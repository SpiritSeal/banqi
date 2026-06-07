// HTML-escape for inserting untrusted strings into `innerHTML` /
// template literals. Cheap, dependency-free, and idempotent on the
// already-escaped form (the regex won't match the entities it emits).
export function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// First letter of a display name, uppercased, for avatar initials.
// Strips emoji / punctuation so we land on a letter when one is
// available; otherwise falls back to `?`.
export function initialsFor(name) {
  const ch = String(name || '').replace(/[^\p{L}\p{N}]+/gu, '').charAt(0);
  return ch ? ch.toUpperCase() : '?';
}

// The game variants the engine supports. `normMode` is the safe entry
// point everywhere we read a mode from a form, URL, or storage —
// unknown values silently snap to 'standard' rather than blowing up
// the engine.
export const GAME_MODES = ['standard', 'capture_general'];
export function normMode(m) { return GAME_MODES.includes(m) ? m : 'standard'; }
export function modeLabel(m) {
  return m === 'capture_general' ? 'Capture the General' : 'Standard';
}

// AI strengths exposed in the lobby. Keep keys in sync with `Difficulty`
// in ../ai/index.mjs — these are display labels only.
export const AI_DIFFICULTY_LABELS = {
  easy: 'Easy', medium: 'Medium', hard: 'Hard', expert: 'Expert', master: 'Master',
  policy: 'Policy', grand: 'Grandmaster',
};
export function aiDifficultyLabel(d) { return AI_DIFFICULTY_LABELS[d] || (d || ''); }

