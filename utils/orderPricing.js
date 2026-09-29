const mongoose = require('mongoose');
const MenuItem = require('../models/menuItemModel');
const Promotion = require('../models/promotionModel');
const { deliveryFeeFor } = require('./deliveryFee');
const { fromPoint } = require('./geocoder');
const { applyRewards } = require('./rewards');

/**
 * The ONE place an order's money is worked out. Used both to show the
 * customer a quote at checkout and to create the order, so the two can
 * never disagree — and nothing the browser sends is trusted except which
 * items, how many, and which promo.
 *
 *   subtotal    = Σ menu price × quantity          (prices from the database)
 *   deliveryFee = by distance store → customer (utils/deliveryFee.js);
 *                 flat DELIVERY_FEE if either location is unknown
 *   serviceFee  = SERVICE_FEE_PERCENT of subtotal  (default 5%, rounded)
 *   discount    = promo, if eligible
 *   rewardDiscount = free-delivery voucher or delivery credit (signed-in
 *                 customers, delivery fee only — see utils/rewards.js)
 *   total       = subtotal + deliveryFee + serviceFee − discount − rewardDiscount
 */
// Flat fee used only when the distance can't be worked out (see deliveryFee.js).
const DELIVERY_FEE = () => Number(process.env.DELIVERY_FEE ?? 800);
const SERVICE_FEE_PERCENT = () => Number(process.env.SERVICE_FEE_PERCENT ?? 5);
const MAX_QUANTITY = 50;

class PricingError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.status = 400;
    this.extra = extra;
  }
}

/**
 * @param {object} args
 * @param {object} args.store        Store document
 * @param {Array}  args.items        [{ menuItemId | id, quantity }]
 * @param {string} [args.promotionId]
 * @param {{latitude:number, longitude:number}|null} [args.deliveryPoint] where it's going
 * @param {boolean} [args.strictPromo] true when placing the order: an invalid
 *        promo is an error. false for quotes: it's reported, not thrown.
 * @param {string} [args.promoCode]   the code typed, for promos that need one
 * @param {object|null} [args.customer] signed-in customer (User doc), or null for guests
 * @param {boolean} [args.useRewards] spend the customer's free deliveries / delivery credit
 */
