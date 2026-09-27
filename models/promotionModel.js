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

    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },
    isActive: { type: Boolean, default: true },
    priority: { type: Number, default: 0 },  // higher shows first in the carousel
  },
  { timestamps: true }
);

PromotionSchema.index({ isActive: 1, priority: -1 });

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

module.exports = mongoose.model('Promotion', PromotionSchema);
