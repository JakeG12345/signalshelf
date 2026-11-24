// Public profile (/u/<handle>) and People (/people) pages.
import { esc, FONT_LINKS, BASE_CSS, RATING_LABELS, barsHtml, LOGO_SVG } from './theme.js';

const safeUrl = u => (/^https:\/\/[^\s"'<>]+$/i.test(String(u || '')) ? String(u) : '');
const KIND = { youtube: 'Video', apple_podcasts: 'Podcast' };
const fmtDate = d => {
  const t = Date.parse(String(d || '').replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(d || '') ? '' : 'Z'));
  return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
};

/** Only public fields leave the server: never notes or transcripts. */
export function publicItem(e) {
  return {
    id: e.id, type: e.source === 'youtube' ? 'video' : e.source === 'apple_podcasts' ? 'podcast' : 'link',
    title: e.title, creator: e.creator || '', url: safeUrl(e.url), thumbnail: safeUrl(e.thumbnail),
    rating: e.signal_rating || null, tags: e.monetization_models || [], key_takeaways: e.key_takeaways || [],
    watched_at: e.watched_at || null
  };
}

const SHARED_CSS = `
  .wrap { max-width:920px; margin:0 auto; padding:calc(20px + env(safe-area-inset-top)) 22px calc(48px + env(safe-area-inset-bottom)); }
  nav.top { display:flex; justify-content:space-between; align-items:center; gap:10px; margin-bottom:44px; }
  nav.top div { display:flex; gap:6px; align-items:center; }
  .plain { font-weight:650; text-decoration:none; padding:7px 10px; font-size:14px; }
  .plain:hover { color:var(--signal); }
  .mute { color:var(--mute); }
  footer { margin-top:40px; color:var(--mute); font-size:13px; }
`;

function topNav() {
  return `<nav class="top">
    <a class="wordmark" href="/">${LOGO_SVG}Signal Shelf</a>
    <div><a class="plain" href="/people">People</a><a class="btn small" href="/app/">My shelf</a></div>
  </nav>`;
}

export function renderProfileHtml({ user, counts, items, sort = 'recent', origin = '' }) {
  const name = user.display_name || `@${user.handle}`;
  const title = `${name} on Signal Shelf`;
  const desc = user.bio || `What ${name} has been watching and listening to, rated.`;
  const rows = items.map(it => {
    const initials = esc((it.creator || it.title).split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase());
    const cover = it.thumbnail ? `<img src="${esc(it.thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span class="ph wide">${initials}</span>`;
    const t = it.url ? `<a href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">${esc(it.title)}</a>` : esc(it.title);
    const meta = [esc(it.creator), KIND[it.type === 'video' ? 'youtube' : it.type === 'podcast' ? 'apple_podcasts' : ''] || 'Link', fmtDate(it.watched_at)].filter(Boolean).join(', ');
    const tk = it.key_takeaways.length ? `<ul class="takeaways">${it.key_takeaways.slice(0, 5).map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '';
    const tags = it.tags.map(m => `<span class="tag">${esc(m)}</span>`).join('');
    const save = it.url ? `<a class="save" href="/app/#add=${esc(encodeURIComponent(it.url))}">Add to my shelf</a>` : '';
    return `<article class="pick">
  <div class="cover">${cover}</div>
  <div class="what"><h2>${t}</h2><p class="meta">${meta}</p>${tk}<p class="foot">${tags}${save}</p></div>
  <div class="meter">${it.rating ? `${barsHtml(it.rating, 'lg')}<span>${RATING_LABELS[it.rating]}</span>` : '<span class="mute">Not rated</span>'}</div>
</article>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:type" content="profile">
<meta property="og:url" content="${esc(origin)}/u/${esc(user.handle)}">
<link rel="canonical" href="${esc(origin)}/u/${esc(user.handle)}">
<meta name="twitter:card" content="summary">
<meta name="theme-color" content="#E6E8E2">
<link rel="icon" href="/app/icon-192.png">
${FONT_LINKS}
<style>${BASE_CSS}${SHARED_CSS}
  .head { display:flex; justify-content:space-between; align-items:flex-start; gap:18px; flex-wrap:wrap; }
  h1 { font-size:clamp(30px, 6vw, 48px); line-height:1.04; margin:0; }
  .handle { margin:6px 0 0; color:var(--mute); }
  .bio { margin:12px 0 0; max-width:56ch; font-size:17px; }
  .counts { display:flex; gap:22px; margin:18px 0 0; font-size:15px; }
  .counts b { font-weight:700; }
  #follow { min-width:110px; }
  #follow.on { background:var(--ink); color:var(--plate); }
  .tabs { display:flex; gap:18px; margin:30px 0 0; border-bottom:3px solid var(--ink); }
  .tabs a { text-decoration:none; font-weight:650; padding:8px 0; margin-bottom:-3px; border-bottom:3px solid transparent; color:var(--mute); }
  .tabs a.on { color:var(--ink); border-color:var(--signal); }
  .pick { display:grid; grid-template-columns:150px 1fr auto; gap:20px; padding:20px 0; border-bottom:1px solid var(--line); align-items:start; }
  .cover { aspect-ratio:16/9; background:var(--well); border-radius:3px; overflow:hidden; display:grid; place-items:center; }
  .cover img { width:100%; height:100%; object-fit:cover; display:block; }
  .ph { font-size:22px; color:var(--mute); }
  .pick h2 { margin:0; font-size:18px; line-height:1.3; font-weight:700; }
  .pick h2 a { text-decoration:none; } .pick h2 a:hover { color:var(--signal); text-decoration:underline; }
  .meta { margin:4px 0 0; color:var(--mute); font-size:14px; }
  .takeaways { margin:10px 0 0; padding:0 0 0 18px; max-width:60ch; }
  .takeaways li { margin-bottom:3px; } .takeaways li::marker { color:var(--signal); }
  .foot { margin:10px 0 0; display:flex; flex-wrap:wrap; gap:6px 8px; align-items:center; font-size:13px; }
  .tag { border:1px solid var(--line); border-radius:3px; padding:1px 7px; color:var(--mute); }
  .save { margin-left:auto; font-weight:650; color:var(--signal); text-decoration:none; }
  .meter { text-align:right; min-width:92px; }
  .meter span:last-child { display:block; margin-top:6px; font-size:13px; font-weight:650; }
  .empty { color:var(--mute); padding:36px 0; }
  @media (max-width:640px) {
    .pick { grid-template-columns:100px 1fr; gap:14px; }
    .meter { grid-column:1 / -1; text-align:left; display:flex; gap:10px; align-items:flex-end; }
    .meter span:last-child { margin:0; }
    .takeaways, .foot { grid-column:1 / -1; } .save { margin-left:0; }
  }
</style>
</head>
<body>
<div class="wrap">
  ${topNav()}
  <div class="head">
    <div>
      <h1 class="wide">${esc(name)}</h1>
      <p class="handle">@${esc(user.handle)}</p>
      ${user.bio ? `<p class="bio">${esc(user.bio)}</p>` : ''}
      <p class="counts"><span><b id="c-items">${counts.items}</b> saved</span><span><b id="c-followers">${counts.followers}</b> follower${counts.followers === 1 ? '' : 's'}</span><span><b>${counts.following}</b> following</span></p>
    </div>
    <a class="btn" id="follow" href="/app/#follow=${esc(user.handle)}">Follow</a>
  </div>
  <nav class="tabs"><a href="?" class="${sort === 'recent' ? 'on' : ''}">Recent</a><a href="?sort=top" class="${sort === 'top' ? 'on' : ''}">Top rated</a></nav>
  <main>
${rows || `<p class="empty">${esc(name)} hasn't saved anything yet.</p>`}
  </main>
  <footer><a href="/u/${esc(user.handle)}/shelf.json">Profile data (JSON)</a></footer>
</div>
<script>
  (function () {
    var token; try { token = localStorage.getItem('ss_token'); } catch (e) {}
    if (!token) return; // the link signs them up first, then follows
    var btn = document.getElementById('follow'), handle = ${JSON.stringify(user.handle)}, on = false;
    var H = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
    function paint() { btn.textContent = on ? 'Following' : 'Follow'; btn.classList.toggle('on', on); }
    fetch('/api/follow/' + handle, { headers: H }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (!d) return;
      if (d.self) { btn.textContent = 'Edit profile'; btn.href = '/app/#account'; return; }
      on = d.following; paint();
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        on = !on; paint();
        var c = document.getElementById('c-followers'); c.textContent = Number(c.textContent) + (on ? 1 : -1);
        fetch('/api/follow/' + handle, { method: on ? 'POST' : 'DELETE', headers: H }).then(function (r) {
          if (!r.ok) { on = !on; paint(); c.textContent = Number(c.textContent) + (on ? 1 : -1); }
        });
      });
    });
  })();
</script>
</body>
</html>`;
}

export function renderPeopleHtml({ people, q = '', origin = '' }) {
  const rows = people.map(p => `<li><a href="/u/${esc(p.handle)}">
      <span class="avatar wide">${esc((p.name || p.handle).slice(0, 1).toUpperCase())}</span>
      <span class="who"><b>${esc(p.name)}</b> <span class="mute">@${esc(p.handle)}</span>${p.bio ? `<span class="bio">${esc(p.bio)}</span>` : ''}</span>
      <span class="mute n">${p.items} saved<br>${p.followers} follower${p.followers === 1 ? '' : 's'}</span></a></li>`).join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>People on Signal Shelf</title>
<meta name="theme-color" content="#E6E8E2">
<link rel="icon" href="/app/icon-192.png">
${FONT_LINKS}
<style>${BASE_CSS}${SHARED_CSS}
  h1 { font-size:clamp(28px, 5vw, 40px); margin:0 0 18px; }
  form { display:flex; gap:8px; margin-bottom:22px; }
  form input { flex:1; min-width:0; font:inherit; font-size:16px; padding:10px 12px; border:1.5px solid var(--ink); border-radius:4px; background:var(--panel); }
  ul { list-style:none; margin:0; padding:0; border-top:3px solid var(--ink); }
  li a { display:grid; grid-template-columns:44px 1fr auto; gap:14px; align-items:center; padding:14px 0; border-bottom:1px solid var(--line); text-decoration:none; }
  li a:hover b { color:var(--signal); }
  .avatar { width:44px; height:44px; border-radius:50%; background:var(--ink); color:var(--plate); display:grid; place-items:center; font-size:18px; }
  .bio { display:block; color:var(--ink); font-size:14px; margin-top:2px; }
  .n { font-size:13px; text-align:right; }
  .empty { color:var(--mute); }
</style>
</head>
<body>
<div class="wrap">
  ${topNav()}
  <h1 class="wide">People</h1>
  <form action="/people"><input type="search" name="q" value="${esc(q)}" placeholder="Find someone by name or username" aria-label="Search people"><button class="btn solid" type="submit">Search</button></form>
  ${rows ? `<ul>${rows}</ul>` : `<p class="empty">${q ? 'No one matches that.' : 'No one here yet. Be the first.'}</p>`}
</div>
</body>
</html>`;
}
