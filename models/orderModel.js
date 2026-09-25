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
    acceptedAt: { type: Date, default: null },
    pickedUpAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: true } }
);

// Riders search for ready orders by pickup (store) location.
OrderSchema.index({ pickupCoordinates: '2dsphere' });

module.exports = mongoose.model('Order', OrderSchema);
module.exports.ORDER_STATUSES = ORDER_STATUSES;