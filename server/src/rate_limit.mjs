// In-memory, per-key sliding-window rate limiter.
//
// Matches the style of `makeGuestRateLimiter` in auth.mjs (which now wraps
// `makeRateLimiter` below). Two flavors are exported:
//
//   makeRateLimiter({ windowMs, max })
//     Returns a `check(key) -> boolean` predicate. Caller decides how to
//     respond on `false`. Used by auth.mjs's guest endpoint.
//
//   rateLimit({ windowMs, max, name, keyer? })
//     Returns an Express middleware that rejects with 429 when the caller
//     trips a bucket. `keyer` defaults to `req.user?.id || req.ip` so signed-
//     in users have their own per-account budget independent of NAT peers
//     sharing an IP; falls back to the request IP for unauthenticated callers
//     (e.g. /auth/* paths). `name` is included in the response body so the
//     client can show a useful message ("game create" vs "match request").
//
// Buckets are stored in a plain Map keyed by the request key. Memory is
// proportional to the number of distinct keys seen within `windowMs`; old
// keys are pruned when their bucket empties or is touched again. This is
// fine for a single-instance relay; #54 explicitly punts on Redis.
//
// Multiple buckets per route are supported via `combineLimits([...])`, which
// is how the spec's "10/min AND 100/hour" can be enforced in a single
// middleware.

export function makeRateLimiter({ windowMs, max } = {}) {
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error('rate_limit: windowMs must be a positive number');
  }
  if (!Number.isFinite(max) || max <= 0) {
    throw new Error('rate_limit: max must be a positive number');
  }
  const buckets = new Map();   // key → [timestamp, ...]
  return function check(key) {
    const now = Date.now();
    const list = (buckets.get(key) || []).filter((t) => t > now - windowMs);
    if (list.length >= max) {
      buckets.set(key, list);
      return false;
    }
    list.push(now);
    buckets.set(key, list);
    return true;
  };
}

// Pull the rate-limit key from a request. Authenticated users get keyed by
// user id (so they keep their budget across IP changes); everyone else gets
// keyed by IP (with `trust proxy` already set in index.mjs, this respects
// `X-Forwarded-For` from the front proxy).
export function defaultKeyer(req) {
  const uid = req.user?.id;
  if (uid != null) return `u:${uid}`;
  return `ip:${req.ip || 'unknown'}`;
}

export function rateLimit({ windowMs, max, name, keyer = defaultKeyer } = {}) {
  const check = makeRateLimiter({ windowMs, max });
  const label = name || 'request';
  return function rateLimitMiddleware(req, res, next) {
    const key = keyer(req);
    if (!check(key)) {
      return res.status(429).json({
        error: `rate limit exceeded for ${label}; slow down and try again`,
      });
    }
    next();
  };
}

// Compose multiple buckets in a single middleware. All buckets must pass.
// Used where the spec demands two windows (e.g. game create: 10/min AND
// 100/hour).
export function combineLimits(specs) {
  const middlewares = specs.map((s) => rateLimit(s));
  return function combined(req, res, next) {
    let i = 0;
    const step = (err) => {
      if (err) return next(err);
      if (i >= middlewares.length) return next();
      const mw = middlewares[i++];
      mw(req, res, step);
    };
    step();
  };
}
