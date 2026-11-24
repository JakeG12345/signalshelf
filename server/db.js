import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DB_PATH = process.env.KT_DB_PATH || path.join(__dirname, 'knowledge.db');
export const SCHEMA_VERSION = 2;

export const MONETIZATION_MODELS = [
  'Micro-SaaS', 'AI Agency', 'Faceless YT', 'Info Product', 'Newsletter', 'Affiliate',
  'E-commerce', 'Freelancing', 'Automation / No-code', 'Content Creation', 'Consulting',
  'Investing', 'AI Tools / Workflows'
];
export const SOURCES = ['youtube', 'apple_podcasts', 'manual'];
export const STATUSES = ['watched', 'to_watch', 'in_progress'];

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');   // dashboard + MCP server can read/write concurrently
db.pragma('busy_timeout = 5000');

// ---------- Schema + migrations ----------
db.exec(`
  CREATE TABLE IF NOT EXISTS entries (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    title TEXT NOT NULL,
    creator TEXT,
    url TEXT,
    published_at TEXT,
    watched_at TEXT DEFAULT CURRENT_TIMESTAMP,
    duration_sec INTEGER,
    tags TEXT DEFAULT '[]',
    transcript TEXT,
    notes TEXT
  );
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`);

const V2_COLUMNS = {
  signal_rating: 'INTEGER',
  monetization_models: "TEXT DEFAULT '[]'",
  key_takeaways: "TEXT DEFAULT '[]'",
  personal_notes: "TEXT DEFAULT ''",
  status: "TEXT DEFAULT 'watched'",
  thumbnail: 'TEXT',
  transcript_status: 'TEXT',
  created_at: 'TEXT',
  updated_at: 'TEXT'
};

const FTS_DDL = `CREATE VIRTUAL TABLE entries_fts USING fts5(
  id UNINDEXED, title, creator, transcript, notes, takeaways, models,
  tokenize = 'unicode61 remove_diacritics 2'
)`;

const migrate = db.transaction(() => {
  const version = db.pragma('user_version', { simple: true });
  if (version >= SCHEMA_VERSION) return;
  const cols = new Set(db.prepare('PRAGMA table_info(entries)').all().map(c => c.name));
  for (const [name, type] of Object.entries(V2_COLUMNS)) {
    if (!cols.has(name)) db.exec(`ALTER TABLE entries ADD COLUMN ${name} ${type}`);
  }
  db.exec(`
    UPDATE entries SET monetization_models = '[]' WHERE monetization_models IS NULL;
    UPDATE entries SET key_takeaways = '[]' WHERE key_takeaways IS NULL;
    UPDATE entries SET status = 'watched' WHERE status IS NULL;
    UPDATE entries SET personal_notes = COALESCE(NULLIF(notes, ''), '') WHERE personal_notes IS NULL OR personal_notes = '';
    UPDATE entries SET created_at = COALESCE(created_at, watched_at, CURRENT_TIMESTAMP);
    UPDATE entries SET updated_at = COALESCE(updated_at, created_at);
    UPDATE entries SET transcript_status = CASE
      WHEN source = 'apple_podcasts' AND length(COALESCE(transcript,'')) > 0 THEN 'description'
      WHEN length(COALESCE(transcript,'')) > 0 THEN 'ok' ELSE 'missing' END
    WHERE transcript_status IS NULL;
    UPDATE entries SET thumbnail = 'https://i.ytimg.com/vi/' || substr(id, 4) || '/hqdefault.jpg'
    WHERE source = 'youtube' AND thumbnail IS NULL AND id LIKE 'yt\\_%' ESCAPE '\\';
    CREATE INDEX IF NOT EXISTS idx_entries_watched ON entries(watched_at);
    CREATE INDEX IF NOT EXISTS idx_entries_rating ON entries(signal_rating);
    DROP TABLE IF EXISTS entries_fts;
  `);
  db.exec(FTS_DDL);
  for (const { id } of db.prepare('SELECT id FROM entries').all()) reindex(id);
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
});

// ---------- Helpers ----------
function parseJsonArray(v) {
  if (Array.isArray(v)) return v;
  try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
}

