// Signal Shelf visual identity, shared by the landing page and public shelves.
// (The app in server/public/index.html carries the same tokens inline because it is a static file.)
//
// Idea: a hi-fi receiver faceplate. Brushed-aluminium greys, ink lettering in an extended grotesque,
// and one lit colour reserved for the signal meter. Ratings are five signal bars, never stars.

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const FONT_LINKS = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..900&display=swap" rel="stylesheet">`;

export const RATING_LABELS = ['Not rated', 'Noise', 'Thin', 'Useful', 'High signal', 'Must watch'];

export const BASE_CSS = `
  :root {
    --plate:#E6E8E2; --panel:#F4F5F0; --well:#D8DBD3; --ink:#15171A; --mute:#5F645F; --line:#C3C7BE;
    --signal:#2740FF; --warn:#8A5200; --red:#B3261E;
    --font:"Archivo", "Helvetica Neue", Helvetica, Arial, sans-serif;
    color-scheme: light;
  }
  * { box-sizing:border-box; }
  html { -webkit-text-size-adjust:100%; }
  body { margin:0; background:var(--plate); color:var(--ink); font:16px/1.5 var(--font); font-variant-numeric:tabular-nums; }
  a { color:inherit; }
  :focus-visible { outline:2px solid var(--signal); outline-offset:2px; }
  .wide { font-stretch:125%; font-weight:800; letter-spacing:-.02em; }
  .wordmark { font-stretch:125%; font-weight:800; font-size:17px; letter-spacing:-.01em; text-decoration:none; display:inline-flex; align-items:center; gap:10px; }
  .btn { display:inline-block; font:inherit; font-weight:650; text-decoration:none; cursor:pointer; padding:11px 18px; border-radius:4px; border:1.5px solid var(--ink); background:transparent; color:var(--ink); }
  .btn.solid { background:var(--ink); color:var(--plate); }
  .btn.solid:hover { background:var(--signal); border-color:var(--signal); }
  .btn:hover { border-color:var(--signal); color:var(--signal); }
  .btn.solid:hover { color:#fff; }
  .btn.small { padding:7px 13px; font-size:14px; }

  /* The signal meter: five ascending bars */
  .bars { display:inline-flex; align-items:flex-end; gap:3px; height:18px; vertical-align:middle; }
  .bars i, .bars button { display:block; width:5px; background:var(--line); border-radius:1px; border:0; padding:0; }
  .bars > :nth-child(1) { height:28%; } .bars > :nth-child(2) { height:46%; } .bars > :nth-child(3) { height:64%; }
  .bars > :nth-child(4) { height:82%; } .bars > :nth-child(5) { height:100%; }
  .bars .on { background:var(--signal); }
  .bars.lg { height:30px; gap:4px; } .bars.lg > * { width:8px; }
  .bars.xl { height:84px; gap:10px; } .bars.xl > * { width:26px; border-radius:2px; }
  .bars button { cursor:pointer; }
`;

/** Static meter markup for a 0-5 rating. */
export function barsHtml(n, cls = '') {
  const v = Math.max(0, Math.min(5, Number(n) || 0));
  return `<span class="bars ${cls}" role="img" aria-label="${v ? `Signal ${v} of 5, ${RATING_LABELS[v]}` : 'Not rated'}">${
    [1, 2, 3, 4, 5].map(i => `<i${i <= v ? ' class="on"' : ''}></i>`).join('')}</span>`;
}

export const LOGO_SVG = `<svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true"><rect width="26" height="26" rx="5" fill="#15171A"/><rect x="5" y="13" width="3" height="5" fill="#E6E8E2"/><rect x="9.5" y="10.5" width="3" height="7.5" fill="#E6E8E2"/><rect x="14" y="8" width="3" height="10" fill="#5B70FF"/><rect x="18.5" y="5.5" width="3" height="12.5" fill="#5B70FF"/><rect x="4" y="19.5" width="18" height="1.5" fill="#E6E8E2"/></svg>`;
