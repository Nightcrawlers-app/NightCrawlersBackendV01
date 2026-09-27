/**
 * Create a ready-to-use TEST vendor with an approved account, an open store
 * (with a map location) and a few menu items — plus a test rider — so you can
 * place and deliver test orders without going through KYC and approval.
 *
 *   node scripts/createTestVendor.js            create (or reset) the test accounts
 *   node scripts/createTestVendor.js --delete   remove them and everything they own
 *
 * Test accounts use @nightcrawlers.test emails, so they're easy to spot and
 * can never receive real email. Passwords are printed once when created.
 *
 * It refuses to run against a database whose name contains "prod" unless you
 * add --allow-prod, because test stores would then appear to real customers.
 */
require('dotenv').config();
const crypto = require('crypto');
const mongoose = require('mongoose');
const Vendor = require('../models/vendorModel');
const Rider = require('../models/riderModel');
const Store = require('../models/storeModel');
const MenuItem = require('../models/menuItemModel');
const Order = require('../models/orderModel');

const VENDOR_EMAIL = 'testvendor@nightcrawlers.test';
const RIDER_EMAIL = 'testrider@nightcrawlers.test';
const args = process.argv.slice(2);

// Wuse 2, Abuja — change if you want the test store somewhere else
const STORE_POINT = { type: 'Point', coordinates: [7.4803, 9.0765] }; // [lng, lat]

const MENU = [
  { name: 'Jollof Rice & Chicken', price: 4500, categories: ['Rice'] },
  { name: 'Chicken Shawarma', price: 3500, categories: ['Shawarma'] },
  { name: 'Suya (Beef), 1 portion', price: 3000, categories: ['Grills'] },
  { name: 'Chapman', price: 1500, categories: ['Drinks'] },
];
const img = (text) => `https://placehold.co/600x400/C62222/FFFFFF/png?text=${encodeURIComponent(text)}`;
const newPassword = () => `Test-${crypto.randomBytes(6).toString('base64url')}`;

(async () => {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set in .env');
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.name;
  // The cluster name as written in MONGODB_URI (e.g. nightcrawlers-prod.xxxx.mongodb.net)
  const host = (process.env.MONGODB_URI.match(/@([^/?]+)/) || [])[1] || mongoose.connection.host || '';
  console.log(`\nDatabase: "${db}" on ${host}`);

  // Check the cluster name as well as the database name — a connection string
  // with no database name puts everything in one called "test".
  if ((/prod/i.test(db) || /prod/i.test(host)) && !args.includes('--allow-prod')) {
    console.log(
      '\n⛔ This looks like your PRODUCTION database. Test stores would be visible to real customers.\n' +
        '   Use a development database, or re-run with --allow-prod if you really mean it\n' +
        '   (and delete the test data afterwards with --delete --allow-prod).'
    );
    process.exitCode = 1;
    return;
  }

  const vendor = await Vendor.findOne({ email: VENDOR_EMAIL });
  const rider = await Rider.findOne({ email: RIDER_EMAIL });

  if (args.includes('--delete')) {
    if (vendor) {
      const stores = await Store.find({ vendorId: vendor._id }, '_id');
      const storeIds = stores.map((s) => s._id);
      const items = await MenuItem.deleteMany({ storeId: { $in: storeIds } });
      const orders = await Order.deleteMany({ vendorId: vendor._id });
      await Store.deleteMany({ vendorId: vendor._id });
      await vendor.deleteOne();
      console.log(`🗑  Deleted test vendor, ${stores.length} store(s), ${items.deletedCount} menu item(s), ${orders.deletedCount} order(s).`);
    }
    if (rider) {
      await rider.deleteOne();
      console.log('🗑  Deleted test rider.');
    }
    if (!vendor && !rider) console.log('Nothing to delete.');
    return;
  }

  // ── Vendor: approved, phone verified, KYC passed ─────────────────────────
  const vendorPassword = newPassword();
  const v = vendor || new Vendor({ email: VENDOR_EMAIL });
  Object.assign(v, {
    firstName: 'Test',
    lastName: 'Vendor',
    businessType: 'Food',
    businessTypeRaw: 'Food',
    phoneNumber: '08000000001',
    location: 'Wuse 2, Abuja',
    password: vendorPassword, // hashed by the model on save
    verified: true,
    phoneVerified: true,
    kycStatus: 'passed',
    rejectedAt: null,
    rejectionReason: null,
    coordinates: STORE_POINT,
  });
  await v.save();

  // ── Store: open 24 hours, pinned on the map ──────────────────────────────
  let store = await Store.findOne({ vendorId: v._id });
  if (!store) {
    store = await Store.create({
      vendorId: v._id,
      name: 'Test Kitchen (TEST)',
      businessType: 'Food',
      categories: ['Rice', 'Shawarma', 'Grills', 'Drinks'],
      address: 'Wuse 2, Abuja',
      description: 'Test store for trying out orders. Not a real restaurant.',
      imageUrl: img('Test Kitchen'),
      is24Hours: true,
      coordinates: STORE_POINT,
    });
  }

  // ── Menu ─────────────────────────────────────────────────────────────────
  for (const item of MENU) {
    await MenuItem.updateOne(
      { storeId: store._id, name: item.name },
      { $setOnInsert: { ...item, storeId: store._id, description: 'Test item', imageUrl: img(item.name) } },
      { upsert: true }
    );
  }

  // ── Rider: approved, can accept and deliver the test orders ─────────────
  const riderPassword = newPassword();
  const r = rider || new Rider({ email: RIDER_EMAIL });
  Object.assign(r, {
    firstName: 'Test',
    lastName: 'Rider',
    vehicleType: 'Bike',
    phoneNumber: '08000000002',
    location: 'Wuse 2, Abuja',
    password: riderPassword,
    verified: true,
    phoneVerified: true,
    kycStatus: 'passed',
    rejectedAt: null,
    rejectionReason: null,
  });
  await r.save();

  console.log(`
✅ Test accounts ready (passwords reset each time you run this)

  VENDOR  → log in at /vendor-signin
    email:    ${VENDOR_EMAIL}
    password: ${vendorPassword}
    store:    "${store.name}" with ${MENU.length} menu items, open 24 hours

  RIDER   → log in at /vendor-signin, then choose the Rider tab
    email:    ${RIDER_EMAIL}
    password: ${riderPassword}

Remove everything later with:  node scripts/createTestVendor.js --delete
`);
})()
  .catch((err) => {
    console.error('\n❌', err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
