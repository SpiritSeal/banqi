// Help dialog wired to the global `?` shortcut. Uses `infoModal` for
// the dialog chrome; the body is the markup for the shortcut list.
//
// Bails out if another modal is already showing so a stray `?` while a
// confirm dialog is up doesn't stack a second overlay on top.

import { infoModal } from './modal.js';

export function showKeyboardHelp() {
  if (document.querySelector('.modal-overlay')) return;
  const html = `
    <p class="muted small" style="margin-top:0">Shortcuts work anywhere unless you're typing in a text field.</p>
    <dl class="kbd-help">
      <dt><kbd>?</kbd></dt>            <dd>Show this help</dd>
      <dt><kbd>Esc</kbd></dt>          <dd>Close a dialog</dd>
      <dt><kbd>Tab</kbd></dt>          <dd>Move focus between controls</dd>
    </dl>
    <h3 class="kbd-help-section">Move history (in a game)</h3>
    <dl class="kbd-help">
      <dt><kbd>←</kbd> / <kbd>→</kbd></dt><dd>Previous / next move</dd>
      <dt><kbd>↑</kbd> / <kbd>↓</kbd></dt><dd>Jump to first move / return to live</dd>
    </dl>
    <h3 class="kbd-help-section">Board (when a cell is focused)</h3>
    <dl class="kbd-help">
      <dt><kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd></dt><dd>Move focus between cells</dd>
      <dt><kbd>Home</kbd> / <kbd>End</kbd></dt><dd>Jump to row start / end</dd>
      <dt><kbd>Enter</kbd> / <kbd>Space</kbd></dt><dd>Flip, select, or move to the focused cell</dd>
    </dl>`;
  infoModal({ title: 'Keyboard shortcuts', html });
}
