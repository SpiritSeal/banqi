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

export async function createGame(db, { roomCode, hostUserId }) {
  const now = Date.now();
  const { rows } = await db.query(`
    INSERT INTO games (room_code, host_user_id, status, created_at)
    VALUES ($1, $2, 'waiting', $3)
    RETURNING *
  `, [roomCode, hostUserId, now]);
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
     WHERE (g.host_user_id = $1 OR g.join_user_id = $2)`;
  if (status) {
    params.push(status);
    sql += ` AND g.status = $${params.length}`;
  }
  params.push(limit);
  sql += ` ORDER BY COALESCE(g.last_move_at, g.created_at) DESC LIMIT $${params.length}`;
  const { rows } = await db.query(sql, params);
  return rows;
}

export async function markGameEnded(db, gameId, winnerColor) {
  const now = Date.now();
  // Resolve winner_user_id from winner_color + host/join.
  const game = await findGameById(db, gameId);
  if (!game) return false;
  if (game.status === 'complete') return false;
  let winnerUserId = null;
  if (winnerColor === 1 || winnerColor === 2) {
    // The first flip assigns color → player_index. The engine state knows
    // who's which; we infer here by listing events and finding the first
    // flip's revealed color, but it's simpler to look at game_state. For
    // now, callers updating elo will resolve this independently — store
    // winner_color, leave winner_user_id null and let the elo updater fill it.
  }
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
