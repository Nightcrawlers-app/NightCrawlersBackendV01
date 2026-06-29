const express = require('express');
const router = express.Router();
const User = require('../models/userModel');
const { signToken } = require('../utils/signToken');
const { protect } = require('../middlewares/auth');
const {
  generateCode,
  sendVerificationEmail,
  sendWelcomeEmail,
  sendPasswordResetEmail,
  sendNewLocationEmail,
} = require('../utils/mailer');
const { checkCooldown, validateCode, CODE_EXPIRY_MS } = require('../utils/codeHelper');

// Helper to get the real IP even behind a proxy
const getIp = (req) =>
  (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
  req.socket.remoteAddress ||
  null;

// POST /api/auth/signup
// Creates account (unverified) and sends a 6-digit code to the email.
router.post('/signup', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required.' });
    }

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing && existing.isVerified) {
      return res.status(409).json({ message: 'Email address is already in use.' });
    }

    // Cooldown check for re-signup attempts
    if (existing) {
      const cooldownError = checkCooldown(existing.verificationCodeSentAt);
      if (cooldownError) return res.status(429).json({ message: cooldownError });
    }
    const code = generateCode();
    const now = new Date();
    const expiry = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes

    const nameParts = (username || '').trim().split(' ');
    const firstName = nameParts[0] || 'User';
    const lastName = nameParts.slice(1).join(' ') || '';

    // If unverified account already exists (re-signup), update it.
    // Otherwise create a fresh one.
    let user;
    if (existing && !existing.isVerified) {
      existing.firstName = firstName;
      existing.lastName = lastName;
      existing.password = password;
      existing.verificationCode = code;
      existing.verificationCodeExpiry = expiry;
      existing.verificationCodeSentAt = now;
      existing.verificationAttempts = 0; //reset attempts on resend
      user = await existing.save();
    } else {
      user = await User.create({
        firstName,
        lastName,
        email,
        password,
        isVerified: false,
        verificationCode: code,
        verificationCodeExpiry: expiry,
        verificationCodeSentAt: now,
        verificationAttempts: 0,
      });
    }

    await sendVerificationEmail(email, firstName, code);

    res.status(201).json({
      message: 'Verification code sent to your email.',
      email,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err.message });
  }
});

// POST /api/auth/verify
// Verifies the 6-digit code. On success, sends welcome email and returns JWT.
router.post('/verify', async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) {
      return res.status(400).json({ message: 'Email and code are required.' });
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(404).json({ message: 'No account found for this email.' });
    }

    if (user.isVerified) {
      return res.status(400).json({ message: 'Account is already verified.' });
    }

    if (!user.verificationCode || user.verificationCode !== code) {
      return res.status(400).json({ message: 'Invalid verification code.' });
    }

    if (!user.verificationCodeExpiry || user.verificationCodeExpiry < new Date()) {
      return res.status(400).json({ message: 'Verification code has expired. Please sign up again.' });
    }

    // Increment attempts before validating
    user.verificationAttempts += 1;
    await user.save();
 
    const result = validateCode(
      user.verificationCode,
      code,
      user.verificationCodeExpiry,
      user.verificationAttempts
    );
    if (!result.valid) {
      return res.status(result.status).json({ message: result.message });
    }

    // Success — clear code and mark verified
    user.isVerified = true;
    user.verificationCode = null;
    user.verificationCodeExpiry = null;
    user.verificationCodeSentAt = null;
    user.verificationAttempts = 0;
    user.lastKnownIp = getIp(req);
    await user.save();

    // Send welcome email (fire-and-forget — don't block the response)
    sendWelcomeEmail(user.email, user.firstName).catch(err =>
      console.error('Welcome email failed:', err.message)
    );

    const token = signToken(user._id, 'customer');
    res.json({ token, user: user.toSafeJSON() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err.message });
  }
});

