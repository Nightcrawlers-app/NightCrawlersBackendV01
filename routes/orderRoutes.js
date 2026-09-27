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

// POST /api/orders/quote — { storeId, items: [{ menuItemId, quantity }], promotionId? }
// The exact breakdown checkout should show. Same maths as placing the order.
router.post('/quote', async (req, res) => {
  try {
    const { storeId, items, promotionId } = req.body;
    if (!require('mongoose').isValidObjectId(storeId)) return res.status(404).json({ message: 'Store not found' });
    const store = await Store.findById(storeId);
    if (!store) return res.status(404).json({ message: 'Store not found' });

    // Where it's going decides the delivery fee: map pin if sent, else the address.
    const deliveryPoint =
      readLatLng({ lat: req.body.customerLatitude, lng: req.body.customerLongitude }) ||
      (req.body.customerAddress ? await geocodeAddress(req.body.customerAddress) : null);

    const priced = await priceOrder({ store, items, promotionId, deliveryPoint, strictPromo: false });
    for (const k of ['promo', 'vendorEarning', 'riderEarning', 'platformEarning']) delete priced[k];
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
    let priced;
    try {
      priced = await priceOrder({ store, items, promotionId: req.body.promotionId, deliveryPoint: delivery, strictPromo: true });
    } catch (err) {
      if (err instanceof PricingError) return res.status(400).json({ message: err.message, ...err.extra });
      throw err;
    }

    const pickup = store.coordinates?.coordinates?.length === 2 ? store.coordinates : undefined;

    const order = await Order.create({
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
      statusHistory: [{ status: 'pending', at: new Date() }],
      status: 'pending',
      ...(pickup && { pickupCoordinates: pickup }),
      ...(priced.promo && {
        promotionId: priced.promo._id,
        promotionTitle: priced.promo.title,
        discountAmount: priced.discount,
        discountFundedBy: priced.promo.fundedBy,
      }),
      ...(delivery && { deliveryCoordinates: toPoint(delivery) }),
    });

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
    const query = { status: 'ready', riderId: null };
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
      total: order.totalPaid ?? order.totalAmount + order.deliveryFee,
      serverTime: new Date(),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Old path, kept so existing clients don't break.
router.get('/pending/list', protect, requireRole('rider'), listPendingForRider);

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

    order.riderId = req.user.id;
    order.status = 'accepted';
    order.acceptedAt = new Date();
    order.statusHistory.push({ status: 'accepted', at: order.acceptedAt });
    await order.save();

    res.json(order);
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

    order.status = status;
    if (status === 'picked_up') order.pickedUpAt = new Date();
    if (status === 'delivered') order.deliveredAt = new Date();
    if (['delivered', 'cancelled'].includes(status)) order.trip = null;
    order.statusHistory.push({ status, at: new Date() });

    await order.save();
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