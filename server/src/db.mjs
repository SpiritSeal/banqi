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
  // The schema is idempotent (CREATE TABLE / INDEX IF NOT EXISTS), but
  // concurrent first-time bootstraps still race on pg_type / pg_class — the
  // SERIAL columns implicitly create sequence types, and existence checks
  // are not atomic with the catalog insert. Serialize via a Postgres
  // advisory lock keyed off a stable hash so multiple workers / test files
  // / processes coordinate correctly.
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

// Anonymize, don't hard-delete. The users table is referenced by games,
// messages, elo_history, and finalize_claims (all non-cascading) — wiping a
// row would orphan opponents' rating history and break head-to-head queries.
// Instead we strip PII (display name + avatar) and rotate the OAuth tuple so
// the same provider account, on signing in again, gets a fresh user row.
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

export async function createGame(db, { roomCode, mode, hostUserId }) {
  const now = Date.now();
  const { rows } = await db.query(`
    INSERT INTO games (room_code, mode, host_user_id, status, created_at)
    VALUES ($1, $2, $3, 'waiting', $4)
    RETURNING *
  `, [roomCode, mode, hostUserId, now]);
  return rows[0];
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
//                   the game (and any messages) is hard-deleted.
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

// ---------- Messages ----------

export async function appendMessage(db, { gameId, senderUserId, body }) {
  const now = Date.now();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Lock the game row to serialize concurrent appends for the same game.
    await client.query('SELECT id FROM games WHERE id = $1 FOR UPDATE', [gameId]);
    const { rows: [{ seq }] } = await client.query(
      'SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM messages WHERE game_id = $1',
      [gameId]
    );
    await client.query(`
      INSERT INTO messages (game_id, seq, sender_user_id, body, created_at)
      VALUES ($1, $2, $3, $4, $5)
    `, [gameId, seq, senderUserId, body, now]);
    await client.query('UPDATE games SET last_move_at = $1 WHERE id = $2', [now, gameId]);
    await client.query('COMMIT');
    return seq;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function listMessages(db, gameId, sinceSeq = 0) {
  const { rows } = await db.query(`
    SELECT seq, sender_user_id, body, created_at
      FROM messages
     WHERE game_id = $1 AND seq >= $2
     ORDER BY seq ASC
  `, [gameId, sinceSeq]);
  return rows;
}

// ---------- Finalize / Elo ----------

export async function recordFinalizeClaim(db, { gameId, userId, winnerColor, tipHash }) {
  const now = Date.now();
  const { rows } = await db.query(`
    INSERT INTO finalize_claims (game_id, user_id, winner_color, tip_hash, created_at)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (game_id, user_id) DO NOTHING
    RETURNING *
  `, [gameId, userId, winnerColor, tipHash, now]);
  if (rows.length > 0) return rows[0];
  const { rows: existing } = await db.query(
    'SELECT * FROM finalize_claims WHERE game_id = $1 AND user_id = $2',
    [gameId, userId]
  );
  return existing[0];
}

export async function getFinalizeClaims(db, gameId) {
  const { rows } = await db.query(
    'SELECT * FROM finalize_claims WHERE game_id = $1 ORDER BY user_id',
    [gameId]
  );
  return rows;
}

export async function applyFinalResult(db, { gameId, winnerColor, winnerUserId, tipHash, status }) {
  const now = Date.now();
  await db.query(`
    UPDATE games
       SET status = $1, winner_color = $2, winner_user_id = $3,
           tip_hash = $4, ended_at = $5
     WHERE id = $6
  `, [status, winnerColor, winnerUserId, tipHash, now, gameId]);
}

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

export async function topLeaderboard(db, limit = 50) {
  const { rows } = await db.query(`
    SELECT u.id, u.display_name, u.avatar_url, u.elo,
           (SELECT COUNT(*)::int FROM elo_history e WHERE e.user_id = u.id AND e.result = 'win')  AS wins,
           (SELECT COUNT(*)::int FROM elo_history e WHERE e.user_id = u.id AND e.result = 'loss') AS losses
      FROM users u
     WHERE EXISTS (SELECT 1 FROM elo_history e WHERE e.user_id = u.id)
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
