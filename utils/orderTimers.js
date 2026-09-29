/**
 * Order timers: stop orders getting stuck at night.
 *
 *   1. Unpaid online orders   Not paid within PAYMENT_TIMEOUT_MINUTES (30) →
 *                             cancelled, so promo uses / rewards / personal
 *                             codes they were holding are given back.
 *   2. Store doesn't accept   Reminder SMS to the vendor after
 *                             VENDOR_REMIND_MINUTES (5); cancelled after
 *                             VENDOR_ACCEPT_TIMEOUT_MINUTES (10). Paid orders
 *                             are refunded automatically. The customer gets an
 *                             email (and SMS).
 *   3. Rider doesn't pick up  Each accepted job gets a pick-up deadline:
 *                             ride time to the store + RIDER_PICKUP_BUFFER_MINUTES
 *                             (10), between RIDER_PICKUP_MIN_MINUTES (15) and
 *                             RIDER_PICKUP_MAX_MINUTES (45). Warning SMS halfway;
 *                             at the deadline the job goes back to other riders —
 *                             unless the rider is already at the store (then the
 *                             wait is the store's fault, not theirs).
 *
 * A check runs every ORDER_TIMER_INTERVAL_SECONDS (60). Every change is an
 * atomic "only if still in this state" update, so a restart mid-check, a
 * second server, or a vendor tapping Accept at the same moment can never
 * cancel twice or release a job the rider just picked up.
 *
 * ORDER_TIMERS_ENABLED=false turns it all off. ORDER_TIMER_SMS=false stops the
 * SMS messages (emails and in-app still work).
 */
const mongoose = require('mongoose');
const Order = require('../models/orderModel');

const num = (name, fallback) => {
  const v = Number(process.env[name]);
  return process.env[name] !== undefined && process.env[name] !== '' && Number.isFinite(v) ? v : fallback;
};
const MIN = 60 * 1000;

const timerSettings = () => ({
  enabled: process.env.ORDER_TIMERS_ENABLED !== 'false',
  sms: process.env.ORDER_TIMER_SMS !== 'false',
  intervalSeconds: Math.max(15, num('ORDER_TIMER_INTERVAL_SECONDS', 60)),
  paymentTimeoutMin: num('PAYMENT_TIMEOUT_MINUTES', 30),
  vendorRemindMin: num('VENDOR_REMIND_MINUTES', 5),
  vendorAcceptMin: num('VENDOR_ACCEPT_TIMEOUT_MINUTES', 10),
  riderBufferMin: num('RIDER_PICKUP_BUFFER_MINUTES', 10),
  riderMinMin: num('RIDER_PICKUP_MIN_MINUTES', 15),
  riderMaxMin: num('RIDER_PICKUP_MAX_MINUTES', 45),
  speedKmh: num('ETA_RIDE_SPEED_KMH', 25),
  arrivalRadiusM: num('ARRIVAL_RADIUS_METERS', 150),
});

// ─── Deadlines ──────────────────────────────────────────────────────────────

/** When the store must have accepted by, counting from now. */
const acceptDeadlineFromNow = () => new Date(Date.now() + timerSettings().vendorAcceptMin * MIN);