export function normalizeTags(input, { max = 12, maxLen = 40 } = {}) {
  const arr = Array.isArray(input) ? input : String(input ?? '').split(',');
  const seen = new Map();
  for (const raw of arr) {
    const t = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
    if (!t) continue;
    // Snap to a preset's canonical spelling when it matches case-insensitively
    const preset = MONETIZATION_MODELS.find(m => m.toLowerCase() === t.toLowerCase());
    const key = t.toLowerCase();
    if (!seen.has(key)) seen.set(key, preset || t);
  }
  return [...seen.values()].slice(0, max);
}

export function normalizeTakeaways(input) {
  const arr = Array.isArray(input) ? input : String(input ?? '').split(/\r?\n/);
  return arr
    .map(s => String(s ?? '').replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(Boolean)
    .map(s => s.slice(0, 1000))
    .slice(0, 50);
}

function normalizeRating(v) {
  if (v === null || v === undefined || v === '' || v === 0) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 5) throw new HttpError(400, 'signal_rating must be an integer 1-5 (or null to clear)');
  return n;
}

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function hydrate(row) {
  if (!row) return row;
  return {
    ...row,
    tags: parseJsonArray(row.tags),
    monetization_models: parseJsonArray(row.monetization_models),
    key_takeaways: parseJsonArray(row.key_takeaways)
  };
}

