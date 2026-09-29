/**
 * Alerts for orders that are running late. Unlike the timers in
 * orderTimers.js, these never cancel or take anything away. They tell the
 * right person so a human can sort it out.
 *
 *   Stage 2 — food taking too long (status 'preparing')
 *     usual prep time for the store's category (ETA_PREP_*) + PREP_LATE_GRACE_MINUTES (10)
 *       → SMS the vendor, SMS the customer, tracking page says "running late"
 *     + PREP_ESCALATE_MINUTES (30) past the usual prep time
 *       → alert the Nightcrawlers team (email + SMS)
 *
 *   Stage 3 — food ready, no rider has taken it (status 'ready')
 *     RIDER_SEARCH_PING_MINUTES (5)       → SMS up to RIDER_PING_MAX (10) online, free riders
 *                                           within RIDER_PING_RADIUS_KM (10) of the store
 *     RIDER_SEARCH_ADMIN_MINUTES (10)     → alert the team
 *     RIDER_SEARCH_CUSTOMER_MINUTES (20)  → customer may cancel for a full refund
 *
 *   Stage 5 — picked up, delivery stalled (status 'picked_up' / 'in_transit')
 *     no rider location for DELIVERY_NO_SIGNAL_MINUTES (10), or
 *     DELIVERY_OVERDUE_MINUTES (20) past the expected arrival
 *       → alert the team with the rider's and customer's numbers and the last
 *         known location. Never reassigned: the food is with that rider, and at
 *         night it may be a safety matter.
 *
 * Team alerts go to ADMIN_ALERT_EMAIL (or CONTACT_INBOX) and, if set, an SMS to
 * ADMIN_ALERT_PHONE. Every alert is raised once per order (atomic), so running
 * the check again, or on two servers, never sends duplicates.
 */
const Order = require('../models/orderModel');
const { reachedAt, PREP_MINUTES } = require('./orderEta');

const num = (name, fallback) => {
  const v = Number(process.env[name]);
  return process.env[name] !== undefined && process.env[name] !== '' && Number.isFinite(v) ? v : fallback;
};
const MIN = 60 * 1000;

const alertSettings = () => ({
  prepGraceMin: num('PREP_LATE_GRACE_MINUTES', 10),
  prepEscalateMin: num('PREP_ESCALATE_MINUTES', 30),
  riderPingMin: num('RIDER_SEARCH_PING_MINUTES', 5),
  riderAdminMin: num('RIDER_SEARCH_ADMIN_MINUTES', 10),
  riderCustomerMin: num('RIDER_SEARCH_CUSTOMER_MINUTES', 20),
  pingRadiusKm: num('RIDER_PING_RADIUS_KM', 10),
  pingMax: num('RIDER_PING_MAX', 10),
  noSignalMin: num('DELIVERY_NO_SIGNAL_MINUTES', 10),
  overdueMin: num('DELIVERY_OVERDUE_MINUTES', 20),
  speedKmh: num('ETA_RIDE_SPEED_KMH', 25),
  defaultKm: num('ETA_DEFAULT_KM', 5),
});

/** Types the team needs to act on (the rest are handled automatically). */
const TEAM_ALERT_TYPES = ['prep_very_late', 'no_rider_admin', 'delivery_stalled', 'cancelled_after_ready'];

const sms = async (phone, message) => {
  if (!phone || process.env.ORDER_TIMER_SMS === 'false' || process.env.NODE_ENV === 'test') return;
  try {
    await require('./smsService').sendSms(phone, message);
  } catch (err) {
    console.error(`SMS to ${phone} failed:`, err.message);
  }
};

/** Tell the team: email, plus SMS if ADMIN_ALERT_PHONE is set. */
const notifyTeam = async ({ subject, lines, orderId }) => {
  if (process.env.NODE_ENV === 'test') return;
  try {
    await require('./mailer').sendAdminAlertEmail({ subject, lines, orderId });
  } catch (err) {
    console.error('Alert email failed:', err.message);
  }
  await sms(process.env.ADMIN_ALERT_PHONE, `Nightcrawlers alert: ${subject}. ${lines[0] || ''}`.slice(0, 300));
};

/**
 * Record an alert on an order, once. `stillIf` is extra conditions the order
 * must still meet (e.g. still 'preparing'). Returns true only for the call
 * that actually recorded it — that call sends the messages.
 */
const raiseAlert = async (orderId, type, message, stillIf = {}) => {
  const res = await Order.updateOne(
    { _id: orderId, ...stillIf, 'alerts.type': { $ne: type } },
    { $push: { alerts: { type, message, at: new Date() } } }
  );
  if (res.modifiedCount === 1) console.log(`[${new Date().toISOString()}] 🔔 ${type} on order ${orderId}: ${message}`);
  return res.modifiedCount === 1;
};

const has = (order, type) => (order.alerts || []).some((a) => a.type === type);
const firstReachedAt = (order, status) => {
  const h = (order.statusHistory || []).find((e) => e.status === status);
  return h ? new Date(h.at) : reachedAt(order, status);
};
const mapsLink = (lat, lng) => `https://maps.google.com/?q=${lat},${lng}`;
const phoneOf = async (Model, id) => (id ? (await Model.findById(id, 'phoneNumber firstName lastName'))?.toObject() : null);