const haversineKm = (a, b) => {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

const pointOf = (geo) =>
  geo?.coordinates?.length === 2 ? { longitude: geo.coordinates[0], latitude: geo.coordinates[1] } : null;

/** The rider's position if they reported it in the last 3 minutes. */
const freshRiderPoint = (rider) => {
  const fresh = rider?.locationUpdatedAt && Date.now() - new Date(rider.locationUpdatedAt).getTime() < 3 * MIN;
  return fresh ? pointOf(rider.coordinates) : null;
};

/**
 * Pick-up deadline for a rider who just accepted: their ride to the store
 * plus a buffer, kept between the min and max. Without a known location,
 * the minimum plus the buffer.
 */
const pickupDeadlineFor = (order, rider) => {
  const s = timerSettings();
  const from = freshRiderPoint(rider);
  const store = pointOf(order.pickupCoordinates);
  // Roads wind: straight-line distance × 1.4 is a fair city estimate.
  const rideMin = from && store ? ((haversineKm(from, store) * 1.4) / s.speedKmh) * 60 : s.riderMinMin;
  const minutes = Math.min(s.riderMaxMin, Math.max(s.riderMinMin, Math.round(rideMin + s.riderBufferMin)));
  return new Date(Date.now() + minutes * MIN);
};

/** Is the rider at the store right now? (then we never take the job off them) */
const riderIsAtStore = (order, rider) => {
  if (order.trip?.destination === 'store' && order.trip?.arrived) return true;
  const here = freshRiderPoint(rider);
  const store = pointOf(order.pickupCoordinates);
  return Boolean(here && store && haversineKm(here, store) * 1000 <= timerSettings().arrivalRadiusM + 50);
};

// ─── Cancelling (shared with the status route) ──────────────────────────────

/** Undo what an order took: rewards back to the customer, promo use and personal code back. */
const releaseOrderPerks = async (order) => {
  const User = require('../models/userModel');
  const Promotion = require('../models/promotionModel');
  const { refundRewards } = require('./rewards');
  if (order.customerId && (order.freeDeliveryUsed || order.deliveryCreditUsed > 0)) {
    await refundRewards(User, order.customerId, order);
  }
  if (order.promotionId) {
    await Promotion.updateOne({ _id: order.promotionId, timesUsed: { $gt: 0 } }, { $inc: { timesUsed: -1 } });
  }
  if (order.personalCodeId) {
    const PersonalCode = require('../models/personalCodeModel');
    await PersonalCode.updateOne({ _id: order.personalCodeId }, { $set: { usedAt: null, orderId: null } });
  }
};

const sms = async (phone, message) => {
  if (!phone || !timerSettings().sms || process.env.NODE_ENV === 'test') return;
  try {
    await require('./smsService').sendSms(phone, message);
  } catch (err) {
    console.error(`SMS to ${phone} failed:`, err.message);
  }
};

/** Tell the customer their order was cancelled (email if they have an account, plus SMS). */
const notifyCustomerCancelled = async (order, reason) => {
  const refund = order.paymentMethod === 'online' && order.paymentStatus === 'paid' ? order.totalPaid : 0;
  if (order.customerId && process.env.NODE_ENV !== 'test') {
    try {
      const User = require('../models/userModel');
      const user = await User.findById(order.customerId, 'email firstName');
      if (user?.email) {
        await require('./mailer').sendOrderCancelledEmail(user.email, user.firstName, {
          storeName: order.storeName,
          reason,
          refundAmount: refund,
        });
      }
    } catch (err) {
      console.error('Cancellation email failed:', err.message);
    }
  }
  await sms(
    order.customerPhone,
    `Nightcrawlers: sorry, your ${order.storeName} order was cancelled. ${reason}${refund ? ` Your ₦${refund.toLocaleString()} refund has started.` : " You weren't charged."}`
  );
};

/**
 * Cancel an order — but only if it's still in one of `fromStatuses` (so a
 * vendor accepting at the same instant wins). Gives back perks, refunds paid
 * online orders and (optionally) tells the customer.
 * Returns the cancelled order, or null if it had already moved on.
 */
const cancelOrder = async (orderId, { fromStatuses, by, reason, notify = true, extraFilter = {} }) => {
  const now = new Date();
  const order = await Order.findOneAndUpdate(
    { _id: orderId, status: { $in: fromStatuses }, ...extraFilter },
    {
      $set: { status: 'cancelled', cancelledAt: now, cancelledBy: by, cancelReason: reason.slice(0, 300), trip: null },
      $push: { statusHistory: { status: 'cancelled', at: now } },
    },
    { new: true }
  );
  if (!order) return null;
  await releaseOrderPerks(order);
  const { refundOrder, needsRefund } = require('./refunds');
  if (needsRefund(order)) await refundOrder(order, reason);
  if (notify) await notifyCustomerCancelled(order, reason);
  return order;
};

// ─── The checks ─────────────────────────────────────────────────────────────

const log = (...args) => console.log(`[${new Date().toISOString()}] ⏱`, ...args);

/** 1. Online orders nobody paid for. */
const expireUnpaid = async (now, s) => {
  const cutoff = new Date(now - s.paymentTimeoutMin * MIN);
  const stale = await Order.find(
    { status: 'pending', paymentMethod: 'online', paymentStatus: { $ne: 'paid' }, createdAt: { $lt: cutoff } },
    '_id'
  ).limit(100);
  for (const { _id } of stale) {
    const done = await cancelOrder(_id, {
      fromStatuses: ['pending'],
      by: 'system',
      reason: 'Payment was not completed.',
      notify: false, // they left without paying; no need to message them
    });
    if (done) log(`unpaid order ${_id} expired`);
  }
};

/** 2a. Nudge the store. */
const remindVendors = async (now, s) => {
  const remindAt = new Date(now + (s.vendorAcceptMin - s.vendorRemindMin) * MIN); // deadline within this → remind
  const due = await Order.find(
    { status: 'pending', acceptDeadline: { $ne: null, $lte: remindAt, $gt: new Date(now) }, vendorRemindedAt: null },
    '_id'
  ).limit(100);
  for (const { _id } of due) {
    const order = await Order.findOneAndUpdate(
      { _id, status: 'pending', vendorRemindedAt: null },
      { $set: { vendorRemindedAt: new Date() } },
      { new: true }
    );
    if (!order) continue;
    const Vendor = require('../models/vendorModel');
    const vendor = await Vendor.findById(order.vendorId, 'phoneNumber');
    const left = Math.max(1, Math.round((order.acceptDeadline - Date.now()) / MIN));
    await sms(
      vendor?.phoneNumber,
      `Nightcrawlers: new order at ${order.storeName} is waiting (₦${order.totalAmount.toLocaleString()}). Accept it in the next ${left} min or it will be cancelled.`
    );
    log(`reminded vendor about order ${_id}`);
  }
};

/** 2b. The store never accepted. */
const cancelUnaccepted = async (now) => {
  const late = await Order.find({ status: 'pending', acceptDeadline: { $ne: null, $lte: new Date(now) } }, '_id vendorId storeName').limit(100);
  for (const { _id, vendorId, storeName } of late) {
    const done = await cancelOrder(_id, {
      fromStatuses: ['pending'],
      by: 'system',
      reason: `${storeName} didn't respond in time.`,
    });
    if (!done) continue;
    log(`order ${_id} cancelled: store didn't accept in time`);
    const Vendor = require('../models/vendorModel');
    const vendor = await Vendor.findById(vendorId, 'phoneNumber');
    await sms(vendor?.phoneNumber, `Nightcrawlers: an order at ${storeName} was cancelled because it wasn't accepted in time. Keep the app open while you're taking orders.`);
  }
};

/** 3a. Warn riders halfway to their pick-up deadline. */
const warnRiders = async (now) => {
  const candidates = await Order.find(
    { status: 'accepted', pickupDeadline: { $ne: null, $gt: new Date(now) }, riderWarnedAt: null },
    '_id acceptedAt pickupDeadline riderId storeName trip pickupCoordinates'
  ).limit(200);
  const Rider = require('../models/riderModel');
  for (const o of candidates) {
    const start = new Date(o.acceptedAt || now).getTime();
    const halfway = start + (new Date(o.pickupDeadline).getTime() - start) / 2;
    if (now < halfway) continue;
    const rider = await Rider.findById(o.riderId, 'phoneNumber coordinates locationUpdatedAt');
    if (riderIsAtStore(o, rider)) continue;
    const claimed = await Order.updateOne({ _id: o._id, status: 'accepted', riderId: o.riderId, riderWarnedAt: null }, { $set: { riderWarnedAt: new Date() } });
    if (claimed.modifiedCount !== 1) continue;
    const left = Math.max(1, Math.round((new Date(o.pickupDeadline) - now) / MIN));
    await sms(rider?.phoneNumber, `Nightcrawlers: please pick up the ${o.storeName} order within ${left} min, or it will go to another rider.`);
  }
};

/** 3b. Deadline passed and the rider isn't at the store: give the job to someone else. */
const releaseLateRiders = async (now) => {
  const late = await Order.find(
    { status: 'accepted', pickupDeadline: { $ne: null, $lte: new Date(now) } },
    '_id riderId storeName trip pickupCoordinates pickupDeadline'
  ).limit(100);
  const Rider = require('../models/riderModel');
  for (const o of late) {
    const rider = await Rider.findById(o.riderId, 'phoneNumber coordinates locationUpdatedAt');
    if (riderIsAtStore(o, rider)) continue; // waiting at the store is not their fault
    const at = new Date();
    const released = await Order.updateOne(
      { _id: o._id, status: 'accepted', riderId: o.riderId },
      {
        $set: { status: 'ready', riderId: null, acceptedAt: null, pickupDeadline: null, riderWarnedAt: null, trip: null },
        $push: { statusHistory: { status: 'ready', at }, riderReleases: { riderId: o.riderId, at } },
      }
    );
    if (released.modifiedCount !== 1) continue;
    await Rider.updateOne({ _id: o.riderId }, { $inc: { releasedJobs: 1 } });
    log(`order ${o._id}: pick-up time ran out, released from rider ${o.riderId}`);
    await sms(rider?.phoneNumber, `Nightcrawlers: the ${o.storeName} pick-up time ran out, so the job has gone to another rider.`);
  }
};

let running = false;
/** One pass of every check. Exported for tests and for a manual run. */
const runOrderTimers = async () => {
  if (running || mongoose.connection.readyState !== 1) return;
  running = true;
  const now = Date.now();
  const s = timerSettings();
  try {
    await expireUnpaid(now, s);
    await remindVendors(now, s);
    await cancelUnaccepted(now);
    await warnRiders(now);
    await releaseLateRiders(now);
    // Running-late alerts (prep, no rider, stalled delivery) — utils/orderAlerts.js
    await require('./orderAlerts').runOrderAlerts(now);
    // Birthday codes (does real work at most once an hour) — utils/birthdays.js
    await require('./birthdays').runBirthdays().catch((err) => console.error('Birthday codes failed:', err.message));
  } catch (err) {
    console.error('Order timers failed (will try again next minute):', err.message);
  } finally {
    running = false;
  }
};

let timer = null;
const startOrderTimers = () => {
  const s = timerSettings();
  if (!s.enabled || timer || process.env.NODE_ENV === 'test') return;
  timer = setInterval(runOrderTimers, s.intervalSeconds * 1000);
  timer.unref();
  console.log(
    `⏱  Order timers on: store accepts within ${s.vendorAcceptMin} min (reminder at ${s.vendorRemindMin}), ` +
      `riders pick up within ${s.riderMinMin}–${s.riderMaxMin} min, unpaid orders expire after ${s.paymentTimeoutMin} min`
  );
};

module.exports = {
  timerSettings,
  acceptDeadlineFromNow,
  pickupDeadlineFor,
  riderIsAtStore,
  releaseOrderPerks,
  cancelOrder,
  notifyCustomerCancelled,
  runOrderTimers,
  startOrderTimers,
};
