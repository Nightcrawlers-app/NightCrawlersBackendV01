const express = require('express');
const router = express.Router();
const Store = require('../models/storeModel');
const { geocodeAddress, readLatLng, toPoint } = require('../utils/geocoder');

/**
 * Coordinates for a store: explicit lat/lng from the client win (a vendor
 * dropping a pin or using GPS). Otherwise geocode the address text.
 * Returns { coordinates, approximate } or null if the address can't be found.
 */
const resolveStorePoint = async (body, address) => {
  const sent = readLatLng(body);
  if (sent) return { coordinates: toPoint(sent), approximate: false };
  const found = await geocodeAddress(address);
  return found ? { coordinates: toPoint(found), approximate: true } : null;
};

const MAX_RADIUS_M = 50000;
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

    // Where is the customer? Prefer real coordinates; otherwise try to
    // geocode the address text they picked (e.g. "Wuse 2, Abuja").
    let point = readLatLng({ lat, lng });
    if (!point && req.query.address) {
      point = await geocodeAddress(String(req.query.address));
    }

    if (!point) {
      const stores = await Store.find(query).sort({ createdAt: -1 });
      return res.json(stores);
    }

    // $geoNear sorts nearest-first and gives us the distance for each store.
    const maxDistance = Math.min(parseInt(radius, 10) || 10000, MAX_RADIUS_M); // metres
    const results = await Store.aggregate([
      {
        $geoNear: {
          near: { type: 'Point', coordinates: [point.longitude, point.latitude] },
          distanceField: 'distanceMeters',
          maxDistance,
          spherical: true,
          query,
        },
      },
    ]);

    res.json(
      results.map(({ distanceMeters, ...raw }) => ({
        ...Store.hydrate(raw).toJSON(),
        distance: Math.round((distanceMeters / 1000) * 10) / 10, // km, 1 decimal
      }))
    );
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

    // Real position, or geocoded from the address. No more fake Abuja default.
    const located = await resolveStorePoint({ lat, lng }, address);

    const store = await Store.create({
      vendorId: req.user.id,
      name,
      businessType: vendor.businessType,
      categories: categories || [],
      address,
      description: description || '',
      imageUrl,
      openingTime: openingTime || { hour: 0, minute: 0 },
      closingTime: closingTime || { hour: 0, minute: 0 },
      ...(located && {
        coordinates: located.coordinates,
        coordinatesApproximate: located.approximate,
      }),
    });

    res.status(201).json(store);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/stores/:id — update store details (owner or admin only)
router.patch('/:id', protect, assertStoreOwnership, async (req, res) => {
  try {
    const allowed = ['name', 'categories', 'address', 'description', 'imageUrl', 'lat', 'lng'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    if (req.body.openingTime) updates.openingTime = req.body.openingTime;
    if (req.body.closingTime) updates.closingTime = req.body.closingTime;

    delete updates.lat;
    delete updates.lng;

    // Re-locate the store if it was given a pin, or its address changed.
    const addressChanged = updates.address !== undefined && updates.address !== req.store.address;
    if (readLatLng(req.body) || addressChanged) {
      const located = await resolveStorePoint(req.body, updates.address ?? req.store.address);
      if (located) {
        updates.coordinates = located.coordinates;
        updates.coordinatesApproximate = located.approximate;
      } else if (addressChanged) {
        // New address we couldn't find: better no position than the old, wrong one.
        updates.$unset = { coordinates: 1 };
      }
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
    const MenuItem = require('../models/menuItemModel');
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