// Server-side YouTube capture for "paste a link". The Chrome extension is still the most reliable
// transcript path (it runs inside your signed-in browser and can read the transcript panel);
// this module degrades gracefully: metadata always, transcript when YouTube serves captions.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'CONSENT=YES+1; SOCS=CAI' };
const TIMEOUT_MS = 12000;

/** Accepts watch/shorts/embed/live/youtu.be URLs or a bare 11-char id. */
export function parseVideoId(input) {
  const s = String(input ?? '').trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  let u;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); } catch { return null; }
  const host = u.hostname.replace(/^(www\.|m\.|music\.)/, '');
  if (host === 'youtu.be') return /^[\w-]{11}$/.test(u.pathname.slice(1, 12)) ? u.pathname.slice(1, 12) : null;
  if (!['youtube.com', 'youtube-nocookie.com'].includes(host)) return null;
  const v = u.searchParams.get('v');
  if (v && /^[\w-]{11}$/.test(v)) return v;
  const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/);
  return m ? m[1] : null;
}

/** Robustly extracts the JSON object that follows `marker` (brace matching, string-aware). */
export function extractJsonObject(text, marker) {
  let i = text.indexOf(marker);
  if (i === -1) return null;
  i = text.indexOf('{', i + marker.length);
  if (i === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try { return JSON.parse(text.slice(i, j + 1)); } catch { return null; }
    }
  }
  return null;
}

/** Prefer human English captions, then auto English, then any human track, then anything. */
export function pickCaptionTrack(tracks = [], lang = 'en') {
  if (!tracks.length) return null;
  const score = t => {
    const code = String(t.languageCode || '').toLowerCase();
    let s = 0;
    if (code === lang) s += 40; else if (code.startsWith(lang + '-')) s += 35;
    if (t.kind !== 'asr') s += 20;
    if (t.isTranslatable) s += 1;
    return s;
  };
  return [...tracks].sort((a, b) => score(b) - score(a))[0];
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodeEntities(s) {
  return String(s).replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const clean = s => s.replace(/\s+/g, ' ').trim();

/** Depth-first search for every object stored under `key` anywhere inside `obj`. */
function collect(obj, key, out = [], depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 60) return out;
  if (Array.isArray(obj)) { for (const v of obj) collect(v, key, out, depth + 1); return out; }
  for (const [k, v] of Object.entries(obj)) {
    if (k === key) out.push(v);
    else collect(v, key, out, depth + 1);
  }
  return out;
}

/** Parses the response of YouTube's own "Show transcript" endpoint into plain text. */
export function parseInnertubeTranscript(json) {
  const segs = collect(json, 'transcriptSegmentRenderer');
  return clean(segs.map(s => (s.snippet?.runs || []).map(r => r.text || '').join('') || s.snippet?.simpleText || '').join(' '));
}

/**
 * Fallback used when caption files come back empty: asks the same endpoint the
 * "Show transcript" panel uses, with the params YouTube embeds in the watch page.
 */
export async function fetchInnertubeTranscript(html, fetchImpl = fetch) {
  const initialData = extractJsonObject(html, 'ytInitialData');
  const params = collect(initialData, 'getTranscriptEndpoint').map(e => e?.params).find(Boolean);
  if (!params) return '';
  const version = (html.match(/"INNERTUBE_CLIENT_VERSION":"([\d.]+)"/) || [])[1] || '2.20251120.01.00';
  const key = (html.match(/"INNERTUBE_API_KEY":"([\w-]+)"/) || [])[1];
  const res = await fetchImpl(`https://www.youtube.com/youtubei/v1/get_transcript?prettyPrint=false${key ? `&key=${key}` : ''}`, {
    method: 'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/json', 'X-Youtube-Client-Name': '1', 'X-Youtube-Client-Version': version, Origin: 'https://www.youtube.com' },
    body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: version, hl: 'en', gl: 'US' } }, params }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!res.ok) return '';
  try { return parseInnertubeTranscript(JSON.parse(await res.text())); } catch { return ''; }
}

/** Parses json3, srv1 (<text>) or srv3 (<p><s>) caption formats into plain text. */
export function parseCaptionBody(body) {
  const t = String(body || '').trim();
  if (!t) return '';
  if (t.startsWith('{')) {
    try {
      const j = JSON.parse(t);
      return clean((j.events || []).map(ev => (ev.segs || []).map(s => s.utf8 || '').join('')).join(' '));
    } catch { return ''; }
  }
  const parts = [];
  const re = /<(text|p)\b[^>]*>([\s\S]*?)<\/\1>/g;
  let m;
  // srv1 captions are often double-encoded (&amp;#39;), so decode twice
  while ((m = re.exec(t))) parts.push(decodeEntities(decodeEntities(m[2].replace(/<[^>]+>/g, ''))));
  return clean(parts.join(' '));
}

