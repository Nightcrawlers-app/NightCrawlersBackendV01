/**
 * Order timers & refunds, against a real MongoDB (CI provides one; locally
 * run `mongod` or point MONGODB_URI at a test database — never production).
 *
 *   npx jest tests/orderTimers.test.js
 */
const mongoose = require('mongoose');

jest.mock('../utils/smsService', () => ({ sendSms: jest.fn().mockResolvedValue({}), normalizePhone: (p) => p }));
jest.mock('../utils/paystackPayments', () => ({
  createRefund: jest.fn().mockResolvedValue({ status: 'pending', alreadyRefunded: false }),
  initializeTransaction: jest.fn(),
  verifyTransaction: jest.fn(),
  isValidWebhookSignature: jest.fn(),
}));

const Order = require('../models/orderModel');
const Rider = require('../models/riderModel');
const { runOrderTimers, pickupDeadlineFor, riderIsAtStore } = require('../utils/orderTimers');
const { refundOrder, applyRefundWebhook } = require('../utils/refunds');
const paystack = require('../utils/paystackPayments');

const MIN = 60 * 1000;
const ago = (m) => new Date(Date.now() - m * MIN);
const fromNow = (m) => new Date(Date.now() + m * MIN);
const STORE = { type: 'Point', coordinates: [7.48, 9.07] }; // [lng, lat], Abuja

const makeOrder = (over = {}) =>
  Order.create({
    storeId: new mongoose.Types.ObjectId(),
    storeName: 'Test Kitchen',
    vendorId: new mongoose.Types.ObjectId(),
    customerName: 'Ada',
    customerPhone: '+2348000000000',
    customerAddress: '12 Test Street',
    items: [{ name: 'Jollof', quantity: 1, price: 4000 }],
    totalAmount: 4000,
    deliveryFee: 800,
    totalPaid: 5000,
    pickupCoordinates: STORE,
    ...over,
  });

const makeRider = (over = {}) =>
  Rider.create({
    firstName: 'Bayo',
    lastName: 'R',
    vehicleType: 'bike',
    email: `r${Math.random()}@test.com`,
    password: 'x',
    location: 'Abuja',
    ...over,
  });

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  // Its own database, so it can't clash with api.test.js running alongside.
  await mongoose.connect(process.env.TIMERS_TEST_MONGODB_URI || 'mongodb://localhost:27017/nightcrawlers_timers_test');
});
afterAll(() => mongoose.disconnect());
afterEach(async () => {
  await Promise.all([Order.deleteMany({}), Rider.deleteMany({})]);
  jest.clearAllMocks();
});

