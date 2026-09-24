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

/**
 * Work out the discount for an order. Never trust a discount sent by the
 * browser — the backend always recalculates with this.
 * Returns { eligible, discount, reason }.
 */
PromotionSchema.methods.quote = function ({ store, subtotal, deliveryFee = 0, now = new Date() }) {
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

  let discount = 0;
  if (this.discountType === 'percent') {
    discount = (subtotal * Math.min(this.discountValue, 100)) / 100;
    if (this.maxDiscount) discount = Math.min(discount, this.maxDiscount);
  } else if (this.discountType === 'fixed') {
    discount = Math.min(this.discountValue, subtotal);
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
