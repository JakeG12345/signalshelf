// Remote MCP server (Streamable HTTP, stateless JSON responses) for Claude on iPhone, web and desktop.
import { APP_VERSION, MONETIZATION_MODELS } from '../../shared/core.js';
import { captureLink } from '../../shared/capture.js';
import { normalizeShelfSettings } from '../../shared/shelf-render.js';

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_TEXT = 120_000;

const SOURCE = { type: 'string', enum: ['youtube', 'apple_podcasts', 'web', 'manual'], description: 'Filter by source' };
const RATING = { type: 'integer', minimum: 1, maximum: 5 };
const MODEL = { type: 'string', description: `Monetization model tag, e.g. ${MONETIZATION_MODELS.slice(0, 6).join(', ')}` };
const STATUS = { type: 'string', enum: ['watched', 'to_watch', 'in_progress'] };

const TOOLS = [
  {
    name: 'list_watched_media',
    description: 'List saved videos, podcast episodes and links from the user\'s Signal Shelf, newest first or by Signal Rating, with optional filters.',
    inputSchema: { type: 'object', properties: {
      source: SOURCE, min_rating: { ...RATING, description: 'Only items rated at least this' }, monetization_model: MODEL, status: STATUS,
      sort: { type: 'string', enum: ['recent', 'rating', 'oldest', 'title'], default: 'recent' },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
    } },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'search_transcripts',
    description: 'Full-text search across transcripts, titles, creators, key takeaways, personal notes and monetization tags. Returns matching snippets.',
    inputSchema: { type: 'object', required: ['query'], properties: {
      query: { type: 'string', description: 'Keywords, e.g. "cold email agency pricing"' },
      source: SOURCE, min_rating: RATING, monetization_model: MODEL,
      limit: { type: 'integer', minimum: 1, maximum: 30, default: 10 }
    } },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'get_full_transcript',
    description: 'Get the full transcript plus all metadata and annotations (rating, tags, takeaways, personal notes) for one entry.',
    inputSchema: { type: 'object', required: ['id'], properties: {
      id: { type: 'string', description: 'Entry id from search or list results' },
      max_chars: { type: 'integer', minimum: 1000, maximum: 500000, default: MAX_TEXT }
    } },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'get_top_rated',
    description: 'The highest Signal Rating items (default 4★+), optionally for one monetization model.',
    inputSchema: { type: 'object', properties: {
      min_rating: { ...RATING, default: 4 }, monetization_model: MODEL,
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 15 }
    } },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'list_by_monetization_model',
    description: 'Without a model: counts and average ratings per monetization model. With a model: the items tagged with it, best first.',
    inputSchema: { type: 'object', properties: { model: MODEL, limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 } } },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'rate_and_annotate',
    description: 'Save a Signal Rating, monetization model tags, key takeaways and/or personal notes on an entry. Only fields you pass change. Use add_takeaways / append_notes to add without overwriting.',
    inputSchema: { type: 'object', required: ['id'], properties: {
      id: { type: 'string' },
      signal_rating: { type: ['integer', 'null'], minimum: 1, maximum: 5, description: '1-5, or null to clear' },
      monetization_models: { type: 'array', items: { type: 'string' }, description: 'Replaces the tag list' },
      key_takeaways: { type: 'array', items: { type: 'string' }, description: 'Replaces all takeaways' },
      add_takeaways: { type: 'array', items: { type: 'string' }, description: 'Appends takeaways' },
      personal_notes: { type: 'string', description: 'Replaces notes' },
      append_notes: { type: 'string', description: 'Appends to notes' },
      status: STATUS
    } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  {
    name: 'save_link',
    description: 'Add a YouTube video, Apple Podcasts episode or any web link (Spotify, articles…). Fetches title/creator and the transcript or description when available.',
    inputSchema: { type: 'object', required: ['url'], properties: {
      url: { type: 'string' }, status: { type: 'string', enum: ['watched', 'to_watch'], default: 'watched' }
    } },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
  },
  {
    name: 'get_public_shelf',
    description: 'Get the public shelf link and its settings (minimum rating, whether it is published).',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true }
  }
];

const compact = e => ({
  id: e.id, source: e.source, title: e.title, creator: e.creator, url: e.url, watched_at: e.watched_at,
  signal_rating: e.signal_rating, monetization_models: e.monetization_models, key_takeaways: e.key_takeaways,
  status: e.status, transcript_status: e.transcript_status,
  transcript_chars: e.transcript_chars ?? (e.transcript || '').length,
  ...(e.match_snippet ? { match_snippet: e.match_snippet } : {})
});
const int = (v, d, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : d;
};
const text = data => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] });
const toolError = msg => ({ content: [{ type: 'text', text: msg }], isError: true });

