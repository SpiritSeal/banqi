// Sign a Playwright browser context in as a dev user against a running
// relay (see relay_harness.mjs). Drives the same /auth/dev?name=...
// endpoint the server-side tests use, captures the Set-Cookie, and
// installs it on the context so subsequent page.goto calls are
// authenticated.
//
// Notes:
//   - Requires AUTH_DEV=1 on the server (startRelayHarness sets this).
//   - The cookie is session-only (no Max-Age in the Set-Cookie from the
//     dev backdoor), so install on the context, not on the page. Cookies
//     installed on the context are sent for every page in that context.

export async function signInBrowserAs(context, baseUrl, name) {
  const url = new URL(baseUrl);
  const apiRes = await context.request.get(
    `${baseUrl}/auth/dev?name=${encodeURIComponent(name)}`,
    { maxRedirects: 0 }
  );
  // The cookie has been stored on the context's storage state by
  // context.request automatically; nothing else to do for the cookie
  // itself. Return the parsed cookie so callers that want to make their
  // own raw fetches (e.g. opening a second user's WS from Node) have it.
  const setCookie = apiRes.headers()['set-cookie'];
  if (!setCookie) {
    throw new Error(`dev sign-in for "${name}" did not return a Set-Cookie (status ${apiRes.status()})`);
  }
  const cookiePair = setCookie.split(/\r?\n/)[0].split(';')[0];
  return { cookie: cookiePair, origin: `${url.protocol}//${url.host}` };
}
