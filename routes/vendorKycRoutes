const express = require('express');
const router = express.Router();
const Vendor = require('../models/vendorModel');
const { protect, requireRole } = require('../middlewares/auth');
const { verifyNIN, verifyCAC, verifyTIN } = require('../utils/premblyService');

/**
 * Recalculates vendor kycStatus based on their path (formal vs informal).
 *
 * Formal:   cacVerified + tinVerified → passed
 * Informal Path A (agent): ninVerified + agentVerified → passed
 * Informal Path B (digital): ninVerified + selfieVerified + termsSignedAt → passed
 * Either path can complete independently.
 */
const updateVendorKycStatus = async (vendor) => {
  let verified = false;

  if (!vendor.isInformalVendor) {
    // Formal path
    verified = vendor.cacVerified && vendor.tinVerified;
  } else {
    // Informal: either agent path OR digital path completes KYC
    const agentPathDone = vendor.ninVerified && vendor.agentVerified;
    const digitalPathDone = vendor.ninVerified && vendor.selfieVerified && !!vendor.termsSignedAt;
    verified = agentPathDone || digitalPathDone;
  }

  const anyStarted = vendor.cacVerified || vendor.tinVerified ||
    vendor.ninVerified || vendor.agentVerified || vendor.selfieVerified;

  if (verified) {
    vendor.kycStatus = 'passed';
  } else if (anyStarted) {
    vendor.kycStatus = 'in_progress';
  } else {
    vendor.kycStatus = 'pending';
  }

  await vendor.save();
  return vendor;
};

