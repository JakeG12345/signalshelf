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
