const MAX_ATTEMPTS = 5;
const COOLDOWN_SECONDS = 60;
const CODE_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Check cooldown before sending a new code.
 * Returns an error string if still in cooldown, otherwise null.
 */
const checkCooldown = (sentAt) => {
  if (!sentAt) return null;
  const secondsElapsed = (Date.now() - new Date(sentAt).getTime()) / 1000;
  if (secondsElapsed < COOLDOWN_SECONDS) {
    const remaining = Math.ceil(COOLDOWN_SECONDS - secondsElapsed);
    return `Please wait ${remaining} second${remaining !== 1 ? 's' : ''} before requesting a new code.`;
  }
  return null;
};

/**
 * Validate a submitted code against stored code, expiry and attempt count.
 * Returns { valid: true } or { valid: false, status, message }.
 */
const validateCode = (stored, submitted, expiry, attempts) => {
  if (attempts >= MAX_ATTEMPTS) {
    return { valid: false, status: 429, message: 'Too many attempts. Please request a new code.' };
  }
  if (!stored || stored !== submitted) {
    return { valid: false, status: 400, message: 'Invalid verification code.' };
  }
  if (!expiry || new Date(expiry) < new Date()) {
    return { valid: false, status: 400, message: 'Code has expired. Please request a new one.' };
  }
  return { valid: true };
};

module.exports = { checkCooldown, validateCode, CODE_EXPIRY_MS };