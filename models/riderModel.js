const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const RiderSchema = new mongoose.Schema(
  {
    firstName: { type: String, required: true },
    lastName: { type: String, default: '' },
    vehicleType: { type: String, required: true },
    phoneNumber: { type: String, default: '' },
    // Phone verification — REQUIRED for riders before admin approval
    phoneVerified: { type: Boolean, default: false },
    phoneVerificationCode: { type: String, default: null },
    phoneVerificationExpiry: { type: Date, default: null },
    phoneVerificationSentAt: { type: Date, default: null },
    phoneVerificationAttempts: { type: Number, default: 0 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true },
    location: { type: String, required: true },
    isOnline: { type: Boolean, default: false },
    lastSeen: { type: Date, default: null },
    verified: { type: Boolean, default: false },
  },
  { timestamps: true }
);

RiderSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

RiderSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

RiderSchema.methods.toSafeJSON = function () {
  const obj = this.toObject();
  delete obj.password;
  delete obj.phoneVerificationCode;
  delete obj.phoneVerificationExpiry;
  delete obj.phoneVerificationSentAt;
  delete obj.phoneVerificationAttempts;
  return obj;
};

module.exports = mongoose.model('Rider', RiderSchema);