-- Kerala NGO Union Quiz — Cloudflare D1 (SQLite) schema
-- The Worker runs this itself when the database is new; by hand: npx wrangler d1 execute ngouquiz --remote --file=db/schema.sql
-- Times are ISO text in UTC (2026-11-02T05:30:00.000Z); lists and settings are JSON text; true/false are 1/0.

CREATE TABLE IF NOT EXISTS players (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  office      TEXT,                          -- required on the player card; empty for players who joined in 2.x
  district    TEXT NOT NULL,
  area        TEXT,                          -- union area within the district (optional)
  phone       TEXT UNIQUE,                   -- 10-digit Indian mobile, digits only; empty for players who joined in 2.x
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS players_district_idx ON players (district);

CREATE TABLE IF NOT EXISTS questions (
  id             INTEGER PRIMARY KEY,
  question       TEXT NOT NULL,
  options        TEXT NOT NULL,               -- JSON array of 2–6 option strings
  correct_index  INTEGER NOT NULL,            -- index into options (0-based)
  difficulty     TEXT NOT NULL CHECK (difficulty IN ('easy','medium','hard')),
  category       TEXT,
  topic          TEXT,                        -- questions sharing a topic never appear in the same game
  campaign       INTEGER NOT NULL DEFAULT 0,  -- about the campaign programme: one per game, at the campaign slot
  explanation    TEXT,                        -- shown after answering
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS questions_pick_idx ON questions (difficulty) WHERE active;

CREATE TABLE IF NOT EXISTS games (
  id             TEXT PRIMARY KEY,            -- UUID, made by the Worker
  player_id      INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  question_ids   TEXT NOT NULL,               -- JSON array of question ids
  option_orders  TEXT NOT NULL,               -- JSON: per-question shuffle of option indexes
  config         TEXT NOT NULL,               -- JSON: scoring rules snapshot at game start
  current_index  INTEGER NOT NULL DEFAULT 0,
  served_at      TEXT,                        -- when the current question was shown
  score          INTEGER NOT NULL DEFAULT 0,
  correct_count  INTEGER NOT NULL DEFAULT 0,
  total_ms       INTEGER NOT NULL DEFAULT 0,  -- total answering time (tie-breaker)
  streak         INTEGER NOT NULL DEFAULT 0,
  best_streak    INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'playing' CHECK (status IN ('playing','finished','void')),
  started_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at    TEXT
);
CREATE INDEX IF NOT EXISTS games_player_idx ON games (player_id);
CREATE INDEX IF NOT EXISTS games_board_idx  ON games (score DESC, total_ms ASC) WHERE status = 'finished';

CREATE TABLE IF NOT EXISTS answers (
  game_id       TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  q_index       INTEGER NOT NULL,
  question_id   INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  chosen_index  INTEGER,                      -- original option index; NULL = time ran out
  is_correct    INTEGER NOT NULL,
  time_ms       INTEGER NOT NULL,
  points        INTEGER NOT NULL,             -- negative for a wrong answer (negative marking)
  skipped       INTEGER NOT NULL DEFAULT 0,
  answered_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (game_id, q_index)
);
CREATE INDEX IF NOT EXISTS answers_question_idx ON answers (question_id);

-- Game settings (single row, key = 'game') and the database version (key = 'schema_version'); value is JSON
CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

-- Union areas under each district (managed from the admin page)
CREATE TABLE IF NOT EXISTS areas (
  id          INTEGER PRIMARY KEY,
  district    TEXT NOT NULL,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (district, name)
);
