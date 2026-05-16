// PostgreSQL access via the pg Pool. All functions are async.

import pkg from 'pg';
const { Pool, types } = pkg;
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// pg returns BIGINT (int8) columns as strings by default to avoid precision
// loss. Our BIGINT columns are epoch-ms timestamps and counts that fit safely
// in a JS Number, so parse them as integers globally.
types.setTypeParser(20, (val) => parseInt(val, 10));

export async function openDb(connectionString) {
  const pool = new Pool({ connectionString });
  const schema = readFileSync(join(__dirname, '..', 'schema.sql'), 'utf8');
  // Idempotent bootstrap serialized through a Postgres advisory lock so
  // multiple workers / test files / processes coordinate correctly.
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [0x42414e51]); // 'BANQ'
    try { await client.query(schema); }
    finally { await client.query('SELECT pg_advisory_unlock($1)', [0x42414e51]); }
  } finally {
    client.release();
  }
  return pool;
}

// ---------- Users ----------

export async function upsertOAuthUser(db, { provider, providerId, displayName, avatarUrl }) {
  const now = Date.now();
  const { rows } = await db.query(`
    INSERT INTO users (provider, provider_id, display_name, avatar_url, created_at)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (provider, provider_id) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      avatar_url   = EXCLUDED.avatar_url
    RETURNING *
  `, [provider, providerId, displayName, avatarUrl, now]);
  return rows[0];
}

