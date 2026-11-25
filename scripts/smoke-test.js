#!/usr/bin/env node
// End-to-end smoke test against a throwaway database. Never touches server/knowledge.db.
//   npm test
import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'assert/strict';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-test-'));
const DB = path.join(TMP, 'test.db');
const SHELF = path.join(TMP, 'shelf');
const PORT = 3900 + Math.floor(Math.random() * 90);
const env = { ...process.env, KT_DB_PATH: DB, KT_SHELF_DIR: SHELF, PORT: String(PORT) };
let passed = 0;
const t = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ✔ ${name}`); }
  catch (e) { console.error(`  ✘ ${name}\n    ${e.stack}`); process.exitCode = 1; }
};

// 1) Seed a v1-schema database (like the original project) to prove migration keeps data.
const v1 = new Database(DB);
v1.exec(`CREATE TABLE entries (id TEXT PRIMARY KEY, source TEXT NOT NULL, title TEXT NOT NULL, creator TEXT, url TEXT,
  published_at TEXT, watched_at TEXT DEFAULT CURRENT_TIMESTAMP, duration_sec INTEGER, tags TEXT DEFAULT '[]', transcript TEXT, notes TEXT);
  CREATE VIRTUAL TABLE entries_fts USING fts5(id UNINDEXED, title, creator, transcript, notes);
  INSERT INTO entries (id, source, title, creator, url, transcript, notes) VALUES
   ('yt_AAAAAAAAAAA','youtube','How I built an AI agency to $10k/mo','Agency Guy','https://www.youtube.com/watch?v=AAAAAAAAAAA','we sell chatbot automation to dentists','old note'),
   ('pod_1','apple_podcasts','Micro SaaS pricing deep dive','Indie Pod','', 'episode description about pricing', NULL);`);
v1.close();

console.log('\nUnit');
process.env.KT_DB_PATH = DB; process.env.KT_SHELF_DIR = SHELF;
const dbm = await import('../server/db.js');
const yt = await import('../shared/youtube.js');
const shelf = await import('../server/shelf.js');
const cap = await import('../shared/capture.js');

await t('migration v1→v2 keeps rows and moves notes', () => {
  assert.equal(dbm.db.pragma('user_version', { simple: true }), 3);
  const e = dbm.getEntryById('yt_AAAAAAAAAAA');
  assert.equal(e.personal_notes, 'old note');
  assert.equal(e.transcript_status, 'ok');
  assert.deepEqual(e.monetization_models, []);
  assert.equal(dbm.getEntryById('pod_1').transcript_status, 'description');
});
await t('FTS search survives punctuation / operators', () => {
  for (const q of ['AND', '"', 'a:b', '-', '(', 'NEAR(', '$10k/mo', '***']) dbm.queryEntries({ q });
  assert.equal(dbm.queryEntries({ q: 'dentist' }).length, 1); // prefix match
});
await t('re-capture with empty transcript keeps transcript + annotations', () => {
  dbm.updateEntry('yt_AAAAAAAAAAA', { signal_rating: 5, monetization_models: ['ai agency', 'Consulting'], key_takeaways: '- niche down\n2. sell retainers' });
  dbm.upsertEntry({ id: 'yt_AAAAAAAAAAA', title: 'How I built an AI agency to $10k/mo', transcript: '' });
  const e = dbm.getEntryById('yt_AAAAAAAAAAA');
  assert.match(e.transcript, /dentists/);
  assert.equal(e.signal_rating, 5);
  assert.deepEqual(e.monetization_models, ['AI Agency', 'Consulting']);
  assert.deepEqual(e.key_takeaways, ['niche down', 'sell retainers']);
  assert.equal(dbm.queryEntries({ q: 'dentists' }).length, 1);
  assert.equal(dbm.queryEntries({ q: 'retainers' }).length, 1, 'takeaways are searchable');
});
await t('filters: rating, model, sort', () => {
  assert.equal(dbm.queryEntries({ minRating: 4 }).length, 1);
  assert.equal(dbm.queryEntries({ model: 'AI AGENCY' }).length, 1);
  assert.equal(dbm.queryEntries({ sort: 'rating' })[0].id, 'yt_AAAAAAAAAAA');
});
await t('validation errors', () => {
  assert.throws(() => dbm.updateEntry('yt_AAAAAAAAAAA', { signal_rating: 7 }), /1-5/);
  assert.throws(() => dbm.updateEntry('nope', { signal_rating: 3 }), /No entry/);
  assert.throws(() => dbm.upsertEntry({ id: 'bad id!', title: 'x' }), /invalid/);
});
await t('parseVideoId handles all URL shapes', () => {
  const id = 'dQw4w9WgXcQ';
  for (const u of [id, `https://www.youtube.com/watch?v=${id}&t=10s`, `youtu.be/${id}?si=x`, `https://m.youtube.com/watch?feature=share&v=${id}`,
    `https://www.youtube.com/shorts/${id}`, `https://www.youtube.com/embed/${id}`, `https://www.youtube.com/live/${id}?x=1`]) assert.equal(yt.parseVideoId(u), id, u);
  assert.equal(yt.parseVideoId('https://example.com/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(yt.parseVideoId('hello'), null);
});
await t('extractJsonObject handles "};" inside strings', () => {
  const html = `<script>var ytInitialPlayerResponse = {"a":"tricky }; value","b":{"c":[1,2]}};var x=1;</script>`;
  assert.deepEqual(yt.extractJsonObject(html, 'ytInitialPlayerResponse'), { a: 'tricky }; value', b: { c: [1, 2] } });
});
await t('caption parsing: json3, srv1, srv3, entities', () => {
  assert.equal(yt.parseCaptionBody('{"events":[{"segs":[{"utf8":"hello "},{"utf8":"world"}]},{"segs":[{"utf8":"\\n again"}]}]}'), 'hello world again');
  assert.equal(yt.parseCaptionBody('<transcript><text start="0">it&amp;#39;s &amp;amp; ok</text><text>next</text></transcript>'), "it's & ok next");
  assert.equal(yt.parseCaptionBody('<timedtext><body><p t="0"><s>one</s><s> two</s></p></body></timedtext>'), 'one two');
  assert.equal(yt.pickCaptionTrack([{ languageCode: 'de' }, { languageCode: 'en', kind: 'asr' }, { languageCode: 'en-GB' }]).languageCode, 'en-GB');
});
await t('fetchYouTubeVideo with mocked YouTube (captions + empty-captions fallback)', async () => {
  const player = { playabilityStatus: { status: 'OK' }, videoDetails: { videoId: 'BBBBBBBBBBB', title: 'Faceless YT in 2026', author: 'Faceless Fred', lengthSeconds: '600' },
    microformat: { playerMicroformatRenderer: { publishDate: '2026-10-01' } },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: 'https://www.youtube.com/api/timedtext?v=B&lang=en', languageCode: 'en' }] } } };
  const mk = captionBody => async url => {
    const body = url.includes('/watch') ? `x ytInitialPlayerResponse = ${JSON.stringify(player)};</script>` : url.includes('timedtext') ? captionBody : '{}';
    return { ok: true, status: 200, text: async () => body };
  };
  const a = await yt.fetchYouTubeVideo('https://youtu.be/BBBBBBBBBBB', { fetchImpl: mk('{"events":[{"segs":[{"utf8":"post three shorts a day"}]}]}') });
  assert.equal(a.title, 'Faceless YT in 2026'); assert.equal(a.transcript, 'post three shorts a day'); assert.equal(a.transcript_status, 'ok');
  const b = await yt.fetchYouTubeVideo('BBBBBBBBBBB', { fetchImpl: mk('') });
  assert.equal(b.transcript_status, 'missing'); assert.ok(b.warnings.some(w => /extension/.test(w)));
});
await t('capture: shared-text URL extraction', () => {
  assert.equal(cap.extractUrl('Watch this! https://youtu.be/dQw4w9WgXcQ?si=abc.'), 'https://youtu.be/dQw4w9WgXcQ?si=abc');
  assert.equal(cap.extractUrl('nope'), null);
  assert.deepEqual(cap.parseApplePodcastUrl('https://podcasts.apple.com/au/podcast/my-first-million/id1469759170?i=1000650000000'), { podcastId: '1469759170', episodeId: '1000650000000' });
});
await t('capture: Apple Podcasts episode via iTunes lookup', async () => {
  const fetchImpl = async url => ({ ok: true, status: 200, text: async () => JSON.stringify({ results: [
    { kind: 'podcast', collectionName: 'MFM' },
    { kind: 'podcast-episode', trackId: 1000650000000, trackName: 'Boring businesses', collectionName: 'My First Million', trackTimeMillis: 3600000,
      releaseDate: '2026-11-01T00:00:00Z', artworkUrl600: 'https://is1-ssl.mzstatic.com/a.jpg', description: 'Shaan and Sam on laundromats', trackViewUrl: 'https://podcasts.apple.com/x' }] }) });
  const r = await cap.captureLink('https://podcasts.apple.com/au/podcast/x/id1469759170?i=1000650000000', { fetchImpl });
  assert.equal(r.id, 'pod_apple_1000650000000'); assert.equal(r.source, 'apple_podcasts'); assert.equal(r.duration_sec, 3600);
  assert.equal(r.transcript_status, 'description'); assert.match(r.transcript, /laundromats/);
});
await t('capture: generic page (Spotify/article) via Open Graph', async () => {
  const html = `<html><head><title>fallback</title><meta property="og:title" content="Episode 12 &amp; pricing"><meta content="Spotify" property="og:site_name"><meta property="og:description" content="How to price an AI agency"><meta property="og:image" content="https://i.scdn.co/x.jpg"></head></html>`;
  const r = await cap.captureLink('https://open.spotify.com/episode/abc', { fetchImpl: async () => ({ ok: true, status: 200, text: async () => html }) });
  assert.equal(r.source, 'web'); assert.equal(r.title, 'Episode 12 & pricing'); assert.equal(r.creator, 'Spotify');
  assert.match(r.id, /^web_[0-9a-f]{20}$/); assert.equal(r.thumbnail, 'https://i.scdn.co/x.jpg');
});
await t('YouTube: innertube transcript fallback when caption files are empty', async () => {
  const player = { playabilityStatus: { status: 'OK' }, videoDetails: { videoId: 'EEEEEEEEEEE', title: 'Agency pricing', author: 'X', lengthSeconds: '60' },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: 'https://www.youtube.com/api/timedtext?v=E', languageCode: 'en' }] } } };
  const initial = { engagementPanels: [{ engagementPanelSectionListRenderer: { content: { continuationItemRenderer: { continuationEndpoint: { getTranscriptEndpoint: { params: 'P4R4MS' } } } } } }] };
  const transcriptJson = { actions: [{ updateEngagementPanelAction: { content: { transcriptRenderer: { content: { transcriptSearchPanelRenderer: { body: { transcriptSegmentListRenderer: { initialSegments: [
    { transcriptSegmentRenderer: { snippet: { runs: [{ text: 'charge a' }] } } }, { transcriptSegmentRenderer: { snippet: { runs: [{ text: 'setup fee' }] } } }] } } } } } } } }] };
  let sentParams = null;
  const fetchImpl = async (url, opts = {}) => {
    if (url.includes('get_transcript')) { sentParams = JSON.parse(opts.body).params; return { ok: true, status: 200, text: async () => JSON.stringify(transcriptJson) }; }
    const body = url.includes('/watch') ? `ytcfg.set({"INNERTUBE_CLIENT_VERSION":"2.20260101.00.00"}); var ytInitialPlayerResponse = ${JSON.stringify(player)}; var ytInitialData = ${JSON.stringify(initial)};` : '';
    return { ok: true, status: 200, text: async () => body };
  };
  const r = await yt.fetchYouTubeVideo('EEEEEEEEEEE', { fetchImpl });
  assert.equal(sentParams, 'P4R4MS'); assert.equal(r.transcript, 'charge a setup fee'); assert.equal(r.transcript_status, 'ok');
});
await t('YouTube: transcript provider first; skipped when already saved', async () => {
  const player = { playabilityStatus: { status: 'OK' }, videoDetails: { videoId: 'FFFFFFFFFFF', title: 'T', author: 'A', lengthSeconds: '60' } };
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => `ytInitialPlayerResponse = ${JSON.stringify(player)};` });
  let calls = 0;
  const provider = async () => { calls++; return 'from provider'; };
  const r = await yt.fetchYouTubeVideo('FFFFFFFFFFF', { fetchImpl, transcriptProvider: provider });
  assert.equal(r.transcript, 'from provider'); assert.equal(r.transcript_status, 'ok');
  const s = await yt.fetchYouTubeVideo('FFFFFFFFFFF', { fetchImpl, transcriptProvider: provider, skipTranscript: true });
  assert.equal(calls, 1); assert.equal(s.transcript, '');
  const c = await cap.captureLink('https://youtu.be/FFFFFFFFFFF', { fetchImpl, transcriptProvider: provider, hasTranscript: async id => id === 'yt_FFFFFFFFFFF' });
  assert.equal(calls, 1, 'hasTranscript skips the provider'); assert.equal(c.title, 'T');
});
await t('import: Takeout JSON (ads and removed videos skipped, newest first, de-duplicated)', async () => {
  const imp = await import('../server/public/importers.js');
  const json = JSON.stringify([
    { header: 'YouTube', title: 'Watched How to price an agency', titleUrl: 'https://www.youtube.com/watch?v=AAAAAAAAAAA', subtitles: [{ name: 'Liam' }], time: '2026-11-20T10:00:00.000Z' },
    { header: 'YouTube', title: 'Watched Some ad', titleUrl: 'https://www.youtube.com/watch?v=BBBBBBBBBBB', time: '2026-11-21T10:00:00Z', details: [{ name: 'From Google Ads' }] },
    { header: 'YouTube', title: 'Watched a video that has been removed', time: '2026-11-22T10:00:00Z' },
    { header: 'YouTube', title: 'Watched How to price an agency', titleUrl: 'https://www.youtube.com/watch?v=AAAAAAAAAAA', time: '2026-11-23T10:00:00Z' },
    { header: 'YouTube Music', title: 'Watched Song', titleUrl: 'https://www.youtube.com/watch?v=CCCCCCCCCCC', time: '2026-11-19T10:00:00Z' }
  ]);
  const r = imp.parseTakeout(json, 'watch-history.json');
  assert.deepEqual(r.map(i => i.key), ['yt_AAAAAAAAAAA', 'yt_CCCCCCCCCCC']);
  assert.equal(r[0].watched_at, '2026-11-23T10:00:00.000Z'); assert.equal(r[0].title, 'How to price an agency');
});
await t('import: Takeout HTML (default format) incl. locale dates Safari cannot parse', async () => {
  const imp = await import('../server/public/importers.js');
  const cell = (id, title, ch, when, ad = false) => `<div class="outer-cell mdl-cell mdl-cell--12-col mdl-shadow--2dp"><div class="mdl-grid"><div class="header-cell mdl-cell mdl-cell--12-col"><p class="mdl-typography--title">YouTube<br></p></div><div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">Watched&nbsp;<a href="https://www.youtube.com/watch?v=${id}">${title}</a><br><a href="https://www.youtube.com/channel/UCx">${ch}</a><br>${when}<br></div><div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1 mdl-typography--text-right"></div><div class="content-cell mdl-cell mdl-cell--12-col mdl-typography--caption"><b>Products:</b><br>&emsp;YouTube<br>${ad ? '<b>Details:</b><br>&emsp;From Google Ads<br>' : ''}</div></div></div>`;
  const html = '<html><body><div class="mdl-grid">' + cell('DDDDDDDDDDD', 'Cold email &amp; pricing', 'Alex', '24 Nov 2026, 22:01:22 AEDT') +
    cell('EEEEEEEEEEE', 'An ad', 'Brand', 'Nov 24, 2026, 9:00:00 PM EST', true) + cell('FFFFFFFFFFF', 'Shorts &#39;n stuff', 'Sam', 'Nov 23, 2026, 10:05:00 PM EST') + '</div></body></html>';
  const r = imp.parseTakeout(html, 'watch-history.html');
  assert.deepEqual(r.map(i => i.key), ['yt_DDDDDDDDDDD', 'yt_FFFFFFFFFFF']);
  assert.equal(r[0].title, 'Cold email & pricing'); assert.equal(r[0].creator, 'Alex'); assert.equal(r[1].title, "Shorts 'n stuff");
  const d = new Date(r[0].watched_at);
  assert.equal(d.getFullYear(), 2026); assert.equal(d.getMonth(), 10); assert.equal(d.getDate(), 24); assert.equal(d.getHours(), 22);
  assert.equal(new Date(imp.parseLooseDate('Nov 23, 2026, 10:05:00 PM EST')).getHours(), 22);
  assert.equal(new Date(imp.parseLooseDate('Nov 23, 2026, 12:05:00 AM EST')).getHours(), 0);
  assert.throws(() => imp.parseTakeout('<html>nope</html>', 'x.html'), /watch-history/);
});
await t('import: YouTube history page parser (app + extension copies agree)', async () => {
  const imp = await import('../server/public/importers.js');
  const data = { contents: { sections: [
    { itemSectionRenderer: { contents: [{ videoRenderer: { videoId: 'GGGGGGGGGGG', title: { runs: [{ text: 'Old layout video' }] }, ownerText: { runs: [{ text: 'Chan A' }] }, lengthText: { simpleText: '12:01' } } }] } },
    { lockupViewModel: { contentId: 'HHHHHHHHHHH', contentType: 'LOCKUP_CONTENT_TYPE_VIDEO', metadata: { lockupMetadataViewModel: { title: { content: 'New layout video' }, metadata: { contentMetadataViewModel: { metadataRows: [{ metadataParts: [{ text: { content: 'Chan B' } }] }] } } } } } },
    { lockupViewModel: { contentId: 'PLxxxxxxxxx', contentType: 'LOCKUP_CONTENT_TYPE_PLAYLIST', metadata: { lockupMetadataViewModel: { title: { content: 'A playlist' } } } } },
    { videoRenderer: { videoId: 'GGGGGGGGGGG', title: { runs: [{ text: 'Old layout video' }] } } }
  ] } };
  const app = imp.parseHistoryPage(data);
  assert.deepEqual(app.map(i => [i.key, i.title, i.creator]), [['yt_GGGGGGGGGGG', 'Old layout video', 'Chan A'], ['yt_HHHHHHHHHHH', 'New layout video', 'Chan B']]);
  const vm = await import('vm');
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'extension', 'history.js'), 'utf8'), ctx);
  assert.equal(JSON.stringify(ctx.ktParseHistory(data)), JSON.stringify(app));
});
await t('import: Apple Podcasts library query + rows', async () => {
  const imp = await import('../server/public/importers.js');
  const lib = new Database(':memory:');
  lib.exec(`CREATE TABLE ZMTPODCAST (Z_PK INTEGER PRIMARY KEY, ZTITLE TEXT, ZAUTHOR TEXT, ZIMAGEURL TEXT, ZSTORECOLLECTIONID INTEGER);
    CREATE TABLE ZMTEPISODE (Z_PK INTEGER PRIMARY KEY, ZUUID TEXT, ZTITLE TEXT, ZPODCAST INTEGER, ZWEBPAGEURL TEXT, ZDURATION REAL,
      ZLASTDATEPLAYED REAL, ZITEMDESCRIPTIONWITHOUTHTML TEXT, ZPLAYCOUNT INTEGER, ZSTORETRACKID INTEGER);
    INSERT INTO ZMTPODCAST VALUES (1, 'My First Million', 'Shaan', 'https://img/x.jpg', 1469759170);
    INSERT INTO ZMTEPISODE VALUES (1, 'U-1', 'Boring businesses', 1, NULL, 3600.4, 785000000, 'Laundromats', 1, 1000650000000);
    INSERT INTO ZMTEPISODE VALUES (2, 'U-2', 'Never played', 1, NULL, 100, NULL, '', 0, 1);
    INSERT INTO ZMTEPISODE VALUES (3, 'U-3', 'Older', 1, 'https://mfm.com/ep3', 50, 700000000, '', 1, 2);`);
  const cols = tb => lib.prepare(`PRAGMA table_info(${tb})`).all().map(c => c.name);
  const rows = lib.prepare(imp.applePodcastsQuery(cols('ZMTEPISODE'), cols('ZMTPODCAST'))).all();
  const r = imp.parseApplePodcastRows(rows);
  assert.deepEqual(r.map(i => i.key), ['pod_U-1', 'pod_U-3']);
  assert.equal(r[0].url, 'https://podcasts.apple.com/podcast/id1469759170?i=1000650000000');
  assert.equal(r[0].duration_sec, 3600); assert.equal(r[0].creator, 'My First Million'); assert.equal(r[1].url, 'https://mfm.com/ep3');
  assert.equal(r[0].watched_at, new Date((785000000 + 978307200) * 1000).toISOString());
});
await t('shelf excludes notes/transcripts, escapes HTML', () => {
  dbm.updateEntry('yt_AAAAAAAAAAA', { title: 'Agency <script>alert(1)</script>', personal_notes: 'SECRET-NOTE' });
  const r = shelf.publishShelf({ minRating: 4, title: 'Test Shelf' });
  assert.equal(r.count, 1);
  const html = fs.readFileSync(path.join(SHELF, 'index.html'), 'utf8');
  const json = fs.readFileSync(path.join(SHELF, 'shelf.json'), 'utf8');
  for (const s of [html, json]) { assert.ok(!s.includes('SECRET-NOTE')); assert.ok(!s.includes('dentists')); }
  assert.ok(!html.includes('<script>alert(1)'));
  assert.ok(html.includes('niche down'));
  dbm.updateEntry('yt_AAAAAAAAAAA', { title: 'How I built an AI agency to $10k/mo' });
});

