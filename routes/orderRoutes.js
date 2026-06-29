const express = require('express');
const router = express.Router();
const Order = require('../models/orderModel');
const Store = require('../models/storeModel');
const { protect, requireRole, optionalAuth } = require('../middlewares/auth');

// POST /api/orders — create a new order (customer, or guest checkout)
router.post('/', optionalAuth, async (req, res) => {
  try {
    const {
      storeId,
      storeName,
      customerName,
      customerPhone,
      customerLocation,
      customerAddress,
      items,
      deliveryFee,
    } = req.body;

    if (!storeId || !customerName || !customerPhone || !customerAddress || !items?.length) {
      return res.status(400).json({ message: 'Missing required order fields.' });
    }

    const store = await Store.findById(storeId);
    if (!store) return res.status(404).json({ message: 'Store not found' });

    const totalAmount = items.reduce((sum, i) => sum + i.price * i.quantity, 0);

    const order = await Order.create({
      storeId,
      storeName: storeName || store.name,
      vendorId: store.vendorId,
      customerId: req.user?.role === 'customer' ? req.user.id : null,
      customerName,
      customerPhone,
      customerLocation: customerLocation || '',
      customerAddress,
      items,
      totalAmount,
      deliveryFee: deliveryFee || 0,
      status: 'pending',
    });

    res.status(201).json(order);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

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

// GET /api/orders/pending?location=... — pending orders available to riders nearby
router.get('/pending/list', protect, requireRole('rider'), async (req, res) => {
  try {
    const { location } = req.query;
    const query = { status: 'ready', riderId: null };

    // Simple location matching; in production, use geo queries with coordinates.
    if (location) {
      query.customerLocation = { $regex: location, $options: 'i' };
    }

    const orders = await Order.find(query).sort({ createdAt: 1 });
    res.json(orders);
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

    order.riderId = req.user.id;
    order.status = 'accepted';
    order.acceptedAt = new Date();
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

    order.status = status;
    if (status === 'picked_up') order.pickedUpAt = new Date();
    if (status === 'delivered') order.deliveredAt = new Date();

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
    const orders = await Order.find({ vendorId: req.params.vendorId }).sort({ createdAt: -1 });
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