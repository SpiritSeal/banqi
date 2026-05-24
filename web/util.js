// HTML-escape for inserting untrusted strings into `innerHTML` /
// template literals. Cheap, dependency-free, and idempotent on the
// already-escaped form (the regex won't match the entities it emits).
export function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