function reindex(id) {
  const e = db.prepare('SELECT * FROM entries WHERE id = ?').get(id);
  db.prepare('DELETE FROM entries_fts WHERE id = ?').run(id);
  if (!e) return;
  db.prepare(`INSERT INTO entries_fts (id, title, creator, transcript, notes, takeaways, models)
              VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    id, e.title || '', e.creator || '', e.transcript || '', e.personal_notes || '',
    parseJsonArray(e.key_takeaways).join('\n'), parseJsonArray(e.monetization_models).join(', ')
  );
}

/** Turns free text into a safe FTS5 query: every word quoted, last word prefix-matched. */
export function toFtsQuery(input) {
  const tokens = String(input ?? '').match(/[\p{L}\p{N}_]+/gu) || [];
  if (!tokens.length) return null;
  return tokens.slice(0, 16).map((t, i, a) => `"${t}"${i === a.length - 1 ? '*' : ''}`).join(' ');
}

migrate.immediate();

// ---------- Writes ----------
/**
 * Insert or refresh a captured item. Only capture fields are written here;
 * user annotations (rating, tags, takeaways, notes) are never overwritten by a re-capture.
 */
export function upsertEntry({
  id, source = 'youtube', title, creator = '', url = '', published_at = null, watched_at = null,
  duration_sec = null, thumbnail = null, transcript = '', transcript_status = null, tags = null,
  bumpWatched = true
}) {
  if (!id || !title) throw new HttpError(400, 'id and title are required');
  if (!/^[\w.:-]{1,160}$/.test(id)) throw new HttpError(400, 'id contains invalid characters');
  if (!SOURCES.includes(source)) throw new HttpError(400, `source must be one of ${SOURCES.join(', ')}`);
  transcript = String(transcript ?? '');
  const status = transcript_status || (transcript.length ? 'ok' : 'missing');
  const now = new Date().toISOString();
  const dur = Number.isFinite(Number(duration_sec)) && duration_sec !== null ? Math.round(Number(duration_sec)) : null;

  const run = db.transaction(() => {
    const existing = db.prepare('SELECT id FROM entries WHERE id = ?').get(id);
    if (existing) {
      db.prepare(`
        UPDATE entries SET
          title = ?, creator = COALESCE(NULLIF(?, ''), creator), url = COALESCE(NULLIF(?, ''), url),
          published_at = COALESCE(?, published_at), duration_sec = COALESCE(NULLIF(?, 0), duration_sec),
          thumbnail = COALESCE(?, thumbnail),
          transcript = CASE WHEN length(?) > 0 THEN ? ELSE transcript END,
          transcript_status = CASE WHEN length(?) > 0 THEN ? ELSE transcript_status END,
          tags = COALESCE(?, tags),
          watched_at = CASE WHEN ? IS NOT NULL THEN ? WHEN ? THEN ? ELSE watched_at END,
          status = CASE WHEN ? AND status = 'to_watch' THEN 'watched' ELSE status END,
          updated_at = ?
        WHERE id = ?
      `).run(
        title, creator, url, published_at, dur, thumbnail,
        transcript, transcript, transcript, status,
        tags ? JSON.stringify(normalizeTags(tags)) : null,
        watched_at, watched_at, bumpWatched ? 1 : 0, now,
        bumpWatched ? 1 : 0, now, id
      );
    } else {
      db.prepare(`
        INSERT INTO entries (id, source, title, creator, url, published_at, watched_at, duration_sec, thumbnail,
          tags, transcript, transcript_status, monetization_models, key_takeaways, personal_notes, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', '', 'watched', ?, ?)
      `).run(id, source, title, creator, url, published_at, watched_at || now, dur, thumbnail,
        JSON.stringify(normalizeTags(tags || [])), transcript, status, now, now);
    }
    reindex(id);
  });
  run.immediate();
  return getEntryById(id);
}

/** Edit user annotations (and optionally title/transcript) for one entry. */
export function updateEntry(id, patch = {}) {
  const current = db.prepare('SELECT * FROM entries WHERE id = ?').get(id);
  if (!current) throw new HttpError(404, `No entry with id ${id}`);
  const sets = [];
  const vals = [];
  const set = (col, v) => { sets.push(`${col} = ?`); vals.push(v); };

  if ('signal_rating' in patch) set('signal_rating', normalizeRating(patch.signal_rating));
  if ('monetization_models' in patch) set('monetization_models', JSON.stringify(normalizeTags(patch.monetization_models)));
  if ('tags' in patch) set('tags', JSON.stringify(normalizeTags(patch.tags)));
  if ('key_takeaways' in patch) set('key_takeaways', JSON.stringify(normalizeTakeaways(patch.key_takeaways)));
  if ('add_takeaways' in patch) {
    const merged = [...parseJsonArray(current.key_takeaways), ...normalizeTakeaways(patch.add_takeaways)];
    set('key_takeaways', JSON.stringify(normalizeTakeaways([...new Set(merged)])));
  }
  if ('personal_notes' in patch) set('personal_notes', String(patch.personal_notes ?? '').slice(0, 20000));
  if ('append_notes' in patch && String(patch.append_notes || '').trim()) {
    const base = current.personal_notes ? current.personal_notes + '\n\n' : '';
    set('personal_notes', (base + String(patch.append_notes).trim()).slice(0, 20000));
  }
  if ('status' in patch) {
    if (!STATUSES.includes(patch.status)) throw new HttpError(400, `status must be one of ${STATUSES.join(', ')}`);
    set('status', patch.status);
  }
  if ('title' in patch) {
    const t = String(patch.title ?? '').trim();
    if (!t) throw new HttpError(400, 'title cannot be empty');
    set('title', t.slice(0, 500));
  }
  if ('transcript' in patch) {
    const tr = String(patch.transcript ?? '');
    set('transcript', tr);
    set('transcript_status', tr.length ? (current.transcript_status === 'description' && tr === current.transcript ? 'description' : 'ok') : 'missing');
  }
  if (!sets.length) return getEntryById(id);
  set('updated_at', new Date().toISOString());
  const run = db.transaction(() => {
    db.prepare(`UPDATE entries SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    reindex(id);
  });
  run.immediate();
  return getEntryById(id);
}

export function deleteEntry(id) {
  const run = db.transaction(() => {
    const info = db.prepare('DELETE FROM entries WHERE id = ?').run(id);
    db.prepare('DELETE FROM entries_fts WHERE id = ?').run(id);
    return info.changes > 0;
  });
  return run.immediate();
}

// ---------- Reads ----------
const LIST_COLS = `e.id, e.source, e.title, e.creator, e.url, e.thumbnail, e.published_at, e.watched_at,
  e.duration_sec, e.tags, e.signal_rating, e.monetization_models, e.key_takeaways, e.status,
  e.transcript_status, e.updated_at, length(COALESCE(e.transcript,'')) AS transcript_chars,
  length(COALESCE(e.personal_notes,'')) > 0 AS has_notes`;

