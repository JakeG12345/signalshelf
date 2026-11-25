import { podcastLink } from './podcast.js';

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

let appUrl = 'https://signalshelf.jake-1c4.workers.dev/app/';

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
  const s = await chrome.storage.sync.get({ autoCapture: false, thresholdMin: 2, apiBase: 'https://signalshelf.jake-1c4.workers.dev', apiToken: '' });
  $('#auto').checked = !!s.autoCapture;
  $('#threshold').value = String(s.thresholdMin);
  $('#api-base').value = s.apiBase;
  $('#api-token').value = s.apiToken;

  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const m = (tab?.url || '').match(/^https:\/\/www\.youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/)([\w-]{11})/);
  const videoId = m?.[1] || null;
  const pod = !videoId && podcastLink(tab?.url || '');
  if (videoId) {
    $('#video-card').hidden = false;
    $('#v-title').textContent = (tab.title || '').replace(/^\(\d+\)\s*/, '').replace(/ - YouTube$/, '');
    $('#v-meta').textContent = 'Not saved yet';
  } else if (pod) {
    $('#video-card').hidden = false;
    $('#v-title').textContent = (tab.title || 'Podcast episode').replace(/\s*[|\u2013-]\s*(Podcast on Spotify|Apple Podcasts)\s*$/i, '').replace(/^Listen to /, '');
    $('#v-meta').textContent = pod.kind === 'spotify' ? 'Spotify episode · not saved yet' : 'Podcast episode · not saved yet';
    $('#save').textContent = 'Save episode + transcript';
    $('#save').dataset.podcast = '1';
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
    $('#connect').hidden = false;
    $('#save').disabled = true;
    if (!h.ok) setMsg(h.error, 'err');
    return;
  }

  if (pod?.kind === 'apple') {
    const r = await send({ type: 'KT_GET', id: `pod_apple_${pod.episode}` });
    if (r.ok && r.data) { $('#v-meta').textContent = `Saved · ${podStatus(r.data)}`; showEntry(r.data); $('#save').textContent = 'Save again'; }
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

const podStatus = e => e.transcript_status === 'ok' ? 'transcript ready' : e.transcript_status === 'pending' ? 'transcribing, ready in a minute or two' : 'no transcript';

$('#save').addEventListener('click', async () => {
  const btn = $('#save');
  btn.disabled = true;
  if (btn.dataset.podcast) {
    setMsg('Finding the episode…');
    const r = await send({ type: 'KT_SAVE_PODCAST', url: tab.url, tabId: tab.id });
    btn.disabled = false;
    if (!r.ok) return setMsg(r.error, 'err');
    const e = r.data.entry;
    $('#v-title').textContent = e.title;
    $('#v-meta').textContent = r.data.matched ? `Saved · ${podStatus(e)}` : 'Saved as a link · not found in the podcast directory, so no transcript';
    setMsg(r.data.matched ? 'Saved. Rate it below.' : 'Saved as a link.', r.data.matched ? 'ok' : '');
    showEntry(e); btn.textContent = 'Save again';
    return;
  }
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
  setMsg('Saving…');
  const r = await send({ type: 'KT_INGEST_URL', url, status: 'watched' });
  $('#linkbtn').disabled = false;
  if (!r.ok) return setMsg(r.error, 'err');
  $('#link').value = '';
  const e = r.data.entry;
  if (r.data.matched !== undefined) return setMsg(`Added "${e.title}" · ${r.data.matched ? podStatus(e) : 'saved as a link'}`, 'ok');
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
  await chrome.storage.sync.set({ apiBase: base || 'https://signalshelf.jake-1c4.workers.dev', apiToken: key });
  location.reload();
});

$('#connect-btn').addEventListener('click', () => { send({ type: 'KT_OPEN_CONNECT' }); window.close(); });
$('#pick').addEventListener('click', () => { send({ type: 'KT_OPEN_PICKER' }); window.close(); });

init();
