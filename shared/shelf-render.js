// Pure Public Shelf rendering, shared by the local server and the Cloudflare Worker.
// Personal notes and transcripts are never part of shelf data.

export const DEFAULT_SHELF_SETTINGS = {
  title: 'My Signal Shelf',
  author: '',
  tagline: 'The highest-signal videos & podcasts I\'ve found on making money and building with AI.',
  minRating: 4,
  includeTakeaways: true,
  maxTakeaways: 5,
  includeYoutube: true,
  includePodcasts: true,
  includeLinks: true,
  published: false
};

export function normalizeShelfSettings(current = {}, patch = {}) {
  const s = { ...DEFAULT_SHELF_SETTINGS, ...current };
  if (typeof patch.title === 'string') s.title = patch.title.trim().slice(0, 120) || DEFAULT_SHELF_SETTINGS.title;
  if (typeof patch.author === 'string') s.author = patch.author.trim().slice(0, 80);
  if (typeof patch.tagline === 'string') s.tagline = patch.tagline.trim().slice(0, 280);
  if (patch.minRating !== undefined) s.minRating = Math.min(5, Math.max(1, Math.round(Number(patch.minRating)) || 4));
  if (patch.maxTakeaways !== undefined) s.maxTakeaways = Math.min(20, Math.max(0, Math.round(Number(patch.maxTakeaways)) || 0));
  for (const k of ['includeTakeaways', 'includeYoutube', 'includePodcasts', 'includeLinks', 'published']) if (k in patch) s[k] = !!patch[k];
  return s;
}

import { esc, FONT_LINKS, BASE_CSS, RATING_LABELS, barsHtml, LOGO_SVG } from './theme.js';

