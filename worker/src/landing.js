// Public landing page at "/".
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function renderLanding({ origin, shelves = [] }) {
  const shelfCards = shelves.map(s => `
      <a class="shelf" href="/u/${esc(s.handle)}">
        <span class="avatar">${esc((s.name || s.handle).slice(0, 1).toUpperCase())}</span>
        <span><b>${esc(s.name || s.handle)}</b><small>@${esc(s.handle)} · ${s.items} pick${s.items === 1 ? '' : 's'}</small></span>
      </a>`).join('');
  const title = 'Signal Shelf: Letterboxd for money-making & AI videos';
  const desc = 'Rate the signal of every money-making and AI video or podcast you watch. Keep the takeaways, share your shelf, and ask Claude what you learned. Free, no sign-up.';
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
<meta name="theme-color" content="#0f1216">
<link rel="icon" href="/app/icon-192.png">
<link rel="apple-touch-icon" href="/app/icon-180.png">
<style>
  :root { --bg:#0f1216; --panel:#171c22; --line:#2a333d; --text:#e6ebf0; --muted:#8b98a5; --accent:#00c030; --blue:#40bcf4; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  a { color:inherit; }
  .wrap { max-width:1040px; margin:0 auto; padding:0 22px; }
  nav { display:flex; justify-content:space-between; align-items:center; padding:calc(18px + env(safe-area-inset-top)) 0 18px; }
  .logo { display:flex; align-items:center; gap:10px; font-weight:800; font-size:18px; text-decoration:none; }
  .logo img { width:30px; height:30px; border-radius:7px; }
  .logo span { color:var(--accent); }
  .btn { display:inline-block; text-decoration:none; font-weight:700; border-radius:10px; padding:12px 20px; border:1px solid var(--line); background:var(--panel); }
  .btn.primary { background:var(--accent); border-color:var(--accent); color:#04130a; }
  .btn.small { padding:8px 14px; font-size:14px; }
  .hero { padding:56px 0 40px; max-width:760px; }
  .hero h1 { font-size:clamp(34px, 6vw, 56px); line-height:1.05; letter-spacing:-.03em; margin:0 0 18px; }
  .hero h1 em { font-style:normal; color:var(--accent); }
  .hero p { font-size:clamp(17px, 2.2vw, 20px); color:#b9c6d3; margin:0 0 28px; }
  .ctas { display:flex; gap:12px; flex-wrap:wrap; align-items:center; }
  .note { color:var(--muted); font-size:14px; margin-top:12px; }
  .stars { color:var(--blue); letter-spacing:3px; font-size:22px; margin-bottom:14px; }
  .steps { display:grid; grid-template-columns:repeat(auto-fit, minmax(230px, 1fr)); gap:16px; padding:32px 0 20px; }
  .step { background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:20px; }
  .step b { display:block; font-size:17px; margin-bottom:6px; }
  .step .n { display:inline-grid; place-items:center; width:28px; height:28px; border-radius:50%; background:#1f2a33; color:var(--accent); font-weight:800; font-size:14px; margin-bottom:12px; }
  .step p { margin:0; color:#aeb9c4; font-size:15px; }
  h2 { font-size:24px; letter-spacing:-.01em; margin:44px 0 14px; }
  .shelves { display:grid; grid-template-columns:repeat(auto-fill, minmax(220px, 1fr)); gap:12px; }
  .shelf { display:flex; gap:12px; align-items:center; background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:12px 14px; text-decoration:none; }
  .shelf:hover { border-color:var(--blue); }
  .shelf small { display:block; color:var(--muted); font-size:13px; }
  .avatar { width:38px; height:38px; border-radius:50%; display:grid; place-items:center; font-weight:800; background:linear-gradient(135deg,#4b2a7a,#1f5f7b); flex:none; }
  .empty { color:var(--muted); }
  .features { display:grid; grid-template-columns:repeat(auto-fit, minmax(260px, 1fr)); gap:10px 28px; color:#b9c6d3; padding:0; list-style:none; }
  .features li::before { content:'★ '; color:var(--blue); }
  footer { color:var(--muted); font-size:14px; padding:48px 0 calc(32px + env(safe-area-inset-bottom)); display:flex; gap:16px; flex-wrap:wrap; justify-content:space-between; }
</style>
</head>
<body>
<div class="wrap">
  <nav>
    <a class="logo" href="/"><img src="/app/icon-192.png" alt="">Signal <span>Shelf</span></a>
    <span class="ctas"><a class="btn small" href="/app/#login" style="border:none;background:none">Log in</a><a class="btn small" href="/app/">Open app</a></span>
  </nav>

  <section class="hero">
    <div class="stars">★★★★★</div>
    <h1>Letterboxd for <em>money-making &amp; AI</em> videos.</h1>
    <p>Most of it is noise. Rate the signal of every video and podcast you watch, keep the takeaways, share your best picks, and ask Claude what you've actually learned.</p>
    <div class="ctas">
      <a class="btn primary" href="/app/">Start your shelf, free</a>
      ${shelves[0] ? `<a class="btn" href="/u/${esc(shelves[0].handle)}">See an example</a>` : ''}
    </div>
    <div class="note">Try it instantly, no sign-up needed. Create a free account when you want to keep it. Works on iPhone, desktop and inside Claude.</div>
  </section>

  <section class="steps">
    <div class="step"><span class="n">1</span><b>Save</b><p>Share any YouTube video, podcast episode or link to Signal Shelf from your iPhone, or one-click save from Chrome.</p></div>
    <div class="step"><span class="n">2</span><b>Rate the signal</b><p>1 to 5 stars for how useful it actually was. Tag the model (AI Agency, Micro-SaaS, Faceless YT…) and jot the takeaways.</p></div>
    <div class="step"><span class="n">3</span><b>Share &amp; ask</b><p>Publish a public shelf of your 4★+ picks, and connect Claude to search every transcript you've saved.</p></div>
  </section>

  <h2>What you get</h2>
  <ul class="features">
    <li>Transcripts saved automatically when available</li>
    <li>Full-text search across everything you've watched</li>
    <li>Public shelf at your own @username</li>
    <li>Claude connector: "what did I learn about pricing?"</li>
    <li>Chrome extension with optional auto-save</li>
    <li>Your notes stay private. Export anytime.</li>
  </ul>

  <h2>Fresh shelves</h2>
  ${shelfCards ? `<div class="shelves">${shelfCards}</div>` : '<p class="empty">Be the first to publish a shelf.</p>'}

  <footer>
    <span>Signal Shelf · built in public, day 1</span>
    <span><a href="https://github.com/JakeG12345/signalshelf">Open source on GitHub</a></span>
  </footer>
</div>
</body>
</html>`;
}

export function renderNotFound(origin, message = 'This shelf doesn\'t exist or isn\'t public yet.') {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Signal Shelf</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1216;color:#e6ebf0;font:16px/1.5 -apple-system,BlinkMacSystemFont,Roboto,sans-serif;text-align:center;padding:24px}
h1{margin:0 0 8px;font-size:28px}h1 span{color:#00c030}p{color:#8b98a5}a{color:#40bcf4}</style></head>
<body><div><h1>Signal <span>Shelf</span></h1><p>${esc(message)}</p><a href="${esc(origin)}/">Make your own shelf →</a></div></body></html>`;
}
