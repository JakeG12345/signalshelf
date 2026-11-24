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

## Cloud setup (all doable from an iPhone)

1. **Cloudflare** (free): sign up at dash.cloudflare.com, open **Workers & Pages** once, and copy your **Account ID**.
2. **API token**: Profile → API Tokens → Create Token → template **Edit Cloudflare Workers** → add permission **Account · D1 · Edit** → create and copy it.
3. **GitHub secrets** (this repo → Settings → Secrets and variables → Actions):
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
   - `APP_TOKEN`: a long passphrase you make up (16+ characters). It unlocks the app and Claude.
4. **Deploy**: Actions → **Test & deploy** → Run workflow. The run summary shows your URLs. After that, every push to `main` tests and redeploys automatically.

Then open `https://signalshelf.<you>.workers.dev/app/` in Safari, unlock with your APP_TOKEN, and **Share → Add to Home Screen**. The app's **Connect** button has copy-paste setup for:

- **iPhone share sheet**: a 2-action Shortcut so you can Share → Save to Signal Shelf from YouTube, Podcasts, Safari, X…
- **Claude** (iPhone, web, desktop): add a custom connector on claude.ai with your private MCP URL.
- **Chrome extension**: paste your workers.dev URL + token into the extension's Server settings.

| URL | |
|---|---|
| `/` | Public shelf (once you press Publish; updates live as you rate) |
| `/shelf.json` | Public shelf data |
| `/app/` | Your private app |
| `/mcp/<APP_TOKEN>` | Claude connector (keep private) |

Transcripts: YouTube sometimes refuses transcript requests from cloud servers. When that happens the video still saves; paste a transcript in the app, or save it from desktop Chrome with the extension (which reads YouTube's transcript panel). Podcasts and web links store their description.

## Chrome extension

`chrome://extensions` → Developer mode → **Load unpacked** → `extension/`. In the popup open **Server settings**, enter your workers.dev URL and token. **Auto-capture** (off by default) saves videos after N minutes of real playback.

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
cd worker && npm install && npm test   # cloud worker under wrangler dev + remote MCP (12 checks)
cd worker && npm run dev    # local cloud dev server (put APP_TOKEN=... in worker/.dev.vars)
```

Backups: the app's Connect panel has **Download all data (JSON)**; `POST /api/import` restores it.
