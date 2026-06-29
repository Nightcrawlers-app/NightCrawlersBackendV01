const mongoose = require('mongoose');

const MenuItemSchema = new mongoose.Schema(
  {
    storeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', required: true, index: true },
    name: { type: String, required: true },
    categories: [{ type: String }],
    price: { type: Number, required: true },
    description: { type: String, default: '' },
    imageUrl: { type: String, required: true },
  },
  { timestamps: { createdAt: 'createdAt', updatedAt: true } }
);

module.exports = mongoose.model('MenuItem', MenuItemSchema);