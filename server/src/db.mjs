// SQLite access. One connection per process; better-sqlite3 is synchronous,
// which matches Node's single-threaded model just fine for this workload.

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function openDb(file) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const schema = readFileSync(join(__dirname, '..', 'schema.sql'), 'utf8');
  db.exec(schema);
  return db;
}

// ---------- Users ----------

export function upsertOAuthUser(db, { provider, providerId, displayName, avatarUrl }) {
  const now = Date.now();
  const existing = db.prepare(
    'SELECT * FROM users WHERE provider = ? AND provider_id = ?'
  ).get(provider, providerId);
  if (existing) {
    db.prepare(
      'UPDATE users SET display_name = ?, avatar_url = ? WHERE id = ?'
    ).run(displayName, avatarUrl, existing.id);
    return db.prepare('SELECT * FROM users WHERE id = ?').get(existing.id);
  }
  const r = db.prepare(`
    INSERT INTO users (provider, provider_id, display_name, avatar_url, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(provider, providerId, displayName, avatarUrl, now);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid);
}

export function getUser(db, id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

// ---------- Games ----------

export function createGame(db, { roomCode, mode, hostUserId }) {
  const now = Date.now();
  const r = db.prepare(`
    INSERT INTO games (room_code, mode, host_user_id, status, created_at)
    VALUES (?, ?, ?, 'waiting', ?)
  `).run(roomCode, mode, hostUserId, now);
  return db.prepare('SELECT * FROM games WHERE id = ?').get(r.lastInsertRowid);
}

export function findGameByRoom(db, roomCode) {
  return db.prepare('SELECT * FROM games WHERE room_code = ?').get(roomCode);
}

export function findGameById(db, id) {
  return db.prepare('SELECT * FROM games WHERE id = ?').get(id);
}

export function joinGame(db, gameId, joinUserId) {
  const now = Date.now();
  const r = db.prepare(`
    UPDATE games
       SET join_user_id = ?, status = 'playing', last_move_at = ?
     WHERE id = ? AND join_user_id IS NULL AND host_user_id != ?
  `).run(joinUserId, now, gameId, joinUserId);
  return r.changes > 0;
}

export function listGamesForUser(db, userId, { status, limit = 50 } = {}) {
  const params = [userId, userId];
  let sql = `
    SELECT g.*, hu.display_name AS host_name, ju.display_name AS join_name
      FROM games g
      JOIN users hu ON hu.id = g.host_user_id
      LEFT JOIN users ju ON ju.id = g.join_user_id
     WHERE (g.host_user_id = ? OR g.join_user_id = ?)`;
  if (status) {
    sql += ' AND g.status = ?';
    params.push(status);
  }
  sql += ' ORDER BY COALESCE(g.last_move_at, g.created_at) DESC LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params);
}

// ---------- Messages ----------

export function appendMessage(db, { gameId, senderUserId, body }) {
  const now = Date.now();
  const next = db.prepare(
    'SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM messages WHERE game_id = ?'
  ).get(gameId).seq;
  db.prepare(`
    INSERT INTO messages (game_id, seq, sender_user_id, body, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(gameId, next, senderUserId, body, now);
  db.prepare('UPDATE games SET last_move_at = ? WHERE id = ?').run(now, gameId);
  return next;
}

export function listMessages(db, gameId, sinceSeq = 0) {
  return db.prepare(`
    SELECT seq, sender_user_id, body, created_at
      FROM messages
     WHERE game_id = ? AND seq >= ?
     ORDER BY seq ASC
  `).all(gameId, sinceSeq);
}

// ---------- Finalize / Elo ----------

export function recordFinalizeClaim(db, { gameId, userId, winnerColor, tipHash }) {
  const now = Date.now();
  // INSERT OR IGNORE: first claim per user wins.
  db.prepare(`
    INSERT OR IGNORE INTO finalize_claims
      (game_id, user_id, winner_color, tip_hash, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(gameId, userId, winnerColor, tipHash, now);
  return db.prepare(
    'SELECT * FROM finalize_claims WHERE game_id = ? AND user_id = ?'
  ).get(gameId, userId);
}

export function getFinalizeClaims(db, gameId) {
  return db.prepare(
    'SELECT * FROM finalize_claims WHERE game_id = ? ORDER BY user_id'
  ).all(gameId);
}

export function applyFinalResult(db, { gameId, winnerColor, winnerUserId,
                                       tipHash, status }) {
  const now = Date.now();
  db.prepare(`
    UPDATE games
       SET status = ?, winner_color = ?, winner_user_id = ?,
           tip_hash = ?, ended_at = ?
     WHERE id = ?
  `).run(status, winnerColor, winnerUserId, tipHash, now, gameId);
}

export function recordEloChange(db, { userId, gameId, opponentId,
                                      eloBefore, eloAfter, result }) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO elo_history
      (user_id, game_id, opponent_id, elo_before, elo_after, delta, result, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, gameId, opponentId, eloBefore, eloAfter, eloAfter - eloBefore, result, now);
  db.prepare('UPDATE users SET elo = ? WHERE id = ?').run(eloAfter, userId);
}

// ---------- Leaderboard / profile ----------

export function topLeaderboard(db, limit = 50) {
  return db.prepare(`
    SELECT u.id, u.display_name, u.avatar_url, u.elo,
           (SELECT COUNT(*) FROM elo_history e WHERE e.user_id = u.id AND e.result = 'win')  AS wins,
           (SELECT COUNT(*) FROM elo_history e WHERE e.user_id = u.id AND e.result = 'loss') AS losses
      FROM users u
     WHERE EXISTS (SELECT 1 FROM elo_history e WHERE e.user_id = u.id)
     ORDER BY u.elo DESC
     LIMIT ?
  `).all(limit);
}

export function headToHead(db, userId) {
  return db.prepare(`
    SELECT opponent_id,
           (SELECT display_name FROM users WHERE id = e.opponent_id) AS opponent_name,
           SUM(CASE WHEN result = 'win'  THEN 1 ELSE 0 END) AS wins,
           SUM(CASE WHEN result = 'loss' THEN 1 ELSE 0 END) AS losses,
           SUM(CASE WHEN result = 'draw' THEN 1 ELSE 0 END) AS draws
      FROM elo_history e
     WHERE user_id = ?
     GROUP BY opponent_id
     ORDER BY (wins + losses + draws) DESC
  `).all(userId);
}
