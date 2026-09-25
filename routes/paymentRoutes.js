const express = require('express');
const mongoose = require('mongoose');
const Order = require('../models/orderModel');
const User = require('../models/userModel');
const { optionalAuth } = require('../middlewares/auth');
const { initializeTransaction, verifyTransaction, isValidWebhookSignature } = require('../utils/paystackPayments');
const { onlinePaymentsEnabled } = require('../utils/settings');

const router = express.Router();

/**
 * Mark an order paid — but only if Paystack says the full amount arrived in
 * naira. Safe to call more than once (the callback page and the webhook can
 * both report the same payment).
 */
const applyPayment = async (order, tx) => {
  if (order.paymentStatus === 'paid') return order;
  const expected = order.totalPaid ?? order.totalAmount + order.deliveryFee;
  if (tx.status === 'success' && tx.currency === 'NGN' && tx.amountNaira >= expected) {
    order.paymentStatus = 'paid';
    order.paidAt = tx.paidAt ? new Date(tx.paidAt) : new Date();
  } else if (['failed', 'abandoned', 'reversed'].includes(tx.status)) {
    order.paymentStatus = 'failed';
  } else if (tx.status === 'success') {
    // Paid, but less than the order total — needs a human to look at it.
    console.error(`⚠️ Paystack amount mismatch on order ${order._id}: got ${tx.amountNaira} ${tx.currency}, expected ${expected}`);
    order.paymentStatus = 'failed';
  }
  await order.save();
  return order;
};

const summary = (order) => ({
  orderId: String(order._id),
  paymentStatus: order.paymentStatus,
  totalPaid: order.totalPaid,
  storeName: order.storeName,
});

// POST /api/payments/paystack/initialize — { orderId } → { authorizationUrl }
// Also used to retry a payment that failed or was abandoned.
router.post('/paystack/initialize', optionalAuth, async (req, res) => {
  try {
    if (!onlinePaymentsEnabled()) return res.status(503).json({ message: 'Online payment is not available right now.' });
    const { orderId } = req.body;
    if (!mongoose.isValidObjectId(orderId)) return res.status(404).json({ message: 'Order not found' });
    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ message: 'Order not found' });

    if (!order.customerId || req.user?.role !== 'customer' || String(order.customerId) !== String(req.user.id)) {
      return res.status(403).json({ message: 'Please sign in to pay for this order.' });
    }
    if (order.paymentMethod !== 'online') return res.status(400).json({ message: 'This order is paid on delivery.' });
    if (order.paymentStatus === 'paid') return res.status(400).json({ message: 'This order is already paid.' });
    if (order.status === 'cancelled') return res.status(400).json({ message: 'This order was cancelled.' });

    const customer = await User.findById(order.customerId);
    const frontend = (process.env.FRONTEND_URL || 'http://localhost:5173').split(',')[0].trim().replace(/\/$/, '');
    // A fresh reference each attempt — Paystack rejects re-using one.
    const reference = `NC-${order._id}-${Date.now()}`;

    const { authorizationUrl } = await initializeTransaction({
      email: customer.email,
      amountNaira: order.totalPaid,
      reference,
      callbackUrl: `${frontend}/payment/callback`,
      metadata: { orderId: String(order._id), store: order.storeName },
    });

    order.paystackReference = reference;
    order.paymentStatus = 'pending';
    await order.save();
    res.json({ authorizationUrl, reference });
  } catch (err) {
    console.error('Payment initialize failed:', err.message);
    res.status(502).json({ message: "Couldn't start the payment. Please try again." });
  }
});

// GET /api/payments/paystack/verify?reference=… — the page Paystack sends
// the customer back to calls this to find out if they paid.
router.get('/paystack/verify', async (req, res) => {
  try {
    const reference = String(req.query.reference || '');
    const order = reference ? await Order.findOne({ paystackReference: reference }) : null;
    if (!order) return res.status(404).json({ message: 'Payment not found' });
    if (order.paymentStatus !== 'paid') await applyPayment(order, await verifyTransaction(reference));
    res.json(summary(order));
  } catch (err) {
    console.error('Payment verify failed:', err.message);
    res.status(502).json({ message: "Couldn't confirm the payment yet. Please refresh in a moment." });
  }
});

// POST /api/payments/paystack/webhook — Paystack calls this server-to-server.
// Set it in the Paystack dashboard: Settings → API Keys & Webhooks →
//   https://api.nightcrawlers.app/api/payments/paystack/webhook
// This is what makes payments reliable even if the customer closes the tab
// before returning to the site.
router.post('/paystack/webhook', async (req, res) => {
  if (!isValidWebhookSignature(req.rawBody, req.headers['x-paystack-signature'])) {
    return res.status(401).end();
  }
  res.status(200).end(); // acknowledge quickly; Paystack retries otherwise
  try {
    const { event, data } = req.body || {};
    if (event !== 'charge.success' || !data?.reference) return;
    const order = await Order.findOne({ paystackReference: data.reference });
    if (!order) return;
    // Re-check with Paystack rather than trusting the webhook body alone.
    await applyPayment(order, await verifyTransaction(data.reference));
  } catch (err) {
    console.error('Paystack webhook handling failed:', err.message);
  }
});

module.exports = { router, applyPayment };
