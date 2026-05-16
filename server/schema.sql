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

-- Per-side "remove from my dashboard" flags. Elo history references games(id)
-- non-cascading, so we soft-hide instead of hard-deleting completed games.
-- Hard delete is reserved for waiting games where no opponent ever joined
-- (see deleteGameForUser in db.mjs).
ALTER TABLE games ADD COLUMN IF NOT EXISTS hidden_for_host BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE games ADD COLUMN IF NOT EXISTS hidden_for_join BOOLEAN NOT NULL DEFAULT FALSE;

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
  status          TEXT    NOT NULL,                            -- 'pending' | 'accepted' | 'declined' | 'cancelled'
  game_id         INTEGER          REFERENCES games(id),       -- non-null once accepted
  created_at      BIGINT  NOT NULL,
  expires_at      BIGINT  NOT NULL,
  responded_at    BIGINT,
  CHECK (from_user_id <> to_user_id)
);
CREATE INDEX IF NOT EXISTS idx_mreq_to_pending   ON match_requests(to_user_id,   status);
CREATE INDEX IF NOT EXISTS idx_mreq_from_pending ON match_requests(from_user_id, status);

-- Web Push subscriptions for "your turn" notifications. A user may install the
-- PWA on multiple devices (phone, laptop, etc.); each device gets its own row.
-- Endpoint is the per-device push service URL; (p256dh, auth) are the keys the
-- browser hands us during subscription. We delete rows on 404/410 from the
-- push service so dead endpoints don't accumulate.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id              SERIAL  PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint        TEXT    NOT NULL,
  p256dh          TEXT    NOT NULL,
  auth            TEXT    NOT NULL,
  created_at      BIGINT  NOT NULL,
  UNIQUE(user_id, endpoint)
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);

-- Drop legacy federated-relay tables / columns if present. The server-
-- authoritative model persists moves via game_state + game_events; end-of-
-- game claims are unnecessary now that the server decides terminal state;
-- and there's only one game mode.
DROP TABLE IF EXISTS finalize_claims;
DROP TABLE IF EXISTS messages;
ALTER TABLE games           DROP COLUMN IF EXISTS mode;
ALTER TABLE games           DROP COLUMN IF EXISTS tip_hash;
ALTER TABLE match_requests  DROP COLUMN IF EXISTS mode;
