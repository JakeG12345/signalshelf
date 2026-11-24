// Turns any shared link into an entry: YouTube, Apple Podcasts, or any web page (Spotify, articles, X posts…).
// Pure: pass fetchImpl in tests. Works in Node 18+ and Cloudflare Workers.
import { parseVideoId, fetchYouTubeVideo, decodeEntities } from './youtube.js';
import { HttpError } from './core.js';

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const TIMEOUT_MS = 12000;

/** Pulls the first URL out of shared text like "Check this out https://youtu.be/x". */
export function extractUrl(input) {
  const s = String(input ?? '').trim();
  const m = s.match(/https?:\/\/[^\s<>"']+/i);
  if (m) return m[0].replace(/[),.;!?]+$/, '');
  if (/^[\w-]{11}$/.test(s)) return `https://www.youtube.com/watch?v=${s}`;
  if (/^[\w-]+(\.[\w-]+)+\/?\S*$/.test(s)) return `https://${s}`;
  return null;
}

export function parseApplePodcastUrl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!/(^|\.)podcasts\.apple\.com$/.test(u.hostname)) return null;
  const podcastId = (u.pathname.match(/\/id(\d+)/) || [])[1];
  const episodeId = u.searchParams.get('i');
  return podcastId ? { podcastId, episodeId } : null;
}

async function sha1Hex(text) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function getText(url, fetchImpl, headers = {}) {
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-AU,en;q=0.9', ...headers },
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

export function readMeta(html) {
  const head = String(html).slice(0, 300000);
  const meta = {};
  const re = /<meta\s+[^>]*?(?:property|name)\s*=\s*["']([^"']+)["'][^>]*?content\s*=\s*["']([^"']*)["'][^>]*>|<meta\s+[^>]*?content\s*=\s*["']([^"']*)["'][^>]*?(?:property|name)\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(head))) {
    const key = (m[1] || m[4] || '').toLowerCase();
    const val = decodeEntities(m[2] ?? m[3] ?? '').trim();
    if (key && val && !(key in meta)) meta[key] = val;
  }
  const title = (head.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  if (title) meta._title = decodeEntities(title).replace(/\s+/g, ' ').trim();
  return meta;
}

const httpsOnly = u => (/^https:\/\//i.test(u || '') ? u : null);

async function captureApplePodcast(url, ids, fetchImpl, warnings) {
  if (ids.episodeId) {
    try {
      const data = JSON.parse(await getText(
        `https://itunes.apple.com/lookup?id=${ids.podcastId}&entity=podcastEpisode&limit=300`, fetchImpl));
      const ep = (data.results || []).find(r => String(r.trackId) === ids.episodeId && r.kind === 'podcast-episode');
      if (ep) {
        const desc = String(ep.description || ep.shortDescription || '').trim();
        return {
          id: `pod_apple_${ids.episodeId}`, source: 'apple_podcasts', title: ep.trackName, creator: ep.collectionName || '',
          url: ep.trackViewUrl || url, duration_sec: ep.trackTimeMillis ? Math.round(ep.trackTimeMillis / 1000) : null,
          published_at: ep.releaseDate || null, thumbnail: httpsOnly(ep.artworkUrl600 || ep.artworkUrl160),
          transcript: desc, transcript_status: desc ? 'description' : 'missing', warnings
        };
      }
      warnings.push('Episode not in the show\'s latest 300 episodes; used the page details instead.');
    } catch (e) {
      warnings.push(`Apple Podcasts lookup failed: ${e.message}`);
    }
  }
  const page = await captureWebPage(url, fetchImpl, warnings);
  return { ...page, id: ids.episodeId ? `pod_apple_${ids.episodeId}` : `pod_apple_show_${ids.podcastId}`, source: 'apple_podcasts' };
}

/** Drops tracking params so the same page shared twice maps to one entry. */
export function canonicalUrl(url) {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_\w+|fbclid|gclid|si|igsh|igshid|ref|ref_src|s|t)$/i.test(k) && !(k === 't' && /youtu/.test(u.hostname))) u.searchParams.delete(k);
    }
    u.hash = '';
    return u.toString();
  } catch { return url; }
}

async function captureWebPage(rawUrl, fetchImpl, warnings) {
  const url = canonicalUrl(rawUrl);
  let meta = {};
  try { meta = readMeta(await getText(url, fetchImpl)); }
  catch (e) { warnings.push(`Could not load the page: ${e.message}`); }
  let host = '';
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
  const title = meta['og:title'] || meta['twitter:title'] || meta._title || url;
  const desc = meta['og:description'] || meta['twitter:description'] || meta.description || '';
  const durMeta = Number(meta['music:duration'] || meta['video:duration'] || 0);
  return {
    id: `web_${(await sha1Hex(url)).slice(0, 20)}`,
    source: 'web',
    title: title.slice(0, 500),
    creator: meta['author'] || meta['og:site_name'] || meta['twitter:creator'] || host,
    url,
    duration_sec: durMeta || null,
    published_at: meta['article:published_time'] || null,
    thumbnail: httpsOnly(meta['og:image'] || meta['twitter:image']),
    transcript: desc,
    transcript_status: desc ? 'description' : 'missing',
    warnings
  };
}

/** Main entry point: returns entry data plus a `warnings` array. Throws HttpError(400) for non-links. */
export async function captureLink(input, { fetchImpl = fetch, transcriptProvider = null, hasTranscript = null } = {}) {
  const url = extractUrl(input);
  if (!url) throw new HttpError(400, 'That does not look like a link.');
  const videoId = parseVideoId(url);
  if (videoId) {
    // Skip paid transcript lookups when this video already has one saved
    const skipTranscript = hasTranscript ? await hasTranscript(`yt_${videoId}`) : false;
    return fetchYouTubeVideo(url, { fetchImpl, transcriptProvider, skipTranscript });
  }
  const warnings = [];
  const apple = parseApplePodcastUrl(url);
  if (apple) return captureApplePodcast(url, apple, fetchImpl, warnings);
  return captureWebPage(url, fetchImpl, warnings);
}
