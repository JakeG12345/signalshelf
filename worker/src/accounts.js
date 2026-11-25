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
  const cols = 'u.id, u.handle, u.display_name, u.bio, u.is_private, u.created_at, u.last_seen_at, (u.password_hash IS NOT NULL OR u.google_sub IS NOT NULL) AS has_password, (u.google_sub IS NOT NULL) AS has_google';
  let user = await db.prepare(`SELECT ${cols}, 0 AS via_session FROM users u WHERE u.key_hash = ?`).bind(hash).first();
  if (!user) {
    user = await db.prepare(`SELECT ${cols}, 1 AS via_session FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.key_hash = ?`).bind(hash).first();
  }
  if (!user) return null;
  user.has_password = !!user.has_password;
  user.has_google = !!user.has_google;
  user.is_private = !!user.is_private;
  user.via_session = !!user.via_session;
  const today = new Date().toISOString().slice(0, 10);
  if (!user.last_seen_at || user.last_seen_at.slice(0, 10) < today) {
    await db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').bind(new Date().toISOString(), user.id).run();
  }
  return user;
}

export async function updateProfile(db, userId, { handle, display_name, bio, is_private } = {}) {
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
  if (bio !== undefined) {
    sets.push('bio = ?');
    vals.push(String(bio ?? '').replace(/\s+/g, ' ').trim().slice(0, 160) || null);
  }
  if (is_private !== undefined) { sets.push('is_private = ?'); vals.push(is_private ? 1 : 0); }
  if (sets.length) {
    try {
      await db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, userId).run();
    } catch (err) {
      if (/UNIQUE/i.test(err.message)) throw new HttpError(409, 'That username is taken. Try another.');
      throw err;
    }
  }
  const u = await db.prepare('SELECT id, handle, display_name, bio, is_private, created_at FROM users WHERE id = ?').bind(userId).first();
  return { ...u, is_private: !!u.is_private };
}

// ---------- Public profiles ----------
// Anyone with a username has a public profile unless they made it private.
// Public: titles, creators, links, ratings, tags, takeaways. Never public: notes, transcripts.
const PUBLIC_USER = `u.handle IS NOT NULL AND COALESCE(u.is_private, 0) = 0`;

/** People for the landing and People pages, most recently active first. */
export async function listPeople(db, { q = '', limit = 30 } = {}) {
  const term = String(q || '').trim().replace(/^@/, '').toLowerCase().replace(/[^a-z0-9_ ]/g, '');
  const { results } = await db.prepare(`
    SELECT u.handle, COALESCE(u.display_name, u.handle) AS name, u.bio,
      (SELECT COUNT(*) FROM entries e WHERE e.user_id = u.id) AS items,
      (SELECT COUNT(*) FROM follows f WHERE f.followee_id = u.id) AS followers,
      (SELECT MAX(e.updated_at) FROM entries e WHERE e.user_id = u.id) AS active
    FROM users u
    WHERE ${PUBLIC_USER} ${term ? "AND (u.handle LIKE ? OR lower(COALESCE(u.display_name, '')) LIKE ?)" : ''}
    ORDER BY (items > 0) DESC, active DESC LIMIT ?`).bind(...(term ? [`%${term}%`, `%${term}%`] : []), limit).all();
  return results;
}

export async function userByHandle(db, handle) {
  const h = String(handle || '').toLowerCase();
  if (!/^[a-z0-9_]{3,20}$/.test(h)) return null;
  const u = await db.prepare('SELECT id, handle, display_name, bio, is_private, created_at FROM users WHERE handle = ?').bind(h).first();
  return u ? { ...u, is_private: !!u.is_private } : null;
}

export async function followCounts(db, userId) {
  const r = await db.prepare(`SELECT
      (SELECT COUNT(*) FROM follows WHERE followee_id = ?) AS followers,
      (SELECT COUNT(*) FROM follows WHERE follower_id = ?) AS following,
      (SELECT COUNT(*) FROM entries WHERE user_id = ?) AS items`).bind(userId, userId, userId).first();
  return r;
}

