// Runs only on Signal Shelf's own app pages. Lets the app hand this extension the shelf key in one click,
// instead of copying it into Server settings by hand.
(() => {
  document.documentElement.dataset.ssExtension = '1'; // tells the app the extension is installed
  window.addEventListener('message', ev => {
    if (ev.source !== window || ev.origin !== location.origin) return;
    const d = ev.data;
    if (!d || d.type !== 'signalshelf:connect' || !/^ss_[A-Za-z0-9]{24,64}$/.test(d.key || '')) return;
    chrome.runtime.sendMessage({ type: 'KT_CONNECT', key: d.key, base: location.origin }, r => {
      window.postMessage({ type: 'signalshelf:connected', ok: !!r?.ok, error: r?.error }, location.origin);
    });
  });
})();
