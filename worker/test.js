// End-to-end test of the Worker under `wrangler dev` (local D1), including a real MCP client.
//   cd worker && npm test
import { spawn } from 'child_process';
import assert from 'assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8790 + Math.floor(Math.random() * 100);
const TOKEN = 'test-token-0123456789abcdef';
const persist = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-d1-'));
const base = `http://127.0.0.1:${PORT}`;

const wr = spawn('npx', ['wrangler', 'dev', '--local', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', persist,
  '--var', `APP_TOKEN:${TOKEN}`, '--show-interactive-dev-session=false'], { cwd: DIR, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false', NO_PROXY: '127.0.0.1,localhost' } });
let log = '';
wr.stdout.on('data', d => (log += d));
wr.stderr.on('data', d => (log += d));

let passed = 0;
const t = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ✔ ${name}`); }
  catch (e) { console.error(`  ✘ ${name}\n    ${e.stack}`); process.exitCode = 1; }
};
const auth = { Authorization: `Bearer ${TOKEN}` };
const j = async (p, o = {}) => {
  const r = await fetch(base + p, { ...o, headers: { 'Content-Type': 'application/json', ...(o.headers || {}) } });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body, headers: r.headers };
};

try {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(base + '/api/health')).ok) break; } catch { /* starting */ }
    await new Promise(r => setTimeout(r, 500));
    if (i === 119) throw new Error('wrangler dev did not start:\n' + log);
  }
  console.log('\nWorker (wrangler dev, local D1)');

  await t('health is public, data is not', async () => {
    const h = await j('/api/health');
    assert.equal(h.body.mode, 'cloud'); assert.equal(h.body.configured, true); assert.equal(h.body.entries, undefined);
    assert.equal((await j('/api/entries')).status, 401);
    assert.equal((await j('/api/entries', { headers: { Authorization: 'Bearer wrong-token-xxxxxxxx' } })).status, 401);
    assert.equal((await j('/api/health', { headers: auth })).body.entries, 0);
  });
  await t('app + PWA assets served under /app/', async () => {
    const r = await fetch(base + '/app', { redirect: 'manual' });
    assert.equal(r.status, 301);
    const html = await (await fetch(base + '/app/')).text();
    assert.ok(html.includes('manifest.webmanifest') && html.includes('Signal <span>Shelf</span>'));
    assert.equal((await fetch(base + '/app/manifest.webmanifest')).status, 200);
    assert.equal((await fetch(base + '/app/icon-180.png')).headers.get('content-type'), 'image/png');
  });
  await t('unpublished shelf shows landing page, json 404', async () => {
    assert.match(await (await fetch(base + '/')).text(), /isn't published yet/);
    assert.equal((await j('/shelf.json')).status, 404);
  });
  await t('ingest, edit, search, filters', async () => {
    const r = await j('/api/ingest', { method: 'POST', headers: auth, body: JSON.stringify({ id: 'yt_AAAAAAAAAAA', title: 'AI agency to $30k/mo', creator: 'Liam', url: 'https://www.youtube.com/watch?v=AAAAAAAAAAA', transcript: 'we sell chatbots to dentists', duration_sec: 1200 }) });
    assert.equal(r.status, 200); assert.equal(r.body.entry.transcript_chars, 28);
    await j('/api/ingest', { method: 'POST', headers: auth, body: JSON.stringify({ id: 'web_x', source: 'web', title: 'Micro-SaaS pricing', transcript: '' }) });
    const p = await j('/api/entries/yt_AAAAAAAAAAA', { method: 'PATCH', headers: auth, body: JSON.stringify({ signal_rating: 5, monetization_models: ['ai agency'], key_takeaways: '- niche down\n- retainers', personal_notes: 'SECRET' }) });
    assert.equal(p.body.entry.signal_rating, 5); assert.deepEqual(p.body.entry.monetization_models, ['AI Agency']);
    // re-capture with empty transcript must keep everything
    await j('/api/ingest', { method: 'POST', headers: auth, body: JSON.stringify({ id: 'yt_AAAAAAAAAAA', title: 'AI agency to $30k/mo', transcript: '' }) });
    const e = (await j('/api/entries/yt_AAAAAAAAAAA', { headers: auth })).body;
    assert.match(e.transcript, /dentists/); assert.equal(e.signal_rating, 5); assert.equal(e.personal_notes, 'SECRET');
    assert.equal((await j('/api/entries?q=dentist', { headers: auth })).body.length, 1);
    assert.equal((await j('/api/entries?q=retainers', { headers: auth })).body.length, 1);
    assert.equal((await j('/api/entries?q=%22((', { headers: auth })).body.length, 0);
    assert.equal((await j('/api/entries?model=AI%20AGENCY', { headers: auth })).body.length, 1);
    assert.equal((await j('/api/entries?sort=rating', { headers: auth })).body[0].id, 'yt_AAAAAAAAAAA');
    assert.equal((await j('/api/entries/yt_AAAAAAAAAAA', { method: 'PATCH', headers: auth, body: JSON.stringify({ signal_rating: 9 }) })).status, 400);
    assert.equal((await j('/api/ingest-url', { method: 'POST', headers: auth, body: JSON.stringify({ url: 'not a link' }) })).status, 400);
  });
  await t('meta exposes Claude + shortcut URLs to the owner', async () => {
    const m = (await j('/api/meta', { headers: auth })).body;
    assert.equal(m.mcpUrl, `${base}/mcp/${TOKEN}`); assert.equal(m.shortcutUrl, `${base}/app/#add=`);
    assert.equal(m.capabilities.podcastsSync, false); assert.equal(m.stats.total, 2);
  });
  await t('publish → live public shelf without private data', async () => {
    const r = await j('/api/shelf/publish', { method: 'POST', headers: auth, body: JSON.stringify({ title: "Ryan's Shelf", minRating: 4 }) });
    assert.equal(r.body.count, 1); assert.equal(r.body.url, `${base}/`);
    const html = await (await fetch(base + '/')).text();
    assert.ok(html.includes('Ryan&#39;s Shelf') && html.includes('niche down'));
    assert.ok(!html.includes('SECRET') && !html.includes('dentists'));
    const data = (await j('/shelf.json')).body;
    assert.equal(data.count, 1); assert.ok(!JSON.stringify(data).includes('SECRET'));
  });
  await t('export / import round trip', async () => {
    const ex = (await j('/api/export', { headers: auth })).body;
    assert.equal(ex.entries.length, 2);
    const imp = await j('/api/import', { method: 'POST', headers: auth, body: JSON.stringify({ entries: [{ ...ex.entries[0], id: 'yt_BBBBBBBBBBB' }] }) });
    assert.equal(imp.body.imported, 1);
    const b = (await j('/api/entries/yt_BBBBBBBBBBB', { headers: auth })).body;
    assert.equal(b.signal_rating, 5); assert.equal(b.personal_notes, 'SECRET');
    assert.equal((await j('/api/entries/yt_BBBBBBBBBBB', { method: 'DELETE', headers: auth })).status, 200);
  });

  console.log('\nRemote MCP (official SDK client over Streamable HTTP)');
  const { Client } = await import('../node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
  const { StreamableHTTPClientTransport } = await import('../node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js');
  await t('wrong token in MCP URL is rejected', async () => {
    assert.equal((await j('/mcp/nope', { method: 'POST', body: '{}' })).status, 401);
  });
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${TOKEN}`)));
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { isError: !!r.isError, text: r.content[0].text };
  };
  await t('initialize + tools/list', async () => {
    assert.equal(client.getServerVersion().name, 'signal-shelf');
    const { tools } = await client.listTools();
    assert.equal(tools.length, 8);
  });
  await t('search / list / top rated / models', async () => {
    assert.match((await call('search_transcripts', { query: 'chatbots' })).text, /yt_AAAAAAAAAAA/);
    assert.match((await call('search_transcripts', { query: '((' })).text, /No matches/);
    assert.equal(JSON.parse((await call('get_top_rated', {})).text).length, 1);
    assert.equal(JSON.parse((await call('list_watched_media', { sort: 'rating' })).text)[0].signal_rating, 5);
    assert.ok(JSON.parse((await call('list_by_monetization_model', {})).text).in_use.length === 1);
  });
  await t('rate_and_annotate + get_full_transcript + shelf', async () => {
    const r = JSON.parse((await call('rate_and_annotate', { id: 'web_x', signal_rating: 4, monetization_models: ['Micro-SaaS'], add_takeaways: ['charge annually'], append_notes: 'from Claude' })).text);
    assert.equal(r.signal_rating, 4); assert.deepEqual(r.key_takeaways, ['charge annually']);
    assert.equal(JSON.parse((await call('get_full_transcript', { id: 'web_x' })).text).personal_notes, 'from Claude');
    assert.equal(JSON.parse((await call('get_public_shelf')).text).published, true);
  });
  await t('tool errors are isError, not protocol failures', async () => {
    assert.ok((await call('get_full_transcript', { id: 'missing' })).isError);
    assert.ok((await call('rate_and_annotate', { id: 'web_x' })).isError);
    assert.ok((await call('rate_and_annotate', { id: 'web_x', signal_rating: 9 })).isError);
    assert.ok((await call('save_link', { url: 'not a link' })).isError);
  });
  await client.close();
} finally {
  wr.kill('SIGINT');
  setTimeout(() => wr.kill('SIGKILL'), 2000);
  fs.rmSync(persist, { recursive: true, force: true });
  console.log(`\n${process.exitCode ? '✘ FAILED' : '✔ all'} ${passed} worker checks passed\n`);
  setTimeout(() => process.exit(process.exitCode || 0), 2500);
}
