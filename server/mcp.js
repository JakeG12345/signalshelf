// stdio MCP server. stdout is reserved for JSON-RPC, so all logging goes to stderr.
console.log = (...a) => console.error(...a);

const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = await import('zod');

let dbm, yt, shelf;
try {
  dbm = await import('./db.js');
  yt = await import('../shared/capture.js');
  shelf = await import('./shelf.js');
} catch (err) {
  console.error('[signal-shelf] failed to open the database:', err.message);
  if (/NODE_MODULE_VERSION|did not self-register|dlopen/i.test(err.message)) {
    console.error('[signal-shelf] better-sqlite3 was built for a different Node version. Run: npm run setup');
  }
  process.exit(1);
}

const server = new McpServer({ name: 'signal-shelf', version: '2.1.0' });

const MAX_TEXT = 120_000;
const ok = data => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] });
const fail = msg => ({ content: [{ type: 'text', text: msg }], isError: true });
const safe = fn => async args => {
  try { return await fn(args); } catch (err) { return fail(`Error: ${err.message}`); }
};
const compact = e => ({
  id: e.id, source: e.source, title: e.title, creator: e.creator, url: e.url, watched_at: e.watched_at,
  signal_rating: e.signal_rating, monetization_models: e.monetization_models, key_takeaways: e.key_takeaways,
  status: e.status, transcript_status: e.transcript_status, transcript_chars: e.transcript_chars,
  ...(e.match_snippet ? { match_snippet: e.match_snippet } : {})
});

const sourceEnum = z.enum(['youtube', 'apple_podcasts', 'web', 'manual']);
const modelDesc = `Monetization model tag, e.g. ${dbm.MONETIZATION_MODELS.slice(0, 6).map(m => `"${m}"`).join(', ')}`;

server.registerTool('list_watched_media', {
  description: 'List tracked YouTube videos and podcast episodes, newest first or by Signal Rating, with optional filters.',
  inputSchema: {
    source: sourceEnum.optional().describe('Filter by platform'),
    min_rating: z.number().int().min(1).max(5).optional().describe('Only items rated at least this (1-5)'),
    monetization_model: z.string().optional().describe(modelDesc),
    status: z.enum(['watched', 'to_watch', 'in_progress']).optional(),
    sort: z.enum(['recent', 'rating', 'oldest', 'title']).default('recent'),
    limit: z.number().int().min(1).max(100).default(20)
  }
}, safe(async a => ok(dbm.queryEntries({
  source: a.source, minRating: a.min_rating, model: a.monetization_model, status: a.status, sort: a.sort, limit: a.limit
}).map(compact))));

server.registerTool('search_transcripts', {
  description: 'Full-text search across transcripts, titles, creators, key takeaways, personal notes and monetization tags. Returns matching snippets.',
  inputSchema: {
    query: z.string().min(1).describe('Keywords, e.g. "cold email agency pricing"'),
    source: sourceEnum.optional(),
    min_rating: z.number().int().min(1).max(5).optional(),
    monetization_model: z.string().optional().describe(modelDesc),
    limit: z.number().int().min(1).max(30).default(10)
  }
}, safe(async a => {
  const rows = dbm.queryEntries({ q: a.query, source: a.source, minRating: a.min_rating, model: a.monetization_model, limit: a.limit });
  return ok(rows.length ? rows.map(compact) : `No matches for "${a.query}".`);
}));

server.registerTool('get_full_transcript', {
  description: 'Get the full transcript plus all metadata and annotations (rating, tags, takeaways, notes) for one entry.',
  inputSchema: {
    id: z.string().describe('Entry id, e.g. "yt_dQw4w9WgXcQ" or "pod_<uuid>"'),
    max_chars: z.number().int().min(1000).max(500000).default(MAX_TEXT).describe('Truncate very long transcripts')
  }
}, safe(async ({ id, max_chars }) => {
  const e = dbm.getEntryById(id);
  if (!e) return fail(`No entry found with id: ${id}. Use search_transcripts or list_watched_media to find ids.`);
  const t = e.transcript || '';
  return ok({
    ...e,
    transcript: t.length > max_chars ? t.slice(0, max_chars) + `\n\n[truncated: ${t.length - max_chars} more chars]` : t,
    transcript_chars: t.length
  });
}));