// POST /api/auth/resend-code
// Resends a fresh verification code.
router.post('/resend-code', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: 'Email is required.' });

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(404).json({ message: 'No account found for this email.' });
    if (user.isVerified) return res.status(400).json({ message: 'Account is already verified.' });
    
    const cooldownError = checkCooldown(user.verificationCodeSentAt);
    if (cooldownError) return res.status(429).json({ message: cooldownError });
    
    const code = generateCode();
    user.verificationCode = code;
    user.verificationCodeExpiry = new Date(Date.now() + 30 * 60 * 1000);
    user.verificationCodeSentAt = new Date();
    user.verificationAttempts = 0;
    await user.save();

    await sendVerificationEmail(email, user.firstName, code);
    res.json({ message: 'A new verification code has been sent.' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email: (email || '').toLowerCase() });

    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ message: 'Invalid credentials.' });
    }

    if (!user.isVerified) {
      return res.status(403).json({
        message: 'Please verify your email before logging in.',
        needsVerification: true,
        email: user.email,
      });
    }

    const currentIp = getIp(req);
    const isNewLocation = user.lastKnownIp && user.lastKnownIp !== currentIp;
 
    if (isNewLocation) {
      const cooldownError = checkCooldown(user.loginCodeSentAt);
      if (cooldownError) return res.status(429).json({ message: cooldownError });
 
      const code = generateCode();
      const now = new Date();
      user.loginCode = code;
      user.loginCodeExpiry = new Date(now.getTime() + CODE_EXPIRY_MS);
      user.loginCodeSentAt = now;
      user.loginCodeAttempts = 0;
      await user.save();
 
      sendNewLocationEmail(user.email, user.firstName, code, currentIp).catch(err =>
        console.error('New location email failed:', err.message)
      );
 
      return res.status(200).json({
        message: 'New location detected. A verification code has been sent to your email.',
        needsLocationVerification: true,
        email: user.email,
      });
    }
 
    user.lastKnownIp = currentIp;
    await user.save();

    const token = signToken(user._id, 'customer');
    res.json({ token, user: user.toSafeJSON() });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── VERIFY LOGIN (new location) ─────────────────────────────────────────────
 
router.post('/verify-login', async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) {
      return res.status(400).json({ message: 'Email and code are required.' });
    }
 
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(404).json({ message: 'No account found for this email.' });
 
    user.loginCodeAttempts += 1;
    await user.save();
 
    const result = validateCode(
      user.loginCode,
      code,
      user.loginCodeExpiry,
      user.loginCodeAttempts
    );
    if (!result.valid) {
      return res.status(result.status).json({ message: result.message });
    }
 
    user.lastKnownIp = getIp(req);
    user.loginCode = null;
    user.loginCodeExpiry = null;
    user.loginCodeSentAt = null;
    user.loginCodeAttempts = 0;
    await user.save();
 
    const token = signToken(user._id, 'customer');
    res.json({ token, user: user.toSafeJSON() });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});
 
// ─── FORGOT PASSWORD ─────────────────────────────────────────────────────────
 
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: 'Email is required.' });
 
    const user = await User.findOne({ email: email.toLowerCase() });
 
    // Always return 200 — don't reveal whether the email exists
    if (!user || !user.isVerified) {
      return res.json({ message: 'If that email exists, a reset code has been sent.' });
    }
 
    const cooldownError = checkCooldown(user.passwordResetSentAt);
    if (cooldownError) return res.status(429).json({ message: cooldownError });
 
    const code = generateCode();
    const now = new Date();
    user.passwordResetCode = code;
    user.passwordResetExpiry = new Date(now.getTime() + CODE_EXPIRY_MS);
    user.passwordResetSentAt = now;
    user.passwordResetAttempts = 0;
    await user.save();
 
    await sendPasswordResetEmail(email, user.firstName, code);
    res.json({ message: 'If that email exists, a reset code has been sent.', email });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});
 
// ─── RESET PASSWORD ──────────────────────────────────────────────────────────
 
router.post('/reset-password', async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;
    if (!email || !code || !newPassword) {
      return res.status(400).json({ message: 'Email, code and new password are required.' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters.' });
    }
 
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(404).json({ message: 'No account found for this email.' });
 
    user.passwordResetAttempts += 1;
    await user.save();
 
    const result = validateCode(
      user.passwordResetCode,
      code,
      user.passwordResetExpiry,
      user.passwordResetAttempts
    );
    if (!result.valid) {
      return res.status(result.status).json({ message: result.message });
    }
 
    user.password = newPassword;
    user.passwordResetCode = null;
    user.passwordResetExpiry = null;
    user.passwordResetSentAt = null;
    user.passwordResetAttempts = 0;
    await user.save();
 
    res.json({ message: 'Password reset successfully. You can now log in.' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET current user
router.get('/me', protect, async (req, res) => {
  try {
    if (req.user.role !== 'customer') return res.status(403).json({ message: 'Forbidden' });
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json(user.toSafeJSON());
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;