const express = require('express');
const { rateLimit, byIp, byIpAndEmail, byUser, MIN } = require('../utils/rateLimit');
const { protect } = require('../middlewares/auth');
const {
  generateCode,
  sendPhoneVerificationCode,
  sendPhoneVerifiedConfirmation,
} = require('../utils/smsService');
const { checkCooldown, validateCode, CODE_EXPIRY_MS } = require('../utils/codeHelper');

/**
 * Creates a phone-verification router for a given model + role.
 *
 * Usage:
 *   const userPhoneRoutes = createPhoneVerificationRoutes(User, 'customer');
 *   app.use('/api/users/me/phone', userPhoneRoutes);
 *
 * Mounted three times in server.js — once each for User, Vendor, Rider —
 * so all three actor types share this exact same logic with zero duplication.
 *
 * Endpoints (relative to wherever this router is mounted):
 *   POST /send     — sends/resends an OTP to req.user's phone
 *   POST /verify   — verifies the OTP and sets phoneVerified = true
 */
const createPhoneVerificationRoutes = (Model, role) => {
  const router = express.Router();

  // All phone verification routes require the user to already be logged in
  router.use(protect);

  // Customers store their number as `phone`, vendors/riders as `phoneNumber`.
  const phoneField = Model.schema.path('phoneNumber') ? 'phoneNumber' : 'phone';

  // POST /number — { phone } set or change the number to verify.
  // Changing it clears any previous verification.
  router.post('/number', rateLimit({ name: `phone-number-${role}`, max: 10, windowMs: 60 * MIN, key: byUser }), async (req, res) => {
    try {
      if (req.user.role !== role) return res.status(403).json({ message: 'Forbidden' });
      const raw = String(req.body.phone || '').replace(/[\s\-()]/g, '');
      // Nigerian mobile: 0803…, 234803…, +234803…
      if (!/^(\+?234|0)[789][01]\d{8}$/.test(raw)) {
        return res.status(400).json({ message: 'Enter a valid Nigerian mobile number, e.g. 08031234567.' });
      }
      const account = await Model.findById(req.user.id);
      if (!account) return res.status(404).json({ message: 'Account not found' });

      if (account[phoneField] !== raw) {
        account[phoneField] = raw;
        account.phoneVerified = false;
        account.phoneVerificationCode = null;
        account.phoneVerificationSentAt = null;
      }
      await account.save();
      res.json({ phone: raw, phoneVerified: account.phoneVerified });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // POST /send — send (or resend) phone verification code
  // SMS costs money — at most 5 per hour per account.
  router.post('/send', rateLimit({ name: `phone-send-${role}`, max: 5, windowMs: 60 * MIN, key: byUser }), async (req, res) => {
    try {
      if (req.user.role !== role) {
        return res.status(403).json({ message: 'Forbidden' });
      }

      const account = await Model.findById(req.user.id);
      if (!account) return res.status(404).json({ message: 'Account not found' });

      const phone = account.phoneNumber || account.phone;
      if (!phone) {
        return res.status(400).json({ message: 'No phone number on file. Please add one first.' });
      }

      if (account.phoneVerified) {
        return res.status(400).json({ message: 'Phone number is already verified.' });
      }

      const cooldownError = checkCooldown(account.phoneVerificationSentAt);
      if (cooldownError) return res.status(429).json({ message: cooldownError });

      const code = generateCode();
      const now = new Date();

      account.phoneVerificationCode = code;
      account.phoneVerificationExpiry = new Date(now.getTime() + CODE_EXPIRY_MS);
      account.phoneVerificationSentAt = now;
      account.phoneVerificationAttempts = 0;
      await account.save();

      await sendPhoneVerificationCode(phone, code, account.firstName);

      res.json({ message: 'Verification code sent to your phone.', phone });
    } catch (err) {
      console.error('Phone verification send failed:', err.message);
      res.status(500).json({ message: err.message });
    }
  });

  // POST /verify — verify the submitted code
  router.post('/verify', rateLimit({ name: `phone-verify-${role}`, max: 15, windowMs: 15 * MIN, key: byUser }), async (req, res) => {
    try {
      if (req.user.role !== role) {
        return res.status(403).json({ message: 'Forbidden' });
      }

      const { code } = req.body;
      if (!code) return res.status(400).json({ message: 'Code is required.' });

      const account = await Model.findById(req.user.id);
      if (!account) return res.status(404).json({ message: 'Account not found' });

      if (account.phoneVerified) {
        return res.status(400).json({ message: 'Phone number is already verified.' });
      }

      account.phoneVerificationAttempts += 1;
      await account.save();

      const result = validateCode(
        account.phoneVerificationCode,
        code,
        account.phoneVerificationExpiry,
        account.phoneVerificationAttempts
      );
      if (!result.valid) {
        return res.status(result.status).json({ message: result.message });
      }

      account.phoneVerified = true;
      account.phoneVerificationCode = null;
      account.phoneVerificationExpiry = null;
      account.phoneVerificationSentAt = null;
      account.phoneVerificationAttempts = 0;
      await account.save();

      const phone = account.phoneNumber || account.phone;
      sendPhoneVerifiedConfirmation(phone, account.firstName).catch((err) =>
        console.error('Phone verified confirmation SMS failed:', err.message)
      );

      res.json({ message: 'Phone number verified successfully.', account: account.toSafeJSON() });
    } catch (err) {
      console.error('Phone verification check failed:', err.message);
      res.status(500).json({ message: err.message });
    }
  });

  return router;
};

module.exports = { createPhoneVerificationRoutes };