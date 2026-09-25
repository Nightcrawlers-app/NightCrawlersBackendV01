const express = require('express');
const { rateLimit, byIp, byIpAndEmail, byUser, MIN } = require('../utils/rateLimit');

// ── Rate limits: stop password guessing and SMS/email spam ──────────────────
const loginLimit = rateLimit({ name: 'login', max: 10, windowMs: 15 * MIN, key: byIpAndEmail });
const loginIpLimit = rateLimit({ name: 'login-ip', max: 50, windowMs: 15 * MIN, key: byIp });
const signupLimit = rateLimit({ name: 'signup', max: 10, windowMs: 60 * MIN, key: byIp });
const sendCodeLimit = rateLimit({ name: 'send-code', max: 5, windowMs: 60 * MIN, key: byIpAndEmail });
const checkCodeLimit = rateLimit({ name: 'check-code', max: 15, windowMs: 15 * MIN, key: byIpAndEmail });
const router = express.Router();
const Admin = require('../models/adminModel');
const { signToken } = require('../utils/signToken');
const { protect, requireRole } = require('../middlewares/auth');

// POST /api/admins/login
router.post('/login', loginIpLimit, loginLimit, async (req, res) => {
  try {
    const { email, password } = req.body;
    const admin = await Admin.findOne({ email: (email || '').toLowerCase() });
    if (!admin || !(await admin.comparePassword(password))) {
      return res.status(401).json({ message: 'Access Denied: Invalid credentials.' });
    }

    const token = signToken(admin._id, 'admin');
    res.json({ token, admin: admin.toSafeJSON() });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/admins/me
router.get('/me', protect, requireRole('admin'), async (req, res) => {
  try {
    const admin = await Admin.findById(req.user.id);
    if (!admin) return res.status(404).json({ message: 'Admin not found' });
    res.json(admin.toSafeJSON());
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/admins — create new admin account (should be locked down / seed-only in production)
router.post('/', protect, requireRole('admin'), async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ message: 'username, email and password are required.' });
    }

    const existing = await Admin.findOne({ $or: [{ email: email.toLowerCase() }, { username }] });
    if (existing) {
      return res.status(409).json({ message: 'Admin with this email or username already exists.' });
    }

    const admin = await Admin.create({ username, email, password });
    res.status(201).json(admin.toSafeJSON());
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;