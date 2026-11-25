// History imports that need a third party: YouTube liked videos (Google OAuth) and podcast search (Apple's public directory).
import { HttpError } from '../../shared/core.js';

/** A 5xx whose message is safe to show (an upstream service failed, not our code). */
const upstream = msg => Object.assign(new HttpError(502, msg), { expose: true });
import { googleEnabled, googleAuthUrl, googleExchange, rateLimit } from './accounts.js';
import { createStore } from './store.js';

export const YT_STATE_PREFIX = 'yt_';
const LIKES_SETTING = 'yt_likes';
const https = u => (/^https:\/\//i.test(u || '') ? u : null);

function isoDurationSec(d) {
  const m = String(d || '').match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  return m ? (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0) : null;
}
const clock = sec => {
  if (!sec) return '';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
};

/** Returns Google's consent URL for read-only YouTube access. Nothing is kept except the list the user then picks from. */
export async function youtubeLikesStart(db, env, origin, user) {
  if (!googleEnabled(env)) throw new HttpError(404, 'YouTube import is not set up.');
  await rateLimit(db, `ytl:${user.id}`, 10, 3600, 'Too many tries. Wait an hour and try again.');
  return googleAuthUrl(db, env, origin, { userId: user.id, scope: 'https://www.googleapis.com/auth/youtube.readonly', prefix: YT_STATE_PREFIX });
}

/** Google's redirect for a likes import: fetch the liked videos once and park them for the picker. The token is not stored. */
export async function youtubeLikesCallback(db, env, origin, params) {
  const { userId, tokens } = await googleExchange(db, env, origin, params);
  if (!userId || !tokens.access_token) throw new HttpError(400, 'YouTube import failed. Try again.');
  const api = env.GOOGLE_API_URL || 'https://www.googleapis.com';
  const items = [];
  let pageToken = '';
  for (let page = 0; page < 4; page++) {
    const q = new URLSearchParams({ part: 'snippet,contentDetails', myRating: 'like', maxResults: '50' });
    if (pageToken) q.set('pageToken', pageToken);
    const res = await fetch(`${api}/youtube/v3/videos?${q}`, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('YouTube likes failed', res.status, JSON.stringify(data).slice(0, 300));
      throw new HttpError(400, res.status === 403 ? 'YouTube did not allow that. Tick the YouTube box when Google asks.' : 'YouTube import failed. Try again.');
    }
    for (const v of data.items || []) {
      if (!/^[A-Za-z0-9_-]{11}$/.test(v.id || '')) continue;
      const sec = isoDurationSec(v.contentDetails?.duration);
      items.push({
        key: `yt_${v.id}`, kind: 'youtube', title: String(v.snippet?.title || 'Untitled').slice(0, 300),
        creator: String(v.snippet?.channelTitle || '').slice(0, 120), url: `https://www.youtube.com/watch?v=${v.id}`,
        watched_at: null, length: clock(sec)
      });
    }
    pageToken = data.nextPageToken || '';
    if (!pageToken) break;
  }
  await createStore(db, userId).setSetting(LIKES_SETTING, { at: Date.now(), items });
}

/** The parked list, once. */
export async function takeYoutubeLikes(store) {
  const saved = await store.getSetting(LIKES_SETTING, null);
  if (!saved) return { items: [] };
  await store.setSetting(LIKES_SETTING, null);
  return { items: Date.now() - (saved.at || 0) < 3600000 ? saved.items || [] : [] };
}

// ---------- Podcast search (Apple's public directory, no sign-in) ----------
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
async function itunes(env, path, params) {
  let res, text;
  try {
    res = await fetch(`${env.ITUNES_URL || 'https://itunes.apple.com'}${path}?${new URLSearchParams(params)}`,
      { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    text = await res.text();
  } catch (err) {
    console.error('iTunes fetch failed', path, err?.message);
    throw upstream('Podcast search is not responding. Try again.');
  }
  if (!res.ok) {
    console.error('iTunes error', path, res.status, text.slice(0, 300));
    throw upstream(`Podcast search failed (${res.status}). Try again.`);
  }
  try { return JSON.parse(text.trim()); }
  catch {
    console.error('iTunes non-JSON', path, res.status, text.slice(0, 300));
    throw upstream('Podcast search sent back something odd. Try again.');
  }
}
const country = request => { const c = request.cf?.country; return typeof c === 'string' && /^[A-Z]{2}$/.test(c) ? c : 'US'; };

export async function searchPodcasts(env, request, q) {
  const term = String(q || '').trim().slice(0, 80);
  if (term.length < 2) return [];
  const data = await itunes(env, '/search', { media: 'podcast', entity: 'podcast', limit: '8', term, country: country(request) });
  return (data.results || []).filter(r => r.collectionId).map(r => ({
    id: String(r.collectionId), title: r.collectionName || '', creator: r.artistName || '', thumbnail: https(r.artworkUrl100)
  }));
}

export async function podcastEpisodes(env, request, id) {
  if (!/^\d{1,15}$/.test(String(id || ''))) throw new HttpError(400, 'Unknown show.');
  const data = await itunes(env, '/lookup', { id: String(id), entity: 'podcastEpisode', limit: '100', country: country(request) });
  return (data.results || []).filter(r => r.kind === 'podcast-episode' && r.trackId).map(r => {
    const description = String(r.description || r.shortDescription || '').trim().slice(0, 20000);
    return {
      key: `pod_apple_${r.trackId}`, kind: 'podcast', id: `pod_apple_${r.trackId}`, title: r.trackName || 'Untitled',
      creator: r.collectionName || '', url: r.trackViewUrl || null, watched_at: null, published_at: r.releaseDate || null,
      duration_sec: r.trackTimeMillis ? Math.round(r.trackTimeMillis / 1000) : null,
      thumbnail: https(r.artworkUrl600 || r.artworkUrl160), description
    };
  });
}
