const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const BUSINESS_TYPES = ['Food', 'Groceries', 'Pharmacy', 'Drinks', 'Clubs/Lounges'];

const VendorSchema = new mongoose.Schema(
  {
    firstName: { type: String, required: true },
    lastName: { type: String, default: '' },
    businessType: { type: String, enum: BUSINESS_TYPES, default: 'Food' },
    businessTypeRaw: { type: String, default: '' },
    phoneNumber: { type: String, default: '' },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true },
    location: { type: String, required: true },
    verified: { type: Boolean, default: false },
  },
  { timestamps: true }
);

VendorSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

VendorSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

VendorSchema.methods.toSafeJSON = function () {
  const obj = this.toObject();
  delete obj.password;
  return obj;
};

module.exports = mongoose.model('Vendor', VendorSchema);
module.exports.BUSINESS_TYPES = BUSINESS_TYPES;