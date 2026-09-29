const mongoose = require('mongoose');

const ORDER_STATUSES = [
  'pending',
  'preparing',
  'ready',
  'accepted',
  'picked_up',
  'in_transit',
  'delivered',
  'cancelled',
];

const OrderItemSchema = new mongoose.Schema(
  {
    // Which menu item this was. Name and price are copied from the menu at
    // order time, so later menu edits don't change past orders.
    menuItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem', default: null },
    name: { type: String, required: true },
    quantity: { type: Number, required: true },
    price: { type: Number, required: true },
  },
  { _id: false }
);

const OrderSchema = new mongoose.Schema(
  {
    storeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', required: true, index: true },
    storeName: { type: String, required: true },
    vendorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', required: true, index: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    customerName: { type: String, required: true },
    customerPhone: { type: String, required: true },
    // City/area label. Optional: the address and coordinates are what riders
    // use. Requiring it crashed any order placed without one (500 error).
    customerLocation: { type: String, default: '' },
    customerAddress: { type: String, required: true },
    // Positions for rider matching and navigation. [longitude, latitude].
    pickupCoordinates: {
      type: { type: String, enum: ['Point'] },
      coordinates: { type: [Number], default: undefined },
    },
    deliveryCoordinates: {
      type: { type: String, enum: ['Point'] },
      coordinates: { type: [Number], default: undefined },
    },
    riderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Rider', default: null, index: true },
    items: [OrderItemSchema],
    totalAmount: { type: Number, required: true },
    deliveryFee: { type: Number, required: true },
    serviceFee: { type: Number, default: 0 },
    // Road-distance estimate used to price delivery (null = flat fallback fee)
    deliveryDistanceKm: { type: Number, default: null },
    // Everything the customer pays: food + delivery + service − discount.
    // (totalAmount above is the food subtotal only.)
    totalPaid: { type: Number, default: null },
    // Settlement split, fixed at order time (see utils/orderPricing.js).
    // vendorEarning + riderEarning + platformEarning === totalPaid.
    vendorEarning: { type: Number, default: null },
    riderEarning: { type: Number, default: null },
    platformEarning: { type: Number, default: null },
    // Promotion applied at checkout (recalculated on the server, never trusted from the browser)
    promotionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Promotion', default: null },
    promotionTitle: { type: String, default: null },
    discountAmount: { type: Number, default: 0 },
    discountFundedBy: { type: String, enum: ['platform', 'vendor', null], default: null },
    promoCode: { type: String, default: null },   // the code typed, if the promo needed one
    personalCodeId: { type: mongoose.Schema.Types.ObjectId, ref: 'PersonalCode', default: null }, // campaign code used

    // Loyalty rewards spent on this order (platform-funded; see utils/rewards.js)
    rewardDiscount: { type: Number, default: 0 },
    freeDeliveryUsed: { type: Boolean, default: false },
    deliveryCreditUsed: { type: Number, default: 0 },
    // Points earned once delivered (and whether they've been added yet)
    pointsEarned: { type: Number, default: 0 },
    pointsAwarded: { type: Boolean, default: false },

    // Notes from the customer. Kept short: they're read on a phone mid-shift.
    noteForVendor: { type: String, default: '', trim: true, maxlength: 300 },   // "no onions"
    noteForRider: { type: String, default: '', trim: true, maxlength: 300 },    // "blue gate, call on arrival"

    // ── Payment ────────────────────────────────────────────────────────────
    //   cash_on_delivery / card_on_delivery → paid to the rider; nothing online
    //   online → Paystack checkout; the vendor can't start until it's 'paid'
    paymentMethod: {
      type: String,
      enum: ['cash_on_delivery', 'card_on_delivery', 'online'],
      default: 'cash_on_delivery',
    },
    paymentStatus: { type: String, enum: ['not_required', 'pending', 'paid', 'failed'], default: 'not_required' },
    paystackReference: { type: String, default: null, index: true },
    paidAt: { type: Date, default: null },
    status: { type: String, enum: ORDER_STATUSES, default: 'pending', index: true },
    // Every status change with its time (server clock), for the tracking page.
    statusHistory: [
      {
        _id: false,
        status: { type: String, enum: ORDER_STATUSES },
        at: { type: Date, default: Date.now },
      },
    ],
    // Live trip progress while a rider has the order (see utils/tripProgress.js):
    // { destination: 'store'|'customer', distanceKm, durationMin, line: [[lat,lng]...],
    //   riderLocation: {latitude, longitude, accuracy, at}, arrived, source, updatedAt, ... }
    trip: { type: mongoose.Schema.Types.Mixed, default: null },
    // Set when a delivery was confirmed without a map location to check against
    deliveredUnverified: { type: Boolean, default: false },
    acceptedAt: { type: Date, default: null },
    pickedUpAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },

    // ── Timers (see utils/orderTimers.js) ──────────────────────────────────
    // The store must accept (pending → preparing) by this time or the order
    // is cancelled. Set when the order can be worked on: at creation for
    // pay-on-delivery, when payment arrives for online orders.
    acceptDeadline: { type: Date, default: null, index: true },
    vendorRemindedAt: { type: Date, default: null },
    // The rider who accepted must pick up by this time or the job goes back
    // to other riders (unless they're already at the store).
    pickupDeadline: { type: Date, default: null, index: true },
    riderWarnedAt: { type: Date, default: null },
    // Riders whose time ran out on this order (they can't take it again).
    riderReleases: [
      {
        _id: false,
        riderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Rider' },
        at: { type: Date, default: Date.now },
      },
    ],

    // ── Alerts: something is running late (utils/orderAlerts.js) ───────────
    // Each type is raised at most once per order. Admin marks them handled.
    //   prep_late          past the usual prep time + grace → vendor nudged, customer told
    //   prep_very_late     much later still → admin alerted
    //   no_rider           nobody took the ready order → nearby online riders pinged
    //   no_rider_admin     still nobody → admin alerted
    //   no_rider_customer  still nobody → customer may cancel for a full refund
    //   delivery_stalled   picked up, but no rider location for a while or well
    //                      past the expected arrival → admin alerted (never reassigned)
    alerts: [
      {
        _id: false,
        type: { type: String },
        at: { type: Date, default: Date.now },
        message: { type: String, default: '' },
        resolvedAt: { type: Date, default: null },
        resolvedNote: { type: String, default: '' },
      },
    ],

    // ── The customer's rating, after delivery ──────────────────────────────
    rating: {
      storeStars: { type: Number, min: 1, max: 5, default: null },
      riderStars: { type: Number, min: 1, max: 5, default: null },
      comment: { type: String, default: '', maxlength: 500 },
      at: { type: Date, default: null },
    },

    // ── Cancellation ───────────────────────────────────────────────────────
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: String, enum: ['customer', 'vendor', 'admin', 'system', null], default: null },
    cancelReason: { type: String, default: '', maxlength: 300 },

    // ── Refunds (online payments; see utils/refunds.js) ────────────────────
    //   none       nothing to refund
    //   requesting we're asking Paystack right now
    //   pending    Paystack accepted the refund and is processing it
    //   processed  Paystack says the money has gone back
    //   failed     Paystack refused or errored — admin needs to retry or refund by hand
    //   manual     admin marked it refunded outside the app
    refundStatus: {
      type: String,
      enum: ['none', 'requesting', 'pending', 'processed', 'failed', 'manual'],
      default: 'none',
      index: true,
    },
    refundAmount: { type: Number, default: 0 },
    refundRequestedAt: { type: Date, default: null },
    refundedAt: { type: Date, default: null },
    refundError: { type: String, default: '' },
    refundNote: { type: String, default: '' },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: true } }
);

// Riders search for ready orders by pickup (store) location.
OrderSchema.index({ pickupCoordinates: '2dsphere' });

module.exports = mongoose.model('Order', OrderSchema);
module.exports.ORDER_STATUSES = ORDER_STATUSES;