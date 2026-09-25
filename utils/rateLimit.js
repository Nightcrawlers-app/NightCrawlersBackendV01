/**
 * Small in-memory rate limiter (no extra dependency).
 *
 *   router.post('/login', rateLimit({ name: 'login', max: 10, windowMs: 15 * MIN, key: byIpAndEmail }), ...)
 *
 * Memory-only means limits reset when the server restarts and aren't shared
 * between multiple API containers. That's fine for one VM; if you ever run
 * several, move this to Redis. nginx also limits overall request rate.
 *
 * Disabled when NODE_ENV=test (the test suite logs in hundreds of times from
 * one address) unless the limiter is created with { enabledInTests: true }.
 */
const MIN = 60 * 1000;
const buckets = new Map(); // "name:key" → [timestamps]

const clientIp = (req) =>
  (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || req.socket?.remoteAddress || 'unknown';

/** Key by IP only. */
const byIp = (req) => clientIp(req);
/** Key by IP + email in the body — so one attacker can't lock out a real user from elsewhere. */
const byIpAndEmail = (req) => `${clientIp(req)}|${String(req.body?.email || '').toLowerCase()}`;
/** Key by logged-in account (falls back to IP). */
const byUser = (req) => (req.user?.id ? `u:${req.user.id}` : clientIp(req));

const rateLimit = ({ name, max, windowMs, key = byIp, message, enabledInTests = false }) => {
  return (req, res, next) => {
    if (process.env.NODE_ENV === 'test' && !enabledInTests) return next();

    const now = Date.now();
    const id = `${name}:${key(req)}`;
    const recent = (buckets.get(id) || []).filter((t) => now - t < windowMs);

    if (recent.length >= max) {
      const retryAfter = Math.ceil((windowMs - (now - recent[0])) / 1000);
      res.set('Retry-After', String(retryAfter));
      const mins = Math.ceil(retryAfter / 60);
      return res.status(429).json({
        message: message || `Too many attempts. Please try again in ${mins} minute${mins === 1 ? '' : 's'}.`,
        retryAfter,
      });
    }
    recent.push(now);
    buckets.set(id, recent);
    next();
  };
};

// Tidy up old entries every 10 minutes so memory doesn't grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [id, times] of buckets) {
    if (!times.length || now - times[times.length - 1] > 60 * MIN) buckets.delete(id);
  }
}, 10 * MIN).unref();

module.exports = { rateLimit, byIp, byIpAndEmail, byUser, MIN };
