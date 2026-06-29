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
    customerLocation: { type: String, required: true },
    customerAddress: { type: String, required: true },
    riderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Rider', default: null, index: true },
    items: [OrderItemSchema],
    totalAmount: { type: Number, required: true },
    deliveryFee: { type: Number, required: true },
    status: { type: String, enum: ORDER_STATUSES, default: 'pending', index: true },
    acceptedAt: { type: Date, default: null },
    pickedUpAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: true } }
);

module.exports = mongoose.model('Order', OrderSchema);
module.exports.ORDER_STATUSES = ORDER_STATUSES;