const mongoose = require('mongoose');
const { BUSINESS_TYPES } = require('./vendorModel');

/**
 * A paid ("Sponsored") spot in the home page's "Popular on Nightcrawlers"
 * section. Each placement puts one store at the front of one category tab
 * for a date window. Impressions and clicks are counted so you can show an
 * advertiser what they got for their money.
 */
const PlacementSchema = new mongoose.Schema(
  {
    storeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', required: true },
    category: { type: String, enum: BUSINESS_TYPES, required: true },   // which tab
    label: { type: String, default: 'Sponsored', trim: true, maxlength: 20 },
    imageUrl: { type: String, default: '' },     // optional tile image; the store's photo otherwise
    advertiser: { type: String, default: '', trim: true, maxlength: 80 }, // for your records
    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },
    isActive: { type: Boolean, default: true },
    priority: { type: Number, default: 0 },     // higher shows first
    impressions: { type: Number, default: 0 },
    clicks: { type: Number, default: 0 },
  },
  { timestamps: true }
);

PlacementSchema.index({ category: 1, isActive: 1, priority: -1 });

PlacementSchema.methods.isLive = function (now = new Date()) {
  if (!this.isActive) return false;
  if (this.startsAt && now < this.startsAt) return false;
  if (this.endsAt && now > this.endsAt) return false;
  return true;
};

PlacementSchema.statics.findLive = function (filter = {}, now = new Date()) {
  return this.find({
    ...filter,
    isActive: true,
    $and: [
      { $or: [{ startsAt: null }, { startsAt: { $lte: now } }] },
      { $or: [{ endsAt: null }, { endsAt: { $gte: now } }] },
    ],
  }).sort({ priority: -1, createdAt: -1 });
};

PlacementSchema.set('toJSON', {
  virtuals: true,
  transform: (doc, ret) => {
    ret.id = String(ret._id);
    ret.storeId = ret.storeId && ret.storeId._id ? String(ret.storeId._id) : String(ret.storeId);
    ret.isLive = doc.isLive();
    return ret;
  },
});

module.exports = mongoose.model('Placement', PlacementSchema);
