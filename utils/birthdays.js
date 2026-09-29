/**
 * Birthday codes. For every live promo marked "birthday" (a personal-code
 * campaign), each customer whose birthday is today (Nigerian time) gets their
 * own single-use code, valid for the promo's codeValidDays (default 7), plus
 * an email and an SMS.
 *
 *   - At most one birthday code per customer per ~year (the same record is
 *     refreshed with a new code each year, so last year's leftover can't be used).
 *   - 29 February birthdays are celebrated on 28 February in other years.
 *   - Runs from the order timer loop but does real work at most once an hour.
 *   - BIRTHDAY_SMS=false turns the SMS off (email still goes).
 */
const Promotion = require('../models/promotionModel');
const PersonalCode = require('../models/personalCodeModel');
const User = require('../models/userModel');

const DAY = 24 * 60 * 60 * 1000;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Today's day/month in Nigeria (UTC+1, no daylight saving). */
const lagosToday = (now = new Date()) => {
  const d = new Date(now.getTime() + 60 * 60 * 1000);
  return { day: d.getUTCDate(), month: d.getUTCMonth() + 1, year: d.getUTCFullYear() };
};
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** Birthdays to celebrate today (adds 29 Feb on 28 Feb in non-leap years). */
const birthdaysToday = (now = new Date()) => {
  const t = lagosToday(now);
  const days = [{ day: t.day, month: t.month }];
  if (t.month === 2 && t.day === 28 && !isLeap(t.year)) days.push({ day: 29, month: 2 });
  return days;
};

const makeCode = (firstName) => {
  const prefix = String(firstName || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3) || 'NC';
  let tail = '';
  for (const b of require('crypto').randomBytes(4)) tail += ALPHABET[b % ALPHABET.length];
  return `${prefix}-HBD${tail.slice(0, 3)}`;
};

const describeOffer = (p) =>
  p.discountType === 'percent'
    ? `${p.discountValue}% off your order${p.maxDiscount ? ` (up to ₦${p.maxDiscount.toLocaleString()})` : ''}`
    : p.discountType === 'fixed'
      ? `₦${p.discountValue.toLocaleString()} off your order`
      : 'Free delivery on your order';

/** Give one customer their birthday code for one promo. Returns the code, or null if they already had one this year. */
const giveBirthdayCode = async (promo, user, now = new Date()) => {
  const expiresAt = new Date(now.getTime() + (promo.codeValidDays || 7) * DAY);
  const recent = new Date(now.getTime() - 300 * DAY); // "this year", with slack
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = makeCode(user.firstName);
    if (await Promotion.exists({ code })) continue;
    try {
      const existing = await PersonalCode.findOne({ promotionId: promo._id, customerId: user._id });
      if (existing) {
        if (existing.issuedAt && existing.issuedAt > recent) return null; // already had this year's
        const updated = await PersonalCode.findOneAndUpdate(
          { _id: existing._id, issuedAt: existing.issuedAt },
          { $set: { code, usedAt: null, orderId: null, emailedAt: null, expiresAt, issuedAt: now } },
          { new: true }
        );
        return updated ? updated.code : null;
      }
      const created = await PersonalCode.create({ promotionId: promo._id, customerId: user._id, code, expiresAt, issuedAt: now });
      return created.code;
    } catch (err) {
      if (err.code !== 11000) throw err;
      if (await PersonalCode.exists({ promotionId: promo._id, customerId: user._id, issuedAt: { $gt: recent } })) return null;
      // else: code clash — try another
    }
  }
  return null;
};

const tellCustomer = async (promo, user, code, expiresAt) => {
  if (process.env.NODE_ENV === 'test') return;
  try {
    await require('./mailer').sendPersonalCodeEmail(user.email, user.firstName, {
      code,
      title: `Happy birthday, ${user.firstName}! 🎂`,
      offer: describeOffer(promo),
      expires: expiresAt,
    });
    await PersonalCode.updateOne({ code }, { $set: { emailedAt: new Date() } });
  } catch (err) {
    console.error(`Birthday email to ${user.email} failed:`, err.message);
  }
  if (process.env.BIRTHDAY_SMS !== 'false' && user.phone) {
    try {
      await require('./smsService').sendSms(
        user.phone,
        `Happy birthday from Nightcrawlers, ${user.firstName}! 🎂 ${describeOffer(promo)} with code ${code}, valid for ${promo.codeValidDays || 7} days.`
      );
    } catch (err) {
      console.error(`Birthday SMS to ${user.phone} failed:`, err.message);
    }
  }
};

let lastRun = 0;
/** Hand out today's birthday codes. `force` skips the once-an-hour limit (tests). */
const runBirthdays = async ({ now = new Date(), force = false } = {}) => {
  if (!force && now.getTime() - lastRun < 60 * 60 * 1000) return 0;
  lastRun = now.getTime();
  const promos = await Promotion.findLive(now).where({ isCampaign: true, birthday: true });
  if (!promos.length) return 0;
  const users = await User.find(
    { isVerified: true, $or: birthdaysToday(now).map((b) => ({ 'birthday.day': b.day, 'birthday.month': b.month })) },
    'firstName email phone'
  ).limit(5000);
  let given = 0;
  for (const promo of promos) {
    for (const user of users) {
      const code = await giveBirthdayCode(promo, user, now);
      if (!code) continue;
      given++;
      console.log(`[${now.toISOString()}] 🎂 birthday code ${code} for ${user.email}`);
      await tellCustomer(promo, user, code, new Date(now.getTime() + (promo.codeValidDays || 7) * DAY));
    }
  }
  return given;
};

module.exports = { runBirthdays, giveBirthdayCode, birthdaysToday, lagosToday };
