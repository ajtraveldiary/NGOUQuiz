# Changelog

The version shows in small text on the quiz's opening screen, in the admin page header, and at `/api/health`.
Bump `version` in `package.json` with every pushed change.

## 1.8.0 — protection against bots, full test pass
- Rate limits, checked before the database is touched. Requests per minute: 120 reads (settings, leaderboard) and 20 player cards per internet address; 600 game requests per address; 10 new games and 90 questions/answers/results per player; 300 admin requests per address. Over the limit the server answers 429 "Too many requests. Wait a minute and try again." Uses Cloudflare's rate-limit bindings (`[[ratelimits]]` in wrangler.toml), with a counter inside the Worker as a fallback. Per-address limits are generous because many phones on one mobile network or office share an address
- Changes (POST) from other websites are refused
- The settings and the public leaderboard are reused for 10 seconds inside the Worker instead of read from the database on every visit (cleared when a game finishes, a new player registers or an admin saves)
- Results: database work runs in 2 parallel batches instead of 7 steps one after another
- Fix: the leaderboard screen could show the list from before your game for up to 15 seconds (browser cache); it is now always fresh
- Flag emblem 21 KB instead of 58 KB (`logo.webp`, sized for the screen)
- "See the leaderboard" link is easier to tap (44 px)
- `npm run load [players]`: plays full games for many players at once and checks the stored results

## 1.7.2
- Opening screen: the "days to go" number counts up from 0, like the stats

## 1.7.1
- Opening screen stats are fixed text in the page: "0 employees have played so far / Top score 0." Only the numbers change, counting up once the data arrives ("You’re #N" is added for a player on the board). No saved copy on the phone any more

## 1.7.0 — smoother on low-powered phones
- Question timer: the ring is a single CSS animation instead of being redrawn by script about 60 times a second; the number updates once a second
- The flag waves three times when the page opens, then rests
- Confetti: half as many pieces, drawn at a lower resolution
- Light mode for weak phones: no endless or decorative motion and no confetti. It turns on for phones that report 2 GB of memory or less, 2 processor cores or fewer, or Data Saver, for reduced motion, or when a quick speed test after loading shows a phone roughly 6x slower than a laptop
- One font file fewer (Big Shoulders 700 was only used by inheritance)
- Server: a new question takes 1 database round trip instead of 3, an answer 2 instead of 4

## 1.6.19
- Smoother loading:
  - Opening screen: the player's button and the last known stats show straight away; the stats keep their space, so "Play now" no longer jumps down when they arrive, and they fade in when they change. The stats request runs alongside the settings request instead of after it
  - Starting a game: the 3-2-1 countdown starts at once while the server sets up the game
  - Between questions: a double tap on Next can't ask for the question twice; Next shows "Loading…" if the next question is slow
  - Results: the placeholder badge and stats stay hidden until the real result arrives

## 1.6.18
- Opening screen stats reworded: "3 employees have played so far" and "Top score 1,348. You’re #1" (the play count is unchanged; the "on the board" count is no longer shown)

## 1.6.17
- Fix: on screens taller than the phone (e.g. the opening screen with the play count), the background glow repeated and left a hard line across the page. The background is now a fixed layer that fills the screen and doesn't scroll with the page

## 1.6.16
- Opening screen: "Kerala NGO Union / presents" moves up under the flag, beside the pole, to save space

## 1.6.15
- Opening screen: once it has fully loaded, the page scrolls to "Play now" if the button is below the screen. It doesn't move if the button is already visible or the player has scrolled or tapped

## 1.6.14
- Opening screen tagline always breaks after the first sentence; the text shrinks slightly on very narrow phones so it stays on two lines

## 1.6.13
- Opening screen: total plays above the leaderboard line ("123 plays so far"). Every game started counts, and so does filling in the player card: a player who registered but never started a game counts once. Voided games don't count

## 1.6.12
- Opening screen: the values row (Solidarity, Democracy, Secularism, People-centred public service) is removed

## 1.6.11
- Secretariat Valayal ticket and results card are fixed in the page and show at once with the rest of the opening screen; only the days-to-go countdown is worked out in the browser, with no wait for the database
- Campaign fields removed from admin Settings

## 1.6.10
- Opening screen: "Kerala NGO Union" and "presents" on two lines, closer to the Arivu logotype

## 1.6.9
- Opening screen tagline: "നമുക്ക് അറിവ് നേടാം. അധികാരികൾ തിരിച്ചറിവ് നേടട്ടെ.."
- `wrangler.toml`: worker name is `ngouquiz`, matching the worker on Cloudflare (Workers Builds)

