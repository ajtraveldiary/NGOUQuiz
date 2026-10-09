# Changelog

The version shows in small text on the quiz's opening screen, in the admin page header, and at `/api/health`.
Bump `version` in `package.json` with every pushed change.

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
