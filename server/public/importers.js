// History importers. Pure functions: they run in the browser (the app) and in Node (tests).
// Every importer returns candidates shaped like:
//   { key, kind: 'youtube'|'podcast', title, creator, url, watched_at, duration_sec?, description?, id? }
// YouTube candidates are saved by URL (the server fetches details + transcript);
// podcast candidates carry everything needed and are saved directly.

const decode = s => String(s ?? '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
const clean = s => decode(s).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

export function videoIdFrom(url) {
  const m = String(url || '').match(/(?:[?&]v=|youtu\.be\/|\/shorts\/|\/live\/)([\w-]{11})/);
  return m ? m[1] : null;
}

/** Keeps the most recent watch of each video, newest first. */
function dedupe(items) {
  const seen = new Map();
  for (const it of items) {
    const prev = seen.get(it.key);
    if (!prev || (it.watched_at || '') > (prev.watched_at || '')) seen.set(it.key, it);
  }
  return [...seen.values()].sort((a, b) => (b.watched_at || '').localeCompare(a.watched_at || ''));
}

// ---------- YouTube: Google Takeout ----------

/** Takeout "watch-history.json" (choose JSON format when exporting). */
export function parseTakeoutJson(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('That file isn\'t valid JSON.'); }
  if (!Array.isArray(data)) throw new Error('This doesn\'t look like a YouTube watch-history file.');
  const items = [];
  for (const r of data) {
    if (!r || r.header && !/youtube/i.test(r.header)) continue;
    if ((r.details || []).some(d => /ads/i.test(d?.name || ''))) continue; // "From Google Ads"
    const id = videoIdFrom(r.titleUrl);
    if (!id) continue; // removed videos, posts, searches
    items.push({
      key: `yt_${id}`, kind: 'youtube',
      title: String(r.title || '').replace(/^Watched\s+/, '').trim() || `YouTube video ${id}`,
      creator: r.subtitles?.[0]?.name || '',
      url: `https://www.youtube.com/watch?v=${id}`,
      watched_at: r.time ? new Date(r.time).toISOString() : null
    });
  }
  return dedupe(items);
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * Parses Takeout's locale dates ("24 Nov 2026, 22:01:22 AEDT", "Nov 24, 2026, 10:01:22 PM EST") as local time.
 * Hand-rolled because Safari's Date.parse rejects most of these formats.
 */
export function parseLooseDate(text) {
  const s = String(text || '').replace(/[  ]/g, ' ');
  const mon = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?/i);
  const year = s.match(/\b(19|20)\d{2}\b/);
  if (!mon || !year) { const t = Date.parse(s); return Number.isFinite(t) ? t : NaN; }
  const rest = s.replace(mon[0], ' ').replace(year[0], ' ');
  const day = rest.match(/\b([0-3]?\d)\b(?!:)/);
  const time = s.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?m\.?)?/i);
  let h = time ? Number(time[1]) : 0;
  const ampm = time?.[4]?.toLowerCase().replace(/\./g, '');
  if (ampm === 'pm' && h < 12) h += 12;
  if (ampm === 'am' && h === 12) h = 0;
  const d = new Date(Number(year[0]), MONTHS.indexOf(mon[1].toLowerCase()), day ? Number(day[1]) : 1,
    h, time ? Number(time[2]) : 0, time?.[3] ? Number(time[3]) : 0);
  return d.getTime();
}

