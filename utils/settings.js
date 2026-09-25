/**
 * Switches read from .env, in one place so every route agrees.
 */
const { SERVICE_FEE_PERCENT } = require('./orderPricing');
const { deliveryFeeSettings } = require('./deliveryFee');

/**
 * REQUIRE_PHONE_VERIFICATION=false turns off the phone requirement for
 * placing orders and for admin approval. Meant as a temporary switch while
 * SMS delivery isn't working — leave it unset (on) normally.
 */
const phoneVerificationRequired = () => process.env.REQUIRE_PHONE_VERIFICATION !== 'false';

/** Online card payments are available when a Paystack secret key is set. */
const onlinePaymentsEnabled = () => Boolean(process.env.PAYSTACK_API_KEY);

/** Safe-to-share settings the frontend needs (no secrets!). */
const publicConfig = () => ({
  requirePhoneVerification: phoneVerificationRequired(),
  onlinePayments: onlinePaymentsEnabled(),
  paystackTestMode: /^sk_test_/.test(process.env.PAYSTACK_API_KEY || ''),
  // How delivery is priced (for display, e.g. "₦500 + ₦150/km after 2 km")
  delivery: (({ baseFee, perKm, includedKm, minFee, maxFee, maxKm }) => ({ baseFee, perKm, includedKm, minFee, maxFee, maxKm }))(deliveryFeeSettings()),
  serviceFeePercent: SERVICE_FEE_PERCENT(),
});

module.exports = { phoneVerificationRequired, onlinePaymentsEnabled, publicConfig };
