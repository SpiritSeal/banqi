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

// AI agents exposed in the lobby. Keep keys in sync with `Difficulty`
// in ../ai/index.mjs (family.version) — these are display labels only.
// The "Banqi AI · " prefix is added by the surrounding UI (badge/chip)
// so labels here are just the family + version portion.
export const AI_DIFFICULTY_LABELS = {
  '1.1': 'Random v1',
  '2.1': 'Greedy v1',
  '3.1': 'Minimax v1',
  '3.2': 'Minimax v2',
  '3.3': 'Minimax v3',
  '4.1': 'Policy v1',
};
export function aiDifficultyLabel(d) { return AI_DIFFICULTY_LABELS[d] || (d || ''); }