describe('store must accept in time', () => {
  test('past the deadline → cancelled by the system, paid order refunded', async () => {
    const o = await makeOrder({ paymentMethod: 'online', paymentStatus: 'paid', paystackReference: 'NC-1', acceptDeadline: ago(1) });
    await runOrderTimers();
    const after = await Order.findById(o._id);
    expect(after.status).toBe('cancelled');
    expect(after.cancelledBy).toBe('system');
    expect(after.cancelReason).toMatch(/didn't respond/);
    expect(after.refundStatus).toBe('pending');
    expect(paystack.createRefund).toHaveBeenCalledTimes(1);
  });

  test('cash order past the deadline → cancelled, nothing to refund', async () => {
    const o = await makeOrder({ acceptDeadline: ago(1) });
    await runOrderTimers();
    const after = await Order.findById(o._id);
    expect(after.status).toBe('cancelled');
    expect(after.refundStatus).toBe('none');
    expect(paystack.createRefund).not.toHaveBeenCalled();
  });

  test('already accepted → left alone', async () => {
    const o = await makeOrder({ status: 'preparing', acceptDeadline: ago(1) });
    await runOrderTimers();
    expect((await Order.findById(o._id)).status).toBe('preparing');
  });

  test('reminder once, about 5 minutes before the deadline', async () => {
    const o = await makeOrder({ acceptDeadline: fromNow(4) });
    await runOrderTimers();
    await runOrderTimers();
    const after = await Order.findById(o._id);
    expect(after.status).toBe('pending');
    expect(after.vendorRemindedAt).not.toBeNull();
  });

  test('old orders without a deadline are not touched', async () => {
    const o = await makeOrder();
    await runOrderTimers();
    expect((await Order.findById(o._id)).status).toBe('pending');
  });
});

test('unpaid online orders expire and give back what they held', async () => {
  const o = await makeOrder({ paymentMethod: 'online', paymentStatus: 'pending' });
  await Order.collection.updateOne({ _id: o._id }, { $set: { createdAt: ago(31) } }); // createdAt is read-only in Mongoose
  await runOrderTimers();
  const after = await Order.findById(o._id);
  expect(after.status).toBe('cancelled');
  expect(after.cancelReason).toMatch(/Payment/);
  expect(paystack.createRefund).not.toHaveBeenCalled();
});

describe('rider must pick up in time', () => {
  test('deadline passed, rider away → job released to other riders', async () => {
    const rider = await makeRider();
    const o = await makeOrder({ status: 'accepted', riderId: rider._id, acceptedAt: ago(30), pickupDeadline: ago(1) });
    await runOrderTimers();
    const after = await Order.findById(o._id);
    expect(after.status).toBe('ready');
    expect(after.riderId).toBeNull();
    expect(after.riderReleases.map((r) => String(r.riderId))).toEqual([String(rider._id)]);
    expect((await Rider.findById(rider._id)).releasedJobs).toBe(1);
  });

  test('rider already at the store → keeps the job', async () => {
    const rider = await makeRider({ coordinates: STORE, locationUpdatedAt: new Date() });
    const o = await makeOrder({ status: 'accepted', riderId: rider._id, acceptedAt: ago(30), pickupDeadline: ago(1) });
    await runOrderTimers();
    expect((await Order.findById(o._id)).status).toBe('accepted');
  });

  test('already picked up → never released', async () => {
    const rider = await makeRider();
    const o = await makeOrder({ status: 'picked_up', riderId: rider._id, pickupDeadline: ago(5) });
    await runOrderTimers();
    expect(String((await Order.findById(o._id)).riderId)).toBe(String(rider._id));
  });

  test('deadline = ride time + buffer, within 15–45 min', () => {
    const far = { coordinates: { type: 'Point', coordinates: [7.3, 9.2] }, locationUpdatedAt: new Date() };
    const near = { coordinates: STORE, locationUpdatedAt: new Date() };
    const mins = (d) => Math.round((d - Date.now()) / MIN);
    expect(mins(pickupDeadlineFor({ pickupCoordinates: STORE }, near))).toBe(15);
    expect(mins(pickupDeadlineFor({ pickupCoordinates: STORE }, far))).toBeGreaterThan(15);
    expect(mins(pickupDeadlineFor({ pickupCoordinates: STORE }, far))).toBeLessThanOrEqual(45);
    expect(riderIsAtStore({ pickupCoordinates: STORE }, near)).toBe(true);
  });
});

describe('refunds', () => {
  test('only one refund even if asked twice at once', async () => {
    const o = await makeOrder({ status: 'cancelled', paymentMethod: 'online', paymentStatus: 'paid', paystackReference: 'NC-2' });
    await Promise.all([refundOrder(o._id, 'x'), refundOrder(o._id, 'x')]);
    expect(paystack.createRefund).toHaveBeenCalledTimes(1);
  });

  test('a Paystack error is recorded for admin to retry', async () => {
    paystack.createRefund.mockRejectedValueOnce(new Error('Paystack: network down'));
    const o = await makeOrder({ status: 'cancelled', paymentMethod: 'online', paymentStatus: 'paid', paystackReference: 'NC-3' });
    const after = await refundOrder(o._id, 'x');
    expect(after.refundStatus).toBe('failed');
    expect(after.refundError).toMatch(/network down/);
    const retried = await refundOrder(o._id, 'x');
    expect(retried.refundStatus).toBe('pending');
  });

  test('webhook marks it processed', async () => {
    await makeOrder({ status: 'cancelled', paymentMethod: 'online', paymentStatus: 'paid', paystackReference: 'NC-4', refundStatus: 'pending' });
    await applyRefundWebhook('refund.processed', { transaction_reference: 'NC-4' });
    expect((await Order.findOne({ paystackReference: 'NC-4' })).refundStatus).toBe('processed');
  });
});
