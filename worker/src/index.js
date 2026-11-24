// Signal Shelf cloud backend: Cloudflare Worker + D1, multi-user with anonymous accounts.
//   /                  landing page + fresh public shelves
//   /u/<handle>        a user's public profile (+ /shelf.json); /people lists everyone
//   /app/              the web app (installable on iPhone)
//   /api/auth/anon     creates an anonymous account, returns its private key
//   /api/*             private JSON API (Authorization: Bearer <key>)
//   /mcp/<key>         remote MCP endpoint for Claude
import { ensureSchema, createStore } from './store.js';
import { handleMcp } from './mcp.js';
import { renderLanding, renderNotFound } from './landing.js';
import { renderProfileHtml, renderPeopleHtml, publicItem } from '../../shared/profile-render.js';
import { createAnonymousUser, resolveUser, updateProfile, listPeople, topSignal, userByHandle, followCounts, setFollow, isFollowing, listFollowing, feed, rateLimit, looksLikeKey, createAccount, changePassword, login, logout, googleEnabled, googleStart, googleCallback } from './accounts.js';
import { captureLink } from '../../shared/capture.js';
import { supadataProvider } from './transcripts.js';
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

const validDate = v => {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) && t < Date.now() + 86400000 ? new Date(t).toISOString() : null;
};

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

/** Link capture with the transcript service, skipping it for videos that already have a transcript. */
export const captureFor = (env, store) => link => captureLink(link, {
  transcriptProvider: supadataProvider(env.SUPADATA_API_KEY),
  hasTranscript: async id => ((await store.get(id))?.transcript || '').length > 0
});

const captureGuard = (db, user, store, limits) => async () => {
  await rateLimit(db, `c:${user.id}`, limits.capturesPerUserPerDay, 86400, 'Daily save limit reached. Try again tomorrow.');
  if ((await store.count()) >= limits.itemsPerUser) throw new HttpError(403, `Shelf is full (${limits.itemsPerUser} items).`);
};

