const axios = require('axios');
const crypto = require('crypto');

/**
 * Paystack online payments (card, bank transfer, USSD — whatever Paystack
 * offers the customer on its hosted checkout page).
 *
 * Uses PAYSTACK_API_KEY, the SECRET key. With a test key (sk_test_…) nothing
 * is really charged: use Paystack's test cards, e.g. 4084 0840 8408 4081,
 * any future expiry, CVV 408, PIN 0000, OTP 123456.
 */
const client = () =>
  axios.create({
    baseURL: 'https://api.paystack.co',
    headers: { Authorization: `Bearer ${process.env.PAYSTACK_API_KEY}`, 'Content-Type': 'application/json' },
    timeout: 15000,
  });

const paystackError = (err) =>
  new Error(`Paystack: ${err.response?.data?.message || err.message}`);

/** Start a payment. Amount in naira; Paystack wants kobo. */
const initializeTransaction = async ({ email, amountNaira, reference, callbackUrl, metadata }) => {
  try {
    const { data } = await client().post('/transaction/initialize', {
      email,
      amount: Math.round(amountNaira * 100),
      currency: 'NGN',
      reference,
      callback_url: callbackUrl,
      metadata,
    });
    return { authorizationUrl: data.data.authorization_url, reference: data.data.reference };
  } catch (err) {
    throw paystackError(err);
  }
};

/** Ask Paystack what actually happened. Never trust the redirect alone. */
const verifyTransaction = async (reference) => {
  try {
    const { data } = await client().get(`/transaction/verify/${encodeURIComponent(reference)}`);
    const t = data.data;
    return { status: t.status, amountNaira: t.amount / 100, currency: t.currency, reference: t.reference, paidAt: t.paid_at };
  } catch (err) {
    throw paystackError(err);
  }
};

/** Webhooks are signed with HMAC-SHA512 of the raw body using the secret key. */
const isValidWebhookSignature = (rawBody, signature) => {
  if (!rawBody || !signature || !process.env.PAYSTACK_API_KEY) return false;
  const expected = crypto.createHmac('sha512', process.env.PAYSTACK_API_KEY).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

module.exports = { initializeTransaction, verifyTransaction, isValidWebhookSignature };