/**
 * Unified list/search with filters.
 * sort: 'recent' | 'rating' | 'relevance' | 'oldest' | 'title'
 */
export function queryEntries({
  q = '', source = null, minRating = null, model = null, status = null,
  sort = null, limit = 50, offset = 0
} = {}) {
  const where = [];
  const params = [];
  const fts = toFtsQuery(q);
  if (String(q ?? '').trim() && !fts) return []; // query had no searchable words
  let from = 'entries e';
  let select = LIST_COLS;
  if (fts) {
    from = 'entries_fts JOIN entries e ON e.id = entries_fts.id';
    select += `, snippet(entries_fts, 3, '[', ']', '…', 24) AS match_snippet`;
    where.push('entries_fts MATCH ?');
    params.push(fts);
  }
  if (source) { where.push('e.source = ?'); params.push(source); }
  if (minRating) { where.push('e.signal_rating >= ?'); params.push(Number(minRating)); }
  if (status) { where.push('e.status = ?'); params.push(status); }
  if (model) {
    where.push(`EXISTS (SELECT 1 FROM json_each(e.monetization_models) WHERE lower(value) = lower(?))`);
    params.push(model);
  }
  const orders = {
    recent: 'e.watched_at DESC',
    oldest: 'e.watched_at ASC',
    rating: 'e.signal_rating IS NULL, e.signal_rating DESC, e.watched_at DESC',
    title: 'e.title COLLATE NOCASE ASC',
    relevance: fts ? 'rank' : 'e.watched_at DESC'
  };
  const order = orders[sort] || (fts ? orders.relevance : orders.recent);
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 500);
  const off = Math.max(Number(offset) || 0, 0);
  const sql = `SELECT ${select} FROM ${from} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY ${order} LIMIT ? OFFSET ?`;
  return db.prepare(sql).all(...params, lim, off).map(r => ({ ...hydrate(r), has_notes: !!r.has_notes }));
}

// Back-compat wrappers
export function listEntries({ source = null, limit = 25, ...rest } = {}) {
  return queryEntries({ source, limit, ...rest });
}
export function searchEntries(query, limit = 10, filters = {}) {
  return queryEntries({ q: query, limit, ...filters });
}

export function getEntryById(id) {
  return hydrate(db.prepare('SELECT * FROM entries WHERE id = ?').get(id));
}

export function getTopRated({ limit = 20, minRating = 4, model = null, source = null } = {}) {
  return queryEntries({ minRating, model, source, sort: 'rating', limit });
}

export function getStats() {
  const totals = db.prepare(`SELECT COUNT(*) AS total,
      SUM(source = 'youtube') AS youtube, SUM(source = 'apple_podcasts') AS podcasts,
      SUM(signal_rating IS NOT NULL) AS rated, ROUND(AVG(signal_rating), 2) AS avg_rating,
      SUM(transcript_status = 'missing') AS missing_transcripts
    FROM entries`).get();
  const models = db.prepare(`SELECT value AS model, COUNT(*) AS count, ROUND(AVG(e.signal_rating), 2) AS avg_rating
    FROM entries e, json_each(e.monetization_models) GROUP BY lower(value) ORDER BY count DESC`).all();
  return { ...totals, models };
}

// ---------- Settings ----------
export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}
export function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
  return value;
}

// ---------- Apple Podcasts (macOS) ----------
export const PODCASTS_DB_PATH = path.join(
  os.homedir(), 'Library/Group Containers/243LU875E5.groups.com.apple.podcasts/Documents/MTLibrary.sqlite'
);

