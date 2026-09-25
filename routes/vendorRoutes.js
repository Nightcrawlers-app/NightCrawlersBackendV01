const express = require('express');
const { rateLimit, byIp, byIpAndEmail, byUser, MIN } = require('../utils/rateLimit');

// ── Rate limits: stop password guessing and SMS/email spam ──────────────────
const loginLimit = rateLimit({ name: 'login', max: 10, windowMs: 15 * MIN, key: byIpAndEmail });
const loginIpLimit = rateLimit({ name: 'login-ip', max: 50, windowMs: 15 * MIN, key: byIp });
const signupLimit = rateLimit({ name: 'signup', max: 10, windowMs: 60 * MIN, key: byIp });
const sendCodeLimit = rateLimit({ name: 'send-code', max: 5, windowMs: 60 * MIN, key: byIpAndEmail });
const checkCodeLimit = rateLimit({ name: 'check-code', max: 15, windowMs: 15 * MIN, key: byIpAndEmail });
const router = express.Router();
const Vendor = require('../models/vendorModel');
const { BUSINESS_TYPES } = require('../models/vendorModel');
const { geocodeAddress, readLatLng, toPoint } = require('../utils/geocoder');
const { signToken } = require('../utils/signToken');
const { protect, requireRole } = require('../middlewares/auth');
const { sendVendorWelcomeEmail } = require('../utils/mailer');

// GET /api/vendors/business-types — the allowed values, for the signup dropdown
router.get('/business-types', (req, res) => res.json(BUSINESS_TYPES));

// POST /api/vendors — create vendor account
router.post('/', signupLimit, async (req, res) => {
  try {
    const { firstName, lastName, businessType, phoneNumber, email, location, password } = req.body;

    if (!email || !password || !location) {
      return res.status(400).json({ message: 'email, password and location are required.' });
    }

    // The signup form now sends one of the exact values from a dropdown.
    // Anything else is rejected rather than silently guessed as 'Food'.
    if (!BUSINESS_TYPES.includes(businessType)) {
      return res.status(400).json({
        message: `Please choose a business type: ${BUSINESS_TYPES.join(', ')}.`,
        allowed: BUSINESS_TYPES,
      });
    }

    const existing = await Vendor.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(409).json({ message: 'Email address is already in use.' });
    }

    // Pin from the signup map, else geocode the typed location.
    const point = readLatLng(req.body) || (await geocodeAddress(location));

    const vendor = await Vendor.create({
      firstName,
      lastName,
      businessType,
      businessTypeRaw: businessType,
      phoneNumber,
      email,
      location,
      password,
      verified: false,
      ...(point && { coordinates: toPoint(point) }),
    });

     // Fire-and-forget welcome email
    sendVendorWelcomeEmail(vendor.email, vendor.firstName, vendor.businessTypeRaw || vendor.businessType)
      .catch(err => console.error('Vendor welcome email failed:', err.message));

    const token = signToken(vendor._id, 'vendor');
    res.status(201).json({ token, vendor: vendor.toSafeJSON() });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/vendors/login
router.post('/login', loginIpLimit, loginLimit, async (req, res) => {
  try {
    const { email, password } = req.body;
    const vendor = await Vendor.findOne({ email: (email || '').toLowerCase() });
    if (!vendor || !(await vendor.comparePassword(password))) {
      return res.status(401).json({ message: 'Incorrect email or password.' });
    }

    const token = signToken(vendor._id, 'vendor');
    res.json({ token, vendor: vendor.toSafeJSON() });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/vendors/me
router.get('/me', protect, requireRole('vendor'), async (req, res) => {
  try {
    const vendor = await Vendor.findById(req.user.id);
    if (!vendor) return res.status(404).json({ message: 'Vendor not found' });
    res.json(vendor.toSafeJSON());
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/vendors/:vendorId/stores — the frontend's vendor dashboard calls
// this path, but it was never mounted (only /api/stores/vendor/:id existed).
router.get('/:vendorId/stores', protect, async (req, res) => {
  try {
    if (req.user.role !== 'admin' && String(req.user.id) !== req.params.vendorId) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    const Store = require('../models/storeModel');
    const stores = await Store.find({ vendorId: req.params.vendorId }).sort({ createdAt: -1 });
    res.json(stores);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/{vendors|riders}/me/reapply — a rejected applicant goes back into
// the admin's approval queue (after fixing whatever the reason said).
router.post('/me/reapply', protect, requireRole('vendor'), async (req, res) => {
  try {
    const account = await Vendor.findById(req.user.id);
    if (!account) return res.status(404).json({ message: 'Account not found' });
    if (!account.rejectedAt) return res.status(400).json({ message: 'Your application is not rejected.' });
    account.rejectedAt = null;
    account.rejectionReason = null;
    await account.save();
    res.json(account.toSafeJSON());
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;