const express = require('express');
const router = express.Router();
const Vendor = require('../models/vendorModel');   // ✅ FIXED: was wrongly importing userModel
const Rider = require('../models/riderModel');
const Store = require('../models/storeModel');
const MenuItem = require('../models/menuItemModel');
const Order = require('../models/orderModel');
const { protect, requireRole } = require('../middlewares/auth');
const {
  sendVendorApprovedEmail,
  sendVendorRejectedEmail,
  sendRiderApprovedEmail,
  sendRiderRejectedEmail,
} = require('../utils/mailer');

router.use(protect, requireRole('admin'));

// ─── helpers ──────────────────────────────────────────────────────────────────

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

// ─── GET /api/admin/stats ──────────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const [totalVendors, totalStores, totalRiders, totalMenuItems, totalOrders] = await Promise.all([
      Vendor.countDocuments(),
      Store.countDocuments(),
      Rider.countDocuments(),
      MenuItem.countDocuments(),
      Order.countDocuments(),
    ]);

    const revenueAgg = await Order.aggregate([
      { $match: { status: 'delivered' } },
      { $group: { _id: null, total: { $sum: { $add: ['$totalAmount', '$deliveryFee'] } } } },
    ]);

    res.json({
      totalVendors,
      totalStores,
      totalRiders,
      totalMenuItems,
      totalOrders,
      totalRevenue: revenueAgg[0]?.total || 0,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── GET /api/admin/activity ───────────────────────────────────────────────────
router.get('/activity', async (req, res) => {
  try {
    const [recentVendors, recentRiders, recentStores] = await Promise.all([
      Vendor.find().sort({ createdAt: -1 }).limit(5),
      Rider.find().sort({ createdAt: -1 }).limit(5),
      Store.find().sort({ createdAt: -1 }).limit(5),
    ]);

    const timeAgo = (date) => {
      const diffMs = Date.now() - new Date(date).getTime();
      const mins = Math.floor(diffMs / 60000);
      if (mins < 1) return 'Just now';
      if (mins < 60) return `${mins}m ago`;
      const hours = Math.floor(mins / 60);
      if (hours < 24) return `${hours}h ago`;
      return `${Math.floor(hours / 24)}d ago`;
    };

    const activity = [
      ...recentVendors.map((v) => ({
        id: String(v._id),
        type: 'vendor',
        message: `${v.firstName} ${v.lastName} registered as a vendor`,
        timeAgo: timeAgo(v.createdAt),
        timestamp: new Date(v.createdAt).getTime(),
      })),
      ...recentRiders.map((r) => ({
        id: String(r._id),
        type: 'rider',
        message: `${r.firstName} ${r.lastName} registered as a rider`,
        timeAgo: timeAgo(r.createdAt),
        timestamp: new Date(r.createdAt).getTime(),
      })),
      ...recentStores.map((s) => ({
        id: String(s._id),
        type: 'store',
        message: `New store created: ${s.name}`,
        timeAgo: timeAgo(s.createdAt),
        timestamp: new Date(s.createdAt).getTime(),
      })),
    ].sort((a, b) => b.timestamp - a.timestamp).slice(0, 10);

    res.json(activity);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── GET /api/admin/pending ─────────────────────────────────────────────────────
router.get('/pending', async (req, res) => {
  try {
    const [pendingVendors, pendingRiders] = await Promise.all([
      Vendor.find({ verified: false }),
      Rider.find({ verified: false }),
    ]);

    const pending = [
      ...pendingVendors.map((v) => ({
        id: String(v._id),
        title: `${v.firstName} ${v.lastName} — ${v.businessTypeRaw || v.businessType}`,
        type: 'vendor',
      })),
      ...pendingRiders.map((r) => ({
        id: String(r._id),
        title: `${r.firstName} ${r.lastName} — ${r.vehicleType}`,
        type: 'rider',
      })),
    ];

    res.json(pending);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── POST /api/admin/verify ─────────────────────────────────────────────────────
// ✅ FIXED: now sends approval/rejection emails
router.post('/verify', async (req, res) => {
  try {
    const { id, type, action } = req.body;
    if (!id || !['vendor', 'rider'].includes(type) || !['approve', 'reject'].includes(action)) {
      return res.status(400).json({ message: 'Invalid verify request.' });
    }

    const Model = type === 'vendor' ? Vendor : Rider;
    const entity = await Model.findById(id);
    if (!entity) return res.status(404).json({ message: `${type} not found.` });

    if (action === 'approve') {
      await Model.findByIdAndUpdate(id, { verified: true });

      // Fire approval email
      if (type === 'vendor') {
        sendVendorApprovedEmail(entity.email, entity.firstName).catch((err) =>
          console.error('Vendor approval email failed:', err.message)
        );
      } else {
        sendRiderApprovedEmail(entity.email, entity.firstName).catch((err) =>
          console.error('Rider approval email failed:', err.message)
        );
      }
    } else {
      // reject: delete the account
      await Model.findByIdAndDelete(id);

      // Fire rejection email
      if (type === 'vendor') {
        sendVendorRejectedEmail(entity.email, entity.firstName).catch((err) =>
          console.error('Vendor rejection email failed:', err.message)
        );
      } else {
        sendRiderRejectedEmail(entity.email, entity.firstName).catch((err) =>
          console.error('Rider rejection email failed:', err.message)
        );
      }
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── GET /api/admin/vendors, /riders, /stores, /orders ──────────────────────────
router.get('/vendors', async (req, res) => {
  const vendors = await Vendor.find().sort({ createdAt: -1 });
  res.json(vendors.map((v) => v.toSafeJSON()));
});

router.get('/riders', async (req, res) => {
  const riders = await Rider.find().sort({ createdAt: -1 });
  res.json(riders.map((r) => r.toSafeJSON()));
});

router.get('/stores', async (req, res) => {
  const stores = await Store.find().sort({ createdAt: -1 });
  res.json(stores);
});

router.get('/orders', async (req, res) => {
  const orders = await Order.find().sort({ createdAt: -1 });
  res.json(orders);
});

// ─── GET /api/admin/order-stats ─────────────────────────────────────────────────
router.get('/order-stats', async (req, res) => {
  try {
    const today = startOfToday();

    const [totalOrders, todayOrders, pendingOrders, activeOrders, completedOrders, onlineRiders, totalRiders] =
      await Promise.all([
        Order.countDocuments(),
        Order.countDocuments({ createdAt: { $gte: today } }),
        Order.countDocuments({ status: { $in: ['pending', 'preparing', 'ready'] } }),
        Order.countDocuments({ status: { $in: ['accepted', 'picked_up', 'in_transit'] } }),
        Order.countDocuments({ status: 'delivered' }),
        Rider.countDocuments({ isOnline: true }),
        Rider.countDocuments(),
      ]);

    const revenueAgg = await Order.aggregate([
      { $match: { status: 'delivered' } },
      { $group: { _id: null, total: { $sum: { $add: ['$totalAmount', '$deliveryFee'] } } } },
    ]);
    const todayRevenueAgg = await Order.aggregate([
      { $match: { status: 'delivered', deliveredAt: { $gte: today } } },
      { $group: { _id: null, total: { $sum: { $add: ['$totalAmount', '$deliveryFee'] } } } },
    ]);

    res.json({
      totalOrders,
      todayOrders,
      pendingOrders,
      activeOrders,
      completedOrders,
      totalRevenue: revenueAgg[0]?.total || 0,
      todayRevenue: todayRevenueAgg[0]?.total || 0,
      onlineRiders,
      totalRiders,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── GET /api/admin/earnings ─────────────────────────────────────────────────
// ✅ IMPROVED: uses $group aggregation instead of per-entity loops
router.get('/earnings', async (req, res) => {
  try {
    const today = startOfToday();
    const month = startOfMonth();
    const year = startOfYear();

    const [vendors, riders] = await Promise.all([Vendor.find(), Rider.find()]);

    // Batch aggregate vendor earnings
    const [vendorToday, vendorMonth, vendorYear] = await Promise.all([
      Order.aggregate([
        { $match: { status: 'delivered', deliveredAt: { $gte: today } } },
        { $group: { _id: '$vendorId', total: { $sum: '$totalAmount' }, count: { $sum: 1 } } },
      ]),
      Order.aggregate([
        { $match: { status: 'delivered', deliveredAt: { $gte: month } } },
        { $group: { _id: '$vendorId', total: { $sum: '$totalAmount' }, count: { $sum: 1 } } },
      ]),
      Order.aggregate([
        { $match: { status: 'delivered', deliveredAt: { $gte: year } } },
        { $group: { _id: '$vendorId', total: { $sum: '$totalAmount' }, count: { $sum: 1 } } },
      ]),
    ]);

    // Batch aggregate rider earnings
    const [riderToday, riderMonth, riderYear] = await Promise.all([
      Order.aggregate([
        { $match: { status: 'delivered', deliveredAt: { $gte: today } } },
        { $group: { _id: '$riderId', total: { $sum: '$deliveryFee' }, count: { $sum: 1 } } },
      ]),
      Order.aggregate([
        { $match: { status: 'delivered', deliveredAt: { $gte: month } } },
        { $group: { _id: '$riderId', total: { $sum: '$deliveryFee' }, count: { $sum: 1 } } },
      ]),
      Order.aggregate([
        { $match: { status: 'delivered', deliveredAt: { $gte: year } } },
        { $group: { _id: '$riderId', total: { $sum: '$deliveryFee' }, count: { $sum: 1 } } },
      ]),
    ]);

    const toMap = (arr) => new Map(arr.map((x) => [String(x._id), x]));

    const vTodayMap = toMap(vendorToday);
    const vMonthMap = toMap(vendorMonth);
    const vYearMap  = toMap(vendorYear);
    const rTodayMap = toMap(riderToday);
    const rMonthMap = toMap(riderMonth);
    const rYearMap  = toMap(riderYear);

    const entityEarnings = [
      ...vendors.map((v) => {
        const id = String(v._id);
        return {
          id,
          name: `${v.firstName} ${v.lastName}`,
          type: 'vendor',
          earnings: {
            today:       vTodayMap.get(id)?.total || 0,
            thisMonth:   vMonthMap.get(id)?.total || 0,
            thisYear:    vYearMap.get(id)?.total  || 0,
            todayOrders: vTodayMap.get(id)?.count || 0,
            monthOrders: vMonthMap.get(id)?.count || 0,
            yearOrders:  vYearMap.get(id)?.count  || 0,
          },
        };
      }),
      ...riders.map((r) => {
        const id = String(r._id);
        return {
          id,
          name: `${r.firstName} ${r.lastName}`,
          type: 'rider',
          earnings: {
            today:       rTodayMap.get(id)?.total || 0,
            thisMonth:   rMonthMap.get(id)?.total || 0,
            thisYear:    rYearMap.get(id)?.total  || 0,
            todayOrders: rTodayMap.get(id)?.count || 0,
            monthOrders: rMonthMap.get(id)?.count || 0,
            yearOrders:  rYearMap.get(id)?.count  || 0,
          },
        };
      }),
    ];

    res.json(entityEarnings);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ─── GET /api/admin/stores/earnings ─────────────────────────────────────────
// ✅ IMPROVED: batched aggregation
router.get('/stores/earnings', async (req, res) => {
  try {
    const today = startOfToday();
    const month = startOfMonth();
    const year = startOfYear();

    const [stores, vendors] = await Promise.all([Store.find(), Vendor.find()]);
    const vendorMap = new Map(vendors.map((v) => [String(v._id), `${v.firstName} ${v.lastName}`]));

    const [storeToday, storeMonth, storeYear] = await Promise.all([
      Order.aggregate([
        { $match: { status: 'delivered', deliveredAt: { $gte: today } } },
        { $group: { _id: '$storeId', total: { $sum: '$totalAmount' }, count: { $sum: 1 } } },
      ]),
      Order.aggregate([
        { $match: { status: 'delivered', deliveredAt: { $gte: month } } },
        { $group: { _id: '$storeId', total: { $sum: '$totalAmount' }, count: { $sum: 1 } } },
      ]),
      Order.aggregate([
        { $match: { status: 'delivered', deliveredAt: { $gte: year } } },
        { $group: { _id: '$storeId', total: { $sum: '$totalAmount' }, count: { $sum: 1 } } },
      ]),
    ]);

    const toMap = (arr) => new Map(arr.map((x) => [String(x._id), x]));
    const sTodayMap = toMap(storeToday);
    const sMonthMap = toMap(storeMonth);
    const sYearMap  = toMap(storeYear);

    const result = stores.map((s) => {
      const id = String(s._id);
      return {
        storeId:      id,
        storeName:    s.name,
        vendorId:     String(s.vendorId),
        vendorName:   vendorMap.get(String(s.vendorId)) || 'Unknown',
        todayEarnings:  sTodayMap.get(id)?.total || 0,
        todayOrders:    sTodayMap.get(id)?.count || 0,
        monthEarnings:  sMonthMap.get(id)?.total || 0,
        monthOrders:    sMonthMap.get(id)?.count || 0,
        yearEarnings:   sYearMap.get(id)?.total  || 0,
        yearOrders:     sYearMap.get(id)?.count  || 0,
      };
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
