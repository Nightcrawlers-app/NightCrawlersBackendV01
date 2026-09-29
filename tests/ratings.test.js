/**
 * Ratings and per-store delivery estimates. Needs MongoDB (like api.test.js),
 * in its own database so it can't clash with the other test files.
 */
const mongoose = require('mongoose');
const request = require('supertest');

let app, Order, Store, Rider, signToken;
const ago = (m) => new Date(Date.now() - m * 60 * 1000);

beforeAll(async () => {
  process.env.MONGODB_URI = process.env.RATINGS_TEST_MONGODB_URI || 'mongodb://localhost:27017/nightcrawlers_ratings_test';
  process.env.JWT_SECRET = 'test_secret';
  app = require('../app');
  ({ signToken } = require('../utils/signToken'));
  Order = require('../models/orderModel');
  Store = require('../models/storeModel');
  Rider = require('../models/riderModel');
  if (mongoose.connection.readyState !== 1) await mongoose.connection.asPromise();
});
afterAll(() => mongoose.disconnect());
afterEach(() => Promise.all([Order.deleteMany({}), Store.deleteMany({}), Rider.deleteMany({})]));

const setup = async (orderOver = {}) => {
  const customerId = new mongoose.Types.ObjectId();
  const store = await Store.create({ vendorId: new mongoose.Types.ObjectId(), name: 'Test Kitchen', businessType: 'Food', address: 'Wuse 2', imageUrl: 'https://x.test/a.png' });
  const rider = await Rider.create({ firstName: 'Bayo', vehicleType: 'bike', email: `r${Date.now()}@t.com`, password: 'x', location: 'Abuja' });
  const order = await Order.create({
    storeId: store._id, storeName: store.name, vendorId: store.vendorId, customerId, riderId: rider._id,
    customerName: 'Ada', customerPhone: '+234', customerAddress: 'x',
    items: [{ name: 'Jollof', quantity: 1, price: 4000 }], totalAmount: 4000, deliveryFee: 800,
    status: 'delivered', deliveredAt: ago(30), ...orderOver,
  });
  return { order, store, rider, token: signToken(String(customerId), 'customer') };
};
const rate = (id, token, body) => request(app).post(`/api/orders/${id}/rate`).set('Authorization', `Bearer ${token}`).send(body);

test('rating a delivered order updates the store and rider, once', async () => {
  const { order, store, rider, token } = await setup();
  const res = await rate(order._id, token, { storeStars: 4, riderStars: 5, comment: 'Hot and fast' });
  expect(res.status).toBe(200);
  expect((await rate(order._id, token, { storeStars: 1 })).status).toBe(409);
  const s = await Store.findById(store._id);
  expect([s.ratingSum, s.ratingCount]).toEqual([4, 1]);
  const r = await Rider.findById(rider._id);
  expect([r.ratingSum, r.ratingCount]).toEqual([5, 1]);
});

test('only the customer, only delivered, only within 7 days, stars 1–5', async () => {
  const { order, token } = await setup();
  const stranger = signToken(String(new mongoose.Types.ObjectId()), 'customer');
  expect((await rate(order._id, stranger, { storeStars: 5 })).status).toBe(404);
  expect((await rate(order._id, token, { storeStars: 6 })).status).toBe(400);
  const old = await setup({ deliveredAt: ago(8 * 24 * 60) });
  expect((await rate(old.order._id, old.token, { storeStars: 5 })).status).toBe(400);
  const pending = await setup({ status: 'preparing', deliveredAt: null });
  expect((await rate(pending.order._id, pending.token, { storeStars: 5 })).status).toBe(400);
});

test('store shows an average only after 3 ratings, plus a delivery estimate', async () => {
  const { store } = await setup();
  await Store.updateOne({ _id: store._id }, { $set: { ratingSum: 9, ratingCount: 2 } });
  let res = await request(app).get(`/api/stores/${store._id}`);
  expect(res.body.rating).toEqual({ average: null, count: 2 });
  expect(res.body.etaMinutes.max).toBeGreaterThan(res.body.etaMinutes.min);
  await Store.updateOne({ _id: store._id }, { $set: { ratingSum: 13, ratingCount: 3 } });
  res = await request(app).get(`/api/stores/${store._id}`);
  expect(res.body.rating).toEqual({ average: 4.3, count: 3 });
  expect(res.body.ratingSum).toBeUndefined();
});
