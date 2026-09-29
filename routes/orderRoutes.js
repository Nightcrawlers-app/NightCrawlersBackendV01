const express = require('express');
const router = express.Router();
const Order = require('../models/orderModel');
const Store = require('../models/storeModel');
const { priceOrder, PricingError } = require('../utils/orderPricing');
const { phoneVerificationRequired } = require('../utils/settings');
const { estimateDelivery, reachedAt } = require('../utils/orderEta');
const { arrivalCheck } = require('../utils/tripProgress');
const { haversineKm } = require('../utils/deliveryFee');
const { protect, requireRole, optionalAuth } = require('../middlewares/auth');
const { geocodeAddress, readLatLng, toPoint, fromPoint } = require('../utils/geocoder');
const { deliveryFeeFor } = require('../utils/deliveryFee');
const { spendRewards, refundRewards, onOrderDelivered } = require('../utils/rewards');
const Promotion = require('../models/promotionModel');

/** The signed-in customer (User doc), or null for guests / other roles. */
const customerFor = async (req) => {
  if (req.user?.role !== 'customer') return null;
  const User = require('../models/userModel');
  return User.findById(req.user.id);
};

/** Customer notes: plain text, trimmed, 300 characters max. */
const cleanNote = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);

// Undo what an order took (rewards, promo use, personal code) — shared with the order timers.
const { releaseOrderPerks, acceptDeadlineFromNow, pickupDeadlineFor } = require('../utils/orderTimers');
const { refundOrder, needsRefund } = require('../utils/refunds');

