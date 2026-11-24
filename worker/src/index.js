// Signal Shelf cloud backend: Cloudflare Worker + D1, multi-user with anonymous accounts.
//   /                  landing page + fresh public shelves
//   /u/<handle>        a user's public shelf (+ /shelf.json)
//   /app/              the web app (installable on iPhone)
//   /api/auth/anon     creates an anonymous account, returns its private key
//   /api/*             private JSON API (Authorization: Bearer <key>)
//   /mcp/<key>         remote MCP endpoint for Claude
import { ensureSchema, createStore } from './store.js';
import { handleMcp } from './mcp.js';
import { renderLanding, renderNotFound } from './landing.js';
import { createAnonymousUser, resolveUser, updateProfile, recentPublicShelves, userByHandle, rateLimit, looksLikeKey } from './accounts.js';
import { captureLink } from '../../shared/capture.js';
import { APP_VERSION, MONETIZATION_MODELS, SOURCES, STATUSES, HttpError } from '../../shared/core.js';
import { DEFAULT_SHELF_SETTINGS, normalizeShelfSettings, shelfDataFromEntries, renderShelfHtml } from '../../shared/shelf-render.js';

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });
const html = (body, status = 200, headers = {}) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers } });

function limitsFrom(env) {
  const n = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    anonPerIpPerDay: n(env.LIMIT_ANON_PER_IP_DAY, 30),
    capturesPerUserPerDay: n(env.LIMIT_CAPTURES_PER_USER_DAY, 300),
    writesPerUserPerHour: n(env.LIMIT_WRITES_PER_USER_HOUR, 2000),
    itemsPerUser: n(env.LIMIT_ITEMS_PER_USER, 5000)
  };
}

function bearer(request) {
  const m = (request.headers.get('Authorization') || '').match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : request.headers.get('X-Api-Key') || '';
}

const slim = e => {
  if (!e) return e;
  const { transcript, user_id, ...rest } = e;
  return { ...rest, transcript_chars: (transcript || '').length };
};
const savedMessage = e => `Saved "${e.title}" (${e.transcript_chars ? `${e.transcript_chars.toLocaleString('en-AU')} chars` : e.transcript_status === 'description' ? 'description only' : 'no transcript'})`;

async function readJson(request) {
  try { return await request.json(); } catch { throw new HttpError(400, 'Invalid JSON body'); }
}

async function shelfFor(db, user) {
  const store = createStore(db, user.id);
  const saved = (await store.getSetting('shelf', {})) || {};
  const settings = normalizeShelfSettings(saved);
  if (!saved.title || saved.title === DEFAULT_SHELF_SETTINGS.title) settings.title = `${user.display_name || '@' + user.handle}'s Signal Shelf`;
  const entries = await store.query({ minRating: settings.minRating, sort: 'rating', limit: 500 });
  return { settings, data: { ...shelfDataFromEntries(entries, settings), handle: user.handle } };
}

const captureGuard = (db, user, store, limits) => async () => {
  await rateLimit(db, `c:${user.id}`, limits.capturesPerUserPerDay, 86400, 'Daily save limit reached. Try again tomorrow.');
  if ((await store.count()) >= limits.itemsPerUser) throw new HttpError(403, `Shelf is full (${limits.itemsPerUser} items).`);
};

