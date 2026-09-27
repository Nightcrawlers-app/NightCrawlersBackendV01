const jwt = require('jsonwebtoken');

/**
 * Login token.
 *   remember = true (or not given) → valid 30 days ("Remember for 30 days" ticked)
 *   remember = false               → valid 1 day, and the browser forgets it when closed
 */
const signToken = (id, role, { remember = true, expiresIn } = {}) =>
  jwt.sign({ id, role }, process.env.JWT_SECRET, { expiresIn: expiresIn || (remember ? '30d' : '1d') });

// Admin sessions are short: admins can approve vendors and change promotions,
// so a forgotten, signed-in admin browser is a bigger risk. Change in .env.
const ADMIN_SESSION = () => process.env.ADMIN_SESSION_HOURS ? `${Number(process.env.ADMIN_SESSION_HOURS)}h` : '8h';

/** Reads the "remember" choice from a login request. Anything but an explicit false means remember. */
const rememberFrom = (req) => req.body?.remember !== false && req.body?.remember !== 'false';

module.exports = { signToken, rememberFrom, ADMIN_SESSION };