export async function setFollow(db, followerId, handle, on) {
  const target = await userByHandle(db, handle);
  if (!target) throw new HttpError(404, 'No one with that username.');
  if (target.id === followerId) throw new HttpError(400, 'You can\'t follow yourself.');
  if (on) {
    await db.prepare('INSERT OR IGNORE INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, ?)')
      .bind(followerId, target.id, new Date().toISOString()).run();
  } else {
    await db.prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?').bind(followerId, target.id).run();
  }
  const c = await followCounts(db, target.id);
  return { handle: target.handle, following: on, followers: c.followers, items: c.items };
}

export async function isFollowing(db, followerId, targetId) {
  return !!(await db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?').bind(followerId, targetId).first());
}

export async function listFollowing(db, userId) {
  const { results } = await db.prepare(`SELECT u.handle, COALESCE(u.display_name, u.handle) AS name
    FROM follows f JOIN users u ON u.id = f.followee_id WHERE f.follower_id = ? AND u.handle IS NOT NULL ORDER BY f.created_at DESC`).bind(userId).all();
  return results;
}

/** What the people you follow have saved recently (public fields only). */
export async function feed(db, userId, limit = 60) {
  const { results } = await db.prepare(`
    SELECT e.id, e.source, e.title, e.creator, e.url, e.thumbnail, e.signal_rating, e.monetization_models, e.key_takeaways,
           e.watched_at, e.updated_at, u.handle, COALESCE(u.display_name, u.handle) AS name
    FROM follows f JOIN users u ON u.id = f.followee_id AND ${PUBLIC_USER}
    JOIN entries e ON e.user_id = u.id
    WHERE f.follower_id = ?
    ORDER BY e.updated_at DESC LIMIT ?`).bind(userId, limit).all();
  return results.map(r => ({ ...r, monetization_models: JSON.parse(r.monetization_models || '[]'), key_takeaways: JSON.parse(r.key_takeaways || '[]') }));
}

/** Items on public profiles, ranked by how many people saved them and how they rated them. */
export async function topSignal(db, limit = 6) {
  const { results } = await db.prepare(`
    SELECT e.id, MAX(e.title) AS title, MAX(e.creator) AS creator, MAX(e.url) AS url,
           COUNT(*) AS shelves, ROUND(AVG(e.signal_rating), 1) AS avg
    FROM entries e JOIN users u ON u.id = e.user_id AND ${PUBLIC_USER}
    WHERE e.signal_rating >= 4 AND e.url LIKE 'https://%'
    GROUP BY e.id ORDER BY shelves DESC, avg DESC, MAX(e.updated_at) DESC LIMIT ?`).bind(limit).all();
  return results;
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

// ---------- Google sign-in (server-side OAuth code flow) ----------
const STATE_TTL_SEC = 600;
export const googleEnabled = env => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);

async function newSession(db, userId) {
  const key = `ss_${randomString(32)}`;
  const now = new Date().toISOString();
  await db.prepare('INSERT INTO sessions (key_hash, user_id, created_at, last_used_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256Hex(key), userId, now, now).run();
  return key;
}

/** Starts sign-in: stores a single-use state (linked to the current guest, if any) and returns Google's URL. */
export async function googleStart(db, request, env, origin, user) {
  if (!googleEnabled(env)) throw new HttpError(404, 'Google sign-in is not set up.');
  const ipHash = (await sha256Hex(`ip:${request.headers.get('CF-Connecting-IP') || 'unknown'}`)).slice(0, 24);
  await rateLimit(db, `gstart:${ipHash}`, 30, 900, 'Too many sign-in attempts. Wait 15 minutes and try again.');
  return googleAuthUrl(db, env, origin, { userId: user?.id || null, scope: 'openid email profile' });
}

/** Stores a single-use state and builds Google's consent URL. `prefix` marks what the state is for. */
export async function googleAuthUrl(db, env, origin, { userId, scope, prefix = '' }) {
  const now = Math.floor(Date.now() / 1000);
  await db.prepare('DELETE FROM oauth_states WHERE created_at < ?').bind(now - STATE_TTL_SEC).run();
  const state = prefix + randomString(40);
  await db.prepare('INSERT INTO oauth_states (state, user_id, created_at) VALUES (?, ?, ?)').bind(state, userId, now).run();
  const q = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID, redirect_uri: `${origin}/auth/google/callback`, response_type: 'code',
    scope, state, prompt: 'select_account'
  });
  return `${env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth'}?${q}`;
}

