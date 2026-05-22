// Boot-time guard for SERVER_SECRET (#72).
//
// Spawns the server entry point as a child process under various env
// permutations and asserts the right combinations of exit code + stderr
// banner. Does NOT need Postgres or the WASM module — the refusal-path
// cases exit BEFORE buildApp() opens a connection or tries to import the
// rules engine, and the boot-path cases only assert that the FATAL banner
// is absent and the process advanced past the SERVER_SECRET check.
//
// Run with: node --test server/tests/server_secret_boot_smoke.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(HERE, '..', 'src', 'index.mjs');
const DEV_SECRET = 'dev-insecure-secret-change-me';

// Spawn the server with a curated env. By default we strip everything the
// boot path looks at so each case starts from a clean slate, then layer
// `extra` on top. PORT is randomised so cases that boot don't collide.
function spawnServer({ extra = {}, port }) {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    PORT: String(port),
    // DATABASE_URL points at /dev/null on purpose: if execution gets past
    // the secret check on a refusal-path test, the connection will fail
    // and the process will exit nonzero anyway — but for refusal tests we
    // only check that the FATAL banner appeared, not what happened after.
    // Boot-path tests verify the FATAL banner is ABSENT and the process
    // got past the secret-check sync section (which runs before any await).
    ...extra,
  };
  const child = spawn(process.execPath, [ENTRY], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  const exited = new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
  return { child, exited, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

// Wait for the child to exit on its own. With no DATABASE_URL and no WASM,
// the boot-path cases will fail later (during buildApp), but that failure
// is downstream of the SERVER_SECRET check — what matters is that the
// FATAL-SERVER_SECRET banner is absent.
async function waitForExit(handle, { timeoutMs = 8000 } = {}) {
  return Promise.race([
    handle.exited,
    new Promise((resolve) =>
      setTimeout(() => {
        try { handle.child.kill('SIGKILL'); } catch {}
        resolve({ code: null, signal: 'TIMEOUT' });
      }, timeoutMs)
    ),
  ]);
}

// One port per case so an accidental partial-listen never collides.
let nextPort = 19260;
const port = () => nextPort++;

describe('SERVER_SECRET boot guard (#72)', () => {
  it('no SERVER_SECRET + no AUTH_DEV → exits nonzero with FATAL banner', async () => {
    const h = spawnServer({ port: port(), extra: {} });
    const exit = await waitForExit(h);
    assert.notEqual(exit.code, 0, `expected nonzero exit, got code=${exit.code} signal=${exit.signal}`);
    assert.match(h.stderr, /FATAL/, 'expected FATAL banner in stderr');
    assert.match(h.stderr, /SERVER_SECRET/, 'banner should name SERVER_SECRET');
    assert.match(h.stderr, /AUTH_DEV=1/, 'banner should name the AUTH_DEV=1 escape hatch');
  });

  it('placeholder SERVER_SECRET + no AUTH_DEV → exits nonzero with FATAL banner', async () => {
    const h = spawnServer({ port: port(), extra: { SERVER_SECRET: DEV_SECRET } });
    const exit = await waitForExit(h);
    assert.notEqual(exit.code, 0, `expected nonzero exit, got code=${exit.code} signal=${exit.signal}`);
    assert.match(h.stderr, /FATAL/);
    assert.match(h.stderr, /SERVER_SECRET/);
  });

  it('AUTH_DEV=1 with no SERVER_SECRET → passes the secret check (no FATAL banner)', async () => {
    const h = spawnServer({ port: port(), extra: { AUTH_DEV: '1' } });
    await waitForExit(h);
    // With AUTH_DEV=1 the secret check is bypassed; the process may still
    // fail later (no DATABASE_URL, no WASM in this test sandbox) but the
    // *boot guard* must not be the reason.
    assert.doesNotMatch(h.stderr, /FATAL: SERVER_SECRET/,
      `AUTH_DEV=1 must bypass the secret check; stderr=${h.stderr.slice(0, 500)}`);
  });

  it('explicit SERVER_SECRET=xyz → passes the secret check', async () => {
    const h = spawnServer({ port: port(), extra: { SERVER_SECRET: 'xyz-explicit-not-the-placeholder' } });
    await waitForExit(h);
    assert.doesNotMatch(h.stderr, /FATAL: SERVER_SECRET/,
      `explicit secret must bypass the check; stderr=${h.stderr.slice(0, 500)}`);
  });

  it('explicit SERVER_SECRET + NODE_ENV=production → passes (NODE_ENV no longer relevant)', async () => {
    const h = spawnServer({
      port: port(),
      extra: { SERVER_SECRET: 'prod-secret-xyz-explicit', NODE_ENV: 'production' },
    });
    await waitForExit(h);
    assert.doesNotMatch(h.stderr, /FATAL: SERVER_SECRET/,
      `production + explicit secret must boot; stderr=${h.stderr.slice(0, 500)}`);
  });

  it('NODE_ENV=production with no SERVER_SECRET → still refuses (regression: must not depend on NODE_ENV)', async () => {
    const h = spawnServer({ port: port(), extra: { NODE_ENV: 'production' } });
    const exit = await waitForExit(h);
    assert.notEqual(exit.code, 0);
    assert.match(h.stderr, /FATAL/);
    assert.match(h.stderr, /SERVER_SECRET/);
  });

  it('NODE_ENV unset with no SERVER_SECRET → still refuses (regression: dev environments must fail closed too)', async () => {
    const h = spawnServer({ port: port(), extra: {} });
    // Same as the first test, but stated as a NODE_ENV-independence regression.
    const exit = await waitForExit(h);
    assert.notEqual(exit.code, 0);
    assert.match(h.stderr, /FATAL/);
  });
});
