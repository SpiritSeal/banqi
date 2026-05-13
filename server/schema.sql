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

-- Per-side "remove from my dashboard" flags. Elo history references games(id)
-- non-cascading, so we soft-hide instead of hard-deleting completed games.
-- Hard delete is reserved for waiting games where no opponent ever joined
-- (see deleteGameForUser in db.mjs).
ALTER TABLE games ADD COLUMN IF NOT EXISTS hidden_for_host BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE games ADD COLUMN IF NOT EXISTS hidden_for_join BOOLEAN NOT NULL DEFAULT FALSE;

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

-- Friendships. Stored canonically with user_lo < user_hi so a friendship is a
-- single row. Either side may unfriend; doing so breaks the link for both.
-- The "credential" to become someone's friend is their friend-invite URL,
-- an HMAC of (SERVER_SECRET, user_id); same trust model as a game room code.
CREATE TABLE IF NOT EXISTS friends (
  user_lo         INTEGER NOT NULL REFERENCES users(id),
  user_hi         INTEGER NOT NULL REFERENCES users(id),
  created_at      BIGINT  NOT NULL,
  PRIMARY KEY (user_lo, user_hi),
  CHECK (user_lo < user_hi)
);
CREATE INDEX IF NOT EXISTS idx_friends_lo ON friends(user_lo);
CREATE INDEX IF NOT EXISTS idx_friends_hi ON friends(user_hi);

-- Directed match invitations. On accept the route handler creates the
-- games row + auto-joins the acceptor, then writes back game_id and
-- status='accepted' in the same transaction. Eligibility (friends OR
-- prior head-to-head) is enforced at INSERT time in the route, not in SQL.
CREATE TABLE IF NOT EXISTS match_requests (
  id              SERIAL  PRIMARY KEY,
  from_user_id    INTEGER NOT NULL REFERENCES users(id),
  to_user_id      INTEGER NOT NULL REFERENCES users(id),
  mode            TEXT    NOT NULL,                            -- 'casual' | 'crypto'
  status          TEXT    NOT NULL,                            -- 'pending' | 'accepted' | 'declined' | 'cancelled'
  game_id         INTEGER          REFERENCES games(id),       -- non-null once accepted
  created_at      BIGINT  NOT NULL,
  expires_at      BIGINT  NOT NULL,
  responded_at    BIGINT,
  CHECK (from_user_id <> to_user_id)
);
CREATE INDEX IF NOT EXISTS idx_mreq_to_pending   ON match_requests(to_user_id,   status);
CREATE INDEX IF NOT EXISTS idx_mreq_from_pending ON match_requests(from_user_id, status);