async function get(url, fetchImpl) {
  const res = await fetchImpl(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${new URL(url).pathname}`);
  return res.text();
}

export async function fetchTranscriptFromTrack(track, fetchImpl = fetch) {
  if (!track?.baseUrl) return '';
  const base = track.baseUrl.startsWith('http') ? track.baseUrl : `https://www.youtube.com${track.baseUrl}`;
  for (const url of [base.replace(/&fmt=[^&]*/, '') + '&fmt=json3', base]) {
    try {
      const text = parseCaptionBody(await get(url, fetchImpl));
      if (text) return text;
    } catch { /* try next format */ }
  }
  return '';
}

/** Fetches metadata (+ transcript when available) for a YouTube URL. Never throws for missing captions. */
/**
 * transcriptProvider: optional async (watchUrl) => text, tried first (e.g. a paid transcript API that isn't IP-blocked).
 * skipTranscript: true when the caller already has this video's transcript (saves provider credits).
 */
export async function fetchYouTubeVideo(input, { fetchImpl = fetch, transcriptProvider = null, skipTranscript = false } = {}) {
  const videoId = parseVideoId(input);
  if (!videoId) {
    const err = new Error('That does not look like a YouTube video link.');
    err.status = 400;
    throw err;
  }
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const warnings = [];
  const out = {
    id: `yt_${videoId}`, source: 'youtube', url, title: '', creator: '', duration_sec: null,
    published_at: null, thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    transcript: '', transcript_status: 'missing', warnings
  };

  let player = null;
  let html = '';
  try {
    html = await get(`${url}&hl=en&bpctr=9999999999&has_verified=1`, fetchImpl);
    player = extractJsonObject(html, 'ytInitialPlayerResponse');
    if (!player) warnings.push('Could not read the YouTube page data (consent wall or layout change).');
  } catch (e) {
    warnings.push(`Could not load the YouTube page: ${e.message}`);
  }

  let tracks = [];
  if (player) {
    const status = player.playabilityStatus?.status;
    if (status && status !== 'OK') warnings.push(`YouTube reports this video as ${status}${player.playabilityStatus?.reason ? `: ${player.playabilityStatus.reason}` : ''}.`);
    const d = player.videoDetails || {};
    const mf = player.microformat?.playerMicroformatRenderer || {};
    out.title = d.title || mf.title?.simpleText || '';
    out.creator = d.author || mf.ownerChannelName || '';
    out.duration_sec = Number(d.lengthSeconds) || null;
    out.published_at = mf.publishDate || mf.uploadDate || null;
    tracks = player.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  }

  if (skipTranscript) {
    out.transcript_status = null; // caller keeps the transcript it already has
  } else {
    // 1) Transcript service first when configured (YouTube blocks most cloud servers)
    if (transcriptProvider) {
      try { out.transcript = String((await transcriptProvider(url)) || '').trim(); }
      catch (e) { warnings.push(`Transcript service: ${e.message}`); }
    }
    // 2) The caption file YouTube lists, 3) the "Show transcript" panel endpoint
    if (!out.transcript && tracks.length) out.transcript = await fetchTranscriptFromTrack(pickCaptionTrack(tracks), fetchImpl);
    if (!out.transcript && html) {
      try { out.transcript = await fetchInnertubeTranscript(html, fetchImpl); } catch { /* ignore */ }
    }
    if (out.transcript) out.transcript_status = 'ok';
    else if (player && !tracks.length && !transcriptProvider) warnings.push('This video has no captions.');
    else warnings.push('No transcript available for this video right now. You can paste one in the app, or save it from desktop Chrome with the extension.');
  }

  if (!out.title) {
    try {
      const o = JSON.parse(await get(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`, fetchImpl));
      out.title = o.title || '';
      out.creator = out.creator || o.author_name || '';
    } catch (e) {
      warnings.push(`oEmbed lookup failed: ${e.message}`);
    }
  }
  if (!out.title) {
    const err = new Error(`Could not fetch details for video ${videoId}. ${warnings.join(' ')}`.trim());
    err.status = 502;
    throw err;
  }
  return out;
}
