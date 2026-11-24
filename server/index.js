import express from 'express';
import cors from 'cors';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import {
  upsertEntry, queryEntries, getEntryById, updateEntry, deleteEntry, getStats,
  syncApplePodcastsMac, MONETIZATION_MODELS, SOURCES, STATUSES, SCHEMA_VERSION, DB_PATH, HttpError
} from './db.js';
import { fetchYouTubeVideo } from './youtube.js';
import { publishShelf, getShelfSettings, saveShelfSettings, SHELF_DIR } from './shelf.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const PORT = Number(process.env.PORT) || 3456;
const app = express();

// Only the dashboard itself and the Chrome extension may call the API from a browser.
// (Without this, any website you visit could read your library from localhost.)
const allowedOrigin = origin =>
  !origin ||
  origin.startsWith('chrome-extension://') ||
  new RegExp(`^http://(localhost|127\\.0\\.0\\.1|\\[::1\\]):${PORT}$`).test(origin);
app.use(cors({ origin: (origin, cb) => cb(null, allowedOrigin(origin)) }));
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.headers.origin && !allowedOrigin(req.headers.origin)) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  next();
});
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/shelf', express.static(SHELF_DIR));

const wrap = fn => async (req, res, next) => {
  try { await fn(req, res, next); } catch (err) { next(err); }
};

app.get('/api/health', (req, res) => {
  const stats = getStats();
  res.json({ ok: true, version: pkg.version, schema: SCHEMA_VERSION, db: DB_PATH, entries: stats.total, pid: process.pid });
});

app.get('/api/meta', (req, res) => {
  res.json({ monetizationModels: MONETIZATION_MODELS, sources: SOURCES, statuses: STATUSES, stats: getStats() });
});

// Ingest from the Chrome extension (or any local script)
app.post('/api/ingest', wrap((req, res) => {
  const b = req.body || {};
  const entry = upsertEntry({
    id: b.id, source: b.source || 'youtube', title: String(b.title || '').trim(), creator: b.creator,
    url: b.url, duration_sec: b.duration_sec, transcript: b.transcript, published_at: b.published_at || null,
    thumbnail: b.thumbnail || null, transcript_status: b.transcript_status || null, tags: b.tags || null
  });
  res.json({ ok: true, entry: slim(entry) });
}));

// Paste a YouTube link: fetched server-side
app.post('/api/ingest-url', wrap(async (req, res) => {
  const { url, status } = req.body || {};
  if (!url) throw new HttpError(400, 'url is required');
  const video = await fetchYouTubeVideo(url);
  const { warnings, ...data } = video;
  let entry = upsertEntry(data);
  if (status && STATUSES.includes(status)) entry = updateEntry(entry.id, { status });
  res.json({ ok: true, entry: slim(entry), warnings });
}));

app.post('/api/sync/podcasts', wrap((req, res) => {
  res.json(syncApplePodcastsMac());
}));

app.get('/api/entries', wrap((req, res) => {
  const { q, source, minRating, model, status, sort, limit, offset } = req.query;
  res.json(queryEntries({
    q: q ? String(q) : '', source: source || null, minRating: minRating ? Number(minRating) : null,
    model: model || null, status: status || null, sort: sort || null, limit: Number(limit) || 100, offset
  }));
}));

app.get('/api/entries/:id', wrap((req, res) => {
  const entry = getEntryById(req.params.id);
  if (!entry) throw new HttpError(404, 'Not found');
  res.json(entry);
}));

app.patch('/api/entries/:id', wrap((req, res) => {
  res.json({ ok: true, entry: updateEntry(req.params.id, req.body || {}) });
}));

app.delete('/api/entries/:id', wrap((req, res) => {
  if (!deleteEntry(req.params.id)) throw new HttpError(404, 'Not found');
  res.json({ ok: true });
}));

app.get('/api/shelf/settings', (req, res) => res.json(getShelfSettings()));
app.put('/api/shelf/settings', wrap((req, res) => res.json(saveShelfSettings(req.body || {}))));
app.post('/api/shelf/publish', wrap((req, res) => {
  const result = publishShelf(req.body || {});
  res.json({ ...result, previewUrl: '/shelf/' });
}));

app.use('/api', (req, res) => res.status(404).json({ error: `No route ${req.method} ${req.originalUrl}` }));

// JSON errors everywhere
app.use((err, req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error('[error]', err);
  res.status(status).json({ error: err.type === 'entity.parse.failed' ? 'Invalid JSON body' : err.message });
});

function slim(e) {
  if (!e) return e;
  const { transcript, ...rest } = e;
  return { ...rest, transcript_chars: (transcript || '').length };
}

// Listen on IPv4 and IPv6 loopback only (never exposed to your network).
const primary = http.createServer(app);
primary.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Is the dashboard already running? Try: lsof -i :${PORT}`);
  } else console.error(err);
  process.exit(1);
});
primary.listen(PORT, '127.0.0.1', () => {
  console.log(`Signal Shelf v${pkg.version} → http://localhost:${PORT}  (db: ${DB_PATH})`);
  const v6 = http.createServer(app);
  v6.on('error', () => {}); // IPv6 loopback unavailable: fine
  v6.listen(PORT, '::1');
});
