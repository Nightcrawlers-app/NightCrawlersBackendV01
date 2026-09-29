const mongoose = require('mongoose');

/**
 * One customer's own single-use code for a personal-code campaign.
 *
 * The campaign is a Promotion with `isCampaign: true`: it holds the discount,
 * the stores it covers and the dates. Each PersonalCode ties one unique code
 * (e.g. "ADA-7K2Q") to one customer. Only that customer can use it, once.
 *
 * `usedAt` is set when an order using it is placed, and cleared again if that
 * order is cancelled.
 */
const PersonalCodeSchema = new mongoose.Schema(
  {
    promotionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Promotion', required: true, index: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    code: { type: String, required: true, uppercase: true, trim: true, unique: true },
    usedAt: { type: Date, default: null },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
    emailedAt: { type: Date, default: null },
    // When this code stops working (birthday codes: a week). null = when the promo ends.
    expiresAt: { type: Date, default: null },
    // When it was (last) given out. Birthday codes are re-issued each year by
    // refreshing this same record with a new code.
    issuedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// One code per customer per campaign.
PersonalCodeSchema.index({ promotionId: 1, customerId: 1 }, { unique: true });

PersonalCodeSchema.set('toJSON', {
  transform: (doc, ret) => {
    ret.id = String(ret._id);
    ret.promotionId = String(ret.promotionId);
    ret.customerId = ret.customerId?._id ? String(ret.customerId._id) : String(ret.customerId);
    return ret;
  },
});

module.exports = mongoose.model('PersonalCode', PersonalCodeSchema);
