// History imports that need a third party: YouTube liked videos (Google OAuth) and podcast search (Apple's public directory).
import { HttpError } from '../../shared/core.js';
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
async function itunes(env, path, params) {
  const res = await fetch(`${env.ITUNES_URL || 'https://itunes.apple.com'}${path}?${new URLSearchParams(params)}`);
  if (!res.ok) throw new HttpError(502, 'Podcast search is busy. Try again.');
  return res.json();
}
const country = request => (/^[A-Z]{2}$/.test(request.cf?.country || '') ? request.cf.country : 'US');

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
