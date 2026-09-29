/**
 * Unit tests for promo codes, rewards and pricing maths — no database needed
 * (models are mocked), so these run anywhere: `npx jest tests/rewards.test.js`
 */
const mongoose = require('mongoose');

const storeId = new mongoose.Types.ObjectId();
const burgerId = new mongoose.Types.ObjectId();
jest.mock('../models/menuItemModel', () => ({ find: jest.fn() }));
const MenuItem = require('../models/menuItemModel');
const Promotion = require('../models/promotionModel');
const { priceOrder } = require('../utils/orderPricing');
const { applyRewards, pointsForSubtotal, makeReferralCode } = require('../utils/rewards');

const store = { _id: storeId, name: 'Test Kitchen', businessType: 'Food', coordinates: null };
const items = [{ menuItemId: String(burgerId), quantity: 2 }];

beforeEach(() => {
  delete process.env.DELIVERY_FEE;
  delete process.env.SERVICE_FEE_PERCENT;
  MenuItem.find.mockResolvedValue([{ _id: burgerId, name: 'Burger', price: 5000, categories: ['Burgers'] }]);
});

describe('applyRewards', () => {
  test('a free-delivery voucher covers the whole fee', () => {
    expect(applyRewards(800, { freeDeliveries: 1, deliveryCredit: 5000 })).toEqual({
      discount: 800, freeDeliveryUsed: true, deliveryCreditUsed: 0,
    });
  });
  test('credit covers what it can', () => {
    expect(applyRewards(800, { deliveryCredit: 300 })).toMatchObject({ discount: 300, deliveryCreditUsed: 300 });
    expect(applyRewards(800, { deliveryCredit: 5000 })).toMatchObject({ discount: 800, deliveryCreditUsed: 800 });
  });
  test('nothing owed → nothing used', () => {
    expect(applyRewards(0, { freeDeliveries: 3 })).toMatchObject({ discount: 0, freeDeliveryUsed: false });
  });
});

test('points: 1 per ₦100 of food by default', () => {
  expect(pointsForSubtotal(10000)).toBe(100);
  expect(pointsForSubtotal(199)).toBe(1);
});

test('referral codes are readable', () => {
  expect(makeReferralCode('Ada')).toMatch(/^ADA[A-HJ-NP-Z2-9]{4}$/);
  expect(makeReferralCode('')).toMatch(/^NC/);
});