server.registerTool('get_top_rated', {
  description: 'The highest Signal Rating items (default 4★+), optionally for one monetization model. Great for "what are my best resources on X".',
  inputSchema: {
    min_rating: z.number().int().min(1).max(5).default(4),
    monetization_model: z.string().optional().describe(modelDesc),
    limit: z.number().int().min(1).max(50).default(15)
  }
}, safe(async a => ok(dbm.getTopRated({ minRating: a.min_rating, model: a.monetization_model, limit: a.limit }).map(compact))));

server.registerTool('list_by_monetization_model', {
  description: 'Without a model: counts and average ratings per monetization model. With a model: the items tagged with it, best first.',
  inputSchema: {
    model: z.string().optional().describe(modelDesc),
    limit: z.number().int().min(1).max(100).default(25)
  }
}, safe(async ({ model, limit }) => {
  if (!model) {
    const s = dbm.getStats();
    return ok({ presets: dbm.MONETIZATION_MODELS, in_use: s.models, totals: { entries: s.total, rated: s.rated, avg_rating: s.avg_rating } });
  }
  return ok(dbm.queryEntries({ model, sort: 'rating', limit }).map(compact));
}));

server.registerTool('rate_and_annotate', {
  description: 'Save a Signal Rating, monetization model tags, key takeaways and/or personal notes on an entry. Only the fields you pass are changed. Use add_takeaways / append_notes to add without overwriting.',
  inputSchema: {
    id: z.string(),
    signal_rating: z.number().int().min(1).max(5).nullable().optional().describe('1-5, or null to clear'),
    monetization_models: z.array(z.string()).optional().describe('Replaces the tag list'),
    key_takeaways: z.array(z.string()).optional().describe('Replaces all takeaways'),
    add_takeaways: z.array(z.string()).optional().describe('Appends takeaways'),
    personal_notes: z.string().optional().describe('Replaces notes'),
    append_notes: z.string().optional().describe('Appends to notes'),
    status: z.enum(['watched', 'to_watch', 'in_progress']).optional()
  }
}, safe(async ({ id, ...patch }) => {
  const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  if (!Object.keys(clean).length) return fail('Pass at least one field to update.');
  return ok(compact(dbm.updateEntry(id, clean)));
}));

server.registerTool('save_link', {
  description: 'Add a YouTube video, Apple Podcasts episode or any web link. Fetches title/creator, and the transcript (YouTube) or description (podcasts/pages) when available.',
  inputSchema: {
    url: z.string().describe('A YouTube, Apple Podcasts, Spotify or any web link'),
    status: z.enum(['watched', 'to_watch']).default('watched')
  }
}, safe(async ({ url, status }) => {
  const { warnings, ...data } = await yt.captureLink(url);
  dbm.upsertEntry(data);
  const e = dbm.updateEntry(data.id, { status });
  return ok({ saved: compact({ ...e, transcript_chars: (e.transcript || '').length }), warnings });
}));

server.registerTool('sync_apple_podcasts', {
  description: 'Import recently played Apple Podcasts episodes (title, show, description) from the macOS Podcasts app.',
  inputSchema: {}
}, safe(async () => {
  const r = dbm.syncApplePodcastsMac();
  return r.error ? fail(r.error) : ok(r);
}));

server.registerTool('publish_public_shelf', {
  description: 'Regenerate the shareable public shelf (static HTML + JSON) of top-rated items. Never includes personal notes or transcripts.',
  inputSchema: {
    min_rating: z.number().int().min(1).max(5).optional(),
    include_takeaways: z.boolean().optional()
  }
}, safe(async ({ min_rating, include_takeaways }) => {
  const o = {};
  if (min_rating !== undefined) o.minRating = min_rating;
  if (include_takeaways !== undefined) o.includeTakeaways = include_takeaways;
  const r = shelf.publishShelf(o);
  return ok({ published: r.count, file: `${r.dir}/index.html`, min_rating: r.settings.minRating });
}));

process.on('uncaughtException', err => console.error('[signal-shelf] uncaught:', err));
process.on('unhandledRejection', err => console.error('[signal-shelf] unhandled:', err));

await server.connect(new StdioServerTransport());
console.error('[signal-shelf] MCP server ready (9 tools)');