async function privateApi(request, url, ctx) {
  const { db, user, key, limits, store, env = {} } = ctx;
  const path = url.pathname;
  const method = request.method;
  let m;

  if (method !== 'GET') await rateLimit(db, `w:${user.id}`, limits.writesPerUserPerHour, 3600, 'Slow down a little: too many changes this hour.');

  const guardCapture = captureGuard(db, user, store, limits);

  if (path === '/api/account/register' && method === 'POST') {
    const b = await readJson(request);
    return json({ ok: true, user: await createAccount(db, user, { handle: b.handle, password: b.password }) });
  }
  if (path === '/api/account/password' && method === 'POST') {
    const b = await readJson(request);
    await changePassword(db, user, { current: b.current, password: b.password });
    return json({ ok: true });
  }
  if (path === '/api/auth/logout' && method === 'POST') {
    if (user.via_session) await logout(db, key);
    return json({ ok: true, ended_session: user.via_session });
  }

  if (path === '/api/me') {
    if (method === 'GET') return json({ ...user, stats: await store.stats() });
    if (method === 'PUT' || method === 'PATCH') {
      const b = await readJson(request);
      return json({ ok: true, user: await updateProfile(db, user.id, { handle: b.handle, display_name: b.display_name, bio: b.bio, is_private: b.is_private }) });
    }
    if (method === 'DELETE') {
      await store.destroy();
      return json({ ok: true, deleted: true });
    }
  }

  if ((m = path.match(/^\/api\/follow\/([A-Za-z0-9_]{3,20})$/))) {
    const target = await userByHandle(db, m[1]);
    if (!target) throw new HttpError(404, 'No one with that username.');
    if (method === 'GET') return json({ self: target.id === user.id, following: await isFollowing(db, user.id, target.id) });
    if (method === 'POST' || method === 'DELETE') return json(await setFollow(db, user.id, m[1], method === 'POST'));
  }
  if (path === '/api/following' && method === 'GET') return json(await listFollowing(db, user.id));
  if (path === '/api/feed' && method === 'GET') return json(await feed(db, user.id, Math.min(Number(url.searchParams.get('limit')) || 60, 200)));

  if (path === '/api/meta' && method === 'GET') {
    return json({
      mode: 'cloud', version: APP_VERSION, user,
      capabilities: { podcastsSync: false, shelfLive: true, accounts: true, social: true },
      googleSignIn: googleEnabled(env),
      shelfUrl: user.handle ? `${url.origin}/u/${user.handle}` : null,
      profileUrl: user.handle ? `${url.origin}/u/${user.handle}` : null,
      follow: await followCounts(db, user.id),
      mcpUrl: `${url.origin}/mcp/${key}`,
      syncUrl: `${url.origin}/app/#k=${key}`,
      shortcutUrl: `${url.origin}/app/#k=${key}&add=`,
      shortcutInstallUrl: /^https:\/\/www\.icloud\.com\/shortcuts\//.test(env.SHORTCUT_ICLOUD_URL || '') ? env.SHORTCUT_ICLOUD_URL : null,
      monetizationModels: MONETIZATION_MODELS, sources: SOURCES, statuses: STATUSES, stats: await store.stats()
    });
  }

  if (path === '/api/ingest' && method === 'POST') {
    const b = await readJson(request);
    if (!(await store.get(String(b.id || '')))) await guardCapture();
    const entry = slim(await store.upsert({
      id: b.id, source: b.source || 'youtube', title: String(b.title || '').trim(), creator: b.creator, url: b.url,
      duration_sec: b.duration_sec, transcript: b.transcript, published_at: b.published_at || null,
      thumbnail: b.thumbnail || null, transcript_status: b.transcript_status || null, tags: b.tags || null,
      watched_at: validDate(b.watched_at)
    }));
    return json({ ok: true, entry, message: savedMessage(entry) });
  }

  if (path === '/api/ingest-url' && method === 'POST') {
    const { url: link, status, watched_at } = await readJson(request);
    if (!link) throw new HttpError(400, 'url is required');
    await guardCapture();
    const { warnings, ...data } = await ctx.capture(link);
    let entry = await store.upsert({ ...data, watched_at: validDate(watched_at) });
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

  if (path === '/api/entries/exists' && method === 'POST') {
    const { ids } = await readJson(request);
    if (!Array.isArray(ids)) throw new HttpError(400, 'Expected { ids: [...] }');
    const saved = [];
    for (let i = 0; i < Math.min(ids.length, 1000); i += 90) {
      const chunk = ids.slice(i, i + 90).map(String);
      const { results } = await db.prepare(`SELECT id FROM entries WHERE user_id = ? AND id IN (${chunk.map(() => '?').join(',')})`).bind(user.id, ...chunk).all();
      saved.push(...results.map(r => r.id));
    }
    return json({ saved });
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

  if (path === '/api/export' && method === 'GET' && url.searchParams.get('format') === 'md') {
    const one = url.searchParams.get('id');
    const entries = one ? [await store.get(one)].filter(Boolean) : await store.all();
    const md = entries.map(e => [
      `# ${e.title}`,
      [e.creator, e.url, e.signal_rating ? `Rated ${e.signal_rating}/5` : '', (e.monetization_models || []).join(', ')].filter(Boolean).join(' | '),
      e.key_takeaways?.length ? `## Takeaways\n${e.key_takeaways.map(t => `- ${t}`).join('\n')}` : '',
      e.personal_notes ? `## Notes\n${e.personal_notes}` : '',
      e.transcript ? `## Transcript\n${e.transcript}` : ''
    ].filter(Boolean).join('\n\n')).join('\n\n---\n\n');
    return new Response(md, { headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="signal-shelf-transcripts-${new Date().toISOString().slice(0, 10)}.md"` } });
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
        return html(renderLanding({ origin: url.origin, shelves: (await listPeople(db, { limit: 8 })).filter(p => p.items > 0), top: await topSignal(db) }), 200, { 'Cache-Control': 'public, max-age=60' });
      }
      if (path === '/people' || path === '/people/') {
        const q = (url.searchParams.get('q') || '').slice(0, 40);
        return html(renderPeopleHtml({ people: await listPeople(db, { q, limit: 60 }), q, origin: url.origin }), 200, { 'Cache-Control': q ? 'no-store' : 'public, max-age=60' });
      }
      let m;
      if ((m = path.match(/^\/(?:u\/|@)([A-Za-z0-9_]{3,20})(\/shelf\.json)?\/?$/))) {
        const u = await userByHandle(db, m[1]);
        if (!u || u.is_private) {
          const msg = u ? 'This profile is private.' : 'No one has that username yet.';
          return m[2] ? json({ error: msg }, 404) : html(renderNotFound(url.origin, msg), 404);
        }
        if (path.startsWith('/@')) return Response.redirect(`${url.origin}/u/${u.handle}`, 301);
        const sort = url.searchParams.get('sort') === 'top' ? 'top' : 'recent';
        const store = createStore(db, u.id);
        const items = (await store.query({ sort: sort === 'top' ? 'rating' : 'recent', limit: 200 })).map(publicItem);
        const counts = await followCounts(db, u.id);
        const cache = { 'Cache-Control': 'public, max-age=30' };
        if (m[2]) {
          return json({ schema: 'signal-shelf-profile/1', handle: u.handle, name: u.display_name || u.handle, bio: u.bio || '', counts, items }, 200,
            { ...cache, 'Access-Control-Allow-Origin': '*' });
        }
        return html(renderProfileHtml({ user: u, counts, items, sort, origin: url.origin }), 200, cache);
      }
      if (path === '/api/auth/login' && request.method === 'POST') {
        return json(await login(db, request, await readJson(request)));
      }
      if (path === '/api/auth/google/start' && request.method === 'POST') {
        const user = await resolveUser(db, bearer(request));
        return json({ url: await googleStart(db, request, env, url.origin, user) });
      }
      if (path === '/auth/google/callback' && request.method === 'GET') {
        try {
          const { key, kind } = await googleCallback(db, request, env, url.origin, url.searchParams);
          return Response.redirect(`${url.origin}/app/#k=${key}&google=${kind}`, 302);
        } catch (err) {
          if (!err.status || err.status >= 500) console.error(err);
          const msg = err.status && err.status < 500 ? err.message : 'Google sign-in failed. Try again.';
          return Response.redirect(`${url.origin}/app/#account&error=${encodeURIComponent(msg)}`, 302);
        }
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
        return handleMcp(request, { store, origin: url.origin, user, guardCapture: captureGuard(db, user, store, limits), capture: captureFor(env, store) });
      }
      return await privateApi(request, url, { db, user, key, limits, store, env, capture: captureFor(env, store) });
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error(err);
      return json({ error: status >= 500 ? 'Something went wrong. Please try again.' : err.message }, status);
    }
  }
};
