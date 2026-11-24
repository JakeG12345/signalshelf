// End-to-end test of the multi-user Worker under `wrangler dev` (local D1), including a real MCP client.
//   cd worker && npm test
import { spawn } from 'child_process';
import assert from 'assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8790 + Math.floor(Math.random() * 100);
const persist = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-d1-'));
const base = `http://127.0.0.1:${PORT}`;

const wr = spawn('npx', ['wrangler', 'dev', '--local', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', persist,
  '--var', 'LIMIT_ANON_PER_IP_DAY:5', '--var', 'LIMIT_ITEMS_PER_USER:4', '--show-interactive-dev-session=false'],
{ cwd: DIR, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false', NO_PROXY: '127.0.0.1,localhost' } });
let log = '';
wr.stdout.on('data', d => (log += d));
wr.stderr.on('data', d => (log += d));

let passed = 0;
const t = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ✔ ${name}`); }
  catch (e) { console.error(`  ✘ ${name}\n    ${e.stack}`); process.exitCode = 1; }
};
const j = async (p, o = {}) => {
  const r = await fetch(base + p, { ...o, headers: { 'Content-Type': 'application/json', ...(o.headers || {}) } });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body, headers: r.headers };
};
const as = key => ({ Authorization: `Bearer ${key}` });
const ip = n => ({ 'CF-Connecting-IP': `203.0.113.${n}` });

try {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(base + '/api/health')).ok) break; } catch { /* starting */ }
    await new Promise(r => setTimeout(r, 500));
    if (i === 119) throw new Error('wrangler dev did not start:\n' + log);
  }
  console.log('\nWorker (wrangler dev, local D1, multi-user)');

  let A, B;
  await t('anonymous accounts: instant, no sign-up', async () => {
    const a = await j('/api/auth/anon', { method: 'POST', headers: ip(1) });
    const b = await j('/api/auth/anon', { method: 'POST', headers: ip(2) });
    assert.equal(a.status, 201); assert.match(a.body.key, /^ss_[A-Za-z0-9]{32}$/);
    A = a.body.key; B = b.body.key;
    const h = await j('/api/health', { headers: as(A) });
    assert.equal(h.body.authed, true); assert.equal(h.body.entries, 0);
    assert.equal((await j('/api/entries')).status, 401);
    assert.equal((await j('/api/entries', { headers: as('ss_' + 'x'.repeat(32)) })).status, 401);
  });
  await t('anonymous signups are rate limited per IP', async () => {
    let last;
    for (let i = 0; i < 6; i++) last = await j('/api/auth/anon', { method: 'POST', headers: ip(9) });
    assert.equal(last.status, 429);
  });
  await t('landing page, app and assets', async () => {
    const landing = await (await fetch(base + '/')).text();
    assert.ok(landing.includes('Track what you watch') && landing.includes('/app/'));
    assert.equal((await fetch(base + '/app', { redirect: 'manual' })).status, 301);
    assert.ok((await (await fetch(base + '/app/')).text()).includes('manifest.webmanifest'));
    assert.equal((await fetch(base + '/app/icon-180.png')).headers.get('content-type'), 'image/png');
  });
  await t('users are isolated, even for the same video', async () => {
    const body = id => JSON.stringify({ id, title: 'AI agency to $30k/mo', creator: 'Liam', url: 'https://www.youtube.com/watch?v=AAAAAAAAAAA', transcript: 'we sell chatbots to dentists' });
    assert.equal((await j('/api/ingest', { method: 'POST', headers: as(A), body: body('yt_AAAAAAAAAAA') })).status, 200);
    assert.equal((await j('/api/ingest', { method: 'POST', headers: as(B), body: body('yt_AAAAAAAAAAA') })).status, 200);
    await j('/api/entries/yt_AAAAAAAAAAA', { method: 'PATCH', headers: as(A), body: JSON.stringify({ signal_rating: 5, key_takeaways: 'niche down', personal_notes: 'A-SECRET', monetization_models: ['AI Agency'] }) });
    const bView = (await j('/api/entries/yt_AAAAAAAAAAA', { headers: as(B) })).body;
    assert.equal(bView.signal_rating, null); assert.equal(bView.personal_notes, '');
    assert.equal((await j('/api/entries?q=niche', { headers: as(B) })).body.length, 0, 'B cannot search A\'s takeaways');
    assert.equal((await j('/api/entries?q=niche', { headers: as(A) })).body.length, 1);
    assert.equal((await j('/api/entries?q=dentists', { headers: as(B) })).body.length, 1);
    await j('/api/entries/yt_AAAAAAAAAAA', { method: 'DELETE', headers: as(B) });
    assert.equal((await j('/api/entries/yt_AAAAAAAAAAA', { headers: as(A) })).status, 200, 'B deleting does not touch A');
  });
  await t('re-capture keeps transcript + annotations; filters work', async () => {
    await j('/api/ingest', { method: 'POST', headers: as(A), body: JSON.stringify({ id: 'yt_AAAAAAAAAAA', title: 'AI agency to $30k/mo', transcript: '' }) });
    const e = (await j('/api/entries/yt_AAAAAAAAAAA', { headers: as(A) })).body;
    assert.match(e.transcript, /dentists/); assert.equal(e.signal_rating, 5); assert.equal(e.user_id, undefined);
    assert.equal((await j('/api/entries?model=ai%20agency', { headers: as(A) })).body.length, 1);
    assert.equal((await j('/api/entries?q=%22((', { headers: as(A) })).body.length, 0);
  });
  await t('exists check is per user; watched_at kept', async () => {
    assert.deepEqual((await j('/api/entries/exists', { method: 'POST', headers: as(A), body: JSON.stringify({ ids: ['yt_AAAAAAAAAAA', 'yt_zzzzzzzzzzz'] }) })).body.saved, ['yt_AAAAAAAAAAA']);
    assert.deepEqual((await j('/api/entries/exists', { method: 'POST', headers: as(B), body: JSON.stringify({ ids: ['yt_AAAAAAAAAAA'] }) })).body.saved, []);
    const r = await j('/api/ingest', { method: 'POST', headers: as(B), body: JSON.stringify({ id: 'pod_x', source: 'apple_podcasts', title: 'Ep', watched_at: '2026-05-06T07:08:09Z' }) });
    assert.equal(r.body.entry.watched_at, '2026-05-06T07:08:09.000Z');
  });
  await t('per-user item cap', async () => {
    for (const n of [1, 2, 3]) {
      assert.equal((await j('/api/ingest', { method: 'POST', headers: as(A), body: JSON.stringify({ id: `web_${n}`, source: 'web', title: `Link ${n}` }) })).status, 200);
    }
    const full = await j('/api/ingest', { method: 'POST', headers: as(A), body: JSON.stringify({ id: 'web_5', source: 'web', title: 'Too many' }) });
    assert.equal(full.status, 403);
    assert.equal((await j('/api/ingest', { method: 'POST', headers: as(A), body: JSON.stringify({ id: 'web_1', source: 'web', title: 'Re-save is fine' }) })).status, 200);
  });
  await t('usernames: validation, reserved, uniqueness', async () => {
    assert.equal((await j('/api/me', { method: 'PUT', headers: as(A), body: JSON.stringify({ handle: 'a' }) })).status, 400);
    assert.equal((await j('/api/me', { method: 'PUT', headers: as(A), body: JSON.stringify({ handle: 'admin' }) })).status, 400);
    assert.equal((await j('/api/me', { method: 'PUT', headers: as(A), body: JSON.stringify({ handle: '@Ryan_Builds' }) })).body.user.handle, 'ryan_builds');
    assert.equal((await j('/api/me', { method: 'PUT', headers: as(B), body: JSON.stringify({ handle: 'RYAN_BUILDS' }) })).status, 409);
  });
  await t('public profiles: everyone with a username, notes/transcripts never shown, private hides', async () => {
    const page = await (await fetch(base + '/u/ryan_builds')).text();
    assert.ok(page.includes('@ryan_builds') && page.includes('niche down') && page.includes('AI agency to $30k/mo'));
    assert.ok(!page.includes('A-SECRET') && !page.includes('dentists'));
    const data = (await j('/u/ryan_builds/shelf.json')).body;
    assert.ok(data.items.length >= 1); assert.ok(!JSON.stringify(data).includes('A-SECRET') && !JSON.stringify(data).includes('dentists'));
    assert.equal((await fetch(base + '/@ryan_builds', { redirect: 'manual' })).status, 301);
    assert.equal((await fetch(base + '/u/nobody_here')).status, 404);
    await j('/api/me', { method: 'PUT', headers: as(A), body: JSON.stringify({ is_private: true, bio: 'I build things' }) });
    assert.equal((await fetch(base + '/u/ryan_builds')).status, 404, 'private profile hidden');
    assert.ok(!(await (await fetch(base + '/people')).text()).includes('ryan_builds'), 'private profile not listed');
    await j('/api/me', { method: 'PUT', headers: as(A), body: JSON.stringify({ is_private: false }) });
    assert.ok((await (await fetch(base + '/u/ryan_builds')).text()).includes('I build things'));
  });
  await t('people page + search', async () => {
    const people = await (await fetch(base + '/people')).text();
    assert.ok(people.includes('/u/ryan_builds'));
    assert.ok((await (await fetch(base + '/people?q=ryan')).text()).includes('/u/ryan_builds'));
    assert.ok(!(await (await fetch(base + '/people?q=zzzz')).text()).includes('/u/ryan_builds'));
    assert.ok((await (await fetch(base + '/')).text()).includes('/u/ryan_builds'), 'landing lists people');
  });
  await t('follow, feed, counts; feed hides private notes', async () => {
    assert.equal((await j('/api/follow/ryan_builds', { method: 'POST', headers: as(A) })).status, 400, 'cannot follow yourself');
    assert.deepEqual((await j('/api/follow/ryan_builds', { headers: as(A) })).body, { self: true, following: false });
    const f = await j('/api/follow/ryan_builds', { method: 'POST', headers: as(B) });
    assert.equal(f.body.following, true); assert.equal(f.body.followers, 1);
    await j('/api/follow/ryan_builds', { method: 'POST', headers: as(B) }); // idempotent
    assert.equal((await j('/api/follow/ryan_builds', { headers: as(B) })).body.following, true);
    const feed = (await j('/api/feed', { headers: as(B) })).body;
    assert.ok(feed.some(i => i.id === 'yt_AAAAAAAAAAA' && i.handle === 'ryan_builds' && i.signal_rating === 5));
    assert.ok(!JSON.stringify(feed).includes('A-SECRET') && !JSON.stringify(feed).includes('dentists'));
    assert.equal((await j('/api/following', { headers: as(B) })).body[0].handle, 'ryan_builds');
    assert.ok((await (await fetch(base + '/u/ryan_builds')).text()).includes('<b id="c-followers">1</b> follower<'));
    await j('/api/me', { method: 'PUT', headers: as(A), body: JSON.stringify({ is_private: true }) });
    assert.equal((await j('/api/feed', { headers: as(B) })).body.length, 0, 'private profiles drop out of feeds');
    await j('/api/me', { method: 'PUT', headers: as(A), body: JSON.stringify({ is_private: false }) });
    assert.equal((await j('/api/follow/ryan_builds', { method: 'DELETE', headers: as(B) })).body.followers, 0);
    assert.equal((await j('/api/follow/nobody_here', { method: 'POST', headers: as(B) })).status, 404);
  });
  await t('meta gives the user their private links', async () => {
    const m = (await j('/api/meta', { headers: as(A) })).body;
    assert.equal(m.mcpUrl, `${base}/mcp/${A}`); assert.equal(m.syncUrl, `${base}/app/#k=${A}`);
    assert.equal(m.shortcutUrl, `${base}/app/#k=${A}&add=`); assert.equal(m.profileUrl, `${base}/u/ryan_builds`);
    assert.equal(m.shortcutInstallUrl, null); // empty SHORTCUT_ICLOUD_URL = manual steps only
  });

  await t('accounts: sign up, log in on another device, log out', async () => {
    assert.equal((await j('/api/account/register', { method: 'POST', headers: as(A), body: JSON.stringify({ password: 'short' }) })).status, 400);
    const reg = await j('/api/account/register', { method: 'POST', headers: as(A), body: JSON.stringify({ password: 'correct horse battery' }) });
    assert.equal(reg.status, 200); assert.equal(reg.body.user.handle, 'ryan_builds'); assert.equal(reg.body.user.has_password, true);
    assert.equal((await j('/api/auth/login', { method: 'POST', body: JSON.stringify({ handle: 'ryan_builds', password: 'wrong password' }) })).status, 401);
    assert.equal((await j('/api/auth/login', { method: 'POST', body: JSON.stringify({ handle: 'nobody_here', password: 'whatever123' }) })).status, 401);
    const li = await j('/api/auth/login', { method: 'POST', body: JSON.stringify({ handle: '@Ryan_Builds', password: 'correct horse battery' }) });
    assert.equal(li.status, 200); assert.notEqual(li.body.key, A);
    const S = li.body.key;
    const viaSession = (await j('/api/entries/yt_AAAAAAAAAAA', { headers: as(S) })).body;
    assert.equal(viaSession.personal_notes, 'A-SECRET', 'session sees the same shelf');
    assert.equal((await j('/api/meta', { headers: as(S) })).body.user.via_session, true);
    assert.equal((await j('/api/auth/logout', { method: 'POST', headers: as(S) })).body.ended_session, true);
    assert.equal((await j('/api/entries', { headers: as(S) })).status, 401, 'session ended');
    assert.equal((await j('/api/entries', { headers: as(A) })).status, 200, 'private key still works');
  });
  await t('login attempts are rate limited per username', async () => {
    let last;
    for (let i = 0; i < 11; i++) last = await j('/api/auth/login', { method: 'POST', headers: ip(40 + i), body: JSON.stringify({ handle: 'ryan_builds', password: 'nope-nope-' + i }) });
    assert.equal(last.status, 429);
  });
  await t('Supadata provider: sync, async job, limits (mocked)', async () => {
    const { supadataProvider } = await import('./src/transcripts.js');
    assert.equal(supadataProvider(''), null);
    const sync = supadataProvider('k', async url => { assert.match(url, /mode=native/); return new Response(JSON.stringify({ lang: 'en', content: 'hello  world' })); });
    assert.equal(await sync('https://www.youtube.com/watch?v=x'), 'hello world');
    let polls = 0;
    const job = supadataProvider('k', async url => url.includes('/transcript/job1')
      ? new Response(JSON.stringify(++polls < 2 ? { status: 'active' } : { status: 'completed', content: [{ text: 'a' }, { text: 'b' }] }))
      : new Response(JSON.stringify({ jobId: 'job1' }), { status: 202 }));
    assert.equal(await job('u'), 'a b');
    const limited = supadataProvider('k', async () => new Response('{}', { status: 429 }));
    await assert.rejects(limited('u'), /limit/);
  });

  console.log('\nRemote MCP (official SDK client over Streamable HTTP)');
  const { Client } = await import('../node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
  const { StreamableHTTPClientTransport } = await import('../node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js');
  const connect = async key => {
    const c = new Client({ name: 'test', version: '1' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${key}`)));
    return c;
  };
  const call = async (c, name, args = {}) => {
    const r = await c.callTool({ name, arguments: args });
    return { isError: !!r.isError, text: r.content[0].text };
  };
  await t('unknown key in MCP URL is rejected', async () => {
    assert.equal((await j('/mcp/ss_' + 'y'.repeat(32), { method: 'POST', body: '{}' })).status, 401);
  });
  const ca = await connect(A);
  const cb = await connect(B);
  await t('initialize + tools/list', async () => {
    assert.equal(ca.getServerVersion().name, 'signal-shelf');
    assert.equal((await ca.listTools()).tools.length, 8);
  });
  await t('each Claude connection only sees its own shelf', async () => {
    assert.match((await call(ca, 'search_transcripts', { query: 'niche' })).text, /yt_AAAAAAAAAAA/);
    assert.match((await call(cb, 'search_transcripts', { query: 'niche' })).text, /No matches/);
    assert.ok((await call(cb, 'get_full_transcript', { id: 'yt_AAAAAAAAAAA' })).isError);
    assert.equal(JSON.parse((await call(ca, 'get_top_rated', {})).text).length, 1);
  });
  await t('rate_and_annotate + shelf link', async () => {
    const r = JSON.parse((await call(ca, 'rate_and_annotate', { id: 'web_1', signal_rating: 4, add_takeaways: ['charge annually'], append_notes: 'from Claude' })).text);
    assert.equal(r.signal_rating, 4);
    assert.equal(JSON.parse((await call(ca, 'get_full_transcript', { id: 'web_1' })).text).personal_notes, 'from Claude');
    assert.equal(JSON.parse((await call(ca, 'get_public_shelf')).text).url, `${base}/u/ryan_builds`);
    assert.ok((await call(ca, 'save_link', { url: 'not a link' })).isError);
  });
  await ca.close(); await cb.close();

  await t('export, then delete account removes everything', async () => {
    const ex = (await j('/api/export', { headers: as(B) })).body;
    assert.ok(Array.isArray(ex.entries));
    const md = await (await fetch(base + '/api/export?format=md', { headers: as(A) })).text();
    assert.ok(md.includes('# AI agency to $30k/mo') && md.includes('## Transcript') && md.includes('dentists'));
    assert.equal((await j('/api/me', { method: 'DELETE', headers: as(B) })).status, 200);
    assert.equal((await j('/api/entries', { headers: as(B) })).status, 401);
    assert.equal((await j('/api/entries', { headers: as(A) })).status, 200, 'A unaffected');
  });

  await t('Google sign-in is hidden when not configured', async () => {
    assert.equal((await j('/api/meta', { headers: as(A) })).body.googleSignIn, false);
    assert.equal((await j('/api/auth/google/start', { method: 'POST' })).status, 404);
  });

  // ---------- Google sign-in, against a local mock of Google's token endpoint ----------
  const mock = http.createServer((req, res) => {
    let body = ''; req.on('data', d => (body += d)).on('end', () => {
      const p = new URLSearchParams(body);
      if (p.get('client_secret') !== 'test-secret' || p.get('grant_type') !== 'authorization_code' || !p.get('redirect_uri').endsWith('/auth/google/callback')) {
        res.writeHead(400); return res.end('{"error":"invalid_client"}');
      }
      const claims = { iss: 'https://accounts.google.com', aud: 'test-client', email_verified: true, exp: Math.floor(Date.now() / 1000) + 3600,
        ...JSON.parse(Buffer.from(p.get('code'), 'base64url').toString()) };
      const enc = o => Buffer.from(JSON.stringify(o)).toString('base64url');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id_token: `${enc({ alg: 'RS256' })}.${enc(claims)}.sig`, access_token: 'x' }));
    });
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const GPORT = PORT + 200;
  const gbase = `http://127.0.0.1:${GPORT}`;
  const gpersist = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-d1g-'));
  const wg = spawn('npx', ['wrangler', 'dev', '--local', '--port', String(GPORT), '--ip', '127.0.0.1', '--persist-to', gpersist,
    '--var', 'GOOGLE_CLIENT_ID:test-client', '--var', 'GOOGLE_CLIENT_SECRET:test-secret',
    '--var', `GOOGLE_TOKEN_URL:http://127.0.0.1:${mock.address().port}/token`, '--show-interactive-dev-session=false'],
  { cwd: DIR, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false', NO_PROXY: '127.0.0.1,localhost' } });
  let glog = ''; wg.stdout.on('data', d => (glog += d)); wg.stderr.on('data', d => (glog += d));
  try {
    for (let i = 0; i < 120; i++) {
      try { if ((await fetch(gbase + '/api/health')).ok) break; } catch { /* starting */ }
      await new Promise(r => setTimeout(r, 500));
      if (i === 119) throw new Error('second wrangler dev did not start:\n' + glog);
    }
    const g = async (p, o = {}) => {
      const r = await fetch(gbase + p, { ...o, headers: { 'Content-Type': 'application/json', ...(o.headers || {}) } });
      return { status: r.status, body: await r.json() };
    };
    const startFlow = async key => {
      const r = await g('/api/auth/google/start', { method: 'POST', headers: { ...(key ? as(key) : {}), ...ip(50) } });
      assert.equal(r.status, 200);
      const u = new URL(r.body.url);
      assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
      assert.equal(u.searchParams.get('scope'), 'openid email profile');
      assert.equal(u.searchParams.get('redirect_uri'), `${gbase}/auth/google/callback`);
      assert.equal(u.searchParams.get('client_id'), 'test-client');
      return u.searchParams.get('state');
    };
    const callback = async (state, claims) => {
      const code = Buffer.from(JSON.stringify(claims)).toString('base64url');
      const r = await fetch(`${gbase}/auth/google/callback?state=${encodeURIComponent(state)}&code=${code}`, { redirect: 'manual' });
      assert.equal(r.status, 302);
      const loc = new URL(r.headers.get('location'));
      assert.equal(loc.pathname, '/app/');
      return new URLSearchParams(loc.hash.slice(1));
    };
    const me = async key => (await g('/api/meta', { headers: as(key) })).body;

    await t('Google: meta flag on when configured', async () => {
      const guest = (await g('/api/auth/anon', { method: 'POST', headers: ip(51) })).body.key;
      assert.equal((await me(guest)).googleSignIn, true);
    });
    let newKey;
    await t('Google: new user gets an account with an auto username', async () => {
      const h = await callback(await startFlow(null), { sub: 'g-1', email: 'ada.l@example.com', name: 'Ada Lovelace' });
      assert.equal(h.get('google'), 'new');
      newKey = h.get('k');
      const m = await me(newKey);
      assert.equal(m.user.handle, 'adalovelace'); assert.equal(m.user.display_name, 'Ada Lovelace');
      assert.equal(m.user.has_password, true); assert.equal(m.user.has_google, true);
    });
    await t('Google: a guest shelf becomes the account, items kept', async () => {
      const guest = (await g('/api/auth/anon', { method: 'POST', headers: ip(52) })).body.key;
      await g('/api/ingest', { method: 'POST', headers: as(guest), body: JSON.stringify({ id: 'web_g', title: 'Guest item', url: 'https://example.com/g' }) });
      const h = await callback(await startFlow(guest), { sub: 'g-2', email: 'ada@example.com', name: 'Ada Lovelace' });
      assert.equal(h.get('google'), 'upgrade');
      const m = await me(h.get('k'));
      assert.equal(m.user.handle, 'ada', 'taken name falls back to the email');
      assert.equal(m.stats.total, 1);
      assert.equal((await me(guest)).user.id, m.user.id, 'same shelf');
      const ch = await g('/api/me', { method: 'PUT', headers: as(h.get('k')), body: JSON.stringify({ handle: 'ada_l' }) });
      assert.equal(ch.body.user.handle, 'ada_l', 'Google users can change their username');
    });
    await t('Google: returning login opens the same account, not the guest', async () => {
      const guest = (await g('/api/auth/anon', { method: 'POST', headers: ip(53) })).body.key;
      const h = await callback(await startFlow(guest), { sub: 'g-1', email: 'ada.l@example.com', name: 'Ada Lovelace' });
      assert.equal(h.get('google'), 'login');
      assert.equal((await me(h.get('k'))).user.handle, 'adalovelace');
      assert.equal((await me(guest)).user.has_google, false, 'guest untouched');
    });
    await t('Google: bad, reused and unverified states are rejected', async () => {
      let h = await callback('nope', { sub: 'g-9', email: 'x@example.com' });
      assert.ok(h.has('account') && /expired/.test(h.get('error')));
      const st = await startFlow(null);
      await callback(st, { sub: 'g-3', email: 'b@example.com', name: 'Bo' });
      h = await callback(st, { sub: 'g-4', email: 'c@example.com' });
      assert.ok(/expired/.test(h.get('error')), 'state is single use');
      h = await callback(await startFlow(null), { sub: 'g-5', email: 'd@example.com', email_verified: false });
      assert.ok(/Verify/.test(h.get('error')));
      h = await callback(await startFlow(null), { sub: 'g-6', email: 'e@example.com', aud: 'someone-else' });
      assert.ok(h.has('error') && !h.has('k'));
      const bo = await callback(await startFlow(null), { sub: 'g-3', email: 'b@example.com', name: 'Bo' });
      assert.match((await me(bo.get('k'))).user.handle, /^user\d{4}$/, 'names too short fall back to a valid handle');
    });
  } finally {
    wg.kill('SIGINT'); setTimeout(() => wg.kill('SIGKILL'), 2000);
    mock.close();
    fs.rmSync(gpersist, { recursive: true, force: true });
  }
} finally {
  wr.kill('SIGINT');
  setTimeout(() => wr.kill('SIGKILL'), 2000);
  fs.rmSync(persist, { recursive: true, force: true });
  console.log(`\n${process.exitCode ? '✘ FAILED' : '✔ all'} ${passed} worker checks passed\n`);
  setTimeout(() => process.exit(process.exitCode || 0), 2500);
}
