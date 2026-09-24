const express = require('express');
const { searchAddress, reverseGeocode, readLatLng } = require('../utils/geocoder');

const router = express.Router();

// GET /api/geo/reverse?lat=9.05&lng=7.49 — coordinates → readable address
router.get('/reverse', async (req, res) => {
  const point = readLatLng(req.query);
  if (!point) return res.status(400).json({ message: 'Valid lat and lng are required.' });

  const place = await reverseGeocode(point.latitude, point.longitude);
  if (!place) {
    // Still useful to the caller: they keep their coordinates, just no label.
    return res.json({ label: null, fullAddress: null, city: '', ...point });
  }
  res.json(place);
});

// GET /api/geo/search?q=admiralty way lekki — address autocomplete
router.get('/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 3) return res.json([]);
  res.json(await searchAddress(q, 5));
});

module.exports = router;
