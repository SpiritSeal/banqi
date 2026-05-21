// Tests for scripts/stamp-sw.mjs.
//
// Covers the four invariants the stamper needs to uphold so the SW update
// banner actually fires on every meaningful deploy:
//   1. Format        — BUILD_ID is exactly 12 lowercase hex chars.
//   2. Determinism   — same input ⇒ same BUILD_ID.
//   3. Content-sense — change one byte in web/, BUILD_ID changes.
//   4. Idempotency   — stamping twice doesn't drift (the index.html meta
//                      tag's own value mustn't feed back into the hash).
// Plus a cross-file consistency check: the BUILD_ID in sw.js matches the
// one in index.html and the file list is reflected in APP_SHELL.
//
// Run with: node tests/sw_buildid.mjs

import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeBuildId } from '../scripts/stamp-sw.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const REAL_WEB = join(REPO, 'web');
const STAMPER = join(REPO, 'scripts', 'stamp-sw.mjs');

const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
const ok   = (m) => console.log('  ok:', m);

const HEX12 = /^[0-9a-f]{12}$/;

async function makeFixture() {
  const dir = await mkdtemp(join(tmpdir(), 'banqi-sw-'));
  // We don't need a real web/ — a minimal fixture is enough and keeps the
  // test independent of changes to the actual app shell. The stamper only
  // requires `sw.js` (with the BUILD_ID line + AUTO-PRECACHE markers) and
  // `index.html` (with a build meta tag).
  await writeFile(join(dir, 'sw.js'),
    "const BUILD_ID = 'dev';\n" +
    "// AUTO-PRECACHE START\n" +
    "const APP_SHELL = ['./'];\n" +
    "// AUTO-PRECACHE END\n");
  await writeFile(join(dir, 'index.html'),
    '<!doctype html><html><head>' +
    '<meta name="build" content="dev">' +
    '</head><body>hi</body></html>\n');
  await writeFile(join(dir, 'main.js'), 'export const x = 1;\n');
  await writeFile(join(dir, 'style.css'), 'body { color: red; }\n');
  await mkdir(join(dir, 'icons'), { recursive: true });
  await writeFile(join(dir, 'icons', 'icon.png'), Buffer.from([137, 80, 78, 71]));
  return dir;
}

function runStamper(webDir, extraArgs = []) {
  const r = spawnSync('node', [STAMPER, '--web', webDir, ...extraArgs], { encoding: 'utf-8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

// ---- 1. Format ----
{
  const dir = await makeFixture();
  try {
    const id = await computeBuildId(dir);
    if (!HEX12.test(id)) fail(`BUILD_ID is not 12-hex: ${id}`);
    ok(`computeBuildId returns 12-hex format (${id})`);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

// ---- 2. Determinism ----
{
  const dir = await makeFixture();
  try {
    const a = await computeBuildId(dir);
    const b = await computeBuildId(dir);
    if (a !== b) fail(`same input produced different BUILD_IDs: ${a} vs ${b}`);
    ok('same input ⇒ same BUILD_ID');
  } finally { await rm(dir, { recursive: true, force: true }); }
}

// ---- 3. Content sensitivity ----
{
  const dir = await makeFixture();
  try {
    const before = await computeBuildId(dir);
    await writeFile(join(dir, 'style.css'), 'body { color: blue; }\n');
    const after = await computeBuildId(dir);
    if (before === after) fail('BUILD_ID unchanged after editing style.css');
    ok(`one-byte edit changed BUILD_ID (${before} → ${after})`);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

// ---- 4. Idempotency under re-stamping ----
// Stamping rewrites index.html's <meta name="build">. If that value fed back
// into the hash, the second stamp would compute a different BUILD_ID from
// the first. The normalization in normalizeForHash() prevents that.
{
  const dir = await makeFixture();
  try {
    const r1 = runStamper(dir);
    if (r1.code !== 0) fail(`first stamp failed: ${r1.stderr || r1.stdout}`);
    const sw1 = await readFile(join(dir, 'sw.js'), 'utf-8');
    const id1 = sw1.match(/^const BUILD_ID = '([^']+)';$/m)?.[1];

    const r2 = runStamper(dir);
    if (r2.code !== 0) fail(`second stamp failed: ${r2.stderr || r2.stdout}`);
    const sw2 = await readFile(join(dir, 'sw.js'), 'utf-8');
    const id2 = sw2.match(/^const BUILD_ID = '([^']+)';$/m)?.[1];

    if (id1 !== id2) fail(`re-stamp drifted: ${id1} → ${id2}`);
    ok(`re-stamping with no source changes is idempotent (${id1})`);

    // --check should agree with the on-disk state at this point.
    const r3 = runStamper(dir, ['--check']);
    if (r3.code !== 0) fail(`--check unexpectedly failed: ${r3.stderr || r3.stdout}`);
    ok('--check passes on a freshly stamped tree');
  } finally { await rm(dir, { recursive: true, force: true }); }
}

// ---- 5. Cross-file consistency on the REAL tree ----
// The committed web/ should always be in a stamped state; if a contributor
// forgot to re-stamp after a change, this catches it. (Doesn't mutate the
// tree — uses --check.)
{
  const r = runStamper(REAL_WEB, ['--check']);
  if (r.code !== 0) {
    fail(`real web/ is not stamped: ${r.stderr.trim() || r.stdout.trim()}`);
  }
  const sw = await readFile(join(REAL_WEB, 'sw.js'), 'utf-8');
  const html = await readFile(join(REAL_WEB, 'index.html'), 'utf-8');
  const swId = sw.match(/^const BUILD_ID = '([^']+)';$/m)?.[1];
  const htmlId = html.match(/<meta\s+name=["']build["']\s+content=["']([^"']+)["']/i)?.[1];
  if (!swId || !HEX12.test(swId)) fail(`sw.js BUILD_ID malformed: ${swId}`);
  if (!htmlId || !HEX12.test(htmlId)) fail(`index.html build meta malformed: ${htmlId}`);
  if (swId !== htmlId) fail(`sw.js (${swId}) and index.html (${htmlId}) disagree`);
  ok(`real web/ sw.js + index.html agree on BUILD_ID (${swId})`);
}

// ---- 6. APP_SHELL stays in sync with the file walk ----
{
  const dir = await makeFixture();
  try {
    runStamper(dir);
    const sw = await readFile(join(dir, 'sw.js'), 'utf-8');
    for (const f of ['./', './index.html', './main.js', './style.css', './icons/icon.png']) {
      if (!sw.includes(`"${f}"`)) fail(`APP_SHELL missing ${f}`);
    }
    if (sw.includes('"./sw.js"')) fail('APP_SHELL must not include sw.js');
    ok('APP_SHELL covers all non-sw.js files (and excludes sw.js)');
  } finally { await rm(dir, { recursive: true, force: true }); }
}

console.log('\nstamp-sw tests: PASS');
