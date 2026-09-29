/**
 * Loyalty: order points, delivery ("ride") credits, free-delivery vouchers
 * and referrals. Every number can be changed in .env — no code changes.
 *
 *   Points      Earned when an order is DELIVERED:
 *               POINTS_PER_100_NAIRA points for every ₦100 of food (default 1).
 *               Redeemed in blocks: POINTS_REDEEM_BLOCK points (default 100)
 *               → ₦POINTS_REDEEM_VALUE of delivery credit (default ₦500).
 *
 *   Delivery credit   Naira that can only pay for delivery fees. Used
 *               automatically at checkout unless the customer turns it off.
 *
 *   Free deliveries   Vouchers: one voucher waives one order's delivery fee.
 *
 *   Referrals   Every customer gets a code (e.g. "ADA7K2"). A friend who
 *               signs up with it gets REFERRAL_NEW_USER_FREE_DELIVERIES
 *               free deliveries (default 1). When that friend's FIRST order
 *               is delivered, the referrer is rewarded with either
 *                 REFERRAL_REWARD=free_delivery → 1 free delivery (default)
 *                 REFERRAL_REWARD=credit        → ₦REFERRAL_CREDIT_AMOUNT
 *                                                 delivery credit (default ₦5,000)
 *               Rewarding on the first delivered order (not on signup) stops
 *               people farming rewards with throwaway accounts.
 *
 * Rewards are funded by the platform: the rider is still paid the full
 * delivery fee; the platform's cut absorbs it.
 */
const crypto = require('crypto');

const num = (name, fallback) => {
  const raw = process.env[name];
  const v = Number(raw);
  return raw !== undefined && raw !== '' && Number.isFinite(v) ? v : fallback;
};

const rewardSettings = () => ({
  pointsPer100Naira: num('POINTS_PER_100_NAIRA', 1),
  redeemBlock: Math.max(1, num('POINTS_REDEEM_BLOCK', 100)),
  redeemValue: num('POINTS_REDEEM_VALUE', 500),
  referralReward: process.env.REFERRAL_REWARD === 'credit' ? 'credit' : 'free_delivery',
  referralCreditAmount: num('REFERRAL_CREDIT_AMOUNT', 5000),
  newUserFreeDeliveries: num('REFERRAL_NEW_USER_FREE_DELIVERIES', 1),
});

/** Points earned for a delivered order's food subtotal. */
const pointsForSubtotal = (subtotal) =>
  Math.max(0, Math.floor((Number(subtotal) || 0) / 100) * rewardSettings().pointsPer100Naira);

// No 0/O/1/I — codes are read aloud and typed on phones.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** "ADA" + 4 random characters, e.g. ADA7K2Q. */
const makeReferralCode = (firstName = '') => {
  const prefix = String(firstName).toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3) || 'NC';
  let tail = '';
  const bytes = crypto.randomBytes(4);
  for (const b of bytes) tail += ALPHABET[b % ALPHABET.length];
  return `${prefix}${tail}`;
};

/** Give the user a referral code if they don't have one yet (retries on the rare clash). */
const ensureReferralCode = async (user) => {
  if (user.referralCode) return user.referralCode;
  const User = user.constructor;
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = makeReferralCode(user.firstName);
    if (await User.exists({ referralCode: code })) continue;
    const saved = await User.findOneAndUpdate(
      { _id: user._id, $or: [{ referralCode: null }, { referralCode: { $exists: false } }] },
      { $set: { referralCode: code } },
      { new: true }
    );
    user.referralCode = saved?.referralCode || code;
    return user.referralCode;
  }
  throw new Error('Could not create a referral code. Please try again.');
};

/**
 * How much of the delivery fee the customer's rewards cover.
 *   deliveryDue — delivery fee still owed after any promo
 *   balances    — the user's `rewards` ({ freeDeliveries, deliveryCredit })
 * A free-delivery voucher is used first (it covers the whole fee); otherwise
 * delivery credit covers as much as it can.
 */