export async function getUser(db, id) {
  const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

// Anonymize, don't hard-delete. The users table is referenced by games and
// elo_history; wiping a row would orphan opponents' rating history. Strip
// PII (display name + avatar) and rotate the OAuth tuple so the same provider
// account, on signing in again, gets a fresh user row.
export async function deleteUser(db, id) {
  const tag = `deleted-${id}-${Date.now()}`;
  const { rowCount } = await db.query(`
    UPDATE users
       SET display_name = '[deleted user]',
           avatar_url   = NULL,
           provider_id  = $1
     WHERE id = $2
  `, [tag, id]);
  return rowCount > 0;
}

// ---------- Games ----------

export async function createGame(db, { roomCode, hostUserId, mode = 'standard' }) {
  const now = Date.now();
  const { rows } = await db.query(`
    INSERT INTO games (room_code, host_user_id, status, mode, created_at)
    VALUES ($1, $2, 'waiting', $3, $4)
    RETURNING *
  `, [roomCode, hostUserId, normalizeMode(mode), now]);
  return rows[0];
}

// Whitelist the game-mode strings. Unknown / missing values collapse to
// 'standard' so a client sending garbage doesn't poison the DB row.
export function normalizeMode(m) {
  return m === 'capture_general' ? 'capture_general' : 'standard';
}

// Whitelist the first-mover preference. Anything not 'challenger' or
// 'opponent' collapses to 'random' so the row is always in {challenger,
// opponent, random}.
export function normalizeFirstMoverPref(p) {
  return p === 'challenger' || p === 'opponent' ? p : 'random';
}

// Resolve 'random' to a concrete seat index (0 = host/challenger, 1 = join/
// opponent). 'challenger' and 'opponent' map deterministically.
export function resolveFirstMoverIndex(pref) {
  if (pref === 'challenger') return 0;
  if (pref === 'opponent')   return 1;
  return Math.random() < 0.5 ? 0 : 1;
}

export async function findGameByRoom(db, roomCode) {
  const { rows } = await db.query('SELECT * FROM games WHERE room_code = $1', [roomCode]);
  return rows[0] || null;
}

export async function findGameById(db, id) {
  const { rows } = await db.query('SELECT * FROM games WHERE id = $1', [id]);
  return rows[0] || null;
}

export async function joinGame(db, gameId, joinUserId) {
  const now = Date.now();
  const { rowCount } = await db.query(`
    UPDATE games
       SET join_user_id = $1, status = 'playing', last_move_at = $2
     WHERE id = $3 AND join_user_id IS NULL AND host_user_id != $1
  `, [joinUserId, now, gameId]);
  return rowCount > 0;
}

export async function listGamesForUser(db, userId, { status, limit = 50 } = {}) {
  const params = [userId, userId];
  let sql = `
    SELECT g.*, hu.display_name AS host_name, ju.display_name AS join_name
      FROM games g
      JOIN users hu ON hu.id = g.host_user_id
      LEFT JOIN users ju ON ju.id = g.join_user_id
     WHERE (
             (g.host_user_id = $1 AND NOT g.hidden_for_host)
          OR (g.join_user_id = $2 AND NOT g.hidden_for_join)
           )`;
  if (status) {
    params.push(status);
    sql += ` AND g.status = $${params.length}`;
  }
  params.push(limit);
  sql += ` ORDER BY COALESCE(g.last_move_at, g.created_at) DESC LIMIT $${params.length}`;
  const { rows } = await db.query(sql, params);
  return rows;
}

// Remove a game from a user's dashboard.
//   - 'removed'   — host clicked delete on a waiting game with no opponent;
//                   the game (and its game_state / game_events rows via FK
//                   cascade) is hard-deleted.
//   - 'hidden'    — soft-hide for this user only. Elo history and the
//                   opponent's view are preserved.
//   - 'forbidden' — caller is not a player in this game.
//   - 'not_found' — no such game id.
export async function deleteGameForUser(db, gameId, userId) {
  const g = await findGameById(db, gameId);
  if (!g) return 'not_found';
  const isHost = g.host_user_id === userId;
  const isJoin = g.join_user_id === userId;
  if (!isHost && !isJoin) return 'forbidden';

  if (isHost && !g.join_user_id && g.status === 'waiting') {
    await db.query('DELETE FROM games WHERE id = $1', [gameId]);
    return 'removed';
  }
  const col = isHost ? 'hidden_for_host' : 'hidden_for_join';
  await db.query(`UPDATE games SET ${col} = TRUE WHERE id = $1`, [gameId]);
  return 'hidden';
}

export async function markGameEnded(db, gameId, winnerColor) {
  const now = Date.now();
  const game = await findGameById(db, gameId);
  if (!game) return false;
  if (game.status === 'complete') return false;
  await db.query(`
    UPDATE games
       SET status = 'complete', winner_color = $1, ended_at = $2
     WHERE id = $3
  `, [winnerColor || null, now, gameId]);
  return true;
}

export async function setGameWinnerUser(db, gameId, winnerUserId) {
  await db.query('UPDATE games SET winner_user_id = $1 WHERE id = $2',
                 [winnerUserId, gameId]);
}

// ---------- Game state + events ----------

export async function saveGameState(db, gameId, boardJson) {
  const now = Date.now();
  await db.query(`
    INSERT INTO game_state (game_id, board_json, updated_at)
    VALUES ($1, $2, $3)
    ON CONFLICT (game_id) DO UPDATE SET
      board_json = EXCLUDED.board_json,
      updated_at = EXCLUDED.updated_at
  `, [gameId, boardJson, now]);
  await db.query('UPDATE games SET last_move_at = $1 WHERE id = $2', [now, gameId]);
}

export async function loadGameState(db, gameId) {
  const { rows } = await db.query(
    'SELECT board_json FROM game_state WHERE game_id = $1', [gameId]);
  return rows[0]?.board_json || null;
}

export async function appendGameEvent(db, gameId, event) {
  const payload = JSON.stringify({
    action: event.action,
    revealed: event.revealed,
    capture: event.capture,
    game_over: event.game_over,
    winner: event.winner,
    draw_offered: event.draw_offered || false,
  });
  await db.query(`
    INSERT INTO game_events (game_id, seq, ts, mover, payload_json)
    VALUES ($1, $2, $3, $4, $5)
  `, [gameId, event.seq, event.ts, event.mover, payload]);
}

export async function listGameEvents(db, gameId) {
  const { rows } = await db.query(`
    SELECT seq, ts, mover, payload_json
      FROM game_events
     WHERE game_id = $1
     ORDER BY seq ASC
  `, [gameId]);
  return rows.map((r) => {
    const p = JSON.parse(r.payload_json);
    return { seq: r.seq, ts: r.ts, mover: r.mover, ...p };
  });
}

// ---------- Elo ----------

export async function recordEloChange(db, { userId, gameId, opponentId,
                                            eloBefore, eloAfter, result }) {
  const now = Date.now();
  await db.query(`
    INSERT INTO elo_history
      (user_id, game_id, opponent_id, elo_before, elo_after, delta, result, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `, [userId, gameId, opponentId, eloBefore, eloAfter, eloAfter - eloBefore, result, now]);
  await db.query('UPDATE users SET elo = $1 WHERE id = $2', [eloAfter, userId]);
}

// ---------- Leaderboard / profile ----------

// Guests don't appear on the leaderboard or in head-to-head queries: their
// accounts are ephemeral and not meant to accumulate a record.
export async function topLeaderboard(db, limit = 50) {
  const { rows } = await db.query(`
    SELECT u.id, u.display_name, u.avatar_url, u.elo,
           (SELECT COUNT(*)::int FROM elo_history e WHERE e.user_id = u.id AND e.result = 'win')  AS wins,
           (SELECT COUNT(*)::int FROM elo_history e WHERE e.user_id = u.id AND e.result = 'loss') AS losses
      FROM users u
     WHERE u.provider != 'guest'
       AND EXISTS (SELECT 1 FROM elo_history e WHERE e.user_id = u.id)
     ORDER BY u.elo DESC
     LIMIT $1
  `, [limit]);
  return rows;
}

export async function headToHead(db, userId) {
  const { rows } = await db.query(`
    SELECT e.opponent_id,
           u.display_name AS opponent_name,
           SUM(CASE WHEN e.result = 'win'  THEN 1 ELSE 0 END)::int AS wins,
           SUM(CASE WHEN e.result = 'loss' THEN 1 ELSE 0 END)::int AS losses,
           SUM(CASE WHEN e.result = 'draw' THEN 1 ELSE 0 END)::int AS draws
      FROM elo_history e
      JOIN users u ON u.id = e.opponent_id
     WHERE e.user_id = $1
     GROUP BY e.opponent_id, u.display_name
     ORDER BY wins + losses + draws DESC
  `, [userId]);
  return rows;
}

// ---------- Friends / Match requests ----------

// Symmetric add. Returns the friend's user row on success. Rejects self-add
// and is idempotent on a duplicate (returns the friend either way).
export async function addFriend(db, currentUserId, otherUserId) {
  if (currentUserId === otherUserId) return null;
  const now = Date.now();
  const lo = Math.min(currentUserId, otherUserId);
  const hi = Math.max(currentUserId, otherUserId);
  await db.query(`
    INSERT INTO friends (user_lo, user_hi, created_at)
    VALUES ($1, $2, $3)
    ON CONFLICT (user_lo, user_hi) DO NOTHING
  `, [lo, hi, now]);
  return getUser(db, otherUserId);
}

export async function listFriends(db, userId) {
  const { rows } = await db.query(`
    SELECT u.id, u.display_name, u.avatar_url, u.elo, f.created_at
      FROM friends f
      JOIN users u
        ON u.id = CASE WHEN f.user_lo = $1 THEN f.user_hi ELSE f.user_lo END
     WHERE f.user_lo = $1 OR f.user_hi = $1
     ORDER BY u.display_name ASC
  `, [userId]);
  return rows;
}

export async function areFriends(db, userId, otherId) {
  if (userId === otherId) return false;
  const lo = Math.min(userId, otherId);
  const hi = Math.max(userId, otherId);
  const { rowCount } = await db.query(
    'SELECT 1 FROM friends WHERE user_lo = $1 AND user_hi = $2',
    [lo, hi]
  );
  return rowCount > 0;
}

export async function removeFriend(db, userId, otherId) {
  const lo = Math.min(userId, otherId);
  const hi = Math.max(userId, otherId);
  const { rowCount } = await db.query(
    'DELETE FROM friends WHERE user_lo = $1 AND user_hi = $2',
    [lo, hi]
  );
  return rowCount > 0;
}

// Eligible to send a match request to `otherId`: either already friends, or
// has previously played them (any row in elo_history between the pair).
export async function isMatchEligible(db, userId, otherId) {
  if (userId === otherId) return false;
  if (await areFriends(db, userId, otherId)) return true;
  const { rowCount } = await db.query(`
    SELECT 1 FROM elo_history
     WHERE (user_id = $1 AND opponent_id = $2)
        OR (user_id = $2 AND opponent_id = $1)
     LIMIT 1
  `, [userId, otherId]);
  return rowCount > 0;
}

const MATCH_REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Idempotent create: if a pending non-expired row already exists from→to,
// returns it instead of inserting a duplicate (regardless of the new rule
// fields — a sender who wants different rules should cancel and resend).
export async function createMatchRequest(db, {
  fromUserId, toUserId,
  mode = 'standard', firstMoverPref = 'random', message = null,
}) {
  const now = Date.now();
  const expires = now + MATCH_REQUEST_TTL_MS;
  const { rows: existing } = await db.query(`
    SELECT * FROM match_requests
     WHERE from_user_id = $1 AND to_user_id = $2
       AND status = 'pending' AND expires_at > $3
     LIMIT 1
  `, [fromUserId, toUserId, now]);
  if (existing[0]) return existing[0];
  const { rows } = await db.query(`
    INSERT INTO match_requests
      (from_user_id, to_user_id, status, mode, first_mover_pref, message,
       created_at, expires_at)
    VALUES ($1, $2, 'pending', $3, $4, $5, $6, $7)
    RETURNING *
  `, [fromUserId, toUserId, normalizeMode(mode),
      normalizeFirstMoverPref(firstMoverPref), message, now, expires]);
  return rows[0];
}

export async function getMatchRequest(db, id) {
  const { rows } = await db.query(
    'SELECT * FROM match_requests WHERE id = $1', [id]
  );
  return rows[0] || null;
}

export async function listIncomingMatchRequests(db, userId) {
  const now = Date.now();
  const { rows } = await db.query(`
    SELECT mr.*, u.display_name AS from_name
      FROM match_requests mr
      JOIN users u ON u.id = mr.from_user_id
     WHERE mr.to_user_id = $1
       AND mr.status = 'pending'
       AND mr.expires_at > $2
     ORDER BY mr.created_at DESC
  `, [userId, now]);
  return rows;
}

export async function listOutgoingMatchRequests(db, userId) {
  const now = Date.now();
  const { rows } = await db.query(`
    SELECT mr.*, u.display_name AS to_name
      FROM match_requests mr
      JOIN users u ON u.id = mr.to_user_id
     WHERE mr.from_user_id = $1
       AND mr.status = 'pending'
       AND mr.expires_at > $2
     ORDER BY mr.created_at DESC
  `, [userId, now]);
  return rows;
}

export async function cancelMatchRequest(db, userId, requestId) {
  const now = Date.now();
  const { rowCount } = await db.query(`
    UPDATE match_requests
       SET status = 'cancelled', responded_at = $1
     WHERE id = $2 AND from_user_id = $3 AND status = 'pending'
  `, [now, requestId, userId]);
  return rowCount > 0;
}

export async function declineMatchRequest(db, userId, requestId) {
  const now = Date.now();
  const { rowCount } = await db.query(`
    UPDATE match_requests
       SET status = 'declined', responded_at = $1
     WHERE id = $2 AND to_user_id = $3 AND status = 'pending'
  `, [now, requestId, userId]);
  return rowCount > 0;
}

// Atomic accept: locks the request row, allocates a unique room code,
// creates the games row with the sender as host + the acceptor as the
// joined player (status='playing'), and marks the request 'accepted' with
// game_id set. The caller supplies `allocateRoomCode` (a sync function
// returning a fresh candidate code) so this module stays SQL-only.
//
// Returns `{ request, game }` on success, or `null` if the request was
// not pending / not addressed to this user / expired.
export async function acceptMatchRequest(db, userId, requestId, allocateRoomCode) {
  const now = Date.now();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: locked } = await client.query(
      'SELECT * FROM match_requests WHERE id = $1 FOR UPDATE',
      [requestId]
    );
    const req = locked[0];
    if (!req || req.to_user_id !== userId ||
        req.status !== 'pending' || req.expires_at <= now) {
      await client.query('ROLLBACK');
      return null;
    }
    // Allocate a room code with the same 5-retry pattern as routes/games.mjs.
    // The accepted game inherits the mode + first-mover preference chosen by
    // the sender on the request. 'random' is resolved to a concrete seat
    // index here so reconnects always see the same first-mover.
    const mode             = normalizeMode(req.mode);
    const firstMoverIndex  = resolveFirstMoverIndex(
      normalizeFirstMoverPref(req.first_mover_pref)
    );
    let game = null;
    for (let i = 0; i < 5; ++i) {
      try {
        const { rows: gRows } = await client.query(`
          INSERT INTO games
            (room_code, host_user_id, status, mode, first_mover_index, created_at)
          VALUES ($1, $2, 'waiting', $3, $4, $5)
          RETURNING *
        `, [allocateRoomCode(), req.from_user_id, mode, firstMoverIndex, now]);
        game = gRows[0];
        break;
      } catch (e) {
        if (i === 4) throw e;  // bubble up after exhausting retries
      }
    }
    // Auto-join the acceptor (the recipient is the join player).
    await client.query(`
      UPDATE games
         SET join_user_id = $1, status = 'playing', last_move_at = $2
       WHERE id = $3
    `, [userId, now, game.id]);
    game.join_user_id = userId;
    game.status       = 'playing';
    game.last_move_at = now;
    const { rows: updated } = await client.query(`
      UPDATE match_requests
         SET status = 'accepted', game_id = $1, responded_at = $2
       WHERE id = $3
       RETURNING *
    `, [game.id, now, requestId]);
    await client.query('COMMIT');
    return { request: updated[0], game };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ---------- Push subscriptions ----------

export async function savePushSubscription(db, { userId, endpoint, p256dh, auth }) {
  const now = Date.now();
  await db.query(`
    INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (user_id, endpoint) DO UPDATE SET
      p256dh = EXCLUDED.p256dh,
      auth   = EXCLUDED.auth
  `, [userId, endpoint, p256dh, auth, now]);
}

export async function deletePushSubscriptionByEndpoint(db, userId, endpoint) {
  await db.query(
    'DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2',
    [userId, endpoint]
  );
}

// Called when the push service tells us an endpoint is permanently gone
// (404/410). The user_id is not required to look it up; endpoints are unique
// enough in practice and we want to drop the row even if it doesn't match.
export async function deletePushSubscriptionByEndpointAnyUser(db, endpoint) {
  await db.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
}

export async function listPushSubscriptionsForUser(db, userId) {
  const { rows } = await db.query(
    'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1',
    [userId]
  );
  return rows;
}

export async function notificationCounts(db, userId) {
  const now = Date.now();
  const { rows } = await db.query(`
    SELECT COUNT(*)::int AS n
      FROM match_requests
     WHERE to_user_id = $1
       AND status = 'pending'
       AND expires_at > $2
  `, [userId, now]);
  return { incoming_match_requests: rows[0]?.n || 0 };
}