// ─── Stage 2: preparing for too long ────────────────────────────────────────
const checkPreparing = async (now, s) => {
  const orders = await Order.find(
    { status: 'preparing' },
    '_id storeId vendorId storeName customerPhone customerName statusHistory alerts createdAt'
  ).limit(300);
  if (!orders.length) return;
  const Store = require('../models/storeModel');
  const Vendor = require('../models/vendorModel');
  const types = new Map(
    (await Store.find({ _id: { $in: orders.map((o) => o.storeId) } }, 'businessType')).map((st) => [String(st._id), st.businessType])
  );
  for (const o of orders) {
    const started = reachedAt(o, 'preparing');
    if (!started) continue;
    const prep = PREP_MINUTES()[types.get(String(o.storeId))] ?? 20;
    const minutesIn = (now - started.getTime()) / MIN;

    if (minutesIn >= prep + s.prepGraceMin && !has(o, 'prep_late')) {
      if (await raiseAlert(o._id, 'prep_late', `Preparing for ${Math.round(minutesIn)} min (usual ${prep})`, { status: 'preparing' })) {
        const vendor = await phoneOf(Vendor, o.vendorId);
        await sms(vendor?.phoneNumber, `Nightcrawlers: the order for ${o.customerName} at ${o.storeName} has been preparing for ${Math.round(minutesIn)} min. Please tap "Mark as Ready" as soon as it's packed.`);
        await sms(o.customerPhone, `Nightcrawlers: ${o.storeName} is taking a little longer than usual with your order. We're on it and will keep you posted.`);
      }
    }
    if (minutesIn >= prep + s.prepEscalateMin && !has(o, 'prep_very_late')) {
      if (await raiseAlert(o._id, 'prep_very_late', `Still preparing after ${Math.round(minutesIn)} min`, { status: 'preparing' })) {
        const vendor = await phoneOf(Vendor, o.vendorId);
        await notifyTeam({
          subject: `${o.storeName} is ${Math.round(minutesIn - prep)} min late preparing an order`,
          lines: [
            `Preparing for ${Math.round(minutesIn)} min; usual for this store type is ${prep}.`,
            `Store: ${o.storeName}${vendor?.phoneNumber ? `, ${vendor.phoneNumber}` : ''}`,
            `Customer: ${o.customerName}, ${o.customerPhone}`,
          ],
          orderId: o._id,
        });
      }
    }
  }
};

// ─── Stage 3: ready, no rider ───────────────────────────────────────────────
const pingNearbyRiders = async (o, s) => {
  try {
    return await pingNearbyRidersUnsafe(o, s);
  } catch (err) {
    console.error('Pinging riders failed:', err.message);
    return 0;
  }
};
const pingNearbyRidersUnsafe = async (o, s) => {
  const Rider = require('../models/riderModel');
  const busy = await Order.distinct('riderId', { status: { $in: ['accepted', 'picked_up', 'in_transit'] }, riderId: { $ne: null } });
  const exclude = [...busy, ...(o.riderReleases || []).map((r) => r.riderId)];
  const fresh = new Date(Date.now() - 15 * MIN);
  const filter = { isOnline: true, verified: true, _id: { $nin: exclude }, locationUpdatedAt: { $gte: fresh } };
  let riders;
  const store = o.pickupCoordinates?.coordinates;
  if (store?.length === 2) {
    riders = await Rider.find({
      ...filter,
      coordinates: { $near: { $geometry: { type: 'Point', coordinates: store }, $maxDistance: s.pingRadiusKm * 1000 } },
    }, 'phoneNumber').limit(s.pingMax);
  } else {
    riders = await Rider.find(filter, 'phoneNumber').limit(s.pingMax);
  }
  for (const r of riders) {
    await sms(r.phoneNumber, `Nightcrawlers: a job is waiting at ${o.storeName} (₦${(o.deliveryFee || 0).toLocaleString()} delivery). Open the app to accept it.`);
  }
  return riders.length;
};

