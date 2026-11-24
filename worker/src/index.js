// Signal Shelf cloud backend: Cloudflare Worker + D1.
//   /            public shelf (live, once published)
//   /shelf.json  public shelf data
//   /app/        private web app (installable on iPhone home screen)
//   /api/*       private JSON API (Bearer token)
//   /mcp/<token> remote MCP endpoint for Claude
import { ensureSchema, createStore } from './store.js';
import { handleMcp } from './mcp.js';
import { captureLink } from '../../shared/capture.js';
import { APP_VERSION, SCHEMA_VERSION, MONETIZATION_MODELS, SOURCES, STATUSES, HttpError } from '../../shared/core.js';
import { normalizeShelfSettings, shelfDataFromEntries, renderShelfHtml } from '../../shared/shelf-render.js';

const MIN_TOKEN_LENGTH = 16;

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });

function safeEqual(a, b) {
  const x = new TextEncoder().encode(String(a));
  const y = new TextEncoder().encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function bearer(request) {
  const h = request.headers.get('Authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : request.headers.get('X-Api-Key') || '';
}

const slim = e => {
  if (!e) return e;
  const { transcript, ...rest } = e;
  return { ...rest, transcript_chars: (transcript || '').length };
};

function savedMessage(e) {
  const t = e.transcript_chars ? `${e.transcript_chars.toLocaleString('en-AU')} chars` : e.transcript_status === 'description' ? 'description only' : 'no transcript';
  return `Saved "${e.title}" (${t})`;
}

async function readJson(request) {
  try { return await request.json(); } catch { throw new HttpError(400, 'Invalid JSON body'); }
}

async function shelfSettings(store) {
  return normalizeShelfSettings((await store.getSetting('shelf', {})) || {});
}

async function shelfData(store) {
  const settings = await shelfSettings(store);
  const entries = await store.query({ minRating: settings.minRating, sort: 'rating', limit: 500 });
  return { settings, data: shelfDataFromEntries(entries, settings) };
}

const LANDING = origin => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Signal Shelf</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#14181c;color:#e6ebf0;font:16px/1.5 -apple-system,BlinkMacSystemFont,Roboto,sans-serif;text-align:center;padding:24px}
h1{margin:0 0 8px;font-size:32px}h1 span{color:#00c030}p{color:#8b98a5;margin:0 0 20px}a{color:#40bcf4}</style></head>
<body><div><h1>Signal <span>Shelf</span></h1><p>The highest-signal videos &amp; podcasts on making money and building with AI.<br>This shelf isn't published yet.</p>
<a href="${origin}/app/">Open the app →</a></div></body></html>`;

async function api(request, env, url, store) {
  const path = url.pathname;
  const method = request.method;
  let m;

  if (path === '/api/meta' && method === 'GET') {
    return json({
      mode: 'cloud', version: APP_VERSION,
      capabilities: { podcastsSync: false, shelfLive: true },
      shelfUrl: `${url.origin}/`,
      mcpUrl: `${url.origin}/mcp/${env.APP_TOKEN}`,
      shortcutUrl: `${url.origin}/app/#add=`,
      monetizationModels: MONETIZATION_MODELS, sources: SOURCES, statuses: STATUSES, stats: await store.stats()
    });
  }

  if (path === '/api/ingest' && method === 'POST') {
    const b = await readJson(request);
    const entry = await store.upsert({
      id: b.id, source: b.source || 'youtube', title: String(b.title || '').trim(), creator: b.creator, url: b.url,
      duration_sec: b.duration_sec, transcript: b.transcript, published_at: b.published_at || null,
      thumbnail: b.thumbnail || null, transcript_status: b.transcript_status || null, tags: b.tags || null
    });
    return json({ ok: true, entry: slim(entry), message: savedMessage(slim(entry)) });
  }

  if (path === '/api/ingest-url' && method === 'POST') {
    const { url: link, status } = await readJson(request);
    if (!link) throw new HttpError(400, 'url is required');
    const { warnings, ...data } = await captureLink(link);
    let entry = await store.upsert(data);
    if (status && STATUSES.includes(status)) entry = await store.update(entry.id, { status });
    return json({ ok: true, entry: slim(entry), warnings, message: savedMessage(slim(entry)) });
  }

  if (path === '/api/sync/podcasts' && method === 'POST') {
    return json({ synced: 0, error: 'Apple Podcasts library sync only works in the Mac version. On iPhone, share an episode to Signal Shelf instead.' });
  }

  if (path === '/api/entries' && method === 'GET') {
    const p = url.searchParams;
    return json(await store.query({
      q: p.get('q') || '', source: p.get('source'), minRating: p.get('minRating') ? Number(p.get('minRating')) : null,
      model: p.get('model'), status: p.get('status'), sort: p.get('sort'), limit: Number(p.get('limit')) || 100, offset: p.get('offset')
    }));
  }

  if ((m = path.match(/^\/api\/entries\/([^/]+)$/))) {
    const id = decodeURIComponent(m[1]);
    if (method === 'GET') {
      const e = await store.get(id);
      if (!e) throw new HttpError(404, 'Not found');
      return json(e);
    }
    if (method === 'PATCH') return json({ ok: true, entry: await store.update(id, await readJson(request)) });
    if (method === 'DELETE') {
      if (!(await store.remove(id))) throw new HttpError(404, 'Not found');
      return json({ ok: true });
    }
  }

  if (path === '/api/shelf/settings') {
    if (method === 'GET') return json(await shelfSettings(store));
    if (method === 'PUT') return json(await store.setSetting('shelf', normalizeShelfSettings(await shelfSettings(store), await readJson(request))));
  }

  if (path === '/api/shelf/publish' && method === 'POST') {
    const patch = await readJson(request).catch(() => ({}));
    const settings = await store.setSetting('shelf', normalizeShelfSettings(await shelfSettings(store), { ...patch, published: patch.published ?? true }));
    const { data } = await shelfData(store);
    return json({ ok: true, count: data.count, settings, url: `${url.origin}/`, previewUrl: '/' });
  }

  if (path === '/api/export' && method === 'GET') {
    return json({ schema: SCHEMA_VERSION, exported_at: new Date().toISOString(), shelf: await shelfSettings(store), entries: await store.all() }, 200, {
      'Content-Disposition': `attachment; filename="signal-shelf-${new Date().toISOString().slice(0, 10)}.json"`
    });
  }

  if (path === '/api/import' && method === 'POST') {
    const body = await readJson(request);
    const entries = Array.isArray(body) ? body : body.entries;
    if (!Array.isArray(entries)) throw new HttpError(400, 'Expected { entries: [...] }');
    let imported = 0;
    for (const e of entries.slice(0, 2000)) {
      await store.upsert({ ...e, bumpWatched: false, tags: e.tags || null, status: e.status });
      await store.update(e.id, {
        signal_rating: e.signal_rating ?? null, monetization_models: e.monetization_models || [], key_takeaways: e.key_takeaways || [],
        personal_notes: e.personal_notes || e.notes || '', status: STATUSES.includes(e.status) ? e.status : 'watched'
      });
      imported++;
    }
    return json({ ok: true, imported });
  }

  throw new HttpError(404, `No route ${method} ${path}`);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      // ---- Public ----
      if (path === '/api/health') {
        const authed = env.APP_TOKEN && safeEqual(bearer(request), env.APP_TOKEN);
        let entries;
        if (authed) { await ensureSchema(env.DB); entries = (await createStore(env.DB).stats()).total; }
        return json({ ok: true, mode: 'cloud', dashboard: '/app/', version: APP_VERSION, configured: !!env.APP_TOKEN, authed: !!authed, ...(authed ? { entries } : {}) });
      }
      if (path === '/app') return Response.redirect(`${url.origin}/app/${url.search}`, 301);
      if (path.startsWith('/app/')) {
        const asset = path === '/app/' ? '/index.html' : path.slice(4);
        const res = await env.ASSETS.fetch(new Request(new URL(asset, url.origin), request));
        if (res.status === 404) return env.ASSETS.fetch(new Request(new URL('/index.html', url.origin), request));
        const out = new Response(res.body, res);
        out.headers.set('Cache-Control', asset === '/index.html' ? 'no-cache' : 'public, max-age=3600');
        return out;
      }
      if (path === '/' || path === '/shelf.json') {
        await ensureSchema(env.DB);
        const { settings, data } = await shelfData(createStore(env.DB));
        if (!settings.published) {
          return path === '/' ? new Response(LANDING(url.origin), { headers: { 'Content-Type': 'text/html; charset=utf-8' } }) : json({ error: 'Shelf not published' }, 404);
        }
        const cache = { 'Cache-Control': 'public, max-age=60' };
        return path === '/'
          ? new Response(renderShelfHtml(data, { jsonHref: '/shelf.json' }), { headers: { 'Content-Type': 'text/html; charset=utf-8', ...cache } })
          : json(data, 200, { ...cache, 'Access-Control-Allow-Origin': '*' });
      }

      // ---- Private (token) ----
      const isMcp = path === '/mcp' || path.startsWith('/mcp/');
      if (!path.startsWith('/api/') && !isMcp) {
        const res = await env.ASSETS.fetch(request);
        return res.status === 404 ? new Response('Not found', { status: 404 }) : res;
      }
      if (!env.APP_TOKEN || env.APP_TOKEN.length < MIN_TOKEN_LENGTH) {
        return json({ error: `Server not configured: set the APP_TOKEN secret (at least ${MIN_TOKEN_LENGTH} characters).` }, 503);
      }
      const supplied = isMcp && path.length > 5 ? decodeURIComponent(path.slice(5)) : bearer(request);
      if (!safeEqual(supplied, env.APP_TOKEN)) return json({ error: 'Unauthorized' }, 401);

      await ensureSchema(env.DB);
      const store = createStore(env.DB);
      if (isMcp) return handleMcp(request, { store, origin: url.origin });
      return await api(request, env, url, store);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error(err);
      return json({ error: err.message || 'Server error' }, status);
    }
  }
};
