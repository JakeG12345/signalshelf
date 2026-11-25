// Real podcast transcripts from the show's own RSS feed (the Podcasting 2.0 <podcast:transcript> tag).
// Free: no transcript credits. Many hosts publish them (Buzzsprout, Transistor, Captivate, RSS.com, Podbean...);
// shows that don't publish one keep the episode description instead.
const UA = 'Mozilla/5.0 (compatible; SignalShelf/1.0; +https://signalshelf.jake-1c4.workers.dev)';
const MAX_FEED_BYTES = 25 * 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 5 * 1024 * 1024;
const TYPE_ORDER = ['text/plain', 'text/vtt', 'application/x-subrip', 'application/srt', 'application/json', 'text/html'];

const isHttp = u => /^https?:\/\/[^\s]+$/i.test(String(u || ''));

export function decodeEntities(s) {
  return String(s ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

const tagText = (block, tag) => {
  const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? decodeEntities(m[1]).trim() : '';
};
const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  return m ? decodeEntities(m[2] ?? m[3]) : '';
};
const stripQuery = u => String(u || '').split(/[?#]/)[0].toLowerCase();
const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Does this <item> block describe the episode? Matches on guid, then audio file, then title. */
export function itemMatches(block, { guid, enclosure, title }) {
  if (guid && tagText(block, 'guid') === String(guid).trim()) return true;
  if (enclosure) {
    const enc = block.match(/<enclosure\b[^>]*>/i);
    if (enc && stripQuery(attr(enc[0], 'url')) === stripQuery(enclosure)) return true;
  }
  return !!title && norm(tagText(block, 'title')) === norm(title);
}

/** The transcript links in an <item>, best format first. */
export function transcriptLinks(block) {
  const links = [...block.matchAll(/<podcast:transcript\b[^>]*>/gi)]
    .map(m => ({ url: attr(m[0], 'url'), type: attr(m[0], 'type').toLowerCase(), lang: attr(m[0], 'language').toLowerCase() }))
    .filter(l => isHttp(l.url));
  const rank = l => { const i = TYPE_ORDER.indexOf(l.type); return (i < 0 ? 50 : i) + (l.lang && !l.lang.startsWith('en') ? 100 : 0); };
  return links.sort((a, b) => rank(a) - rank(b));
}

/** Subtitle / JSON / HTML / plain transcript files to plain text. */
export function transcriptToText(body, type = '') {
  const raw = String(body || '').replace(/^﻿/, '');
  const t = type.toLowerCase();
  if (t.includes('json') || /^\s*[{[]/.test(raw)) {
    try {
      const data = JSON.parse(raw);
      const segs = Array.isArray(data) ? data : data.segments || data.transcript || [];
      if (Array.isArray(segs) && segs.length) {
        const parts = [];
        for (const s of segs) {
          const text = String(s.body ?? s.text ?? '').trim();
          if (text && parts[parts.length - 1] !== text) parts.push(text);
        }
        return parts.join(' ').replace(/\s+/g, ' ').trim();
      }
    } catch { /* not JSON after all */ }
  }
  if (t.includes('vtt') || t.includes('srt') || t.includes('subrip') || /-->/.test(raw.slice(0, 5000))) {
    const lines = [];
    for (const blk of raw.replace(/\r/g, '').split(/\n{2,}/)) {
      if (/^(WEBVTT|NOTE|STYLE|REGION)\b/.test(blk.trim())) continue;
      for (const line of blk.split('\n')) {
        const l = line.trim();
        if (!l || /-->/.test(l) || /^\d+$/.test(l)) continue;
        const text = decodeEntities(l.replace(/<v\s+([^>]+)>/gi, '').replace(/<[^>]+>/g, '')).trim();
        if (text && lines[lines.length - 1] !== text) lines.push(text);
      }
    }
    return lines.join(' ').replace(/\s+/g, ' ').trim();
  }
  if (t.includes('html') || /<\/(p|div|span|br)\b|<br\s*\/?>/i.test(raw.slice(0, 5000))) {
    return decodeEntities(raw.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  }
  return raw.replace(/\s+/g, ' ').trim();
}

async function readCapped(res, max) {
  const reader = res.body?.getReader();
  if (!reader) return (await res.text()).slice(0, max);
  const dec = new TextDecoder();
  let out = '', bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength; out += dec.decode(value, { stream: true });
    if (bytes > max) { reader.cancel().catch(() => {}); break; }
  }
  return out;
}

/** Streams the feed until the episode's <item> turns up, so big feeds stop early (picks are usually recent). */
async function findItem(feedUrl, episode, fetchImpl) {
  const res = await fetchImpl(feedUrl, { headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml, */*' },
    signal: AbortSignal.timeout(15000), cf: { cacheTtl: 900, cacheEverything: true } });
  if (!res.ok || !res.body) return null;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) { bytes += value.byteLength; buf += dec.decode(value, { stream: !done }); }
      let end;
      while ((end = buf.search(/<\/item>/i)) >= 0) {
        const pre = buf.slice(0, end);
        const start = Math.max(pre.lastIndexOf('<item>'), pre.lastIndexOf('<item '), pre.lastIndexOf('<item\n'), pre.lastIndexOf('<item\r'));
        const block = start >= 0 ? buf.slice(start, end) : '';
        buf = buf.slice(end + 7);
        if (block && itemMatches(block, episode)) return block;
      }
      if (done || bytes > MAX_FEED_BYTES) return null;
      if (buf.length > 2_000_000) buf = buf.slice(-1_000_000); // a runaway item: keep the tail only
    }
  } finally { reader.cancel().catch(() => {}); }
}

/**
 * Returns the episode's published transcript as plain text, or '' when the show doesn't publish one.
 * Never throws: a failed lookup just means "no transcript".
 */
export async function podcastTranscript({ feedUrl, guid, enclosure, title }, fetchImpl = fetch) {
  if (!isHttp(feedUrl) || !(guid || enclosure || title)) return '';
  try {
    const item = await findItem(feedUrl, { guid, enclosure, title }, fetchImpl);
    if (!item) return '';
    for (const link of transcriptLinks(item).slice(0, 3)) {
      try {
        const res = await fetchImpl(link.url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
        if (!res.ok) continue;
        const text = transcriptToText(await readCapped(res, MAX_TRANSCRIPT_BYTES), link.type || res.headers.get('content-type') || '');
        if (text.length > 200) return text;
      } catch { /* try the next format */ }
    }
  } catch (err) {
    console.error('podcast transcript lookup failed', feedUrl, err?.message);
  }
  return '';
}

// ---------- Speech-to-text fallback (Deepgram), for shows that don't publish a transcript ----------
// Saving queues a job and marks the episode 'pending'. The app then calls POST /api/transcribe/<id>, which asks
// Deepgram and waits for the answer (about 30s for an hour of audio). Jobs left behind (app closed) are resumed
// the next time the app loads; failures come back as a readable error and the episode keeps its description.
const JOB_TTL_SEC = 86400;
const RUNNING_SEC = 360;

export const deepgramEnabled = env => !!env.DEEPGRAM_API_KEY;

// ---------- Shared cache: one transcript per episode, reused across users ----------
// Only transcripts we fetched (show feed) or generated (Deepgram) go in here, never text a user typed or pasted.
export function episodeKeys({ id, enclosure }) {
  const keys = [];
  if (/^pod_apple_\d+$/.test(String(id || ''))) keys.push(String(id));
  if (isHttp(enclosure)) keys.push('audio:' + stripQuery(enclosure));
  return keys;
}
export async function cachedTranscript(db, keys) {
  if (!keys.length) return '';
  const row = await db.prepare(`SELECT text FROM podcast_transcripts WHERE key IN (${keys.map(() => '?').join(',')}) LIMIT 1`).bind(...keys).first();
  return row?.text || '';
}
export async function cacheTranscript(db, keys, text, source) {
  if (!keys.length || !text) return;
  const now = Math.floor(Date.now() / 1000);
  await db.batch(keys.map(k => db.prepare('INSERT INTO podcast_transcripts (key, text, source, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO NOTHING').bind(k, text, source, now)));
}

/** Queues transcription of an episode's audio. Returns true when queued. */
export async function queueTranscription(env, db, { userId, entryId, audioUrl, cacheKeys = [] }) {
  if (!deepgramEnabled(env) || !isHttp(audioUrl)) return false;
  const now = Math.floor(Date.now() / 1000);
  await db.batch([
    db.prepare('DELETE FROM stt_jobs WHERE created_at < ?').bind(now - JOB_TTL_SEC),
    db.prepare(`INSERT INTO stt_jobs (user_id, entry_id, audio_url, cache_keys, created_at, started_at) VALUES (?, ?, ?, ?, ?, NULL)
      ON CONFLICT(user_id, entry_id) DO UPDATE SET audio_url = excluded.audio_url, cache_keys = excluded.cache_keys, created_at = excluded.created_at, started_at = NULL`)
      .bind(userId, entryId, audioUrl, JSON.stringify(cacheKeys), now),
    db.prepare("UPDATE entries SET transcript_status = 'pending' WHERE user_id = ? AND id = ?").bind(userId, entryId)
  ]);
  return true;
}

/** Text from a Deepgram result: paragraphs when available, else the flat transcript. */
export function deepgramText(data) {
  const alt = data?.results?.channels?.[0]?.alternatives?.[0] || {};
  return String(alt.paragraphs?.transcript || alt.transcript || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

const resetPending = (db, userId, entryId) => db.prepare(`UPDATE entries SET transcript_status =
    CASE WHEN length(COALESCE(transcript, '')) > 0 THEN 'description' ELSE 'missing' END
  WHERE user_id = ? AND id = ? AND transcript_status = 'pending'`).bind(userId, entryId).run();

/**
 * Runs a queued job for one of the user's episodes and waits for Deepgram.
 * Returns { status: 'ok', text, cacheKeys } | { status: 'running' } | { status: 'none' }.
 * Throws an error with a readable message when Deepgram fails (the episode goes back to its description).
 */
export async function runTranscription(env, db, userId, entryId) {
  const now = Math.floor(Date.now() / 1000);
  const job = await db.prepare('SELECT * FROM stt_jobs WHERE user_id = ? AND entry_id = ? AND created_at >= ?').bind(userId, entryId, now - JOB_TTL_SEC).first();
  if (!job || !deepgramEnabled(env)) { await resetPending(db, userId, entryId); return { status: 'none' }; }
  // Claim it, unless another request is already waiting on Deepgram for this episode
  const claim = await db.prepare('UPDATE stt_jobs SET started_at = ? WHERE user_id = ? AND entry_id = ? AND (started_at IS NULL OR started_at < ?)')
    .bind(now, userId, entryId, now - RUNNING_SEC).run();
  if (!claim.meta?.changes) return { status: 'running' };

  const q = new URLSearchParams({ model: 'nova-3', smart_format: 'true', paragraphs: 'true' });
  let res, data = {};
  try {
    res = await fetch(`${env.DEEPGRAM_URL || 'https://api.deepgram.com'}/v1/listen?${q}`, {
      method: 'POST', headers: { Authorization: `Token ${env.DEEPGRAM_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: job.audio_url }), signal: AbortSignal.timeout(300000)
    });
    data = await res.json().catch(() => ({}));
  } catch (err) {
    res = { ok: false, status: 0 }; data = { err_msg: err?.name === 'TimeoutError' ? 'took too long' : err?.message };
  }
  await db.prepare('DELETE FROM stt_jobs WHERE user_id = ? AND entry_id = ?').bind(userId, entryId).run();
  const text = res.ok ? deepgramText(data) : '';
  if (text.length > 50) {
    let cacheKeys = [];
    try { cacheKeys = JSON.parse(job.cache_keys || '[]'); } catch { /* none */ }
    return { status: 'ok', text, cacheKeys };
  }
  await resetPending(db, userId, entryId);
  console.error('Deepgram failed', res.status, JSON.stringify(data).slice(0, 300));
  const why = res.ok ? 'no speech found' : (data.err_msg || data.message || data.error || `error ${res.status}`);
  const err = new Error(`Transcription failed (${String(why).slice(0, 140)})`);
  err.status = 502; err.expose = true;
  throw err;
}
