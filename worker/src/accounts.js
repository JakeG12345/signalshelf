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

/**
 * Returns the user for a key, or null. A key is either the shelf's own private key or a login session key.
 * Also bumps last_seen_at at most once a day.
 */
export async function resolveUser(db, key) {
  if (!looksLikeKey(key)) return null;
  const hash = await sha256Hex(key);
  const cols = 'u.id, u.handle, u.display_name, u.created_at, u.last_seen_at, (u.password_hash IS NOT NULL) AS has_password';
  let user = await db.prepare(`SELECT ${cols}, 0 AS via_session FROM users u WHERE u.key_hash = ?`).bind(hash).first();
  if (!user) {
    user = await db.prepare(`SELECT ${cols}, 1 AS via_session FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.key_hash = ?`).bind(hash).first();
  }
  if (!user) return null;
  user.has_password = !!user.has_password;
  user.via_session = !!user.via_session;
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

// ---------- Username + password accounts ----------
// PBKDF2-SHA256 via WebCrypto. Iterations are kept modest to fit Workers' CPU limits; logins are rate limited.
const PBKDF2_ITERATIONS = 25000;
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));

export async function hashPassword(password, saltB64 = b64(crypto.getRandomValues(new Uint8Array(16)))) {
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const salt = Uint8Array.from(atob(saltB64), c => c.charCodeAt(0));
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS }, keyMaterial, 256);
  return { hash: `pbkdf2$${PBKDF2_ITERATIONS}$${b64(bits)}`, salt: saltB64 };
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function validatePassword(pw) {
  const p = String(pw ?? '');
  if (p.length < 8) throw new HttpError(400, 'Passwords need at least 8 characters.');
  if (p.length > 200) throw new HttpError(400, 'That password is too long.');
  return p;
}

/** Turns the current (possibly anonymous) shelf into an account with a username and password. */
export async function createAccount(db, user, { handle, password }) {
  const pw = validatePassword(password);
  const updated = await updateProfile(db, user.id, { handle: handle ?? user.handle });
  if (!updated.handle) throw new HttpError(400, 'Pick a username.');
  const { hash, salt } = await hashPassword(pw);
  await db.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?').bind(hash, salt, user.id).run();
  return { ...updated, has_password: true };
}

export async function changePassword(db, user, { current, password }) {
  const row = await db.prepare('SELECT password_hash, password_salt FROM users WHERE id = ?').bind(user.id).first();
  if (row?.password_hash) {
    const check = await hashPassword(String(current ?? ''), row.password_salt);
    if (!safeEqual(check.hash, row.password_hash)) throw new HttpError(401, 'Current password is wrong.');
  }
  const { hash, salt } = await hashPassword(validatePassword(password));
  await db.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?').bind(hash, salt, user.id).run();
}

/** Username + password login. Returns a new session key for this device. */
export async function login(db, request, { handle, password }) {
  const h = String(handle ?? '').trim().replace(/^@/, '').toLowerCase();
  const ipHash = (await sha256Hex(`ip:${request.headers.get('CF-Connecting-IP') || 'unknown'}`)).slice(0, 24);
  await rateLimit(db, `login-ip:${ipHash}`, 30, 900, 'Too many login attempts. Wait 15 minutes and try again.');
  await rateLimit(db, `login-h:${h}`, 10, 900, 'Too many login attempts for this username. Wait 15 minutes and try again.');
  const row = /^[a-z0-9_]{3,20}$/.test(h)
    ? await db.prepare('SELECT id, handle, display_name, password_hash, password_salt FROM users WHERE handle = ?').bind(h).first()
    : null;
  // Always do the hashing work so timing doesn't reveal which usernames exist
  const check = await hashPassword(String(password ?? ''), row?.password_salt || 'AAAAAAAAAAAAAAAAAAAAAA==');
  if (!row?.password_hash || !safeEqual(check.hash, row.password_hash)) throw new HttpError(401, 'Wrong username or password.');
  const key = `ss_${randomString(32)}`;
  const now = new Date().toISOString();
  await db.prepare('INSERT INTO sessions (key_hash, user_id, created_at, last_used_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256Hex(key), row.id, now, now).run();
  return { key, user: { id: row.id, handle: row.handle, display_name: row.display_name } };
}

/** Ends this device's login session (the shelf's own private key can't be logged out, only replaced). */
export async function logout(db, key) {
  await db.prepare('DELETE FROM sessions WHERE key_hash = ?').bind(await sha256Hex(key)).run();
}

/** Items that appear on published shelves, ranked by how many shelves carry them. Only already-public data. */
export async function topSignal(db, limit = 6) {
  const { results } = await db.prepare(`
    SELECT e.id, MAX(e.title) AS title, MAX(e.creator) AS creator, MAX(e.url) AS url,
           COUNT(*) AS shelves, ROUND(AVG(e.signal_rating), 1) AS avg
    FROM entries e
    JOIN users u ON u.id = e.user_id AND u.handle IS NOT NULL
    JOIN user_settings s ON s.user_id = u.id AND s.key = 'shelf' AND json_extract(s.value, '$.published') = 1
    WHERE e.signal_rating >= COALESCE(json_extract(s.value, '$.minRating'), 4)
      AND e.url LIKE 'https://%'
      AND NOT (e.source = 'youtube' AND COALESCE(json_extract(s.value, '$.includeYoutube'), 1) = 0)
      AND NOT (e.source = 'apple_podcasts' AND COALESCE(json_extract(s.value, '$.includePodcasts'), 1) = 0)
      AND NOT (e.source NOT IN ('youtube', 'apple_podcasts') AND COALESCE(json_extract(s.value, '$.includeLinks'), 1) = 0)
    GROUP BY e.id ORDER BY shelves DESC, avg DESC, MAX(e.updated_at) DESC LIMIT ?`).bind(limit).all();
  return results;
}
