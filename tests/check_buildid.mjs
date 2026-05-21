// Tests for scripts/check-buildid.mjs — the CI guard that catches the case
// where a contributor edits web/ but leaves BUILD_ID untouched (defeating
// the SW update banner on next deploy).
//
// We exercise the script against an ephemeral git repo so the test doesn't
// touch the real repository state. Each scenario builds an isolated repo
// fixture with a base commit + a head commit and a controlled diff between
// them, then runs check-buildid.mjs with BASE_REF pointing at the synthetic
// base, asserting exit code + stderr/stdout messaging.
//
// Run: node tests/check_buildid.mjs

import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const CHECKER = join(REPO, 'scripts', 'check-buildid.mjs');

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

// Run a git subcommand inside a repo, asserting success. Returns stdout.
function gitOk(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr}`);
  }
  return r.stdout;
}

// Spawn check-buildid with a particular base ref and cwd.
function runChecker(cwd, baseRef) {
  const r = spawnSync('node', [CHECKER], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, BASE_REF: baseRef },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

// Build a fresh repo with a single `base` branch holding (sw.js, otherFile).
async function makeRepoFixture({ baseSw, baseOther, headSw, headOther }) {
  const dir = await mkdtemp(join(tmpdir(), 'banqi-cb-'));
  await mkdir(join(dir, 'web'), { recursive: true });

  gitOk(dir, ['init', '--quiet', '-b', 'main']);
  gitOk(dir, ['config', 'user.email', 'test@example.com']);
  gitOk(dir, ['config', 'user.name', 'Test']);
  gitOk(dir, ['config', 'commit.gpgsign', 'false']);

  // Base commit. Use a named branch to avoid the "git show <branch>" path
  // depending on the local checkout. The script reads BASE_REF=<branch>.
  if (baseSw != null) await writeFile(join(dir, 'web', 'sw.js'), baseSw);
  if (baseOther != null) await writeFile(join(dir, 'web', 'main.js'), baseOther);
  gitOk(dir, ['add', '-A']);
  gitOk(dir, ['commit', '--quiet', '-m', 'base']);
  gitOk(dir, ['branch', 'fakebase']);

  // Head commit (on main, where the working tree lives so `git diff` works).
  if (headSw != null) await writeFile(join(dir, 'web', 'sw.js'), headSw);
  if (headOther != null) await writeFile(join(dir, 'web', 'main.js'), headOther);
  // Allow head == base (no changes): commit anyway with --allow-empty so we
  // have a distinct HEAD to compare against the base branch.
  gitOk(dir, ['add', '-A']);
  const status = gitOk(dir, ['status', '--porcelain']);
  if (status.trim()) {
    gitOk(dir, ['commit', '--quiet', '-m', 'head']);
  } else {
    gitOk(dir, ['commit', '--quiet', '--allow-empty', '-m', 'head (empty)']);
  }

  return dir;
}

function swWithBuildId(id, body = '// sw body\n') {
  return `const BUILD_ID = '${id}';\n${body}`;
}

// ============ scenario coverage ============

console.log('\n== happy paths ==');

{
  // No web/ changes between base and head: should pass quietly.
  const dir = await makeRepoFixture({
    baseSw: swWithBuildId('a'.repeat(12)),
    baseOther: 'export const x = 1;\n',
    headSw: swWithBuildId('a'.repeat(12)),     // unchanged
    headOther: 'export const x = 1;\n',         // unchanged
  });
  try {
    const r = runChecker(dir, 'fakebase');
    checkEq('no web/ or ai/ changes → exit 0', r.code, 0);
    check('no-changes message in stdout',
      /no web\/ or ai\/ changes vs base/.test(r.stdout),
      `stdout=${JSON.stringify(r.stdout)}`);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

{
  // web/ changed and BUILD_ID bumped: should pass.
  const dir = await makeRepoFixture({
    baseSw: swWithBuildId('a'.repeat(12)),
    baseOther: 'export const x = 1;\n',
    headSw: swWithBuildId('b'.repeat(12)),     // bumped
    headOther: 'export const x = 2;\n',        // changed
  });
  try {
    const r = runChecker(dir, 'fakebase');
    checkEq('web/ changed + BUILD_ID bumped → exit 0', r.code, 0);
    check('stdout reports the transition',
      /aaaaaaaaaaaa.*bbbbbbbbbbbb/.test(r.stdout),
      `stdout=${JSON.stringify(r.stdout)}`);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

console.log('\n== the protected case ==');

{
  // web/ changed but BUILD_ID is identical: the core failure mode this
  // guard exists to catch.
  const dir = await makeRepoFixture({
    baseSw: swWithBuildId('a'.repeat(12)),
    baseOther: 'export const x = 1;\n',
    headSw: swWithBuildId('a'.repeat(12)),     // unchanged (the bug)
    headOther: 'export const x = 2;\n',        // changed
  });
  try {
    const r = runChecker(dir, 'fakebase');
    checkEq('web/ changed without BUILD_ID bump → exit 1', r.code, 1);
    check('stderr explains the failure',
      /BUILD_ID is unchanged/.test(r.stderr),
      `stderr=${JSON.stringify(r.stderr)}`);
    check('stderr suggests the fix',
      /make stamp-sw/.test(r.stderr),
      `stderr=${JSON.stringify(r.stderr)}`);
    check('stderr lists the changed file',
      /web\/main\.js/.test(r.stderr),
      `stderr=${JSON.stringify(r.stderr)}`);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

{
  // ai/ changed but BUILD_ID is identical: same failure mode as web/, since
  // both directories feed into the stamper's content hash.
  const dir = await mkdtemp(join(tmpdir(), 'banqi-cb-'));
  try {
    gitOk(dir, ['init', '--quiet', '-b', 'main']);
    gitOk(dir, ['config', 'user.email', 't@e']);
    gitOk(dir, ['config', 'user.name', 'T']);
    gitOk(dir, ['config', 'commit.gpgsign', 'false']);
    await mkdir(join(dir, 'web'), { recursive: true });
    await mkdir(join(dir, 'ai'), { recursive: true });
    await writeFile(join(dir, 'web', 'sw.js'), swWithBuildId('a'.repeat(12)));
    await writeFile(join(dir, 'ai', 'index.mjs'), 'export const v = 1;\n');
    gitOk(dir, ['add', '-A']);
    gitOk(dir, ['commit', '--quiet', '-m', 'base']);
    gitOk(dir, ['branch', 'fakebase']);
    // Change ai/ but leave BUILD_ID alone.
    await writeFile(join(dir, 'ai', 'index.mjs'), 'export const v = 2;\n');
    gitOk(dir, ['add', '-A']);
    gitOk(dir, ['commit', '--quiet', '-m', 'ai change without stamp']);

    const r = runChecker(dir, 'fakebase');
    checkEq('ai/ changed without BUILD_ID bump → exit 1', r.code, 1);
    check('stderr lists the changed ai/ file',
      /ai\/index\.mjs/.test(r.stderr),
      `stderr=${JSON.stringify(r.stderr)}`);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

console.log('\n== edge cases ==');

{
  // sw.js itself changes but no other web/ file does — that's already a
  // BUILD_ID bump path. (sw.js is part of web/, so the diff flags it; the
  // BUILD_ID literal embedded in the diff is the bump itself.)
  const dir = await makeRepoFixture({
    baseSw: swWithBuildId('a'.repeat(12)),
    baseOther: 'export const x = 1;\n',
    headSw: swWithBuildId('b'.repeat(12)),     // BUILD_ID bumped, no other change
    headOther: 'export const x = 1;\n',
  });
  try {
    const r = runChecker(dir, 'fakebase');
    checkEq('sw.js BUILD_ID bump alone → exit 0', r.code, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

{
  // BASE_REF doesn't exist: should skip silently with exit 0 and a warning,
  // not fail the build. Avoids false-positives on shallow clones / first
  // pushes of a new branch.
  const dir = await makeRepoFixture({
    baseSw: swWithBuildId('a'.repeat(12)),
    baseOther: 'export const x = 1;\n',
    headSw: swWithBuildId('a'.repeat(12)),
    headOther: 'export const x = 1;\n',
  });
  try {
    const r = runChecker(dir, 'origin/never-existed');
    checkEq('missing BASE_REF → exit 0 (skip)', r.code, 0);
    check('skip message mentions the missing ref',
      /not found|skipping/.test(r.stderr),
      `stderr=${JSON.stringify(r.stderr)}`);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

{
  // Base has no BUILD_ID at all (stamper was just being introduced).
  // Should let HEAD through.
  const dir = await makeRepoFixture({
    baseSw: '// no BUILD_ID here yet\n',
    baseOther: 'export const x = 1;\n',
    headSw: swWithBuildId('b'.repeat(12)),
    headOther: 'export const x = 2;\n',
  });
  try {
    const r = runChecker(dir, 'fakebase');
    checkEq('base has no BUILD_ID → exit 0', r.code, 0);
    check('stdout notes the first-stamp case',
      /first stamp on HEAD|base has no BUILD_ID/.test(r.stdout),
      `stdout=${JSON.stringify(r.stdout)}`);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

{
  // HEAD has no BUILD_ID line — defensive: bail with a non-zero exit so a
  // botched sw.js can't sneak through.
  const dir = await makeRepoFixture({
    baseSw: swWithBuildId('a'.repeat(12)),
    baseOther: 'export const x = 1;\n',
    headSw: '// BUILD_ID got lost\n',
    headOther: 'export const x = 2;\n',
  });
  try {
    const r = runChecker(dir, 'fakebase');
    check('HEAD missing BUILD_ID → non-zero exit', r.code !== 0);
    check('stderr mentions HEAD',
      /HEAD/.test(r.stderr),
      `stderr=${JSON.stringify(r.stderr)}`);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

{
  // Changes outside web/ should never trip the guard.
  const dir = await mkdtemp(join(tmpdir(), 'banqi-cb-'));
  try {
    gitOk(dir, ['init', '--quiet', '-b', 'main']);
    gitOk(dir, ['config', 'user.email', 't@e']);
    gitOk(dir, ['config', 'user.name', 'T']);
    gitOk(dir, ['config', 'commit.gpgsign', 'false']);
    await mkdir(join(dir, 'web'), { recursive: true });
    await mkdir(join(dir, 'server', 'src'), { recursive: true });
    await writeFile(join(dir, 'web', 'sw.js'), swWithBuildId('a'.repeat(12)));
    await writeFile(join(dir, 'server', 'src', 'index.mjs'), 'console.log(1)\n');
    gitOk(dir, ['add', '-A']);
    gitOk(dir, ['commit', '--quiet', '-m', 'base']);
    gitOk(dir, ['branch', 'fakebase']);
    // Edit only server/ — no web/ touch.
    await writeFile(join(dir, 'server', 'src', 'index.mjs'), 'console.log(2)\n');
    gitOk(dir, ['add', '-A']);
    gitOk(dir, ['commit', '--quiet', '-m', 'server change']);

    const r = runChecker(dir, 'fakebase');
    checkEq('server-only change → exit 0', r.code, 0);
    check('non-web/ai changes message',
      /no web\/ or ai\/ changes/.test(r.stdout),
      `stdout=${JSON.stringify(r.stdout)}`);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

// ============ summary ============

console.log(`\ncheck-buildid tests: ${failed === 0 ? 'OK' : `${failed} failure(s)`}`);
if (failed > 0) process.exit(1);
