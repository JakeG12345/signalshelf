// Service worker: talks to the local server (avoids page CORS / Private Network Access issues)
// and orchestrates capture for both the popup and auto-capture.
const DEFAULT_API = 'http://127.0.0.1:3456';

async function server() {
  const { apiBase = DEFAULT_API, apiToken = '' } = await chrome.storage.sync.get(['apiBase', 'apiToken']);
  return { base: String(apiBase || DEFAULT_API).replace(/\/+$/, ''), token: apiToken };
}

async function api(path, opts = {}) {
  const { base, token } = await server();
  let res;
  try {
    res = await fetch(base + path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opts.headers || {}) },
      signal: AbortSignal.timeout(opts.timeout || 20000)
    });
  } catch {
    throw new Error(base.includes('127.0.0.1') || base.includes('localhost')
      ? 'Local server is offline. Run "npm start", or set your cloud URL in Server settings.'
      : `Can't reach ${base}. Check the URL in Server settings.`);
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error('Key missing or wrong. Paste it from the app\'s Account panel into Server settings.');
  if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
  return data;
}

// Reads the live player response from the page's own JS world (fresh even after in-site navigation).
async function readPlayerResponse(tabId) {
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        try {
          const p = document.getElementById('movie_player');
          const pr = (p && p.getPlayerResponse && p.getPlayerResponse()) || window.ytInitialPlayerResponse;
          if (!pr) return null;
          return JSON.stringify({ videoDetails: pr.videoDetails, captions: pr.captions, microformat: pr.microformat });
        } catch { return null; }
      }
    });
    return r?.result ? JSON.parse(r.result) : null;
  } catch {
    return null;
  }
}

async function sendToTab(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    // Tab was open before the extension loaded: inject the content script, then retry.
    await chrome.scripting.executeScript({ target: { tabId }, files: ['history.js', 'content.js'] });
    return chrome.tabs.sendMessage(tabId, msg);
  }
}

async function captureTab(tabId, { auto = false } = {}) {
  const tab = await chrome.tabs.get(tabId);
  if (!/^https:\/\/www\.youtube\.com\/(watch|shorts\/)/.test(tab.url || '')) {
    throw new Error('Open a YouTube video first.');
  }
  const playerResponse = await readPlayerResponse(tabId);
  const extracted = await sendToTab(tabId, { type: 'KT_EXTRACT', playerResponse, auto });
  if (!extracted?.ok) throw new Error(extracted?.error || 'Could not read this video.');
  const { entry } = await api('/api/ingest', { method: 'POST', body: JSON.stringify(extracted.payload) });
  chrome.action.setBadgeText({ tabId, text: '✓' });
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#2740FF' });
  return { ok: true, entry, method: extracted.method, auto };
}

// Reads the signed-in user's YouTube watch history through a youtube.com tab (same-origin, their cookies).
async function readYouTubeHistory() {
  let [tab] = await chrome.tabs.query({ url: 'https://www.youtube.com/*' });
  let temp = null;
  if (!tab) {
    temp = await chrome.tabs.create({ url: 'https://www.youtube.com/', active: false });
    tab = temp;
    await new Promise(resolve => {
      const done = (id, info) => { if (id === temp.id && info.status === 'complete') { chrome.tabs.onUpdated.removeListener(done); resolve(); } };
      chrome.tabs.onUpdated.addListener(done);
      setTimeout(resolve, 15000);
    });
  }
  try {
    const res = await sendToTab(tab.id, { type: 'KT_HISTORY' });
    if (!res?.ok) throw new Error(res?.error || 'Could not read your YouTube history.');
    return res.items;
  } finally {
    if (temp) chrome.tabs.remove(temp.id).catch(() => {});
  }
}

// New installs: auto-capture on (2 min of playback). Respect a choice already synced from another device.
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== 'install') return;
  const { autoCapture } = await chrome.storage.sync.get('autoCapture');
  if (autoCapture === undefined) await chrome.storage.sync.set({ autoCapture: true, thresholdMin: 2 });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handlers = {
    KT_CAPTURE: () => captureTab(msg.tabId),
    KT_AUTO_CAPTURE: () => captureTab(sender.tab.id, { auto: true }),
    KT_INGEST_URL: () => api('/api/ingest-url', { method: 'POST', body: JSON.stringify({ url: msg.url, status: msg.status }), timeout: 45000 }),
    KT_HISTORY: () => readYouTubeHistory(),
    KT_EXISTS: () => api('/api/entries/exists', { method: 'POST', body: JSON.stringify({ ids: msg.ids }) }),
    KT_OPEN_PICKER: () => chrome.tabs.create({ url: chrome.runtime.getURL('picker.html') }).then(() => true),
    KT_HEALTH: async () => ({ ...(await api('/api/health', { timeout: 4000 })), base: (await server()).base }),
    KT_GET: () => api('/api/entries/' + encodeURIComponent(msg.id)).catch(e => (/not found/i.test(e.message) ? null : Promise.reject(e))),
    KT_RATE: () => api('/api/entries/' + encodeURIComponent(msg.id), { method: 'PATCH', body: JSON.stringify(msg.patch) })
  };
  const h = handlers[msg?.type];
  if (!h) return false;
  Promise.resolve()
    .then(h)
    .then(data => sendResponse({ ok: true, data }))
    .catch(err => sendResponse({ ok: false, error: err.message }));
  return true; // async response
});

// Clear the ✓ badge when the tab moves to another video
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url) chrome.action.setBadgeText({ tabId, text: '' });
});
