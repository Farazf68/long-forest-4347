# RadDeck

Radiology board review: flashcards and podcasts for every Core Radiology module, on one spaced-repetition schedule.

## What's in here

| File | What it does |
| --- | --- |
| `public/index.html` | Page shell and styles |
| `public/app.js` | The app: Today, Library, Module, Study, Stats, Settings, sync |
| `public/fsrs.js` | Scheduler (FSRS-5 with 1 min / 10 min learning steps) |
| `public/anki.js` | Anki `.apkg` importer (old and new Anki formats, basic + cloze + reversed cards, images) |
| `public/zip.js` | Small zip reader used by the importer |
| `public/chapters.js` | The 15 chapters / 181 modules. Module ids are storage keys, so don't rename them |
| `src/worker.js` | Cloudflare Worker API over the R2 bucket |
| `wrangler.jsonc` | Worker config (assets in `public/`, R2 bucket `appstorage` bound as `APP_STORAGE`) |

## Deploy

```sh
npm install
npx wrangler secret put ADMIN_TOKEN   # only if you haven't set it before; pick a long random string
npx wrangler deploy
```

Then open the site, go to **Settings**, and sign in with that token on each device you use.
Anyone with the link can view; only someone with the token can upload, delete, or sync progress.

Run locally with `npx wrangler dev`.

## How it works

- **Studying.** Each card has its own schedule. New cards go through two short steps (1 min, 10 min), then graduate to day-based reviews. Grading Again on a review card sends it back for a 10 min relearning step and shortens its next interval. Days roll over at 4am. New cards are capped per day (Settings, default 20) and spread evenly through your reviews. Target recall (default 90%) controls how aggressive the intervals are.
- **Keyboard.** Space shows the answer (and grades Good once it's shown), 1–4 grade, Z undoes, Esc ends the session.
- **Podcasts** have their own listening schedule (1, 3, 7, 14, 30, 60, 120 days) and never block cards. Playback speed and position are remembered.
- **Importing.** Re-importing the same Anki deck updates changed cards and adds new ones without touching your progress. Text files: one card per line, front and back separated by a tab or comma.
- **Storage.** Everything is saved in the browser first (IndexedDB), then synced to R2 when you're signed in. Changes made offline or signed out wait in a queue and sync later.
- **Backup.** Settings has a JSON backup of all card text and review history (images and audio stay in R2).

R2 layout: `flashcards/user.json`, `flashcards/podcasts.json`, `flashcards/cards/{module}.json`, `audio/{module}`, `media/{module}/{file}`.

The `.apkg` reader loads sql.js and fzstd from jsDelivr the first time you import a deck.
