const express = require('express');
const router = express.Router();
const Vendor = require('../models/vendorModel');
const { signToken } = require('../utils/signToken');
const { protect, requireRole } = require('../middlewares/auth');
const { sendVendorWelcomeEmail } = require('../utils/mailer');

const resolveBusinessType = (input) => {
  const normalized = (input || '').toLowerCase().trim();
  const map = [
    { type: 'Food', keywords: ['food', 'restaurant', 'resto', 'cafe', 'kitchen', 'diner', 'meal'] },
    { type: 'Groceries', keywords: ['grocery', 'supermarket', 'market', 'mart', 'grocer'] },
    { type: 'Pharmacy', keywords: ['pharmacy', 'chemist', 'drug', 'medicine', 'med'] },
    { type: 'Drinks', keywords: ['drink', 'drinks', 'beverage', 'liquor', 'wine', 'alcohol'] },
    { type: 'Clubs/Lounges', keywords: ['club', 'lounge', 'nightlife', 'bar'] },
  ];
  for (const entry of map) {
    if (entry.keywords.some((kw) => normalized.includes(kw))) return entry.type;
  }
  return 'Food';
};

// POST /api/vendors — create vendor account
router.post('/', async (req, res) => {
  try {
    const { firstName, lastName, businessType, phoneNumber, email, location, password } = req.body;

    if (!email || !password || !location) {
      return res.status(400).json({ message: 'email, password and location are required.' });
    }

    const existing = await Vendor.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(409).json({ message: 'Email address is already in use.' });
    }

    const vendor = await Vendor.create({
      firstName,
      lastName,
      businessType: resolveBusinessType(businessType),
      businessTypeRaw: businessType || '',
      phoneNumber,
      email,
      location,
      password,
      verified: false,
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
router.post('/login', async (req, res) => {
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

module.exports = router;