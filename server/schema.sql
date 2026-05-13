-- Banqi server-authoritative game schema. PostgreSQL.
-- Applied idempotently via CREATE TABLE/INDEX IF NOT EXISTS on startup.

CREATE TABLE IF NOT EXISTS users (
  id              SERIAL  PRIMARY KEY,
  provider        TEXT    NOT NULL,                          -- 'github' | 'google' | 'dev' | 'guest'
  provider_id     TEXT    NOT NULL,
  display_name    TEXT    NOT NULL,
  avatar_url      TEXT,
  elo             INTEGER NOT NULL DEFAULT 1200,
  created_at      BIGINT  NOT NULL,
  UNIQUE(provider, provider_id)
);

CREATE TABLE IF NOT EXISTS games (
  id              SERIAL  PRIMARY KEY,
  room_code       TEXT    NOT NULL UNIQUE,
  host_user_id    INTEGER NOT NULL REFERENCES users(id),
  join_user_id    INTEGER          REFERENCES users(id),
  status          TEXT    NOT NULL,                            -- 'waiting' | 'playing' | 'complete' | 'abandoned'
  winner_color    INTEGER,                                     -- 1=red, 2=black, NULL=unfinished
  winner_user_id  INTEGER          REFERENCES users(id),
  created_at      BIGINT  NOT NULL,
  last_move_at    BIGINT,
  ended_at        BIGINT
);
CREATE INDEX IF NOT EXISTS idx_games_host   ON games(host_user_id);
CREATE INDEX IF NOT EXISTS idx_games_join   ON games(join_user_id);
CREATE INDEX IF NOT EXISTS idx_games_status ON games(status);

-- Latest authoritative state of each game. board_json is the C++ Game's
-- snapshot JSON: hidden deck + cell-by-cell state + turn metadata.
CREATE TABLE IF NOT EXISTS game_state (
  game_id    INTEGER PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
  board_json TEXT    NOT NULL,
  updated_at BIGINT  NOT NULL
);

-- Append-only audit log of accepted actions, in monotonic order per game.
-- Drives the replay UI and supports user-facing game review.
CREATE TABLE IF NOT EXISTS game_events (
  id              SERIAL  PRIMARY KEY,
  game_id         INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,
  ts              BIGINT  NOT NULL,
  mover           INTEGER NOT NULL,                            -- 0 = host, 1 = join
  payload_json    TEXT    NOT NULL,                            -- {action, revealed, capture, game_over, winner}
  UNIQUE(game_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_events_game ON game_events(game_id, seq);

CREATE TABLE IF NOT EXISTS elo_history (
  id              SERIAL  PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id),
  game_id         INTEGER NOT NULL REFERENCES games(id),
  opponent_id     INTEGER NOT NULL REFERENCES users(id),
  elo_before      INTEGER NOT NULL,
  elo_after       INTEGER NOT NULL,
  delta           INTEGER NOT NULL,
  result          TEXT    NOT NULL,                            -- 'win' | 'loss' | 'draw'
  created_at      BIGINT  NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_elo_user ON elo_history(user_id, created_at);

-- Drop legacy federated-relay tables if present. They're no longer used in
-- the server-authoritative model — moves are persisted via game_state +
-- game_events, and end-of-game claims are unnecessary now that the server
-- decides terminal state.
DROP TABLE IF EXISTS finalize_claims;
DROP TABLE IF EXISTS messages;
ALTER TABLE games DROP COLUMN IF EXISTS mode;
ALTER TABLE games DROP COLUMN IF EXISTS tip_hash;