// GET /api/orders/delivery-estimate?storeId=…&lat=…&lng=… — the delivery
// ("ride") fee from a store to a point, for the store page before checkout.
// Same formula checkout uses. Without lat/lng: the flat fallback fee.
router.get('/delivery-estimate', async (req, res) => {
  try {
    const { storeId } = req.query;
    if (!require('mongoose').isValidObjectId(storeId)) return res.status(404).json({ message: 'Store not found' });
    const store = await Store.findById(storeId, 'coordinates name');
    if (!store) return res.status(404).json({ message: 'Store not found' });
    const storePoint = store.coordinates?.coordinates?.length === 2 ? fromPoint(store.coordinates) : null;
    const to = readLatLng(req.query);
    const { fee, distanceKm, tooFar, maxKm } = deliveryFeeFor(storePoint, to);
    res.json({ fee, distanceKm, tooFar, maxKm, estimated: !(storePoint && to) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/orders/quote — { storeId, items: [{ menuItemId, quantity }], promotionId?, promoCode?, useRewards? }
// The exact breakdown checkout should show. Same maths as placing the order.
router.post('/quote', optionalAuth, async (req, res) => {
  try {
    const { storeId, items, promotionId, promoCode } = req.body;
    if (!require('mongoose').isValidObjectId(storeId)) return res.status(404).json({ message: 'Store not found' });
    const store = await Store.findById(storeId);
    if (!store) return res.status(404).json({ message: 'Store not found' });

    // Where it's going decides the delivery fee: map pin if sent, else the address.
    const deliveryPoint =
      readLatLng({ lat: req.body.customerLatitude, lng: req.body.customerLongitude }) ||
      (req.body.customerAddress ? await geocodeAddress(req.body.customerAddress) : null);

    const priced = await priceOrder({
      store,
      items,
      promotionId,
      promoCode,
      deliveryPoint,
      strictPromo: false,
      customer: await customerFor(req),
      useRewards: req.body.useRewards !== false,
    });
    for (const k of ['promo', 'personalCode', 'vendorEarning', 'riderEarning', 'platformEarning']) delete priced[k];
    res.json(priced);
  } catch (err) {
    if (err instanceof PricingError) return res.status(400).json({ message: err.message, ...err.extra });
    res.status(500).json({ message: err.message });
  }
});

// POST /api/orders — create a new order (customer, or guest checkout)
router.post('/', optionalAuth, async (req, res) => {
  try {
    // ── Phone verification gate (logged-in customers only) ──────────────
    if (req.user?.role === 'customer' && phoneVerificationRequired()) {
      const User = require('../models/userModel');
      const user = await User.findById(req.user.id);
      if (user && !user.phoneVerified) {
        return res.status(403).json({
          message: 'Please verify your phone number or login before placing an order.',
          needsPhoneVerification: true,
        });
      }
    }
    const {
      storeId,
      storeName,
      customerName,
      customerPhone,
      customerLocation,
      customerAddress,
      items,
    } = req.body;

    if (!storeId || !customerName || !customerPhone || !customerAddress || !items?.length) {
      return res.status(400).json({ message: 'Missing required order fields.' });
    }

    if (!require('mongoose').isValidObjectId(storeId)) {
      return res.status(404).json({ message: 'Store not found' });
    }
    const store = await Store.findById(storeId);
    if (!store) return res.status(404).json({ message: 'Store not found' });

    const paymentMethod = req.body.paymentMethod || 'cash_on_delivery';
    if (!['cash_on_delivery', 'card_on_delivery', 'online'].includes(paymentMethod)) {
      return res.status(400).json({ message: 'Unknown payment method.' });
    }
    if (paymentMethod === 'online') {
      if (!require('../utils/settings').onlinePaymentsEnabled()) {
        return res.status(400).json({ message: 'Online payment is not available right now.' });
      }
      if (req.user?.role !== 'customer') {
        return res.status(400).json({ message: 'Please sign in to pay online.' });
      }
    }

    // Delivery point: GPS/pin from checkout if sent, else geocode the address.
    let delivery = readLatLng({ lat: req.body.customerLatitude, lng: req.body.customerLongitude });
    if (!delivery) delivery = await geocodeAddress(customerAddress);

    // All money is worked out on the server — see utils/orderPricing.js.
    const customer = await customerFor(req);
    let priced;
    try {
      priced = await priceOrder({
        store,
        items,
        promotionId: req.body.promotionId,
        promoCode: req.body.promoCode,
        deliveryPoint: delivery,
        strictPromo: true,
        customer,
        useRewards: req.body.useRewards !== false,
      });
    } catch (err) {
      if (err instanceof PricingError) return res.status(400).json({ message: err.message, ...err.extra });
      throw err;
    }

    // Claim a use of a limited promo — atomically, so the last slot can't go twice.
    if (priced.promo) {
      const claim = priced.promo.usageLimit
        ? { _id: priced.promo._id, timesUsed: { $lt: priced.promo.usageLimit } }
        : { _id: priced.promo._id };
      const claimed = await Promotion.updateOne(claim, { $inc: { timesUsed: 1 } });
      if (claimed.modifiedCount !== 1) {
        return res.status(400).json({ message: 'This promo has just been fully used up.', promotionInvalid: true });
      }
    }
    // A personal (campaign) code is single-use: claim it the same way.
    const PersonalCode = require('../models/personalCodeModel');
    if (priced.personalCode) {
      const took = await PersonalCode.updateOne({ _id: priced.personalCode._id, usedAt: null }, { $set: { usedAt: new Date() } });
      if (took.modifiedCount !== 1) {
        await Promotion.updateOne({ _id: priced.promo._id }, { $inc: { timesUsed: -1 } });
        return res.status(400).json({ message: "You've already used this code.", promotionInvalid: true });
      }
    }
    // Spend rewards the same way; if the balance moved since the quote, ask them to re-check.
    const User = require('../models/userModel');
    if (customer && !(await spendRewards(User, customer._id, priced.rewards))) {
      await releaseOrderPerks({ promotionId: priced.promo?._id, personalCodeId: priced.personalCode?._id });
      return res.status(409).json({ message: 'Your rewards balance changed. Please check your total and try again.', rewardsChanged: true });
    }

    const pickup = store.coordinates?.coordinates?.length === 2 ? store.coordinates : undefined;

    let order;
    try {
      order = await Order.create({
        storeId,
        storeName: storeName || store.name,
        vendorId: store.vendorId,
        customerId: req.user?.role === 'customer' ? req.user.id : null,
        customerName,
        customerPhone,
        customerLocation: customerLocation || delivery?.city || '',
        customerAddress,
        items: priced.items,
        totalAmount: priced.subtotal, // food subtotal (kept as totalAmount for existing reports)
        deliveryFee: priced.deliveryFee,
        deliveryDistanceKm: priced.distanceKm,
        serviceFee: priced.serviceFee,
        totalPaid: priced.total,      // what the customer pays
        vendorEarning: priced.vendorEarning,
        riderEarning: priced.riderEarning,
        platformEarning: priced.platformEarning,
        paymentMethod,
        paymentStatus: paymentMethod === 'online' ? 'pending' : 'not_required',
        // Pay-on-delivery orders go to the store now, so its clock starts now.
        // Online orders start theirs when payment arrives (paymentRoutes).
        acceptDeadline: paymentMethod === 'online' ? null : acceptDeadlineFromNow(),
        statusHistory: [{ status: 'pending', at: new Date() }],
        status: 'pending',
        ...(pickup && { pickupCoordinates: pickup }),
        ...(priced.promo && {
          promotionId: priced.promo._id,
          promotionTitle: priced.promo.title,
          discountAmount: priced.discount,
          discountFundedBy: priced.promo.fundedBy,
          promoCode: priced.personalCode?.code || priced.promo.code || null,
          personalCodeId: priced.personalCode?._id || null,
        }),
        rewardDiscount: priced.rewardDiscount,
        freeDeliveryUsed: priced.rewards.freeDeliveryUsed,
        deliveryCreditUsed: priced.rewards.deliveryCreditUsed,
        noteForVendor: cleanNote(req.body.noteForVendor),
        noteForRider: cleanNote(req.body.noteForRider),
        ...(delivery && { deliveryCoordinates: toPoint(delivery) }),
      });
    } catch (err) {
      // Nothing was ordered — give back what we took above.
      await releaseOrderPerks({
        customerId: customer?._id,
        freeDeliveryUsed: priced.rewards.freeDeliveryUsed,
        deliveryCreditUsed: priced.rewards.deliveryCreditUsed,
        promotionId: priced.promo?._id,
        personalCodeId: priced.personalCode?._id,
      });
      throw err;
    }
    if (priced.personalCode) {
      await PersonalCode.updateOne({ _id: priced.personalCode._id }, { $set: { orderId: order._id } });
    }

    res.status(201).json(order);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/orders/pending?lat=..&lng=..&location=.. — ready orders for riders.
// With coordinates: nearest pickup first, within `radius` metres (default 15km).
// Without: falls back to matching the location text. Must stay above /:id.
const listPendingForRider = async (req, res) => {
  try {
    const { location, radius } = req.query;
    const query = {
      status: 'ready',
      riderId: null,
      // Not jobs this rider already let run out
      'riderReleases.riderId': { $ne: new (require('mongoose').Types.ObjectId)(String(req.user.id)) },
    };
    const point = readLatLng(req.query);

    if (point) {
      const maxDistance = Math.min(parseInt(radius, 10) || 15000, 50000);
      const near = await Order.aggregate([
        {
          $geoNear: {
            near: { type: 'Point', coordinates: [point.longitude, point.latitude] },
            distanceField: 'distanceMeters',
            maxDistance,
            spherical: true,
            query,
          },
        },
      ]);
      // Orders whose store has no coordinates can't be ranked — list them after.
      const unlocated = await Order.find({ ...query, pickupCoordinates: { $exists: false } })
        .sort({ createdAt: 1 })
        .lean();
      return res.json([
        ...near.map(({ distanceMeters, ...o }) => ({
          ...o,
          id: String(o._id),
          distance: Math.round((distanceMeters / 1000) * 10) / 10,
        })),
        ...unlocated.map((o) => ({ ...o, id: String(o._id), distance: null })),
      ]);
    }

    if (location) {
      const escaped = String(location).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.customerLocation = { $regex: escaped, $options: 'i' };
    }
    const orders = await Order.find(query).sort({ createdAt: 1 });
    res.json(orders);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

router.get('/pending', protect, requireRole('rider'), listPendingForRider);

// GET /api/orders/:id
router.get('/:id', protect, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found' });

    const { role, id } = req.user;
    const isOwner =
      (role === 'customer' && String(order.customerId) === String(id)) ||
      (role === 'vendor' && String(order.vendorId) === String(id)) ||
      (role === 'rider' && String(order.riderId) === String(id)) ||
      role === 'admin';

    if (!isOwner) return res.status(403).json({ message: 'Forbidden' });
    res.json(order);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/orders/:id/track — the customer's live view of their order:
// status timeline, delivery time window, rider details once assigned.
router.get('/:id/track', protect, async (req, res) => {
  try {
    if (!require('mongoose').isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Order not found' });
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found' });

    const { role, id } = req.user;
    const allowed =
      (role === 'customer' && String(order.customerId) === String(id)) ||
      (role === 'vendor' && String(order.vendorId) === String(id)) ||
      (role === 'rider' && String(order.riderId) === String(id)) ||
      role === 'admin';
    if (!allowed) return res.status(403).json({ message: 'Forbidden' });

    const store = await Store.findById(order.storeId, 'name address businessType');
    let eta = estimateDelivery(order, { businessType: store?.businessType });

    // On the way to the customer with a fresh route: use the real road time.
    const trip = order.trip;
    const tripFresh = trip?.updatedAt && Date.now() - new Date(trip.updatedAt).getTime() < 3 * 60 * 1000;
    if (tripFresh && trip.destination === 'customer') {
      const earliest = new Date(Date.now() + trip.durationMin * 60 * 1000);
      eta = { earliest, latest: new Date(earliest.getTime() + 5 * 60 * 1000) };
    }

    // Rider details only once someone has accepted it — and only what the
    // customer needs: first name, vehicle, phone, and how far away they are.
    let rider = null;
    if (order.riderId) {
      const Rider = require('../models/riderModel');
      const r = await Rider.findById(order.riderId, 'firstName vehicleType phoneNumber coordinates locationUpdatedAt');
      if (r) {
        const delivery = order.deliveryCoordinates?.coordinates?.length === 2 ? fromPoint(order.deliveryCoordinates) : null;
        const riderPos = r.coordinates?.coordinates?.length === 2 ? fromPoint(r.coordinates) : null;
        const fresh = r.locationUpdatedAt && Date.now() - new Date(r.locationUpdatedAt).getTime() < 10 * 60 * 1000;
        rider = {
          firstName: r.firstName,
          vehicleType: r.vehicleType,
          phoneNumber: ['accepted', 'picked_up', 'in_transit'].includes(order.status) ? r.phoneNumber : null,
          distanceKm:
            delivery && riderPos && fresh ? Math.round(haversineKm(riderPos, delivery) * 1.3 * 10) / 10 : null,
        };
      }
    }

    const at = (s) => reachedAt(order, s);
    res.json({
      id: String(order._id),
      status: order.status,
      paymentMethod: order.paymentMethod,
      paymentStatus: order.paymentStatus,
      placedAt: order.createdAt,
      // Why it was cancelled, and where the refund is (online orders)
      cancelReason: order.status === 'cancelled' ? order.cancelReason || '' : '',
      cancelledBy: order.status === 'cancelled' ? order.cancelledBy : null,
      refundStatus: order.refundStatus || 'none',
      refundAmount: order.refundAmount || 0,
      acceptDeadline: order.status === 'pending' ? order.acceptDeadline : null,
      // Running late / can cancel (utils/orderAlerts.js)
      delays: require('../utils/orderAlerts').customerView(order),
      steps: {
        placed: order.createdAt,
        confirmed: at('preparing'),
        ready: at('ready'),
        pickedUp: at('picked_up'),
        delivered: at('delivered'),
        cancelled: at('cancelled'),
      },
      eta: eta && { earliest: eta.earliest, latest: eta.latest },
      // Live trip for the map: where the rider is, the road route, time/distance left
      trip:
        tripFresh && ['accepted', 'picked_up', 'in_transit'].includes(order.status)
          ? {
              destination: trip.destination,
              distanceKm: trip.distanceKm,
              durationMin: trip.durationMin,
              line: trip.line,
              riderLocation: { latitude: trip.riderLocation.latitude, longitude: trip.riderLocation.longitude },
              arrived: trip.arrived,
              updatedAt: trip.updatedAt,
            }
          : null,
      pickupPoint: order.pickupCoordinates?.coordinates?.length === 2 ? fromPoint(order.pickupCoordinates) : null,
      deliveryPoint: order.deliveryCoordinates?.coordinates?.length === 2 ? fromPoint(order.deliveryCoordinates) : null,
      store: store && { name: store.name, address: store.address, businessType: store.businessType },
      rider,
      deliveryAddress: order.customerAddress,
      items: order.items.map((i) => ({ name: i.name, quantity: i.quantity, price: i.price })),
      subtotal: order.totalAmount,
      deliveryFee: order.deliveryFee,
      serviceFee: order.serviceFee,
      discount: order.discountAmount || 0,
      rewardDiscount: order.rewardDiscount || 0,
      noteForVendor: order.noteForVendor || '',
      noteForRider: order.noteForRider || '',
      total: order.totalPaid ?? order.totalAmount + order.deliveryFee,
      serverTime: new Date(),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Old path, kept so existing clients don't break.
router.get('/pending/list', protect, requireRole('rider'), listPendingForRider);

// POST /api/orders/:id/cancel — the customer cancels their own order.
// Allowed before the store accepts it, or after a long wait for a rider
// (utils/orderAlerts.js offers it). Paid orders are refunded in full.
router.post('/:id/cancel', protect, requireRole('customer'), async (req, res) => {
  try {
    if (!require('mongoose').isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Order not found' });
    const order = await Order.findById(req.params.id);
    if (!order || String(order.customerId) !== String(req.user.id)) return res.status(404).json({ message: 'Order not found' });

    const { customerView, raiseAlert, notifyTeam } = require('../utils/orderAlerts');
    if (!customerView(order).canCancel) {
      return res.status(400).json({
        message:
          order.status === 'cancelled'
            ? 'This order is already cancelled.'
            : "This order can't be cancelled now — the store is already working on it. Contact us if something's wrong.",
      });
    }

    const { cancelOrder } = require('../utils/orderTimers');
    const afterReady = order.status === 'ready';
    const cancelled = await cancelOrder(order._id, {
      fromStatuses: [order.status],
      extraFilter: afterReady ? { riderId: null } : {},
      by: 'customer',
      reason: afterReady ? 'You cancelled because no rider was available.' : 'You cancelled the order.',
      notify: false, // they did it themselves; the screen tells them about the refund
    });
    if (!cancelled) {
      return res.status(409).json({ message: 'Your order just moved on (the store accepted it or a rider took it), so it can no longer be cancelled here.' });
    }

    // Food was already made: the vendor shouldn't lose out. Flag it for the team.
    if (afterReady) {
      const Vendor = require('../models/vendorModel');
      const vendor = await Vendor.findById(cancelled.vendorId, 'phoneNumber');
      if (process.env.NODE_ENV !== 'test' && vendor?.phoneNumber) {
        require('../utils/smsService')
          .sendSms(vendor.phoneNumber, `Nightcrawlers: the ${cancelled.storeName} order for ${cancelled.customerName} was cancelled because no rider was found. Our team will contact you about the food you prepared.`)
          .catch(() => {});
      }
      if (await raiseAlert(cancelled._id, 'cancelled_after_ready', 'Customer cancelled after food was ready (no rider). Vendor may need paying.')) {
        notifyTeam({
          subject: `Order cancelled after the food was ready: ${cancelled.storeName}`,
          lines: [
            'No rider took it, so the customer cancelled and was refunded.',
            `The vendor made the food (₦${cancelled.totalAmount.toLocaleString()}). Decide whether to pay them.`,
          ],
          orderId: cancelled._id,
        }).catch(() => {});
      }
    }
    const fresh = await Order.findById(cancelled._id);
    res.json(fresh);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/orders/:id/accept — rider accepts an order
router.post('/:id/accept', protect, requireRole('rider'), async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found' });

    if (order.riderId) {
      return res.status(409).json({ message: 'Order already accepted by another rider.' });
    }
    if (order.status !== 'ready') {
      return res.status(400).json({ message: 'Order is not ready for pickup yet.' });
    }
    if ((order.riderReleases || []).some((r) => String(r.riderId) === String(req.user.id))) {
      return res.status(400).json({ message: "Your pick-up time ran out on this order, so it's gone to another rider." });
    }

    // Pick-up deadline: their ride to the store plus a buffer (utils/orderTimers.js)
    const Rider = require('../models/riderModel');
    const rider = await Rider.findById(req.user.id, 'coordinates locationUpdatedAt');
    const acceptedAt = new Date();
    // Atomic, so two riders tapping Accept at once can't both get it.
    const taken = await Order.findOneAndUpdate(
      { _id: order._id, status: 'ready', riderId: null },
      {
        $set: {
          riderId: req.user.id,
          status: 'accepted',
          acceptedAt,
          pickupDeadline: pickupDeadlineFor(order, rider),
          riderWarnedAt: null,
        },
        $push: { statusHistory: { status: 'accepted', at: acceptedAt } },
      },
      { new: true }
    );
    if (!taken) return res.status(409).json({ message: 'Order already accepted by another rider.' });

    res.json(taken);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/orders/:id/status — update order status (role-aware transitions)
router.patch('/:id/status', protect, async (req, res) => {
  try {
    const { status } = req.body;
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found' });

    const { role, id } = req.user;

    const vendorTransitions = {
      pending: ['preparing', 'cancelled'],
      preparing: ['ready', 'cancelled'],
    };
    const riderTransitions = {
      accepted: ['picked_up'],
      picked_up: ['in_transit', 'delivered'],
      in_transit: ['delivered'],
    };

    if (role === 'vendor') {
      if (String(order.vendorId) !== String(id)) return res.status(403).json({ message: 'Forbidden' });
      if (order.paymentMethod === 'online' && order.paymentStatus !== 'paid' && status !== 'cancelled') {
        return res.status(400).json({ message: 'This order is waiting for the customer to pay online.' });
      }
      const allowed = vendorTransitions[order.status] || [];
      if (!allowed.includes(status)) {
        return res.status(400).json({ message: `Cannot transition from ${order.status} to ${status}` });
      }
    } else if (role === 'rider') {
      if (String(order.riderId) !== String(id)) return res.status(403).json({ message: 'Forbidden' });
      const allowed = riderTransitions[order.status] || [];
      if (!allowed.includes(status)) {
        return res.status(400).json({ message: `Cannot transition from ${order.status} to ${status}` });
      }
    } else if (role !== 'admin') {
      return res.status(403).json({ message: 'Forbidden' });
    }

    // A rider can only complete a delivery AT the delivery address. Their live
    // position (sent with the request, or their last one from the past two
    // minutes) must be within ARRIVAL_RADIUS_METERS of the customer's pin.
    if (status === 'delivered' && role === 'rider') {
      let point = readLatLng(req.body);
      let accuracy = Number(req.body.accuracy) || 0;
      if (!point) {
        const Rider = require('../models/riderModel');
        const r = await Rider.findById(id, 'coordinates locationUpdatedAt');
        const fresh = r?.locationUpdatedAt && Date.now() - new Date(r.locationUpdatedAt).getTime() < 2 * 60 * 1000;
        point = fresh && r.coordinates?.coordinates?.length === 2 ? fromPoint(r.coordinates) : null;
        accuracy = 0;
      }
      if (!point) {
        return res.status(400).json({ message: 'Turn on your location so we can confirm you are at the delivery address.', needsLocation: true });
      }
      const check = arrivalCheck(order, point, accuracy);
      if (!check.arrived) {
        const away = check.metersAway >= 1000 ? `${(check.metersAway / 1000).toFixed(1)} km` : `${check.metersAway} m`;
        return res.status(400).json({
          message: `You're about ${away} from the delivery address. You can mark it delivered when you arrive.`,
          notArrived: true,
          metersAway: check.metersAway,
        });
      }
      if (!check.verifiable) order.deliveredUnverified = true; // no pin to check against
    }

    const wasCancelled = order.status === 'cancelled';
    if (status === 'cancelled' && !wasCancelled) {
      order.cancelledAt = new Date();
      order.cancelledBy = role === 'admin' ? 'admin' : role === 'vendor' ? 'vendor' : 'system';
      order.cancelReason = String(req.body.reason || (role === 'vendor' ? `${order.storeName} cancelled the order.` : 'Cancelled by Nightcrawlers.')).slice(0, 300);
    }
    order.status = status;
    if (status === 'picked_up') order.pickedUpAt = new Date();
    if (status === 'delivered') {
      order.deliveredAt = new Date();
      await onOrderDelivered(order); // points + referral reward (sets order.pointsEarned)
    }
    if (status === 'cancelled' && !wasCancelled) await releaseOrderPerks(order);
    if (['delivered', 'cancelled'].includes(status)) order.trip = null;
    order.statusHistory.push({ status, at: new Date() });

    await order.save();

    // Paid online and now cancelled → refund automatically, and tell the customer.
    if (status === 'cancelled' && !wasCancelled) {
      let latest = order;
      if (needsRefund(order)) latest = (await refundOrder(order, order.cancelReason)) || order;
      // Email/SMS in the background; the vendor or admin doesn't wait for it.
      require('../utils/orderTimers').notifyCustomerCancelled(latest, order.cancelReason).catch(() => {});
      return res.json(latest);
    }
    res.json(order);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/riders/:id/orders
router.get('/rider/:riderId', protect, async (req, res) => {
  try {
    if (req.user.role !== 'admin' && String(req.user.id) !== req.params.riderId) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    const orders = await Order.find({ riderId: req.params.riderId }).sort({ createdAt: -1 });
    res.json(orders);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/vendors/:id/orders
router.get('/vendor/:vendorId', protect, async (req, res) => {
  try {
    if (req.user.role !== 'admin' && String(req.user.id) !== req.params.vendorId) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    // Online orders only appear once they're paid — nothing to cook before then.
    const orders = await Order.find({
      vendorId: req.params.vendorId,
      $or: [{ paymentMethod: { $ne: 'online' } }, { paymentStatus: 'paid' }],
    }).sort({ createdAt: -1 });
    res.json(orders);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/users/me/orders — customer's own order/transaction history
router.get('/customer/me', protect, requireRole('customer'), async (req, res) => {
  try {
    const orders = await Order.find({ customerId: req.user.id }).sort({ createdAt: -1 });
    res.json(orders);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;