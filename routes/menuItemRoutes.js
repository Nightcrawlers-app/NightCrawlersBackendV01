const express = require('express');
const router = express.Router();
const MenuItem = require('../models/menuItemModel');
const Store = require('../models/storeModel');
const { protect, requireRole } = require('../middlewares/auth');

// Helper: verify the authenticated vendor owns the store this item belongs to
const assertOwnsStore = async (storeId, user) => {
  const store = await Store.findById(storeId);
  if (!store) return { error: 404, message: 'Store not found' };
  if (user.role === 'admin') return { store };
  if (user.role !== 'vendor' || String(store.vendorId) !== String(user.id)) {
    return { error: 403, message: 'Forbidden: you do not own this store' };
  }
  return { store };
};

// ─── PUBLIC READ ──────────────────────────────────────────────────────────────

// GET /api/stores/:storeId/menu-items
router.get('/stores/:storeId/menu-items', async (req, res) => {
  try {
    const items = await MenuItem.find({ storeId: req.params.storeId }).sort({ createdAt: -1 });
    res.json(items);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── VENDOR WRITE ROUTES ───────────────────────────────────────────────────────

// POST /api/menu-items
router.post('/menu-items', protect, requireRole('vendor', 'admin'), async (req, res) => {
  try {
    const { storeId, name, categories, price, description, imageUrl } = req.body;

    if (!storeId || !name || price === undefined || !imageUrl) {
      return res.status(400).json({ message: 'storeId, name, price and imageUrl are required.' });
    }

    const check = await assertOwnsStore(storeId, req.user);
    if (check.error) return res.status(check.error).json({ message: check.message });

    const item = await MenuItem.create({
      storeId,
      name,
      categories: categories || [],
      price: Number(price) || 0,
      description: description || '',
      imageUrl,
    });

    res.status(201).json(item);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/menu-items/:id
router.patch('/menu-items/:id', protect, requireRole('vendor', 'admin'), async (req, res) => {
  try {
    const item = await MenuItem.findById(req.params.id);
    if (!item) return res.status(404).json({ message: 'Menu item not found' });

    const check = await assertOwnsStore(item.storeId, req.user);
    if (check.error) return res.status(check.error).json({ message: check.message });

    const allowed = ['name', 'categories', 'price', 'description', 'imageUrl'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    if (updates.price !== undefined) updates.price = Number(updates.price) || 0;

    const updated = await MenuItem.findByIdAndUpdate(req.params.id, updates, { new: true });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE /api/menu-items/:id
router.delete('/menu-items/:id', protect, requireRole('vendor', 'admin'), async (req, res) => {
  try {
    const item = await MenuItem.findById(req.params.id);
    if (!item) return res.status(404).json({ message: 'Menu item not found' });

    const check = await assertOwnsStore(item.storeId, req.user);
    if (check.error) return res.status(check.error).json({ message: check.message });

    await MenuItem.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;