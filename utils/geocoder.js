const axios = require('axios');

/**
 * Geocoding via OpenStreetMap Nominatim — free, no API key.
 *
 * Nominatim's usage policy: max 1 request/second, a real User-Agent, and
 * caching results. This module does all three, and every browser request goes
 * through our backend (never straight from the frontend) so we stay within it.
 *
 * If traffic grows past what Nominatim allows, swap the two `fetch*` functions
 * for Google/Mapbox — nothing else in the app needs to change.
 */

const NOMINATIM_URL = process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org';
const USER_AGENT =
  process.env.GEOCODER_USER_AGENT ||
  `NightCrawlers/1.0 (${process.env.SMTP_FROM || 'support@nightcrawlers.app'})`;
const COUNTRY = process.env.GEOCODER_COUNTRY || 'ng';

const client = axios.create({
  baseURL: NOMINATIM_URL,
  timeout: 8000,
  headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en' },
});

// ── Tiny in-memory LRU-ish cache ─────────────────────────────────────────────
const CACHE_MAX = 1000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map();

const cacheGet = (key) => {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
};

const cacheSet = (key, value) => {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { value, at: Date.now() });
};

// ── 1 request per second, queued ─────────────────────────────────────────────
let queue = Promise.resolve();
let lastCall = 0;
const throttled = (fn) => {
  const run = queue.then(async () => {
    const wait = Math.max(0, lastCall + 1000 - Date.now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    return fn();
  });
  queue = run.catch(() => {});
  return run;
};

const disabled = () => process.env.NODE_ENV === 'test' || process.env.GEOCODER_DISABLED === 'true';

/** Build a short, human label: "12 Admiralty Way, Lekki, Lagos". */
const shortLabel = (place) => {
  const a = place.address || {};
  const street = [a.house_number, a.road].filter(Boolean).join(' ');
  const area = a.suburb || a.neighbourhood || a.quarter || a.village || a.town;
  const city = a.city || a.state_district || a.county || a.state;
  const parts = [street || a.amenity || a.building, area, city].filter(Boolean);
  const unique = parts.filter((p, i) => parts.indexOf(p) === i);
  return unique.length ? unique.join(', ') : place.display_name;
};

const toResult = (place) => ({
  label: shortLabel(place),
  fullAddress: place.display_name,
  city: place.address?.city || place.address?.town || place.address?.state || '',
  latitude: parseFloat(place.lat),
  longitude: parseFloat(place.lon),
});

/**
 * Address text → up to `limit` matches. Returns [] on failure, never throws,
 * so a geocoder outage can't break store creation or checkout.
 */
const searchAddress = async (query, limit = 5) => {
  const q = (query || '').trim();
  if (!q || disabled()) return [];

  const key = `s:${q.toLowerCase()}:${limit}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  try {
    const { data } = await throttled(() =>
      client.get('/search', {
        params: { q, format: 'jsonv2', addressdetails: 1, limit, countrycodes: COUNTRY },
      })
    );
    const results = (data || []).map(toResult);
    cacheSet(key, results);
    return results;
  } catch (err) {
    console.error('Geocoder search failed:', err.message);
    return [];
  }
};

/** Address text → best single match, or null. */
const geocodeAddress = async (address) => {
  const [first] = await searchAddress(address, 1);
  return first || null;
};

/** Coordinates → readable address, or null. */
const reverseGeocode = async (latitude, longitude) => {
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!isValidLatLng(lat, lng) || disabled()) return null;

  // ~11m precision is plenty for a cache key
  const key = `r:${lat.toFixed(4)},${lng.toFixed(4)}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  try {
    const { data } = await throttled(() =>
      client.get('/reverse', {
        params: { lat, lon: lng, format: 'jsonv2', addressdetails: 1, zoom: 18 },
      })
    );
    const result = data && !data.error ? toResult(data) : null;
    cacheSet(key, result);
    return result;
  } catch (err) {
    console.error('Geocoder reverse failed:', err.message);
    return null;
  }
};

const isValidLatLng = (lat, lng) =>
  Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

/**
 * Pull a valid { latitude, longitude } out of a request body/query.
 * Accepts `latitude/longitude` or `lat/lng`. Returns null if absent/invalid.
 */
const readLatLng = (src = {}) => {
  const lat = parseFloat(src.latitude ?? src.lat);
  const lng = parseFloat(src.longitude ?? src.lng);
  return isValidLatLng(lat, lng) ? { latitude: lat, longitude: lng } : null;
};

/** { latitude, longitude } → GeoJSON Point (note: [lng, lat] order). */
const toPoint = ({ latitude, longitude }) => ({ type: 'Point', coordinates: [longitude, latitude] });

/** GeoJSON Point → { latitude, longitude } or nulls. */
const fromPoint = (point) => {
  const c = point?.coordinates;
  if (!Array.isArray(c) || c.length !== 2) return { latitude: null, longitude: null };
  return { latitude: c[1], longitude: c[0] };
};

module.exports = {
  searchAddress,
  geocodeAddress,
  reverseGeocode,
  readLatLng,
  isValidLatLng,
  toPoint,
  fromPoint,
};
