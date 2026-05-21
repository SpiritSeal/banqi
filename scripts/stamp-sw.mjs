// Content-hash stamper for the service worker.
//
// Walks the web/ directory, computes a 12-hex digest from every file except
// sw.js itself, and writes that digest into two places:
//   * web/sw.js — the `BUILD_ID` constant + the auto-generated `APP_SHELL`
//     precache list (delimited by AUTO-PRECACHE markers).
//   * web/index.html — `<meta name="build" content="…">`, used by support /
//     telemetry to identify which build a client is running.
//
// Why content-hash instead of a hand-bumped version:
//   The PWA update banner only fires when BUILD_ID changes. A deploy that
//   forgets to bump it ships invisibly. Deriving BUILD_ID from web/ contents
//   means every meaningful change to the shipped bundle invalidates the SW
//   cache atomically (see web/sw.js activate handler) and surfaces the
//   "Update available" banner.
//
// Determinism: hashing is path+content, files are sorted, and the index.html
// build-meta value is normalized to a placeholder before hashing so the
// stamper's own output doesn't perturb its input.
//
// Usage:
//   node scripts/stamp-sw.mjs [--web <path>] [--check]
//
//   --web <path>  Directory to walk (default: ./web). Overridden in Docker.
//   --check       Exit non-zero if a stamp would change anything. Lets CI
//                 verify the stamper was run without mutating the tree.

import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_WEB_DIR = join(__dirname, '..', 'web');

const SW_FILENAME = 'sw.js';
const INDEX_FILENAME = 'index.html';
const BUILD_META_PLACEHOLDER = '__BUILD__';

// Static entries that don't correspond to a single file on disk but should
// still appear in the precache list. './' is a navigation alias for the page
// shell; precaching it primes the navigation cache so first-launch offline
// works even before the browser has issued an `index.html` request.
const STATIC_PRECACHE_ENTRIES = ['./'];

// Files to exclude from BOTH the hash and the precache list.
function isExcluded(relPath) {
  if (relPath === SW_FILENAME) return true;       // can't precache the SW itself
  if (relPath.startsWith('.')) return true;        // dotfiles
  if (relPath.endsWith('.tmp')) return true;       // editor swap files
  if (relPath.endsWith('.map')) return true;       // source maps — not needed offline
  return false;
}

async function walk(root) {
  const out = [];
  async function recurse(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        await recurse(full);
      } else if (e.isFile()) {
        const rel = relative(root, full).split(sep).join(posix.sep);
        if (!isExcluded(rel)) out.push(rel);
      }
    }
  }
  await recurse(root);
  out.sort();
  return out;
}

// Normalize a file's bytes for hashing. For index.html, blank out the
// build-meta content attribute so the value the stamper writes doesn't feed
// back into the hash (which would change BUILD_ID, which would change the
// meta value, which would change the hash — infinite loop).
function normalizeForHash(relPath, bytes) {
  if (relPath !== INDEX_FILENAME) return bytes;
  const text = bytes.toString('utf-8');
  const normalized = text.replace(
    /(<meta\s+name=["']build["']\s+content=["'])[^"']*(["'])/i,
    `$1${BUILD_META_PLACEHOLDER}$2`,
  );
  return Buffer.from(normalized, 'utf-8');
}

export async function computeBuildId(webDir) {
  const files = await walk(webDir);
  const lines = [];
  for (const rel of files) {
    const bytes = await readFile(join(webDir, rel));
    const normalized = normalizeForHash(rel, bytes);
    const hash = createHash('sha256').update(normalized).digest('hex');
    lines.push(`${rel}|${hash}`);
  }
  const digest = createHash('sha256').update(lines.join('\n')).digest('hex');
  return digest.slice(0, 12);
}

// Render the JS source for the auto-generated APP_SHELL block. Lives between
// the AUTO-PRECACHE markers in web/sw.js.
function renderAppShell(files) {
  const all = [...STATIC_PRECACHE_ENTRIES, ...files.map((f) => `./${f}`)];
  const lines = all.map((p) => `  ${JSON.stringify(p)},`);
  return `const APP_SHELL = [\n${lines.join('\n')}\n];`;
}

// Replace the BUILD_ID literal and the AUTO-PRECACHE block in sw.js. Returns
// {before, after} for the --check path.
function rewriteSw(swText, buildId, files) {
  const buildIdRe = /^const BUILD_ID = '[^']*';$/m;
  if (!buildIdRe.test(swText)) {
    throw new Error("sw.js: couldn't find the `const BUILD_ID = '…';` line");
  }
  const markerRe = /\/\/ AUTO-PRECACHE START\n[\s\S]*?\/\/ AUTO-PRECACHE END/m;
  if (!markerRe.test(swText)) {
    throw new Error("sw.js: couldn't find AUTO-PRECACHE START/END markers");
  }
  const appShellBlock = renderAppShell(files);
  return swText
    .replace(buildIdRe, `const BUILD_ID = '${buildId}';`)
    .replace(markerRe, `// AUTO-PRECACHE START\n${appShellBlock}\n// AUTO-PRECACHE END`);
}

function rewriteIndex(htmlText, buildId) {
  const re = /(<meta\s+name=["']build["']\s+content=["'])[^"']*(["'])/i;
  if (!re.test(htmlText)) {
    throw new Error('index.html: missing <meta name="build" content="…"> tag');
  }
  // Reset regex lastIndex isn't needed since `re` has no `g` flag.
  return htmlText.replace(re, (_match, p1, p2) => `${p1}${buildId}${p2}`);
}

async function main() {
  const argv = process.argv.slice(2);
  let webDir = DEFAULT_WEB_DIR;
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--web') webDir = argv[++i];
    else if (argv[i] === '--check') check = true;
    else { console.error(`unknown arg: ${argv[i]}`); process.exit(2); }
  }

  try { await stat(webDir); }
  catch { console.error(`web dir not found: ${webDir}`); process.exit(2); }

  const buildId = await computeBuildId(webDir);
  const files = (await walk(webDir));

  const swPath = join(webDir, SW_FILENAME);
  const indexPath = join(webDir, INDEX_FILENAME);
  const swBefore = await readFile(swPath, 'utf-8');
  const indexBefore = await readFile(indexPath, 'utf-8');
  const swAfter = rewriteSw(swBefore, buildId, files);
  const indexAfter = rewriteIndex(indexBefore, buildId);

  if (check) {
    const drift = (swAfter !== swBefore) || (indexAfter !== indexBefore);
    if (drift) {
      console.error(`stamp-sw --check: BUILD_ID would change to ${buildId}; re-run \`node scripts/stamp-sw.mjs\` and commit`);
      process.exit(1);
    }
    console.log(`stamp-sw --check: ok (BUILD_ID=${buildId})`);
    return;
  }

  if (swAfter !== swBefore) await writeFile(swPath, swAfter);
  if (indexAfter !== indexBefore) await writeFile(indexPath, indexAfter);
  console.log(`BUILD_ID=${buildId} (${files.length} files hashed)`);
}

const invokedAsScript = process.argv[1]
  && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedAsScript) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
