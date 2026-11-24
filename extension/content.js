// Signal Shelf content script (runs on all youtube.com pages; YouTube is a single-page app).
(() => {
  if (window.__ktLoaded) return;
  window.__ktLoaded = true;

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const clean = s => String(s || '').replace(/\s+/g, ' ').trim();

  function currentVideoId() {
    const u = new URL(location.href);
    if (u.pathname === '/watch') return u.searchParams.get('v');
    const m = u.pathname.match(/^\/shorts\/([\w-]{11})/);
    return m ? m[1] : null;
  }

  // ---------- Player response ----------
  function extractJsonObject(text, marker) {
    let i = text.indexOf(marker);
    if (i === -1) return null;
    i = text.indexOf('{', i + marker.length);
    if (i === -1) return null;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) { try { return JSON.parse(text.slice(i, j + 1)); } catch { return null; } }
    }
    return null;
  }

  async function getPlayerResponse(videoId, fromPage) {
    if (fromPage?.videoDetails?.videoId === videoId) return fromPage;
    try {
      const html = await fetch(`https://www.youtube.com/watch?v=${videoId}`, { credentials: 'include' }).then(r => r.text());
      const pr = extractJsonObject(html, 'ytInitialPlayerResponse');
      if (pr?.videoDetails?.videoId === videoId) return pr;
    } catch { /* fall through */ }
    return null;
  }

  // ---------- Captions via timedtext ----------
  function pickTrack(tracks) {
    const score = t => {
      const code = String(t.languageCode || '').toLowerCase();
      return (code === 'en' ? 40 : code.startsWith('en-') ? 35 : 0) + (t.kind !== 'asr' ? 20 : 0);
    };
    return [...tracks].sort((a, b) => score(b) - score(a))[0];
  }

  function parseCaptionBody(body) {
    const t = String(body || '').trim();
    if (!t) return '';
    if (t.startsWith('{')) {
      try {
        const j = JSON.parse(t);
        return clean((j.events || []).map(ev => (ev.segs || []).map(s => s.utf8 || '').join('')).join(' '));
      } catch { return ''; }
    }
    const doc = new DOMParser().parseFromString(t, 'text/xml');
    const raw = [...doc.querySelectorAll('text, p')].map(n => n.textContent).join(' ');
    // srv1 captions are often double-encoded (&amp;#39;); decode the second layer (DOMParser never runs scripts)
    return clean(new DOMParser().parseFromString(`<body>${raw.replace(/</g, '&lt;')}</body>`, 'text/html').body.textContent);
  }

  async function captionsFromTracks(pr) {
    const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    if (!tracks.length) return '';
    const base = pickTrack(tracks).baseUrl;
    for (const url of [base.replace(/&fmt=[^&]*/, '') + '&fmt=json3', base]) {
      try {
        const text = parseCaptionBody(await fetch(url, { credentials: 'include' }).then(r => r.text()));
        if (text) return text;
      } catch { /* next */ }
    }
    return '';
  }

  // ---------- Captions via the "Show transcript" panel (works when timedtext returns empty) ----------
  const SEGMENT_SELECTORS = [
    'ytd-transcript-segment-renderer .segment-text',
    'ytd-transcript-segment-renderer yt-formatted-string:not(.segment-timestamp)',
    'transcript-segment-view-model .yt-core-attributed-string',
    'transcript-segment-view-model span[role="text"]'
  ];
  const panelEl = () => document.querySelector('ytd-engagement-panel-section-list-renderer[target-id*="transcript"]');

  function readSegments() {
    const root = panelEl() || document;
    for (const sel of SEGMENT_SELECTORS) {
      const nodes = root.querySelectorAll(sel);
      if (nodes.length) return clean([...nodes].map(n => n.textContent).join(' '));
    }
    return '';
  }

  function findTranscriptButton() {
    const direct = document.querySelector('ytd-video-description-transcript-section-renderer button');
    if (direct) return direct;
    const candidates = document.querySelectorAll('#description button, ytd-watch-metadata button, #primary button, ytd-menu-popup-renderer tp-yt-paper-item');
    return [...candidates].find(b => /transcript/i.test(b.getAttribute('aria-label') || b.textContent || '')) || null;
  }

  async function captionsFromPanel() {
    let text = readSegments();
    if (text) return text;
    const panel = panelEl();
    const wasOpen = panel?.getAttribute('visibility') === 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED';
    let btn = findTranscriptButton();
    if (!btn) {
      const expand = document.querySelector('ytd-text-inline-expander #expand, tp-yt-paper-button#expand, #description-inline-expander #expand');
      if (expand) { expand.click(); await sleep(400); btn = findTranscriptButton(); }
    }
    if (!btn) return '';
    btn.click();
    for (let i = 0; i < 40 && !text; i++) { await sleep(250); text = readSegments(); }
    if (!wasOpen) {
      const p = panelEl();
      if (p) p.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN');
    }
    return text;
  }

  async function extract(fromPage) {
    const videoId = currentVideoId();
    if (!videoId) return { ok: false, error: 'Not on a YouTube video page.' };
    const pr = await getPlayerResponse(videoId, fromPage);
    const d = pr?.videoDetails || {};
    const mf = pr?.microformat?.playerMicroformatRenderer || {};
    let transcript = '', method = 'none';
    transcript = await captionsFromTracks(pr);
    if (transcript) method = 'captions';
    else {
      transcript = await captionsFromPanel();
      if (transcript) method = 'transcript-panel';
    }
    const domTitle = clean(document.querySelector('ytd-watch-metadata h1, h1.ytd-watch-metadata')?.textContent) ||
      document.title.replace(/^\(\d+\)\s*/, '').replace(/ - YouTube$/, '').trim();
    const domChannel = clean(document.querySelector('ytd-watch-metadata ytd-channel-name a, #owner #channel-name a')?.textContent);
    return {
      ok: true,
      method,
      payload: {
        id: `yt_${videoId}`,
        source: 'youtube',
        title: d.title || domTitle || `YouTube video ${videoId}`,
        creator: d.author || domChannel || '',
        url: `https://www.youtube.com/watch?v=${videoId}`,
        duration_sec: Number(d.lengthSeconds) || Math.round(document.querySelector('video')?.duration || 0) || null,
        published_at: mf.publishDate || mf.uploadDate || null,
        thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        transcript,
        transcript_status: transcript ? 'ok' : 'missing'
      }
    };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'KT_EXTRACT') {
      extract(msg.playerResponse).then(sendResponse, err => sendResponse({ ok: false, error: err.message }));
      return true;
    }
    if (msg?.type === 'KT_HISTORY') {
      fetch('/feed/history', { credentials: 'include' })
        .then(r => r.text())
        .then(html => {
          const data = extractJsonObject(html, 'ytInitialData');
          const items = data ? globalThis.ktParseHistory(data) : [];
          if (!items.length) {
            const signedOut = /"LOGGED_IN":false|ServiceLogin|accounts\.google\.com\/ServiceLogin/.test(html);
            return sendResponse({ ok: false, error: signedOut ? 'Sign in to YouTube in Chrome first.' : 'No watch history found. Is YouTube history turned on?' });
          }
          sendResponse({ ok: true, items });
        })
        .catch(err => sendResponse({ ok: false, error: `Couldn't read your YouTube history: ${err.message}` }));
      return true;
    }
    if (msg?.type === 'KT_STATE') {
      sendResponse({ videoId: currentVideoId(), watchedSec: Math.round(watch.played), autoSaved: watch.saved });
      return false;
    }
    return false;
  });

  // ---------- Auto-capture ----------
  const settings = { autoCapture: true, thresholdMin: 2, apiBase: '', apiToken: '' };
  chrome.storage.sync.get(settings, s => Object.assign(settings, s));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    for (const [k, v] of Object.entries(changes)) if (k in settings) settings[k] = v.newValue;
  });

  const watch = { id: null, played: 0, lastT: null, saved: false, busy: false };

  async function alreadyAutoSaved(id) {
    const { kt_autosaved = {} } = await chrome.storage.local.get('kt_autosaved');
    return !!kt_autosaved[id];
  }
  async function markAutoSaved(id) {
    const { kt_autosaved = {} } = await chrome.storage.local.get('kt_autosaved');
    kt_autosaved[id] = Date.now();
    const keys = Object.keys(kt_autosaved);
    if (keys.length > 1000) keys.sort((a, b) => kt_autosaved[a] - kt_autosaved[b]).slice(0, keys.length - 1000).forEach(k => delete kt_autosaved[k]);
    await chrome.storage.local.set({ kt_autosaved });
  }

  function toast(text, isErr) {
    let el = document.getElementById('kt-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'kt-toast';
      Object.assign(el.style, {
        position: 'fixed', right: '20px', bottom: '20px', zIndex: 2147483647, padding: '10px 14px', borderRadius: '4px',
        background: '#15171A', color: '#E6E8E2', font: '13px/1.4 -apple-system, Roboto, sans-serif',
        boxShadow: '0 6px 24px rgba(0,0,0,.35)', transition: 'opacity .25s', maxWidth: '320px'
      });
      document.documentElement.appendChild(el);
    }
    el.style.border = `1px solid ${isErr ? '#B3261E' : '#5B70FF'}`;
    el.textContent = text;
    el.style.opacity = '1';
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.style.opacity = '0'; }, 4000);
  }

  async function maybeAutoCapture(video) {
    if (!settings.autoCapture || watch.saved || watch.busy || !watch.id) return;
    // Not connected yet (no key, no custom server): stay quiet instead of failing on every video.
    if (!settings.apiToken && !settings.apiBase) return;
    const threshold = Math.max(0.5, Number(settings.thresholdMin) || 2) * 60;
    const dur = video.duration;
    // Short videos: count as watched at 90% if they are shorter than the threshold.
    const shortDone = Number.isFinite(dur) && dur > 0 && dur < threshold && watch.played >= dur * 0.9;
    if (watch.played < threshold && !shortDone) return;
    watch.busy = true;
    const id = watch.id;
    try {
      if (await alreadyAutoSaved(id)) { watch.saved = true; return; }
      const res = await chrome.runtime.sendMessage({ type: 'KT_AUTO_CAPTURE' });
      if (id !== watch.id) return; // navigated away mid-save
      if (res?.ok) {
        watch.saved = true;
        await markAutoSaved(id);
        const chars = res.data.entry.transcript_chars || 0;
        toast(`✓ Auto-saved to Signal Shelf${chars ? ` · ${chars.toLocaleString()} chars` : ' · no transcript found'}`);
      } else {
        watch.saved = true; // don't retry every second; manual save still works
        toast(`Signal Shelf: ${res?.error || 'auto-save failed'}`, true);
      }
    } catch (e) {
      watch.saved = true;
      if (!/Extension context invalidated/i.test(e.message)) toast(`Signal Shelf: ${e.message}`, true);
    } finally {
      watch.busy = false;
    }
  }

  setInterval(() => {
    const id = currentVideoId();
    if (id !== watch.id) Object.assign(watch, { id, played: 0, lastT: null, saved: false, busy: false });
    if (!id) return;
    const video = document.querySelector('#movie_player video, video.html5-main-video, video');
    if (!video) return;
    const isAd = !!document.querySelector('#movie_player.ad-showing');
    const t = video.currentTime;
    if (!video.paused && !video.ended && !isAd && watch.lastT !== null) {
      const delta = t - watch.lastT;
      if (delta > 0 && delta <= 5) watch.played += delta; // seeks/jumps don't count
    }
    watch.lastT = isAd ? null : t;
    maybeAutoCapture(video);
  }, 1000);
})();