/** Takeout "watch-history.html" (the default format). Regex-based so it also runs in Node. */
export function parseTakeoutHtml(html) {
  const items = [];
  const cells = String(html).split(/<div class="content-cell[^"]*mdl-typography--body-1"[^>]*>/).slice(1);
  for (const cell of cells) {
    const body = cell.split('</div>')[0];
    if (/From Google Ads/i.test(cell.slice(0, 2000))) continue;
    const links = [...body.matchAll(/<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
    const video = links.find(l => videoIdFrom(l[1]));
    if (!video) continue;
    const id = videoIdFrom(video[1]);
    const channel = links.find(l => l !== video && /youtube\.com\/(channel|@|c\/|user)/.test(l[1]));
    // The timestamp is the last line of the cell: "24 Nov 2026, 10:01:22 pm AEDT"
    const lines = body.split(/<br\s*\/?>/i).map(clean).filter(Boolean);
    const t = parseLooseDate(lines[lines.length - 1]);
    items.push({
      key: `yt_${id}`, kind: 'youtube',
      title: clean(video[2]) || `YouTube video ${id}`,
      creator: channel ? clean(channel[2]) : '',
      url: `https://www.youtube.com/watch?v=${id}`,
      watched_at: Number.isFinite(t) ? new Date(t).toISOString() : null
    });
  }
  if (!items.length && !/content-cell/.test(html)) throw new Error('This doesn\'t look like a YouTube watch-history file.');
  return dedupe(items);
}

export function parseTakeout(text, filename = '') {
  const t = String(text).trimStart();
  return t.startsWith('[') || /\.json$/i.test(filename) ? parseTakeoutJson(text) : parseTakeoutHtml(text);
}

// ---------- YouTube: live history page (used by the Chrome extension) ----------

function collect(obj, keys, out = [], depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 80) return out;
  if (Array.isArray(obj)) { for (const v of obj) collect(v, keys, out, depth + 1); return out; }
  for (const [k, v] of Object.entries(obj)) {
    if (keys.includes(k)) out.push([k, v]);
    else collect(v, keys, out, depth + 1);
  }
  return out;
}

/** Parses ytInitialData from youtube.com/feed/history (old videoRenderer and newer lockupViewModel layouts). */
export function parseHistoryPage(initialData) {
  const items = [];
  for (const [k, v] of collect(initialData, ['videoRenderer', 'lockupViewModel'])) {
    let id, title, creator, length;
    if (k === 'videoRenderer') {
      id = v.videoId;
      title = v.title?.runs?.map(r => r.text).join('') || v.title?.simpleText;
      creator = v.ownerText?.runs?.[0]?.text || v.longBylineText?.runs?.[0]?.text || '';
      length = v.lengthText?.simpleText;
    } else {
      if (v.contentType && !/VIDEO/.test(v.contentType)) continue;
      id = v.contentId;
      const meta = v.metadata?.lockupMetadataViewModel;
      title = meta?.title?.content;
      creator = meta?.metadata?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts?.[0]?.text?.content || '';
    }
    if (!id || !/^[\w-]{11}$/.test(id) || !title) continue;
    items.push({ key: `yt_${id}`, kind: 'youtube', title, creator, url: `https://www.youtube.com/watch?v=${id}`, watched_at: null, length });
  }
  const seen = new Set();
  return items.filter(i => !seen.has(i.key) && seen.add(i.key)); // page order is already newest first
}

// ---------- Apple Podcasts (Mac library file) ----------

/** Builds the query for MTLibrary.sqlite using only columns that exist in this version of the app. */
export function applePodcastsQuery(episodeCols, podcastCols, limit = 300) {
  const e = c => (episodeCols.includes(c) ? `e.${c}` : 'NULL');
  const p = c => (podcastCols.includes(c) ? `p.${c}` : 'NULL');
  const played = [
    episodeCols.includes('ZLASTDATEPLAYED') ? 'e.ZLASTDATEPLAYED IS NOT NULL' : null,
    episodeCols.includes('ZPLAYCOUNT') ? 'e.ZPLAYCOUNT > 0' : null,
    episodeCols.includes('ZPLAYHEAD') ? 'e.ZPLAYHEAD > 60' : null
  ].filter(Boolean).join(' OR ') || '1';
  return `SELECT ${e('ZUUID')} AS uuid, ${e('ZTITLE')} AS title, ${p('ZTITLE')} AS show, ${p('ZAUTHOR')} AS author,
      ${e('ZWEBPAGEURL')} AS url, ${e('ZDURATION')} AS duration, ${e('ZLASTDATEPLAYED')} AS last_played,
      ${e('ZITEMDESCRIPTIONWITHOUTHTML')} AS description, ${p('ZIMAGEURL')} AS image,
      ${e('ZSTORETRACKID')} AS store_id, ${p('ZSTORECOLLECTIONID')} AS show_store_id,
      ${p('ZFEEDURL')} AS feed_url, ${e('ZGUID')} AS guid, ${e('ZENCLOSUREURL')} AS enclosure
    FROM ZMTEPISODE e LEFT JOIN ZMTPODCAST p ON e.ZPODCAST = p.Z_PK
    WHERE ${played}
    ORDER BY ${episodeCols.includes('ZLASTDATEPLAYED') ? 'e.ZLASTDATEPLAYED DESC' : 'e.Z_PK DESC'} LIMIT ${Number(limit) || 300}`;
}

const coreDataToIso = s => (s ? new Date((Number(s) + 978307200) * 1000).toISOString() : null);

export function parseApplePodcastRows(rows) {
  return rows.filter(r => r.uuid && r.title).map(r => {
    const appleUrl = r.store_id && r.show_store_id ? `https://podcasts.apple.com/podcast/id${r.show_store_id}?i=${r.store_id}` : '';
    return {
      key: `pod_${r.uuid}`, kind: 'podcast', id: `pod_${r.uuid}`,
      title: String(r.title), creator: r.show || r.author || 'Podcast',
      url: /^https?:\/\//.test(r.url || '') ? r.url : appleUrl,
      duration_sec: r.duration ? Math.round(r.duration) : null,
      watched_at: coreDataToIso(r.last_played),
      thumbnail: /^https:\/\//.test(r.image || '') ? r.image : null,
      description: String(r.description || '').trim(),
      feed_url: /^https?:\/\//.test(r.feed_url || '') ? r.feed_url : null,
      episode_guid: r.guid ? String(r.guid) : null,
      enclosure_url: /^https?:\/\//.test(r.enclosure || '') ? r.enclosure : null
    };
  });
}
