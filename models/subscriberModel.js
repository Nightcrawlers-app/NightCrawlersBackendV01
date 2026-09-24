const mongoose = require('mongoose');
const crypto = require('crypto');

const SubscriberSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 254 },
    status: { type: String, enum: ['subscribed', 'unsubscribed'], default: 'subscribed' },
    // Random token for one-click unsubscribe links
    unsubscribeToken: {
      type: String,
      default: () => crypto.randomBytes(24).toString('hex'),
      index: true,
    },
    source: { type: String, default: 'website' },
    subscribedAt: { type: Date, default: Date.now },
    unsubscribedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Subscriber', SubscriberSchema);
