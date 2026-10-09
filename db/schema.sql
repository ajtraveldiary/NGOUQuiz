-- Arivu Quiz — Neon Postgres schema
-- Run once in the Neon SQL editor (or: psql "$DATABASE_URL" -f db/schema.sql)

CREATE TABLE IF NOT EXISTS players (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  office      TEXT,                          -- not collected since v10 (kept for earlier players)
  district    TEXT NOT NULL,
  phone       TEXT UNIQUE,                   -- not collected since v10 (kept for earlier players)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS players_district_idx ON players (district);

CREATE TABLE IF NOT EXISTS questions (
  id             SERIAL PRIMARY KEY,
  question       TEXT NOT NULL,
  options        JSONB NOT NULL,              -- array of 2–6 option strings
  correct_index  SMALLINT NOT NULL,           -- index into options (0-based)
  difficulty     TEXT NOT NULL CHECK (difficulty IN ('easy','medium','hard')),
  category       TEXT,
  topic          TEXT,                        -- questions sharing a topic never appear in the same game
  campaign       BOOLEAN NOT NULL DEFAULT false, -- no longer used (always false since v10)
  explanation    TEXT,                        -- shown after answering
  active         BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS questions_pick_idx ON questions (difficulty) WHERE active;

CREATE TABLE IF NOT EXISTS games (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id      INT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  question_ids   INT[] NOT NULL,
  option_orders  JSONB NOT NULL,              -- per-question shuffle of option indexes
  config         JSONB NOT NULL,              -- scoring rules snapshot at game start
  current_index  INT NOT NULL DEFAULT 0,
  served_at      TIMESTAMPTZ,                 -- when the current question was shown
  score          INT NOT NULL DEFAULT 0,
  correct_count  INT NOT NULL DEFAULT 0,
  total_ms       INT NOT NULL DEFAULT 0,      -- total answering time (tie-breaker)
  streak         INT NOT NULL DEFAULT 0,
  best_streak    INT NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'playing' CHECK (status IN ('playing','finished','void')),
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS games_player_idx ON games (player_id);
CREATE INDEX IF NOT EXISTS games_board_idx  ON games (score DESC, total_ms ASC) WHERE status = 'finished';

CREATE TABLE IF NOT EXISTS answers (
  game_id       UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  q_index       INT NOT NULL,
  question_id   INT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  chosen_index  SMALLINT,                     -- original option index; NULL = time ran out
  is_correct    BOOLEAN NOT NULL,
  time_ms       INT NOT NULL,
  points        INT NOT NULL,                 -- negative for a wrong answer (negative marking)
  skipped       BOOLEAN NOT NULL DEFAULT false,
  answered_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (game_id, q_index)
);
CREATE INDEX IF NOT EXISTS answers_question_idx ON answers (question_id);

CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  JSONB NOT NULL
);

-- ---- Upgrades for databases created with an earlier version (safe to re-run) ----
ALTER TABLE answers ADD COLUMN IF NOT EXISTS skipped BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE questions ADD COLUMN IF NOT EXISTS topic TEXT;
ALTER TABLE questions ADD COLUMN IF NOT EXISTS campaign BOOLEAN NOT NULL DEFAULT false;
-- v10: only a name and district are collected; Thiruvananthapuram is one district again
ALTER TABLE players ALTER COLUMN office DROP NOT NULL;
ALTER TABLE players ALTER COLUMN phone DROP NOT NULL;
UPDATE players SET district = 'Thiruvananthapuram' WHERE district IN ('Thiruvananthapuram North', 'Thiruvananthapuram South');
-- v11: areas are no longer used
ALTER TABLE players DROP COLUMN IF EXISTS area;
DROP TABLE IF EXISTS areas;
