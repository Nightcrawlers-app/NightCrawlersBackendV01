const express = require('express');
const router = express.Router();
const User = require('../models/userModel');
const { protect, requireRole } = require('../middlewares/auth');

router.use(protect, requireRole('customer'));

// PATCH /api/users/me — update profile fields (firstName, lastName, phone, avatar, notifications)
router.patch('/me', async (req, res) => {
  try {
    const allowed = ['firstName', 'lastName', 'phone', 'avatar', 'notifications', 'favoriteVendors'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    const user = await User.findByIdAndUpdate(req.user.id, updates, { new: true });
    res.json(user.toSafeJSON());
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/users/me/addresses — add a new address
router.post('/me/addresses', async (req, res) => {
  try {
    const { label, address, city, isDefault } = req.body;
    if (!label || !address || !city) {
      return res.status(400).json({ message: 'label, address and city are required.' });
    }

    const user = await User.findById(req.user.id);

    if (isDefault || user.addresses.length === 0) {
      user.addresses.forEach((a) => (a.isDefault = false));
    }

    user.addresses.push({
      label,
      address,
      city,
      isDefault: isDefault || user.addresses.length === 0,
    });

    const defaultAddr = user.addresses.find((a) => a.isDefault);
    if (defaultAddr) user.location = defaultAddr.city;

    await user.save();
    res.status(201).json(user.toSafeJSON());
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/users/me/addresses/:addressId
router.patch('/me/addresses/:addressId', async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    const addr = user.addresses.id(req.params.addressId);
    if (!addr) return res.status(404).json({ message: 'Address not found' });

    const { label, address, city, isDefault } = req.body;
    if (label !== undefined) addr.label = label;
    if (address !== undefined) addr.address = address;
    if (city !== undefined) addr.city = city;

    if (isDefault) {
      user.addresses.forEach((a) => (a.isDefault = a._id.equals(addr._id)));
    }

    const defaultAddr = user.addresses.find((a) => a.isDefault);
    if (defaultAddr) user.location = defaultAddr.city;

    await user.save();
    res.json(user.toSafeJSON());
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE /api/users/me/addresses/:addressId
router.delete('/me/addresses/:addressId', async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    const addr = user.addresses.id(req.params.addressId);
    if (!addr) return res.status(404).json({ message: 'Address not found' });

    const wasDefault = addr.isDefault;
    addr.deleteOne();

    if (wasDefault && user.addresses.length > 0) {
      user.addresses[0].isDefault = true;
    }

    const defaultAddr = user.addresses.find((a) => a.isDefault);
    user.location = defaultAddr ? defaultAddr.city : 'Lagos, Nigeria';

    await user.save();
    res.json(user.toSafeJSON());
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/users/me/addresses/:addressId/default
router.patch('/me/addresses/:addressId/default', async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    const target = user.addresses.id(req.params.addressId);
    if (!target) return res.status(404).json({ message: 'Address not found' });

    user.addresses.forEach((a) => (a.isDefault = a._id.equals(target._id)));
    user.location = target.city;

    await user.save();
    res.json(user.toSafeJSON());
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/users/me/password — change password
router.patch('/me/password', async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: 'Please fill in all fields' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ message: 'New password must be at least 6 characters' });
    }

    const user = await User.findById(req.user.id);
    if (!(await user.comparePassword(currentPassword))) {
      return res.status(400).json({ message: 'Current password is incorrect' });
    }

    user.password = newPassword; // pre-save hook hashes it
    await user.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE /api/users/me — delete account
router.delete('/me', async (req, res) => {
  try {
    await User.findByIdAndDelete(req.user.id);
    // Note: also consider anonymizing/cleaning up related Orders here.
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;