const priceOrder = async ({
  store,
  items,
  promotionId,
  promoCode = null,
  deliveryPoint = null,
  strictPromo = true,
  customer = null,
  useRewards = true,
}) => {
  if (!Array.isArray(items) || !items.length) throw new PricingError('Your cart is empty.');

  const lines = items.map((raw) => ({
    menuItemId: String(raw?.menuItemId ?? raw?.id ?? ''),
    quantity: Number(raw?.quantity),
  }));
  for (const l of lines) {
    if (!mongoose.isValidObjectId(l.menuItemId)) {
      throw new PricingError("Your cart has an item we don't recognise. Please remove it and add it again.", { cartInvalid: true });
    }
    if (!Number.isInteger(l.quantity) || l.quantity < 1 || l.quantity > MAX_QUANTITY) {
      throw new PricingError(`Quantity must be a whole number from 1 to ${MAX_QUANTITY}.`);
    }
  }

  const menuItems = await MenuItem.find({ _id: { $in: lines.map((l) => l.menuItemId) }, storeId: store._id });
  const byId = new Map(menuItems.map((m) => [String(m._id), m]));
  const missing = lines.filter((l) => !byId.has(l.menuItemId));
  if (missing.length) {
    throw new PricingError('Some items in your cart are no longer on this menu. Please refresh and try again.', {
      cartInvalid: true,
      missingItemIds: missing.map((l) => l.menuItemId),
    });
  }

  const orderItems = lines.map((l) => {
    const m = byId.get(l.menuItemId);
    return { menuItemId: m._id, name: m.name, price: m.price, quantity: l.quantity, categories: m.categories || [] };
  });

  const subtotal = orderItems.reduce((sum, i) => sum + i.price * i.quantity, 0);
  const storePoint = store.coordinates?.coordinates?.length === 2 ? fromPoint(store.coordinates) : null;
  const delivery = deliveryFeeFor(storePoint, deliveryPoint);
  if (delivery.tooFar) {
    throw new PricingError(
      `${store.name} is about ${Math.round(delivery.distanceKm)} km away — we deliver up to ${delivery.maxKm} km. Try a store closer to you.`,
      { tooFar: true, distanceKm: delivery.distanceKm }
    );
  }
  const deliveryFee = delivery.fee;
  const serviceFee = Math.round((subtotal * SERVICE_FEE_PERCENT()) / 100);

  let promo = null;
  let personalCode = null; // campaign promos: this customer's own code (PersonalCode doc)
  let promotion = null; // what the customer sees about the promo
  let discount = 0;
  if (promotionId) {
    promo = mongoose.isValidObjectId(promotionId) ? await Promotion.findById(promotionId) : null;
    let result = promo
      ? promo.quote({ store, subtotal, deliveryFee, items: orderItems })
      : { eligible: false, discount: 0, reason: 'That promo no longer exists.' };
    // Code promos only work with the (right person's) code; some depend on who's ordering.
    if (result.eligible) {
      require('../models/personalCodeModel'); // registers the model used by checkCode
      const check = await promo.checkCode(promoCode, customer?._id ?? null);
      if (check.reason) result = { eligible: false, discount: 0, reason: check.reason };
      else personalCode = check.personalCode;
    }
    if (result.eligible) {
      const reason = await promo.customerIneligibleReason(customer?._id ?? null);
      if (reason) result = { eligible: false, discount: 0, reason };
    }
    if (!result.eligible && strictPromo) {
      throw new PricingError(result.reason, { promotionInvalid: true });
    }
    discount = result.eligible ? result.discount : 0;
    promotion = { id: promotionId, title: promo?.title ?? null, ...result };
    if (!result.eligible) promo = null;
  }

  // ── Loyalty rewards: only against whatever delivery fee is still owed ─────
  const promoCoversDelivery = promo?.discountType === 'free_delivery' ? discount : 0;
  const deliveryDue = Math.max(0, deliveryFee - promoCoversDelivery);
  const rewardBalances = {
    freeDeliveries: customer?.rewards?.freeDeliveries || 0,
    deliveryCredit: customer?.rewards?.deliveryCredit || 0,
  };
  const rewards = customer && useRewards
    ? applyRewards(deliveryDue, rewardBalances)
    : { discount: 0, freeDeliveryUsed: false, deliveryCreditUsed: 0 };
  const rewardDiscount = rewards.discount;

  // ── Who gets what ─────────────────────────────────────────────────────────
  // Vendor: the food subtotal, minus the discount only if the VENDOR funds it.
  // Rider:  the delivery fee, always (free delivery is paid by whoever funds the promo).
  // Platform: the service fee, minus the discount if the PLATFORM funds it.
  const vendorFunded = promo?.fundedBy === 'vendor';
  const vendorEarning = subtotal - (vendorFunded ? discount : 0);
  const riderEarning = deliveryFee;
  // Rewards are always platform-funded; the rider still gets the full fee.
  const platformEarning = serviceFee - (vendorFunded ? 0 : discount) - rewardDiscount;

  return {
    vendorEarning,
    riderEarning,
    platformEarning,
    items: orderItems,
    subtotal,
    deliveryFee,
    distanceKm: delivery.distanceKm, // null when the fee is the flat fallback
    serviceFee,
    serviceFeePercent: SERVICE_FEE_PERCENT(),
    discount,
    rewardDiscount,
    rewards: {
      ...rewards,
      // What the customer has, so checkout can offer the switch
      available: customer ? rewardBalances : null,
      applied: Boolean(customer && useRewards),
    },
    total: Math.max(0, subtotal + deliveryFee + serviceFee - discount - rewardDiscount),
    promotion,
    promo, // the document, for recording on the order (not sent to clients)
    personalCode: promo ? personalCode : null, // likewise
  };
};

module.exports = { priceOrder, PricingError, DELIVERY_FEE, SERVICE_FEE_PERCENT };
