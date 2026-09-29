const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const AddressSchema = new mongoose.Schema({
  label: { type: String, required: true },
  address: { type: String, required: true },
  city: { type: String, required: true },
  isDefault: { type: Boolean, default: false },
  // GeoJSON point, [longitude, latitude]. `default: undefined` matters:
  // without it Mongoose saves an empty array, which is not valid GeoJSON.
  coordinates: {
    type: { type: String, enum: ['Point'] },
    coordinates: { type: [Number], default: undefined },
  },
});

const UserSchema = new mongoose.Schema(
  {
    firstName: { 
        type: String, 
        required: true 
    },
    lastName: { 
        type: String, 
        default: '' 
    },
    email: { 
        type: String, 
        required: true, 
        unique: true, 
        lowercase: true, 
        trim: true 
    },
    password: { 
      type: String, 
      required: true 
    },
    phone: { 
      type: String, 
      default: '' 
    },
     // Phone verification fields (optional for customers — not required to log in,
    // but required before placing an order; see orderRoutes.js)
    phoneVerified: { type: Boolean, default: false },
    phoneVerificationCode: { type: String, default: null },
    phoneVerificationExpiry: { type: Date, default: null },
    phoneVerificationSentAt: { type: Date, default: null },
    phoneVerificationAttempts: { type: Number, default: 0 },
    avatar: { type: String, default: null },
    location: { type: String, default: 'Abuja, Nigeria' },
    coordinates: {
      type: { type: String, enum: ['Point'] },
      coordinates: { type: [Number], default: undefined }, // [longitude, latitude]
    },
    addresses: [AddressSchema],
    favoriteVendors: [{ type: String }],
    // Favourites shown on the profile: stores to go back to, and past orders
    // to repeat with one tap.
    favoriteStores: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Store' }],
    favoriteOrders: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Order' }],

    // ── Loyalty (see utils/rewards.js) ──────────────────────────────────────
    rewards: {
      points: { type: Number, default: 0, min: 0 },
      deliveryCredit: { type: Number, default: 0, min: 0 },   // ₦, pays delivery fees only
      freeDeliveries: { type: Number, default: 0, min: 0 },   // vouchers
    },
    // Birthday: day and month only (no year — we don't need their age). Set
    // once by the customer; changing it needs support, so it can't be moved
    // around to collect extra birthday codes.
    birthday: {
      day: { type: Number, min: 1, max: 31, default: null },
      month: { type: Number, min: 1, max: 12, default: null },
    },
    // Their own code to share, and who referred them (if anyone).
    referralCode: { type: String, default: null, uppercase: true, trim: true },
    referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    // True once the referrer has been rewarded for this customer.
    referralRewarded: { type: Boolean, default: false },
    notifications: {
      orderUpdates: { type: Boolean, default: true },
      promotions: { type: Boolean, default: false },
      newsletter: { type: Boolean, default: true },
    },
    //Email verification fields
    isVerified: { type: Boolean, default: false },
    verificationCode: { type: String, default: null },
    verificationCodeExpiry: { type: Date, default: null },
    verificationCodeSentAt: { type: Date, default: null }, //Cooldown
    verificationAttempts: { type: Number, default: 0 },

    //password reset fields
    passwordResetCode: { type: String, default: null },
    passwordResetExpiry: { type: Date, default: null },
    passwordResetSentAt: { type: Date, default: null },
    passwordResetAttempts: { type: Number, default: 0 },

    // New location login fields
    lastKnownIp: { type: String, default: null },
    loginCode: { type: String, default: null },
    loginCodeExpiry: { type: Date, default: null },
    loginCodeSentAt: { type: Date, default: null },
    // Was `loginAttempts`, but every route reads/writes `loginCodeAttempts`,
    // so the attempt limit on new-location codes never actually applied.
    loginCodeAttempts: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: 'joinedDate', updatedAt: true } }
);

UserSchema.index({ coordinates: '2dsphere' }, { sparse: true });
// Unique only among users who have a code (most old accounts don't yet).
UserSchema.index(
  { referralCode: 1 },
  { unique: true, partialFilterExpression: { referralCode: { $type: 'string' } } }
);

UserSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

UserSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

UserSchema.methods.toSafeJSON = function () {
  const obj = this.toObject();
  delete obj.password;
  delete obj.verificationCode;
  delete obj.verificationCodeExpiry;
  delete obj.verificationCodeSentAt;
  delete obj.verificationAttempts;
  delete obj.phoneVerificationCode;
  delete obj.phoneVerificationExpiry;
  delete obj.phoneVerificationSentAt;
  delete obj.phoneVerificationAttempts;
  delete obj.passwordResetCode;
  delete obj.passwordResetExpiry;
  delete obj.passwordResetSentAt;
  delete obj.passwordResetAttempts;
  delete obj.loginCode;
  delete obj.loginCodeExpiry;
  delete obj.loginCodeSentAt;
  delete obj.loginCodeAttempts;

  // Give the frontend plain ids and lat/lng instead of Mongo/GeoJSON shapes.
  obj.id = String(obj._id);
  const toLatLng = (point) =>
    Array.isArray(point?.coordinates) && point.coordinates.length === 2
      ? { latitude: point.coordinates[1], longitude: point.coordinates[0] }
      : { latitude: null, longitude: null };
  Object.assign(obj, toLatLng(obj.coordinates));
  obj.birthday = obj.birthday?.day && obj.birthday?.month ? { day: obj.birthday.day, month: obj.birthday.month } : null;
  obj.favoriteStores = (obj.favoriteStores || []).map(String);
  obj.favoriteOrders = (obj.favoriteOrders || []).map(String);
  obj.referredBy = obj.referredBy ? String(obj.referredBy) : null;
  obj.rewards = {
    points: obj.rewards?.points || 0,
    deliveryCredit: obj.rewards?.deliveryCredit || 0,
    freeDeliveries: obj.rewards?.freeDeliveries || 0,
  };
  obj.addresses = (obj.addresses || []).map((a) => ({
    ...a,
    id: String(a._id),
    ...toLatLng(a.coordinates),
  }));
  return obj;
};

module.exports = mongoose.model('User', UserSchema);
