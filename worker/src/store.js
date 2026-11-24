// D1 data layer. All SQL comes from shared/core.js so the cloud and the local server behave identically.
import {
  SCHEMA_SQL, REINDEX_SQL, STATS_SQL, MODELS_SQL, HttpError,
  hydrate, buildEntriesQuery, buildUpsert, buildPatch
} from '../../shared/core.js';

let schemaReady = null;
export function ensureSchema(db) {
  if (!schemaReady) {
    schemaReady = db.batch(SCHEMA_SQL.map(sql => db.prepare(sql))).catch(err => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

export function createStore(db) {
  const reindex = id => REINDEX_SQL.map(sql => db.prepare(sql).bind(id));

  const store = {
    async get(id) {
      return hydrate(await db.prepare('SELECT * FROM entries WHERE id = ?').bind(id).first());
    },

    async upsert(data) {
      const { sql, params } = buildUpsert(data);
      await db.batch([db.prepare(sql).bind(...params), ...reindex(data.id)]);
      return store.get(data.id);
    },

    async update(id, patch) {
      const current = await store.get(id);
      if (!current) throw new HttpError(404, `No entry with id ${id}`);
      const { sets, vals } = buildPatch(current, patch);
      if (!sets.length) return current;
      await db.batch([
        db.prepare(`UPDATE entries SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, id),
        ...reindex(id)
      ]);
      return store.get(id);
    },

    async remove(id) {
      const [del] = await db.batch([
        db.prepare('DELETE FROM entries WHERE id = ?').bind(id),
        db.prepare('DELETE FROM entries_fts WHERE id = ?').bind(id)
      ]);
      return (del.meta?.changes || 0) > 0;
    },

    async query(filters = {}) {
      const q = buildEntriesQuery(filters);
      if (!q) return [];
      const { results } = await db.prepare(q.sql).bind(...q.params).all();
      return results.map(hydrate);
    },

    async all() {
      const { results } = await db.prepare('SELECT * FROM entries ORDER BY watched_at DESC').all();
      return results.map(hydrate);
    },

    async stats() {
      const [totals, models] = await db.batch([db.prepare(STATS_SQL), db.prepare(MODELS_SQL)]);
      return { ...totals.results[0], models: models.results };
    },

    async getSetting(key, fallback = null) {
      const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
      if (!row) return fallback;
      try { return JSON.parse(row.value); } catch { return fallback; }
    },

    async setSetting(key, value) {
      await db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .bind(key, JSON.stringify(value)).run();
      return value;
    }
  };
  return store;
}
