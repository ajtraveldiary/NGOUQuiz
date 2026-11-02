# Arivu Quiz — Kerala NGO Union campaign quiz

Mobile-first quiz game on **Cloudflare Workers + D1** (Cloudflare's SQLite database). Everything runs in one Cloudflare account.

- Player card (name, office, district, area, mobile). 15 union districts, with Thiruvananthapuram split into North and South; areas under each district are managed from the admin page → rules card → 3‑2‑1 countdown → 10 timed questions → score, rank and Top 10.
- Questions march from easy to hard (default 4 easy, 4 medium, 2 hard, picked at random from the pool every game). Option order is shuffled per player so "the answer is B" can't be passed around.
- Scoring per right answer: **level points + speed bonus + streak bonus**
  - Level points: easy 100, medium 150, hard 200
  - Speed bonus: level points × (seconds left ÷ time limit)
  - Streak bonus: +25 for each answer in a row after the first, capped at +100
  - Wrong answer: negative marks (easy −25, medium −40, hard −50, editable in Settings). A game score never goes below 0
  - Skip button or time out: 0, no marks lost
  - Skip takes two taps (the first shows "Tap again to skip") and stays locked for a moment as each question appears, so it isn't pressed by accident
  - Wrong, skipped or timed out: the streak resets and the right answer is shown in green
- Timing is measured **on the server**, so the score can't be faked from the browser. Refreshing the page doesn't reset the clock.
- Leaderboard ranks each player's **best** game; ties go to the faster total time. Kerala-wide and per-district boards.
- Hidden admin page: insights, question pool (add / edit / hide / CSV import), all players with every game and answer, void cheating games, CSV exports, game settings.

## Project layout

```
public/            game frontend (served as static assets)
  index.html  app.js  style.css  favicon.svg
src/index.js       Worker: API + admin routes
src/admin.html     admin page (bundled into the Worker, not a public file)
db/schema.sql      tables (D1 / SQLite)
db/seed.sql        232 starter questions in Malayalam (Political, Constitution, KSR & Govt rules, General political; 21 bonus questions on the Secretariat Valayal)
db/seed-questions.json  same questions as JSON (edit + `npm run seed:build`)
scripts/           local server, API tests, demo build, one-time Neon export
```

## Deploy (about 15 minutes)

1. **Cloudflare**:
   ```bash
   npm install
   npx wrangler login
   npx wrangler d1 create ngouquiz --location apac   # then put the printed database_id in wrangler.toml ([[d1_databases]], binding "DB")
   npx wrangler secret put APP_SECRET       # any random 32+ character string
   npx wrangler secret put ADMIN_PASSWORD   # admin page password
   npx wrangler secret put ADMIN_PATH       # the admin page's address, e.g. ngou-desk-4831 (no admin page without it)
   ```
2. The Worker creates the tables and loads the starter questions itself on its first request.
3. `npm run deploy`. When it finishes, it prints the game's web address (also shown in the Cloudflare dashboard under *Workers & Pages → ngouquiz*). The admin page is that address followed by `/` and your `ADMIN_PATH`.
4. Optional: Workers → your worker → *Settings → Domains & Routes* to add `quiz.keralangounion.in`.

## Try it locally

```bash
npm install
npm run local        # http://localhost:8787 — admin at /union-control-room, password "admin"
npm test             # end-to-end API tests on an in-memory D1 stand-in (Node's built-in SQLite, Node 22.5+)
```

`npm run dev` runs the real Worker with a local D1 database (kept in `.wrangler/`); it needs `APP_SECRET`, `ADMIN_PASSWORD` and `ADMIN_PATH` in a `.dev.vars` file.

## Admin page

| Tab | What you can do |
|---|---|
| Insights | Players, games, completion rate, average score; games per day; players and average score by district; right-answers spread; accuracy by level; play time of day (IST); hardest questions (check these for a wrong answer key) |
| Districts & areas | Add areas under each of the 15 districts (paste a comma-separated list), rename (also updates players who chose it) or delete. A district with no areas skips the area question |
| Questions | Search and filter; add / edit (2–6 options, Malayalam works); hide or delete (questions already answered are hidden instead, so history stays); import CSV |
| Players & scores | Search by name, office or phone; filter by district; open a player to see every game and every answer; void a game to remove it from the board |
| Settings | Questions per level; seconds per question; points; streak bonus; attempts per player; open/close the quiz; show explanations |

**CSV format** for importing questions (UTF‑8):

```
difficulty,category,question,option_a,option_b,option_c,option_d,correct,explanation
easy,Kerala,How many districts does Kerala have?,12,14,15,16,B,Kerala has 14 districts.
```

Use *Settings → Questions CSV* to download the current pool in the same format.

## Database setup and upgrades are automatic

On its first request the Worker creates any missing tables and loads the Malayalam starter questions if the pool is empty. A database copied from a 2.x Neon database (version 11) is put back to the 1.9.1 quiz once: "Thiruvananthapuram" players move to "Thiruvananthapuram North", and the bonus questions hidden in 2.0.0 are shown again. Running `db/schema.sql` by hand is optional.

## Moving the data from Neon (once)

Until 2.7.0 the quiz kept its data in Neon Postgres. To copy it into D1 (players, games, answers, questions with admin edits, settings, areas):

```powershell
$env:DATABASE_URL = "postgresql://…"   # the Neon connection string
npm run export:neon                    # writes db/neon-export.sql
npx wrangler d1 execute ngouquiz --remote --file=db/neon-export.sql
```

The file replaces everything in the D1 database. Then open `/api/health` once (it finishes any upgrade) and delete `db/neon-export.sql`, which holds players' phone numbers. Keep the same `APP_SECRET` as before if players should keep their saved player cards (only on the same web address).

## Game structure

- 10 regular questions: 6 Political, 1 Constitution, 2 KSR & Govt rules, 1 General political (Settings → Question mix), ordered 4 easy → 4 medium → 2 hard.
- Then 1 bonus question about the campaign programme (questions ticked "Bonus question about the campaign"). Never more than one per game; a wrong bonus answer loses no marks.
- Campaign countdown and card (name, date, place, message, demands) are fixed in `public/index.html`; only the countdown is worked out in `public/app.js` (`CAMPAIGN`), with no wait for the server.
- Question sources: `scripts/mix-questions.py` (Constitution, KSR, General political) and `scripts/valayal-questions.py` (brochure) write into `db/seed-questions.json`.

## Version

The version number shows in small text on the opening screen, in the admin header and at `/api/health`. It comes from `version` in `package.json`; see `CHANGELOG.md`. After changing it, run `npm run stamp` so `public/index.html` and its file links carry the same version (the tests check this); an old page left open in a browser then reloads itself once.

## Protection against bots

Every request is checked against a per-minute limit before the database is touched:

| What | Limit per minute |
|---|---|
| Opening-screen data (settings, leaderboard) | 120 per internet address |
| Player cards | 20 per internet address |
| Game requests | 600 per internet address |
| New games | 10 per player |
| Questions, answers, results | 90 per player |
| Admin page | 300 per internet address; password tries 10 per address (plus 8 wrong passwords per 15 minutes) |
| Health check (`/api/health`) | 20 per internet address |

Over the limit, the game shows "Too many requests. Wait a minute and try again." Per-address limits are generous on purpose: many phones on one mobile network, or one office, can share an address. The limits live in `wrangler.toml` (`[[ratelimits]]`, Cloudflare Workers Rate Limiting) and in `LIMITS` in `src/index.js` (used if the Cloudflare limits are missing); keep the two in step. Changes sent from other websites are refused.

`npm run load 150` plays 150 full games at once against an in-memory D1 stand-in and checks every stored score.

## Troubleshooting

Open the game's address followed by `/api/health`. It reports whether the database connects, the number of questions, players and areas, and whether `APP_SECRET` and `ADMIN_PASSWORD` are set. If something is wrong it says what to fix, for example a missing D1 binding.

## Before launch

- **Review the 61 Malayalam starter questions** with the union's committee. Give rephrased versions of one fact the same *topic tag* so they never appear in the same game.
- Set *Attempts per player* if prizes are involved (e.g. 3).
- Players are identified by mobile number without OTP. If prizes are significant, verify winners by phone before announcing, and use *Void this game* for any misuse.
- Add the union areas for each district under *Districts & areas*.
- Optionally add a Cloudflare rate-limiting rule on `/api/` (Security → WAF) for very high traffic.
