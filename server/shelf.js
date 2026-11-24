import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { queryEntries, getSetting, setSetting } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SHELF_DIR = process.env.KT_SHELF_DIR || path.join(__dirname, '..', 'public-shelf');

export const DEFAULT_SHELF_SETTINGS = {
  title: 'My Signal Shelf',
  author: '',
  tagline: 'The highest-signal videos & podcasts I\'ve found on making money and building with AI.',
  minRating: 4,
  includeTakeaways: true,
  maxTakeaways: 5,
  includeYoutube: true,
  includePodcasts: true
};

export function getShelfSettings() {
  return { ...DEFAULT_SHELF_SETTINGS, ...(getSetting('shelf', {}) || {}) };
}

export function saveShelfSettings(patch = {}) {
  const s = { ...getShelfSettings() };
  if (typeof patch.title === 'string') s.title = patch.title.trim().slice(0, 120) || DEFAULT_SHELF_SETTINGS.title;
  if (typeof patch.author === 'string') s.author = patch.author.trim().slice(0, 80);
  if (typeof patch.tagline === 'string') s.tagline = patch.tagline.trim().slice(0, 280);
  if (patch.minRating !== undefined) s.minRating = Math.min(5, Math.max(1, Math.round(Number(patch.minRating)) || 4));
  if (patch.maxTakeaways !== undefined) s.maxTakeaways = Math.min(20, Math.max(0, Math.round(Number(patch.maxTakeaways)) || 0));
  for (const k of ['includeTakeaways', 'includeYoutube', 'includePodcasts']) if (k in patch) s[k] = !!patch[k];
  return setSetting('shelf', s);
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = u => (/^https:\/\/[^\s"'<>]+$/i.test(String(u || '')) ? String(u) : '');
const stars = n => '★'.repeat(n) + '☆'.repeat(5 - n);
const fmtDuration = s => {
  if (!s) return '';
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
};

/**
 * Public data only. Personal notes and transcripts are deliberately never included.
 */
export function buildShelfData(settings = getShelfSettings()) {
  const items = queryEntries({ minRating: settings.minRating, sort: 'rating', limit: 500 })
    .filter(e => (e.source === 'youtube' ? settings.includeYoutube : e.source === 'apple_podcasts' ? settings.includePodcasts : true))
    .map(e => ({
      id: e.id,
      type: e.source === 'youtube' ? 'video' : 'podcast',
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

export function renderShelfHtml(data) {
  const avg = data.items.length ? (data.items.reduce((a, b) => a + b.rating, 0) / data.items.length).toFixed(1) : '–';
  const cards = data.items.map(it => {
    const initials = esc((it.creator || it.title).split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase());
    const cover = it.thumbnail
      ? `<img src="${esc(it.thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
      : `<div class="ph">${initials}</div>`;
    const title = it.url ? `<a href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">${esc(it.title)}</a>` : esc(it.title);
    const tags = it.monetization_models.map(m => `<span class="tag">${esc(m)}</span>`).join('');
    const tk = it.key_takeaways.length
      ? `<details><summary>${it.key_takeaways.length} key takeaway${it.key_takeaways.length > 1 ? 's' : ''}</summary><ul>${it.key_takeaways.map(t => `<li>${esc(t)}</li>`).join('')}</ul></details>`
      : '';
    const meta = [esc(it.creator), it.type === 'video' ? 'Video' : 'Podcast', fmtDuration(it.duration_sec)].filter(Boolean).join(' · ');
    return `<article class="card" data-models="${esc(JSON.stringify(it.monetization_models.map(m => m.toLowerCase())))}">
  <div class="cover ${it.type}">${cover}<span class="kind">${it.type === 'video' ? '▶' : '🎙'}</span></div>
  <div class="body">
    <div class="stars" aria-label="${it.rating} out of 5">${stars(it.rating)}</div>
    <h2>${title}</h2>
    <div class="meta">${meta}</div>
    <div class="tags">${tags}</div>
    ${tk}
  </div>
</article>`;
  }).join('\n');
  const filters = data.models.length
    ? `<nav class="filters"><button class="chip on" data-f="">All <b>${data.count}</b></button>${data.models.map(m => `<button class="chip" data-f="${esc(m.name.toLowerCase())}">${esc(m.name)} <b>${m.count}</b></button>`).join('')}</nav>`
    : '';
  const byline = data.author ? `Curated by ${esc(data.author)} · ` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(data.title)}</title>
<meta name="description" content="${esc(data.tagline)}">
<meta property="og:title" content="${esc(data.title)}">
<meta property="og:description" content="${esc(data.tagline)}">
<style>
  :root { --bg:#14181c; --panel:#1c2228; --line:#2c3440; --text:#e6ebf0; --muted:#8b98a5; --accent:#00c030; --star:#40bcf4; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  .wrap { max-width:1120px; margin:0 auto; padding:48px 24px 64px; }
  header h1 { margin:0 0 6px; font-size:34px; letter-spacing:-.02em; }
  header p { margin:0; color:var(--muted); max-width:640px; }
  .stats { display:flex; gap:28px; margin:22px 0 26px; }
  .stats div { font-size:12px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); }
  .stats b { display:block; font-size:24px; color:var(--text); letter-spacing:0; }
  .filters { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:26px; }
  .chip { background:var(--panel); color:var(--text); border:1px solid var(--line); border-radius:999px; padding:6px 12px; font-size:13px; cursor:pointer; }
  .chip b { color:var(--muted); font-weight:600; margin-left:4px; }
  .chip.on { background:var(--accent); border-color:var(--accent); color:#04130a; }
  .chip.on b { color:#04130a; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(250px,1fr)); gap:20px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; overflow:hidden; display:flex; flex-direction:column; }
  .card.hide { display:none; }
  .cover { position:relative; aspect-ratio:16/9; background:#0d1013; }
  .cover.podcast { aspect-ratio:16/9; }
  .cover img { width:100%; height:100%; object-fit:cover; display:block; }
  .ph { width:100%; height:100%; display:grid; place-items:center; font-size:34px; font-weight:700; color:#fff; background:linear-gradient(135deg,#5b2a86,#1f6f8b); }
  .kind { position:absolute; left:8px; bottom:8px; background:rgba(0,0,0,.7); border-radius:4px; padding:1px 7px; font-size:12px; }
  .body { padding:14px 16px 16px; display:flex; flex-direction:column; gap:6px; }
  .stars { color:var(--star); letter-spacing:2px; font-size:15px; }
  h2 { margin:0; font-size:16px; line-height:1.35; }
  h2 a { color:var(--text); text-decoration:none; }
  h2 a:hover { color:var(--star); }
  .meta { color:var(--muted); font-size:13px; }
  .tags { display:flex; flex-wrap:wrap; gap:6px; }
  .tag { font-size:11px; background:#26303a; color:#b9c6d3; border-radius:4px; padding:2px 7px; }
  details { margin-top:4px; font-size:14px; }
  summary { cursor:pointer; color:var(--accent); font-size:13px; }
  details ul { margin:8px 0 0; padding-left:18px; color:#cdd6df; }
  details li { margin-bottom:4px; }
  footer { margin-top:48px; color:var(--muted); font-size:12px; text-align:center; }
  .empty { color:var(--muted); padding:40px 0; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>${esc(data.title)}</h1>
    <p>${esc(data.tagline)}</p>
  </header>
  <section class="stats">
    <div><b>${data.count}</b>Picks</div>
    <div><b>${avg}</b>Avg signal</div>
    <div><b>${data.models.length}</b>Models</div>
  </section>
  ${filters}
  <main class="grid">
${cards || '<p class="empty">Nothing on the shelf yet.</p>'}
  </main>
  <footer>${byline}${data.min_rating}★+ only · Updated ${esc(new Date(data.generated_at).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }))} · <a href="shelf.json" style="color:inherit">JSON</a></footer>
</div>
<script>
  document.querySelectorAll('.chip').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.chip').forEach(function (b) { b.classList.toggle('on', b === btn); });
      var f = btn.getAttribute('data-f');
      document.querySelectorAll('.card').forEach(function (c) {
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

export function publishShelf(overrides = {}) {
  const settings = Object.keys(overrides).length ? saveShelfSettings(overrides) : getShelfSettings();
  const data = buildShelfData(settings);
  fs.mkdirSync(SHELF_DIR, { recursive: true });
  fs.writeFileSync(path.join(SHELF_DIR, 'index.html'), renderShelfHtml(data));
  fs.writeFileSync(path.join(SHELF_DIR, 'shelf.json'), JSON.stringify(data, null, 2));
  return { ok: true, count: data.count, dir: SHELF_DIR, files: ['index.html', 'shelf.json'], settings };
}

// CLI: npm run shelf -- --min 4
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--min');
  const res = publishShelf(i >= 0 ? { minRating: Number(args[i + 1]) } : {});
  console.log(`Published ${res.count} item(s) to ${res.dir}/index.html (min ${res.settings.minRating}★)`);
}
