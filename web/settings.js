// Banqi settings: theme, board style, piece style, animations, sound.
// Persisted to localStorage under banqi.settings.v1. Applied to <body> via
// data attributes and class names so CSS can pick up the changes without a
// re-render.

const KEY = 'banqi.settings.v1';

const DEFAULTS = Object.freeze({
  theme: 'dark',         // dark | sepia
  boardStyle: 'classic', // classic | wood | minimal  (reserved; default for now)
  pieceStyle: 'glyph',   // glyph | minimal | large
  pieceNumbers: 'off',   // off | badge | full  (rank labels on captured-pieces pane)
  animations: 'on',      // on | off
  sound: 'on',           // on | off
});

const VALID = {
  theme:        ['dark', 'sepia'],
  boardStyle:   ['classic', 'wood', 'minimal'],
  pieceStyle:   ['glyph', 'minimal', 'large'],
  pieceNumbers: ['off', 'badge', 'full'],
  animations:   ['on', 'off'],
  sound:        ['on', 'off'],
};

let cached = null;

function load() {
  if (cached) return cached;
  let stored = null;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) stored = JSON.parse(raw);
  } catch (_) { /* corrupt / blocked storage — fall through to defaults */ }
  const out = { ...DEFAULTS };
  if (stored && typeof stored === 'object') {
    for (const k of Object.keys(DEFAULTS)) {
      if (VALID[k].includes(stored[k])) out[k] = stored[k];
    }
  }
  cached = out;
  return out;
}

function save(s) {
  cached = s;
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (_) {}
}

export function getSettings() { return { ...load() }; }

export function getSetting(key) { return load()[key]; }

export function setSetting(key, value) {
  if (!(key in DEFAULTS)) return;
  if (!VALID[key].includes(value)) return;
  const s = { ...load(), [key]: value };
  save(s);
  apply(s);
  window.dispatchEvent(new CustomEvent('banqi:settings-change', { detail: { key, value, settings: s } }));
}

export function isSoundEnabled() { return load().sound === 'on'; }
export function areAnimationsEnabled() {
  if (load().animations !== 'on') return false;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return false;
  return true;
}

function apply(s) {
  document.body.dataset.theme = s.theme;
  document.body.dataset.boardStyle = s.boardStyle;
  document.body.dataset.pieceStyle = s.pieceStyle;
  document.body.dataset.pieceNumbers = s.pieceNumbers;
  document.body.classList.toggle('no-anim', s.animations === 'off');
  document.body.classList.toggle('sound-off', s.sound === 'off');
  // Update theme-color meta so PWA chrome matches.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', s.theme === 'sepia' ? '#1d1611' : '#1c1c1e');
}

export function initSettings() { apply(load()); }

// ----- drawer UI -----

let drawerOpen = false;