const checkReady = async (now, s) => {
  const orders = await Order.find(
    { status: 'ready', riderId: null },
    '_id storeName customerName customerPhone customerId pickupCoordinates deliveryFee statusHistory alerts riderReleases vendorId'
  ).limit(300);
  for (const o of orders) {
    const lastReady = reachedAt(o, 'ready');
    const firstReady = firstReachedAt(o, 'ready');
    if (!lastReady || !firstReady) continue;
    const sinceLast = (now - lastReady.getTime()) / MIN;
    const sinceFirst = (now - firstReady.getTime()) / MIN;
    const still = { status: 'ready', riderId: null };

    if (sinceLast >= s.riderPingMin && !has(o, 'no_rider')) {
      if (await raiseAlert(o._id, 'no_rider', `No rider after ${Math.round(sinceLast)} min`, still)) {
        const n = await pingNearbyRiders(o, s);
        await Order.updateOne(
          { _id: o._id, 'alerts.type': 'no_rider' },
          { $set: { 'alerts.$.message': `No rider after ${Math.round(sinceLast)} min; ${n} nearby rider${n === 1 ? '' : 's'} messaged` } }
        );
      }
    }
    if (sinceFirst >= s.riderAdminMin && !has(o, 'no_rider_admin')) {
      if (await raiseAlert(o._id, 'no_rider_admin', `Ready for ${Math.round(sinceFirst)} min with no rider`, still)) {
        await notifyTeam({
          subject: `No rider for ${o.storeName} order after ${Math.round(sinceFirst)} min`,
          lines: [
            'The food is ready and waiting at the store. Nearby online riders were already messaged.',
            `Customer: ${o.customerName}, ${o.customerPhone}`,
          ],
          orderId: o._id,
        });
      }
    }
    if (sinceFirst >= s.riderCustomerMin && !has(o, 'no_rider_customer')) {
      if (await raiseAlert(o._id, 'no_rider_customer', 'Customer offered: keep waiting or cancel', still)) {
        const link = `${(process.env.FRONTEND_URL || '').split(',')[0].trim().replace(/\/$/, '')}/orders/${o._id}`;
        await sms(
          o.customerPhone,
          `Nightcrawlers: sorry, we're still finding a rider for your ${o.storeName} order. You can keep waiting, or cancel for a full refund: ${link}`
        );
      }
    }
  }
};

// ─── Stage 5: delivery stalled after pick-up ────────────────────────────────
const checkDelivering = async (now, s) => {
  const orders = await Order.find(
    { status: { $in: ['picked_up', 'in_transit'] } },
    '_id riderId storeName customerName customerPhone customerAddress deliveryDistanceKm statusHistory pickedUpAt alerts trip'
  ).limit(300);
  const Rider = require('../models/riderModel');
  for (const o of orders) {
    if (has(o, 'delivery_stalled')) continue;
    const picked = reachedAt(o, 'picked_up');
    if (!picked) continue;
    const minutesSince = (now - picked.getTime()) / MIN;
    const km = o.deliveryDistanceKm ?? s.defaultKm;
    const rideMin = Math.max(5, Math.round((km / s.speedKmh) * 60));
    const rider = await Rider.findById(o.riderId, 'firstName lastName phoneNumber coordinates locationUpdatedAt');
    const lastSeen = rider?.locationUpdatedAt ? new Date(rider.locationUpdatedAt) : null;
    const silentMin = lastSeen ? (now - lastSeen.getTime()) / MIN : minutesSince;

    let reason = null;
    if (minutesSince >= s.noSignalMin && silentMin >= s.noSignalMin) {
      reason = `No location from the rider for ${Math.round(silentMin)} min`;
    } else if (minutesSince >= rideMin + s.overdueMin) {
      reason = `${Math.round(minutesSince - rideMin)} min past the expected arrival`;
    }
    if (!reason) continue;
    if (!(await raiseAlert(o._id, 'delivery_stalled', reason, { status: { $in: ['picked_up', 'in_transit'] } }))) continue;

    const pos = rider?.coordinates?.coordinates;
    await notifyTeam({
      subject: `Delivery may be stalled: ${o.storeName} → ${o.customerName}`,
      lines: [
        `${reason}. Picked up ${Math.round(minutesSince)} min ago (expected ride ~${rideMin} min).`,
        `Rider: ${rider ? `${rider.firstName} ${rider.lastName || ''}`.trim() : 'unknown'}${rider?.phoneNumber ? `, ${rider.phoneNumber}` : ''}`,
        `Customer: ${o.customerName}, ${o.customerPhone}, ${o.customerAddress}`,
        pos?.length === 2 ? `Last known rider location${lastSeen ? ` (${Math.round(silentMin)} min ago)` : ''}: ${mapsLink(pos[1], pos[0])}` : 'No rider location on record.',
      ],
      orderId: o._id,
    });
  }
};

/** One pass of every alert check (called by the order timer loop). */
const runOrderAlerts = async (now = Date.now()) => {
  const s = alertSettings();
  // Each stage on its own, so a problem in one never stops the others.
  for (const [name, check] of [['prep', checkPreparing], ['rider', checkReady], ['delivery', checkDelivering]]) {
    try {
      await check(now, s);
    } catch (err) {
      console.error(`Order alerts (${name}) failed, will retry next minute:`, err.message);
    }
  }
};

/**
 * What the customer should see on the tracking page. canCancel: they may
 * cancel themselves (before the store accepts, or after a long rider search).
 */
const customerView = (order) => ({
  prepLate: order.status === 'preparing' && has(order, 'prep_late'),
  findingRider: order.status === 'ready' && !order.riderId && has(order, 'no_rider'),
  deliveryDelayed: ['picked_up', 'in_transit'].includes(order.status) && has(order, 'delivery_stalled'),
  canCancel: order.status === 'pending' || (order.status === 'ready' && !order.riderId && has(order, 'no_rider_customer')),
});

module.exports = { alertSettings, runOrderAlerts, raiseAlert, notifyTeam, customerView, TEAM_ALERT_TYPES };
