const express = require('express');
const router = express.Router();
const Store = require('../models/storeModel');
const { 
  protect, 
  requireRole, 
  optionalAuth 
} = require('../middlewares/auth');

// Helper: ensure the authenticated vendor owns this store (or is admin)
const assertStoreOwnership = async (req, res, next) => {
  try {
    const store = await Store.findById(req.params.id);
    if (!store) return res.status(404).json({ message: 'Store not found' });

    if (req.user.role === 'admin') {
      req.store = store;
      return next();
    }

    if (req.user.role !== 'vendor' || String(store.vendorId) !== String(req.user.id)) {
      return res.status(403).json({ message: 'Forbidden: you do not own this store' });
    }

    req.store = store;
    next();
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ─── PUBLIC READ ROUTES ──────────────────────────────────────────────────────

// GET /api/stores — explore page (filters: category, address/location, search)
// Supports: ?category=Food, ?search=pizza, ?lat=6.5&lng=3.3&radius=5000
router.get('/', optionalAuth, async (req, res) => {
  try {
    const { category, search, lat, lng, radius } = req.query;
    const query = {};

    if (category && category !== 'All') {
      query.businessType = category;
    }

    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
        { categories: { $regex: search, $options: 'i' } },
      ];
    }

    // Geo query — find stores within radius (default 10km)
    if (lat && lng) {
      query.coordinates = {
        $near: {
          $geometry: {
            type: 'Point',
            coordinates: [parseFloat(lng), parseFloat(lat)],
          },
          $maxDistance: radius ? parseInt(radius) : 10000, // metres
        },
      };
    }

    const stores = await Store.find(query).sort(lat && lng ? {}: { createdAt: -1 });
    res.json(stores);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/stores/:id — single store
router.get('/:id', async (req, res) => {
  try {
    const store = await Store.findById(req.params.id);
    if (!store) return res.status(404).json({ message: 'Store not found' });
    res.json(store);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── VENDOR WRITE ROUTES ─────────────────────────────────────────────────────

// POST /api/stores — create a store for the authenticated vendor
router.post('/', protect, requireRole('vendor'), async (req, res) => {
  try {
    const { name, categories, address, description, imageUrl, openingTime, closingTime, lat, lng } = req.body;

    if (!name || !address || !imageUrl) {
      return res.status(400).json({ message: 'name, address and imageUrl are required.' });
    }

    // Vendor's businessType determines the store's businessType
    const Vendor = require('../models/vendorModel');
    const vendor = await Vendor.findById(req.user.id);
    if (!vendor) return res.status(404).json({ message: 'Vendor not found' });

    // Safely parse or fallback
    const parsedLng = parseFloat(lng);
    const parsedLat = parseFloat(lat);
    
    const finalLng = !isNaN(parsedLng) ? parsedLng : 7.4985;
    const finalLat = !isNaN(parsedLat) ? parsedLat : 9.0563;

    const store = await Store.create({
      vendorId: req.user.id,
      name,
      businessType: vendor.businessType,
      categories: categories || [],
      address,
      description: description || '',
      imageUrl,
      openingTime: openingTime || '',
      closingTime: closingTime || '',
      coordinates: {
        type: 'Point',
        coordinates: [ finalLng, finalLat ],
      },
    });

    res.status(201).json(store);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/stores/:id — update store details (owner or admin only)
router.patch('/:id', protect, assertStoreOwnership, async (req, res) => {
  try {
    const allowed = ['name', 'categories', 'address', 'description', 'imageUrl', 'openingTime', 'closingTime', 'lat', 'lng'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    // Allow updating coordinates if lat/lng provided
    if (req.body.lat && req.body.lng) {
      updates.coordinates = {
        type: 'Point',
        coordinates: [parseFloat(req.body.lng), parseFloat(req.body.lat)],
      };
    }

    const updated = await Store.findByIdAndUpdate(req.params.id, updates, { new: true });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE /api/stores/:id — owner or admin only
router.delete('/:id', protect, assertStoreOwnership, async (req, res) => {
  try {
    await Store.findByIdAndDelete(req.params.id);
    // Consider also cascading delete of MenuItems for this store.
    const MenuItem = require('../models/MenuItem');
    await MenuItem.deleteMany({ storeId: req.params.id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/vendors/:vendorId/stores — all stores for a vendor
// Mounted separately below for the /api/vendors/:vendorId/stores path
router.get('/vendor/:vendorId', protect, async (req, res) => {
  try {
    if (req.user.role !== 'admin' && String(req.user.id) !== req.params.vendorId) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    const stores = await Store.find({ vendorId: req.params.vendorId }).sort({ createdAt: -1 });
    res.json(stores);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
module.exports.assertStoreOwnership = assertStoreOwnership;