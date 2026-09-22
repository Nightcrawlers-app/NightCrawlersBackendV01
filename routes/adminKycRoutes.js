const express = require('express');
const router = express.Router();
const Vendor = require('../models/vendorModel');
const Rider = require('../models/riderModel');
const { protect, requireRole } = require('../middlewares/auth');

router.use(protect, requireRole('admin'));

// ── GET /api/admin/kyc/pending — all vendors/riders with KYC in_progress ──────
router.get('/kyc/pending', async (req, res) => {
  try {
    const [pendingVendors, pendingRiders] = await Promise.all([
      Vendor.find({ kycStatus: { $in: ['in_progress', 'pending'] }, verified: false })
        .select('firstName lastName email businessType isInformalVendor kycStatus ninVerified cacVerified tinVerified agentVerified selfieVerified termsSignedAt addressDocumentUrl'),
      Rider.find({ kycStatus: { $in: ['in_progress', 'pending'] }, verified: false })
        .select('firstName lastName email vehicleType kycStatus ninVerified licenseVerified addressVerified selfieVerified addressDocumentUrl addressSubmittedAt'),
    ]);

    res.json({
      vendors: pendingVendors.map((v) => ({
        id: String(v._id),
        name: `${v.firstName} ${v.lastName}`,
        email: v.email,
        businessType: v.businessType,
        vendorType: v.isInformalVendor ? 'informal' : 'formal',
        kycStatus: v.kycStatus,
        checks: v.isInformalVendor
          ? { nin: v.ninVerified, agent: v.agentVerified, selfie: v.selfieVerified, termsSigned: !!v.termsSignedAt }
          : { cac: v.cacVerified, tin: v.tinVerified },
      })),
      riders: pendingRiders.map((r) => ({
        id: String(r._id),
        name: `${r.firstName} ${r.lastName}`,
        email: r.email,
        vehicleType: r.vehicleType,
        kycStatus: r.kycStatus,
        checks: {
          nin: r.ninVerified,
          license: r.licenseVerified,
          address: r.addressVerified,
          addressDocUrl: r.addressDocumentUrl,
          addressSubmittedAt: r.addressSubmittedAt,
          selfie: r.selfieVerified,
        },
      })),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── POST /api/admin/kyc/rider/:id/address — approve or reject utility bill ────
router.post('/kyc/rider/:id/address', async (req, res) => {
  try {
    const { action, notes } = req.body;

    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ message: 'action must be "approve" or "reject".' });
    }

    const rider = await Rider.findById(req.params.id);
    if (!rider) return res.status(404).json({ message: 'Rider not found' });

    if (!rider.addressDocumentUrl) {
      return res.status(400).json({ message: 'Rider has not submitted an address document.' });
    }

    if (action === 'approve') {
      rider.addressVerified = true;
      rider.addressReviewedBy = req.user.id;
      rider.addressReviewedAt = new Date();
    } else {
      // Reject — clear the document so rider can resubmit
      rider.addressVerified = false;
      rider.addressDocumentUrl = null;
      rider.addressSubmittedAt = null;
      rider.addressReviewedBy = req.user.id;
      rider.addressReviewedAt = new Date();
    }

    // Recalculate KYC status
    const checks = [rider.ninVerified, rider.licenseVerified, rider.addressVerified];
    const anyStarted = rider.ninVerified || rider.licenseVerified || rider.addressVerified;

    if (checks.every(Boolean)) {
      rider.kycStatus = 'passed';
    } else if (anyStarted) {
      rider.kycStatus = 'in_progress';
    }

    await rider.save();

    res.json({
      success: true,
      action,
      kycStatus: rider.kycStatus,
      message: action === 'approve'
        ? 'Address document approved.'
        : 'Address document rejected. Rider must resubmit.',
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── POST /api/admin/kyc/vendor/:id/agent — mark agent in-person visit ─────────
router.post('/kyc/vendor/:id/agent', async (req, res) => {
  try {
    const { verified, notes } = req.body;

    if (typeof verified !== 'boolean') {
      return res.status(400).json({ message: 'verified must be true or false.' });
    }

    const vendor = await Vendor.findById(req.params.id);
    if (!vendor) return res.status(404).json({ message: 'Vendor not found' });

    if (!vendor.isInformalVendor) {
      return res.status(400).json({ message: 'Agent verification is only for informal vendors.' });
    }

    vendor.agentVerified = verified;
    vendor.agentId = req.user.id;
    vendor.agentVerifiedAt = new Date();
    vendor.agentNotes = notes || null;

    // Recalculate KYC status
    const agentPathDone = vendor.ninVerified && vendor.agentVerified;
    const digitalPathDone = vendor.ninVerified && vendor.selfieVerified && !!vendor.termsSignedAt;
    const anyStarted = vendor.ninVerified || vendor.agentVerified || vendor.selfieVerified;

    if (agentPathDone || digitalPathDone) {
      vendor.kycStatus = 'passed';
    } else if (anyStarted) {
      vendor.kycStatus = 'in_progress';
    }

    await vendor.save();

    res.json({
      success: true,
      agentVerified: verified,
      kycStatus: vendor.kycStatus,
      message: verified
        ? 'Agent in-person visit recorded. Vendor KYC updated.'
        : 'Agent visit marked as failed.',
    });
  } catch (err) {
    console.log('AGENT ROUTE ERROR:', err.message); // comment out later
    res.status(500).json({ message: err.message });
  }
});

// ── GET /api/admin/kyc/vendor/:id — full KYC details for a vendor ─────────────
router.get('/kyc/vendor/:id', async (req, res) => {
  try {
    const vendor = await Vendor.findById(req.params.id);
    if (!vendor) return res.status(404).json({ message: 'Vendor not found' });

    res.json({
      id: String(vendor._id),
      name: `${vendor.firstName} ${vendor.lastName}`,
      email: vendor.email,
      businessType: vendor.businessType,
      isInformalVendor: vendor.isInformalVendor,
      kycStatus: vendor.kycStatus,
      verified: vendor.verified,
      kyc: vendor.isInformalVendor
        ? {
            nin: { verified: vendor.ninVerified, number: vendor.ninNumber, data: vendor.ninData },
            agent: { verified: vendor.agentVerified, verifiedAt: vendor.agentVerifiedAt, notes: vendor.agentNotes },
            selfie: { verified: vendor.selfieVerified },
            terms: { signed: !!vendor.termsSignedAt, signedAt: vendor.termsSignedAt, version: vendor.termsVersion },
          }
        : {
            cac: { verified: vendor.cacVerified, rcNumber: vendor.cacRcNumber, data: vendor.cacData },
            tin: { verified: vendor.tinVerified, number: vendor.tinNumber, data: vendor.tinData },
          },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── GET /api/admin/kyc/rider/:id — full KYC details for a rider ───────────────
router.get('/kyc/rider/:id', async (req, res) => {
  try {
    const rider = await Rider.findById(req.params.id);
    if (!rider) return res.status(404).json({ message: 'Rider not found' });

    res.json({
      id: String(rider._id),
      name: `${rider.firstName} ${rider.lastName}`,
      email: rider.email,
      vehicleType: rider.vehicleType,
      kycStatus: rider.kycStatus,
      verified: rider.verified,
      kyc: {
        nin: { verified: rider.ninVerified, number: rider.ninNumber, data: rider.ninData },
        license: { verified: rider.licenseVerified, number: rider.licenseNumber, data: rider.licenseData },
        selfie: { verified: rider.selfieVerified },
        address: {
          verified: rider.addressVerified,
          documentUrl: rider.addressDocumentUrl,
          submittedAt: rider.addressSubmittedAt,
          reviewedAt: rider.addressReviewedAt,
        },
      },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;