const { getRoute } = require('./routing');
const { haversineKm } = require('./deliveryFee');
const { fromPoint } = require('./geocoder');

/**
 * Live trip progress for a rider's active order, like ride-hailing apps show:
 * distance and time left on the actual road route, the route line for the
 * map, and whether the rider has arrived.
 *
 * Routing costs a request to the routing provider, so we only re-route when
 * the rider has moved noticeably or it's been a while; otherwise the last
 * route is reused.
 */
const num = (name, fallback) => {
  const v = Number(process.env[name]);
  return process.env[name] !== undefined && process.env[name] !== '' && Number.isFinite(v) ? v : fallback;
};
const ARRIVAL_RADIUS_M = () => num('ARRIVAL_RADIUS_METERS', 150); // "at the address"
const REROUTE_MOVE_M = 150;
const REROUTE_EVERY_MS = 60 * 1000;
const MIN_REROUTE_GAP_MS = 15 * 1000;

const pointOf = (geo) => (geo?.coordinates?.length === 2 ? fromPoint(geo) : null);

/** Where the rider is heading for this order right now. */
const destinationFor = (order) => {
  if (order.status === 'accepted') return { kind: 'store', point: pointOf(order.pickupCoordinates) };
  if (['picked_up', 'in_transit'].includes(order.status)) return { kind: 'customer', point: pointOf(order.deliveryCoordinates) };
  return null;
};

/** Metres between rider and the delivery address, allowing for GPS inaccuracy. */
const arrivalCheck = (order, riderPoint, accuracyM = 0) => {
  const dest = pointOf(order.deliveryCoordinates);
  if (!dest) return { verifiable: false, arrived: true, metersAway: null };
  const meters = haversineKm(riderPoint, dest) * 1000;
  const allowance = ARRIVAL_RADIUS_M() + Math.min(Math.max(accuracyM || 0, 0), 100);
  return { verifiable: true, arrived: meters <= allowance, metersAway: Math.round(meters) };
};

/**
 * Update order.trip from the rider's latest position (does not save).
 * @returns {Promise<object|null>} the trip summary, or null if not on a trip
 */
const updateTrip = async (order, riderPoint, accuracyM = 0, now = new Date()) => {
  const dest = destinationFor(order);
  if (!dest || !dest.point || !riderPoint) return null;

  const prev = order.trip && order.trip.destination === dest.kind ? order.trip : null;
  const lastFrom = prev?.routedFrom?.latitude != null ? prev.routedFrom : null;
  const movedM = lastFrom ? haversineKm(lastFrom, riderPoint) * 1000 : Infinity;
  const age = prev?.routedAt ? now - new Date(prev.routedAt) : Infinity;
  const needRoute = !prev || (age > MIN_REROUTE_GAP_MS && (movedM > REROUTE_MOVE_M || age > REROUTE_EVERY_MS));

  let route = prev
    ? { distanceKm: prev.distanceKm, durationMin: prev.durationMin, line: prev.line, source: prev.source }
    : null;
  if (needRoute) route = await getRoute(riderPoint, dest.point);

  // Between re-routes, shrink the remaining distance/time in proportion to the
  // straight-line progress, so numbers keep counting down smoothly.
  let { distanceKm, durationMin } = route;
  if (!needRoute && lastFrom) {
    const was = haversineKm(lastFrom, dest.point);
    const nowKm = haversineKm(riderPoint, dest.point);
    const ratio = was > 0 ? Math.min(1, Math.max(0, nowKm / was)) : 1;
    distanceKm = Math.round(route.distanceKm * ratio * 10) / 10;
    durationMin = Math.max(ratio > 0 ? 1 : 0, Math.round(route.durationMin * ratio));
  }

  const arrival = dest.kind === 'customer' ? arrivalCheck(order, riderPoint, accuracyM) : null;
  const atStore = dest.kind === 'store' ? haversineKm(riderPoint, dest.point) * 1000 <= ARRIVAL_RADIUS_M() : null;

  order.trip = {
    destination: dest.kind,
    distanceKm,
    durationMin,
    line: route.line,
    source: route.source,
    routedAt: needRoute ? now : prev.routedAt,
    routedFrom: needRoute ? riderPoint : prev.routedFrom,
    riderLocation: { ...riderPoint, accuracy: accuracyM || null, at: now },
    arrived: dest.kind === 'customer' ? arrival.arrived : atStore,
    updatedAt: now,
  };
  return order.trip;
};

module.exports = { updateTrip, arrivalCheck, destinationFor, ARRIVAL_RADIUS_M };