/** Checks and burns the state, then swaps the code for tokens. Returns { userId, tokens }. */
export async function googleExchange(db, env, origin, params) {
  if (!googleEnabled(env)) throw new HttpError(404, 'Google sign-in is not set up.');
  if (params.get('error')) throw new HttpError(400, 'Google sign-in was cancelled.');
  const state = params.get('state') || '';
  const code = params.get('code') || '';
  const row = state ? await db.prepare('DELETE FROM oauth_states WHERE state = ? RETURNING user_id, created_at').bind(state).first() : null;
  if (!row || row.created_at < Math.floor(Date.now() / 1000) - STATE_TTL_SEC) throw new HttpError(400, 'That sign-in link expired. Try again.');
  if (!code) throw new HttpError(400, 'Google sign-in failed.');
  const res = await fetch(env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${origin}/auth/google/callback`, grant_type: 'authorization_code' })
  });
  const tokens = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(400, 'Google sign-in failed.');
  return { userId: row.user_id, tokens };
}

function decodeJwtPayload(jwt) {
  const part = String(jwt || '').split('.')[1];
  if (!part) throw new HttpError(400, 'Google sign-in failed.');
  const b = part.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b + '='.repeat((4 - (b.length % 4)) % 4));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))));
}

/** A free, valid username from the Google name or email. */
async function autoHandle(db, claims) {
  const bases = [claims.name, claims.given_name, String(claims.email || '').split('@')[0]]
    .map(v => String(v || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9_]+/g, '').slice(0, 15));
  const free = async h => { try { normalizeHandle(h); } catch { return false; } return !(await db.prepare('SELECT 1 FROM users WHERE handle = ?').bind(h).first()); };
  for (const b of bases) if (b.length >= 3 && await free(b)) return b;
  const base = (bases.find(b => b.length >= 3) || 'user').slice(0, 15);
  for (let i = 0; i < 20; i++) {
    const h = `${base}${Math.floor(Math.random() * 9000) + 1000}`;
    if (await free(h)) return h;
  }
  return `user${randomString(8).toLowerCase().replace(/[^a-z0-9]/g, '0')}`;
}

/** Handles Google's redirect. Returns a new session key for this device. */
export async function googleCallback(db, request, env, origin, params) {
  const { userId: stateUserId, tokens: tok } = await googleExchange(db, env, origin, params);
  if (!tok.id_token) throw new HttpError(400, 'Google sign-in failed.');
  // The id_token came straight from Google's token endpoint over TLS, so its claims can be read without a signature check.
  const c = decodeJwtPayload(tok.id_token);
  const audOk = Array.isArray(c.aud) ? c.aud.includes(env.GOOGLE_CLIENT_ID) : c.aud === env.GOOGLE_CLIENT_ID;
  const issOk = c.iss === 'https://accounts.google.com' || c.iss === 'accounts.google.com';
  if (!audOk || !issOk || !c.sub || (c.exp && c.exp * 1000 < Date.now() - 60000)) throw new HttpError(400, 'Google sign-in failed.');
  if (c.email_verified !== true && c.email_verified !== 'true') throw new HttpError(400, 'Verify your Google email first.');
  const sub = String(c.sub);

  const existing = await db.prepare('SELECT id FROM users WHERE google_sub = ?').bind(sub).first();
  if (existing) return { key: await newSession(db, existing.id), userId: existing.id, kind: 'login' };

  const name = String(c.name || '').replace(/\s+/g, ' ').trim().slice(0, 60) || null;
  const guest = stateUserId
    ? await db.prepare('SELECT id, handle, display_name FROM users WHERE id = ? AND password_hash IS NULL AND google_sub IS NULL').bind(stateUserId).first()
    : null;
  if (guest) {
    const handle = guest.handle || await autoHandle(db, c);
    await db.prepare('UPDATE users SET google_sub = ?, handle = ?, display_name = COALESCE(display_name, ?) WHERE id = ?')
      .bind(sub, handle, name, guest.id).run();
    return { key: await newSession(db, guest.id), userId: guest.id, kind: 'upgrade' };
  }
  const id = `u_${randomString(14)}`;
  const now = new Date().toISOString();
  await db.prepare('INSERT INTO users (id, key_hash, handle, display_name, created_at, last_seen_at, google_sub) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, await sha256Hex(`ss_${randomString(32)}`), await autoHandle(db, c), name, now, now, sub).run();
  return { key: await newSession(db, id), userId: id, kind: 'new' };
}
