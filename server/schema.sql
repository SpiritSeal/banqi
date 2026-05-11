-- Banqi federated relay: schema. PostgreSQL.
-- Applied idempotently via CREATE TABLE/INDEX IF NOT EXISTS on startup.

CREATE TABLE IF NOT EXISTS users (
  id              SERIAL  PRIMARY KEY,
  provider        TEXT    NOT NULL,
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
  mode            TEXT    NOT NULL,                            -- 'casual' | 'crypto'
  host_user_id    INTEGER NOT NULL REFERENCES users(id),
  join_user_id    INTEGER          REFERENCES users(id),
  status          TEXT    NOT NULL,                            -- 'waiting' | 'playing' | 'complete' | 'disputed' | 'abandoned'
  winner_color    INTEGER,                                     -- 1=red, 2=black, NULL=unfinished
  winner_user_id  INTEGER          REFERENCES users(id),
  tip_hash        TEXT,
  created_at      BIGINT  NOT NULL,
  last_move_at    BIGINT,
  ended_at        BIGINT
);
CREATE INDEX IF NOT EXISTS idx_games_host   ON games(host_user_id);
CREATE INDEX IF NOT EXISTS idx_games_join   ON games(join_user_id);
CREATE INDEX IF NOT EXISTS idx_games_status ON games(status);

CREATE TABLE IF NOT EXISTS messages (
  id              SERIAL  PRIMARY KEY,
  game_id         INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,                            -- monotonic per game
  sender_user_id  INTEGER NOT NULL REFERENCES users(id),
  body            TEXT    NOT NULL,                            -- raw JSON line
  created_at      BIGINT  NOT NULL,
  UNIQUE(game_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_messages_game ON messages(game_id, seq);

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

-- finalize_claims collects game-over reports from both clients. When both rows
-- for a game agree, the server applies Elo and marks the game complete. If they
-- disagree, the game is marked 'disputed' with no rating change.
CREATE TABLE IF NOT EXISTS finalize_claims (
  id              SERIAL  PRIMARY KEY,
  game_id         INTEGER NOT NULL REFERENCES games(id),
  user_id         INTEGER NOT NULL REFERENCES users(id),
  winner_color    INTEGER,                                     -- 1, 2, or NULL for resign-with-no-flip
  tip_hash        TEXT    NOT NULL,
  created_at      BIGINT  NOT NULL,
  UNIQUE(game_id, user_id)
);
