// Supadata transcript provider (https://supadata.ai). Used when SUPADATA_API_KEY is set.
// YouTube blocks most cloud servers from fetching captions; Supadata isn't blocked.
const API = 'https://api.supadata.ai/v1';
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function supadataProvider(apiKey, fetchImpl = fetch) {
  if (!apiKey) return null;
  const headers = { 'x-api-key': apiKey, Accept: 'application/json' };

  const read = async res => {
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 || res.status === 403) throw new Error('API key rejected');
    if (res.status === 402 || res.status === 429) throw new Error('monthly limit reached');
    if (!res.ok && res.status !== 202) return { text: '' };
    if (data.jobId && res.status === 202) return { jobId: data.jobId };
    if (data.status && data.status !== 'completed') return { pending: data.status !== 'failed' };
    const c = data.content;
    return { text: typeof c === 'string' ? c : Array.isArray(c) ? c.map(s => s.text || '').join(' ') : '' };
  };

  return async watchUrl => {
    // mode=native: use the video's existing captions only (1 credit), never paid AI transcription
    const q = new URLSearchParams({ url: watchUrl, text: 'true', mode: 'native' });
    let r = await read(await fetchImpl(`${API}/transcript?${q}`, { headers, signal: AbortSignal.timeout(20000) }));
    if (r.jobId) {
      for (let i = 0; i < 8 && !r.text; i++) {
        await sleep(2000);
        const next = await read(await fetchImpl(`${API}/transcript/${encodeURIComponent(r.jobId)}`, { headers, signal: AbortSignal.timeout(10000) }));
        if (!next.pending) { r = next; break; }
      }
    }
    return (r.text || '').replace(/\s+/g, ' ').trim();
  };
}
