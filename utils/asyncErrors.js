/**
 * Express 4 doesn't notice when an `async` route handler fails: the error
 * becomes an unhandled promise rejection instead of reaching the error
 * handler. Before server.js logged those, one failed database call in such a
 * route crashed the whole API (everyone saw "Could not reach the server");
 * now it would leave that one request hanging until it timed out.
 *
 * This small patch (the same idea as the `express-async-errors` package)
 * passes any rejected promise from a route or middleware to next(err), so the
 * global error handler in app.js answers properly. Load it once, before any
 * routes are created. Express 5 does this itself — remove this file then.
 */
const Layer = require('express/lib/router/layer');

const original = Layer.prototype.handle_request;
if (!original.__asyncPatched) {
  Layer.prototype.handle_request = function handleRequest(req, res, next) {
    const fn = this.handle;
    // Error-handling middleware (4 arguments) is left alone.
    if (fn.length > 3) return original.call(this, req, res, next);
    try {
      const result = fn(req, res, next);
      if (result && typeof result.then === 'function') {
        result.then(undefined, (err) => next(err || new Error('Request failed')));
      }
    } catch (err) {
      next(err);
    }
  };
  Layer.prototype.handle_request.__asyncPatched = true;
}
