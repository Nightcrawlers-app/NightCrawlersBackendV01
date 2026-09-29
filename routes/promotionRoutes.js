const express = require('express');
const mongoose = require('mongoose');
const Promotion = require('../models/promotionModel');
const Store = require('../models/storeModel');
const PersonalCode = require('../models/personalCodeModel');
const User = require('../models/userModel');
const Order = require('../models/orderModel');
const crypto = require('crypto');

/** "20% off (up to ₦2,000)", "₦500 off", "Free delivery" — for emails. */
const describeOffer = (p) => {
  const main =
    p.discountType === 'percent'
      ? `${p.discountValue}% off${p.maxDiscount ? ` (up to ₦${p.maxDiscount.toLocaleString()})` : ''}`
      : p.discountType === 'fixed'
        ? `₦${p.discountValue.toLocaleString()} off`
        : 'Free delivery';
  return p.minOrderAmount ? `${main} on orders over ₦${p.minOrderAmount.toLocaleString()}` : main;
};
const { protect, requireRole, optionalAuth } = require('../middlewares/auth');
const { rateLimit, MIN } = require('../utils/rateLimit');

// ── Public: what customers see ───────────────────────────────────────────────
const publicRouter = express.Router();

// GET /api/promotions — live promos for the banner carousel
publicRouter.get('/', async (req, res) => {
  try {
    res.json(await Promotion.findListed());
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/promotions/code — { code, storeId? } → the promo that code unlocks.
// Checkout calls this when the customer types a code, then prices the order
// with it (POST /api/orders/quote with promotionId + promoCode). Limited so
// codes can't be guessed by brute force.
const codeLimit = rateLimit({
  name: 'promo-code',
  max: 20,
  windowMs: 15 * MIN,
  message: 'Too many promo code attempts. Please try again in a few minutes.',
});
publicRouter.post('/code', optionalAuth, codeLimit, async (req, res) => {
  try {
    const code = String(req.body.code || '').trim().toUpperCase();
    if (!code) return res.status(400).json({ message: 'Enter a promo code.' });
    let promo = await Promotion.findOne({ code });
    let personal = null;
    if (!promo) {
      // Not a shared code — maybe someone's personal campaign code.
      personal = await PersonalCode.findOne({ code });
      if (personal) {
        if (req.user?.role !== 'customer') return res.status(401).json({ message: 'Sign in to use your code.' });
        if (String(personal.customerId) !== String(req.user.id)) {
          return res.status(403).json({ message: "This code isn't linked to your account." });
        }
        if (personal.usedAt) return res.status(400).json({ message: "You've already used this code." });
        if (personal.expiresAt && personal.expiresAt < new Date()) return res.status(400).json({ message: 'This code has expired.' });
        promo = await Promotion.findById(personal.promotionId);
      }
    }
    if (!promo || !promo.isLive()) return res.status(404).json({ message: "That code isn't valid or has expired." });
    if (promo.usageLimit && promo.timesUsed >= promo.usageLimit) {
      return res.status(400).json({ message: 'That code has been fully used up.' });
    }
    if (req.body.storeId && mongoose.isValidObjectId(req.body.storeId)) {
      const store = await Store.findById(req.body.storeId);
      if (store && !promo.appliesToStore(store)) {
        return res.status(400).json({ message: `That code doesn't work at ${store.name}.` });
      }
    }
    const who = req.user?.role === 'customer' ? req.user.id : null;
    const reason = await promo.customerIneligibleReason(who);
    if (reason) return res.status(400).json({ message: reason });
    // For a personal code, `code` is theirs — checkout sends it back when ordering.
    res.json(personal ? { ...promo.toJSON(), code: personal.code } : promo);
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
    const out = promo.toJSON();
    if (promo.listed === false) delete out.code; // don't leak secret codes by id
    res.json(out);
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
  'minOrderAmount', 'scope', 'businessType', 'storeIds', 'itemKeywords', 'fundedBy', 'startsAt', 'endsAt',
  'isActive', 'priority', 'code', 'audience', 'usageLimit', 'perCustomerLimit', 'listed',
  'customerIds', 'isCampaign', 'birthday', 'codeValidDays',
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
  if (data.itemKeywords !== undefined) {
    if (!Array.isArray(data.itemKeywords)) return [null, 'Item keywords must be a list.'];
    data.itemKeywords = [...new Set(data.itemKeywords.map((k) => String(k).trim().toLowerCase()).filter(Boolean))].slice(0, 10);
  }
  if (data.scope && data.scope !== 'category') data.businessType = null;
  if (data.scope && data.scope !== 'stores') data.storeIds = [];
  for (const k of ['startsAt', 'endsAt', 'maxDiscount', 'usageLimit', 'perCustomerLimit']) {
    if (data[k] === '' || data[k] === 0) data[k] = null;
  }
  if (data.code !== undefined) {
    const code = data.code === null ? '' : String(data.code).trim().toUpperCase();
    if (code && !/^[A-Z0-9_-]{3,20}$/.test(code)) {
      return [null, 'Promo codes are 3–20 letters or numbers (no spaces), e.g. NIGHT10.'];
    }
    data.code = code || null;
  }
  if (data.customerIds !== undefined) {
    if (!Array.isArray(data.customerIds) || !data.customerIds.every((id) => mongoose.isValidObjectId(id))) {
      return [null, 'Pick customers from the list.'];
    }
    data.customerIds = [...new Set(data.customerIds.map(String))].slice(0, 200);
  }
  const final = { ...existing, ...data };
  if (final.birthday && !final.isCampaign) data.birthday = false; // birthday promos are personal-code campaigns
  if (data.codeValidDays !== undefined) {
    const d = Math.floor(Number(data.codeValidDays));
    if (!(d >= 1 && d <= 60)) return [null, 'Birthday codes can last 1 to 60 days.'];
    data.codeValidDays = d;
  }
  if (final.isCampaign) {
    // Each customer gets their own code instead of a shared one.
    data.code = null;
    data.customerIds = [];
    data.listed = false;
  } else if ((final.customerIds || []).length) {
    if (!final.code) return [null, 'Give the promo a code — it only works for the customers you picked.'];
    data.listed = false; // private: never advertised to everyone
  }
  return [data, null];
};

// GET /api/admin/promotions/customers?search=ada — find customers to tie codes to
adminRouter.get('/customers', async (req, res) => {
  try {
    const q = String(req.query.search || '').trim();
    const ids = String(req.query.ids || '').split(',').filter((id) => mongoose.isValidObjectId(id));
    let filter;
    if (ids.length) filter = { _id: { $in: ids } };
    else if (q.length >= 2) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter = { isVerified: true, $or: [{ email: rx }, { firstName: rx }, { lastName: rx }, { phone: rx }] };
    } else return res.json([]);
    const users = await User.find(filter, 'firstName lastName email phone').limit(20);
    res.json(users.map((u) => ({ id: String(u._id), name: `${u.firstName} ${u.lastName}`.trim(), email: u.email, phone: u.phone })));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/admin/promotions — all promos, including ended/paused ones
adminRouter.get('/', async (req, res) => {
  try {
    const promos = await Promotion.find().sort({ isActive: -1, priority: -1, createdAt: -1 });
    // Personal-code campaigns: how many codes went out and how many were used.
    const campaignIds = promos.filter((p) => p.isCampaign).map((p) => p._id);
    const counts = campaignIds.length
      ? await PersonalCode.aggregate([
          { $match: { promotionId: { $in: campaignIds } } },
          { $group: { _id: '$promotionId', issued: { $sum: 1 }, used: { $sum: { $cond: [{ $ne: ['$usedAt', null] }, 1, 0] } } } },
        ])
      : [];
    const byId = new Map(counts.map((c) => [String(c._id), c]));
    res.json(promos.map((p) => {
      const c = byId.get(String(p._id));
      return { ...p.toJSON(), ...(p.isCampaign && { codesIssued: c?.issued || 0, codesUsed: c?.used || 0 }) };
    }));
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
    if (err.code === 11000) return res.status(409).json({ message: 'Another promo already uses that code.' });
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
    if (err.code === 11000) return res.status(409).json({ message: 'Another promo already uses that code.' });
    res.status(400).json({ message: err.message });
  }
});

adminRouter.delete('/:id', async (req, res) => {
  try {
    await Promotion.findByIdAndDelete(req.params.id);
    await PersonalCode.deleteMany({ promotionId: req.params.id });
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── Personal-code campaigns ─────────────────────────────────────────────────
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const personalCodeFor = (firstName) => {
  const prefix = String(firstName || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3) || 'NC';
  let tail = '';
  for (const b of crypto.randomBytes(4)) tail += ALPHABET[b % ALPHABET.length];
  return `${prefix}-${tail}`;
};

const loadCampaign = async (req, res) => {
  const promo = mongoose.isValidObjectId(req.params.id) ? await Promotion.findById(req.params.id) : null;
  if (!promo) {
    res.status(404).json({ message: 'Promotion not found' });
    return null;
  }
  if (!promo.isCampaign) {
    res.status(400).json({ message: 'This promo isn’t set up for personal codes.' });
    return null;
  }
  return promo;
};

// GET /api/admin/promotions/:id/codes — every code in a campaign, with who has it
adminRouter.get('/:id/codes', async (req, res) => {
  try {
    const promo = await loadCampaign(req, res);
    if (!promo) return;
    const codes = await PersonalCode.find({ promotionId: promo._id }).sort({ createdAt: -1 }).limit(2000)
      .populate('customerId', 'firstName lastName email');
    res.json(codes.map((c) => ({
      id: String(c._id),
      code: c.code,
      usedAt: c.usedAt,
      expiresAt: c.expiresAt,
      issuedAt: c.issuedAt,
      orderId: c.orderId ? String(c.orderId) : null,
      emailedAt: c.emailedAt,
      createdAt: c.createdAt,
      customer: c.customerId
        ? { id: String(c.customerId._id), name: `${c.customerId.firstName} ${c.customerId.lastName}`.trim(), email: c.customerId.email }
        : null,
    })));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/**
 * POST /api/admin/promotions/:id/codes — give customers their own code.
 *   { audience: 'customers', customerIds: [...] }   people picked by name/email
 *   { audience: 'emails', emails: ['a@b.com', ...] } a pasted list
 *   { audience: 'inactive', days: 30 }                verified customers with no order in `days` (or never)
 *   { audience: 'all' }                               every verified customer
 *   sendEmail: true → email each new code
 * Customers who already have a code in this campaign are skipped.
 */
const MAX_PER_BATCH = 5000;
adminRouter.post('/:id/codes', async (req, res) => {
  try {
    const promo = await loadCampaign(req, res);
    if (!promo) return;
    const { audience, sendEmail } = req.body;

    let users = [];
    let notFound = [];
    const fields = 'firstName lastName email';
    if (audience === 'customers') {
      const ids = (req.body.customerIds || []).filter((id) => mongoose.isValidObjectId(id));
      users = await User.find({ _id: { $in: ids } }, fields);
    } else if (audience === 'emails') {
      const emails = [...new Set((req.body.emails || []).map((e) => String(e).trim().toLowerCase()).filter(Boolean))];
      users = await User.find({ email: { $in: emails }, isVerified: true }, fields);
      const found = new Set(users.map((u) => u.email));
      notFound = emails.filter((e) => !found.has(e));
    } else if (audience === 'inactive') {
      const days = Math.max(1, Math.min(365, Number(req.body.days) || 30));
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const recent = await Order.distinct('customerId', { createdAt: { $gte: since }, customerId: { $ne: null } });
      users = await User.find({ isVerified: true, _id: { $nin: recent } }, fields).limit(MAX_PER_BATCH);
    } else if (audience === 'all') {
      users = await User.find({ isVerified: true }, fields).limit(MAX_PER_BATCH);
    } else {
      return res.status(400).json({ message: 'Choose who gets a code.' });
    }

    const already = new Set(
      (await PersonalCode.distinct('customerId', { promotionId: promo._id, customerId: { $in: users.map((u) => u._id) } })).map(String)
    );
    const fresh = users.filter((u) => !already.has(String(u._id)));

    // Make the codes, retrying the rare clash with an existing code.
    const created = [];
    for (const u of fresh) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = personalCodeFor(u.firstName);
        if (await Promotion.exists({ code })) continue;
        try {
          const pc = await PersonalCode.create({ promotionId: promo._id, customerId: u._id, code });
          created.push({ pc, user: u });
          break;
        } catch (err) {
          if (err.code !== 11000) throw err;
          // duplicate code (or a code for this customer was created meanwhile) — try again / skip
          if (await PersonalCode.exists({ promotionId: promo._id, customerId: u._id })) break;
        }
      }
    }

    // Emails go out after the response (a few hundred can take a while).
    if (sendEmail && created.length) {
      const { sendPersonalCodeEmail } = require('../utils/mailer');
      const offer = describeOffer(promo);
      (async () => {
        for (const { pc, user } of created) {
          try {
            await sendPersonalCodeEmail(user.email, user.firstName, { code: pc.code, title: promo.title, offer, expires: promo.endsAt });
            await PersonalCode.updateOne({ _id: pc._id }, { $set: { emailedAt: new Date() } });
          } catch (err) {
            console.error(`Personal code email to ${user.email} failed:`, err.message);
          }
        }
      })();
    }

    res.status(201).json({
      created: created.length,
      skipped: users.length - fresh.length,   // already had a code
      notFound,                                // pasted emails with no verified account
      emailing: Boolean(sendEmail && created.length),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE /api/admin/promotions/:id/codes/:codeId — take a code back (unused only)
adminRouter.delete('/:id/codes/:codeId', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.codeId)) return res.status(404).json({ message: 'Code not found' });
    const pc = await PersonalCode.findOne({ _id: req.params.codeId, promotionId: req.params.id });
    if (!pc) return res.status(404).json({ message: 'Code not found' });
    if (pc.usedAt) return res.status(400).json({ message: "This code has been used, so it can't be removed." });
    await pc.deleteOne();
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = { publicRouter, adminRouter };
