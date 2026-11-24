// D1 data layer (multi-user). Entry SQL comes from shared/core.js, scoped by user_id.
import {
  HttpError, hydrate, buildEntriesQuery, buildUpsert, buildPatch, reindexStatements, statsStatements
} from '../../shared/core.js';

const ENTRY_COLUMNS = `
    title TEXT NOT NULL,
    source TEXT NOT NULL,
    creator TEXT,
    url TEXT,
    published_at TEXT,
    watched_at TEXT,
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
    updated_at TEXT`;

export const CLOUD_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    key_hash TEXT NOT NULL UNIQUE,
    handle TEXT UNIQUE,
    display_name TEXT,
    created_at TEXT NOT NULL,
    last_seen_at TEXT,
    created_ip_hash TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS entries (
    user_id TEXT NOT NULL,
    id TEXT NOT NULL,${ENTRY_COLUMNS},
    PRIMARY KEY (user_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_entries_user_watched ON entries(user_id, watched_at)`,
  `CREATE INDEX IF NOT EXISTS idx_entries_user_rating ON entries(user_id, signal_rating)`,
  `CREATE TABLE IF NOT EXISTS user_settings (
    user_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT,
    PRIMARY KEY (user_id, key)
  )`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
    id UNINDEXED, user_id UNINDEXED, title, creator, transcript, notes, takeaways, models,
    tokenize = 'unicode61 remove_diacritics 2'
  )`,
  `CREATE TABLE IF NOT EXISTS rate_limits (
    bucket TEXT PRIMARY KEY,
    count INTEGER NOT NULL,
    reset_at INTEGER NOT NULL
  )`
];

let schemaReady = null;
export function ensureSchema(db) {
  if (!schemaReady) {
    schemaReady = (async () => {
      // v2 (single-user) databases had `entries` without user_id: park them and start the multi-user schema.
      const cols = (await db.prepare('PRAGMA table_info(entries)').all()).results || [];
      if (cols.length && !cols.some(c => c.name === 'user_id')) {
        await db.batch([
          db.prepare('ALTER TABLE entries RENAME TO entries_v2_legacy'),
          db.prepare('DROP TABLE IF EXISTS entries_fts'),
          db.prepare('DROP INDEX IF EXISTS idx_entries_watched'),
          db.prepare('DROP INDEX IF EXISTS idx_entries_rating')
        ]);
      }
      await db.batch(CLOUD_SCHEMA_SQL.map(sql => db.prepare(sql)));
    })().catch(err => { schemaReady = null; throw err; });
  }
  return schemaReady;
}

const bindAll = (db, stmts) => stmts.map(s => db.prepare(s.sql).bind(...s.params));

/** Everything a signed-in user can do with their own data. */
export function createStore(db, userId) {
  if (!userId) throw new Error('createStore needs a userId');
  const reindex = id => bindAll(db, reindexStatements(id, userId));

  const store = {
    userId,

    async get(id) {
      return hydrate(await db.prepare('SELECT * FROM entries WHERE user_id = ? AND id = ?').bind(userId, id).first());
    },

    async count() {
      return (await db.prepare('SELECT COUNT(*) AS n FROM entries WHERE user_id = ?').bind(userId).first()).n;
    },

    async upsert(data) {
      const { sql, params } = buildUpsert(data, undefined, userId);
      await db.batch([db.prepare(sql).bind(...params), ...reindex(data.id)]);
      return store.get(data.id);
    },

    async update(id, patch) {
      const current = await store.get(id);
      if (!current) throw new HttpError(404, `No entry with id ${id}`);
      const { sets, vals } = buildPatch(current, patch);
      if (!sets.length) return current;
      await db.batch([
        db.prepare(`UPDATE entries SET ${sets.join(', ')} WHERE user_id = ? AND id = ?`).bind(...vals, userId, id),
        ...reindex(id)
      ]);
      return store.get(id);
    },

    async remove(id) {
      const [del] = await db.batch([
        db.prepare('DELETE FROM entries WHERE user_id = ? AND id = ?').bind(userId, id),
        db.prepare('DELETE FROM entries_fts WHERE user_id = ? AND id = ?').bind(userId, id)
      ]);
      return (del.meta?.changes || 0) > 0;
    },

    async query(filters = {}) {
      const q = buildEntriesQuery({ ...filters, userId });
      if (!q) return [];
      const { results } = await db.prepare(q.sql).bind(...q.params).all();
      return results.map(hydrate);
    },

    async all() {
      const { results } = await db.prepare('SELECT * FROM entries WHERE user_id = ? ORDER BY watched_at DESC').bind(userId).all();
      return results.map(r => { const { user_id, ...rest } = hydrate(r); return rest; });
    },

    async stats() {
      const [totals, models] = await db.batch(bindAll(db, statsStatements(userId)));
      return { ...totals.results[0], models: models.results };
    },

    async getSetting(key, fallback = null) {
      const row = await db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?').bind(userId, key).first();
      if (!row) return fallback;
      try { return JSON.parse(row.value); } catch { return fallback; }
    },

    async setSetting(key, value) {
      await db.prepare(`INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)
        ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`).bind(userId, key, JSON.stringify(value)).run();
      return value;
    },

    /** Permanently deletes the account and all of its data. */
    async destroy() {
      await db.batch([
        db.prepare('DELETE FROM entries_fts WHERE user_id = ?').bind(userId),
        db.prepare('DELETE FROM entries WHERE user_id = ?').bind(userId),
        db.prepare('DELETE FROM user_settings WHERE user_id = ?').bind(userId),
        db.prepare('DELETE FROM users WHERE id = ?').bind(userId)
      ]);
    }
  };
  return store;
}
