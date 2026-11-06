# Changelog

The version shows in small text on the quiz's opening screen, in the admin page header, and at `/api/health`.
Bump `version` in `package.json` with every pushed change.

## 2.8.0
- Link preview picture: sharing the quiz link on WhatsApp, Facebook, Telegram and others shows a 1200×630 card (`public/og-image.jpg`, 72 KB) with the union flag and torch, "Kerala NGO Union presents അറിവ് Quiz", the tagline and the Secretariat Valayal date. The title sits in the middle, so it still shows when WhatsApp crops the picture to a square
- The Worker fills in the site's full address in the page's preview tags (apps ignore a picture without one), so it works on workers.dev and on any custom domain; `run_worker_first` in wrangler.toml sends just the page through the Worker, which keeps the page's security headers
- The card is `scripts/og-card.html`; after changing it, run `python scripts/build-og-image.py` (needs Google Chrome and Pillow)

## 2.7.1
Security fixes from a site-wide check:
- Admin password tries are limited to 10 a minute per internet address (new rate limit `RL_LOGIN`), on top of the 8-wrong-tries lockout
- `/api/health` is limited to 20 a minute per address (`RL_HEALTH`); it counts every table, so it could be used to run up database reads
- CSV exports keep text that starts with `=`, `+`, `-` or `@` as text (a leading `'`), so a player's name or office can't run as an Excel formula
- The admin page's address is now the `ADMIN_PATH` secret instead of a line in the public wrangler.toml; without the secret there is no admin page
- Content-Security-Policy on the game page (public/_headers) and the admin page (only its own script, by hash), and neither page can be shown inside another site
- The admin login form can never put the password in the address bar, even if the page's script fails to run
- Development tools updated (wrangler 4.156.1); `npm audit` finds no known vulnerabilities

## 2.7.0
- Data moves from Neon Postgres to Cloudflare D1 (database `ngouquiz`, binding `DB` in wrangler.toml), so the whole quiz runs in one Cloudflare account. `DATABASE_URL` is no longer used
- Every query is rewritten for SQLite; the game, scoring, timing, leaderboard, admin page and exports work as before. Many-row writes (starter questions, question import, areas) go as one statement each, within D1's limits
- `npm run export:neon` (scripts/export-neon.mjs) copies everything from Neon into `db/neon-export.sql` for `wrangler d1 execute`; a copied 2.x database (version 11) gets the 1.9.1 fixes on its first `/api/health`
- The admin page is back at `/desk-ydxesk4m` (2.6.0 had brought back the 1.9.1 address `/union-control-room`)
- Tests, the local server and the load test run on a D1 stand-in built on Node's own SQLite (scripts/d1-sqlite.mjs) instead of PGlite, and now also run from folders with spaces in their path

## 2.6.0
- Back to the 1.9.1 quiz: every file is as it was in 1.9.1 (commit 9496849), so 2.0.0–2.5.1 are undone — the Kerala NGO Union branding, bonus question, phone/office/area player card, districts & areas page and the earlier colours return
- Database version 12 puts back what 2.x removed from an existing database: the `areas` table and the players' `area` column, Thiruvananthapuram North/South, the questions hidden in 2.0.0 and the campaign flag on the starter bonus questions
- Not recoverable by the upgrade: the players deleted in 2.1.0, the phone numbers and offices erased in 2.0.0, the areas that were in the admin page, and the campaign flag on bonus questions added by hand. Players who joined during 2.x keep their saved player card and scores and show on the leaderboard without an office
- Local `wrangler dev` starts again: the Worker no longer exports plain values (`VERSION`, `DISTRICTS`, `DEFAULT_SETTINGS`), which the Workers runtime refuses as entrypoints

## 2.5.1
- Opening screen tagline is now "അവകാശം അറിയണം. / ചരിത്രം മറക്കരുത്." The link preview picture keeps the old tagline

## 2.5.0
- Link preview picture: sharing the quiz link on WhatsApp (and Telegram, Facebook and others) shows a 1200×630 card with the അറിവ് logo, QUIZ and the tagline on the teal background (`public/og-image.jpg`, 54 KB)
- The Worker fills in the site's full address in the page's link-preview tags (they must be complete addresses), so the picture keeps working on workers.dev and on any custom domain. `run_worker_first` in wrangler.toml sends just the page through the Worker

## 2.4.0
- Leaderboard: under each name, the office and district ("Taluk Office, Kottarakkara, Kollam"), or just the district when no office was given; on the Kerala board and the district boards. Long offices wrap (up to three lines on the podium, two in the list) instead of being cut off
- Player card helper text now says the office shows under the name on the leaderboard

## 2.3.0
- Player card: an optional "Office name" field after the district, with the helper text "Government employees: the office where you work. Members of the public: leave it blank." A blank office is stored as empty
- The office shows on the admin Players page (and its search) and in the leaderboard, games and players exports; it is never shown on the public leaderboard

## 2.2.0 — Kerala colours
- New colour theme for the game and the admin page: deep backwater teal background, kasavu gold for the main buttons, timer and score, handloom cream cards, paddy green for right answers and laterite red-brown for wrong ones; pale mint for secondary text. Replaces the maroon and red palette
- The results badge, welcome line, avatar and rank number use teal and gold (red-brown now only means a wrong answer, a hard question or time running out)
- Text and button colours meet the 4.5:1 contrast guideline (white on the right and wrong answer colours included)
- Browser bar colour, favicon and confetti follow the new palette

## 2.1.0
- All players registered before this version are deleted, with their games and answers; the leaderboard and play count start again from zero. A phone that still remembers a deleted player is asked to fill in a new player card
- The admin page no longer has the Districts & areas tab; areas are gone from the database, the Insights page, the Players filter and every export. Players still choose a district

## 2.0.0 — unbranded
- No organisation or event on any screen: the flag and emblem, the organisation line, the event countdown card, the results card and the event wording in the share message are removed. Page title and link previews say only "Arivu Quiz"
- No bonus question: every game is 10 questions. The bonus switch, filter, question tick box and Excel column are removed from the admin page
- 27 questions retired: the bonus questions and the questions that name an organisation. 205 remain. On an existing database they are hidden (not deleted), so past games keep their answers
- Player card: only a name (or nickname) and a district. No phone number, office or area is asked or stored; a player is known by the key saved on their phone, and each new card is a new player. The leaderboard shows the name and district only
- Kerala's 14 districts (Thiruvananthapuram is one district again; existing players and areas are merged)
- Results badges: Expert / Well informed / Good effort / Keep learning. Rules screen: "Welcome."
- Neutral favicon; the admin address changed (see wrangler.toml `ADMIN_PATH`); project renamed `arivu-quiz`
- Settings that are no longer used (organisation line, tagline, values, event details, bonus switch) are removed from the database
- Phone numbers and offices saved by earlier versions are erased from the database, and removed from the admin page and every export

Earlier versions: see the git history.
