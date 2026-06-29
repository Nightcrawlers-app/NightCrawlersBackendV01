const mongoose = require('mongoose');
const { BUSINESS_TYPES } = require('./vendorModel');

// Stores time as { hour: 0-23, minute: 0-59 } so we can compare against current time
const TimeSchema = new mongoose.Schema(
  {
    hour: { type: Number, min: 0, max: 23, required: true },
    minute: { type: Number, min: 0, max: 59, default: 0 },
  },
  { _id: false }
);

const StoreSchema = new mongoose.Schema(
  {
    vendorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', required: true, index: true },
    name: { type: String, required: true },
    businessType: { type: String, enum: BUSINESS_TYPES, required: true },
    categories: [{ type: String }],
    address: { type: String, required: true },
    description: { type: String, default: '' },
    imageUrl: { type: String, required: true },

    // Opening hours
    is24Hours: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true }, // vendor can manually close
    openingTime: { 
      type: TimeSchema, 
      default: null,
      match: [/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Please use HH:mm format']
     },
    closingTime: { 
      type: TimeSchema, 
      default: null,
      match: [/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Please use HH:mm format']
     },
    // GeoJSON point for $near queries
    coordinates: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point',
      },
      coordinates: {
        type: [Number], // [longitude, latitude]
        default: [7.4985, 9.0563], // Abuja default
      },
    },
  }, { timestamps: { createdAt: 'createdAt', updatedAt: true } }
);


StoreSchema.index({ coordinates: '2dsphere' });
StoreSchema.index({ address: 'text', name: 'text', });
StoreSchema.index({ categories: 1 });

/**
 * Returns 'open' | 'closed' | '24hrs'
 * Pass a Date object or leave empty to use current time.
 * Uses Lagos time (WAT = UTC+1) by default.
 */
StoreSchema.methods.getStatus = function (now = new Date()) {
  if (!this.isActive) return 'closed';
  if (this.is24Hours) return '24hrs';
  if (!this.openingTime || !this.closingTime) return 'open'; // no hours set — assume open

  // Convert to WAT (UTC+1)
  const watOffset = 60; // minutes
  const localMinutes =
    now.getUTCHours() * 60 + now.getUTCMinutes() + watOffset;
  const currentMins = localMinutes % (24 * 60); // wrap past midnight

  const openMins = this.openingTime.hour * 60 + this.openingTime.minute;
  const closeMins = this.closingTime.hour * 60 + this.closingTime.minute;

  // Handle overnight stores (e.g. 22:00 - 04:00)
  if (closeMins < openMins) {
    return currentMins >= openMins || currentMins < closeMins ? 'open' : 'closed';
  }

  return currentMins >= openMins && currentMins < closeMins ? 'open' : 'closed';
};

/**
 * Adds a virtual `status` field to every toJSON/toObject call
 * so the frontend always gets { ...store, status: 'open' | 'closed' | '24hrs' }
 */
StoreSchema.set('toJSON', {
  virtuals: true,
  transform: (doc, ret) => {
    ret.status = doc.getStatus();
    // Return display strings as well for convenience
    ret.openingTimeDisplay = doc.is24Hours
      ? '24 Hours'
      : doc.openingTime
      ? formatTime(doc.openingTime)
      : null;
    ret.closingTimeDisplay = doc.is24Hours
      ? null
      : doc.closingTime
      ? formatTime(doc.closingTime)
      : null;
    return ret;
  },
});

const formatTime = ({ hour, minute }) => {
  const period = hour >= 12 ? 'PM' : 'AM';
  const h = hour % 12 || 12;
  const m = String(minute).padStart(2, '0');
  return `${h}:${m} ${period}`;
};

module.exports = mongoose.model('Store', StoreSchema);
