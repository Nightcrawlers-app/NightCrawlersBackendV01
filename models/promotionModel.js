const mongoose = require('mongoose');
const { BUSINESS_TYPES } = require('./vendorModel');

/**
 * A promotion shown as a banner in the app, and applied to orders.
 *
 *   discountType   'percent'       → discountValue% off the food subtotal (capped by maxDiscount)
 *                  'fixed'         → ₦discountValue off the food subtotal
 *                  'free_delivery' → the delivery fee is waived
 *   scope          'all'      → every store
 *                  'category' → every store of one businessType (e.g. all Pharmacies)
 *                  'stores'   → only the stores listed in storeIds
 *
 * Promo codes: set `code` (e.g. "NIGHT10") and the promo is only applied when
 * the customer types that code at checkout — never automatically.
 *   audience          'everyone' | 'new_customers' (no previous orders — for
 *                     "free delivery on your first order", "15% off first order")
 *   usageLimit        total times it can be used across everyone (null = no limit)
 *   perCustomerLimit  times one customer can use it (null = no limit)
 *   listed            false hides it from the banner carousel and store badges
 *                     (a secret code you hand out on Instagram, flyers, etc.)
 *
 * Codes tied to accounts:
 *   customerIds  set → the code only works for these customers ("This code
 *                isn't linked to your account" for anyone else). For one-off
 *                gestures: an apology code, an influencer's own code.
 *   isCampaign   true → no shared code at all. Each chosen customer gets their
 *                own single-use code (see personalCodeModel.js), generated
 *                from the admin screen and shown in their Rewards tab.
 */
const PromotionSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 80 },   // "50% off KFC buckets"
    subtitle: { type: String, default: '', trim: true, maxlength: 160 },  // "This weekend only"
    badge: { type: String, default: '', trim: true, maxlength: 20 },      // "50% OFF" — shown on store cards
    imageUrl: { type: String, default: '' },                               // banner image (data URL or https)

    discountType: { type: String, enum: ['percent', 'fixed', 'free_delivery'], required: true },
    discountValue: { type: Number, default: 0, min: 0 },
    maxDiscount: { type: Number, default: null, min: 0 },   // cap for percent promos (₦)
    minOrderAmount: { type: Number, default: 0, min: 0 },   // food subtotal needed (₦)

    scope: { type: String, enum: ['all', 'category', 'stores'], default: 'all' },
    businessType: { type: String, enum: [...BUSINESS_TYPES, null], default: null },
    storeIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Store' }],

    // Optional: only these items get the discount, matched against each menu
    // item's name and categories (case-insensitive, e.g. "pizza" matches
    // "Pepperoni Pizza" or an item in the "Pizza" category). Empty = whole order.
    itemKeywords: [{ type: String, trim: true, lowercase: true, maxlength: 40 }],

    // Who pays for the discount. Recorded on each order so earnings can be
    // settled correctly later (platform-funded vs vendor-funded).
    fundedBy: { type: String, enum: ['platform', 'vendor'], default: 'platform' },

    code: { type: String, default: null, trim: true, uppercase: true, maxlength: 20 },
    audience: { type: String, enum: ['everyone', 'new_customers'], default: 'everyone' },
    usageLimit: { type: Number, default: null, min: 1 },
    perCustomerLimit: { type: Number, default: null, min: 1 },
    timesUsed: { type: Number, default: 0, min: 0 },
    listed: { type: Boolean, default: true },
    customerIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    isCampaign: { type: Boolean, default: false },

    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },
    isActive: { type: Boolean, default: true },
    priority: { type: Number, default: 0 },  // higher shows first in the carousel
  },
  { timestamps: true }
);

PromotionSchema.index({ isActive: 1, priority: -1 });
// Codes are unique, but most promos don't have one.
PromotionSchema.index({ code: 1 }, { unique: true, partialFilterExpression: { code: { $type: 'string' } } });

PromotionSchema.virtual('requiresCode').get(function () {
  return Boolean(this.code) || Boolean(this.isCampaign);
});

/** Only for particular customers (so never advertised to everyone). */
PromotionSchema.methods.isPrivate = function () {
  return Boolean(this.isCampaign) || (this.customerIds || []).length > 0;
};

/** Is it switched on and inside its date window? */
PromotionSchema.methods.isLive = function (now = new Date()) {
  if (!this.isActive) return false;
  if (this.startsAt && now < this.startsAt) return false;
  if (this.endsAt && now > this.endsAt) return false;
  return true;
};

/** Does it cover this store? */
PromotionSchema.methods.appliesToStore = function (store) {
  if (!store) return false;
  if (this.scope === 'all') return true;
  if (this.scope === 'category') return store.businessType === this.businessType;
  return (this.storeIds || []).some((id) => String(id) === String(store._id || store.id));
};

/** Does this menu line match the promo's item keywords? (always true when there are none) */
PromotionSchema.methods.matchesItem = function (item) {
  const keywords = this.itemKeywords || [];
  if (!keywords.length) return true;
  const text = [item.name, ...(item.categories || [])].join(' ').toLowerCase();
  return keywords.some((k) => text.includes(k));
};

/**
 * Work out the discount for an order. Never trust a discount sent by the
 * browser — the backend always recalculates with this.
 * `items` ([{ name, price, quantity, categories }]) is needed for promos that
 * target specific items; without it such a promo can't be applied.
 * Returns { eligible, discount, reason }.
 */