const applyRewards = (deliveryDue, balances = {}) => {
  const none = { discount: 0, freeDeliveryUsed: false, deliveryCreditUsed: 0 };
  if (!(deliveryDue > 0)) return none;
  if ((balances.freeDeliveries || 0) >= 1) {
    return { discount: deliveryDue, freeDeliveryUsed: true, deliveryCreditUsed: 0 };
  }
  const credit = Math.min(Math.max(0, balances.deliveryCredit || 0), deliveryDue);
  if (credit > 0) return { discount: credit, freeDeliveryUsed: false, deliveryCreditUsed: credit };
  return none;
};

/**
 * Take the rewards an order uses off the customer's balance — atomically, so
 * two orders placed at once can't both spend the same voucher. Returns false
 * if the balance changed since the quote.
 */
const spendRewards = async (User, userId, { freeDeliveryUsed, deliveryCreditUsed }) => {
  if (!freeDeliveryUsed && !(deliveryCreditUsed > 0)) return true;
  const filter = { _id: userId };
  const inc = {};
  if (freeDeliveryUsed) {
    filter['rewards.freeDeliveries'] = { $gte: 1 };
    inc['rewards.freeDeliveries'] = -1;
  }
  if (deliveryCreditUsed > 0) {
    filter['rewards.deliveryCredit'] = { $gte: deliveryCreditUsed };
    inc['rewards.deliveryCredit'] = -deliveryCreditUsed;
  }
  const res = await User.updateOne(filter, { $inc: inc });
  return res.modifiedCount === 1;
};

/** Put rewards back (order cancelled, or it failed to save). */
const refundRewards = async (User, userId, { freeDeliveryUsed, deliveryCreditUsed }) => {
  const inc = {};
  if (freeDeliveryUsed) inc['rewards.freeDeliveries'] = 1;
  if (deliveryCreditUsed > 0) inc['rewards.deliveryCredit'] = deliveryCreditUsed;
  if (Object.keys(inc).length) await User.updateOne({ _id: userId }, { $inc: inc });
};

/**
 * Called once when an order becomes 'delivered': award points, and reward
 * the referrer if this is the referred customer's first delivered order.
 * Never throws — a rewards hiccup must not block a delivery.
 */
const onOrderDelivered = async (order) => {
  try {
    if (!order.customerId || order.pointsAwarded) return;
    const User = require('../models/userModel');
    const Order = require('../models/orderModel');

    const points = pointsForSubtotal(order.totalAmount);
    order.pointsEarned = points;
    order.pointsAwarded = true;
    if (points > 0) await User.updateOne({ _id: order.customerId }, { $inc: { 'rewards.points': points } });

    const customer = await User.findById(order.customerId, 'referredBy referralRewarded');
    if (!customer?.referredBy || customer.referralRewarded) return;
    const earlier = await Order.countDocuments({
      customerId: order.customerId,
      status: 'delivered',
      _id: { $ne: order._id },
    });
    if (earlier > 0) return;

    // Mark first so a retry can't pay the referrer twice.
    const claimed = await User.updateOne(
      { _id: customer._id, referralRewarded: { $ne: true } },
      { $set: { referralRewarded: true } }
    );
    if (claimed.modifiedCount !== 1) return;

    const s = rewardSettings();
    const inc =
      s.referralReward === 'credit'
        ? { 'rewards.deliveryCredit': s.referralCreditAmount }
        : { 'rewards.freeDeliveries': 1 };
    await User.updateOne({ _id: customer.referredBy }, { $inc: inc });
  } catch (err) {
    console.error('Rewards on delivery failed:', err.message);
  }
};

module.exports = {
  rewardSettings,
  pointsForSubtotal,
  makeReferralCode,
  ensureReferralCode,
  applyRewards,
  spendRewards,
  refundRewards,
  onOrderDelivered,
};
