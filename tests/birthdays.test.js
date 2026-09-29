/**
 * Birthday codes (utils/birthdays.js). Needs MongoDB, own database.
 */
const mongoose = require('mongoose');
const Promotion = require('../models/promotionModel');
const PersonalCode = require('../models/personalCodeModel');
const User = require('../models/userModel');
const { runBirthdays, lagosToday } = require('../utils/birthdays');

const DAY = 24 * 60 * 60 * 1000;

beforeAll(() => mongoose.connect(process.env.BIRTHDAYS_TEST_MONGODB_URI || 'mongodb://localhost:27017/nightcrawlers_birthdays_test'));
afterAll(() => mongoose.disconnect());
afterEach(() => Promise.all([Promotion.deleteMany({}), PersonalCode.deleteMany({}), User.deleteMany({})]));

const makeUser = (birthday, email = 'ada@test.com') =>
  User.collection.insertOne({ firstName: 'Ada', lastName: 'O', email, isVerified: true, birthday }).then((r) => r.insertedId);
const birthdayPromo = () =>
  Promotion.create({ title: 'Happy birthday', discountType: 'percent', discountValue: 15, maxDiscount: 2000, isCampaign: true, birthday: true, codeValidDays: 7 });

test('customers with a birthday today get one code, valid 7 days, once a year', async () => {
  const today = lagosToday();
  const promo = await birthdayPromo();
  const ada = await makeUser({ day: today.day, month: today.month });
  await makeUser({ day: today.day, month: (today.month % 12) + 1 }, 'notyet@test.com');

  expect(await runBirthdays({ force: true })).toBe(1);
  const codes = await PersonalCode.find({ promotionId: promo._id });
  expect(codes).toHaveLength(1);
  expect(String(codes[0].customerId)).toBe(String(ada));
  expect(codes[0].code).toMatch(/^ADA-HBD/);
  expect(Math.round((codes[0].expiresAt - Date.now()) / DAY)).toBe(7);

  expect(await runBirthdays({ force: true })).toBe(0); // not twice

  // A year later: same record refreshed with a new, unused code
  await PersonalCode.updateOne({ _id: codes[0]._id }, { $set: { issuedAt: new Date(Date.now() - 360 * DAY), usedAt: new Date() } });
  expect(await runBirthdays({ force: true })).toBe(1);
  const again = await PersonalCode.findById(codes[0]._id);
  expect(again.code).not.toBe(codes[0].code);
  expect(again.usedAt).toBeNull();
});

test('an expired birthday code is refused at checkout', async () => {
  const promo = await birthdayPromo();
  const ada = await makeUser({ day: 1, month: 1 });
  await PersonalCode.create({ promotionId: promo._id, customerId: ada, code: 'ADA-HBDXYZ', expiresAt: new Date(Date.now() - DAY) });
  const check = await promo.checkCode('ada-hbdxyz', ada);
  expect(check.reason).toMatch(/expired/);
});

test('nothing happens without a live birthday promo', async () => {
  const today = lagosToday();
  await makeUser({ day: today.day, month: today.month });
  expect(await runBirthdays({ force: true })).toBe(0);
});