const safeUrl = u => (/^https:\/\/[^\s"'<>]+$/i.test(String(u || '')) ? String(u) : '');
const fmtDuration = s => {
  if (!s) return '';
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
};

const KIND_LABEL = { video: 'Video', podcast: 'Podcast', link: 'Link' };

/**
 * Public data only. Personal notes and transcripts are deliberately never included.
 */
export function shelfDataFromEntries(entries, settings) {
  const items = entries
    .filter(e => e.signal_rating >= settings.minRating)
    .filter(e => (e.source === 'youtube' ? settings.includeYoutube : e.source === 'apple_podcasts' ? settings.includePodcasts : settings.includeLinks))
    .map(e => ({
      id: e.id,
      type: e.source === 'youtube' ? 'video' : e.source === 'apple_podcasts' ? 'podcast' : 'link',
      title: e.title,
      creator: e.creator || '',
      url: safeUrl(e.url),
      thumbnail: safeUrl(e.thumbnail),
      rating: e.signal_rating,
      monetization_models: e.monetization_models,
      key_takeaways: settings.includeTakeaways ? e.key_takeaways.slice(0, settings.maxTakeaways) : [],
      duration_sec: e.duration_sec || null,
      watched_at: e.watched_at
    }));
  const modelCounts = {};
  for (const it of items) for (const m of it.monetization_models) modelCounts[m] = (modelCounts[m] || 0) + 1;
  return {
    schema: 'signal-shelf/1',
    title: settings.title,
    author: settings.author,
    tagline: settings.tagline,
    min_rating: settings.minRating,
    generated_at: new Date().toISOString(),
    count: items.length,
    models: Object.entries(modelCounts).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
    items
  };
}

export function renderShelfHtml(data, { jsonHref = 'shelf.json', ctaUrl = '', canonicalUrl = '' } = {}) {
  const appUrl = ctaUrl ? `${ctaUrl.replace(/\/$/, '')}/app/` : '';
  const rows = data.items.map(it => {
    const initials = esc((it.creator || it.title).split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase());
    const cover = it.thumbnail
      ? `<img src="${esc(it.thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
      : `<span class="ph wide">${initials}</span>`;
    const title = it.url ? `<a href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">${esc(it.title)}</a>` : esc(it.title);
    const meta = [esc(it.creator), KIND_LABEL[it.type] || 'Link', fmtDuration(it.duration_sec)].filter(Boolean).join(', ');
    const tags = it.monetization_models.map(m => `<span class="tag">${esc(m)}</span>`).join('');
    const tk = it.key_takeaways.length ? `<ul class="takeaways">${it.key_takeaways.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : '';
    const save = appUrl && it.url ? `<a class="save" href="${esc(appUrl)}#add=${esc(encodeURIComponent(it.url))}">Add to my shelf</a>` : '';
    return `<article class="pick" data-models="${esc(JSON.stringify(it.monetization_models.map(m => m.toLowerCase())))}">
  <div class="cover">${cover}</div>
  <div class="what">
    <h2>${title}</h2>
    <p class="meta">${meta}</p>
    ${tk}
    <p class="foot">${tags}${save}</p>
  </div>
  <div class="meter">${barsHtml(it.rating, 'lg')}<span>${RATING_LABELS[it.rating]}</span></div>
</article>`;
  }).join('\n');
  const filters = data.models.length > 1
    ? `<nav class="filters" aria-label="Filter by model"><button class="chip on" data-f="">All ${data.count}</button>${data.models.map(m => `<button class="chip" data-f="${esc(m.name.toLowerCase())}">${esc(m.name)} ${m.count}</button>`).join('')}</nav>`
    : '';
  const updated = new Date(data.generated_at).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
  const floor = data.min_rating >= 5 ? 'Only five-bar picks' : `${data.count} pick${data.count === 1 ? '' : 's'} rated ${data.min_rating} bars or higher`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(data.title)}</title>
<meta name="description" content="${esc(data.tagline)}">
<meta property="og:title" content="${esc(data.title)}">
<meta property="og:description" content="${esc(data.tagline)}">
<meta property="og:type" content="website">
${canonicalUrl ? `<meta property="og:url" content="${esc(canonicalUrl)}"><link rel="canonical" href="${esc(canonicalUrl)}">` : ''}
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(data.title)}">
<meta name="twitter:description" content="${esc(data.tagline)}">
<meta name="theme-color" content="#E6E8E2">
${FONT_LINKS}
<style>${BASE_CSS}
  .wrap { max-width:920px; margin:0 auto; padding:calc(20px + env(safe-area-inset-top)) 22px calc(48px + env(safe-area-inset-bottom)); }
  nav.top { display:flex; justify-content:space-between; align-items:center; margin-bottom:56px; }
  h1 { font-size:clamp(30px, 6vw, 52px); line-height:1.04; margin:0 0 14px; max-width:16ch; }
  .tagline { margin:0; max-width:56ch; color:var(--mute); font-size:18px; }
  .count { margin:22px 0 0; font-weight:650; }
  .filters { display:flex; flex-wrap:wrap; gap:8px; margin-top:26px; }
  .chip { font:inherit; font-size:14px; font-weight:600; cursor:pointer; background:transparent; color:var(--ink); border:1.5px solid var(--line); border-radius:999px; padding:5px 12px; }
  .chip.on { background:var(--ink); border-color:var(--ink); color:var(--plate); }
  .list { margin-top:34px; border-top:3px solid var(--ink); }
  .pick { display:grid; grid-template-columns:168px 1fr auto; gap:22px; padding:22px 0; border-bottom:1px solid var(--line); align-items:start; }
  .pick.hide { display:none; }
  .cover { aspect-ratio:16/9; background:var(--well); border-radius:3px; overflow:hidden; display:grid; place-items:center; }
  .cover img { width:100%; height:100%; object-fit:cover; display:block; }
  .ph { font-size:26px; color:var(--mute); }
  h2 { margin:0; font-size:19px; line-height:1.3; font-weight:700; }
  h2 a { text-decoration:none; }
  h2 a:hover { color:var(--signal); text-decoration:underline; }
  .meta { margin:4px 0 0; color:var(--mute); font-size:14px; }
  .takeaways { margin:12px 0 0; padding:0 0 0 18px; max-width:60ch; }
  .takeaways li { margin-bottom:4px; }
  .takeaways li::marker { color:var(--signal); }
  .foot { margin:12px 0 0; display:flex; flex-wrap:wrap; gap:6px 8px; align-items:center; font-size:13px; }
  .tag { border:1px solid var(--line); border-radius:3px; padding:1px 7px; color:var(--mute); }
  .save { margin-left:auto; font-weight:650; color:var(--signal); text-decoration:none; }
  .save:hover { text-decoration:underline; }
  .meter { text-align:right; min-width:92px; }
  .meter span:last-child { display:block; margin-top:6px; font-size:13px; font-weight:650; }
  .empty { color:var(--mute); padding:40px 0; }
  .own { margin-top:44px; display:flex; flex-wrap:wrap; gap:14px; align-items:center; justify-content:space-between; }
  .own p { margin:0; font-weight:650; font-size:18px; }
  footer { margin-top:40px; color:var(--mute); font-size:13px; }
  @media (max-width:640px) {
    nav.top { margin-bottom:36px; }
    .pick { grid-template-columns:104px 1fr; gap:14px; }
    .meter { grid-column:1 / -1; text-align:left; display:flex; gap:10px; align-items:flex-end; }
    .meter span:last-child { margin:0; }
    .takeaways, .foot { grid-column:1 / -1; }
    .save { margin-left:0; }
  }
</style>
</head>
<body>
<div class="wrap">
  <nav class="top">
    <a class="wordmark" href="${esc(ctaUrl || '#')}">${LOGO_SVG}Signal Shelf</a>
    ${ctaUrl ? `<a class="btn small" href="${esc(appUrl)}">Start a shelf</a>` : ''}
  </nav>
  <header>
    <h1 class="wide">${esc(data.title)}</h1>
    <p class="tagline">${esc(data.tagline)}</p>
    <p class="count">${data.count ? floor : ''}</p>
    ${filters}
  </header>
  <main class="list">
${rows || '<p class="empty">Nothing on this shelf yet.</p>'}
  </main>
  ${ctaUrl ? `<div class="own"><p>Keep track of what was worth your time.</p><a class="btn solid" href="${esc(ctaUrl)}">Make your own Signal Shelf</a></div>` : ''}
  <footer>${data.author ? `Curated by ${esc(data.author)}. ` : ''}Updated ${esc(updated)}. <a href="${esc(jsonHref)}">Shelf data (JSON)</a></footer>
</div>
<script>
  document.querySelectorAll('.chip').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.chip').forEach(function (b) { b.classList.toggle('on', b === btn); });
      var f = btn.getAttribute('data-f');
      document.querySelectorAll('.pick').forEach(function (c) {
        var models = JSON.parse(c.getAttribute('data-models') || '[]');
        c.classList.toggle('hide', !!f && models.indexOf(f) === -1);
      });
    });
  });
</script>
</body>
</html>
`;
}
