const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const AddressSchema = new mongoose.Schema({
  label: { type: String, required: true },
  address: { type: String, required: true },
  city: { type: String, required: true },
  isDefault: { type: Boolean, default: false },
  coordinates: {
    type: { 
      type: String, 
      enum: ['Point'], 
      default: 'Point' 
    },
    coordinates: { 
      type: [Number], 
      default: null}, // [longitude, latitude]
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
    avatar: { type: String, default: null },
    location: { type: String, default: 'Abuja, Nigeria' },
    coordinates: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], default: null }, // [longitude, latitude]
    },
    addresses: [AddressSchema],
    favoriteVendors: [{ type: String }],
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
    loginAttempts: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: 'joinedDate', updatedAt: true } }
);

UserSchema.index({ coordinates: '2dsphere' });

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
  delete obj.passwordResetCode;
  delete obj.passwordResetExpiry;
  delete obj.passwordResetSentAt;
  delete obj.passwordResetAttempts;
  delete obj.loginCode;
  delete obj.loginCodeExpiry;
  delete obj.loginCodeSentAt;
  delete obj.loginCodeAttempts;
  return obj;
};

module.exports = mongoose.model('User', UserSchema);