export function syncApplePodcastsMac({ limit = 200 } = {}) {
  if (process.platform !== 'darwin') {
    return { synced: 0, error: 'Apple Podcasts sync only works on macOS.' };
  }
  if (!fs.existsSync(PODCASTS_DB_PATH)) {
    return { synced: 0, error: 'Apple Podcasts database not found. Open the Podcasts app once, then try again.' };
  }

  // Copy the DB *and* its WAL/SHM files: recent plays often live only in the -wal file.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-podcasts-'));
  const tmpDb = path.join(tmpDir, 'MTLibrary.sqlite');
  try {
    try {
      fs.copyFileSync(PODCASTS_DB_PATH, tmpDb);
      for (const ext of ['-wal', '-shm']) {
        if (fs.existsSync(PODCASTS_DB_PATH + ext)) fs.copyFileSync(PODCASTS_DB_PATH + ext, tmpDb + ext);
      }
    } catch (err) {
      if (err.code === 'EPERM' || err.code === 'EACCES') {
        return {
          synced: 0,
          error: 'macOS blocked access to the Podcasts library. Grant Full Disk Access to the app running this server ' +
                 '(Terminal/iTerm for the dashboard, Claude for MCP) in System Settings → Privacy & Security → Full Disk Access.'
        };
      }
      throw err;
    }

    const podDb = new Database(tmpDb, { readonly: false, fileMustExist: true }); // writable so SQLite can replay the WAL copy
    let rows;
    try {
      const cols = new Set(podDb.prepare('PRAGMA table_info(ZMTEPISODE)').all().map(c => c.name));
      if (!cols.size) return { synced: 0, error: 'Unexpected Apple Podcasts database format (ZMTEPISODE missing).' };
      const pick = (c, alias) => (cols.has(c) ? `e.${c}` : 'NULL') + ` AS ${alias}`;
      rows = podDb.prepare(`
        SELECT ${pick('ZUUID', 'uuid')}, ${pick('ZTITLE', 'title')}, p.ZTITLE AS podcast_name,
               ${pick('ZWEBPAGEURL', 'url')}, ${pick('ZDURATION', 'duration')}, ${pick('ZLASTDATEPLAYED', 'last_played')},
               ${pick('ZPUBDATE', 'pub_date')}, ${pick('ZITEMDESCRIPTIONWITHOUTHTML', 'description')},
               p.ZIMAGEURL AS image_url
        FROM ZMTEPISODE e LEFT JOIN ZMTPODCAST p ON e.ZPODCAST = p.Z_PK
        WHERE ${cols.has('ZLASTDATEPLAYED') ? 'e.ZLASTDATEPLAYED IS NOT NULL' : '0'}
           ${cols.has('ZPLAYCOUNT') ? 'OR e.ZPLAYCOUNT > 0' : ''}
        ORDER BY ${cols.has('ZLASTDATEPLAYED') ? 'e.ZLASTDATEPLAYED' : 'e.Z_PK'} DESC
        LIMIT ?
      `).all(limit);
    } catch (err) {
      // ZIMAGEURL may not exist on older libraries; retry without it
      if (/no such column: p\.ZIMAGEURL/.test(err.message)) {
        rows = podDb.prepare(`SELECT e.ZUUID AS uuid, e.ZTITLE AS title, p.ZTITLE AS podcast_name, e.ZWEBPAGEURL AS url,
          e.ZDURATION AS duration, e.ZLASTDATEPLAYED AS last_played, NULL AS pub_date,
          e.ZITEMDESCRIPTIONWITHOUTHTML AS description, NULL AS image_url
          FROM ZMTEPISODE e LEFT JOIN ZMTPODCAST p ON e.ZPODCAST = p.Z_PK
          WHERE e.ZLASTDATEPLAYED IS NOT NULL OR e.ZPLAYCOUNT > 0 ORDER BY e.ZLASTDATEPLAYED DESC LIMIT ?`).all(limit);
      } else throw err;
    } finally {
      podDb.close();
    }

    // CoreData timestamps count seconds from 2001-01-01
    const coreDataToIso = s => (s ? new Date((s + 978307200) * 1000).toISOString() : null);
    let count = 0;
    for (const r of rows) {
      if (!r.uuid || !r.title) continue;
      upsertEntry({
        id: `pod_${r.uuid}`,
        source: 'apple_podcasts',
        title: r.title,
        creator: r.podcast_name || 'Unknown Podcast',
        url: r.url || '',
        published_at: coreDataToIso(r.pub_date),
        watched_at: coreDataToIso(r.last_played),
        bumpWatched: false,
        duration_sec: Math.round(r.duration || 0),
        thumbnail: r.image_url || null,
        transcript: r.description || '',
        transcript_status: r.description ? 'description' : 'missing'
      });
      count++;
    }
    return { synced: count };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
