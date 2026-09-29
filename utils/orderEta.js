/**
 * Delivery time estimates, worked out on the server from the order's status
 * and timestamps (never from the customer's clock).
 *
 *   waiting for store  → store confirms + prepares + rider picks up + ride
 *   preparing          → rest of prep time + pickup + ride
 *   ready              → rider accepts and reaches the store + ride
 *   rider accepted     → ride to the store + ride to the customer
 *   picked up / on way → remaining ride
 *
 * Every number can be tuned in .env without code changes. Estimates are shown
 * as a window ("11:40–11:55 PM"), which is honest about uncertainty.
 */
const num = (name, fallback) => {
  const v = Number(process.env[name]);
  return process.env[name] !== undefined && process.env[name] !== '' && Number.isFinite(v) ? v : fallback;
};

// Typical preparation minutes per business type
const PREP_MINUTES = () => ({
  Food: num('ETA_PREP_FOOD', 20),
  Groceries: num('ETA_PREP_GROCERIES', 15),
  Pharmacy: num('ETA_PREP_PHARMACY', 10),
  Drinks: num('ETA_PREP_DRINKS', 10),
  'Clubs/Lounges': num('ETA_PREP_LOUNGES', 15),
});

const settings = () => ({
  confirmMin: num('ETA_CONFIRM_MINUTES', 5), // store accepts the order
  dispatchMin: num('ETA_DISPATCH_MINUTES', 5), // a rider accepts once it's ready
  toStoreMin: num('ETA_RIDER_TO_STORE_MINUTES', 8), // rider reaches the store
  speedKmh: num('ETA_RIDE_SPEED_KMH', 25), // average night-time riding speed
  defaultKm: num('ETA_DEFAULT_KM', 5), // when the distance isn't known
  windowMin: num('ETA_WINDOW_MINUTES', 15), // width of the shown window
});

const MIN = 60 * 1000;
const roundUp5 = (d) => new Date(Math.ceil(d.getTime() / (5 * MIN)) * 5 * MIN);

/** When status X was reached, from the history (falls back to older fields). */
const reachedAt = (order, status) => {
  const h = (order.statusHistory || []).filter((e) => e.status === status).pop();
  if (h) return new Date(h.at);
  if (status === 'accepted' && order.acceptedAt) return new Date(order.acceptedAt);
  if (status === 'picked_up' && order.pickedUpAt) return new Date(order.pickedUpAt);
  if (status === 'delivered' && order.deliveredAt) return new Date(order.deliveredAt);
  return null;
};

/**
 * @returns {{ earliest: Date, latest: Date } | null} null when delivered/cancelled
 */
const estimateDelivery = (order, { businessType = 'Food', now = new Date() } = {}) => {
  if (['delivered', 'cancelled'].includes(order.status)) return null;
  const s = settings();
  const prep = PREP_MINUTES()[businessType] ?? 20;
  const km = order.deliveryDistanceKm ?? s.defaultKm;
  const ride = Math.max(5, Math.round((km / s.speedKmh) * 60));
  const nowMs = now.getTime();

  let minutesLeft;
  switch (order.status) {
    case 'pending':
      minutesLeft = s.confirmMin + prep + s.dispatchMin + s.toStoreMin + ride;
      break;
    case 'preparing': {
      const started = reachedAt(order, 'preparing') || now;
      const prepLeft = Math.max(3, prep - (nowMs - started.getTime()) / MIN);
      minutesLeft = prepLeft + s.dispatchMin + s.toStoreMin + ride;
      break;
    }
    case 'ready':
      minutesLeft = s.dispatchMin + s.toStoreMin + ride;
      break;
    case 'accepted': {
      const accepted = reachedAt(order, 'accepted') || now;
      const toStoreLeft = Math.max(2, s.toStoreMin - (nowMs - accepted.getTime()) / MIN);
      minutesLeft = toStoreLeft + ride;
      break;
    }
    case 'picked_up':
    case 'in_transit': {
      const picked = reachedAt(order, 'picked_up') || now;
      minutesLeft = Math.max(3, ride - (nowMs - picked.getTime()) / MIN);
      break;
    }
    default:
      minutesLeft = prep + ride;
  }

  const earliest = roundUp5(new Date(nowMs + minutesLeft * MIN));
  return { earliest, latest: new Date(earliest.getTime() + s.windowMin * MIN) };
};

/**
 * How long an order from a store usually takes to arrive, before ordering:
 * store confirms + prep time for its category + rider accepts + rider reaches
 * the store + ride to the customer. Shown on store cards ("25–40 min").
 *   distanceKm — store to customer, or null when we don't know where they are
 */
const estimateForStore = (businessType, distanceKm = null) => {
  const s = settings();
  const prep = PREP_MINUTES()[businessType] ?? 20;
  const km = distanceKm ?? s.defaultKm;
  const ride = Math.max(5, Math.round((km / s.speedKmh) * 60));
  const total = s.confirmMin + prep + s.dispatchMin + s.toStoreMin + ride;
  const min = Math.max(10, Math.floor(total / 5) * 5);
  return { min, max: min + s.windowMin, estimated: distanceKm == null };
};

module.exports = { estimateDelivery, reachedAt, PREP_MINUTES, estimateForStore };