// 2) HTTP API
console.log('\nHTTP API');
const srv = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let srvLog = '';
srv.stdout.on('data', d => (srvLog += d)); srv.stderr.on('data', d => (srvLog += d));
const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 50; i++) { try { await fetch(base + '/api/health'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
const j = async (p, o = {}) => { const r = await fetch(base + p, { ...o, headers: { 'Content-Type': 'application/json', ...(o.headers || {}) } }); return { status: r.status, body: await r.json() }; };

await t('GET /api/health + /api/meta', async () => {
  const h = await j('/api/health'); assert.equal(h.body.ok, true); assert.equal(h.body.schema, 3);
  const m = await j('/api/meta'); assert.ok(m.body.monetizationModels.includes('Micro-SaaS')); assert.equal(m.body.stats.total, 2);
});
await t('POST /api/ingest (extension payload)', async () => {
  const r = await j('/api/ingest', { method: 'POST', headers: { Origin: 'chrome-extension://abc' }, body: JSON.stringify({ id: 'yt_CCCCCCCCCCC', title: 'Micro-SaaS idea validation', creator: 'Builder', url: 'https://www.youtube.com/watch?v=CCCCCCCCCCC', transcript: 'validate with landing pages', duration_sec: 900 }) });
  assert.equal(r.status, 200); assert.equal(r.body.entry.transcript_chars, 27); assert.equal(r.body.entry.transcript, undefined);
});
await t('ingest validation + bad JSON + unknown route', async () => {
  assert.equal((await j('/api/ingest', { method: 'POST', body: '{}' })).status, 400);
  assert.equal((await j('/api/ingest', { method: 'POST', body: '{bad' })).body.error, 'Invalid JSON body');
  assert.equal((await j('/api/nope')).status, 404);
  assert.equal((await j('/api/ingest-url', { method: 'POST', body: JSON.stringify({ url: 'not a link at all' }) })).status, 400);
});
await t('foreign websites are blocked (CORS/CSRF)', async () => {
  const r = await j('/api/ingest', { method: 'POST', headers: { Origin: 'https://evil.example' }, body: JSON.stringify({ id: 'x', title: 'x' }) });
  assert.equal(r.status, 403);
  const g = await fetch(base + '/api/entries', { headers: { Origin: 'https://evil.example' } });
  assert.equal(g.headers.get('access-control-allow-origin'), null);
});
await t('GET /api/entries with search + filters', async () => {
  assert.equal((await j('/api/entries?q=landing')).body.length, 1);
  assert.equal((await j('/api/entries?q=landing&source=apple_podcasts')).body.length, 0);
  assert.equal((await j('/api/entries?minRating=5')).body[0].id, 'yt_AAAAAAAAAAA');
  assert.equal((await j('/api/entries?q=%22%3A(')).status, 200);
});
await t('PATCH + DELETE /api/entries/:id', async () => {
  const p = await j('/api/entries/yt_CCCCCCCCCCC', { method: 'PATCH', body: JSON.stringify({ signal_rating: 4, monetization_models: ['Micro-SaaS'], key_takeaways: 'ship in a weekend', status: 'to_watch' }) });
  assert.equal(p.body.entry.signal_rating, 4); assert.equal(p.body.entry.status, 'to_watch');
  assert.equal((await j('/api/entries/yt_CCCCCCCCCCC', { method: 'PATCH', body: JSON.stringify({ signal_rating: 9 }) })).status, 400);
  assert.equal((await j('/api/entries/missing', { method: 'PATCH', body: '{}' })).status, 404);
  await j('/api/ingest', { method: 'POST', body: JSON.stringify({ id: 'yt_DDDDDDDDDDD', title: 'temp' }) });
  assert.equal((await j('/api/entries/yt_DDDDDDDDDDD', { method: 'DELETE' })).status, 200);
  assert.equal((await j('/api/entries/yt_DDDDDDDDDDD')).status, 404);
});
await t('shelf settings + publish + served at /shelf/', async () => {
  const s = await j('/api/shelf/settings', { method: 'PUT', body: JSON.stringify({ title: 'Ryan\'s Shelf', minRating: 4 }) });
  assert.equal(s.body.title, "Ryan's Shelf");
  const p = await j('/api/shelf/publish', { method: 'POST', body: JSON.stringify({}) });
  assert.equal(p.body.count, 2);
  const html = await (await fetch(base + '/shelf/')).text();
  assert.ok(html.includes('Ryan&#39;s Shelf') && html.includes('Micro-SaaS idea validation'));
});
await t('exists + watched_at on ingest', async () => {
  const r = await j('/api/ingest', { method: 'POST', body: JSON.stringify({ id: 'yt_IIIIIIIIIII', title: 'Dated', watched_at: '2026-01-02T03:04:05Z' }) });
  assert.equal(r.body.entry.watched_at, '2026-01-02T03:04:05.000Z');
  assert.deepEqual((await j('/api/entries/exists', { method: 'POST', body: JSON.stringify({ ids: ['yt_IIIIIIIIIII', 'yt_nope'] }) })).body.saved, ['yt_IIIIIIIIIII']);
});
await t('dashboard HTML served', async () => {
  assert.ok((await (await fetch(base + '/')).text()).includes('Public Shelf'));
});
srv.kill();

// 3) MCP over stdio, from a different cwd like Claude Desktop
console.log('\nMCP (stdio)');
const mcp = spawn(process.execPath, [path.join(ROOT, 'server', 'mcp.js')], { env, cwd: os.homedir(), stdio: ['pipe', 'pipe', 'pipe'] });
let buf = ''; const waiters = new Map(); let nextId = 1;
mcp.stdout.on('data', d => {
  buf += d; let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    let msg; try { msg = JSON.parse(line); } catch { throw new Error('Non-JSON on MCP stdout: ' + line); }
    waiters.get(msg.id)?.(msg); waiters.delete(msg.id);
  }
});
const rpc = (method, params = {}) => new Promise((res, rej) => {
  const id = nextId++; waiters.set(id, res);
  setTimeout(() => rej(new Error(`timeout ${method}`)), 8000);
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
const call = async (name, args = {}) => {
  const r = await rpc('tools/call', { name, arguments: args });
  return { isError: !!r.result?.isError, text: r.result?.content?.[0]?.text ?? JSON.stringify(r.error) };
};
await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

await t('tools/list exposes 9 tools', async () => {
  const r = await rpc('tools/list');
  assert.equal(r.result.tools.length, 9);
});
await t('search_transcripts / list / top rated / by model', async () => {
  assert.match((await call('search_transcripts', { query: 'chatbot dentists' })).text, /yt_AAAAAAAAAAA/);
  assert.match((await call('search_transcripts', { query: '((' })).text, /No matches/);
  assert.equal(JSON.parse((await call('list_watched_media', { sort: 'rating', limit: 5 })).text)[0].signal_rating, 5);
  assert.equal(JSON.parse((await call('get_top_rated', { min_rating: 4 })).text).length, 2);
  assert.ok(JSON.parse((await call('list_by_monetization_model', {})).text).in_use.length >= 2);
  assert.equal(JSON.parse((await call('list_by_monetization_model', { model: 'micro-saas' })).text).length, 1);
});
await t('rate_and_annotate appends takeaways + notes', async () => {
  const r = JSON.parse((await call('rate_and_annotate', { id: 'pod_1', signal_rating: 3, monetization_models: ['Micro-SaaS'], add_takeaways: ['charge annually'], append_notes: 'from Claude' })).text);
  assert.equal(r.signal_rating, 3); assert.deepEqual(r.key_takeaways, ['charge annually']);
  const full = JSON.parse((await call('get_full_transcript', { id: 'pod_1' })).text);
  assert.equal(full.personal_notes, 'from Claude');
});
await t('errors come back as isError, not crashes', async () => {
  assert.ok((await call('get_full_transcript', { id: 'nope' })).isError);
  assert.ok((await call('rate_and_annotate', { id: 'nope', signal_rating: 2 })).isError);
  assert.ok((await call('rate_and_annotate', { id: 'pod_1' })).isError);
  assert.ok((await call('save_link', { url: 'not a link' })).isError);
});
await t('publish_public_shelf', async () => {
  assert.equal(JSON.parse((await call('publish_public_shelf', { min_rating: 3 })).text).published, 3);
});
mcp.kill();

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${process.exitCode ? '✘ FAILED' : '✔ all'} ${passed} checks passed\n`);
process.exit(process.exitCode || 0);
