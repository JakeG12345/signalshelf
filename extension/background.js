// Service worker: talks to the local server (avoids page CORS / Private Network Access issues)
// and orchestrates capture for both the popup and auto-capture.
const API = 'http://127.0.0.1:3456';

async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(API + path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      signal: AbortSignal.timeout(opts.timeout || 20000)
    });
  } catch {
    throw new Error('Local server is offline. Run "npm start" in your signal-shelf folder.');
  }
  const data = await res.json().catch(() => ({}));
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
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
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
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#00c030' });
  return { ok: true, entry, method: extracted.method, auto };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handlers = {
    KT_CAPTURE: () => captureTab(msg.tabId),
    KT_AUTO_CAPTURE: () => captureTab(sender.tab.id, { auto: true }),
    KT_INGEST_URL: () => api('/api/ingest-url', { method: 'POST', body: JSON.stringify({ url: msg.url, status: msg.status }), timeout: 45000 }),
    KT_HEALTH: () => api('/api/health', { timeout: 2500 }),
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
