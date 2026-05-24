// Toast notifications mounted into the `#toast-stack` container in
// index.html. Lightweight and dependency-free — kept as its own module
// so anywhere in the web bundle can `import { toast } from './ui/toast.js'`
// without dragging in main.js.
//
//   toast('Game saved.', { kind: 'success', timeoutMs: 2500 });
//
// Returns a `close()` function so callers can dismiss programmatically
// (e.g. after a retry succeeds).

let _toastSeq = 0;

export function toast(message, opts = {}) {
  const stack = document.getElementById('toast-stack');
  if (!stack) return () => {};
  const kind = opts.kind || 'info';
  const id = `toast-${++_toastSeq}`;
  const div = document.createElement('div');
  div.className = `toast toast-${kind}`;
  div.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  div.id = id;
  div.innerHTML = `
    <button class="toast-close" type="button" aria-label="Dismiss">×</button>
    <span class="toast-msg"></span>`;
  div.querySelector('.toast-msg').textContent = message;
  const close = () => { div.remove(); };
  div.querySelector('.toast-close').addEventListener('click', close);
  stack.appendChild(div);
  const timeoutMs = opts.timeoutMs ?? (kind === 'error' ? 8000 : 5000);
  if (timeoutMs > 0) setTimeout(close, timeoutMs);
  return close;
}
