// Pure data logic shared by the local Node server (better-sqlite3) and the Cloudflare Worker (D1).
// No I/O here: everything returns SQL + params or plain values.

export const SCHEMA_VERSION = 2;
export const APP_VERSION = '2.1.0';

export const MONETIZATION_MODELS = [
  'Micro-SaaS', 'AI Agency', 'Faceless YT', 'Info Product', 'Newsletter', 'Affiliate',
  'E-commerce', 'Freelancing', 'Automation / No-code', 'Content Creation', 'Consulting',
  'Investing', 'AI Tools / Workflows'
];
export const SOURCES = ['youtube', 'apple_podcasts', 'web', 'manual'];
export const STATUSES = ['watched', 'to_watch', 'in_progress'];

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Fresh v2 schema (used as-is by the Worker; the local server migrates v1 → v2 itself).
export const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS entries (
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
    notes TEXT,
    signal_rating INTEGER,
    monetization_models TEXT DEFAULT '[]',
    key_takeaways TEXT DEFAULT '[]',
    personal_notes TEXT DEFAULT '',
    status TEXT DEFAULT 'watched',
    thumbnail TEXT,
    transcript_status TEXT,
    created_at TEXT,
    updated_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_entries_watched ON entries(watched_at)`,
  `CREATE INDEX IF NOT EXISTS idx_entries_rating ON entries(signal_rating)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
    id UNINDEXED, title, creator, transcript, notes, takeaways, models,
    tokenize = 'unicode61 remove_diacritics 2'
  )`
];

// Rebuilds one entry's search row entirely in SQL (works identically in SQLite and D1).
export const REINDEX_SQL = [
  `DELETE FROM entries_fts WHERE id = ?`,
  `INSERT INTO entries_fts (id, title, creator, transcript, notes, takeaways, models)
   SELECT e.id, e.title, COALESCE(e.creator, ''), COALESCE(e.transcript, ''), COALESCE(e.personal_notes, ''),
     COALESCE((SELECT group_concat(value, char(10)) FROM json_each(e.key_takeaways)), ''),
     COALESCE((SELECT group_concat(value, ', ') FROM json_each(e.monetization_models)), '')
   FROM entries e WHERE e.id = ?`
];

/** Reindex statements for one entry; pass userId for the multi-user cloud schema. */
export function reindexStatements(id, userId) {
  if (userId === undefined) return REINDEX_SQL.map(sql => ({ sql, params: [id] }));
  return [
    { sql: 'DELETE FROM entries_fts WHERE id = ? AND user_id = ?', params: [id, userId] },
    {
      sql: `INSERT INTO entries_fts (id, user_id, title, creator, transcript, notes, takeaways, models)
        SELECT e.id, e.user_id, e.title, COALESCE(e.creator, ''), COALESCE(e.transcript, ''), COALESCE(e.personal_notes, ''),
          COALESCE((SELECT group_concat(value, char(10)) FROM json_each(e.key_takeaways)), ''),
          COALESCE((SELECT group_concat(value, ', ') FROM json_each(e.monetization_models)), '')
        FROM entries e WHERE e.id = ? AND e.user_id = ?`,
      params: [id, userId]
    }
  ];
}

export function statsStatements(userId) {
  if (userId === undefined) return [{ sql: STATS_SQL, params: [] }, { sql: MODELS_SQL, params: [] }];
  return [
    { sql: STATS_SQL.replace(/FROM entries$/, 'FROM entries WHERE user_id = ?'), params: [userId] },
    { sql: MODELS_SQL.replace('FROM entries e, json_each(e.monetization_models)', 'FROM entries e, json_each(e.monetization_models) WHERE e.user_id = ?'), params: [userId] }
  ];
}

export const STATS_SQL = `SELECT COUNT(*) AS total,
    COALESCE(SUM(source = 'youtube'), 0) AS youtube, COALESCE(SUM(source = 'apple_podcasts'), 0) AS podcasts,
    COALESCE(SUM(source NOT IN ('youtube', 'apple_podcasts')), 0) AS links,
    COALESCE(SUM(signal_rating IS NOT NULL), 0) AS rated, ROUND(AVG(signal_rating), 2) AS avg_rating,
    COALESCE(SUM(transcript_status = 'missing'), 0) AS missing_transcripts
  FROM entries`;
export const MODELS_SQL = `SELECT value AS model, COUNT(*) AS count, ROUND(AVG(e.signal_rating), 2) AS avg_rating
  FROM entries e, json_each(e.monetization_models) GROUP BY lower(value) ORDER BY count DESC`;

// ---------- Normalisers ----------
export function parseJsonArray(v) {
  if (Array.isArray(v)) return v;
  try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
}

export function normalizeTags(input, { max = 12, maxLen = 40 } = {}) {
  const arr = Array.isArray(input) ? input : String(input ?? '').split(',');
  const seen = new Map();
  for (const raw of arr) {
    const t = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
    if (!t) continue;
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

export function normalizeRating(v) {
  if (v === null || v === undefined || v === '' || v === 0) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 5) throw new HttpError(400, 'signal_rating must be an integer 1-5 (or null to clear)');
  return n;
}

export function hydrate(row) {
  if (!row) return row ?? null;
  const out = {
    ...row,
    tags: parseJsonArray(row.tags),
    monetization_models: parseJsonArray(row.monetization_models),
    key_takeaways: parseJsonArray(row.key_takeaways)
  };
  if ('has_notes' in row) out.has_notes = !!row.has_notes;
  return out;
}

/** Turns free text into a safe FTS5 query: every word quoted, last word prefix-matched. */
export function toFtsQuery(input) {
  const tokens = String(input ?? '').match(/[\p{L}\p{N}_]+/gu) || [];
  if (!tokens.length) return null;
  return tokens.slice(0, 16).map((t, i, a) => `"${t}"${i === a.length - 1 ? '*' : ''}`).join(' ');
}

export function validateCapture({ id, title, source }) {
  if (!id || !title) throw new HttpError(400, 'id and title are required');
  if (!/^[\w.:-]{1,160}$/.test(id)) throw new HttpError(400, 'id contains invalid characters');
  if (!SOURCES.includes(source)) throw new HttpError(400, `source must be one of ${SOURCES.join(', ')}`);
}

// ---------- Query builders ----------
const LIST_COLS = `e.id, e.source, e.title, e.creator, e.url, e.thumbnail, e.published_at, e.watched_at,
  e.duration_sec, e.tags, e.signal_rating, e.monetization_models, e.key_takeaways, e.status,
  e.transcript_status, e.updated_at, length(COALESCE(e.transcript,'')) AS transcript_chars,
  length(COALESCE(e.personal_notes,'')) > 0 AS has_notes`;

/** Returns null when the query has text but no searchable words (caller should return []). */
export function buildEntriesQuery({
  q = '', source = null, minRating = null, model = null, status = null,
  sort = null, limit = 50, offset = 0, userId
} = {}) {
  const where = [];
  const params = [];
  const fts = toFtsQuery(q);
  if (String(q ?? '').trim() && !fts) return null;
  const scoped = userId !== undefined;
  let from = 'entries e';
  let select = LIST_COLS;
  if (fts) {
    from = scoped
      ? 'entries_fts JOIN entries e ON e.id = entries_fts.id AND e.user_id = entries_fts.user_id'
      : 'entries_fts JOIN entries e ON e.id = entries_fts.id';
    // snippet column index: transcript is column 3 locally, 4 in the cloud (user_id is column 1)
    select += `, snippet(entries_fts, ${scoped ? 4 : 3}, '[', ']', '…', 24) AS match_snippet`;
    where.push('entries_fts MATCH ?');
    params.push(fts);
  }
  if (scoped) { where.push('e.user_id = ?'); params.push(userId); }
  if (source) { where.push('e.source = ?'); params.push(String(source)); }
  if (minRating) { where.push('e.signal_rating >= ?'); params.push(Number(minRating)); }
  if (status) { where.push('e.status = ?'); params.push(String(status)); }
  if (model) {
    where.push('EXISTS (SELECT 1 FROM json_each(e.monetization_models) WHERE lower(value) = lower(?))');
    params.push(String(model));
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
  params.push(lim, off);
  return {
    sql: `SELECT ${select} FROM ${from} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT ? OFFSET ?`,
    params
  };
}

/**
 * Insert-or-refresh for a captured item. Only capture fields change on conflict;
 * the user's rating, tags, takeaways and notes are never overwritten by a re-capture.
 */
export function buildUpsert({
  id, source = 'youtube', title, creator = '', url = '', published_at = null, watched_at = null,
  duration_sec = null, thumbnail = null, transcript = '', transcript_status = null, tags = null,
  status = 'watched', bumpWatched = true
}, now = new Date().toISOString(), userId) {
  validateCapture({ id, title, source });
  const tr = String(transcript ?? '').slice(0, 1_500_000); // stays under D1's 2 MB row limit
  const tStatus = transcript_status || (tr.length ? 'ok' : 'missing');
  const dur = duration_sec === null || duration_sec === undefined || !Number.isFinite(Number(duration_sec))
    ? null : Math.round(Number(duration_sec));
  const tagsJson = JSON.stringify(normalizeTags(tags || []));
  const initialStatus = STATUSES.includes(status) ? status : 'watched';
  const scoped = userId !== undefined;
  return expandNumbered({
    sql: `INSERT INTO entries (id, ${scoped ? 'user_id, ' : ''}source, title, creator, url, published_at, watched_at, duration_sec, thumbnail,
        tags, transcript, transcript_status, monetization_models, key_takeaways, personal_notes, status, created_at, updated_at)
      VALUES (?1, ${scoped ? '?17, ' : ''}?2, ?3, ?4, ?5, ?6, COALESCE(?7, ?14), ?8, ?9, ?10, ?11, ?12, '[]', '[]', '', ?13, ?14, ?14)
      ON CONFLICT(${scoped ? 'user_id, id' : 'id'}) DO UPDATE SET
        title = excluded.title,
        creator = COALESCE(NULLIF(excluded.creator, ''), entries.creator),
        url = COALESCE(NULLIF(excluded.url, ''), entries.url),
        published_at = COALESCE(excluded.published_at, entries.published_at),
        duration_sec = COALESCE(NULLIF(excluded.duration_sec, 0), entries.duration_sec),
        thumbnail = COALESCE(excluded.thumbnail, entries.thumbnail),
        transcript = CASE WHEN length(excluded.transcript) > 0 THEN excluded.transcript ELSE entries.transcript END,
        transcript_status = CASE WHEN length(excluded.transcript) > 0 THEN excluded.transcript_status ELSE entries.transcript_status END,
        tags = CASE WHEN ?15 THEN excluded.tags ELSE entries.tags END,
        watched_at = CASE WHEN ?7 IS NOT NULL THEN ?7 WHEN ?16 THEN ?14 ELSE entries.watched_at END,
        status = CASE WHEN ?16 AND entries.status = 'to_watch' THEN 'watched' ELSE entries.status END,
        updated_at = ?14`,
    params: [
      id, source, String(title).trim().slice(0, 500), creator || '', url || '', published_at || null, watched_at || null,
      dur, thumbnail || null, tagsJson, tr, tStatus, initialStatus, now, tags ? 1 : 0, bumpWatched ? 1 : 0,
      scoped ? userId : null
    ]
  });
}

/** Rewrites ?1..?N placeholders into plain positional `?` (portable across SQLite drivers and D1). */
function expandNumbered({ sql, params }) {
  const out = [];
  const text = sql.replace(/\?(\d+)/g, (_, n) => { out.push(params[Number(n) - 1]); return '?'; });
  return { sql: text, params: out };
}

/** Validates a user edit and returns the SET clause. `current` is the hydrated existing row. */
export function buildPatch(current, patch = {}, now = new Date().toISOString()) {
  const sets = [];
  const vals = [];
  const set = (col, v) => { sets.push(`${col} = ?`); vals.push(v); };

  if ('signal_rating' in patch) set('signal_rating', normalizeRating(patch.signal_rating));
  if ('monetization_models' in patch) set('monetization_models', JSON.stringify(normalizeTags(patch.monetization_models)));
  if ('tags' in patch) set('tags', JSON.stringify(normalizeTags(patch.tags)));
  if ('key_takeaways' in patch) set('key_takeaways', JSON.stringify(normalizeTakeaways(patch.key_takeaways)));
  if ('add_takeaways' in patch) {
    const merged = [...(current.key_takeaways || []), ...normalizeTakeaways(patch.add_takeaways)];
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
    set('transcript_status', !tr.length ? 'missing'
      : current.transcript_status === 'description' && tr === current.transcript ? 'description' : 'ok');
  }
  if (sets.length) set('updated_at', now);
  return { sets, vals };
}
