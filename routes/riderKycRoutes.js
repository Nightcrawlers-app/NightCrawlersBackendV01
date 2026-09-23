const express = require('express');
const router = express.Router();
const Rider = require('../models/riderModel');
const { protect, requireRole } = require('../middlewares/auth');
const { verifyNIN, verifyDriversLicense } = require('../utils/premblyService');

/**
 * Recalculates and saves the rider's overall kycStatus based on
 * which individual checks have passed. All 4 must pass for 'passed'.
 * selfie is deferred (SmileID) — treated as optional until SmileID is live.
 */
const updateRiderKycStatus = async (rider) => {
  const checks = [
    rider.ninVerified,
    rider.licenseVerified,
    rider.addressVerified,
    // rider.selfieVerified, // re-enable once SmileID is integrated
  ];

  const anyStarted = rider.ninVerified || rider.licenseVerified ||
    rider.addressVerified || rider.agentVerified;

  if (checks.every(Boolean)) {
    rider.kycStatus = 'passed';
  } else if (anyStarted) {
    rider.kycStatus = 'in_progress';
  } else {
    rider.kycStatus = 'pending';
  }

  await rider.save();
  return rider;
};

// ── GET /api/riders/me/kyc — get current KYC status ──────────────────────────
router.get('/me/kyc', protect, requireRole('rider'), async (req, res) => {
  try {
    const rider = await Rider.findById(req.user.id);
    if (!rider) return res.status(404).json({ message: 'Rider not found' });

    res.json({
      kycStatus: rider.kycStatus,
      checks: {
        nin: {
          verified: rider.ninVerified,
          submitted: !!rider.ninNumber,
        },
        driversLicense: {
          verified: rider.licenseVerified,
          submitted: !!rider.licenseNumber,
        },
        selfie: {
          verified: rider.selfieVerified,
          note: 'Selfie/liveness check coming soon via SmileID.',
        },
        residentialAddress: {
          verified: rider.addressVerified,
          submitted: !!rider.addressDocumentUrl,
          submittedAt: rider.addressSubmittedAt,
        },
      },
      requiredChecks: ['nin', 'driversLicense', 'residentialAddress'],
      allVerified: rider.kycStatus === 'passed',
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── POST /api/riders/me/kyc/nin — verify NIN ─────────────────────────────────
router.post('/me/kyc/nin', protect, requireRole('rider'), async (req, res) => {
  try {
    const { nin } = req.body;
    if (!nin) return res.status(400).json({ message: 'NIN is required.' });
    
    if (!/^\d{11}$/.test(nin)) {
      return res.status(422).json({ message: 'NIN must be exactly 11 digits.' });
    }
    const rider = await Rider.findById(req.user.id);
    if (!rider) return res.status(404).json({ message: 'Rider not found' });

    if (rider.ninVerified) {
      return res.status(400).json({ message: 'NIN already verified.' });
    }

    const result = await verifyNIN(nin);

    rider.ninVerified = true;
    rider.ninNumber = nin;
    rider.ninData = {
      firstName: result.firstName,
      lastName: result.lastName,
      middleName: result.middleName,
      dateOfBirth: result.dateOfBirth,
      gender: result.gender,
      phone: result.phone,
      // deliberately omit photo from stored data for privacy
    };

    await updateRiderKycStatus(rider);

    res.json({
      message: 'NIN verified successfully.',
      verified: true,
      data: rider.ninData,
      kycStatus: rider.kycStatus,
    });
  } catch (err) {
    res.status(422).json({ message: err.message });
  }
});

// ── POST /api/riders/me/kyc/license — verify driver's license ────────────────
router.post('/me/kyc/license', protect, requireRole('rider'), async (req, res) => {
  try {
    const { licenseNumber, dateOfBirth } = req.body;

    if (!licenseNumber) return res.status(400).json({ message: 'License number is required.' });
    if (!dateOfBirth) return res.status(400).json({ message: 'Date of birth is required (YYYY-MM-DD).' });
    
    // ✅ Add this validation BEFORE calling verifyDriversLicense
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) {
      return res.status(422).json({ message: 'Date of birth must be in YYYY-MM-DD format.' });
    }

    const rider = await Rider.findById(req.user.id);
    if (!rider) return res.status(404).json({ message: 'Rider not found' });

    if (rider.licenseVerified) {
      return res.status(400).json({ message: 'Driver\'s license already verified.' });
    }

    if (!rider.ninVerified) {
      return res.status(400).json({
        message: 'Please verify your NIN before your driver\'s license.',
      });
    }

    const result = await verifyDriversLicense(licenseNumber, dateOfBirth);

    rider.licenseVerified = true;
    rider.licenseNumber = licenseNumber;
    rider.licenseData = {
      firstName: result.firstName,
      lastName: result.lastName,
      expiryDate: result.expiryDate,
      stateOfIssue: result.stateOfIssue,
      vehicleClass: result.vehicleClass,
    };

    await updateRiderKycStatus(rider);

    res.json({
      message: 'Driver\'s license verified successfully.',
      verified: true,
      data: rider.licenseData,
      kycStatus: rider.kycStatus,
    });
  } catch (err) {
    res.status(422).json({ message: err.message });
  }
});

// ── POST /api/riders/me/kyc/address — submit utility bill URL ────────────────
// Frontend uploads the image to cloud storage (e.g. Cloudinary) and sends the URL.
// Admin reviews and approves/rejects via the admin KYC route.
router.post('/me/kyc/address', protect, requireRole('rider'), async (req, res) => {
  try {
    const { documentUrl } = req.body;

    if (!documentUrl) {
      return res.status(400).json({ message: 'documentUrl is required.' });
    }

    const rider = await Rider.findById(req.user.id);
    if (!rider) return res.status(404).json({ message: 'Rider not found' });

    if (rider.addressVerified) {
      return res.status(400).json({ message: 'Address already verified.' });
    }

    rider.addressDocumentUrl = documentUrl;
    rider.addressSubmittedAt = new Date();
    await updateRiderKycStatus(rider);

    res.json({
      message: 'Utility bill submitted. An admin will review it within 24 hours.',
      submitted: true,
      kycStatus: rider.kycStatus,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
