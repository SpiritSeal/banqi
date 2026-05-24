// Content-hash stamper for the service worker.
//
// Walks the web/ + ai/ directories, computes a 12-hex digest from every file
// except sw.js itself, and writes that digest into two places:
//   * web/sw.js — the `BUILD_ID` constant + the auto-generated `APP_SHELL`
//     precache list (delimited by AUTO-PRECACHE markers).
//   * web/index.html — `<meta name="build" content="…">`, used by support /
//     telemetry to identify which build a client is running.
//
// BUILD_ID is a build artifact, not source. The committed sw.js + index.html
// carry literal `__BUILD_ID__` placeholders and an empty AUTO-PRECACHE block;
// CI, the Dockerfile, and deploy.yml all run this script before shipping, so
// what reaches a browser always has the real hash. Devs only need to run it
// locally if they want the PWA update banner to fire during dev.
//
// Why content-hash instead of a hand-bumped version:
//   The PWA update banner only fires when BUILD_ID changes. A deploy that
//   forgets to bump it ships invisibly. Deriving BUILD_ID from web/+ai/
//   contents means every meaningful change to the shipped bundle invalidates
//   the SW cache atomically (see web/sw.js activate handler) and surfaces
//   the "Update available" banner.
//
// Determinism: hashing is path+content, files are sorted, and the index.html
// build-meta value is normalized to a fixed placeholder before hashing so a
// previously-stamped tree hashes identically to the placeholder source —
// re-stamping is a no-op when nothing real has changed.
//
// Usage:
//   node scripts/stamp-sw.mjs [--web <path>] [--ai <path>] [--check]
//
//   --web <path>  Web directory to walk (default: ./web). Overridden in Docker.
//   --ai  <path>  AI directory to walk (default: ./ai). The AI module lives
//                 outside web/ so the server can import it without the web
//                 bundle, but the browser still precaches it via the /ai
//                 static mount. Pass an empty string to skip.
//   --check       Exit non-zero if a stamp would change anything. Lets CI
//                 verify the stamper was run without mutating the tree.

import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_WEB_DIR = join(__dirname, '..', 'web');
const DEFAULT_AI_DIR = join(__dirname, '..', 'ai');

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
  // Any path segment starting with `.` — top-level dotfiles AND nested ones
  // (icons/.DS_Store, .vscode/settings.json, etc.). Catches editor + OS
  // artifacts so they don't leak into BUILD_ID.
  if (/(^|\/)\.[^/]+/.test(relPath)) return true;
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

export async function computeBuildId(webDir, aiDir) {
  const files = await walk(webDir);
  const lines = [];
  for (const rel of files) {
    const bytes = await readFile(join(webDir, rel));
    const normalized = normalizeForHash(rel, bytes);
    const hash = createHash('sha256').update(normalized).digest('hex');
    lines.push(`${rel}|${hash}`);
  }
  if (aiDir) {
    const aiFiles = await walk(aiDir);
    for (const rel of aiFiles) {
      const bytes = await readFile(join(aiDir, rel));
      const hash = createHash('sha256').update(bytes).digest('hex');
      // Prefix with `ai/` so the line is distinct from a web/ file of the
      // same relative name, and to mirror the path the SW will fetch.
      lines.push(`ai/${rel}|${hash}`);
    }
  }
  const digest = createHash('sha256').update(lines.join('\n')).digest('hex');
  return digest.slice(0, 12);
}

// Render the JS source for the auto-generated APP_SHELL block. Lives between
// the AUTO-PRECACHE markers in web/sw.js.
//
// `aiFiles` are paths relative to the ai/ dir and are emitted as `../ai/<rel>`
// — the SW lives at /sw.js so its scope is /, and `../ai/` from web/sw.js
// resolves to the /ai/* URLs Express serves via the second static mount.
//
// The static head entries (`./`) come first; the remainder is sorted so the
// list is stable across walks and easy to eyeball-diff in code review.
function renderAppShell(files, aiFiles = []) {
  const rest = [
    ...files.map((f) => `./${f}`),
    ...aiFiles.map((f) => `../ai/${f}`),
  ].sort();
  const all = [...STATIC_PRECACHE_ENTRIES, ...rest];
  const lines = all.map((p) => `  ${JSON.stringify(p)},`);
  return `const APP_SHELL = [\n${lines.join('\n')}\n];`;
}

// Replace the BUILD_ID literal and the AUTO-PRECACHE block in sw.js. Returns
// {before, after} for the --check path.
function rewriteSw(swText, buildId, files, aiFiles = []) {
  // Accept CRLF (Windows checkouts with core.autocrlf=true) by matching
  // both `$` and `\r?\n`. Don't normalise the file — preserve the host's
  // line endings so the stamper is a no-op on git's filter pipeline.
  const buildIdRe = /^const BUILD_ID = '[^']*';\r?$/m;
  if (!buildIdRe.test(swText)) {
    throw new Error("sw.js: couldn't find the `const BUILD_ID = '…';` line");
  }
  const markerRe = /(\/\/ AUTO-PRECACHE START)(\r?\n)[\s\S]*?(\/\/ AUTO-PRECACHE END)/m;
  const markerMatch = swText.match(markerRe);
  if (!markerMatch) {
    throw new Error("sw.js: couldn't find AUTO-PRECACHE START/END markers");
  }
  const nl = markerMatch[2];   // '\n' or '\r\n', whichever the file uses.
  const appShellBlock = renderAppShell(files, aiFiles).split('\n').join(nl);
  return swText
    .replace(buildIdRe, (m) => m.replace(/'[^']*'/, `'${buildId}'`))
    .replace(markerRe, `$1${nl}${appShellBlock}${nl}$3`);
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
  let aiDir = DEFAULT_AI_DIR;
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--web') webDir = argv[++i];
    else if (argv[i] === '--ai') aiDir = argv[++i];
    else if (argv[i] === '--check') check = true;
    else { console.error(`unknown arg: ${argv[i]}`); process.exit(2); }
  }

  try { await stat(webDir); }
  catch { console.error(`web dir not found: ${webDir}`); process.exit(2); }

  // An empty --ai value disables the AI scan entirely (no precache, no hash
  // contribution). A non-empty value that points at a missing directory is
  // an error — silently skipping it would corrupt BUILD_ID.
  let effectiveAiDir = aiDir || null;
  if (effectiveAiDir) {
    try { await stat(effectiveAiDir); }
    catch { console.error(`ai dir not found: ${effectiveAiDir}`); process.exit(2); }
  }

  const buildId = await computeBuildId(webDir, effectiveAiDir);
  const files = (await walk(webDir));
  const aiFiles = effectiveAiDir ? (await walk(effectiveAiDir)) : [];

  const swPath = join(webDir, SW_FILENAME);
  const indexPath = join(webDir, INDEX_FILENAME);
  const swBefore = await readFile(swPath, 'utf-8');
  const indexBefore = await readFile(indexPath, 'utf-8');
  const swAfter = rewriteSw(swBefore, buildId, files, aiFiles);
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
  const totalFiles = files.length + aiFiles.length;
  console.log(`BUILD_ID=${buildId} (${totalFiles} files hashed`
    + (aiFiles.length ? `, ${aiFiles.length} from ai/` : '') + `)`);
}

const invokedAsScript = process.argv[1]
  && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedAsScript) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
