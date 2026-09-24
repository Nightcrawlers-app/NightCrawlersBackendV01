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

// Expose `id` alongside `_id` — the frontend cart keys items by `id`.
MenuItemSchema.set('toJSON', {
  virtuals: true,
  transform: (doc, ret) => {
    ret.id = String(ret._id);
    return ret;
  },
});

module.exports = mongoose.model('MenuItem', MenuItemSchema);