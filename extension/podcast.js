// Podcast episodes from Apple Podcasts and Spotify pages. Same approach as the web app:
// find the episode in Apple's public directory (from the user's browser, which Apple doesn't block),
// so the server gets the audio and feed address and can fetch or make a transcript.
const ITUNES = 'https://itunes.apple.com';

/** Which podcast page is this? { kind: 'apple', show, episode } | { kind: 'spotify', id } | null */
export function podcastLink(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (/(^|\.)podcasts\.apple\.com$/.test(u.hostname)) {
    const show = (u.pathname.match(/\/id(\d+)/) || [])[1];
    const episode = u.searchParams.get('i');
    return show && episode ? { kind: 'apple', show, episode } : null;
  }
  if (u.hostname === 'open.spotify.com') {
    const id = (u.pathname.match(/\/episode\/([A-Za-z0-9]{10,40})/) || [])[1];
    return id ? { kind: 'spotify', id } : null;
  }
  return null;
}

const https = u => (/^https:\/\//i.test(u || '') ? u : null);
export const normTitle = t => String(t || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();
const showOf = data => (data.results || []).find(r => r.kind === 'podcast' || (r.wrapperType === 'track' && r.feedUrl));

/** The episode in the shape the server's /api/ingest takes for podcasts. */
export function mapEpisode(r, feedUrl) {
  return {
    id: `pod_apple_${r.trackId}`, source: 'apple_podcasts', title: r.trackName || 'Untitled', creator: r.collectionName || '',
    url: r.trackViewUrl || null, published_at: r.releaseDate || null,
    duration_sec: r.trackTimeMillis ? Math.round(r.trackTimeMillis / 1000) : null,
    thumbnail: https(r.artworkUrl600 || r.artworkUrl160),
    description: String(r.description || r.shortDescription || '').trim().slice(0, 20000),
    feed_url: feedUrl || r.feedUrl || null, episode_guid: r.episodeGuid || null, enclosure_url: r.episodeUrl || null
  };
}

async function itunes(fetchImpl, path, params) {
  const res = await fetchImpl(`${ITUNES}${path}?${new URLSearchParams(params)}`);
  if (!res.ok) throw new Error(`Podcast directory error ${res.status}`);
  return res.json();
}

/**
 * Finds the episode behind an Apple Podcasts or Spotify link. Returns the ingest body, or null when it
 * isn't in the directory (Spotify exclusives). `api` is used for Spotify only, to read the episode page.
 */
export async function resolveEpisode(url, { fetchImpl = fetch, api } = {}) {
  const link = podcastLink(url);
  if (!link) return null;

  if (link.kind === 'apple') {
    // Apple returns at most 200 episodes per lookup; older ones are looked up by their own id
    const data = await itunes(fetchImpl, '/lookup', { id: link.show, entity: 'podcastEpisode', limit: '200' });
    let r = (data.results || []).find(x => String(x.trackId) === link.episode && x.kind === 'podcast-episode');
    let feed = showOf(data)?.feedUrl;
    if (!r) {
      const one = await itunes(fetchImpl, '/lookup', { id: link.episode, entity: 'podcastEpisode' });
      r = (one.results || []).find(x => String(x.trackId) === link.episode);
    }
    return r ? { ...mapEpisode(r, feed), url } : null;
  }

  // Spotify: read the episode and show names, then match them in the directory
  const info = await api(`/api/spotify-episode?url=${encodeURIComponent(url)}`);
  const want = normTitle(info.title), show = normTitle(info.show);
  const sameShow = r => !show || normTitle(r.collectionName).includes(show) || show.includes(normTitle(r.collectionName));
  for (const term of [info.show ? `${info.title} ${info.show}` : info.title, info.title]) {
    const data = await itunes(fetchImpl, '/search', { media: 'podcast', entity: 'podcastEpisode', limit: '25', term: term.slice(0, 200) });
    const eps = (data.results || []).filter(r => r.trackId && (r.kind === 'podcast-episode' || r.episodeUrl));
    const r = eps.find(x => normTitle(x.trackName) === want && sameShow(x))
      || eps.find(x => sameShow(x) && (normTitle(x.trackName).includes(want) || want.includes(normTitle(x.trackName))));
    if (r) {
      let feed = r.feedUrl;
      if (!feed && r.collectionId) feed = showOf(await itunes(fetchImpl, '/lookup', { id: String(r.collectionId) }))?.feedUrl;
      const ep = mapEpisode(r, feed);
      return { ...ep, url, thumbnail: ep.thumbnail || info.image || null };
    }
  }
  return null;
}
