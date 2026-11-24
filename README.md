# Signal Shelf

**Letterboxd for money-making & AI YouTube videos and podcasts, with Claude as your memory.**

Capture what you watch and listen to, rate how much *signal* it had, tag the monetization model, write down the takeaways, publish a shareable shelf of your best picks, and let Claude search all of it through MCP. Everything runs locally; your data lives in `server/knowledge.db`.

| Piece | What it does |
|---|---|
| `extension/` | Chrome extension: save the current video + transcript, paste a link, optional **auto-capture** after N minutes of playback |
| `server/index.js` | Local API + dashboard at http://localhost:3456 |
| `server/db.js` | SQLite + FTS5 storage, migrations, Apple Podcasts sync (macOS) |
| `server/youtube.js` | Server-side link capture (metadata + captions when YouTube serves them) |
| `server/shelf.js` | Public Shelf generator → `public-shelf/index.html` + `shelf.json` |
| `server/mcp.js` | Claude MCP server (9 tools) |
| `scripts/setup.js` | One-click setup + health check (`npm run setup` / `npm run doctor`) |

## Setup

```bash
cd signal-shelf
npm install
npm run setup     # checks Node/SQLite, rebuilds native module if needed, registers MCP in Claude Desktop
npm start         # dashboard + API on http://localhost:3456 (keep this running for the extension)
```

`npm run setup` backs up `claude_desktop_config.json` before editing it, keeps your other MCP servers, and pins the absolute Node path (so Claude Desktop finds it even with nvm). **Quit Claude Desktop fully (⌘Q) and reopen** afterwards. If you change Node versions later, run `npm run setup` again. `npm run doctor` runs the same checks without changing anything.

Claude Code: `claude mcp add signal-shelf -- "$(which node)" "$PWD/server/mcp.js"`

### Chrome extension
1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick the `extension/` folder.
   (Upgrading from v1? Click the reload ↻ icon on the existing card instead, then refresh open YouTube tabs.)
2. On a video, click the icon → **Save video + transcript**, then tap stars to rate.
3. Optional: turn on **Auto-capture** (off by default). Videos save after 2 minutes of actual playback (pauses, seeks and ads don't count; videos shorter than the threshold save at 90% watched). Change the threshold in the popup.

Transcripts: the extension first tries YouTube's caption files, then falls back to reading YouTube's own **Show transcript** panel (briefly opening and closing it). Videos with no captions save without a transcript; you can paste one in the dashboard.

### Apple Podcasts (macOS)
Click **Sync Apple Podcasts** in the dashboard (or ask Claude to). It imports played episodes with their descriptions. If macOS blocks it, grant **Full Disk Access** to your terminal app (and to Claude for MCP sync) in System Settings → Privacy & Security.

## Rating & tagging
Click any card to edit: **Signal Rating** (1–5, keys `1`–`5`, `0` clears), **Monetization Models** (Micro-SaaS, AI Agency, Faceless YT, Info Product, … or custom), **Key Takeaways** (one per line), **Personal Notes** (private), status (watched / to watch / in progress), title and transcript. `⌘↵` saves, `Esc` closes. Everything is full-text searchable.

## Public Shelf
**Publish Public Shelf** (or `npm run shelf -- --min 4`) writes a self-contained page to `public-shelf/` with your top-rated picks, stars, tags and takeaways. **Personal notes and transcripts are never included.** Preview at http://localhost:3456/shelf/. To share, drag the `public-shelf` folder onto https://app.netlify.com/drop, or push it to GitHub Pages / Vercel. `shelf.json` is the same data for anything else you want to build.

## Claude MCP tools
`list_watched_media`, `search_transcripts`, `get_full_transcript`, `get_top_rated`, `list_by_monetization_model`, `rate_and_annotate`, `save_youtube_url`, `sync_apple_podcasts`, `publish_public_shelf`.

Try:
> *"What are my top-rated AI Agency videos? Summarise the takeaways."*
> *"Search my transcripts for cold email pricing, then rate the best one 5 and add 3 takeaways."*

## API
`GET /api/health` · `GET /api/meta` · `GET /api/entries?q=&source=&minRating=&model=&status=&sort=` · `GET|PATCH|DELETE /api/entries/:id` · `POST /api/ingest` · `POST /api/ingest-url {url}` · `POST /api/sync/podcasts` · `GET|PUT /api/shelf/settings` · `POST /api/shelf/publish`

The server only listens on loopback and rejects requests from other websites' origins.

## Tests
`npm test` runs 23 end-to-end checks (migration, search, API, CORS, shelf privacy, MCP over stdio) against a throwaway database.
