const axios = require('axios');

const SENDCHAMP_BASE_URL = 'https://api.sendchamp.com/api/v1';

const sendchampClient = axios.create({
  baseURL: SENDCHAMP_BASE_URL,
  headers: {
    Authorization: `Bearer ${process.env.SENDCHAMP_API_KEY}`,
    'Content-Type': 'application/json',
  },
  timeout: 10000,
});

/**
 * Generates a 6-digit numeric OTP code.
 * Mirrors generateCode() in mailer.js for consistency.
 */
const generateCode = () => Math.floor(100000 + Math.random() * 900000).toString();

/**
 * Normalizes a Nigerian phone number to international format.
 * Accepts: 08012345678, +2348012345678, 2348012345678
 * Returns: 2348012345678
 */
const normalizePhone = (phone) => {
  if (!phone) return null;
  let cleaned = phone.replace(/[\s\-()]/g, '');

  if (cleaned.startsWith('+')) cleaned = cleaned.slice(1);
  if (cleaned.startsWith('0')) cleaned = '234' + cleaned.slice(1);
  if (!cleaned.startsWith('234')) cleaned = '234' + cleaned;

  return cleaned;
};

/**
 * Sends an SMS via Sendchamp.
 * Used internally — callers should prefer the specific send*Otp helpers below.
 */
/**
 * Which SMS company to use: SMS_PROVIDER=sendchamp (default) or termii.
 * Switch in .env and restart — no code changes needed.
 */
const smsProvider = () => (process.env.SMS_PROVIDER || 'sendchamp').toLowerCase();

const sendSms = async (to, message) =>
  smsProvider() === 'termii' ? sendViaTermii(to, message) : sendViaSendchamp(to, message);

/**
 * Termii. Needs TERMII_API_KEY and TERMII_SENDER_ID. TERMII_BASE_URL is the
 * account-specific address shown on your Termii dashboard (API settings).
 * OTPs must use the "dnd" channel with a sender ID Termii has approved for it.
 */
const sendViaTermii = async (to, message) => {
  const phone = normalizePhone(to);
  if (!process.env.TERMII_API_KEY) {
    throw new Error('SMS is not configured on the server (TERMII_API_KEY missing).');
  }
  const baseURL = (process.env.TERMII_BASE_URL || 'https://api.ng.termii.com').replace(/\/$/, '');
  let body;
  try {
    const response = await axios.post(
      `${baseURL}/api/sms/send`,
      {
        api_key: process.env.TERMII_API_KEY,
        to: phone,
        from: process.env.TERMII_SENDER_ID || 'N-Alert',
        sms: message,
        type: 'plain',
        channel: process.env.TERMII_CHANNEL || 'dnd',
      },
      { timeout: 10000 }
    );
    body = response.data;
  } catch (err) {
    const errMsg = err.response?.data?.message || err.message;
    console.error(`❌ SMS (termii) → ${phone} failed:`, JSON.stringify(err.response?.data || err.message));
    throw new Error(`Termii SMS failed: ${errMsg}`);
  }
  console.log(`📱 SMS (termii) → ${phone}: ${JSON.stringify({ ...body, user: undefined })}`);
  if (!body?.message_id) throw new Error(`Termii SMS failed: ${body?.message || 'no message id returned'}`);
  return body;
};

const sendViaSendchamp = async (to, message) => {
  const phone = normalizePhone(to);

  if (!process.env.SENDCHAMP_API_KEY) {
    throw new Error('SMS is not configured on the server (SENDCHAMP_API_KEY missing).');
  }

  let body;
  try {
    const response = await sendchampClient.post('/sms/send', {
      to: [phone], // Sendchamp requires an array, even for one number
      message,
      sender_name: process.env.SENDCHAMP_SENDER_NAME || 'Sendchamp',
      route: process.env.SENDCHAMP_ROUTE || 'dnd', // dnd reaches numbers on the Do-Not-Disturb list
    });
    body = response.data;
  } catch (err) {
    const errMsg = err.response?.data?.message || err.message;
    console.error(`❌ SMS → ${phone} failed:`, JSON.stringify(err.response?.data || err.message));
    throw new Error(`Sendchamp SMS failed: ${errMsg}`);
  }

  // Sendchamp can answer HTTP 200 and still not send (test key, empty wallet,
  // unapproved sender ID). Log the full reply so the reason is visible.
  const status = String(body?.data?.status || body?.status || '').toLowerCase();
  console.log(`📱 SMS → ${phone}: ${JSON.stringify(body)}`);
  if (['error', 'failed', 'rejected'].includes(status) || body?.code >= 400) {
    throw new Error(`Sendchamp SMS failed: ${body?.message || status}`);
  }
  return body;
};

/**
 * Sends a phone verification OTP code.
 * Generic — works for User, Vendor, or Rider.
 */
const sendPhoneVerificationCode = async (phone, code, firstName = '') => {
  const greeting = firstName ? `Hi ${firstName}, ` : '';
  const message = `${greeting}your NightCrawlers verification code is ${code}. It expires in 30 minutes. Do not share this code with anyone.`;

  // Local development only: print the code so you can finish the flow even
  // when the SMS doesn't arrive. Never runs in production.
  if (process.env.NODE_ENV !== 'production') {
    console.log(`🔑 [dev] phone code for ${normalizePhone(phone)}: ${code}`);
  }
  return sendSms(phone, message);
};

/**
 * Sends a notification that phone verification was successful.
 * Optional — purely a nice-to-have confirmation text.
 */
const sendPhoneVerifiedConfirmation = async (phone, firstName = '') => {
  const greeting = firstName ? `Hi ${firstName}, ` : '';
  const message = `${greeting}your phone number has been verified on NightCrawlers. You're all set!`;
  return sendSms(phone, message);
};

module.exports = {
  smsProvider,
  generateCode,
  normalizePhone,
  sendSms,
  sendPhoneVerificationCode,
  sendPhoneVerifiedConfirmation,
};