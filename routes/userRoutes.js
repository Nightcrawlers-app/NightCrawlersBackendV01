const express = require('express');
const router = express.Router();
const User = require('../models/userModel');
const { protect, requireRole } = require('../middlewares/auth');
const { geocodeAddress, readLatLng, toPoint } = require('../utils/geocoder');

router.use(protect, requireRole('customer'));

// Avatars are stored as small data URLs (the frontend resizes to ~512px JPEG
// before upload, which comes out around 30–80 KB). Cap it so one user can't
// bloat every /me response with a 6 MB photo.
const MAX_AVATAR_BYTES = 400 * 1024;
const validateAvatar = (avatar) => {
  if (avatar === null || avatar === '') return null;
  if (typeof avatar !== 'string') return 'Invalid image.';
  if (/^https:\/\//i.test(avatar)) return null; // hosted image URL
  const m = avatar.match(/^data:image\/(png|jpe?g|webp|gif);base64,/i);
  if (!m) return 'Image must be a PNG, JPG, WEBP or GIF.';
  const bytes = Math.floor(((avatar.length - m[0].length) * 3) / 4);
  if (bytes > MAX_AVATAR_BYTES) return 'Image is too large. Please choose a smaller photo.';
  return null;
};

/**
 * Work out coordinates for an address: use lat/lng the client sent (e.g. from
 * "use my current location"), otherwise geocode the text. Null if neither works.
 */
const resolveAddressPoint = async (body, address, city) => {
  const sent = readLatLng(body);
  if (sent) return toPoint(sent);
  const found = await geocodeAddress([address, city].filter(Boolean).join(', '));
  return found ? toPoint(found) : undefined;
};

/** Keep the user's top-level location/coordinates in sync with their default address. */
const syncDefault = (user) => {
  const def = user.addresses.find((a) => a.isDefault);
  if (!def) return;
  user.location = def.city;
  user.coordinates = def.coordinates?.coordinates?.length ? def.coordinates : undefined;
};

// PATCH /api/users/me — update profile fields (firstName, lastName, phone, avatar, notifications)
router.patch('/me', async (req, res) => {
  try {
    const allowed = ['firstName', 'lastName', 'phone', 'avatar', 'notifications', 'favoriteVendors'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    if (updates.avatar !== undefined) {
      const avatarError = validateAvatar(updates.avatar);
      if (avatarError) return res.status(400).json({ message: avatarError });
      if (updates.avatar === '') updates.avatar = null;
    }

    const current = await User.findById(req.user.id);
    if (!current) return res.status(404).json({ message: 'User not found' });

    // Changing the phone number means the old verification no longer applies.
    if (updates.phone !== undefined && updates.phone !== current.phone) {
      updates.phoneVerified = false;
    }

    const user = await User.findByIdAndUpdate(req.user.id, updates, { new: true, runValidators: true });
    res.json(user.toSafeJSON());
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/users/me/addresses — add a new address
router.post('/me/addresses', async (req, res) => {
  try {
    const { label, address, city, isDefault } = req.body;
    if (!label || !address || !city) {
      return res.status(400).json({ message: 'label, address and city are required.' });
    }

    const user = await User.findById(req.user.id);

    if (isDefault || user.addresses.length === 0) {
      user.addresses.forEach((a) => (a.isDefault = false));
    }

    const coordinates = await resolveAddressPoint(req.body, address, city);

    user.addresses.push({
      label,
      address,
      city,
      isDefault: isDefault || user.addresses.length === 0,
      ...(coordinates && { coordinates }),
    });

    syncDefault(user);

    await user.save();
    res.status(201).json(user.toSafeJSON());
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/users/me/addresses/:addressId
router.patch('/me/addresses/:addressId', async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    const addr = user.addresses.id(req.params.addressId);
    if (!addr) return res.status(404).json({ message: 'Address not found' });

    const { label, address, city, isDefault } = req.body;
    const moved = (address !== undefined && address !== addr.address) ||
      (city !== undefined && city !== addr.city) || readLatLng(req.body);
    if (label !== undefined) addr.label = label;
    if (address !== undefined) addr.address = address;
    if (city !== undefined) addr.city = city;

    if (moved) {
      addr.coordinates = await resolveAddressPoint(req.body, addr.address, addr.city);
    }

    if (isDefault) {
      user.addresses.forEach((a) => (a.isDefault = a._id.equals(addr._id)));
    }

    syncDefault(user);

    await user.save();
    res.json(user.toSafeJSON());
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE /api/users/me/addresses/:addressId
router.delete('/me/addresses/:addressId', async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    const addr = user.addresses.id(req.params.addressId);
    if (!addr) return res.status(404).json({ message: 'Address not found' });

    const wasDefault = addr.isDefault;
    addr.deleteOne();

    if (wasDefault && user.addresses.length > 0) {
      user.addresses[0].isDefault = true;
    }

    const defaultAddr = user.addresses.find((a) => a.isDefault);
    if (defaultAddr) syncDefault(user);
    else {
      user.location = 'Abuja, Nigeria'; // matches the schema default
      user.coordinates = undefined;
    }

    await user.save();
    res.json(user.toSafeJSON());
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/users/me/addresses/:addressId/default
router.patch('/me/addresses/:addressId/default', async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    const target = user.addresses.id(req.params.addressId);
    if (!target) return res.status(404).json({ message: 'Address not found' });

    user.addresses.forEach((a) => (a.isDefault = a._id.equals(target._id)));
    syncDefault(user);

    await user.save();
    res.json(user.toSafeJSON());
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/users/me/password — change password
router.patch('/me/password', async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: 'Please fill in all fields' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ message: 'New password must be at least 6 characters' });
    }

    const user = await User.findById(req.user.id);
    if (!(await user.comparePassword(currentPassword))) {
      return res.status(400).json({ message: 'Current password is incorrect' });
    }

    user.password = newPassword; // pre-save hook hashes it
    await user.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── Rewards: points, delivery credit, free deliveries, referrals ────────────
const mongoose = require('mongoose');
const { rewardSettings, ensureReferralCode } = require('../utils/rewards');

// GET /api/users/me/rewards — balances, referral code and how it all works
router.get('/me/rewards', async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    const code = await ensureReferralCode(user);
    const [referrals, rewardedReferrals] = await Promise.all([
      User.countDocuments({ referredBy: user._id, isVerified: true }),
      User.countDocuments({ referredBy: user._id, referralRewarded: true }),
    ]);
    const frontend = (process.env.FRONTEND_URL || 'https://nightcrawlers.app').split(',')[0].trim().replace(/\/$/, '');
    const s = rewardSettings();
    res.json({
      points: user.rewards?.points || 0,
      deliveryCredit: user.rewards?.deliveryCredit || 0,
      freeDeliveries: user.rewards?.freeDeliveries || 0,
      referralCode: code,
      referralLink: `${frontend}/signup?ref=${encodeURIComponent(code)}`,
      referrals,
      rewardedReferrals,
      rules: {
        pointsPer100Naira: s.pointsPer100Naira,
        redeemBlock: s.redeemBlock,
        redeemValue: s.redeemValue,
        referralReward: s.referralReward,
        referralCreditAmount: s.referralCreditAmount,
        newUserFreeDeliveries: s.newUserFreeDeliveries,
      },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/users/me/rewards/redeem — { blocks? } turn points into delivery credit.
// Default: as many whole blocks as they have.
router.post('/me/rewards/redeem', async (req, res) => {
  try {
    const { redeemBlock, redeemValue } = rewardSettings();
    const user = await User.findById(req.user.id, 'rewards');
    if (!user) return res.status(404).json({ message: 'User not found' });
    const have = Math.floor((user.rewards?.points || 0) / redeemBlock);
    const wanted = req.body.blocks === undefined ? have : Math.floor(Number(req.body.blocks));
    if (!(wanted >= 1)) {
      return res.status(400).json({ message: `You need at least ${redeemBlock} points to redeem.` });
    }
    if (wanted > have) return res.status(400).json({ message: "You don't have enough points for that." });
    const points = wanted * redeemBlock;
    const credit = wanted * redeemValue;
    const updated = await User.findOneAndUpdate(
      { _id: user._id, 'rewards.points': { $gte: points } },
      { $inc: { 'rewards.points': -points, 'rewards.deliveryCredit': credit } },
      { new: true }
    );
    if (!updated) return res.status(409).json({ message: 'Your points changed. Please try again.' });
    res.json({
      message: `Swapped ${points.toLocaleString()} points for ₦${credit.toLocaleString()} delivery credit.`,
      points: updated.rewards.points,
      deliveryCredit: updated.rewards.deliveryCredit,
      freeDeliveries: updated.rewards.freeDeliveries,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/users/me/codes — promo codes tied to this account that still work:
// their own campaign codes (single-use) and codes set up for them by name.
router.get('/me/codes', async (req, res) => {
  try {
    const Promotion = require('../models/promotionModel');
    const PersonalCode = require('../models/personalCodeModel');
    const [mine, restricted] = await Promise.all([
      PersonalCode.find({ customerId: req.user.id, usedAt: null }),
      Promotion.findLive().where({ customerIds: req.user.id, code: { $ne: null } }),
    ]);
    const campaigns = await Promotion.findLive().where({ _id: { $in: mine.map((c) => c.promotionId) } });
    const byId = new Map(campaigns.map((p) => [String(p._id), p]));
    const shape = (p, code, kind) => ({
      code,
      kind, // 'personal' = single-use, just for them; 'account' = a code only their account can use
      promotionId: String(p._id),
      title: p.title,
      subtitle: p.subtitle,
      discountType: p.discountType,
      discountValue: p.discountValue,
      maxDiscount: p.maxDiscount,
      minOrderAmount: p.minOrderAmount,
      itemKeywords: p.itemKeywords,
      scope: p.scope,
      businessType: p.businessType,
      storeIds: (p.storeIds || []).map(String),
      endsAt: p.endsAt,
    });
    const out = [
      ...mine.filter((c) => byId.has(String(c.promotionId))).map((c) => shape(byId.get(String(c.promotionId)), c.code, 'personal')),
      ...(await Promise.all(
        restricted.map(async (p) => ((await p.customerIneligibleReason(req.user.id)) ? null : shape(p, p.code, 'account')))
      )).filter(Boolean),
    ];
    // Soonest to expire first; no end date last.
    out.sort((a, b) => (a.endsAt ? new Date(a.endsAt).getTime() : Infinity) - (b.endsAt ? new Date(b.endsAt).getTime() : Infinity));
    res.json(out);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── Favourites: stores and past orders ─────────────────────────────────────
const MAX_FAVORITES = 50;

// GET /api/users/me/favorites — { stores: [Store], orders: [Order] }
router.get('/me/favorites', async (req, res) => {
  try {
    const Store = require('../models/storeModel');
    const Order = require('../models/orderModel');
    const user = await User.findById(req.user.id, 'favoriteStores favoriteOrders');
    if (!user) return res.status(404).json({ message: 'User not found' });
    const [stores, orders] = await Promise.all([
      Store.find({ _id: { $in: user.favoriteStores } }),
      Order.find({ _id: { $in: user.favoriteOrders }, customerId: user._id }).sort({ createdAt: -1 }),
    ]);
    // Newest favourite first; drop stores/orders that no longer exist.
    const order = (ids, docs) => {
      const byId = new Map(docs.map((d) => [String(d._id), d]));
      return [...ids].reverse().map((id) => byId.get(String(id))).filter(Boolean);
    };
    res.json({ stores: order(user.favoriteStores, stores), orders: order(user.favoriteOrders, orders) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/** PUT adds, DELETE removes. Both return the ids now favourited. */
const favoriteRoute = (field, check) => async (req, res) => {
  try {
    const id = req.params.id;
    if (!mongoose.isValidObjectId(id)) return res.status(404).json({ message: 'Not found' });
    if (req.method === 'PUT') {
      const problem = await check(id, req.user.id);
      if (problem) return res.status(problem.status).json({ message: problem.message });
      const user = await User.findById(req.user.id, field);
      if (!user[field].some((x) => String(x) === id) && user[field].length >= MAX_FAVORITES) {
        return res.status(400).json({ message: `You can keep up to ${MAX_FAVORITES} favourites. Remove one first.` });
      }
    }
    const update = req.method === 'PUT' ? { $addToSet: { [field]: id } } : { $pull: { [field]: id } };
    const user = await User.findByIdAndUpdate(req.user.id, update, { new: true, projection: field });
    res.json({ [field]: user[field].map(String) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const storeExists = async (id) => {
  const Store = require('../models/storeModel');
  return (await Store.exists({ _id: id })) ? null : { status: 404, message: 'Store not found' };
};
const ownOrder = async (id, userId) => {
  const Order = require('../models/orderModel');
  return (await Order.exists({ _id: id, customerId: userId })) ? null : { status: 404, message: 'Order not found' };
};

router.put('/me/favorites/stores/:id', favoriteRoute('favoriteStores', storeExists));
router.delete('/me/favorites/stores/:id', favoriteRoute('favoriteStores', storeExists));
router.put('/me/favorites/orders/:id', favoriteRoute('favoriteOrders', ownOrder));
router.delete('/me/favorites/orders/:id', favoriteRoute('favoriteOrders', ownOrder));

// DELETE /api/users/me — delete account
router.delete('/me', async (req, res) => {
  try {
    await User.findByIdAndDelete(req.user.id);
    // Note: also consider anonymizing/cleaning up related Orders here.
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;