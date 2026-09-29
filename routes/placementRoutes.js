const express = require('express');
const mongoose = require('mongoose');
const Placement = require('../models/placementModel');
const Store = require('../models/storeModel');
const { BUSINESS_TYPES } = require('../models/vendorModel');
const { protect, requireRole } = require('../middlewares/auth');
const { rateLimit, MIN } = require('../utils/rateLimit');

/**
 * Sponsored tiles ("ads") in "Popular on Nightcrawlers".
 *   Public:  GET  /api/placements?category=Food   → live ads for that tab, each with its store
 *            POST /api/placements/:id/click       → count a tap
 *   Admin:   /api/admin/placements                → create / edit / pause / delete
 */
const publicRouter = express.Router();

publicRouter.get('/', async (req, res) => {
  try {
    const filter = {};
    if (req.query.category) {
      if (!BUSINESS_TYPES.includes(req.query.category)) return res.json([]);
      filter.category = req.query.category;
    }
    const live = await Placement.findLive(filter).limit(6);
    const stores = await Store.find({ _id: { $in: live.map((p) => p.storeId) } });
    const byId = new Map(stores.map((s) => [String(s._id), s]));
    const out = live
      .filter((p) => byId.has(String(p.storeId)))
      .map((p) => ({ ...p.toJSON(), store: byId.get(String(p.storeId)).toJSON() }));
    // Count that these were shown (best effort, doesn't slow the response).
    if (out.length) {
      Placement.updateMany({ _id: { $in: out.map((p) => p.id) } }, { $inc: { impressions: 1 } }).catch(() => {});
    }
    res.json(out);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

const clickLimit = rateLimit({ name: 'ad-click', max: 60, windowMs: 10 * MIN });
publicRouter.post('/:id/click', clickLimit, async (req, res) => {
  try {
    if (mongoose.isValidObjectId(req.params.id)) {
      await Placement.updateOne({ _id: req.params.id }, { $inc: { clicks: 1 } });
    }
    res.status(204).end();
  } catch {
    res.status(204).end();
  }
});

// ── Admin ───────────────────────────────────────────────────────────────────
const adminRouter = express.Router();
adminRouter.use(protect, requireRole('admin'));

const EDITABLE = ['storeId', 'category', 'label', 'imageUrl', 'advertiser', 'startsAt', 'endsAt', 'isActive', 'priority'];
const MAX_IMAGE_BYTES = 800 * 1024;

const readPlacement = async (body, existing = {}) => {
  const data = {};
  for (const k of EDITABLE) if (body[k] !== undefined) data[k] = body[k];
  const merged = { ...existing, ...data };
  for (const k of ['startsAt', 'endsAt']) if (data[k] === '') data[k] = null;
  if (data.storeId !== undefined) {
    if (!mongoose.isValidObjectId(data.storeId) || !(await Store.exists({ _id: data.storeId }))) {
      return [null, 'Choose a store.'];
    }
  }
  if (merged.category && !BUSINESS_TYPES.includes(merged.category)) return [null, 'Choose which tab the ad appears on.'];
  if (data.imageUrl) {
    const m = String(data.imageUrl).match(/^data:image\/(png|jpe?g|webp);base64,/i);
    if (!m && !/^https:\/\//i.test(data.imageUrl)) return [null, 'Image must be an uploaded picture or an https link.'];
    if (m && ((data.imageUrl.length - m[0].length) * 3) / 4 > MAX_IMAGE_BYTES) return [null, 'Image is too large.'];
  }
  if (merged.startsAt && merged.endsAt && new Date(merged.endsAt) < new Date(merged.startsAt)) {
    return [null, 'End date must be after the start date.'];
  }
  return [data, null];
};

adminRouter.get('/', async (req, res) => {
  try {
    const list = await Placement.find().sort({ isActive: -1, priority: -1, createdAt: -1 });
    const stores = await Store.find({ _id: { $in: list.map((p) => p.storeId) } }, 'name businessType');
    const names = new Map(stores.map((s) => [String(s._id), s.name]));
    res.json(list.map((p) => ({ ...p.toJSON(), storeName: names.get(String(p.storeId)) || '(deleted store)' })));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

adminRouter.post('/', async (req, res) => {
  try {
    const [data, error] = await readPlacement(req.body);
    if (error) return res.status(400).json({ message: error });
    if (!data.storeId || !data.category) return res.status(400).json({ message: 'Store and tab are required.' });
    res.status(201).json(await Placement.create(data));
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

adminRouter.patch('/:id', async (req, res) => {
  try {
    const p = mongoose.isValidObjectId(req.params.id) ? await Placement.findById(req.params.id) : null;
    if (!p) return res.status(404).json({ message: 'Ad not found' });
    const [data, error] = await readPlacement(req.body, p.toObject());
    if (error) return res.status(400).json({ message: error });
    p.set(data);
    await p.save();
    res.json(p);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

adminRouter.delete('/:id', async (req, res) => {
  try {
    await Placement.findByIdAndDelete(req.params.id);
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = { publicRouter, adminRouter };
