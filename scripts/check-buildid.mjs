// CI guard: when web/ files changed on this branch but BUILD_ID didn't, the
// SW update banner won't fire on next deploy and clients sit on stale caches.
// The stamp-sw script makes BUILD_ID a content hash, so this should be a
// near-impossibility — but a contributor who edits web/ and forgets
// `make stamp-sw` would slip a stale BUILD_ID through. This catches it.
//
// Compares HEAD vs $BASE_REF (default: origin/main). Skips silently when the
// base ref doesn't exist (e.g. first push of a new branch on a fresh clone)
// so the check doesn't false-positive in unusual CI configurations.
//
// Usage:
//   node scripts/check-buildid.mjs              # base = origin/main
//   BASE_REF=origin/develop node scripts/check-buildid.mjs

import { spawnSync } from 'node:child_process';

// Run from wherever the script is invoked. The Makefile target runs from
// the repo root; tests spin up ephemeral repos and chdir into them.
const REPO = process.cwd();
const BASE_REF = process.env.BASE_REF || 'origin/main';

function git(args) {
  return spawnSync('git', args, { cwd: REPO, encoding: 'utf-8' });
}

// Bail out cleanly if the base ref isn't present (e.g. shallow clone without
// `fetch-depth: 0`, or a fresh repo). Don't fail CI for an environment
// problem; the developer will see it from the stderr log.
const verify = git(['rev-parse', '--verify', BASE_REF]);
if (verify.status !== 0) {
  console.error(`check-buildid: skipping — base ref "${BASE_REF}" not found.`);
  console.error('If running in CI, ensure actions/checkout has fetch-depth: 0.');
  process.exit(0);
}

const diff = git(['diff', '--name-only', `${BASE_REF}...HEAD`, '--', 'web/']);
if (diff.status !== 0) {
  console.error(`check-buildid: \`git diff\` failed:\n${diff.stderr}`);
  process.exit(2);
}
const changedFiles = diff.stdout.split('\n').filter(Boolean);
if (changedFiles.length === 0) {
  console.log('check-buildid: ok (no web/ changes vs base)');
  process.exit(0);
}

// Extract BUILD_ID from a given ref. `git show <ref>:<path>` reads a file at
// that commit without checking it out.
function buildIdAt(ref) {
  const r = git(['show', `${ref}:web/sw.js`]);
  if (r.status !== 0) return null;
  return r.stdout.match(/^const BUILD_ID = '([^']+)';$/m)?.[1] || null;
}

const headId = buildIdAt('HEAD');
const baseId = buildIdAt(BASE_REF);

if (!headId) { console.error('check-buildid: could not read BUILD_ID at HEAD'); process.exit(2); }
if (!baseId) {
  // No BUILD_ID at base means stamper was just introduced — let it through.
  console.log(`check-buildid: ok (base has no BUILD_ID; first stamp on HEAD = ${headId})`);
  process.exit(0);
}

if (headId === baseId) {
  console.error(`check-buildid: FAIL`);
  console.error(`  ${changedFiles.length} web/ file(s) changed vs ${BASE_REF}, but BUILD_ID is unchanged (${headId}).`);
  console.error(`  Run \`make stamp-sw\` and commit the result.`);
  console.error(`  Changed files:`);
  for (const f of changedFiles.slice(0, 20)) console.error(`    ${f}`);
  if (changedFiles.length > 20) console.error(`    … and ${changedFiles.length - 20} more`);
  process.exit(1);
}

console.log(`check-buildid: ok (${baseId} → ${headId}, ${changedFiles.length} web/ file(s) changed)`);
