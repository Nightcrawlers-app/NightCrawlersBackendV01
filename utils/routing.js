const axios = require('axios');
const { haversineKm } = require('./deliveryFee');

/**
 * Road routes (distance, drive time and the line to draw on the map) between
 * two points. Pick the provider in .env:
 *
 *   ROUTING_PROVIDER=osrm     OSRM (default). Free, no key. The public server
 *                             (router.project-osrm.org) is a DEMO with no uptime
 *                             guarantee and a fair-use policy — fine for testing,
 *                             not for a busy live service. Point OSRM_URL at your
 *                             own OSRM server, or switch provider, before launch.
 *   ROUTING_PROVIDER=ors      openrouteservice.org — free key, daily quota.
 *                             Needs OPENROUTESERVICE_API_KEY.
 *   ROUTING_PROVIDER=mapbox   Mapbox Directions — generous free tier, then paid.
 *                             Needs MAPBOX_TOKEN.
 *
 * If the provider fails or is slow, we fall back to a straight-line estimate
 * so riders and customers always see *something*, never an error.
 *
 * ROUTE_TIME_FACTOR scales provider drive times (e.g. 0.8 if bikes at night
 * are consistently 20% faster than the car times the provider returns).
 */
const TIMEOUT_MS = 6000;
const factor = () => Number(process.env.ROUTE_TIME_FACTOR) || 1;
const lngLat = (p) => `${p.longitude},${p.latitude}`;

const fromGeoJsonLine = (coords) => (coords || []).map(([lng, lat]) => [lat, lng]);

const providers = {
  async osrm(from, to) {
    const base = (process.env.OSRM_URL || 'https://router.project-osrm.org').replace(/\/$/, '');
    const { data } = await axios.get(`${base}/route/v1/driving/${lngLat(from)};${lngLat(to)}`, {
      params: { overview: 'simplified', geometries: 'geojson' },
      timeout: TIMEOUT_MS,
      headers: { 'User-Agent': 'Nightcrawlers/1.0' },
    });
    const r = data?.routes?.[0];
    if (data?.code !== 'Ok' || !r) throw new Error(data?.message || 'no route');
    return { meters: r.distance, seconds: r.duration, line: fromGeoJsonLine(r.geometry?.coordinates) };
  },

  async ors(from, to) {
    const { data } = await axios.post(
      'https://api.openrouteservice.org/v2/directions/driving-car/geojson',
      { coordinates: [[from.longitude, from.latitude], [to.longitude, to.latitude]] },
      { timeout: TIMEOUT_MS, headers: { Authorization: process.env.OPENROUTESERVICE_API_KEY } }
    );
    const f = data?.features?.[0];
    if (!f) throw new Error('no route');
    return { meters: f.properties.summary.distance, seconds: f.properties.summary.duration, line: fromGeoJsonLine(f.geometry.coordinates) };
  },

  async mapbox(from, to) {
    const { data } = await axios.get(
      `https://api.mapbox.com/directions/v5/mapbox/driving/${lngLat(from)};${lngLat(to)}`,
      { params: { geometries: 'geojson', overview: 'simplified', access_token: process.env.MAPBOX_TOKEN }, timeout: TIMEOUT_MS }
    );
    const r = data?.routes?.[0];
    if (!r) throw new Error(data?.message || 'no route');
    return { meters: r.distance, seconds: r.duration, line: fromGeoJsonLine(r.geometry?.coordinates) };
  },
};

/** Straight line × 1.3 at ETA_RIDE_SPEED_KMH — used when routing isn't available. */
const estimateRoute = (from, to) => {
  const km = haversineKm(from, to) * 1.3;
  const speed = Number(process.env.ETA_RIDE_SPEED_KMH) || 25;
  return {
    distanceKm: Math.round(km * 10) / 10,
    durationMin: Math.max(1, Math.round((km / speed) * 60)),
    line: [[from.latitude, from.longitude], [to.latitude, to.longitude]],
    source: 'estimate',
  };
};

/**
 * @returns {Promise<{distanceKm:number, durationMin:number, line:[number,number][], source:string}>}
 */
const getRoute = async (from, to) => {
  const name = (process.env.ROUTING_PROVIDER || 'osrm').toLowerCase();
  if (process.env.NODE_ENV === 'test' || process.env.ROUTING_DISABLED === 'true' || !providers[name]) {
    return estimateRoute(from, to);
  }
  try {
    const r = await providers[name](from, to);
    return {
      distanceKm: Math.round((r.meters / 1000) * 10) / 10,
      durationMin: Math.max(1, Math.round((r.seconds / 60) * factor())),
      line: r.line,
      source: name,
    };
  } catch (err) {
    console.error(`Routing (${name}) failed, using estimate:`, err.message);
    return estimateRoute(from, to);
  }
};

module.exports = { getRoute, estimateRoute };
