/**
 * NightCrawlers API — Test Suite
 * 
 * Stack: Jest + Supertest + mongodb-memory-server
 * Run:   npm test
 * 
 * Install test deps:
 *   npm install --save-dev jest supertest mongodb-memory-server @types/jest
 */

const request = require('supertest');
const mongoose = require('mongoose');

// ── We stub nodemailer so no real emails fire during tests ───────────────────
jest.mock('../utils/mailer', () => ({
  generateCode: () => '123456',
  sendVerificationEmail: jest.fn().mockResolvedValue(true),
  sendWelcomeEmail: jest.fn().mockResolvedValue(true),
  sendPasswordResetEmail: jest.fn().mockResolvedValue(true),
  sendNewLocationEmail: jest.fn().mockResolvedValue(true),
  sendPasswordChangedEmail: jest.fn().mockResolvedValue(true),
  sendAccountUpdatedEmail: jest.fn().mockResolvedValue(true),
  sendVendorWelcomeEmail: jest.fn().mockResolvedValue(true),
  sendVendorApprovedEmail: jest.fn().mockResolvedValue(true),
  sendVendorRejectedEmail: jest.fn().mockResolvedValue(true),
  sendRiderWelcomeEmail: jest.fn().mockResolvedValue(true),
  sendRiderApprovedEmail: jest.fn().mockResolvedValue(true),
  sendRiderRejectedEmail: jest.fn().mockResolvedValue(true),
}));

let app;

// ── Setup & teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  process.env.MONGODB_URI = 'mongodb://localhost:27017/nightcrawlers_test';
  process.env.JWT_SECRET = 'test_secret';
  process.env.FRONTEND_URL = 'http://localhost:5173';
  process.env.SMTP_FROM = 'test@nightcrawlers.com';

  // Import app after env is set
  app = require('../server');

// Wait for mongoose to connect
  await new Promise(resolve => setTimeout(resolve, 1000));
}, 15000); // 15s timeout for initial DB connection

afterAll(async () => {
  await mongoose.disconnect();
});

afterEach(async () => {
  // Clear all collections between tests
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    await collections[key].deleteMany({});
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

const registerUser = async (overrides = {}) => {
  const defaults = {
    username: 'Test User',
    email: 'user@test.com',
    password: 'password123',
  };
  return request(app).post('/api/auth/signup').send({ ...defaults, ...overrides });
};

const verifyUser = async (email, code = '123456') => {
  return request(app).post('/api/auth/verify').send({ email, code });
};

const loginUser = async (email = 'user@test.com', password = 'password123') => {
  const signup = await registerUser({ email });
  await verifyUser(email);
  const login = await request(app).post('/api/auth/login').send({ email, password });
  return login.body.token;
};

const registerVendor = async (overrides = {}) => {
  const defaults = {
    firstName: 'Vendor',
    lastName: 'One',
    businessType: 'Food',
    email: 'vendor@test.com',
    location: 'Abuja',
    password: 'password123',
  };
  return request(app).post('/api/vendors').send({ ...defaults, ...overrides });
};

const registerRider = async (overrides = {}) => {
  const defaults = {
    firstName: 'Rider',
    lastName: 'One',
    vehicleType: 'Motorcycle',
    email: 'rider@test.com',
    location: 'Abuja',
    password: 'password123',
  };
  return request(app).post('/api/riders').send({ ...defaults, ...overrides });
};

const createAdmin = async () => {
  const Admin = require('../models/adminModel');
  const admin = await Admin.create({
    username: 'superadmin',
    email: 'admin@test.com',
    password: 'adminpass123',
  });
  const login = await request(app)
    .post('/api/admins/login')
    .send({ email: 'admin@test.com', password: 'adminpass123' });
  return { admin, token: login.body.token };
};

// ── Health check ─────────────────────────────────────────────────────────────

describe('Health', () => {
  it('GET / returns status ok', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

// ── User Auth ────────────────────────────────────────────────────────────────

describe('User Auth', () => {
  it('POST /api/auth/signup creates unverified account and sends code', async () => {
    const res = await registerUser();
    expect(res.status).toBe(201);
    expect(res.body.email).toBe('user@test.com');
    expect(res.body.token).toBeUndefined(); // no token until verified
  });

  it('POST /api/auth/signup returns 409 if email already verified', async () => {
    await registerUser();
    await verifyUser('user@test.com');
    const res = await registerUser(); // same email
    expect(res.status).toBe(409);
  });

  it('POST /api/auth/verify returns token on correct code', async () => {
    await registerUser();
    const res = await verifyUser('user@test.com');
    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.user.email).toBe('user@test.com');
    expect(res.body.user.password).toBeUndefined();
  });

  it('POST /api/auth/verify returns 400 on wrong code', async () => {
    await registerUser();
    const res = await request(app)
      .post('/api/auth/verify')
      .send({ email: 'user@test.com', code: '000000' });
    expect(res.status).toBe(400);
  });

  it('POST /api/auth/login returns token for verified user', async () => {
    const token = await loginUser();
    expect(token).toBeDefined();
  });

  it('POST /api/auth/login returns 403 for unverified user', async () => {
    await registerUser();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'user@test.com', password: 'password123' });
    expect(res.status).toBe(403);
    expect(res.body.needsVerification).toBe(true);
  });

  it('POST /api/auth/login returns 401 for wrong password', async () => {
    await loginUser(); // creates & verifies
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'user@test.com', password: 'wrongpass' });
    expect(res.status).toBe(401);
  });

  it('GET /api/auth/me returns current user', async () => {
    const token = await loginUser();
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.email).toBe('user@test.com');
  });

  it('GET /api/auth/me returns 401 without token', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });
});