describe('priceOrder', () => {
  test('no promo, no customer: flat fee + 5% service', async () => {
    const q = await priceOrder({ store, items });
    expect(q).toMatchObject({ subtotal: 10000, deliveryFee: 800, serviceFee: 500, discount: 0, rewardDiscount: 0, total: 11300 });
    expect(q.vendorEarning + q.riderEarning + q.platformEarning).toBe(q.total);
  });

  test('customer delivery credit comes off the delivery fee, platform pays', async () => {
    const customer = { _id: new mongoose.Types.ObjectId(), rewards: { deliveryCredit: 5000, freeDeliveries: 0 } };
    const q = await priceOrder({ store, items, customer });
    expect(q.rewardDiscount).toBe(800);
    expect(q.total).toBe(10500);
    expect(q.riderEarning).toBe(800); // rider still paid in full
    expect(q.vendorEarning + q.riderEarning + q.platformEarning).toBe(q.total);
  });

  test('rewards can be switched off', async () => {
    const customer = { _id: new mongoose.Types.ObjectId(), rewards: { freeDeliveries: 1 } };
    const q = await priceOrder({ store, items, customer, useRewards: false });
    expect(q.rewardDiscount).toBe(0);
  });

  test('code promos need the code', async () => {
    const promo = new Promotion({ title: '10% off', discountType: 'percent', discountValue: 10, code: 'NIGHT10' });
    jest.spyOn(Promotion, 'findById').mockResolvedValue(promo);
    const without = await priceOrder({ store, items, promotionId: String(promo._id), strictPromo: false });
    expect(without.discount).toBe(0);
    expect(without.promotion.reason).toMatch(/code/);
    const withCode = await priceOrder({ store, items, promotionId: String(promo._id), promoCode: 'night10', strictPromo: false });
    expect(withCode.discount).toBe(1000);
    await expect(priceOrder({ store, items, promotionId: String(promo._id) })).rejects.toThrow(/code/);
  });

  test('first-order promos need a signed-in customer', async () => {
    const promo = new Promotion({ title: 'Free delivery, first order', discountType: 'free_delivery', audience: 'new_customers' });
    jest.spyOn(Promotion, 'findById').mockResolvedValue(promo);
    const q = await priceOrder({ store, items, promotionId: String(promo._id), strictPromo: false });
    expect(q.promotion.reason).toMatch(/Sign in/);
  });

  test('free-delivery promo leaves nothing for rewards to cover', async () => {
    const promo = new Promotion({ title: 'Free delivery', discountType: 'free_delivery' });
    jest.spyOn(Promotion, 'findById').mockResolvedValue(promo);
    const customer = { _id: new mongoose.Types.ObjectId(), rewards: { freeDeliveries: 1 } };
    const q = await priceOrder({ store, items, promotionId: String(promo._id), customer });
    expect(q.discount).toBe(800);
    expect(q.rewardDiscount).toBe(0); // voucher kept for another order
    expect(q.rewards.freeDeliveryUsed).toBe(false);
  });

  test('a used-up promo is refused', async () => {
    const promo = new Promotion({ title: 'x', discountType: 'fixed', discountValue: 500, usageLimit: 3, timesUsed: 3 });
    jest.spyOn(Promotion, 'findById').mockResolvedValue(promo);
    const q = await priceOrder({ store, items, promotionId: String(promo._id), strictPromo: false });
    expect(q.promotion.reason).toMatch(/used up/);
  });
});

describe('codes tied to accounts', () => {
  const PersonalCode = require('../models/personalCodeModel');
  const ada = { _id: new mongoose.Types.ObjectId(), rewards: {} };
  const bola = { _id: new mongoose.Types.ObjectId(), rewards: {} };

  test('a code locked to one customer only works for them', async () => {
    const promo = new Promotion({ title: 'Sorry', discountType: 'fixed', discountValue: 1000, code: 'SORRY-ADA', customerIds: [ada._id] });
    jest.spyOn(Promotion, 'findById').mockResolvedValue(promo);
    const mine = await priceOrder({ store, items, promotionId: String(promo._id), promoCode: 'sorry-ada', customer: ada, strictPromo: false });
    expect(mine.discount).toBe(1000);
    const theirs = await priceOrder({ store, items, promotionId: String(promo._id), promoCode: 'SORRY-ADA', customer: bola, strictPromo: false });
    expect(theirs.promotion.reason).toMatch(/linked to your account/);
  });

  test('personal campaign codes: owner only, single use', async () => {
    const promo = new Promotion({ title: 'Win back', discountType: 'percent', discountValue: 20, isCampaign: true });
    jest.spyOn(Promotion, 'findById').mockResolvedValue(promo);
    const pc = { _id: new mongoose.Types.ObjectId(), promotionId: promo._id, customerId: ada._id, code: 'ADA-7K2Q', usedAt: null };
    jest.spyOn(PersonalCode, 'findOne').mockImplementation(async (f) => (f.code === pc.code ? pc : null));

    const ok = await priceOrder({ store, items, promotionId: String(promo._id), promoCode: 'ada-7k2q', customer: ada, strictPromo: false });
    expect(ok.discount).toBe(2000);
    expect(ok.personalCode.code).toBe('ADA-7K2Q');

    const wrongPerson = await priceOrder({ store, items, promotionId: String(promo._id), promoCode: 'ADA-7K2Q', customer: bola, strictPromo: false });
    expect(wrongPerson.promotion.reason).toMatch(/linked to your account/);

    pc.usedAt = new Date();
    const again = await priceOrder({ store, items, promotionId: String(promo._id), promoCode: 'ADA-7K2Q', customer: ada, strictPromo: false });
    expect(again.promotion.reason).toMatch(/already used/);
  });
});
