# Chrome Web Store listing: Signal Shelf

Upload `dist/signal-shelf-extension-<version>.zip` (build it with `npm run pack:extension`).

## Store listing tab

**Name:** Signal Shelf

**Summary (132 characters max):**
Save YouTube videos and podcast episodes with their transcripts. Rate them, and let Claude read what you learned.

**Description:**
Signal Shelf keeps track of the YouTube videos and podcasts you learn from.

- Save the video or podcast episode you're on with one click, transcript included
- Works on YouTube, Apple Podcasts and Spotify episode pages
- Rate each one from Noise to Must watch on five signal bars
- Optional auto-capture saves YouTube videos you watch for a few minutes (off until you turn it on)
- Pick from your YouTube watch history
- Connect Claude to your shelf so it can search your transcripts and write notes for you

Your shelf is private. Nothing is shown to anyone else. Free, and no account is needed to start.

**Category:** Productivity
**Language:** English

**Images to upload:**
- Icon: `extension/icons/icon-128.png` (128x128)
- Screenshots (1280x800), in this folder: `store-1-shelf.png`, `store-2-episode.png`, `store-3-extension.png`

## Privacy practices tab

**Single purpose:** Save YouTube videos and podcast episodes, with their transcripts, to the user's own Signal Shelf.

**Permission justifications:**
- `activeTab`: read the title and address of the tab the user is on when they open the popup, to offer saving that video or episode.
- `scripting`: read the YouTube player's caption list on the video page the user chose to save.
- `storage`: keep the user's shelf key and settings (auto-capture on or off, minutes) in Chrome sync storage.
- `tabs`: find an open YouTube tab to read the user's own watch history when they press "Pick from YouTube history", and close the tab opened by Connect.
- Host `https://www.youtube.com/*`: read the video and its captions when saving.
- Host `https://itunes.apple.com/*`: look up podcast episodes in Apple's public directory to find their audio for transcripts.
- Host `https://signalshelf.jake-1c4.workers.dev/*`: the user's shelf (the extension's own service), and the one-click Connect on its app page.
- Host `http://127.0.0.1:3456/*`, `http://localhost:3456/*`: optional self-hosted Mac version.

**Remote code:** No, all code is in the package.

**Data usage (tick these):**
- Web history: yes (the videos and episodes the user saves, and with auto-capture on, YouTube videos they watch)
- Website content: yes (titles, captions and transcripts of saved items)
- Authentication information: yes (the user's shelf key, stored locally in Chrome)

**Certify:** not sold to third parties; not used for unrelated purposes; not used for creditworthiness or lending.

**Privacy policy URL:** https://signalshelf.jake-1c4.workers.dev/privacy

## Distribution
Public. All regions.
