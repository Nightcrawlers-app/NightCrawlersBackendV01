const express = require('express');
const router = express.Router();
const User = require('../models/userModel');
const { protect, requireRole } = require('../middlewares/auth');
const { geocodeAddress, readLatLng, toPoint } = require('../utils/geocoder');

router.use(protect, requireRole('customer'));

// Avatars are stored as small data URLs (the frontend resizes to ~512px JPEG
// before upload, which comes out around 30–80 KB). Cap it so one user can't
// bloat every /me response with a 6 MB photo.
const MAX_AVATAR_BYTES = 400 * 1024;
const validateAvatar = (avatar) => {
  if (avatar === null || avatar === '') return null;
  if (typeof avatar !== 'string') return 'Invalid image.';
  if (/^https:\/\//i.test(avatar)) return null; // hosted image URL
  const m = avatar.match(/^data:image\/(png|jpe?g|webp|gif);base64,/i);
  if (!m) return 'Image must be a PNG, JPG, WEBP or GIF.';
  const bytes = Math.floor(((avatar.length - m[0].length) * 3) / 4);
  if (bytes > MAX_AVATAR_BYTES) return 'Image is too large. Please choose a smaller photo.';
  return null;
};

/**
 * Work out coordinates for an address: use lat/lng the client sent (e.g. from
 * "use my current location"), otherwise geocode the text. Null if neither works.
 */
const resolveAddressPoint = async (body, address, city) => {
  const sent = readLatLng(body);
  if (sent) return toPoint(sent);
  const found = await geocodeAddress([address, city].filter(Boolean).join(', '));
  return found ? toPoint(found) : undefined;
};

/** Keep the user's top-level location/coordinates in sync with their default address. */
const syncDefault = (user) => {
  const def = user.addresses.find((a) => a.isDefault);
  if (!def) return;
  user.location = def.city;
  user.coordinates = def.coordinates?.coordinates?.length ? def.coordinates : undefined;
};

// PATCH /api/users/me — update profile fields (firstName, lastName, phone, avatar, notifications)
router.patch('/me', async (req, res) => {
  try {
    const allowed = ['firstName', 'lastName', 'phone', 'avatar', 'notifications', 'favoriteVendors'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    if (updates.avatar !== undefined) {
      const avatarError = validateAvatar(updates.avatar);
      if (avatarError) return res.status(400).json({ message: avatarError });
      if (updates.avatar === '') updates.avatar = null;
    }

    const current = await User.findById(req.user.id);
    if (!current) return res.status(404).json({ message: 'User not found' });

    // Changing the phone number means the old verification no longer applies.
    if (updates.phone !== undefined && updates.phone !== current.phone) {
      updates.phoneVerified = false;
    }

    const user = await User.findByIdAndUpdate(req.user.id, updates, { new: true, runValidators: true });
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

    const coordinates = await resolveAddressPoint(req.body, address, city);

    user.addresses.push({
      label,
      address,
      city,
      isDefault: isDefault || user.addresses.length === 0,
      ...(coordinates && { coordinates }),
    });

    syncDefault(user);

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
    const moved = (address !== undefined && address !== addr.address) ||
      (city !== undefined && city !== addr.city) || readLatLng(req.body);
    if (label !== undefined) addr.label = label;
    if (address !== undefined) addr.address = address;
    if (city !== undefined) addr.city = city;

    if (moved) {
      addr.coordinates = await resolveAddressPoint(req.body, addr.address, addr.city);
    }

    if (isDefault) {
      user.addresses.forEach((a) => (a.isDefault = a._id.equals(addr._id)));
    }

    syncDefault(user);

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
    if (defaultAddr) syncDefault(user);
    else {
      user.location = 'Abuja, Nigeria'; // matches the schema default
      user.coordinates = undefined;
    }

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
    syncDefault(user);

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
    if (newPassword.length < 8) {
      return res.status(400).json({ message: 'New password must be at least 8 characters' });
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