export function openSettingsDrawer() {
  if (drawerOpen) return;
  drawerOpen = true;
  const root = document.getElementById('drawer-root');
  if (!root) return;

  const previouslyFocused = document.activeElement;
  const s = getSettings();

  const overlay = document.createElement('div');
  overlay.className = 'crib-drawer-overlay';

  const drawer = document.createElement('aside');
  drawer.className = 'crib-drawer settings-drawer';
  drawer.setAttribute('role', 'dialog');
  drawer.setAttribute('aria-modal', 'true');
  drawer.setAttribute('aria-labelledby', 'settings-title');
  drawer.tabIndex = -1;
  drawer.innerHTML = `
    <div class="crib-drawer-head">
      <h2 id="settings-title">Settings</h2>
      <button type="button" class="crib-drawer-close" aria-label="Close settings">×</button>
    </div>
    <div class="setting-row">
      <label for="setting-theme">
        <span class="setting-label">Theme</span>
        <span class="setting-hint">Visual palette</span>
      </label>
      <select id="setting-theme">
        <option value="dark">Dark</option>
        <option value="sepia">Sepia (warm)</option>
      </select>
    </div>
    <div class="setting-row">
      <label for="setting-piece">
        <span class="setting-label">Piece style</span>
        <span class="setting-hint">Layout of the piece glyph</span>
      </label>
      <select id="setting-piece">
        <option value="glyph">Glyph + rank</option>
        <option value="minimal">Glyph only</option>
        <option value="large">Large glyph</option>
      </select>
    </div>
    <div class="setting-row">
      <label for="setting-pnums">
        <span class="setting-label">Captured-pieces rank labels</span>
        <span class="setting-hint">Show rank numbers (1–7) on the pieces pane</span>
      </label>
      <select id="setting-pnums">
        <option value="off">Off (glyph only)</option>
        <option value="badge">Glyph + small rank</option>
        <option value="full">Glyph + rank + count</option>
      </select>
    </div>
    <div class="setting-row">
      <label for="setting-anim">
        <span class="setting-label">Animations</span>
        <span class="setting-hint">Piece flip, move and capture effects</span>
      </label>
      <label class="toggle-switch">
        <input id="setting-anim" type="checkbox">
        <span class="toggle-switch-slider"></span>
      </label>
    </div>
    <div class="setting-row">
      <label for="setting-sound">
        <span class="setting-label">Sound effects</span>
        <span class="setting-hint">Move clack and game-over chime</span>
      </label>
      <label class="toggle-switch">
        <input id="setting-sound" type="checkbox">
        <span class="toggle-switch-slider"></span>
      </label>
    </div>
  `;

  overlay.appendChild(drawer);
  root.appendChild(overlay);

  drawer.querySelector('#setting-theme').value = s.theme;
  drawer.querySelector('#setting-piece').value = s.pieceStyle;
  drawer.querySelector('#setting-pnums').value = s.pieceNumbers;
  drawer.querySelector('#setting-anim').checked = s.animations === 'on';
  drawer.querySelector('#setting-sound').checked = s.sound === 'on';

  const close = () => {
    if (!drawerOpen) return;
    drawerOpen = false;
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    try { previouslyFocused?.focus?.(); } catch (_) {}
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  };

  drawer.querySelector('.crib-drawer-close').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey, true);

  drawer.querySelector('#setting-theme').addEventListener('change', (e) => setSetting('theme', e.target.value));
  drawer.querySelector('#setting-piece').addEventListener('change', (e) => setSetting('pieceStyle', e.target.value));
  drawer.querySelector('#setting-pnums').addEventListener('change', (e) => setSetting('pieceNumbers', e.target.value));
  drawer.querySelector('#setting-anim').addEventListener('change', (e) => setSetting('animations', e.target.checked ? 'on' : 'off'));
  drawer.querySelector('#setting-sound').addEventListener('change', (e) => setSetting('sound', e.target.checked ? 'on' : 'off'));

  drawer.focus();
}

export function openRulesDrawer() {
  const root = document.getElementById('drawer-root');
  const tpl = document.getElementById('crib-template');
  if (!root || !tpl) return;
  if (document.querySelector('.crib-drawer.rules-drawer')) return; // already open

  const previouslyFocused = document.activeElement;
  const overlay = document.createElement('div');
  overlay.className = 'crib-drawer-overlay';

  const drawer = document.createElement('aside');
  drawer.className = 'crib-drawer rules-drawer';
  drawer.setAttribute('role', 'dialog');
  drawer.setAttribute('aria-modal', 'true');
  drawer.setAttribute('aria-labelledby', 'rules-title');
  drawer.tabIndex = -1;
  drawer.innerHTML = `
    <div class="crib-drawer-head">
      <h2 id="rules-title">Pieces &amp; rules</h2>
      <button type="button" class="crib-drawer-close" aria-label="Close rules">×</button>
    </div>
  `;
  drawer.appendChild(tpl.content.cloneNode(true));
  overlay.appendChild(drawer);
  root.appendChild(overlay);

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    try { previouslyFocused?.focus?.(); } catch (_) {}
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  };
  drawer.querySelector('.crib-drawer-close').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey, true);
  drawer.focus();
}
