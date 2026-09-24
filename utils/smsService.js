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
const sendSms = async (to, message) => {
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
  generateCode,
  normalizePhone,
  sendSms,
  sendPhoneVerificationCode,
  sendPhoneVerifiedConfirmation,
};