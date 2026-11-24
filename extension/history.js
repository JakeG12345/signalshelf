// Parses youtube.com/feed/history (ytInitialData). Mirrors parseHistoryPage in server/public/importers.js.
(() => {
  if (globalThis.ktParseHistory) return;
  function collect(obj, keys, out = [], depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 80) return out;
    if (Array.isArray(obj)) { for (const v of obj) collect(v, keys, out, depth + 1); return out; }
    for (const [k, v] of Object.entries(obj)) {
      if (keys.includes(k)) out.push([k, v]);
      else collect(v, keys, out, depth + 1);
    }
    return out;
  }
  globalThis.ktParseHistory = function (initialData) {
    const items = [];
    for (const [k, v] of collect(initialData, ['videoRenderer', 'lockupViewModel'])) {
      let id, title, creator, length;
      if (k === 'videoRenderer') {
        id = v.videoId;
        title = (v.title?.runs || []).map(r => r.text).join('') || v.title?.simpleText;
        creator = v.ownerText?.runs?.[0]?.text || v.longBylineText?.runs?.[0]?.text || '';
        length = v.lengthText?.simpleText;
      } else {
        if (v.contentType && !/VIDEO/.test(v.contentType)) continue;
        id = v.contentId;
        const meta = v.metadata?.lockupMetadataViewModel;
        title = meta?.title?.content;
        creator = meta?.metadata?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts?.[0]?.text?.content || '';
      }
      if (!id || !/^[\w-]{11}$/.test(id) || !title) continue;
      items.push({ key: `yt_${id}`, kind: 'youtube', title, creator, url: `https://www.youtube.com/watch?v=${id}`, watched_at: null, length });
    }
    const seen = new Set();
    return items.filter(i => !seen.has(i.key) && seen.add(i.key));
  };
})();
