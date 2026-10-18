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

Cloudflare Workers Builds deploys automatically on every push to the `claude` branch.
To deploy by hand instead:

```sh
npm install
npx wrangler secret put ADMIN_TOKEN   # only if you haven't set it before; pick a long random string
npx wrangler deploy
```

Then open the site, go to **Settings**, and sign in with that token on each device you use.
Anyone with the link can view; only someone with the token can upload, delete, or sync progress.

Run locally with `npx wrangler dev`.

## How it works

- **Studying.** Each card has its own schedule (FSRS-5). New cards go through two short steps (1 min, 10 min), then graduate to day-based reviews. Again on a review card sends it back for a 10 min relearning step and shortens its next interval. Hard, Good and Easy always give different intervals, and intervals get a small random spread so cards learned together don't all come back on the same day. Days roll over at 4am. Target recall (default 90%) sets how aggressive the intervals are.
- **More on demand.** New cards are capped per day (Settings, default 20). "Learn 10 more new" raises today's cap whenever you want, and "Review ahead" pulls in cards due in the next 3 days when nothing is due.
- **Later.** Hides a card for 24 hours without changing its schedule (a skipped new card doesn't use up a new-card slot). Undo works on it too.
- **Keyboard.** Space or tapping the card shows the answer (Space grades Good once it's shown), 1–4 grade, L = Later, Z undoes, Esc ends the session.
- **Podcasts** have their own schedule, separate from cards. After a listen, rate it Felt new, Familiar or Knew it well; the next listen is set for before you'd forget, and the gap grows when you know it (up to 6 months). The Podcasts tab lists what's due, new and coming up. Playback speed and position are remembered.
- **Your own content.** Podcasts → "Add your own podcast", or Library → Miscellaneous → "New topic", creates a topic of your own. Topics work like modules: a podcast slot and a flashcard slot, same schedules, synced. Rename or delete from the topic page.
- **Importing.** Re-importing the same Anki deck updates changed cards and adds new ones without touching your progress. Text files: one card per line, front and back separated by a tab or comma.
- **Storage and sync.** Everything is saved in the browser first (IndexedDB), then synced to R2 when you're signed in. Changes upload a few seconds after you make them; nothing to push by hand. Each device pulls the latest when it opens, when you come back to the tab, and every 2 minutes while it's open. When two devices changed the same module, they merge card by card (the most recent review of each card wins), so one device never overwrites another. Changes made offline or signed out wait in a queue and sync later.
- **Backup.** Settings has a JSON backup of all card text and review history (images and audio stay in R2).

R2 layout: `flashcards/user.json`, `flashcards/podcasts.json`, `flashcards/cards/{module}.json`, `audio/{module}`, `media/{module}/{file}`.

The `.apkg` reader loads sql.js and fzstd from jsDelivr the first time you import a deck.
