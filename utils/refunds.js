/**
 * Giving customers their money back when a paid online order is cancelled
 * (by the store, by an admin, or automatically by the order timers).
 *
 * Safe to call more than once: the order is "claimed" atomically before
 * Paystack is asked, so two cancellations at the same moment can't refund
 * twice, and Paystack itself refuses a second full refund (treated as done).
 *
 * If Paystack refuses or is unreachable, the order is marked refundStatus
 * 'failed' and shows up in Admin → Refunds to retry or refund by hand. The
 * customer is never silently left out of pocket.
 */
const Order = require('../models/orderModel');

const needsRefund = (order) => order.paymentMethod === 'online' && order.paymentStatus === 'paid';

/**
 * @param {string|object} orderOrId
 * @param {string} reason  shown to the customer by Paystack and kept for you
 * @returns the updated order (refundStatus pending/processed/failed), or null if nothing to do
 */
const refundOrder = async (orderOrId, reason = 'Order cancelled') => {
  const id = orderOrId?._id ?? orderOrId;
  // Claim it: only one caller moves it to 'requesting'. Failed refunds, and
  // ones stuck 'requesting' for 10+ minutes (e.g. the server restarted mid-way),
  // can be tried again.
  const staleRequest = new Date(Date.now() - 10 * 60 * 1000);
  const order = await Order.findOneAndUpdate(
    {
      _id: id,
      paymentMethod: 'online',
      paymentStatus: 'paid',
      $or: [
        { refundStatus: { $in: ['none', 'failed', null] } },
        { refundStatus: 'requesting', refundRequestedAt: { $lt: staleRequest } },
      ],
    },
    { $set: { refundStatus: 'requesting', refundRequestedAt: new Date(), refundError: '' } },
    { new: true }
  );
  if (!order) return null;

  const amount = order.totalPaid ?? order.totalAmount + order.deliveryFee;
  try {
    if (!order.paystackReference) throw new Error('No Paystack reference on this order');
    const { createRefund } = require('./paystackPayments');
    const result = await createRefund({
      reference: order.paystackReference,
      customerNote: `Nightcrawlers refund: ${reason}`,
      merchantNote: `Order ${order._id}: ${reason}`,
    });
    const processed = result.status === 'processed';
    return Order.findByIdAndUpdate(
      order._id,
      {
        $set: {
          refundStatus: processed ? 'processed' : 'pending',
          refundAmount: amount,
          ...(processed && { refundedAt: new Date() }),
          refundNote: reason,
        },
      },
      { new: true }
    );
  } catch (err) {
    console.error(`❌ Refund failed for order ${order._id}:`, err.message);
    return Order.findByIdAndUpdate(
      order._id,
      { $set: { refundStatus: 'failed', refundAmount: amount, refundError: err.message.slice(0, 300), refundNote: reason } },
      { new: true }
    );
  }
};

/** Paystack webhook: refund.processed / refund.failed / refund.pending. */
const applyRefundWebhook = async (event, data) => {
  const reference = data?.transaction_reference || data?.transaction?.reference;
  if (!reference) return;
  const order = await Order.findOne({ paystackReference: reference });
  if (!order) return;
  if (event === 'refund.processed') {
    order.refundStatus = 'processed';
    order.refundedAt = new Date();
    order.refundError = '';
  } else if (event === 'refund.failed') {
    order.refundStatus = 'failed';
    order.refundError = String(data?.message || data?.status || 'Paystack could not complete the refund').slice(0, 300);
  } else if (event === 'refund.pending' && order.refundStatus === 'requesting') {
    order.refundStatus = 'pending';
  } else {
    return;
  }
  await order.save();
};

module.exports = { refundOrder, needsRefund, applyRefundWebhook };