async function callTool(name, a = {}, { store, origin, user, guardCapture, capture = captureLink }) {
  switch (name) {
    case 'list_watched_media':
      return text((await store.query({
        source: a.source, minRating: a.min_rating, model: a.monetization_model, status: a.status,
        sort: a.sort || 'recent', limit: int(a.limit, 20, 1, 100)
      })).map(compact));
    case 'search_transcripts': {
      if (!String(a.query || '').trim()) return toolError('query is required');
      const rows = await store.query({ q: a.query, source: a.source, minRating: a.min_rating, model: a.monetization_model, limit: int(a.limit, 10, 1, 30) });
      return text(rows.length ? rows.map(compact) : `No matches for "${a.query}".`);
    }
    case 'get_full_transcript': {
      const found = await store.get(String(a.id || ''));
      if (!found) return toolError(`No entry found with id: ${a.id}. Use search_transcripts or list_watched_media to find ids.`);
      const { user_id, ...e } = found;
      const max = int(a.max_chars, MAX_TEXT, 1000, 500000);
      const t = e.transcript || '';
      return text({ ...e, transcript: t.length > max ? t.slice(0, max) + `\n\n[truncated: ${t.length - max} more chars]` : t, transcript_chars: t.length });
    }
    case 'get_top_rated':
      return text((await store.query({ minRating: int(a.min_rating, 4, 1, 5), model: a.monetization_model, sort: 'rating', limit: int(a.limit, 15, 1, 50) })).map(compact));
    case 'list_by_monetization_model': {
      if (!a.model) {
        const s = await store.stats();
        return text({ presets: MONETIZATION_MODELS, in_use: s.models, totals: { entries: s.total, rated: s.rated, avg_rating: s.avg_rating } });
      }
      return text((await store.query({ model: a.model, sort: 'rating', limit: int(a.limit, 25, 1, 100) })).map(compact));
    }
    case 'rate_and_annotate': {
      const { id, ...rest } = a;
      const patch = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
      if (!Object.keys(patch).length) return toolError('Pass at least one field to update.');
      return text(compact(await store.update(String(id || ''), patch)));
    }
    case 'save_link': {
      if (guardCapture) await guardCapture();
      const { warnings, ...data } = await capture(a.url);
      await store.upsert(data);
      const e = await store.update(data.id, { status: a.status === 'to_watch' ? 'to_watch' : 'watched' });
      return text({ saved: compact(e), warnings });
    }
    case 'get_public_shelf': {
      const s = normalizeShelfSettings(await store.getSetting('shelf', {}) || {});
      if (!user?.handle) return text({ published: false, note: 'No username yet. In the Signal Shelf app, open Public Shelf, pick a username and publish.' });
      return text({ url: `${origin}/u/${user.handle}`, published: s.published, min_rating: s.minRating });
    }
    default:
      return null;
  }
}

async function handleMessage(msg, ctx) {
  const isRequest = msg && typeof msg === 'object' && 'id' in msg && msg.id !== null;
  const reply = result => ({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code, message } });
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(-32600, 'Invalid Request');
  if (!isRequest) return null; // notifications (initialized, cancelled…) need no response

  switch (msg.method) {
    case 'initialize': {
      const requested = msg.params?.protocolVersion;
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[1],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'signal-shelf', title: 'Signal Shelf', version: APP_VERSION },
        instructions: 'Signal Shelf is the user\'s personal library of money-making and AI videos, podcasts and links, each with a 1-5 Signal Rating, monetization model tags, key takeaways and private notes. Search it before answering questions about what the user has watched or learned, cite entries by title, and use rate_and_annotate to save takeaways when the user asks.'
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      const name = msg.params?.name;
      if (!TOOLS.some(t => t.name === name)) return fail(-32602, `Unknown tool: ${name}`);
      try {
        return reply(await callTool(name, msg.params?.arguments || {}, ctx));
      } catch (err) {
        return reply(toolError(`Error: ${err.message}`));
      }
    }
    case 'resources/list': return reply({ resources: [] });
    case 'prompts/list': return reply({ prompts: [] });
    default:
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

export async function handleMcp(request, ctx) {
  if (request.method !== 'POST') {
    return new Response('Signal Shelf MCP endpoint. Use POST (Streamable HTTP).', { status: 405, headers: { Allow: 'POST' } });
  }
  let body;
  try { body = await request.json(); }
  catch { return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, { status: 400 }); }

  const batch = Array.isArray(body);
  const results = (await Promise.all((batch ? body : [body]).map(m => handleMessage(m, ctx)))).filter(Boolean);
  if (!results.length) return new Response(null, { status: 202 });
  return Response.json(batch ? results : results[0], { headers: { 'Cache-Control': 'no-store' } });
}
