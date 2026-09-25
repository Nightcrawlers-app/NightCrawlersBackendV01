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

    phoneVerified: { type: Boolean, default: false },
    phoneVerificationCode: { type: String, default: null },
    phoneVerificationExpiry: { type: Date, default: null },
    phoneVerificationSentAt: { type: Date, default: null },
    phoneVerificationAttempts: { type: Number, default: 0 },

    bankVerified: { type: Boolean, default: false },
    bankAccountNumber: { type: String, default: null },
    bankAccountName: { type: String, default: null },
    bankCode: { type: String, default: null },
    bankName: { type: String, default: null },
    
     // ── KYC Fields ──────────────────────────────────────────────────────────
 
    // Is this vendor informal (no registered business)?
    isInformalVendor: { type: Boolean, default: false },
 
    // Overall KYC status
    kycStatus: { type: String, enum: ['pending', 'in_progress', 'passed', 'failed'], default: 'pending' },
 
    // ── FORMAL VENDOR KYC ──────────────────────────────────────────────────
 
    // CAC Verification (via Prembly)
    cacVerified: { type: Boolean, default: false },
    cacRcNumber: { type: String, default: null },
    cacData: { type: Object, default: null }, // company name, status, type
 
    // TIN Verification (via Prembly)
    tinVerified: { type: Boolean, default: false },
    tinNumber: { type: String, default: null },
    tinData: { type: Object, default: null },
 
    // ── INFORMAL VENDOR KYC ───────────────────────────────────────────────
 
    // NIN Verification (via Prembly) — informal vendors only
    ninVerified: { type: Boolean, default: false },
    ninNumber: { type: String, default: null },
    ninData: { type: Object, default: null },
 
    // Selfie / Liveness (via SmileID — deferred)
    selfieVerified: { type: Boolean, default: false },
    selfieJobId: { type: String, default: null },
 
    // Agent in-person verification — informal vendors (Path A)
    agentVerified: { type: Boolean, default: false },
    agentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    agentVerifiedAt: { type: Date, default: null },
    agentNotes: { type: String, default: null },
 
    // Signed T&Cs — informal vendors (Path B)
    termsSignedAt: { type: Date, default: null },
    termsVersion: { type: String, default: null }, // which version of T&Cs they signed

    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true },
    location: { type: String, required: true },
    // Where the business is, picked on the map at signup. [longitude, latitude].
    coordinates: {
      type: { type: String, enum: ['Point'] },
      coordinates: { type: [Number], default: undefined },
    },
    verified: { type: Boolean, default: false },
    // Rejected applications are kept (not deleted) so there's a record and
    // the applicant can see why and reapply.
    rejectedAt: { type: Date, default: null },
    rejectionReason: { type: String, default: null, maxlength: 500 },
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
  obj.id = String(obj._id);
  const c = obj.coordinates?.coordinates;
  obj.latitude = Array.isArray(c) && c.length === 2 ? c[1] : null;
  obj.longitude = Array.isArray(c) && c.length === 2 ? c[0] : null;
  delete obj.password;
  delete obj.phoneVerificationCode;
  delete obj.phoneVerificationExpiry;
  delete obj.phoneVerificationSentAt;
  delete obj.phoneVerificationAttempts;
  return obj;
};

module.exports = mongoose.model('Vendor', VendorSchema);
module.exports.BUSINESS_TYPES = BUSINESS_TYPES;