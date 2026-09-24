const express = require('express');
const mongoose = require('mongoose');
const Promotion = require('../models/promotionModel');
const Store = require('../models/storeModel');
const { protect, requireRole } = require('../middlewares/auth');

// ── Public: what customers see ───────────────────────────────────────────────
const publicRouter = express.Router();

// GET /api/promotions — live promos for the banner carousel
publicRouter.get('/', async (req, res) => {
  try {
    res.json(await Promotion.findLive());
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/promotions/:id
publicRouter.get('/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Promotion not found' });
    const promo = await Promotion.findById(req.params.id);
    if (!promo) return res.status(404).json({ message: 'Promotion not found' });
    res.json(promo);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/promotions/:id/quote — { storeId, subtotal, deliveryFee }
// Lets checkout show the exact discount the server will apply.
publicRouter.post('/:id/quote', async (req, res) => {
  try {
    const { storeId, subtotal, deliveryFee } = req.body;
    if (!mongoose.isValidObjectId(req.params.id) || !mongoose.isValidObjectId(storeId)) {
      return res.status(400).json({ message: 'Valid promotion and store are required.' });
    }
    const [promo, store] = await Promise.all([Promotion.findById(req.params.id), Store.findById(storeId)]);
    if (!promo) return res.status(404).json({ message: 'Promotion not found' });
    if (!store) return res.status(404).json({ message: 'Store not found' });
    res.json(promo.quote({ store, subtotal: Number(subtotal) || 0, deliveryFee: Number(deliveryFee) || 0 }));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── Admin: create and manage promos ─────────────────────────────────────────
const adminRouter = express.Router();
adminRouter.use(protect, requireRole('admin'));

const MAX_IMAGE_BYTES = 800 * 1024;
const EDITABLE = [
  'title', 'subtitle', 'badge', 'imageUrl', 'discountType', 'discountValue', 'maxDiscount',
  'minOrderAmount', 'scope', 'businessType', 'storeIds', 'fundedBy', 'startsAt', 'endsAt',
  'isActive', 'priority',
];

/** Pick allowed fields and check the combination makes sense. Returns [data, error]. */
const readPromotion = (body, existing = {}) => {
  const data = {};
  for (const key of EDITABLE) if (body[key] !== undefined) data[key] = body[key];
  const merged = { ...existing, ...data };

  if (data.imageUrl) {
    const m = String(data.imageUrl).match(/^data:image\/(png|jpe?g|webp);base64,/i);
    if (!m && !/^https:\/\//i.test(data.imageUrl)) return [null, 'Image must be an uploaded picture or an https link.'];
    if (m && ((data.imageUrl.length - m[0].length) * 3) / 4 > MAX_IMAGE_BYTES) {
      return [null, 'Banner image is too large. Please use a smaller picture.'];
    }
  }
  if (merged.discountType === 'percent' && !(merged.discountValue > 0 && merged.discountValue <= 100)) {
    return [null, 'Percent off must be between 1 and 100.'];
  }
  if (merged.discountType === 'fixed' && !(merged.discountValue > 0)) {
    return [null, 'Amount off must be more than ₦0.'];
  }
  if (merged.scope === 'category' && !merged.businessType) return [null, 'Choose which category this promo is for.'];
  if (merged.scope === 'stores' && !(merged.storeIds || []).length) return [null, 'Choose at least one store.'];
  if (merged.startsAt && merged.endsAt && new Date(merged.endsAt) < new Date(merged.startsAt)) {
    return [null, 'End date must be after the start date.'];
  }
  if (data.scope && data.scope !== 'category') data.businessType = null;
  if (data.scope && data.scope !== 'stores') data.storeIds = [];
  for (const k of ['startsAt', 'endsAt', 'maxDiscount']) if (data[k] === '') data[k] = null;
  return [data, null];
};

// GET /api/admin/promotions — all promos, including ended/paused ones
adminRouter.get('/', async (req, res) => {
  try {
    res.json(await Promotion.find().sort({ isActive: -1, priority: -1, createdAt: -1 }));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

adminRouter.post('/', async (req, res) => {
  try {
    const [data, error] = readPromotion(req.body);
    if (error) return res.status(400).json({ message: error });
    if (!data.title || !data.discountType) {
      return res.status(400).json({ message: 'Title and discount type are required.' });
    }
    res.status(201).json(await Promotion.create(data));
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

adminRouter.patch('/:id', async (req, res) => {
  try {
    const promo = await Promotion.findById(req.params.id);
    if (!promo) return res.status(404).json({ message: 'Promotion not found' });
    const [data, error] = readPromotion(req.body, promo.toObject());
    if (error) return res.status(400).json({ message: error });
    promo.set(data);
    await promo.save();
    res.json(promo);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

adminRouter.delete('/:id', async (req, res) => {
  try {
    await Promotion.findByIdAndDelete(req.params.id);
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = { publicRouter, adminRouter };