## 1.6.8
- Opening screen: "Kerala NGO Union presents"
- The opening screen's title, organisation line, tagline and values are fixed in the page; they no longer come from the database, and their fields are removed from admin Settings

## 1.6.7
- Opening screen: "Arivu" in the title is now the Malayalam logotype (`public/arivu-title.webp`); "Quiz" stays below it

## 1.6.6
- How to play: the English "Example: …" box is removed

## 1.6.5
- Game rules rewritten in short Malayalam (5 lines); the numbers still follow Settings
- The negative-marks line is hidden when negative marking is off; the replay line follows "Attempts per player"

## 1.6.4
- Fix: the Skip button was easy to press by accident during a game
- Skip now takes two taps: the first turns it into "Tap again to skip" (it resets after 3 seconds); a fast double-tap doesn't count
- Skip is locked for the first moment of each question, so a tap meant for "Next question" can't land on it
- Rules screen says "Tap Skip twice"

## 1.6.3
- Fix: after an update, a returning player's browser could mix the old cached page with the new code, and the site stopped loading (no districts, no scores)
- The page is never cached; app.js and style.css links carry the version (`?v=1.6.3`), so every update loads matching files
- If an old page is still open, it reloads itself once to the new version
- The campaign section can no longer stop the rest of the page from starting
- `npm run stamp` writes the package.json version into index.html (tests check it)

## 1.6.2
- 27 brochure questions reworded as standalone questions: no "ലഘുലേഖ പ്രകാരം" or "…എന്ന് ലഘുലേഖ പറയുന്നു"; explanations updated too
- Existing databases get the new wording automatically, once (questions edited in the admin page are left alone)

## 1.6.1
- Database upgrade sends only the questions that are missing, instead of the whole pool
- If adding questions fails, the quiz keeps running on the existing questions; /api/health shows the error (`questionUpgrade`) and the database version
- robots.txt allows /api/health so the status page can be checked remotely

## 1.6.0 — Secretariat Valayal campaign
- Opening screen: countdown ticket for the Secretariat Valayal (Saturday, 21 November 2026, Thiruvananthapuram); new tagline
- Results: campaign card with the 7 demands; share text invites colleagues to join on 21 November
- Bonus question: after the 10 regular questions, one question about the Secretariat Valayal programme (never more than one per game); a wrong bonus answer loses no marks
- Question mix per game: 6 Political, 1 Constitution, 2 KSR & Govt rules, 1 General political (editable percentages in Settings); difficulty stays 4 easy, 4 medium, 2 hard
- 171 new Malayalam questions: 95 from the Action Council brochure (21 about the programme, 74 background), 26 Constitution, 27 KSR & Kerala government rules, 23 General political (LDF government achievements). Pool: 232 questions
- Admin: campaign settings (name, date, place, message, demands), bonus switch, question mix, bonus flag and filter for questions
- New questions are added to an existing database automatically, once

## 1.5.1
- All 61 starter questions are in the Political category (questions already in the database are updated automatically)

## 1.5.0
- New Malayalam question pool: 61 questions (24 easy, 27 medium, 10 hard) on NPS, OPS and the employees' pension struggle; the old English questions are removed automatically on first deploy (one time only)
- Anek Malayalam font for the game and admin page; long questions use a slightly smaller size
- Topic tags: rephrased versions of the same fact never appear in the same game (editable in the question editor and CSV `topic` column)
- Sound button scrolls with the page so it no longer covers the streak counter

## 1.4.3
- Organisation line now reads "Kerala NGO Union" (saved admin settings are updated automatically)

## 1.4.2
- Smaller emblem on the flag, with space on every side

## 1.4.1
- Kerala NGO Union torch emblem on the waving flag on the opening screen (`public/logo.png`)

## 1.4.0
- Negative marking: a wrong answer loses marks (easy 25, medium 40, hard 50; editable in admin Settings, 0 turns it off). A game score never goes below 0
- Skip button at the bottom of each question: no marks lost, the right answer is shown
- Running out of time loses no marks
- Results show wrong, skipped and marks lost; admin shows skips per question and in player history; games CSV adds Wrong, Skipped and Marks lost

## 1.3.0
- Version number shown on the opening screen, admin header and `/api/health`

## 1.2.1
- Database tables are created and upgraded automatically; starter questions load into an empty pool
- Clear error messages for database setup problems; new `/api/health` check page

## 1.2.0
- 15 districts: Thiruvananthapuram split into North and South
- Area question after District; admin "Districts & areas" page to manage areas
- Area filter, area insights and Area column in CSV exports

## 1.1.0
- 15 seconds per question (was 20)

## 1.0.0
- First release: registration, rules, 10 timed questions, scoring, leaderboard, admin panel
