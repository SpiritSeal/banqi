// Node-level tests of the LAN relay (infra/relay.mjs).
//
// Drives the relay through raw WebSocket clients — no browser. Exercises the
// pairing protocol, role assignment, message forwarding, third-client
// rejection, partner-gone notification, room reuse after both peers leave,
// path-traversal protection, and the bare-GET-/ → ?relay=auto redirect.
//
// Usage:  node tests/test_relay.mjs

import { startRelay } from '../infra/relay.mjs';
import { WebSocket } from 'ws';
import { request as httpRequest } from 'node:http';

let passed = 0;
let failed = 0;

function ok(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}` + (detail ? `\n      ${detail}` : ''));
  }
}

async function withRelay(fn) {
  const r = await startRelay({ port: 0, host: '127.0.0.1', verbose: false });
  try { await fn(r); }
  finally { await r.close(); }
}

function withTimeout(p, ms, label) {
  let t;
  return Promise.race([
    p,
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`timeout: ${label}`)), ms); }),
  ]).finally(() => clearTimeout(t));
}

function connect(port, path = '/banqi') {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  const inbox = [];
  const wakers = [];
  ws.on('message', (data) => {
    const text = data.toString();
    inbox.push(text);
    while (wakers.length) wakers.shift()();
  });
  let closed = null;
  ws.on('close', (code, reason) => { closed = { code, reason: reason.toString() }; });
  return {
    ws,
    opened: new Promise((res, rej) => {
      ws.once('open', res);
      ws.once('error', rej);
    }),
    async next(timeoutMs = 1500) {
      while (!inbox.length) {
        if (closed) throw new Error(`closed before message: ${closed.code} ${closed.reason}`);
        await withTimeout(new Promise(r => wakers.push(r)), timeoutMs, 'next message');
      }
      return JSON.parse(inbox.shift());
    },
    /** True once the WS has emitted a 'close' event. */
    get closed() { return closed; },
    /** Wait for the close event. */
    waitClose(timeoutMs = 1500) {
      if (closed) return Promise.resolve(closed);
      return withTimeout(new Promise((res) => ws.once('close', (c, r) => res({ code: c, reason: r.toString() }))), timeoutMs, 'close');
    },
    send(s) { ws.send(s); },
    close() { try { ws.close(); } catch (_) {} },
  };
}

// --- TESTS ---

async function testRoleAssignmentAndPairing(r) {
  console.log('test: role assignment + relay-paired notification');
  const a = connect(r.port);
  await a.opened;
  const m1 = await a.next();
  ok('first client gets relay-role host', m1.type === 'relay-role' && m1.role === 'host', JSON.stringify(m1));

  const b = connect(r.port);
  await b.opened;
  const m2 = await b.next();
  ok('second client gets relay-role join', m2.type === 'relay-role' && m2.role === 'join', JSON.stringify(m2));

  // Both should now see relay-paired.
  const pairedA = await a.next();
  const pairedB = await b.next();
  ok('host sees relay-paired after second connects', pairedA.type === 'relay-paired', JSON.stringify(pairedA));
  ok('join sees relay-paired immediately', pairedB.type === 'relay-paired', JSON.stringify(pairedB));

  a.close(); b.close();
  await new Promise(r => setTimeout(r, 50));   // let close fire
}

async function testForwardingBothDirections(r) {
  console.log('test: messages forward both directions');
  const a = connect(r.port);
  const b = connect(r.port);
  await Promise.all([a.opened, b.opened]);
  await a.next(); await b.next();        // role
  await a.next(); await b.next();        // paired

  a.send('hello-from-host');
  const got_b = await withTimeout(
    new Promise(res => b.ws.once('message', (d) => res(d.toString()))),
    1000, 'b receive');
  ok('host → join forwarded verbatim', got_b === 'hello-from-host', got_b);

  b.send('reply-from-join');
  const got_a = await withTimeout(
    new Promise(res => a.ws.once('message', (d) => res(d.toString()))),
    1000, 'a receive');
  ok('join → host forwarded verbatim', got_a === 'reply-from-join', got_a);

  a.close(); b.close();
  await new Promise(r => setTimeout(r, 50));
}

async function testThirdClientRejected(r) {
  console.log('test: third client is rejected (room full)');
  const a = connect(r.port);
  const b = connect(r.port);
  await Promise.all([a.opened, b.opened]);
  await a.next(); await b.next(); await a.next(); await b.next(); // drain role+paired

  const c = connect(r.port);
  await c.opened;
  const err = await c.next();
  ok('third client gets relay-error', err.type === 'relay-error' && /room full/i.test(err.reason || ''), JSON.stringify(err));
  const closeInfo = await c.waitClose(1500);
  ok('third client connection is closed', closeInfo.code !== 0, JSON.stringify(closeInfo));

  // Existing pair still works.
  a.send('still-alive');
  const got = await withTimeout(
    new Promise(res => b.ws.once('message', (d) => res(d.toString()))),
    1000, 'still-alive forward');
  ok('existing pair unaffected by reject', got === 'still-alive', got);

  a.close(); b.close();
  await new Promise(r => setTimeout(r, 50));
}

async function testPartnerGoneAndRoomReuse(r) {
  console.log('test: partner-gone notification + room reuses after both leave');
  const a = connect(r.port);
  const b = connect(r.port);
  await Promise.all([a.opened, b.opened]);
  await a.next(); await b.next(); await a.next(); await b.next();   // drain handshake

  // Close A — B should get relay-partner-gone and then a close.
  a.close();
  const partnerGone = await b.next(2000);
  ok('partner-gone delivered to surviving peer', partnerGone.type === 'relay-partner-gone', JSON.stringify(partnerGone));
  await b.waitClose(2000);
  ok('surviving peer is then closed by relay', !!b.closed, '');

  // Now a fresh pair should work.
  const c = connect(r.port);
  const d = connect(r.port);
  await Promise.all([c.opened, d.opened]);
  const cm1 = await c.next();
  const dm1 = await d.next();
  ok('new pair: first client gets host role', cm1.type === 'relay-role' && cm1.role === 'host', JSON.stringify(cm1));
  ok('new pair: second client gets join role', dm1.type === 'relay-role' && dm1.role === 'join', JSON.stringify(dm1));
  await c.next(); await d.next();    // paired
  c.close(); d.close();
  await new Promise(r => setTimeout(r, 50));
}

function httpGet(port, path) {
  return new Promise((res, rej) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET' }, (resp) => {
      const chunks = [];
      resp.on('data', c => chunks.push(c));
      resp.on('end', () => res({
        status: resp.statusCode,
        location: resp.headers.location,
        body: Buffer.concat(chunks).toString(),
        headers: resp.headers,
      }));
    });
    req.on('error', rej);
    req.end();
  });
}

async function testHttpRedirect(r) {
  console.log('test: bare GET / redirects to /?relay=auto');
  const r1 = await httpGet(r.port, '/');
  ok('GET / returns 302', r1.status === 302, `status=${r1.status}`);
  ok('GET / redirects to /?relay=auto', r1.location === '/?relay=auto', `location=${r1.location}`);

  const r2 = await httpGet(r.port, '/?relay=auto');
  ok('GET /?relay=auto returns 200', r2.status === 200, `status=${r2.status}`);
  ok('redirect target serves index.html', /<title>Banqi/.test(r2.body), r2.body.slice(0, 80));

  const r3 = await httpGet(r.port, '/index.html');
  ok('direct GET /index.html still serves (no redirect loop)', r3.status === 200,
     `status=${r3.status} location=${r3.location}`);
}

async function testStaticFiles(r) {
  console.log('test: relay serves static assets');
  const css = await httpGet(r.port, '/style.css');
  ok('GET /style.css returns 200', css.status === 200, `status=${css.status}`);
  ok('style.css has correct mime type', /text\/css/.test(css.headers['content-type']), css.headers['content-type']);

  const js  = await httpGet(r.port, '/main.js');
  ok('GET /main.js returns 200', js.status === 200, `status=${js.status}`);
  ok('main.js has correct mime type', /javascript/.test(js.headers['content-type']), js.headers['content-type']);

  const wasm = await httpGet(r.port, '/banqi.wasm');
  ok('GET /banqi.wasm returns 200', wasm.status === 200, `status=${wasm.status}`);
  ok('banqi.wasm has correct mime type', wasm.headers['content-type'] === 'application/wasm', wasm.headers['content-type']);
}

async function testPathTraversalRejected(r) {
  console.log('test: path traversal is rejected');
  // node:http normalizes /../etc/passwd -> /etc/passwd before our handler sees it,
  // so an explicit ../ in the path is what's interesting.
  const traversal = await httpGet(r.port, '/foo/../../etc/passwd');
  ok('traversal-style path rejected with non-200',
     traversal.status === 400 || traversal.status === 404,
     `status=${traversal.status} body="${traversal.body.slice(0,60)}"`);
}

async function testCorrectWsPath(r) {
  console.log('test: only /banqi accepts WebSocket upgrades');
  // The HTTP server returns 404 (not WS) for non-/banqi paths.
  const wrong = await httpGet(r.port, '/nope');
  ok('non-/banqi path 404s', wrong.status === 404, `status=${wrong.status}`);
}

async function main() {
  console.log('== relay protocol tests ==');
  await withRelay(testRoleAssignmentAndPairing);
  await withRelay(testForwardingBothDirections);
  await withRelay(testThirdClientRejected);
  await withRelay(testPartnerGoneAndRoomReuse);
  await withRelay(testHttpRedirect);
  await withRelay(testStaticFiles);
  await withRelay(testPathTraversalRejected);
  await withRelay(testCorrectWsPath);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FAILED with exception:', e);
  process.exit(1);
});
