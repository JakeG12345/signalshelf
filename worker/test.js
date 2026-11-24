// End-to-end test of the multi-user Worker under `wrangler dev` (local D1), including a real MCP client.
//   cd worker && npm test
import { spawn } from 'child_process';
import assert from 'assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

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
    assert.ok(landing.includes('Shelve the ones') && landing.includes('/app/'));
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
  await t('publish needs a username; public shelf hides private data', async () => {
    assert.equal((await j('/api/shelf/publish', { method: 'POST', headers: as(B), body: '{}' })).status, 400);
    assert.equal((await fetch(base + '/u/ryan_builds')).status, 404, 'not public before publishing');
    const r = await j('/api/shelf/publish', { method: 'POST', headers: as(A), body: JSON.stringify({ minRating: 4 }) });
    assert.equal(r.body.url, `${base}/u/ryan_builds`); assert.equal(r.body.count, 1);
    const page = await (await fetch(base + '/u/ryan_builds')).text();
    assert.ok(page.includes('@ryan_builds&#39;s Signal Shelf') && page.includes('niche down') && page.includes('Make your own Signal Shelf'));
    assert.ok(!page.includes('A-SECRET') && !page.includes('dentists'));
    const data = (await j('/u/ryan_builds/shelf.json')).body;
    assert.equal(data.count, 1); assert.ok(!JSON.stringify(data).includes('A-SECRET'));
    assert.equal((await fetch(base + '/@ryan_builds', { redirect: 'manual' })).status, 301);
    assert.ok((await (await fetch(base + '/')).text()).includes('/u/ryan_builds'), 'landing lists fresh shelves');
  });
  await t('meta gives the user their private links', async () => {
    const m = (await j('/api/meta', { headers: as(A) })).body;
    assert.equal(m.mcpUrl, `${base}/mcp/${A}`); assert.equal(m.syncUrl, `${base}/app/#k=${A}`);
    assert.equal(m.shortcutUrl, `${base}/app/#k=${A}&add=`); assert.equal(m.shelfUrl, `${base}/u/ryan_builds`);
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
    assert.equal((await j('/api/me', { method: 'DELETE', headers: as(B) })).status, 200);
    assert.equal((await j('/api/entries', { headers: as(B) })).status, 401);
    assert.equal((await j('/api/entries', { headers: as(A) })).status, 200, 'A unaffected');
  });
} finally {
  wr.kill('SIGINT');
  setTimeout(() => wr.kill('SIGKILL'), 2000);
  fs.rmSync(persist, { recursive: true, force: true });
  console.log(`\n${process.exitCode ? '✘ FAILED' : '✔ all'} ${passed} worker checks passed\n`);
  setTimeout(() => process.exit(process.exitCode || 0), 2500);
}
