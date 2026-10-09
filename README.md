# Arivu Quiz — Kerala NGO Union campaign quiz

Mobile-first quiz game on **Cloudflare Workers + Neon Postgres**.

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
db/schema.sql      tables
db/seed.sql        232 starter questions in Malayalam (Political, Constitution, KSR & Govt rules, General political; 21 bonus questions on the Secretariat Valayal)
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
3. In `wrangler.toml`, change `ADMIN_PATH` to a path only your team knows (e.g. `ngou-desk-4831`).
4. `npm run deploy`. When it finishes, it prints the game's web address (also shown in the Cloudflare dashboard under *Workers & Pages → ngouquiz*). The admin page is that address followed by `/` and your `ADMIN_PATH`.
5. Optional: Workers → your worker → *Settings → Domains & Routes* to add `quiz.keralangounion.in`.

## Try it locally without Neon

```bash
npm install
npm run local        # http://localhost:8787 — admin at /union-control-room, password "admin"
npm test             # end-to-end API tests on an in-memory Postgres
```

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

On its first request the Worker creates any missing tables, upgrades older databases (adds areas, moves "Thiruvananthapuram" players to "Thiruvananthapuram North") and loads the Malayalam starter questions if the pool is empty (version 1.5.0 also replaced the old English questions once). Running `db/schema.sql` by hand is optional.

## Game structure

- 10 regular questions: 6 Political, 1 Constitution, 2 KSR & Govt rules, 1 General political (Settings → Question mix), ordered 4 easy → 4 medium → 2 hard.
- Then 1 bonus question about the campaign programme (questions ticked "Bonus question about the campaign"). Never more than one per game; a wrong bonus answer loses no marks.
- Campaign countdown and card (name, date, place, message, demands) are fixed in `public/index.html`; only the countdown is worked out in `public/app.js` (`CAMPAIGN`), with no wait for the server.
- Question sources: `scripts/mix-questions.py` (Constitution, KSR, General political) and `scripts/valayal-questions.py` (brochure) write into `db/seed-questions.json`.

## Version

The version number shows in small text on the opening screen, in the admin header and at `/api/health`. It comes from `version` in `package.json`; see `CHANGELOG.md`. After changing it, run `npm run stamp` so `public/index.html` and its file links carry the same version (the tests check this); an old page left open in a browser then reloads itself once.

## Troubleshooting

Open the game's address followed by `/api/health`. It reports whether the database connects, the number of questions, players and areas, and whether `APP_SECRET` and `ADMIN_PASSWORD` are set. If something is wrong it says what to fix, for example a wrong `DATABASE_URL`.

## Before launch

- **Review the 61 Malayalam starter questions** with the union's committee. Give rephrased versions of one fact the same *topic tag* so they never appear in the same game.
- Set *Attempts per player* if prizes are involved (e.g. 3).
- Players are identified by mobile number without OTP. If prizes are significant, verify winners by phone before announcing, and use *Void this game* for any misuse.
- Add the union areas for each district under *Districts & areas*.
- Optionally add a Cloudflare rate-limiting rule on `/api/` (Security → WAF) for very high traffic.
