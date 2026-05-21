// Tests for scripts/stamp-sw.mjs.
//
// The stamper is the only thing standing between a deploy and an
// invisible-to-the-user stale-cache outcome, so we cover it thoroughly:
//
//   * Hash invariants (format, determinism, content/path sensitivity,
//     binary-safe, exclusion rules).
//   * Idempotency under re-stamping (the index.html meta tag's value
//     mustn't feed back into the hash).
//   * sw.js rewriting (BUILD_ID line + AUTO-PRECACHE block) including
//     APP_SHELL completeness and sorting.
//   * Error paths (missing files, missing markers, missing meta tag).
//   * CLI behavior (--check exit codes, unknown flag, missing --web).
//   * Cross-file consistency on the real committed web/ tree.
//
// Style follows tests/board_input_unit.mjs: accumulate failures, print a
// section header per area, summarise at the end. Lets you see every
// problem in one run instead of chasing them one fix at a time.
//
// Run: node tests/sw_buildid.mjs

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

const HEX12 = /^[0-9a-f]{12}$/;

let failed = 0;
function check(label, cond, detail = '') {
  if (cond) {
    console.log(`  ok: ${label}`);
  } else {
    failed++;
    console.error(`  FAIL: ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
function checkEq(label, got, want) {
  check(label, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}

// Build a minimal but realistic fixture. Tests that need extra files add
// them after the call. Returns the absolute path; caller must `rm -rf`.
async function makeFixture() {
  const dir = await mkdtemp(join(tmpdir(), 'banqi-sw-'));
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

async function withFixture(fn) {
  const dir = await makeFixture();
  try { await fn(dir); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

function runStamper(webDir, extraArgs = []) {
  const args = webDir == null ? extraArgs : ['--web', webDir, ...extraArgs];
  const r = spawnSync('node', [STAMPER, ...args], { encoding: 'utf-8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function buildIdFromSw(text)   { return text.match(/^const BUILD_ID = '([^']+)';$/m)?.[1] ?? null; }
function buildIdFromHtml(text) { return text.match(/<meta\s+name=["']build["']\s+content=["']([^"']+)["']/i)?.[1] ?? null; }
function appShellFromSw(text) {
  const block = text.match(/\/\/ AUTO-PRECACHE START\n([\s\S]*?)\/\/ AUTO-PRECACHE END/m)?.[1] ?? '';
  return [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

// ============ Hash invariants ============

console.log('\n== hash invariants ==');

await withFixture(async (dir) => {
  const id = await computeBuildId(dir);
  check(`format is 12 lowercase hex (${id})`, HEX12.test(id));
});

await withFixture(async (dir) => {
  const a = await computeBuildId(dir);
  const b = await computeBuildId(dir);
  checkEq('same fixture ⇒ same BUILD_ID', a, b);
});

await withFixture(async (dir) => {
  const before = await computeBuildId(dir);
  await writeFile(join(dir, 'style.css'), 'body { color: blue; }\n');
  const after = await computeBuildId(dir);
  check(`one-byte content edit changes BUILD_ID (${before} → ${after})`,
    before !== after);
});

await withFixture(async (dir) => {
  // Renaming a file (same content, new path) must change BUILD_ID — the
  // path is part of the precache list and an HTTP-cache key.
  const before = await computeBuildId(dir);
  const original = await readFile(join(dir, 'style.css'));
  await rm(join(dir, 'style.css'));
  await writeFile(join(dir, 'style.renamed.css'), original);
  const after = await computeBuildId(dir);
  check(`rename changes BUILD_ID (${before} → ${after})`, before !== after);
});

await withFixture(async (dir) => {
  // Binary content (non-UTF-8) mustn't crash the hasher and must contribute
  // to BUILD_ID byte-for-byte. We simulate a wasm-sized payload of random
  // bytes that includes nulls and 0xff.
  const a = Buffer.alloc(8192);
  for (let i = 0; i < a.length; i++) a[i] = (i * 37 + 17) & 0xff;
  await writeFile(join(dir, 'banqi.wasm'), a);
  const id1 = await computeBuildId(dir);
  check('binary file produces a valid hash', HEX12.test(id1));
  a[0] ^= 1;
  await writeFile(join(dir, 'banqi.wasm'), a);
  const id2 = await computeBuildId(dir);
  check(`flipping one bit in binary changes BUILD_ID (${id1} → ${id2})`,
    id1 !== id2);
});

// ============ Exclusion rules ============

console.log('\n== exclusion rules ==');

await withFixture(async (dir) => {
  const before = await computeBuildId(dir);
  // sw.js: we're hashing the rest of the tree to decide sw.js's BUILD_ID.
  // Hashing sw.js itself creates a fixed-point dependency.
  await writeFile(join(dir, 'sw.js'),
    "const BUILD_ID = 'totally-different';\n" +
    "// AUTO-PRECACHE START\n" +
    "const APP_SHELL = [];\n" +
    "// AUTO-PRECACHE END\n");
  const after = await computeBuildId(dir);
  checkEq('editing sw.js does not change BUILD_ID', after, before);
});

await withFixture(async (dir) => {
  const before = await computeBuildId(dir);
  await writeFile(join(dir, '.DS_Store'), Buffer.from([0x00, 0x01]));
  await writeFile(join(dir, '.hidden-config'), 'secret\n');
  const after = await computeBuildId(dir);
  checkEq('top-level dotfiles excluded from hash', after, before);
});

await withFixture(async (dir) => {
  // Nested dotfiles — macOS sprinkles .DS_Store all over a tree once you
  // open a Finder window. If those tripped BUILD_ID, every macOS contributor
  // would see false-positive stamper drift.
  const before = await computeBuildId(dir);
  await writeFile(join(dir, 'icons', '.DS_Store'), Buffer.from([0x00, 0x01]));
  await mkdir(join(dir, '.vscode'), { recursive: true });
  await writeFile(join(dir, '.vscode', 'settings.json'), '{}\n');
  const after = await computeBuildId(dir);
  checkEq('nested dotfiles excluded from hash', after, before);

  runStamper(dir);
  const sw = await readFile(join(dir, 'sw.js'), 'utf-8');
  const shell = appShellFromSw(sw);
  check('APP_SHELL excludes ./icons/.DS_Store',
    !shell.includes('./icons/.DS_Store'));
  check('APP_SHELL excludes ./.vscode/settings.json',
    !shell.some((p) => p.includes('/.vscode/')));
});

await withFixture(async (dir) => {
  const before = await computeBuildId(dir);
  await writeFile(join(dir, 'editor.swap.tmp'), 'editor swap\n');
  await writeFile(join(dir, 'main.js.map'), '{"version":3}\n');
  const after = await computeBuildId(dir);
  checkEq('.tmp and .map files excluded from hash', after, before);
});

// ============ Re-stamp idempotency ============

console.log('\n== re-stamp idempotency ==');

await withFixture(async (dir) => {
  // Stamping rewrites the <meta name="build"> content. If that value fed
  // into the hash, every stamp would produce a new BUILD_ID, breaking
  // determinism. normalizeForHash() in the stamper neutralises this.
  const r1 = runStamper(dir);
  checkEq('first stamp exits 0', r1.code, 0);
  const id1 = buildIdFromSw(await readFile(join(dir, 'sw.js'), 'utf-8'));

  const r2 = runStamper(dir);
  checkEq('second stamp exits 0', r2.code, 0);
  const id2 = buildIdFromSw(await readFile(join(dir, 'sw.js'), 'utf-8'));
  checkEq('re-stamp with no source changes is idempotent', id1, id2);

  const r3 = runStamper(dir, ['--check']);
  checkEq('--check exits 0 on a freshly stamped tree', r3.code, 0);
});

await withFixture(async (dir) => {
  runStamper(dir);
  await writeFile(join(dir, 'style.css'), 'body { color: green; }\n');
  const r = runStamper(dir, ['--check']);
  checkEq('--check exits 1 after a source-only change',
    r.code, 1);
  check('--check stderr names the new BUILD_ID',
    /BUILD_ID would change to [0-9a-f]{12}/.test(r.stderr),
    `stderr=${JSON.stringify(r.stderr)}`);
});

// ============ sw.js rewriting ============

console.log('\n== sw.js rewriting ==');

await withFixture(async (dir) => {
  // Subdirs deeper than one level — the walk must recurse arbitrarily.
  await mkdir(join(dir, 'sounds'), { recursive: true });
  await writeFile(join(dir, 'sounds', 'move.mp3'), Buffer.from([0xff, 0xfb]));
  await mkdir(join(dir, 'a', 'b', 'c'), { recursive: true });
  await writeFile(join(dir, 'a', 'b', 'c', 'deep.txt'), 'leaf\n');

  runStamper(dir);
  const sw = await readFile(join(dir, 'sw.js'), 'utf-8');
  const shell = appShellFromSw(sw);

  check('APP_SHELL includes top-level ./', shell.includes('./'));
  for (const f of ['./index.html', './main.js', './style.css',
                   './icons/icon.png', './sounds/move.mp3',
                   './a/b/c/deep.txt']) {
    check(`APP_SHELL includes ${f}`, shell.includes(f));
  }
  check('APP_SHELL excludes ./sw.js', !shell.includes('./sw.js'));

  // POSIX paths even on systems where the walker might return backslashes.
  check('APP_SHELL paths are POSIX (no backslashes)',
    shell.every((p) => !p.includes('\\')));

  // No duplicates.
  checkEq('APP_SHELL has no duplicates',
    new Set(shell).size, shell.length);

  // Sorted (apart from the leading './').
  const tail = shell.slice(1);
  const sortedTail = [...tail].sort();
  check('APP_SHELL is sorted (after the static "./" head)',
    tail.every((p, i) => p === sortedTail[i]));
});

await withFixture(async (dir) => {
  // index.html should have the stamper's BUILD_ID, byte-identical to sw.js.
  runStamper(dir);
  const sw = await readFile(join(dir, 'sw.js'), 'utf-8');
  const html = await readFile(join(dir, 'index.html'), 'utf-8');
  const swId = buildIdFromSw(sw);
  const htmlId = buildIdFromHtml(html);
  check(`sw.js BUILD_ID is 12-hex (${swId})`, HEX12.test(swId || ''));
  check(`index.html build meta is 12-hex (${htmlId})`, HEX12.test(htmlId || ''));
  checkEq('sw.js and index.html BUILD_ID agree', swId, htmlId);
});

// ============ Cross-platform line endings ============

console.log('\n== line endings ==');

await withFixture(async (dir) => {
  // Simulate a Windows checkout with core.autocrlf=true: CRLF in sw.js +
  // index.html. The stamper must still parse the BUILD_ID line and the
  // AUTO-PRECACHE markers, and must preserve the file's line-ending style
  // when writing back (otherwise git keeps re-converting on every commit).
  const toCRLF = (s) => s.replace(/\n/g, '\r\n');
  await writeFile(join(dir, 'sw.js'), toCRLF(
    "const BUILD_ID = 'dev';\n" +
    "// AUTO-PRECACHE START\n" +
    "const APP_SHELL = ['./'];\n" +
    "// AUTO-PRECACHE END\n"));
  await writeFile(join(dir, 'index.html'), toCRLF(
    '<!doctype html>\n<html>\n<head>\n' +
    '<meta name="build" content="dev">\n' +
    '</head>\n<body>hi</body>\n</html>\n'));

  const r = runStamper(dir);
  checkEq('CRLF sw.js + index.html → stamp succeeds', r.code, 0);

  const sw = await readFile(join(dir, 'sw.js'), 'utf-8');
  check('stamped sw.js BUILD_ID is 12-hex',
    HEX12.test(buildIdFromSw(sw) || ''));
  const hasCrlf = sw.includes('\r\n');
  const hasBareLf = /(?<!\r)\n/.test(sw);
  check('stamped sw.js preserves CRLF line endings (no bare LF)',
    hasCrlf && !hasBareLf,
    `hasCrlf=${hasCrlf} hasBareLf=${hasBareLf}`);

  // Re-stamping must remain idempotent under CRLF.
  const id1 = buildIdFromSw(sw);
  runStamper(dir);
  const id2 = buildIdFromSw(await readFile(join(dir, 'sw.js'), 'utf-8'));
  checkEq('CRLF re-stamp is idempotent', id1, id2);

  const r3 = runStamper(dir, ['--check']);
  checkEq('--check passes after CRLF stamp', r3.code, 0);
});

// ============ Error paths ============

console.log('\n== error paths ==');

await withFixture(async (dir) => {
  await rm(join(dir, 'index.html'));
  const r = runStamper(dir);
  check('missing index.html → non-zero exit', r.code !== 0);
  check('missing index.html → useful stderr',
    /index\.html/.test(r.stderr),
    `stderr=${JSON.stringify(r.stderr)}`);
});

await withFixture(async (dir) => {
  await rm(join(dir, 'sw.js'));
  const r = runStamper(dir);
  check('missing sw.js → non-zero exit', r.code !== 0);
  check('missing sw.js → useful stderr',
    /sw\.js|ENOENT/.test(r.stderr),
    `stderr=${JSON.stringify(r.stderr)}`);
});

await withFixture(async (dir) => {
  await writeFile(join(dir, 'sw.js'),
    "let BUILD_ID = 'whatever';\n" +  // wrong: `let` not `const`
    "// AUTO-PRECACHE START\n// AUTO-PRECACHE END\n");
  const r = runStamper(dir);
  check('malformed BUILD_ID line → non-zero exit', r.code !== 0);
  check('malformed BUILD_ID line → mentions BUILD_ID',
    /BUILD_ID/.test(r.stderr),
    `stderr=${JSON.stringify(r.stderr)}`);
});

await withFixture(async (dir) => {
  await writeFile(join(dir, 'sw.js'),
    "const BUILD_ID = 'dev';\n" +
    "const APP_SHELL = [];\n");                // no markers
  const r = runStamper(dir);
  check('missing AUTO-PRECACHE markers → non-zero exit', r.code !== 0);
  check('missing markers → mentions AUTO-PRECACHE',
    /AUTO-PRECACHE/.test(r.stderr),
    `stderr=${JSON.stringify(r.stderr)}`);
});

await withFixture(async (dir) => {
  await writeFile(join(dir, 'index.html'),
    '<!doctype html><html><head></head><body>no meta</body></html>\n');
  const r = runStamper(dir);
  check('missing <meta name="build"> → non-zero exit', r.code !== 0);
  check('missing build meta → mentions index.html',
    /index\.html|build/.test(r.stderr),
    `stderr=${JSON.stringify(r.stderr)}`);
});

// ============ CLI ============

console.log('\n== CLI ==');

{
  const r = runStamper('/this/path/does/not/exist');
  checkEq('missing --web dir → exit 2', r.code, 2);
}

{
  const r = runStamper(REAL_WEB, ['--bogus-flag']);
  checkEq('unknown flag → exit 2', r.code, 2);
}

// ============ Real-tree state ============

console.log('\n== real web/ ==');

{
  // The committed tree should always be a freshly stamped state: if a
  // contributor forgot to re-stamp, --check catches it without mutating
  // anything. (Skipped if banqi.{js,wasm} aren't built locally — the
  // CI-stamped BUILD_ID then naturally differs from a wasm-less local one.)
  let wasmPresent = true;
  try { await readFile(join(REAL_WEB, 'banqi.wasm')); }
  catch { wasmPresent = false; }
  if (!wasmPresent) {
    console.log('  skip: real-tree --check (banqi.wasm not built locally)');
  } else {
    const r = runStamper(REAL_WEB, ['--check']);
    check('real web/ passes --check after `make wasm`',
      r.code === 0,
      `stderr=${r.stderr.trim()}`);
  }

  const sw = await readFile(join(REAL_WEB, 'sw.js'), 'utf-8');
  const html = await readFile(join(REAL_WEB, 'index.html'), 'utf-8');
  const swId = buildIdFromSw(sw);
  const htmlId = buildIdFromHtml(html);
  check(`real sw.js BUILD_ID is 12-hex (${swId})`, HEX12.test(swId || ''));
  check(`real index.html build meta is 12-hex (${htmlId})`, HEX12.test(htmlId || ''));
  checkEq('real sw.js + index.html agree on BUILD_ID', swId, htmlId);

  const shell = appShellFromSw(sw);
  check('real APP_SHELL is non-empty', shell.length > 1);
  check('real APP_SHELL excludes ./sw.js', !shell.includes('./sw.js'));
}

// ============ summary ============

console.log(`\nstamp-sw tests: ${failed === 0 ? 'OK' : `${failed} failure(s)`}`);
if (failed > 0) process.exit(1);
