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

  try {
    const response = await sendchampClient.post('/sms/send', {
      to: phone,
      message,
      sender_name: process.env.SENDCHAMP_SENDER_NAME || 'Sendchamp',
      route: 'dnd', // bypasses Do-Not-Disturb registry, recommended for OTPs in Nigeria
    });
    return response.data;
  } catch (err) {
    const errMsg = err.response?.data?.message || err.message;
    throw new Error(`Sendchamp SMS failed: ${errMsg}`);
  }
};

/**
 * Sends a phone verification OTP code.
 * Generic — works for User, Vendor, or Rider.
 */
const sendPhoneVerificationCode = async (phone, code, firstName = '') => {
  const greeting = firstName ? `Hi ${firstName}, ` : '';
  const message = `${greeting}your NightCrawlers verification code is ${code}. It expires in 10 minutes. Do not share this code with anyone.`;
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