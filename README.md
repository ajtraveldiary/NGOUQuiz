# Arivu Quiz

Mobile-first quiz game on **Cloudflare Workers + Neon Postgres**.

- Player card asks for a name (or nickname), one of Kerala's 14 districts and, optionally, an office name (government employees fill it in; members of the public leave it blank). No phone number. The leaderboard shows the office and district under each name. A player is known by the key saved on their phone → rules card → 3‑2‑1 countdown → 10 timed questions → score, rank and Top 10.
- Questions march from easy to hard (default 4 easy, 4 medium, 2 hard, picked at random from the pool every game). Option order is shuffled per player so "the answer is B" can't be passed around.
- Scoring per right answer: **level points + speed bonus + streak bonus**
  - Level points: easy 100, medium 150, hard 200
  - Speed bonus: level points × (seconds left ÷ time limit)
  - Streak bonus: +25 for each answer in a row after the first, capped at +100
  - Wrong answer: negative marks (easy −25, medium −40, hard −50, editable in Settings). A game score never goes below 0
  - Skip button or time out: 0, no marks lost
  - Skip opens 5 seconds into each question and takes two taps (the first shows "Tap again to skip"), so it isn't pressed by accident
  - Wrong, skipped or timed out: the streak resets and the right answer is shown in green
- Timing is measured **on the server**, so the score can't be faked from the browser. Refreshing the page doesn't reset the clock.
- Leaderboard ranks each player's **best** game; ties go to the faster total time. Kerala-wide and per-district boards.
- Hidden admin page: insights, question pool (add / edit / hide; download and import Excel or CSV), all players with every game and answer, void cheating games, CSV exports, game settings.

## Project layout

```
public/            game frontend (served as static assets)
  index.html  app.js  style.css  favicon.svg
src/index.js       Worker: API + admin routes
src/admin.html     admin page (bundled into the Worker, not a public file)
db/schema.sql      tables
db/seed.sql        205 starter questions in Malayalam (Political, Constitution, KSR & Govt rules, General political)
db/seed-questions.json  same questions as JSON (edit + `npm run seed:build`)
scripts/           local server, API tests, demo build
```

## Deploy (about 15 minutes)

1. **Neon**: create a project at neon.tech (choose region *AWS Asia Pacific (Singapore)* for Kerala). Copy the connection string (Dashboard → Connect → "Pooled connection"). The Worker creates the tables itself.
2. **Cloudflare**:
   ```bash
   npm install
   npx wrangler login
   npx wrangler secret put DATABASE_URL     # paste the Neon connection string
   npx wrangler secret put APP_SECRET       # any random 32+ character string
   npx wrangler secret put ADMIN_PASSWORD   # admin page password
   ```
3. In `wrangler.toml`, change `ADMIN_PATH` to a path only your team knows.
4. `npm run deploy`. When it finishes, it prints the game's web address (also shown in the Cloudflare dashboard under *Workers & Pages*). The admin page is that address followed by `/` and your `ADMIN_PATH`.
5. Optional: Workers → your worker → *Settings → Domains & Routes* to add your own domain.

## Try it locally without Neon

```bash
npm install
npm run local        # http://localhost:8787 — admin at /admin-desk, password "admin"
npm test             # end-to-end API tests on an in-memory Postgres
```

## Admin page

| Tab | What you can do |
|---|---|
| Insights | Players, games, completion rate, average score; games per day; players and average score by district; right-answers spread; accuracy by level; play time of day (IST); hardest questions (check these for a wrong answer key) |
| Questions | Search and filter; add / edit (2–6 options, Malayalam works); hide or delete (questions already answered are hidden instead, so history stays); **Download Excel**, edit, and **Import Excel / CSV** (rows keep their id, so they update the same questions) |
| Players & scores | Search by name; filter by district; open a player to see every game and every answer; void a game to remove it from the board |
| Settings | Questions per level; seconds per question; points; streak bonus; attempts per player; open/close the quiz; show explanations |

**Import columns** (Excel or CSV UTF‑8): `id, difficulty, category, topic, question, option_a … option_f, correct (A–F), explanation, active (yes/no)`. A row with an id updates that question; a row without one updates the question with exactly the same text, or is added. Use *Download Excel* on the Questions page to get the current pool in this format.

## Database setup and upgrades are automatic

On its first request the Worker creates any missing tables, upgrades older databases and loads the Malayalam starter questions if the pool is empty. Questions retired by an upgrade are hidden, never deleted, so past games keep their answers. Running `db/schema.sql` by hand is optional.

## Game structure

- 10 questions: 6 Political, 1 Constitution, 2 KSR & Govt rules, 1 General political (Settings → Question mix), ordered 4 easy → 4 medium → 2 hard.
- The opening screen text is fixed in `public/index.html`; only the play count and top score come from the server.

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
| Admin page | 300 per internet address (plus 8 wrong passwords per 15 minutes) |

Over the limit, the game shows "Too many requests. Wait a minute and try again." Per-address limits are generous on purpose: many phones on one mobile network, or one office, can share an address. The limits live in `wrangler.toml` (`[[ratelimits]]`, Cloudflare Workers Rate Limiting) and in `LIMITS` in `src/index.js` (used if the Cloudflare limits are missing); keep the two in step. Changes sent from other websites are refused.

`npm run load 150` plays 150 full games at once against an in-memory database and checks every stored score.

## Troubleshooting

Open the game's address followed by `/api/health`. It reports whether the database connects, the number of questions and players, and whether `APP_SECRET` and `ADMIN_PASSWORD` are set. If something is wrong it says what to fix, for example a wrong `DATABASE_URL`.

## Before launch

- Give rephrased versions of one fact the same *topic tag* so they never appear in the same game.
- Set *Attempts per player* if prizes are involved (e.g. 3).
- Players are not verified (no phone number, no OTP). If prizes are significant, use *Void this game* for any misuse.
