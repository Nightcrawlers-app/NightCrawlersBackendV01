const express = require('express');
const router = express.Router();
const Order = require('../models/orderModel');
const Store = require('../models/storeModel');
const { protect, requireRole } = require('../middlewares/auth');

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};
const startOfMonth = () => {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
};
const startOfYear = () => {
  const d = new Date();
  d.setMonth(0, 1);
  d.setHours(0, 0, 0, 0);
  return d;
};

const earningsAgg = async (match, revenueField) => {
  const today = startOfToday();
  const month = startOfMonth();
  const year = startOfYear();

  const [todayAgg, monthAgg, yearAgg] = await Promise.all([
    Order.aggregate([
      { $match: { ...match, status: 'delivered', deliveredAt: { $gte: today } } },
      { $group: { _id: null, total: { $sum: `$${revenueField}` }, count: { $sum: 1 } } },
    ]),
    Order.aggregate([
      { $match: { ...match, status: 'delivered', deliveredAt: { $gte: month } } },
      { $group: { _id: null, total: { $sum: `$${revenueField}` }, count: { $sum: 1 } } },
    ]),
    Order.aggregate([
      { $match: { ...match, status: 'delivered', deliveredAt: { $gte: year } } },
      { $group: { _id: null, total: { $sum: `$${revenueField}` }, count: { $sum: 1 } } },
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
    const earnings = await earningsAgg({ riderId: req.params.id }, 'deliveryFee');
    res.json(earnings);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;