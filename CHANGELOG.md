# Changelog

The version shows in small text on the quiz's opening screen, in the admin page header, and at `/api/health`.
Bump `version` in `package.json` with every pushed change.

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
