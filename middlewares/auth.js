const jwt = require('jsonwebtoken');

/**
 * Verifies JWT and attaches { id, role } to req.user.
 * Token payload shape: { id, role } where role is one of
 * 'customer' | 'vendor' | 'rider' | 'admin'.
 */
const protect = (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

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
 * Usage: requireRole('vendor', 'admin')
 */
const requireRole = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return res.status(403).json({ message: 'Forbidden: insufficient role' });
  }
  next();
};

/**
 * Like protect, but does not fail if no token is present.
 * Useful for routes that behave differently for logged-in vs anonymous users.
 */
const optionalAuth = (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) return next();

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    // ignore invalid token, proceed as anonymous
  }
  next();
};

module.exports = { protect, requireRole, optionalAuth };