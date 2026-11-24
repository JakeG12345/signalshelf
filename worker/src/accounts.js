// Anonymous-first accounts: a visitor gets a private key instantly (no email, no password).
// The key is the only credential; it is stored as a SHA-256 hash.
import { HttpError } from '../../shared/core.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const RESERVED_HANDLES = new Set([
  'admin', 'api', 'app', 'apps', 'mcp', 'u', 'user', 'users', 'shelf', 'shelves', 'signal', 'signalshelf', 'about', 'help',
  'login', 'logout', 'signup', 'settings', 'account', 'www', 'root', 'support', 'null', 'undefined', 'me', 'new', 'explore', 'claude'
]);

export function randomString(len) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export const looksLikeKey = k => /^ss_[A-Za-z0-9]{24,64}$/.test(String(k || ''));

export function normalizeHandle(raw) {
  const h = String(raw ?? '').trim().replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9_]{3,20}$/.test(h)) throw new HttpError(400, 'Usernames are 3–20 characters: letters, numbers and _ only.');
  if (RESERVED_HANDLES.has(h)) throw new HttpError(400, 'That username is reserved. Try another.');
  return h;
}

/** Fixed-window counter in D1. Throws 429 when `limit` is exceeded within `windowSec`. */
export async function rateLimit(db, bucket, limit, windowSec, message) {
  const now = Math.floor(Date.now() / 1000);
  const row = await db.prepare(`INSERT INTO rate_limits (bucket, count, reset_at) VALUES (?, 1, ?)
      ON CONFLICT(bucket) DO UPDATE SET
        count = CASE WHEN rate_limits.reset_at <= ? THEN 1 ELSE rate_limits.count + 1 END,
        reset_at = CASE WHEN rate_limits.reset_at <= ? THEN ? ELSE rate_limits.reset_at END
      RETURNING count`).bind(bucket, now + windowSec, now, now, now + windowSec).first();
  if (row && row.count > limit) throw new HttpError(429, message || 'Too many requests. Try again later.');
}

export async function createAnonymousUser(db, request, limits) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const ipHash = (await sha256Hex(`ip:${ip}`)).slice(0, 24);
  await rateLimit(db, `anon:${ipHash}`, limits.anonPerIpPerDay, 86400, 'Too many new shelves from this network today. Try again tomorrow.');
  // Opportunistic cleanup of expired counters
  await db.prepare('DELETE FROM rate_limits WHERE reset_at < ?').bind(Math.floor(Date.now() / 1000) - 86400).run();

  const key = `ss_${randomString(32)}`;
  const id = `u_${randomString(14)}`;
  const now = new Date().toISOString();
  await db.prepare('INSERT INTO users (id, key_hash, created_at, last_seen_at, created_ip_hash) VALUES (?, ?, ?, ?, ?)')
    .bind(id, await sha256Hex(key), now, now, ipHash).run();
  return { key, user: { id, handle: null, display_name: null, created_at: now } };
}

/** Returns the user for a key, or null. Also bumps last_seen_at at most once a day. */
export async function resolveUser(db, key) {
  if (!looksLikeKey(key)) return null;
  const user = await db.prepare('SELECT id, handle, display_name, created_at, last_seen_at FROM users WHERE key_hash = ?')
    .bind(await sha256Hex(key)).first();
  if (!user) return null;
  const today = new Date().toISOString().slice(0, 10);
  if (!user.last_seen_at || user.last_seen_at.slice(0, 10) < today) {
    await db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').bind(new Date().toISOString(), user.id).run();
  }
  return user;
}

export async function updateProfile(db, userId, { handle, display_name } = {}) {
  const sets = [];
  const vals = [];
  if (handle !== undefined) {
    if (handle === null || handle === '') { sets.push('handle = NULL'); }
    else {
      const h = normalizeHandle(handle);
      const taken = await db.prepare('SELECT id FROM users WHERE handle = ? AND id != ?').bind(h, userId).first();
      if (taken) throw new HttpError(409, `@${h} is taken. Try another.`);
      sets.push('handle = ?'); vals.push(h);
    }
  }
  if (display_name !== undefined) {
    sets.push('display_name = ?');
    vals.push(String(display_name ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) || null);
  }
  if (sets.length) {
    try {
      await db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, userId).run();
    } catch (err) {
      if (/UNIQUE/i.test(err.message)) throw new HttpError(409, 'That username is taken. Try another.');
      throw err;
    }
  }
  return db.prepare('SELECT id, handle, display_name, created_at FROM users WHERE id = ?').bind(userId).first();
}

/** Public shelves for the landing page. */
export async function recentPublicShelves(db, limit = 12) {
  const { results } = await db.prepare(`
    SELECT u.handle, COALESCE(u.display_name, u.handle) AS name, COUNT(e.id) AS items, MAX(e.updated_at) AS updated
    FROM users u
    JOIN user_settings s ON s.user_id = u.id AND s.key = 'shelf' AND json_extract(s.value, '$.published') = 1
    JOIN entries e ON e.user_id = u.id AND e.signal_rating >= COALESCE(json_extract(s.value, '$.minRating'), 4)
    WHERE u.handle IS NOT NULL
    GROUP BY u.id ORDER BY updated DESC LIMIT ?`).bind(limit).all();
  return results;
}

export async function userByHandle(db, handle) {
  const h = String(handle || '').toLowerCase();
  if (!/^[a-z0-9_]{3,20}$/.test(h)) return null;
  return db.prepare('SELECT id, handle, display_name FROM users WHERE handle = ?').bind(h).first();
}
