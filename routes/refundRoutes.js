const express = require('express');
const mongoose = require('mongoose');
const Order = require('../models/orderModel');
const { protect, requireRole } = require('../middlewares/auth');
const { refundOrder } = require('../utils/refunds');

/**
 * Admin → Refunds. Refunds normally happen automatically (utils/refunds.js);
 * this is for the ones that need a person.
 *
 *   GET  /api/admin/refunds?status=attention|pending|done|all
 *          attention (default) = failed, or stuck asking Paystack
 *   POST /api/admin/refunds/:orderId/retry    ask Paystack again
 *   POST /api/admin/refunds/:orderId/manual   { note } — you refunded it yourself
 */
const router = express.Router();
router.use(protect, requireRole('admin'));

const FIELDS =
  'storeName customerName customerPhone totalPaid paymentMethod paymentStatus paystackReference status cancelReason cancelledBy cancelledAt ' +
  'refundStatus refundAmount refundRequestedAt refundedAt refundError refundNote createdAt';

router.get('/', async (req, res) => {
  try {
    const stale = new Date(Date.now() - 10 * 60 * 1000);
    const filters = {
      attention: { $or: [{ refundStatus: 'failed' }, { refundStatus: 'requesting', refundRequestedAt: { $lt: stale } }] },
      pending: { refundStatus: { $in: ['requesting', 'pending'] } },
      done: { refundStatus: { $in: ['processed', 'manual'] } },
      all: { refundStatus: { $ne: 'none' } },
    };
    const filter = filters[req.query.status] || filters.attention;
    const [orders, attention] = await Promise.all([
      Order.find(filter, FIELDS).sort({ refundRequestedAt: -1, cancelledAt: -1 }).limit(200),
      Order.countDocuments(filters.attention),
    ]);
    res.json({ attention, orders: orders.map((o) => ({ ...o.toObject(), id: String(o._id) })) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/:orderId/retry', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.orderId)) return res.status(404).json({ message: 'Order not found' });
    const order = await Order.findById(req.params.orderId);
    if (!order) return res.status(404).json({ message: 'Order not found' });
    if (order.paymentStatus !== 'paid' || order.paymentMethod !== 'online') {
      return res.status(400).json({ message: 'This order was not paid online, so there is nothing to refund.' });
    }
    if (['processed', 'manual'].includes(order.refundStatus)) return res.status(400).json({ message: 'Already refunded.' });
    const updated = await refundOrder(order, order.refundNote || order.cancelReason || 'Order cancelled');
    if (!updated) return res.status(409).json({ message: 'A refund for this order is already in progress.' });
    res.json({ ...updated.toObject(), id: String(updated._id) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/:orderId/manual', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.orderId)) return res.status(404).json({ message: 'Order not found' });
    const note = String(req.body.note || '').trim().slice(0, 300);
    if (!note) return res.status(400).json({ message: 'Say how it was refunded (e.g. "Bank transfer, ref 12345").' });
    const updated = await Order.findOneAndUpdate(
      { _id: req.params.orderId, refundStatus: { $nin: ['processed', 'manual'] } },
      { $set: { refundStatus: 'manual', refundedAt: new Date(), refundError: '', refundNote: note } },
      { new: true }
    );
    if (!updated) return res.status(400).json({ message: 'Already refunded, or order not found.' });
    res.json({ ...updated.toObject(), id: String(updated._id) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