// ── Vendor Auth ──────────────────────────────────────────────────────────────

describe('Vendor Auth', () => {
  it('POST /api/vendors creates vendor and sends welcome email', async () => {
    const mailer = require('../utils/mailer');
    const res = await registerVendor();
    expect(res.status).toBe(201);
    expect(res.body.token).toBeDefined();
    expect(res.body.vendor.verified).toBe(false);
    expect(mailer.sendVendorWelcomeEmail).toHaveBeenCalledWith(
      'vendor@test.com',
      'Vendor',
      expect.any(String)
    );
  });

  it('POST /api/vendors returns 409 for duplicate email', async () => {
    await registerVendor();
    const res = await registerVendor();
    expect(res.status).toBe(409);
  });

  it('POST /api/vendors/login returns token', async () => {
    await registerVendor();
    const res = await request(app)
      .post('/api/vendors/login')
      .send({ email: 'vendor@test.com', password: 'password123' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
  });
});

// ── Rider Auth ───────────────────────────────────────────────────────────────

describe('Rider Auth', () => {
  it('POST /api/riders creates rider and sends welcome email', async () => {
    const mailer = require('../utils/mailer');
    const res = await registerRider();
    expect(res.status).toBe(201);
    expect(res.body.token).toBeDefined();
    expect(mailer.sendRiderWelcomeEmail).toHaveBeenCalledWith(
      'rider@test.com',
      'Rider',
      'Motorcycle'
    );
  });

  it('PATCH /api/riders/:id/status sets online/offline', async () => {
    const reg = await registerRider();
    const { token, rider } = reg.body;
    const res = await request(app)
      .patch(`/api/riders/${rider._id}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ isOnline: true });
    expect(res.status).toBe(200);
    expect(res.body.isOnline).toBe(true);
  });
});

// ── Stores ───────────────────────────────────────────────────────────────────

describe('Stores', () => {
  let vendorToken;

  beforeEach(async () => {
    const reg = await registerVendor();
    vendorToken = reg.body.token;
  });

  it('POST /api/stores creates a store for vendor', async () => {
    const res = await request(app)
      .post('/api/stores')
      .set('Authorization', `Bearer ${vendorToken}`)
      .send({
        name: 'Mama Put Kitchen',
        address: '12 Wuse Zone 3, Abuja',
        imageUrl: 'https://example.com/store.jpg',
        lat: 9.0563,
        lng: 7.4985,
      });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Mama Put Kitchen');
    expect(res.body.coordinates.coordinates).toEqual([7.4985, 9.0563]);
  });

  it('GET /api/stores returns list of stores', async () => {
    // Create a store first
    await request(app)
      .post('/api/stores')
      .set('Authorization', `Bearer ${vendorToken}`)
      .send({
        name: 'Test Store',
        address: 'Garki, Abuja',
        imageUrl: 'https://example.com/img.jpg',
      });

    const res = await request(app).get('/api/stores');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(1);
  });

  it('GET /api/stores?search= filters by name', async () => {
    await request(app)
      .post('/api/stores')
      .set('Authorization', `Bearer ${vendorToken}`)
      .send({ name: 'Pizza Palace', address: 'Maitama', imageUrl: 'https://example.com/img.jpg' });

    const res = await request(app).get('/api/stores?search=pizza');
    expect(res.status).toBe(200);
    expect(res.body[0].name).toBe('Pizza Palace');
  });

  it('GET /api/stores returns status field on each store', async () => {
    await request(app)
      .post('/api/stores')
      .set('Authorization', `Bearer ${vendorToken}`)
      .send({ name: 'Open Store', address: 'Abuja', imageUrl: 'https://x.com/img.jpg', is24Hours: true });

    const res = await request(app).get('/api/stores');
    expect(res.body[0].status).toBeDefined();
  });

  it('PATCH /api/stores/:id rejects non-owner vendor', async () => {
    const store = await request(app)
      .post('/api/stores')
      .set('Authorization', `Bearer ${vendorToken}`)
      .send({ name: 'Owned Store', address: 'Abuja', imageUrl: 'https://x.com/img.jpg' });

    const reg2 = await registerVendor({ email: 'vendor2@test.com' });
    const res = await request(app)
      .patch(`/api/stores/${store.body._id}`)
      .set('Authorization', `Bearer ${reg2.body.token}`)
      .send({ name: 'Hacked Name' });
    expect(res.status).toBe(403);
  });
});

// ── Menu Items ───────────────────────────────────────────────────────────────

describe('Menu Items', () => {
  let vendorToken;
  let storeId;

  beforeEach(async () => {
    const reg = await registerVendor();
    vendorToken = reg.body.token;
    const store = await request(app)
      .post('/api/stores')
      .set('Authorization', `Bearer ${vendorToken}`)
      .send({ name: 'My Store', address: 'Abuja', imageUrl: 'https://x.com/img.jpg' });
    storeId = store.body._id;
  });

  it('POST /api/menu-items creates an item', async () => {
    const res = await request(app)
      .post('/api/menu-items')
      .set('Authorization', `Bearer ${vendorToken}`)
      .send({ storeId, name: 'Jollof Rice', price: 1500, imageUrl: 'https://x.com/jollof.jpg' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Jollof Rice');
    expect(res.body.price).toBe(1500);
  });

  it('GET /api/stores/:id/menu-items returns items', async () => {
    await request(app)
      .post('/api/menu-items')
      .set('Authorization', `Bearer ${vendorToken}`)
      .send({ storeId, name: 'Egusi Soup', price: 2000, imageUrl: 'https://x.com/egusi.jpg' });

    const res = await request(app).get(`/api/stores/${storeId}/menu-items`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].name).toBe('Egusi Soup');
  });
});

// ── Orders ───────────────────────────────────────────────────────────────────

describe('Orders', () => {
  let storeId;
  let vendorId;

  beforeEach(async () => {
    const reg = await registerVendor();
    vendorId = reg.body.vendor._id;
    const store = await request(app)
      .post('/api/stores')
      .set('Authorization', `Bearer ${reg.body.token}`)
      .send({ name: 'Order Test Store', address: 'Abuja', imageUrl: 'https://x.com/img.jpg' });
    storeId = store.body._id;
  });

  it('POST /api/orders creates an order as guest', async () => {
    const res = await request(app).post('/api/orders').send({
      storeId,
      customerName: 'Amaka Obi',
      customerPhone: '08012345678',
      customerAddress: '5 Nnamdi Azikiwe Way, Abuja',
      customerLocation: 'Abuja, Nigeria',
      items: [{ name: 'Shawarma', quantity: 2, price: 1200 }],
      deliveryFee: 500,
    });
    console.log('ORDER ERROR:',res.body); // Debugging line REMOVE IN PROD
    expect(res.status).toBe(201);
    expect(res.body.totalAmount).toBe(2400);
    expect(res.body.status).toBe('pending');
  });

  it('POST /api/orders returns 400 if required fields missing', async () => {
    const res = await request(app).post('/api/orders').send({ storeId });
    expect(res.status).toBe(400);
  });

  it('PATCH /api/orders/:id/status allows vendor to advance status', async () => {
    const vendorReg = await registerVendor({ email: 'v2@test.com' });
    const vendorToken = vendorReg.body.token;
    const store2 = await request(app)
      .post('/api/stores')
      .set('Authorization', `Bearer ${vendorToken}`)
      .send({ name: 'Store 2', address: 'Abuja', imageUrl: 'https://x.com/img.jpg' });

    const order = await request(app).post('/api/orders').send({
      storeId: store2.body._id,
      customerName: 'Tunde',
      customerPhone: '08098765432',
      customerAddress: 'Jabi, Abuja',
      customerLocation: 'Abuja, Nigeria',
      items: [{ name: 'Rice', quantity: 1, price: 1000 }],
      deliveryFee: 300,
    });

    const res = await request(app)
      .patch(`/api/orders/${order.body._id}/status`)
      .set('Authorization', `Bearer ${vendorToken}`)
      .send({ status: 'preparing' });
    console.log('STATUS ERROR:', res.body); // Debugging line REMOVE IN PROD
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('preparing');
  });
});

// ── Admin ────────────────────────────────────────────────────────────────────

describe('Admin', () => {
  it('POST /api/admins/login returns token', async () => {
    const { token } = await createAdmin();
    expect(token).toBeDefined();
  });

  it('GET /api/admin/stats returns stats object', async () => {
    const { token } = await createAdmin();
    const res = await request(app)
      .get('/api/admin/stats')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('totalVendors');
    expect(res.body).toHaveProperty('totalRiders');
    expect(res.body).toHaveProperty('totalRevenue');
  });

  it('GET /api/admin/stats is blocked for non-admin', async () => {
    const token = await loginUser();
    const res = await request(app)
      .get('/api/admin/stats')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('POST /api/admin/verify approves vendor and sends email', async () => {
    const mailer = require('../utils/mailer');
    const { token } = await createAdmin();
    const reg = await registerVendor();
    const vendorId = reg.body.vendor._id;

    const res = await request(app)
      .post('/api/admin/verify')
      .set('Authorization', `Bearer ${token}`)
      .send({ id: vendorId, type: 'vendor', action: 'approve' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mailer.sendVendorApprovedEmail).toHaveBeenCalled();
  });

  it('POST /api/admin/verify rejects rider and sends email', async () => {
    const mailer = require('../utils/mailer');
    const { token } = await createAdmin();
    const reg = await registerRider();
    const riderId = reg.body.rider._id;

    const res = await request(app)
      .post('/api/admin/verify')
      .set('Authorization', `Bearer ${token}`)
      .send({ id: riderId, type: 'rider', action: 'reject' });

    expect(res.status).toBe(200);
    expect(mailer.sendRiderRejectedEmail).toHaveBeenCalled();
  });
});

// ── Password Reset ───────────────────────────────────────────────────────────

describe('Password Reset', () => {
  it('POST /api/auth/forgot-password returns 200 even for unknown email', async () => {
    const res = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'nobody@test.com' });
    expect(res.status).toBe(200);
  });

  it('POST /api/auth/reset-password resets password with valid code', async () => {
    await registerUser();
    await verifyUser('user@test.com');

    await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'user@test.com' });

    // Code is mocked as '123456'
    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ email: 'user@test.com', code: '123456', newPassword: 'newpass456' });
    expect(res.status).toBe(200);

    // Login with new password
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'user@test.com', password: 'newpass456' });
    expect(login.status).toBe(200);
    expect(login.body.token).toBeDefined();
  });
});
