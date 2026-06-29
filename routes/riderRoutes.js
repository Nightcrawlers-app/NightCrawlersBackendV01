const express = require('express');
const router = express.Router();
const Rider = require('../models/riderModel');
const { signToken } = require('../utils/signToken');
const { protect, requireRole } = require('../middlewares/auth');
const { sendRiderWelcomeEmail } = require('../utils/mailer'); // ✅ ADDED

// POST /api/riders — create rider account
router.post('/', async (req, res) => {
  try {
    const { firstName, lastName, vehicleType, phoneNumber, email, location, password } = req.body;

    if (!email || !password || !location || !vehicleType) {
      return res.status(400).json({ message: 'Missing required fields.' });
    }

    const existing = await Rider.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(409).json({ message: 'Email address is already in use.' });
    }

    const rider = await Rider.create({
      firstName,
      lastName,
      vehicleType,
      phoneNumber,
      email,
      location,
      password,
      verified: false,
    });

    // ✅ ADDED: fire-and-forget welcome email (mirrors vendorRoutes pattern)
    sendRiderWelcomeEmail(rider.email, rider.firstName, rider.vehicleType).catch((err) =>
      console.error('Rider welcome email failed:', err.message)
    );

    const token = signToken(rider._id, 'rider');
    res.status(201).json({ token, rider: rider.toSafeJSON() });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/riders/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const rider = await Rider.findOne({ email: (email || '').toLowerCase() });
    if (!rider || !(await rider.comparePassword(password))) {
      return res.status(401).json({ message: 'Incorrect email or password.' });
    }

    const token = signToken(rider._id, 'rider');
    res.json({ token, rider: rider.toSafeJSON() });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/riders/me
router.get('/me', protect, requireRole('rider'), async (req, res) => {
  try {
    const rider = await Rider.findById(req.user.id);
    if (!rider) return res.status(404).json({ message: 'Rider not found' });
    res.json(rider.toSafeJSON());
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/riders/:id/status — set online/offline
router.patch('/:id/status', protect, requireRole('rider'), async (req, res) => {
  try {
    if (req.params.id !== req.user.id) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    const { isOnline } = req.body;
    const rider = await Rider.findByIdAndUpdate(
      req.params.id,
      { isOnline: !!isOnline, lastSeen: new Date() },
      { new: true }
    );
    res.json(rider.toSafeJSON());
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/riders/online — all online riders (admin use)
router.get('/online', protect, requireRole('admin'), async (req, res) => {
  try {
    const riders = await Rider.find({ isOnline: true });
    res.json(riders.map((r) => r.toSafeJSON()));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/riders/:id
router.get('/:id', protect, async (req, res) => {
  try {
    const rider = await Rider.findById(req.params.id);
    if (!rider) return res.status(404).json({ message: 'Rider not found' });
    res.json(rider.toSafeJSON());
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
