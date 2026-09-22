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

    bankVerified: { type: Boolean, default: false },
    bankAccountNumber: { type: String, default: null },
    bankAccountName: { type: String, default: null },
    bankCode: { type: String, default: null },
    bankName: { type: String, default: null },
    
    // ── KYC Fields ──────────────────────────────────────────────────────────
 
    // Overall KYC status: 'pending' | 'in_progress' | 'passed' | 'failed'
    kycStatus: { type: String, enum: ['pending', 'in_progress', 'passed', 'failed'], default: 'pending' },
 
    // NIN Verification (via Prembly)
    ninVerified: { type: Boolean, default: false },
    ninNumber: { type: String, default: null },
    ninData: { type: Object, default: null }, // stores name, DOB, gender from NIMC
 
    // Driver's License Verification (via Prembly)
    licenseVerified: { type: Boolean, default: false },
    licenseNumber: { type: String, default: null },
    licenseData: { type: Object, default: null }, // stores expiry, state, vehicle class
 
    // Selfie / Liveness (via SmileID — deferred)
    selfieVerified: { type: Boolean, default: false },
    selfieJobId: { type: String, default: null }, // SmileID job reference
 
    // Residential Address (utility bill — admin reviews manually)
    addressVerified: { type: Boolean, default: false },
    addressDocumentUrl: { type: String, default: null }, // uploaded utility bill image URL
    addressSubmittedAt: { type: Date, default: null },
    addressReviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    addressReviewedAt: { type: Date, default: null },
 
    // Agent in-person visit (for informal vendors — also reused for riders if needed)
    agentVerified: { type: Boolean, default: false },
    agentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    agentVerifiedAt: { type: Date, default: null },
    agentNotes: { type: String, default: null },

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