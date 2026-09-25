/**
 * Distance-based delivery fee.
 *
 *   fee = BASE + PER_KM × (km beyond the first INCLUDED_KM)
 *         rounded UP to the nearest ₦50, kept between MIN and MAX
 *
 * With the defaults: ≤2 km → ₦500 · 5 km → ₦950 · 10 km → ₦1,700 · capped at ₦3,000.
 * Orders further than MAX_KM are refused (riders won't take them).
 *
 * Distance is the straight line between store and customer × 1.3, a common
 * approximation for city roads (routing APIs cost money; this is free and
 * close enough for pricing). If either location is unknown, the flat
 * DELIVERY_FEE is charged instead.
 *
 * Every number can be changed in .env — no code changes needed.
 */
const num = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && process.env[name] !== '' && process.env[name] !== undefined ? v : fallback;
};

const settings = () => ({
  baseFee: num('DELIVERY_BASE_FEE', 500),
  perKm: num('DELIVERY_PER_KM', 150),
  includedKm: num('DELIVERY_INCLUDED_KM', 2),
  minFee: num('DELIVERY_MIN_FEE', 500),
  maxFee: num('DELIVERY_MAX_FEE', 3000),
  maxKm: num('DELIVERY_MAX_KM', 20),
  fallbackFee: num('DELIVERY_FEE', 800), // used when distance can't be worked out
  roadFactor: num('DELIVERY_ROAD_FACTOR', 1.3),
});

const toRad = (d) => (d * Math.PI) / 180;

/** Straight-line km between two { latitude, longitude } points. */
const haversineKm = (a, b) => {
  const R = 6371;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

/**
 * @returns {{ fee: number, distanceKm: number|null, tooFar: boolean, maxKm: number }}
 */
const deliveryFeeFor = (from, to) => {
  const s = settings();
  if (!from || !to) return { fee: s.fallbackFee, distanceKm: null, tooFar: false, maxKm: s.maxKm };

  const km = Math.round(haversineKm(from, to) * s.roadFactor * 10) / 10;
  const raw = s.baseFee + s.perKm * Math.max(0, km - s.includedKm);
  const fee = Math.min(s.maxFee, Math.max(s.minFee, Math.ceil(raw / 50) * 50));
  return { fee, distanceKm: km, tooFar: km > s.maxKm, maxKm: s.maxKm };
};

module.exports = { deliveryFeeFor, haversineKm, deliveryFeeSettings: settings };
