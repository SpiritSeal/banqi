// Wraps an async Express handler so rejected promises propagate to
// `next(err)` instead of silently hanging the request.
export const asyncRoute = (fn) => (req, res, next) => fn(req, res, next).catch(next);
