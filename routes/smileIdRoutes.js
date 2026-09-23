const express = require('express');
const router = express.Router();
const axios = require('axios');
const crypto = require('crypto');
const Vendor = require('../models/vendorModel');
const Rider = require('../models/riderModel');
const { protect, requireRole } = require('../middlewares/auth');

const SMILEID_BASE = process.env.SMILEID_ENVIRONMENT === 'production'
  ? 'https://api.smileidentity.com/v1'
  : 'https://testapi.smileidentity.com/v1';

const PARTNER_ID = process.env.SMILEID_PARTNER_ID;
const API_KEY = process.env.SMILEID_API_KEY;

/**
 * Generates the SmileID signature required for authenticated requests.
 * Signature = base64(HMAC-SHA256(timestamp + partner_id, api_key))
 */
const generateSignature = (timestamp) => {
  const message = `${timestamp}${PARTNER_ID}`;
  return crypto
    .createHmac('sha256', API_KEY)
    .update(message)
    .digest('base64');
};

// ── POST /api/kyc/smileid/token ───────────────────────────────────────────────
// Mints a short-lived SmileID v3 token for the Web SDK.
// The frontend calls this BEFORE loading the SmileID modal.
// The token proves to SmileID that this is a legitimate session
// without exposing the API key to the browser.
router.post('/smileid/token', protect, async (req, res) => {
  try {
    const { role } = req.user;
    if (!['vendor', 'rider'].includes(role)) {
      return res.status(403).json({ message: 'KYC is only for vendors and riders.' });
    }

    const timestamp = new Date().toISOString();
    const signature = generateSignature(timestamp);

    // callback_url is where SmileID posts the verification result
    const callbackUrl = `${process.env.API_BASE_URL || 'https://api.nightcrawlers.app'}/api/kyc/smileid/callback`;

    const response = await axios.post(`${SMILEID_BASE}/token`, {
      partner_id: PARTNER_ID,
      timestamp,
      signature,
      callback_url: callbackUrl,
      products: ['biometric_kyc'],
    });

    res.json({
      token: response.data.token,
      callbackUrl,
    });
  } catch (err) {
    const message = err.response?.data?.message || err.message;
    console.error('SmileID token error:', message);
    res.status(500).json({ message: `Could not mint SmileID token: ${message}` });
  }
});

// ── POST /api/kyc/smileid/callback ────────────────────────────────────────────
// SmileID posts the verification result here after the user completes
// the selfie/liveness flow. This is the ONLY place the actual verdict arrives —
// never trust the browser callback.
//
// No auth middleware — SmileID posts from their servers, not the user's browser.
// We verify authenticity by checking the signature in the payload.
router.post('/smileid/callback', async (req, res) => {
  try {
    const {
      partner_params,
      Actions,
      signature,
      timestamp,
      smile_job_id,
    } = req.body;

    // ── Verify SmileID signature ───────────────────────────────────────────
    const expectedSignature = generateSignature(timestamp);
    if (signature !== expectedSignature) {
      console.error('SmileID callback: invalid signature');
      return res.status(400).json({ message: 'Invalid signature' });
    }

    // partner_params.user_id = our internal ID, partner_params.job_type = role
    const { user_id: userId, job_type: role } = partner_params || {};

    if (!userId || !['vendor', 'rider'].includes(role)) {
      console.error('SmileID callback: missing or invalid user_id/role', partner_params);
      return res.status(400).json({ message: 'Invalid partner_params' });
    }

    // ── Interpret the verdict ──────────────────────────────────────────────
    // Actions.Liveness_Check and Actions.Selfie_Provided are key fields.
    // "Passed" means the check succeeded.
    const livenessPassed = Actions?.Liveness_Check === 'Passed';
    const selfiePassed = Actions?.Selfie_Provided === 'Passed';
    const overallPassed = livenessPassed && selfiePassed;

    console.log(`SmileID callback: job=${smile_job_id} user=${userId} role=${role} passed=${overallPassed}`);

    // ── Update the model ───────────────────────────────────────────────────
    const Model = role === 'vendor' ? Vendor : Rider;
    const account = await Model.findById(userId);

    if (!account) {
      console.error(`SmileID callback: ${role} ${userId} not found`);
      return res.status(404).json({ message: `${role} not found` });
    }

    account.selfieVerified = overallPassed;
    account.selfieJobId = smile_job_id;

    // Recalculate KYC status
    if (role === 'vendor') {
      const agentPathDone = account.ninVerified && account.agentVerified;
      const digitalPathDone = account.ninVerified && account.selfieVerified && !!account.termsSignedAt;
      const anyStarted = account.ninVerified || account.agentVerified || account.selfieVerified;

      if (agentPathDone || digitalPathDone) {
        account.kycStatus = 'passed';
      } else if (anyStarted) {
        account.kycStatus = 'in_progress';
      }
    } else {
      // rider
      const checks = [account.ninVerified, account.licenseVerified, account.addressVerified, account.selfieVerified];
      const anyStarted = checks.some(Boolean);

      if (checks.every(Boolean)) {
        account.kycStatus = 'passed';
      } else if (anyStarted) {
        account.kycStatus = 'in_progress';
      }
    }

    await account.save();

    // SmileID expects a 200 response to acknowledge receipt
    res.json({ success: true });
  } catch (err) {
    console.error('SmileID callback error:', err.message);
    res.status(500).json({ message: err.message });
  }
});

// ── GET /api/kyc/smileid/status ───────────────────────────────────────────────
// Returns the current selfie verification status for the logged-in user.
router.get('/smileid/status', protect, async (req, res) => {
  try {
    const { role, id } = req.user;
    if (!['vendor', 'rider'].includes(role)) {
      return res.status(403).json({ message: 'KYC is only for vendors and riders.' });
    }

    const Model = role === 'vendor' ? Vendor : Rider;
    const account = await Model.findById(id);
    if (!account) return res.status(404).json({ message: 'Account not found' });

    res.json({
      selfieVerified: account.selfieVerified,
      selfieJobId: account.selfieJobId,
      kycStatus: account.kycStatus,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;