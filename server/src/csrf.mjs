// Same-origin guard for state-changing HTTP methods. CSRF mitigation that
// piggybacks on the browser's built-in Origin / Referer headers instead of
// adding a token scheme — the trade-off is documented in #73.
//
// Behaviour:
//   - GET / HEAD / OPTIONS always pass through (idempotent, no side effects).
//   - Every other method requires the request's Origin header (falling back
//     to Referer, since some clients omit Origin on same-origin GETs that
//     follow redirects) to parse cleanly AND match the configured publicUrl's
//     `URL.origin` exactly. A missing header is itself a fail — modern
//     browsers populate Origin on every cross-site fetch / form submission /
//     XHR, so an absent header on a state-changing request is a strong CSRF
//     signal.
//   - On mismatch we respond 403 with `{ error: 'cross-origin request
//     blocked' }`, matching the JSON-error convention used elsewhere in the
//     API.

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function requireSameOrigin(publicUrl) {
  // Compute the expected origin once at startup. URL throws on garbage, which
  // we want to surface immediately rather than per-request.
  const expected = new URL(publicUrl).origin;

  return function sameOriginMiddleware(req, res, next) {
    if (SAFE_METHODS.has(req.method)) return next();

    const source = req.headers.origin || req.headers.referer;
    if (!source) {
      return res.status(403).json({ error: 'cross-origin request blocked' });
    }
    let candidate;
    try {
      candidate = new URL(source).origin;
    } catch {
      return res.status(403).json({ error: 'cross-origin request blocked' });
    }
    if (candidate !== expected) {
      return res.status(403).json({ error: 'cross-origin request blocked' });
    }
    next();
  };
}