async function privateApi(request, url, ctx) {
  const { db, user, key, limits, store } = ctx;
  const path = url.pathname;
  const method = request.method;
  let m;

  if (method !== 'GET') await rateLimit(db, `w:${user.id}`, limits.writesPerUserPerHour, 3600, 'Slow down a little: too many changes this hour.');

  const guardCapture = captureGuard(db, user, store, limits);

  if (path === '/api/me') {
    if (method === 'GET') return json({ ...user, stats: await store.stats() });
    if (method === 'PUT' || method === 'PATCH') {
      const b = await readJson(request);
      return json({ ok: true, user: await updateProfile(db, user.id, { handle: b.handle, display_name: b.display_name }) });
    }
    if (method === 'DELETE') {
      await store.destroy();
      return json({ ok: true, deleted: true });
    }
  }

  if (path === '/api/meta' && method === 'GET') {
    return json({
      mode: 'cloud', version: APP_VERSION, user,
      capabilities: { podcastsSync: false, shelfLive: true, accounts: true },
      shelfUrl: user.handle ? `${url.origin}/u/${user.handle}` : null,
      mcpUrl: `${url.origin}/mcp/${key}`,
      syncUrl: `${url.origin}/app/#k=${key}`,
      shortcutUrl: `${url.origin}/app/#k=${key}&add=`,
      monetizationModels: MONETIZATION_MODELS, sources: SOURCES, statuses: STATUSES, stats: await store.stats()
    });
  }

  if (path === '/api/ingest' && method === 'POST') {
    const b = await readJson(request);
    if (!(await store.get(String(b.id || '')))) await guardCapture();
    const entry = slim(await store.upsert({
      id: b.id, source: b.source || 'youtube', title: String(b.title || '').trim(), creator: b.creator, url: b.url,
      duration_sec: b.duration_sec, transcript: b.transcript, published_at: b.published_at || null,
      thumbnail: b.thumbnail || null, transcript_status: b.transcript_status || null, tags: b.tags || null
    }));
    return json({ ok: true, entry, message: savedMessage(entry) });
  }

  if (path === '/api/ingest-url' && method === 'POST') {
    const { url: link, status } = await readJson(request);
    if (!link) throw new HttpError(400, 'url is required');
    await guardCapture();
    const { warnings, ...data } = await captureLink(link);
    let entry = await store.upsert(data);
    if (status && STATUSES.includes(status)) entry = await store.update(entry.id, { status });
    entry = slim(entry);
    return json({ ok: true, entry, warnings, message: savedMessage(entry) });
  }

  if (path === '/api/sync/podcasts' && method === 'POST') {
    return json({ synced: 0, error: 'Apple Podcasts library sync only works in the Mac version. Share an episode to Signal Shelf instead.' });
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
      const { user_id, ...rest } = e;
      return json(rest);
    }
    if (method === 'PATCH') return json({ ok: true, entry: slim(await store.update(id, await readJson(request))) });
    if (method === 'DELETE') {
      if (!(await store.remove(id))) throw new HttpError(404, 'Not found');
      return json({ ok: true });
    }
  }

  if (path === '/api/shelf/settings') {
    const current = normalizeShelfSettings((await store.getSetting('shelf', {})) || {});
    if (method === 'GET') return json({ ...current, handle: user.handle });
    if (method === 'PUT') return json(await store.setSetting('shelf', normalizeShelfSettings(current, await readJson(request))));
  }

  if (path === '/api/shelf/publish' && method === 'POST') {
    const patch = await readJson(request).catch(() => ({}));
    let u = user;
    if (patch.handle && patch.handle !== user.handle) u = { ...user, ...(await updateProfile(db, user.id, { handle: patch.handle })) };
    if (!u.handle) throw new HttpError(400, 'Pick a username first: it becomes your shelf link.');
    const current = normalizeShelfSettings((await store.getSetting('shelf', {})) || {});
    const { handle, ...rest } = patch;
    const settings = await store.setSetting('shelf', normalizeShelfSettings(current, { ...rest, published: rest.published ?? true }));
    const { data } = await shelfFor(db, u);
    return json({ ok: true, count: data.count, settings, handle: u.handle, url: `${url.origin}/u/${u.handle}` });
  }

  if (path === '/api/export' && method === 'GET') {
    return json({ schema: 3, exported_at: new Date().toISOString(), user: { handle: user.handle, display_name: user.display_name },
      shelf: await store.getSetting('shelf', {}), entries: await store.all() }, 200, {
      'Content-Disposition': `attachment; filename="signal-shelf-${new Date().toISOString().slice(0, 10)}.json"`
    });
  }

  if (path === '/api/import' && method === 'POST') {
    const body = await readJson(request);
    const entries = Array.isArray(body) ? body : body.entries;
    if (!Array.isArray(entries)) throw new HttpError(400, 'Expected { entries: [...] }');
    const room = limits.itemsPerUser - (await store.count());
    let imported = 0;
    for (const e of entries.slice(0, Math.max(0, Math.min(room, 2000)))) {
      await store.upsert({ ...e, bumpWatched: false, tags: e.tags || null });
      await store.update(e.id, {
        signal_rating: e.signal_rating ?? null, monetization_models: e.monetization_models || [], key_takeaways: e.key_takeaways || [],
        personal_notes: e.personal_notes || e.notes || '', status: STATUSES.includes(e.status) ? e.status : 'watched'
      });
      imported++;
    }
    return json({ ok: true, imported, skipped: entries.length - imported });
  }

  throw new HttpError(404, `No route ${method} ${path}`);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const db = env.DB;
    const limits = limitsFrom(env);
    try {
      // ---------- Static app ----------
      if (path === '/app') return Response.redirect(`${url.origin}/app/${url.search}`, 301);
      if (path.startsWith('/app/')) {
        const asset = path === '/app/' ? '/index.html' : path.slice(4);
        let res = await env.ASSETS.fetch(new Request(new URL(asset, url.origin), request));
        if (res.status === 404) res = await env.ASSETS.fetch(new Request(new URL('/index.html', url.origin), request));
        const out = new Response(res.body, res);
        out.headers.set('Cache-Control', asset === '/index.html' ? 'no-cache' : 'public, max-age=3600');
        return out;
      }

      await ensureSchema(db);

      // ---------- Public ----------
      if (path === '/api/health') {
        const user = await resolveUser(db, bearer(request));
        return json({ ok: true, mode: 'cloud', dashboard: '/app/', version: APP_VERSION, accounts: true, authed: !!user,
          ...(user ? { entries: (await createStore(db, user.id).stats()).total, handle: user.handle } : {}) });
      }
      if (path === '/' || path === '') {
        return html(renderLanding({ origin: url.origin, shelves: await recentPublicShelves(db) }), 200, { 'Cache-Control': 'public, max-age=60' });
      }
      let m;
      if ((m = path.match(/^\/(?:u\/|@)([A-Za-z0-9_]{3,20})(\/shelf\.json)?\/?$/))) {
        const u = await userByHandle(db, m[1]);
        const shelf = u ? await shelfFor(db, u) : null;
        if (!shelf || !shelf.settings.published) {
          return m[2] ? json({ error: 'Shelf not found' }, 404) : html(renderNotFound(url.origin), 404);
        }
        if (path.startsWith('/@')) return Response.redirect(`${url.origin}/u/${u.handle}`, 301);
        const cache = { 'Cache-Control': 'public, max-age=60' };
        return m[2]
          ? json(shelf.data, 200, { ...cache, 'Access-Control-Allow-Origin': '*' })
          : html(renderShelfHtml(shelf.data, { jsonHref: `/u/${u.handle}/shelf.json`, ctaUrl: `${url.origin}/`, canonicalUrl: `${url.origin}/u/${u.handle}` }), 200, cache);
      }
      if (path === '/api/auth/anon' && request.method === 'POST') {
        return json(await createAnonymousUser(db, request, limits), 201);
      }

      // ---------- Private ----------
      const isMcp = path === '/mcp' || path.startsWith('/mcp/');
      if (!path.startsWith('/api/') && !isMcp) {
        const res = await env.ASSETS.fetch(request);
        return res.status === 404 ? html(renderNotFound(url.origin, 'Page not found.'), 404) : res;
      }
      const key = isMcp && path.length > 5 ? decodeURIComponent(path.slice(5)) : bearer(request);
      const user = looksLikeKey(key) ? await resolveUser(db, key) : null;
      if (!user) return json({ error: 'Unauthorized: unknown or missing key' }, 401);

      const store = createStore(db, user.id);
      if (isMcp) {
        await rateLimit(db, `w:${user.id}`, limits.writesPerUserPerHour, 3600, 'Too many requests this hour.');
        return handleMcp(request, { store, origin: url.origin, user, guardCapture: captureGuard(db, user, store, limits) });
      }
      return await privateApi(request, url, { db, user, key, limits, store });
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error(err);
      return json({ error: status >= 500 ? 'Something went wrong. Please try again.' : err.message }, status);
    }
  }
};
