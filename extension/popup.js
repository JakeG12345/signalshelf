const $ = s => document.querySelector(s);
const send = msg => chrome.runtime.sendMessage(msg).catch(e => ({ ok: false, error: e.message }));
const LABELS = ['', 'Noise', 'Thin', 'Useful', 'High signal', 'Must watch'];
let tab = null;
let entryId = null;

function setMsg(text, kind = '') { const m = $('#msg'); m.textContent = text; m.className = kind; }

function renderStars(rating) {
  const el = $('#stars');
  el.hidden = false;
  el.innerHTML = '';
  for (let n = 1; n <= 5; n++) {
    const b = document.createElement('button');
    b.title = LABELS[n];
    b.setAttribute('aria-label', `${n} of 5, ${LABELS[n]}`);
    if (rating >= n) b.className = 'on';
    b.addEventListener('click', () => rate(rating === n ? null : n));
    el.appendChild(b);
  }
  const lbl = document.createElement('span');
  lbl.className = 'lbl';
  lbl.textContent = rating ? LABELS[rating] : 'How much signal?';
  el.appendChild(lbl);
}

async function rate(n) {
  const r = await send({ type: 'KT_RATE', id: entryId, patch: { signal_rating: n } });
  if (r.ok) { renderStars(r.data.entry.signal_rating || 0); setMsg(n ? `${LABELS[n]}, ${n} of 5` : 'Rating cleared', 'ok'); }
  else setMsg(r.error, 'err');
}

let appUrl = 'http://127.0.0.1:3456/';

function showEntry(entry) {
  entryId = entry.id;
  renderStars(entry.signal_rating || 0);
  $('#save').textContent = 'Re-save (refresh transcript)';
  const link = $('#open-entry');
  link.hidden = false;
  link.href = `${appUrl}#open=${encodeURIComponent(entry.id)}`;
  link.target = '_blank';
}

async function init() {
  const s = await chrome.storage.sync.get({ autoCapture: true, thresholdMin: 2, apiBase: 'http://127.0.0.1:3456', apiToken: '' });
  $('#auto').checked = !!s.autoCapture;
  $('#threshold').value = String(s.thresholdMin);
  $('#api-base').value = s.apiBase;
  $('#api-token').value = s.apiToken;

  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const m = (tab?.url || '').match(/^https:\/\/www\.youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/)([\w-]{11})/);
  const videoId = m?.[1] || null;
  if (videoId) {
    $('#video-card').hidden = false;
    $('#v-title').textContent = (tab.title || '').replace(/^\(\d+\)\s*/, '').replace(/ - YouTube$/, '');
    $('#v-meta').textContent = 'Not saved yet';
  } else {
    $('#no-video').hidden = false;
  }

  const h = await send({ type: 'KT_HEALTH' });
  const ready = h.ok && (h.data.mode !== 'cloud' || h.data.authed);
  $('#dot').className = 'dot ' + (ready ? 'on' : 'off');
  if (h.ok) {
    appUrl = h.data.base + (h.data.dashboard || '/');
    $('#dash').href = appUrl;
  }
  $('#srv').textContent = !h.ok ? 'offline' : !ready ? 'key needed' : `${h.data.mode || 'local'} · ${h.data.entries} items`;
  if (!ready) {
    setMsg(h.ok ? 'Paste your key from the app\'s Account panel into Server settings.' : h.error, 'err');
    $('#save').disabled = true;
    $('#srv-settings').open = true;
    return;
  }

  if (videoId) {
    const r = await send({ type: 'KT_GET', id: `yt_${videoId}` });
    if (r.ok && r.data) {
      const e = r.data;
      $('#v-meta').textContent = `Saved · ${(e.transcript || '').length ? `${e.transcript.length.toLocaleString()} chars transcript` : 'no transcript'}`;
      showEntry(e);
    }
    try {
      const st = await chrome.tabs.sendMessage(tab.id, { type: 'KT_STATE' });
      if (st && st.videoId === videoId && st.watchedSec) $('#v-meta').textContent += ` · watched ${Math.floor(st.watchedSec / 60)}m ${st.watchedSec % 60}s`;
    } catch { /* content script not loaded yet */ }
  }
}

$('#save').addEventListener('click', async () => {
  const btn = $('#save');
  btn.disabled = true;
  setMsg('Reading video + transcript…');
  const r = await send({ type: 'KT_CAPTURE', tabId: tab.id });
  btn.disabled = false;
  if (!r.ok) return setMsg(r.error, 'err');
  const e = r.data.entry;
  const chars = e.transcript_chars || 0;
  $('#v-meta').textContent = `Saved · ${chars ? `${chars.toLocaleString()} chars transcript` : 'no transcript'}`;
  setMsg(chars ? `Saved via ${r.data.method}. Rate it below.` : 'Saved, but no transcript was found (video may have no captions).', chars ? 'ok' : 'err');
  showEntry(e);
});

$('#linkform').addEventListener('submit', async ev => {
  ev.preventDefault();
  const url = $('#link').value.trim();
  if (!url) return;
  $('#linkbtn').disabled = true;
  setMsg('Fetching video…');
  const r = await send({ type: 'KT_INGEST_URL', url, status: 'watched' });
  $('#linkbtn').disabled = false;
  if (!r.ok) return setMsg(r.error, 'err');
  $('#link').value = '';
  const e = r.data.entry;
  setMsg(`Added "${e.title}"${e.transcript_chars ? '' : ' (no transcript: open the video and press Save to grab it)'}`, e.transcript_chars ? 'ok' : '');
});

$('#auto').addEventListener('change', e => {
  chrome.storage.sync.set({ autoCapture: e.target.checked });
  setMsg(e.target.checked ? `Auto-capture on: videos save after ${$('#threshold').value} min of playback.` : 'Auto-capture off.', 'ok');
});
$('#threshold').addEventListener('change', e => chrome.storage.sync.set({ thresholdMin: Number(e.target.value) }));

$('#api-save').addEventListener('click', async () => {
  let base = $('#api-base').value.trim().replace(/\/+$/, '').replace(/\/app$/, '');
  if (base && !/^https?:\/\//.test(base)) base = 'https://' + base;
  const rawKey = $('#api-token').value.trim();
  const key = (rawKey.match(/ss_[A-Za-z0-9]{24,64}/) || [rawKey])[0]; // accepts a pasted private link too
  await chrome.storage.sync.set({ apiBase: base || 'http://127.0.0.1:3456', apiToken: key });
  location.reload();
});

$('#pick').addEventListener('click', () => { send({ type: 'KT_OPEN_PICKER' }); window.close(); });

init();
