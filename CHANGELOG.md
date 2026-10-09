# Changelog

The version shows in small text on the quiz's opening screen, in the admin page header, and at `/api/health`.
Bump `version` in `package.json` with every pushed change.

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
