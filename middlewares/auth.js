const jwt = require('jsonwebtoken');

/**
 * Cookie names — one per role so vendor + rider can coexist in the same browser.
 * httpOnly: true  → JS cannot read the token (XSS protection)
 * secure: true    → only sent over HTTPS (set to false in dev via NODE_ENV check)
 * sameSite: 'lax' → sent on same-site navigations, blocks CSRF from other origins
 */
const COOKIE_NAMES = {
  customer: 'nc_customer_token',
  vendor:   'nc_vendor_token',
  rider:    'nc_rider_token',
  admin:    'nc_admin_token',
};

/**
 * Cookie options — secure only in production.
 */
const cookieOptions = (maxAgeDays = 30) => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
  maxAge: maxAgeDays * 24 * 60 * 60 * 1000,
  path: '/',
});

/**
 * Sets an httpOnly session cookie for the given role.
 * Call this in login/signup handlers instead of returning the token in the body.
 */
const setAuthCookie = (res, token, role) => {
  const name = COOKIE_NAMES[role];
  if (!name) throw new Error(`Unknown role: ${role}`);
  res.cookie(name, token, cookieOptions());
};

/**
 * Clears the session cookie for the given role.
 * Call this in logout handlers.
 */
const clearAuthCookie = (res, role) => {
  const name = COOKIE_NAMES[role];
  if (name) {
    res.clearCookie(name, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      path: '/',
    });
  }
};

/**
 * Extracts and verifies a JWT from either:
 *   1. An httpOnly cookie (preferred — set by login/signup)
 *   2. Authorization: Bearer <token> header (fallback for API clients / tests)
 *
 * Attaches { id, role } to req.user on success.
 */
const protect = (req, res, next) => {
  let token = null;

  // 1. Try cookies first (most secure path)
  if (req.cookies) {
    for (const name of Object.values(COOKIE_NAMES)) {
      if (req.cookies[name]) {
        token = req.cookies[name];
        break;
      }
    }
  }

  // 2. Fall back to Authorization header (API clients, Jest tests)
  if (!token) {
    const header = req.headers.authorization || '';
    if (header.startsWith('Bearer ')) token = header.slice(7);
  }

  if (!token) {
    return res.status(401).json({ message: 'Not authenticated' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // { id, role }
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
};

/**
 * Restricts access to specific roles.
 */
const requireRole = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return res.status(403).json({ message: 'Forbidden: insufficient role' });
  }
  next();
};

/**
 * Like protect, but does not fail if no token is present.
 */
const optionalAuth = (req, res, next) => {
  let token = null;

  if (req.cookies) {
    for (const name of Object.values(COOKIE_NAMES)) {
      if (req.cookies[name]) {
        token = req.cookies[name];
        break;
      }
    }
  }

  if (!token) {
    const header = req.headers.authorization || '';
    if (header.startsWith('Bearer ')) token = header.slice(7);
  }

  if (!token) return next();

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    // ignore invalid token
  }
  next();
};

module.exports = { protect, requireRole, optionalAuth, setAuthCookie, clearAuthCookie };