// ── GET /api/vendors/me/kyc — get current KYC status ─────────────────────────
router.get('/me/kyc', protect, requireRole('vendor'), async (req, res) => {
  try {
    const vendor = await Vendor.findById(req.user.id);
    if (!vendor) return res.status(404).json({ message: 'Vendor not found' });

    if (!vendor.isInformalVendor) {
      // Formal vendor
      return res.json({
        kycStatus: vendor.kycStatus,
        vendorType: 'formal',
        checks: {
          cac: { verified: vendor.cacVerified, submitted: !!vendor.cacRcNumber },
          tin: { verified: vendor.tinVerified, submitted: !!vendor.tinNumber },
        },
        requiredChecks: ['cac', 'tin'],
        allPassed: vendor.kycStatus === 'passed',
      });
    }

    // Informal vendor
    res.json({
      kycStatus: vendor.kycStatus,
      vendorType: 'informal',
      paths: {
        agentPath: {
          label: 'In-person agent verification',
          checks: {
            nin: { verified: vendor.ninVerified, submitted: !!vendor.ninNumber },
            agentVisit: { verified: vendor.agentVerified, verifiedAt: vendor.agentVerifiedAt },
          },
          completed: vendor.ninVerified && vendor.agentVerified,
        },
        digitalPath: {
          label: 'Digital verification (selfie + T&Cs)',
          checks: {
            nin: { verified: vendor.ninVerified, submitted: !!vendor.ninNumber },
            selfie: { verified: vendor.selfieVerified, note: 'Coming soon via SmileID.' },
            termsSigned: { signed: !!vendor.termsSignedAt, signedAt: vendor.termsSignedAt },
          },
          completed: vendor.ninVerified && vendor.selfieVerified && !!vendor.termsSignedAt,
        },
      },
      allVerified: vendor.kycStatus === 'passed',
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── POST /api/vendors/me/kyc/declare — declare informal status ────────────────
// Called at or after registration when vendor ticks "I don't have a registered business"
router.post('/me/kyc/declare', protect, requireRole('vendor'), async (req, res) => {
  try {
    const { isInformalVendor } = req.body;

    if (typeof isInformalVendor !== 'boolean') {
      return res.status(400).json({ message: 'isInformalVendor must be true or false.' });
    }

    const vendor = await Vendor.findById(req.user.id);
    if (!vendor) return res.status(404).json({ message: 'Vendor not found' });

    // Don't allow changing if KYC already in progress
    if (vendor.kycStatus !== 'pending') {
      return res.status(400).json({
        message: 'Cannot change vendor type after KYC has started.',
      });
    }

    vendor.isInformalVendor = isInformalVendor;
    await vendor.save();

    res.json({
      message: `Vendor type set to ${isInformalVendor ? 'informal' : 'formal'}.`,
      isInformalVendor: vendor.isInformalVendor,
      kycPath: isInformalVendor
        ? 'NIN + (agent visit OR selfie + T&Cs)'
        : 'CAC + TIN',
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── POST /api/vendors/me/kyc/cac — verify CAC (formal vendors) ───────────────
router.post('/me/kyc/cac', protect, requireRole('vendor'), async (req, res) => {
  try {
    const { rcNumber } = req.body;
    if (!rcNumber) return res.status(400).json({ message: 'RC number is required.' });

    const vendor = await Vendor.findById(req.user.id);
    if (!vendor) return res.status(404).json({ message: 'Vendor not found' });

    if (vendor.isInformalVendor) {
      return res.status(400).json({ message: 'CAC verification is for formal vendors only.' });
    }

    if (vendor.cacVerified) {
      return res.status(400).json({ message: 'CAC already verified.' });
    }

    const result = await verifyCAC(rcNumber);

    vendor.cacVerified = true;
    vendor.cacRcNumber = rcNumber;
    vendor.cacData = {
      companyName: result.companyName,
      companyStatus: result.companyStatus,
      registrationDate: result.registrationDate,
      companyType: result.companyType,
      address: result.address,
    };

    await updateVendorKycStatus(vendor);

    res.json({
      message: 'CAC verified successfully.',
      verified: true,
      data: vendor.cacData,
      kycStatus: vendor.kycStatus,
    });
  } catch (err) {
    res.status(422).json({ message: err.message });
  }
});

// ── POST /api/vendors/me/kyc/tin — verify TIN (formal vendors) ───────────────
router.post('/me/kyc/tin', protect, requireRole('vendor'), async (req, res) => {
  try {
    const { tin } = req.body;
    if (!tin) return res.status(400).json({ message: 'TIN is required.' });

    const vendor = await Vendor.findById(req.user.id);
    if (!vendor) return res.status(404).json({ message: 'Vendor not found' });

    if (vendor.isInformalVendor) {
      return res.status(400).json({ message: 'TIN verification is for formal vendors only.' });
    }

    if (vendor.tinVerified) {
      return res.status(400).json({ message: 'TIN already verified.' });
    }

    const result = await verifyTIN(tin);

    vendor.tinVerified = true;
    vendor.tinNumber = tin;
    vendor.tinData = {
      taxpayerName: result.taxpayerName,
      taxOffice: result.taxOffice,
      phone: result.phone,
      email: result.email,
    };

    await updateVendorKycStatus(vendor);

    // comment out later

    res.json({
      message: 'TIN verified successfully.',
      verified: true,
      data: vendor.tinData,
      kycStatus: vendor.kycStatus,
    });
  } catch (err) {
    res.status(422).json({ message: err.message });
  }
});

// ── POST /api/vendors/me/kyc/nin — verify NIN (informal vendors) ──────────────
router.post('/me/kyc/nin', protect, requireRole('vendor'), async (req, res) => {
  try {
    const { nin } = req.body;
    if (!nin) return res.status(400).json({ message: 'NIN is required.' });

    if (!/^\d{11}$/.test(nin)) {
      return res.status(422).json({ message: 'NIN must be exactly 11 digits.' });
    }

    const vendor = await Vendor.findById(req.user.id);
    if (!vendor) return res.status(404).json({ message: 'Vendor not found' });

    if (!vendor.isInformalVendor) {
      return res.status(400).json({ message: 'NIN verification is for informal vendors only. Formal vendors use CAC + TIN.' });
    }

    if (vendor.ninVerified) {
      return res.status(400).json({ message: 'NIN already verified.' });
    }

    const result = await verifyNIN(nin);

    vendor.ninVerified = true;
    vendor.ninNumber = nin;
    vendor.ninData = {
      firstName: result.firstName,
      lastName: result.lastName,
      middleName: result.middleName,
      dateOfBirth: result.dateOfBirth,
      gender: result.gender,
      phone: result.phone,
    };

    await updateVendorKycStatus(vendor);

    res.json({
      message: 'NIN verified successfully.',
      verified: true,
      data: vendor.ninData,
      kycStatus: vendor.kycStatus,
    });
  } catch (err) {
    res.status(422).json({ message: err.message });
  }
});

// ── POST /api/vendors/me/kyc/terms — sign T&Cs (informal Path B) ─────────────
router.post('/me/kyc/terms', protect, requireRole('vendor'), async (req, res) => {
  try {
    const { agreed, termsVersion } = req.body;

    if (!agreed) {
      return res.status(400).json({ message: 'You must agree to the terms and conditions.' });
    }

    const vendor = await Vendor.findById(req.user.id);
    if (!vendor) return res.status(404).json({ message: 'Vendor not found' });

    if (!vendor.isInformalVendor) {
      return res.status(400).json({ message: 'T&Cs signing is for informal vendors only.' });
    }

    if (!vendor.ninVerified) {
      return res.status(400).json({ message: 'Please verify your NIN before signing T&Cs.' });
    }

    if (vendor.termsSignedAt) {
      return res.status(400).json({ message: 'T&Cs already signed.' });
    }

    vendor.termsSignedAt = new Date();
    vendor.termsVersion = termsVersion || 'v1.0';

    await updateVendorKycStatus(vendor);

    res.json({
      message: 'Terms and conditions signed successfully.',
      signedAt: vendor.termsSignedAt,
      termsVersion: vendor.termsVersion,
      kycStatus: vendor.kycStatus,
    });
  } catch (err) {
    console.error('Terms route error:', err.message);
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;