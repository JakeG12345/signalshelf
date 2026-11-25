# Signal Shelf

Track the YouTube videos and podcasts you watch, with transcripts. Connect Claude (remote MCP) or export the transcripts so Claude can summarise or build from them. Letterboxd-style social layer: public profiles, follow people, Following feed.

Live: https://signalshelf.jake-1c4.workers.dev (landing `/`, app `/app/`, profiles `/u/<handle>`, `/people`).
Owner: Ryan (GitHub JakeG12345). Built as day 1 of a "launch a product every day" challenge posted on X and YouTube.

## How Ryan wants to work

- Keep chat replies short. After each task: one or two lines on what was done, then a numbered list of **what you need from him** and **what's still to do**.
- He often works from his iPhone. Prefer changes he can check on the live site; push to `main` to deploy.
- Website copy: as little text as possible, plain sentence case, no hype, no em dashes, no "AI" framing (the product has no AI of its own).
- He wants things to feel instant and simple. Don't add steps or settings unless needed.

## Layout

| Path | What |
|---|---|
| `worker/` | **Production backend**: Cloudflare Worker + D1. `src/index.js` routes, `store.js` (D1, schema + migrations in `ensureSchema`), `accounts.js` (guest accounts, passwords, sessions, follows, feed, people, rate limits), `mcp.js` (remote MCP, Streamable HTTP, JSON responses), `landing.js`, `transcripts.js` (Supadata), `podcast-transcripts.js` (real podcast transcripts from the show's RSS `<podcast:transcript>` tag, free, streamed so big feeds stop early), `imports.js` (YouTube liked videos via Google OAuth, podcast show search via Apple's directory; the app calls Apple from the browser (JSONP) because Apple returns 429 to Workers, server endpoints are the fallback). |
| `server/public/` | The web app (single `index.html`, inline CSS/JS) + PWA manifest/icons, `importers.js` (Takeout / YouTube history / Apple Podcasts parsers), `vendor/sql-wasm.*` (sql.js for reading MTLibrary.sqlite on-device). Served by the Worker at `/app/`. |
| `shared/` | Code used by both the Worker and the Mac server: `core.js` (all entry SQL builders, normalisers, `userId`-scoped variants), `capture.js` + `youtube.js` (link capture), `theme.js` (design tokens, signal-bars, logo), `profile-render.js`, `shelf-render.js`. |
| `extension/` | Chrome MV3 extension: save + transcript (caption files, then YouTube's transcript panel), auto-capture (on by default for new installs, 2 min), "Pick from YouTube history" (`picker.html`), server URL + key settings. |
| `server/` | Optional Mac-only version: Express + better-sqlite3, Apple Podcasts library sync, stdio MCP. Secondary; keep it working but don't prioritise it. |

## Commands

```bash
npm ci && npm test                         # 33 checks: shared logic, importers, local server, stdio MCP
cd worker && npm ci && npm test            # 33 checks (9 MCP tools): multi-user Worker under wrangler dev + remote MCP + Google sign-in, YouTube likes and podcast search (local mock)
cd worker && npm run dev                   # local cloud dev server
```

Both suites must pass before pushing. CI (`.github/workflows/deploy.yml`) runs them on every push and deploys `main` to Cloudflare. Secrets live in the GitHub `production` environment: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `SUPADATA_API_KEY`, `GOOGLE_CLIENT_SECRET`, `DEEPGRAM_API_KEY`. The workflow creates/finds the D1 database `signalshelf` and patches its id into `wrangler.toml`.

Check a deploy: `curl -s https://api.github.com/repos/JakeG12345/signalshelf/actions/runs?per_page=1`.

## Rules that matter

- **Sharing is off** (`SOCIAL_ENABLED` empty in `wrangler.toml`): no public profiles, `/people`, `/u/*`, follows, Following feed or landing picks; all return 404 or are hidden, and `capabilities.social` is false so the app hides them. Ryan wants it back only if there's interest; flip `SOCIAL_ENABLED = "true"`. The main test instance runs with it on, the Google instance with it off.
- **Privacy:** personal notes and transcripts never leave a user's own API responses. Profiles, feed, `/people`, landing "top rated" and "most must watch" (`featured`) and `shelf.json` use `publicItem` / explicit public columns only. Add a test whenever you touch these.
- **Every query is user-scoped** in the Worker (`createStore(db, userId)`, `buildEntriesQuery({ userId })`). Entry ids (`yt_<id>`, `pod_<uuid>`, `web_<hash>`) are only unique per user.
- **Each entry has four text fields, all private to its owner:** `transcript` (spoken words only), `description` (the show's or page's own notes; podcasts never put it in `transcript`), `personal_notes` (the user's), `claude_notes` (written by Claude via the MCP `write_claude_notes` tool, replace or append; old `rate_and_annotate.append_notes` also lands here, never in the user's notes). Search covers all four; the Markdown export includes them. `SCHEMA_VERSION` 3.
- **Re-captures never overwrite** a user's rating, tags, takeaways or notes, or a transcript with an empty one (`buildUpsert`).
- **Instant UI:** the app updates the screen first and syncs in the background with rollback (`sync()`, `replaceCard()`, cached first paint). Keep new interactions optimistic.
- **Transcripts:** YouTube blocks cloud IPs, so the Worker uses Supadata (`mode=native`, 1 credit per new video; skipped when a transcript already exists). Free plan = 100/month; transcripts are free for users for now. When credits run out, saves continue without a transcript. Podcasts: the app sends `feed_url`, `episode_guid`, `enclosure_url` with each save and the Worker fetches the show's published transcript; Order on every podcast save: (1) shared cache `podcast_transcripts` keyed by `pod_apple_<trackId>` and `audio:<enclosure without query>`, (2) the show's published transcript, (3) Deepgram speech-to-text on the audio (`nova-3`): saving queues an `stt_jobs` row and marks the episode `pending`; the app then calls `POST /api/transcribe/<id>`, which waits on Deepgram (about 30s per hour of audio) and returns the entry or a readable error. The app resumes pending episodes on load, two at a time; 30/user/day. No callbacks. Only feed and Deepgram text go in the cache, never user-pasted text. Without `DEEPGRAM_API_KEY` step 3 is skipped and the description stays.
- **No history APIs exist:** YouTube removed watch history from its API in 2016; Apple Podcasts has no API. History import = Chrome extension (live), Google Takeout file, or the Mac Podcasts library file. Easier stand-ins: YouTube liked videos (`youtube.readonly`, token never stored, list parked once in `user_settings`) and podcast show search with episode ticking.
- **Accounts:** guests get a key instantly (no sign-up); sign-up adds username + password (PBKDF2, 25k iterations for Workers CPU limits) or "Continue with Google" (OAuth code flow, `users.google_sub`, `oauth_states`; auto username; guest shelf is upgraded in place) and makes a public profile (private toggle available). Keys are stored hashed; the private link `/app/#k=<key>` signs a device in.
- **Rate limits** live in D1 (`rateLimit`): guest creation per IP, saves per day, writes per hour, logins, items per user (5000).

## Design

Hi-fi faceplate look: plate `#E6E8E2`, panel `#F4F5F0`, ink `#15171A`, mute `#5F645F`, line `#C3C7BE`, signal blue `#2740FF`. Type: Archivo (variable, wide 125% for headings). Ratings are **five ascending signal bars**, never stars; labels Noise, Thin, Useful, High signal, Must watch. Logo = five blue bars. Tokens are in `shared/theme.js` and duplicated inline in `server/public/index.html` and `extension/popup.html`.

## Open ideas (ask Ryan before starting)

1. One-tap Shortcut: set `SHORTCUT_ICLOUD_URL` in `worker/wrangler.toml` once Ryan shares the iCloud link.
3. Share image (OG card) for profiles, for posting on X.
4. Password reset by email (needs an email provider such as Resend + a domain).
5. Buy `signalshelf.app` (unregistered as of 24 Nov 2026) and point it at the Worker.
6. Native iPhone wrapper (e.g. Capacitor) around the web app with a Share Extension. Skipped for launch; revisit if it gets traction.
