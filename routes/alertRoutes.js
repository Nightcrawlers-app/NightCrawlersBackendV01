const express = require('express');
const mongoose = require('mongoose');
const Order = require('../models/orderModel');
const { protect, requireRole } = require('../middlewares/auth');
const { TEAM_ALERT_TYPES } = require('../utils/orderAlerts');

/**
 * Admin → Alerts: orders the team should look at (utils/orderAlerts.js).
 *   GET  /api/admin/alerts                     open alerts, newest first
 *   POST /api/admin/alerts/:orderId/resolve    { type, note? } — mark handled
 *
 * `stillHappening` is false when the problem has sorted itself out (e.g. the
 * store marked it ready after all) — those can just be dismissed.
 */
const router = express.Router();
router.use(protect, requireRole('admin'));

const STILL = {
  prep_very_late: (o) => o.status === 'preparing',
  no_rider_admin: (o) => o.status === 'ready' && !o.riderId,
  delivery_stalled: (o) => ['picked_up', 'in_transit'].includes(o.status),
  cancelled_after_ready: () => true, // needs a decision about paying the vendor
};

router.get('/', async (req, res) => {
  try {
    const orders = await Order.find(
      { alerts: { $elemMatch: { type: { $in: TEAM_ALERT_TYPES }, resolvedAt: null } } },
      'storeName customerName customerPhone customerAddress status riderId vendorId totalAmount totalPaid paymentMethod paymentStatus refundStatus alerts createdAt trip'
    )
      .sort({ updatedAt: -1 })
      .limit(200)
      .populate('riderId', 'firstName lastName phoneNumber coordinates locationUpdatedAt')
      .populate('vendorId', 'phoneNumber businessName');

    const rows = [];
    for (const o of orders) {
      for (const a of o.alerts) {
        if (!TEAM_ALERT_TYPES.includes(a.type) || a.resolvedAt) continue;
        const rider = o.riderId;
        const pos = rider?.coordinates?.coordinates;
        rows.push({
          orderId: String(o._id),
          type: a.type,
          message: a.message,
          at: a.at,
          stillHappening: STILL[a.type]?.(o) ?? true,
          status: o.status,
          storeName: o.storeName,
          vendorPhone: o.vendorId?.phoneNumber || '',
          customerName: o.customerName,
          customerPhone: o.customerPhone,
          customerAddress: o.customerAddress,
          total: o.totalPaid ?? o.totalAmount,
          paymentMethod: o.paymentMethod,
          refundStatus: o.refundStatus,
          rider: rider
            ? {
                name: `${rider.firstName} ${rider.lastName || ''}`.trim(),
                phone: rider.phoneNumber || '',
                lastLocation: pos?.length === 2 ? { latitude: pos[1], longitude: pos[0], at: rider.locationUpdatedAt } : null,
              }
            : null,
        });
      }
    }
    rows.sort((a, b) => Number(b.stillHappening) - Number(a.stillHappening) || new Date(b.at) - new Date(a.at));
    res.json({ open: rows.filter((r) => r.stillHappening).length, alerts: rows });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post('/:orderId/resolve', async (req, res) => {
  try {
    const { type } = req.body;
    if (!mongoose.isValidObjectId(req.params.orderId) || !TEAM_ALERT_TYPES.includes(type)) {
      return res.status(400).json({ message: 'Unknown alert.' });
    }
    const note = String(req.body.note || '').trim().slice(0, 300);
    const done = await Order.updateOne(
      { _id: req.params.orderId, alerts: { $elemMatch: { type, resolvedAt: null } } },
      { $set: { 'alerts.$.resolvedAt': new Date(), 'alerts.$.resolvedNote': note } }
    );
    if (done.modifiedCount !== 1) return res.status(404).json({ message: 'Already handled, or not found.' });
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
