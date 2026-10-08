# Arivu Quiz — Kerala NGO Union campaign quiz

Mobile-first quiz game on **Cloudflare Workers + Neon Postgres**.

- Player card (name, office, district, mobile) → rules card → 3‑2‑1 countdown → 10 timed questions → score, rank and Top 10.
- Questions march from easy to hard (default 4 easy, 4 medium, 2 hard, picked at random from the pool every game). Option order is shuffled per player so "the answer is B" can't be passed around.
- Scoring per right answer: **level points + speed bonus + streak bonus**
  - Level points: easy 100, medium 150, hard 200
  - Speed bonus: level points × (seconds left ÷ time limit)
  - Streak bonus: +25 for each answer in a row after the first, capped at +100
  - Wrong answer or time out: 0 and the streak resets. The right answer is shown in green.
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
db/seed.sql        36 starter questions (12 per level)
db/seed-questions.json  same questions as JSON (edit + `npm run seed:build`)
scripts/           local server, API tests, demo build
```

## Deploy (about 15 minutes)

1. **Neon**: create a project at neon.tech (choose region *AWS Asia Pacific (Singapore)* for Kerala). Open *SQL Editor* and run `db/schema.sql`, then `db/seed.sql`. Copy the connection string (Dashboard → Connect → "Pooled connection").
2. **Cloudflare**:
   ```bash
   npm install
   npx wrangler login
   npx wrangler secret put DATABASE_URL     # paste the Neon connection string
   npx wrangler secret put APP_SECRET       # any random 32+ character string
   npx wrangler secret put ADMIN_PASSWORD   # admin page password
   ```
3. In `wrangler.toml`, change `ADMIN_PATH` to a path only your team knows (e.g. `ngou-desk-4831`).
4. `npm run deploy`. The game is at `https://ngo-union-quiz.<your-subdomain>.workers.dev/`, the admin page at `/<ADMIN_PATH>`.
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
| Questions | Search and filter; add / edit (2–6 options, Malayalam works); hide or delete (questions already answered are hidden instead, so history stays); import CSV |
| Players & scores | Search by name, office or phone; filter by district; open a player to see every game and every answer; void a game to remove it from the board |
| Settings | Title, organisation line, tagline, values shown on the welcome screen; questions per level; seconds per question; points; streak bonus; attempts per player; open/close the quiz; show explanations |

**CSV format** for importing questions (UTF‑8):

```
difficulty,category,question,option_a,option_b,option_c,option_d,correct,explanation
easy,Kerala,How many districts does Kerala have?,12,14,15,16,B,Kerala has 14 districts.
```

Use *Settings → Questions CSV* to download the current pool in the same format.

## Before launch

- **Review the 36 starter questions** with the union's committee and replace or extend them. A pool of 30+ per level keeps games fresh.
- Set *Attempts per player* if prizes are involved (e.g. 3).
- Players are identified by mobile number without OTP. If prizes are significant, verify winners by phone before announcing, and use *Void this game* for any misuse.
- Optionally add a Cloudflare rate-limiting rule on `/api/` (Security → WAF) for very high traffic.
