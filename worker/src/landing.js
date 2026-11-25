// Public landing page at "/".
import { esc, FONT_LINKS, BASE_CSS, RATING_LABELS, barsHtml, LOGO_SVG } from '../../shared/theme.js';

export function renderLanding({ origin, shelves = [], top = [] }) {
  const title = 'Signal Shelf: track what you watch';
  const desc = 'Track the YouTube videos and podcasts you watch, with transcripts. Connect Claude or export them, and share your shelf.';

  const topRows = top.map(t => `
      <li><a href="${esc(t.url)}" target="_blank" rel="noopener noreferrer">${esc(t.title)}</a>
        <span class="by">${esc(t.creator || '')}</span>
        <span class="score">${barsHtml(Math.round(t.avg))}<span>on ${t.shelves} shel${t.shelves === 1 ? 'f' : 'ves'}</span></span>
        <a class="add" href="/app/#add=${esc(encodeURIComponent(t.url))}">Add to my shelf</a></li>`).join('');
  const shelfRows = shelves.map(s => `
      <li><a href="/u/${esc(s.handle)}"><b>${esc(s.name || s.handle)}</b> <span class="by">@${esc(s.handle)}, ${s.items} saved</span></a></li>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${esc(origin)}/">
<meta property="og:image" content="${esc(origin)}/app/icon-512.png">
<meta name="twitter:card" content="summary">
<meta name="theme-color" content="#E6E8E2">
<link rel="icon" href="/app/icon-192.png">
<link rel="apple-touch-icon" href="/app/icon-180.png">
${FONT_LINKS}
<style>${BASE_CSS}
  .wrap { max-width:1080px; margin:0 auto; padding:0 24px; }
  nav.top { display:flex; justify-content:space-between; align-items:center; padding:calc(20px + env(safe-area-inset-top)) 0 20px; }
  nav.top div { display:flex; gap:8px; align-items:center; }
  .plain { font-weight:650; text-decoration:none; padding:7px 10px; font-size:14px; }
  .plain:hover { color:var(--signal); }

  .hero { display:grid; grid-template-columns:minmax(0, 1.25fr) minmax(0, 1fr); gap:56px; align-items:center; padding:64px 0 72px; }
  h1 { font-size:clamp(34px, 5.4vw, 62px); line-height:1.02; margin:0 0 22px; }
  .lede { font-size:19px; max-width:50ch; margin:0 0 30px; color:#2c3033; }
  .ctas { display:flex; gap:10px; flex-wrap:wrap; }
  .note { margin:14px 0 0; font-size:14px; color:var(--mute); }

  /* The meter you can try */
  .tuner { background:var(--panel); border:1.5px solid var(--ink); border-radius:6px; padding:28px 28px 24px; }
  .tuner p { margin:0; }
  .tuner .ask { font-weight:650; font-size:17px; }
  .tuner .sub { color:var(--mute); font-size:14px; margin-top:2px; }
  .tuner .bars { margin:30px 0 18px; }
  .readout { display:flex; justify-content:space-between; align-items:baseline; border-top:1px solid var(--line); padding-top:14px; min-height:44px; }
  .readout b { font-size:22px; }
  .readout span { color:var(--mute); font-size:14px; }

  .steps { display:grid; grid-template-columns:repeat(3, 1fr); border-top:3px solid var(--ink); }
  .steps div { padding:22px 26px 26px 0; }
  .steps div + div { padding-left:26px; border-left:1px solid var(--line); }
  .steps .n { font-size:15px; color:var(--signal); display:block; margin-bottom:10px; }
  .steps h2 { margin:0 0 6px; font-size:20px; }
  .steps p { margin:0; color:#2c3033; max-width:34ch; }

  section.block { padding:56px 0 0; }
  section.block > h2 { font-size:24px; margin:0 0 16px; }
  section.block > p { margin:0 0 18px; color:var(--mute); }
  ul.rows { list-style:none; margin:0; padding:0; border-top:1px solid var(--line); }
  ul.rows li { display:grid; grid-template-columns:minmax(0, 1fr) auto auto; gap:6px 22px; align-items:center; padding:14px 0; border-bottom:1px solid var(--line); }
  ul.rows li > a:first-child { font-weight:650; text-decoration:none; }
  ul.rows li > a:first-child:hover { color:var(--signal); }
  .by { color:var(--mute); font-weight:400; font-size:14px; }
  ul.top li .by { grid-column:1; grid-row:2; }
  .score { display:flex; gap:10px; align-items:flex-end; font-size:14px; color:var(--mute); grid-row:1 / span 2; grid-column:2; }
  .add { grid-row:1 / span 2; grid-column:3; font-size:14px; font-weight:650; color:var(--signal); text-decoration:none; }
  .add:hover { text-decoration:underline; }
  ul.shelves { display:grid; grid-template-columns:repeat(auto-fill, minmax(260px, 1fr)); column-gap:28px; border-top:0; }
  ul.shelves li { display:block; border-top:1px solid var(--line); border-bottom:0; }
  ul.shelves a { text-decoration:none; display:block; }

  .also { columns:2; column-gap:40px; padding:0; margin:0; list-style:none; max-width:820px; }
  .also li { break-inside:avoid; padding:9px 0; border-bottom:1px solid var(--line); }

  footer { color:var(--mute); font-size:14px; padding:64px 0 calc(32px + env(safe-area-inset-bottom)); display:flex; gap:16px; flex-wrap:wrap; justify-content:space-between; }

  @media (max-width:820px) {
    .hero { grid-template-columns:1fr; gap:36px; padding:36px 0 48px; }
    .steps { grid-template-columns:1fr; }
    .steps div, .steps div + div { padding:18px 0; border-left:0; }
    .steps div + div { border-top:1px solid var(--line); }
    ul.top li { grid-template-columns:1fr; }
    .score, .add { grid-column:1; grid-row:auto; }
    .also { columns:1; }
    .bars.xl { height:72px; gap:8px; } .bars.xl > * { width:22px; }
  }
</style>
</head>
<body>
<div class="wrap">
  <nav class="top">
    <a class="wordmark" href="/">${LOGO_SVG}Signal Shelf</a>
    <div><a class="plain" href="/people">People</a><a class="plain" href="/app/#login">Log in</a><a class="btn small solid" href="/app/">Start a shelf</a></div>
  </nav>

  <section class="hero">
    <div>
      <h1 class="wide">Track what you watch. Let Claude read it.</h1>
      <p class="lede">Save YouTube videos and podcasts with their transcripts. Rate them, share your shelf.</p>
      <div class="ctas">
        <a class="btn solid" href="/app/">Start a shelf</a>
        ${shelves[0] ? `<a class="btn" href="/people">Browse people</a>` : ''}
      </div>
      <p class="note">Free. No account needed.</p>
    </div>

    <div class="tuner" id="tuner">
      <p class="ask">The last video you watched.</p>
      <p class="sub">How good was it?</p>
      <span class="bars xl" role="group" aria-label="Rate from 1 to 5 bars">
        ${[1, 2, 3, 4, 5].map(n => `<button type="button" data-n="${n}" aria-label="${n} of 5, ${RATING_LABELS[n]}"></button>`).join('')}
      </span>
      <p class="readout"><b id="tuner-label">Tap a bar</b><span id="tuner-note"></span></p>
    </div>
  </section>

  <section class="steps">
    <div><span class="n wide">1</span><h2>Save</h2><p>Videos and podcasts, transcripts included.</p></div>
    <div><span class="n wide">2</span><h2>Rate</h2><p>One to five bars. Add notes.</p></div>
    <div><span class="n wide">3</span><h2>Use</h2><p>Connect Claude or export. Share your shelf.</p></div>
  </section>

  ${top.length ? `<section class="block">
    <h2 class="wide">Top rated right now</h2>
    <ul class="rows top">${topRows}</ul>
  </section>` : ''}

  ${shelves.length ? `<section class="block">
    <h2 class="wide">People</h2>
    <ul class="rows shelves">${shelfRows}</ul>
    <p style="margin-top:16px"><a class="plain" href="/people" style="padding:0;color:var(--signal)">Browse everyone</a></p>
  </section>` : ''}



  <footer>
    <span>Signal Shelf</span>
    <span><a href="/privacy">Privacy</a> · <a href="https://github.com/JakeG12345/signalshelf">Source on GitHub</a></span>
  </footer>
</div>
<script>
  (function () {
    var labels = ${JSON.stringify(RATING_LABELS)};
    var notes = ['', '', '', '', '', ''];
    var buttons = [].slice.call(document.querySelectorAll('#tuner button'));
    var set = 0;
    function paint(n) { buttons.forEach(function (b, i) { b.classList.toggle('on', i < n); }); }
    function read(n) {
      document.getElementById('tuner-label').textContent = n ? labels[n] : 'Tap a bar';
      document.getElementById('tuner-note').textContent = notes[n] || '';
    }
    buttons.forEach(function (b) {
      var n = Number(b.getAttribute('data-n'));
      b.addEventListener('mouseenter', function () { paint(n); read(n); });
      b.addEventListener('focus', function () { paint(n); read(n); });
      b.addEventListener('click', function () { set = n; paint(n); read(n); });
    });
    document.getElementById('tuner').addEventListener('mouseleave', function () { paint(set); read(set); });
  })();
</script>
</body>
</html>`;
}

export function renderNotFound(origin, message = 'This shelf doesn\'t exist or isn\'t public yet.') {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Signal Shelf</title>${FONT_LINKS}<style>${BASE_CSS}
  body { min-height:100vh; display:grid; place-items:center; padding:24px; text-align:center; }
  p { color:var(--mute); margin:14px 0 22px; }</style></head>
<body><div><a class="wordmark" href="${esc(origin)}/">${LOGO_SVG}Signal Shelf</a><p>${esc(message)}</p><a class="btn solid" href="${esc(origin)}/">Make your own shelf</a></div></body></html>`;
}

export function renderPrivacy(origin) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Privacy · Signal Shelf</title>${FONT_LINKS}<style>${BASE_CSS}
  body { padding:32px 24px 64px; }
  main { max-width:680px; margin:0 auto; }
  h1 { margin:36px 0 6px; } h2 { font-size:18px; margin:30px 0 6px; }
  p, li { color:var(--mute); line-height:1.55; } ul { padding-left:20px; }</style></head>
<body><main><a class="wordmark" href="${esc(origin)}/">${LOGO_SVG}Signal Shelf</a>
<h1>Privacy</h1><p>Last updated 25 November 2026.</p>
<h2>What we store</h2>
<ul>
<li>What you save: links, titles, creators, transcripts, your ratings, tags, takeaways and notes.</li>
<li>Your account: a username, an optional name and bio, and a scrambled password if you set one.</li>
<li>A scrambled form of your network address, used only to limit abuse.</li>
</ul>
<h2>What others can see</h2>
<p>If you have a username, your profile shows what you saved, your ratings, tags and takeaways. Notes and transcripts are never shown to anyone else. You can make your profile private in Account.</p>
<h2>Google sign-in</h2>
<p>If you continue with Google we receive your name, email address and Google account ID. We store the account ID and your name. We do not store your email address.</p>
<h2>YouTube</h2>
<p>If you import liked videos, Google asks you to let Signal Shelf view your YouTube account. We read your list of liked videos once so you can pick from it. We do not keep access to your account, and the list is deleted as soon as it is shown to you. Only the videos you pick are saved.</p>
<p>This feature uses YouTube API Services. By using it you agree to the <a href="https://www.youtube.com/t/terms">YouTube Terms of Service</a>, and the <a href="https://policies.google.com/privacy">Google Privacy Policy</a> applies. You can remove access any time in your <a href="https://myaccount.google.com/permissions">Google security settings</a>.</p>
<p>Signal Shelf's use of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements.</p>
<h2>Who else handles data</h2>
<ul>
<li>Cloudflare hosts the site and database.</li>
<li>Supadata fetches video transcripts. It receives the video link, nothing about you.</li>
<li>Apple's podcast directory answers show searches. It receives the search words, nothing about you.</li>
</ul>
<p>We do not sell data or show ads.</p>
<h2>Your data</h2>
<p>In Account you can download everything or delete your shelf. Deleting removes your account and all of its data.</p>
</main></body></html>`;
}
