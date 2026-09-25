const express = require('express');
const router = express.Router();
const Order = require('../models/orderModel');
const Store = require('../models/storeModel');
const { protect, requireRole } = require('../middlewares/auth');

// Day/month/year start in Nigerian time (not the server's zone) — see utils/time.js
const { startOfToday, startOfMonth, startOfYear } = require('../utils/time');

// Older orders (before the split was stored) fall back to the old fields.
const EARNING_EXPR = {
  totalAmount: { $ifNull: ['$vendorEarning', '$totalAmount'] },
  deliveryFee: { $ifNull: ['$riderEarning', '$deliveryFee'] },
};

const earningsAgg = async (match, revenueField) => {
  const sumExpr = EARNING_EXPR[revenueField] || `$${revenueField}`;
  const today = startOfToday();
  const month = startOfMonth();
  const year = startOfYear();

  const [todayAgg, monthAgg, yearAgg] = await Promise.all([
    Order.aggregate([
      { $match: { ...match, status: 'delivered', deliveredAt: { $gte: today } } },
      { $group: { _id: null, total: { $sum: sumExpr }, count: { $sum: 1 } } },
    ]),
    Order.aggregate([
      { $match: { ...match, status: 'delivered', deliveredAt: { $gte: month } } },
      { $group: { _id: null, total: { $sum: sumExpr }, count: { $sum: 1 } } },
    ]),
    Order.aggregate([
      { $match: { ...match, status: 'delivered', deliveredAt: { $gte: year } } },
      { $group: { _id: null, total: { $sum: sumExpr }, count: { $sum: 1 } } },
    ]),
  ]);

  return {
    today: todayAgg[0]?.total || 0,
    thisMonth: monthAgg[0]?.total || 0,
    thisYear: yearAgg[0]?.total || 0,
    todayOrders: todayAgg[0]?.count || 0,
    monthOrders: monthAgg[0]?.count || 0,
    yearOrders: yearAgg[0]?.count || 0,
  };
};

// GET /api/vendors/:id/earnings
router.get('/vendors/:id/earnings', protect, async (req, res) => {
  try {
    if (req.user.role !== 'admin' && String(req.user.id) !== req.params.id) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    if (req.user.role === 'vendor') {
      const Vendor = require('../models/vendorModel');
      const vendor = await Vendor.findById(req.user.id);
      if (vendor && !vendor.bankVerified) {
        return res.status(403).json({
          message: 'Please verify your bank account before accessing earnings.',
          needsBankVerification: true,
        });
      }
    }
    const earnings = await earningsAgg({ vendorId: req.params.id }, 'totalAmount');
    res.json(earnings);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/vendors/:id/stores/earnings — per-store breakdown for this vendor
router.get('/vendors/:id/stores/earnings', protect, async (req, res) => {
  try {
    if (req.user.role !== 'admin' && String(req.user.id) !== req.params.id) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const stores = await Store.find({ vendorId: req.params.id });
    const vendor = require('../models/Vendor');
    const vendorDoc = await vendor.findById(req.params.id);
    const vendorName = vendorDoc ? `${vendorDoc.firstName} ${vendorDoc.lastName}` : 'Unknown';

    const result = [];
    for (const s of stores) {
      const e = await earningsAgg({ storeId: s._id }, 'totalAmount');
      result.push({
        storeId: String(s._id),
        storeName: s.name,
        vendorId: String(s.vendorId),
        vendorName,
        todayEarnings: e.today,
        todayOrders: e.todayOrders,
        monthEarnings: e.thisMonth,
        monthOrders: e.monthOrders,
        yearEarnings: e.thisYear,
        yearOrders: e.yearOrders,
      });
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/stores/:id/earnings
router.get('/stores/:id/earnings', protect, async (req, res) => {
  try {
    const store = await Store.findById(req.params.id);
    if (!store) return res.status(404).json({ message: 'Store not found' });

    if (req.user.role !== 'admin' && String(store.vendorId) !== String(req.user.id)) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const Vendor = require('../models/Vendor');
    const vendorDoc = await Vendor.findById(store.vendorId);
    const e = await earningsAgg({ storeId: store._id }, 'totalAmount');

    res.json({
      storeId: String(store._id),
      storeName: store.name,
      vendorId: String(store.vendorId),
      vendorName: vendorDoc ? `${vendorDoc.firstName} ${vendorDoc.lastName}` : 'Unknown',
      todayEarnings: e.today,
      todayOrders: e.todayOrders,
      monthEarnings: e.thisMonth,
      monthOrders: e.monthOrders,
      yearEarnings: e.thisYear,
      yearOrders: e.yearOrders,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/riders/:id/earnings
router.get('/riders/:id/earnings', protect, async (req, res) => {
  try {
    if (req.user.role !== 'admin' && String(req.user.id) !== req.params.id) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    if (req.user.role === 'rider') {
      const Rider = require('../models/riderModel');
      const rider = await Rider.findById(req.user.id);
      if (rider && !rider.bankVerified) {
        return res.status(403).json({
          message: 'Please verify your bank account before accessing earnings.',
          needsBankVerification: true,
        });
      }
    }
  
    const earnings = await earningsAgg({ riderId: req.params.id }, 'deliveryFee');
    res.json(earnings);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;