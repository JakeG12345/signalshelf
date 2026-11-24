# Signal Shelf

**Letterboxd for money-making & AI videos and podcasts, with Claude as your memory.**

Save what you watch and listen to, give it a Signal Rating (1–5), tag the monetization model, write the key takeaways, share a public shelf of your best picks, and ask Claude about all of it. Works on iPhone, desktop and in Claude.

| Part | What it does |
|---|---|
| `worker/` | Cloud backend (Cloudflare Workers + D1, free tier): API, web app, live public shelf, remote MCP for Claude |
| `server/public/` | The web app (installable on iPhone home screen) |
| `shared/` | Logic used by both cloud and Mac: data rules, link capture (YouTube, Apple Podcasts, any page), shelf rendering |
| `extension/` | Chrome extension: save + transcript, optional auto-capture |
| `server/` | Optional Mac-only version (local SQLite, Apple Podcasts library sync, stdio MCP) |

## How it works (cloud)

- **No sign-up.** Opening `/app/` creates a private, anonymous shelf instantly. Your **private link** (Account panel) is your login: open it on other devices to use the same shelf.
- **Public shelves** live at `/u/<username>` once you pick a username and press Publish. The landing page `/` lists fresh shelves.
- **Privacy.** Each person's data is isolated; personal notes and transcripts never appear on public pages. Account panel → Delete my shelf removes everything.
- **Limits.** New shelves per network per day, saves per user per day, writes per hour and items per shelf (see `limitsFrom` in `worker/src/index.js`; override with Worker vars).

| URL | |
|---|---|
| `/` | Landing page + fresh shelves |
| `/app/` | The app (add to iPhone home screen) |
| `/u/<username>` | Public shelf (+ `/shelf.json`) |
| `/mcp/<your key>` | Your Claude connector (private) |

## Deploying your own

1. **Cloudflare** (free): sign up, open **Workers & Pages** once, copy your **Account ID**.
2. **API token**: Profile → API Tokens → **Edit Cloudflare Workers** template → add **Account · D1 · Edit**.
3. **GitHub secrets** (repo or `production` environment): `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
4. Actions → **Test & deploy** → Run workflow. Every push to `main` then tests and redeploys.

Transcripts: YouTube sometimes refuses transcript requests from cloud servers. The video still saves; paste a transcript in the app, or save it from desktop Chrome with the extension (which reads YouTube's transcript panel). Podcasts and web links store their description.

## Chrome extension

`chrome://extensions` → Developer mode → **Load unpacked** → `extension/`. In the popup open **Server settings** and paste the URL and key from the app's Account panel. **Auto-capture** (off by default) saves videos after N minutes of real playback.

## Claude tools

`search_transcripts`, `list_watched_media`, `get_full_transcript`, `get_top_rated`, `list_by_monetization_model`, `rate_and_annotate`, `save_link`, `get_public_shelf`.

> *"What are my top-rated AI Agency videos? Summarise the takeaways."*
> *"Save this link, rate it 4 and add 3 takeaways: https://youtu.be/…"*

## Mac-only version (optional)

```bash
npm install
npm run setup   # registers the local MCP server in Claude Desktop
npm start       # http://localhost:3456
```

## Development

```bash
npm test                    # local server + stdio MCP (27 checks)
cd worker && npm install && npm test   # multi-user cloud worker + remote MCP (14 checks)
cd worker && npm run dev    # local cloud dev server
```

Backups: the app's Connect panel has **Download all data (JSON)**; `POST /api/import` restores it.
