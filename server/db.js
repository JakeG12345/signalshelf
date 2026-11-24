import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { fileURLToPath } from 'url';
import {
  SCHEMA_VERSION, MONETIZATION_MODELS, SOURCES, STATUSES, HttpError, SCHEMA_SQL, REINDEX_SQL, STATS_SQL, MODELS_SQL,
  hydrate, normalizeTags, normalizeTakeaways, toFtsQuery, buildEntriesQuery, buildUpsert, buildPatch
} from '../shared/core.js';

export { SCHEMA_VERSION, MONETIZATION_MODELS, SOURCES, STATUSES, HttpError, normalizeTags, normalizeTakeaways, toFtsQuery };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DB_PATH = process.env.KT_DB_PATH || path.join(__dirname, 'knowledge.db');

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');   // dashboard + MCP server can read/write concurrently
db.pragma('busy_timeout = 5000');

// ---------- Schema + migrations ----------
// v1 (original project) had only the base columns; v2 adds annotations and a richer FTS index.
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

const migrate = db.transaction(() => {
  const version = db.pragma('user_version', { simple: true });
  if (version >= SCHEMA_VERSION) return;
  const hasEntries = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'entries'").get();
  if (hasEntries) {
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
      DROP TABLE IF EXISTS entries_fts;
    `);
  }
  for (const sql of SCHEMA_SQL) db.exec(sql);
  for (const { id } of db.prepare('SELECT id FROM entries').all()) reindex(id);
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
});

function reindex(id) {
  for (const sql of REINDEX_SQL) db.prepare(sql).run(id);
}

migrate.immediate();

// ---------- Writes ----------
/** Insert or refresh a captured item (annotations are never overwritten by a re-capture). */
export function upsertEntry(data) {
  const { sql, params } = buildUpsert(data);
  db.transaction(() => {
    db.prepare(sql).run(...params);
    reindex(data.id);
  }).immediate();
  return getEntryById(data.id);
}

/** Edit user annotations (and optionally title/transcript) for one entry. */
export function updateEntry(id, patch = {}) {
  const current = getEntryById(id);
  if (!current) throw new HttpError(404, `No entry with id ${id}`);
  const { sets, vals } = buildPatch(current, patch);
  if (!sets.length) return current;
  db.transaction(() => {
    db.prepare(`UPDATE entries SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    reindex(id);
  }).immediate();
  return getEntryById(id);
}

export function deleteEntry(id) {
  return db.transaction(() => {
    const info = db.prepare('DELETE FROM entries WHERE id = ?').run(id);
    db.prepare('DELETE FROM entries_fts WHERE id = ?').run(id);
    return info.changes > 0;
  }).immediate();
}

// ---------- Reads ----------
export function queryEntries(filters = {}) {
  const q = buildEntriesQuery(filters);
  if (!q) return [];
  return db.prepare(q.sql).all(...q.params).map(hydrate);
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
  return { ...db.prepare(STATS_SQL).get(), models: db.prepare(MODELS_SQL).all() };
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
