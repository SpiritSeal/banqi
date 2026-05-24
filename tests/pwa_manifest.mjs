// Static validation of web/manifest.webmanifest and the related index.html
// tags. Catches the install-blocker mistakes (missing required fields, wrong
// icon sizes, dangling icon references) without needing a browser, server,
// or WASM build. Run with: node tests/pwa_manifest.mjs

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, '..', 'web');

const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
const ok   = (m) => console.log('  ok:', m);

// ---- manifest ----
let raw;
try { raw = await readFile(join(WEB_DIR, 'manifest.webmanifest'), 'utf-8'); }
catch { fail('web/manifest.webmanifest does not exist'); }

let manifest;
try { manifest = JSON.parse(raw); }
catch (e) { fail(`manifest.webmanifest is not valid JSON: ${e.message}`); }

const REQUIRED = ['name', 'short_name', 'start_url', 'scope', 'display',
                  'theme_color', 'background_color', 'icons'];
for (const f of REQUIRED) {
  if (manifest[f] == null) fail(`manifest missing required field: ${f}`);
}
ok('all required fields present');

if (!Array.isArray(manifest.icons) || manifest.icons.length === 0) {
  fail('manifest.icons must be a non-empty array');
}

const sizes = new Set(manifest.icons.map((i) => i.sizes));
if (!sizes.has('192x192')) fail('manifest needs an icon with sizes "192x192"');
if (!sizes.has('512x512')) fail('manifest needs an icon with sizes "512x512"');
ok('192x192 and 512x512 icons declared');

const hasMaskable = manifest.icons.some((i) => (i.purpose || '').split(/\s+/).includes('maskable'));
if (!hasMaskable) fail('manifest should include at least one maskable icon');
ok('maskable icon declared');

for (const icon of manifest.icons) {
  try { await readFile(join(WEB_DIR, icon.src)); }
  catch { fail(`icon file missing on disk: ${icon.src}`); }
}
ok(`${manifest.icons.length} icon files all exist on disk`);

// ---- index.html ----
const html = await readFile(join(WEB_DIR, 'index.html'), 'utf-8');

const checks = [
  { re: /<link[^>]+rel=["']manifest["'][^>]+href=["']manifest\.webmanifest["']/i,
    msg: '<link rel="manifest"> points to manifest.webmanifest' },
  { re: /<link[^>]+rel=["']apple-touch-icon["'][^>]+href=["']([^"']+)["']/i,
    msg: '<link rel="apple-touch-icon"> present', capture: true },
  { re: /<meta[^>]+name=["']apple-mobile-web-app-capable["'][^>]+content=["']yes["']/i,
    msg: 'apple-mobile-web-app-capable=yes' },
  { re: /<meta[^>]+name=["']theme-color["'][^>]+content=["']#[0-9a-f]{3,8}["']/i,
    msg: 'theme-color meta present' },
  { re: /<meta[^>]+name=["']viewport["'][^>]+content=["'][^"']*viewport-fit=cover/i,
    msg: 'viewport meta has viewport-fit=cover' },
];

for (const c of checks) {
  const m = html.match(c.re);
  if (!m) fail(`index.html: ${c.msg} — not found`);
  ok(c.msg);
  if (c.capture && m[1]) {
    try { await readFile(join(WEB_DIR, m[1])); }
    catch { fail(`apple-touch-icon file missing on disk: ${m[1]}`); }
    ok(`apple-touch-icon exists on disk: ${m[1]}`);
  }
}

// ---- sw.js sanity ----
const sw = await readFile(join(WEB_DIR, 'sw.js'), 'utf-8');
for (const tok of ['install', 'activate', 'fetch', 'BUILD_ID', 'skipWaiting']) {
  if (!sw.includes(tok)) fail(`sw.js missing expected token: ${tok}`);
}
ok('sw.js declares install/activate/fetch/skipWaiting and a BUILD_ID');

// BUILD_ID is either:
//   * the literal placeholder `__BUILD_ID__` (committed, unstamped tree —
//     dev iteration, fresh clone), or
//   * a 12-char hex hash written by scripts/stamp-sw.mjs (built tree — CI,
//     Docker image, deploy artifact).
// Anything else (a hand-edit, a date string, "dev") means someone broke the
// invariant and the update banner will misbehave.
const PLACEHOLDER = '__BUILD_ID__';
const isValidBuildId = (v) => v === PLACEHOLDER || /^[0-9a-f]{12}$/.test(v);

const swBuildId = sw.match(/^const BUILD_ID = '([^']+)';$/m)?.[1];
if (!swBuildId || !isValidBuildId(swBuildId)) {
  fail(`sw.js BUILD_ID must be 12 hex chars or "${PLACEHOLDER}" (got "${swBuildId}")`);
}
ok(`sw.js BUILD_ID is valid (${swBuildId})`);

// The <meta name="build"> tag in index.html must agree with sw.js. The
// stamper writes both from the same hash in one pass; the committed source
// has the same placeholder in both. Disagreement is always a hand-edit.
const htmlBuildId = html.match(/<meta\s+name=["']build["']\s+content=["']([^"']+)["']/i)?.[1];
if (!htmlBuildId) fail('index.html: missing <meta name="build" content="…">');
if (htmlBuildId !== swBuildId) {
  fail(`BUILD_ID mismatch: sw.js=${swBuildId} index.html=${htmlBuildId}`);
}
ok('index.html <meta name="build"> matches sw.js BUILD_ID');

console.log('\nPWA manifest validation: PASS');