PromotionSchema.methods.quote = function ({ store, subtotal, deliveryFee = 0, items = null, now = new Date() }) {
  if (!this.isLive(now)) return { eligible: false, discount: 0, reason: 'This promo has ended.' };
  if (this.usageLimit && (this.timesUsed || 0) >= this.usageLimit) {
    return { eligible: false, discount: 0, reason: 'This promo has been fully used up.' };
  }
  if (!this.appliesToStore(store)) {
    return { eligible: false, discount: 0, reason: "This promo isn't available at this store." };
  }
  if (subtotal < (this.minOrderAmount || 0)) {
    const short = Math.ceil(this.minOrderAmount - subtotal);
    return {
      eligible: false,
      discount: 0,
      reason: `Add ₦${short.toLocaleString()} more to use this promo.`,
      amountNeeded: short,
    };
  }

  // Only the matching items count towards the discount (whole order if no keywords).
  let eligibleSubtotal = subtotal;
  if ((this.itemKeywords || []).length) {
    const matching = (items || []).filter((i) => this.matchesItem(i));
    eligibleSubtotal = matching.reduce((sum, i) => sum + i.price * i.quantity, 0);
    if (!matching.length) {
      return {
        eligible: false,
        discount: 0,
        reason: `This promo is only for ${this.itemKeywords.join(', ')} items. Add one to your order to use it.`,
      };
    }
  }

  let discount = 0;
  if (this.discountType === 'percent') {
    discount = (eligibleSubtotal * Math.min(this.discountValue, 100)) / 100;
    if (this.maxDiscount) discount = Math.min(discount, this.maxDiscount);
  } else if (this.discountType === 'fixed') {
    discount = Math.min(this.discountValue, eligibleSubtotal);
  } else if (this.discountType === 'free_delivery') {
    discount = Math.max(0, deliveryFee);
  }
  return { eligible: true, discount: Math.round(discount), reason: null };
};

PromotionSchema.set('toJSON', {
  virtuals: true,
  transform: (doc, ret) => {
    ret.id = String(ret._id);
    ret.storeIds = (ret.storeIds || []).map(String);
    ret.isLive = doc.isLive();
    ret.requiresCode = Boolean(doc.code) || Boolean(doc.isCampaign);
    ret.customerIds = (ret.customerIds || []).map(String);
    return ret;
  },
});

/** Every promotion that's live right now, best first. */
PromotionSchema.statics.findLive = function (now = new Date()) {
  return this.find({
    isActive: true,
    $and: [
      { $or: [{ startsAt: null }, { startsAt: { $lte: now } }] },
      { $or: [{ endsAt: null }, { endsAt: { $gte: now } }] },
    ],
  }).sort({ priority: -1, createdAt: -1 });
};

/** Live promos customers may see advertised (banner, store badges, checkout list). */
PromotionSchema.statics.findListed = function (now = new Date()) {
  return this.findLive(now).where({
    listed: { $ne: false },
    isCampaign: { $ne: true },
    'customerIds.0': { $exists: false }, // tied to particular customers
  });
};

/**
 * Checks that depend on WHO is ordering. Returns a reason string when the
 * customer can't use this promo, or null when they can.
 *   customerId — null for guest checkout
 */
PromotionSchema.methods.customerIneligibleReason = async function (customerId) {
  const restricted = (this.customerIds || []).length > 0;
  const needsCustomer = this.audience === 'new_customers' || this.perCustomerLimit || restricted || this.isCampaign;
  if (!needsCustomer) return null;
  if (!customerId) return 'Sign in to use this promo.';
  if (restricted && !this.customerIds.some((id) => String(id) === String(customerId))) {
    return "This code isn't linked to your account.";
  }
  // Loaded here (not looked up by name) so this works even where nothing else
  // has loaded the Order model yet — e.g. a unit test.
  const Order = require('./orderModel');
  if (this.audience === 'new_customers') {
    const previous = await Order.countDocuments({ customerId, status: { $ne: 'cancelled' } });
    if (previous > 0) return 'This promo is for your first order only.';
  }
  if (this.perCustomerLimit) {
    const used = await Order.countDocuments({ customerId, promotionId: this._id, status: { $ne: 'cancelled' } });
    if (used >= this.perCustomerLimit) {
      return this.perCustomerLimit === 1 ? "You've already used this promo." : `You've used this promo ${used} times — that's the limit.`;
    }
  }
  return null;
};

/**
 * Is `typed` the right code for this promo and this customer?
 * Returns { reason } when not, or { reason: null, personalCode } when it is
 * (personalCode is the PersonalCode doc for campaign promos, else null).
 */
PromotionSchema.methods.checkCode = async function (typed, customerId) {
  const code = String(typed || '').trim().toUpperCase();
  if (this.isCampaign) {
    if (!customerId) return { reason: 'Sign in to use your code.' };
    if (!code) return { reason: 'Enter your personal code to use this promo.' };
    const PersonalCode = require('./personalCodeModel');
    const pc = await PersonalCode.findOne({ promotionId: this._id, code });
    if (!pc) return { reason: "That code isn't valid." };
    if (String(pc.customerId) !== String(customerId)) return { reason: "This code isn't linked to your account." };
    if (pc.usedAt) return { reason: "You've already used this code." };
    return { reason: null, personalCode: pc };
  }
  if (this.code && code !== this.code) return { reason: 'Enter the promo code to use this promo.' };
  return { reason: null, personalCode: null };
};

module.exports = mongoose.model('Promotion', PromotionSchema);
