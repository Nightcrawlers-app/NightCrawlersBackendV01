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
  verifyMailer: jest.fn().mockResolvedValue(true),
  sendContactNotification: jest.fn().mockResolvedValue(true),
  sendContactAcknowledgement: jest.fn().mockResolvedValue(true),
  sendNewsletterWelcome: jest.fn().mockResolvedValue(true),
}));


jest.mock('../utils/smsService', () => ({
  generateCode: () => '654321',
  normalizePhone: (phone) => phone,
  sendSms: jest.fn().mockResolvedValue(true),
  sendPhoneVerificationCode: jest.fn().mockResolvedValue(true),
  sendPhoneVerifiedConfirmation: jest.fn().mockResolvedValue(true),
}));


jest.mock('../utils/paystackService', () => ({
  resolveAccountNumber: jest.fn().mockResolvedValue({
    accountName: 'JOHN DOE',
    accountNumber: '0123456789',
    bankCode: '058',
    bankName: 'Guaranty Trust Bank (GTBank)',
  }),
  fetchBankList: jest.fn().mockResolvedValue([
    { name: 'Guaranty Trust Bank (GTBank)', code: '058' },
    { name: 'Access Bank', code: '044' },
    { name: 'Zenith Bank', code: '057' },
  ]),
  NIGERIAN_BANKS: [
    { name: 'Guaranty Trust Bank (GTBank)', code: '058' },
    { name: 'Access Bank', code: '044' },
  ],
}));


jest.mock('../utils/premblyService', () => ({
  verifyNIN: jest.fn().mockResolvedValue({
    verified: true,
    nin: '12345678901',
    firstName: 'John',
    lastName: 'Doe',
    middleName: 'A',
    dateOfBirth: '1990-01-01',
    gender: 'Male',
    phone: '08012345678',
  }),
  verifyDriversLicense: jest.fn().mockResolvedValue({
    verified: true,
    licenseNumber: 'ABC123456789',
    firstName: 'John',
    lastName: 'Doe',
    expiryDate: '2028-01-01',
    stateOfIssue: 'Lagos',
    vehicleClass: 'B',
  }),
  verifyCAC: jest.fn().mockResolvedValue({
    verified: true,
    rcNumber: '123456',
    companyName: 'Test Company Ltd',
    companyStatus: 'Active',
    registrationDate: '2020-01-01',
    companyType: 'Private Limited',
    address: '1 Test Street, Lagos',
  }),
  verifyTIN: jest.fn().mockResolvedValue({
    verified: true,
    tin: '12345678-0001',
    taxpayerName: 'Test Company Ltd',
    taxOffice: 'Lagos',
    phone: '08012345678',
    email: 'test@company.com',
  }),
}));

let app;

// ── Setup & teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  process.env.MONGODB_URI = 'mongodb://localhost:27017/nightcrawlers_test';
  process.env.JWT_SECRET = 'test_secret';
  process.env.FRONTEND_URL = 'http://localhost:5173';
  process.env.SMTP_FROM = 'test@nightcrawlers.com';

  // Import app after env is set
  app = require('../app');

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

/** Add a real menu item and return its id — orders only accept real menu items. */
const addMenuItem = async (vendorToken, storeId, name = 'Item', price = 1000) => {
  const res = await request(app)
    .post('/api/menu-items')
    .set('Authorization', `Bearer ${vendorToken}`)
    .send({ storeId, name, price, imageUrl: 'https://x.com/food.jpg' });
  return res.body._id;
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

//__ Phone Verification_____________________________________________________

describe('Phone Verification', () => {
  describe('Customer phone verification', () => {
    it('POST /api/users/me/phone/send sends a code', async () => {
      const sms = require('../utils/smsService');
      const reg = await registerUser();
      await verifyUser(reg.body.email);
      const login = await request(app)
        .post('/api/auth/login')
        .send({ email: reg.body.email, password: 'password123' });
 
      // Add a phone number first since default user has none
      await request(app)
        .patch('/api/users/me')
        .set('Authorization', `Bearer ${login.body.token}`)
        .send({ phone: '08012345678' });
 
      const res = await request(app)
        .post('/api/users/me/phone/send')
        .set('Authorization', `Bearer ${login.body.token}`);
 
      expect(res.status).toBe(200);
      expect(sms.sendPhoneVerificationCode).toHaveBeenCalled();
    });
 
    it('POST /api/users/me/phone/send fails if no phone on file', async () => {
      const reg = await registerUser();
      await verifyUser(reg.body.email);
      const login = await request(app)
        .post('/api/auth/login')
        .send({ email: reg.body.email, password: 'password123' });
 
      const res = await request(app)
        .post('/api/users/me/phone/send')
        .set('Authorization', `Bearer ${login.body.token}`);
 
      expect(res.status).toBe(400);
    });
 
    it('POST /api/users/me/phone/verify verifies with correct code', async () => {
      const reg = await registerUser();
      await verifyUser(reg.body.email);
      const login = await request(app)
        .post('/api/auth/login')
        .send({ email: reg.body.email, password: 'password123' });
 
      await request(app)
        .patch('/api/users/me')
        .set('Authorization', `Bearer ${login.body.token}`)
        .send({ phone: '08012345678' });
 
      await request(app)
        .post('/api/users/me/phone/send')
        .set('Authorization', `Bearer ${login.body.token}`);
 
      const res = await request(app)
        .post('/api/users/me/phone/verify')
        .set('Authorization', `Bearer ${login.body.token}`)
        .send({ code: '654321' });
 
      expect(res.status).toBe(200);
      expect(res.body.account.phoneVerified).toBe(true);
    });
 
    it('POST /api/users/me/phone/verify rejects wrong code', async () => {
      const reg = await registerUser();
      await verifyUser(reg.body.email);
      const login = await request(app)
        .post('/api/auth/login')
        .send({ email: reg.body.email, password: 'password123' });
 
      await request(app)
        .patch('/api/users/me')
        .set('Authorization', `Bearer ${login.body.token}`)
        .send({ phone: '08012345678' });
 
      await request(app)
        .post('/api/users/me/phone/send')
        .set('Authorization', `Bearer ${login.body.token}`);
 
      const res = await request(app)
        .post('/api/users/me/phone/verify')
        .set('Authorization', `Bearer ${login.body.token}`)
        .send({ code: '000000' });
 
      expect(res.status).toBe(400);
    });
 
    it('POST /api/orders is blocked for logged-in customer with unverified phone', async () => {
      const vendorReg = await registerVendor({ email: 'phonetest-vendor@test.com' });
      const store = await request(app)
        .post('/api/stores')
        .set('Authorization', `Bearer ${vendorReg.body.token}`)
        .send({ name: 'Phone Test Store', address: 'Abuja', imageUrl: 'https://x.com/img.jpg' });
 
      const userReg = await registerUser({ email: 'phonetest-customer@test.com' });
      await verifyUser('phonetest-customer@test.com');
      const login = await request(app)
        .post('/api/auth/login')
        .send({ email: 'phonetest-customer@test.com', password: 'password123' });
 
      const res = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${login.body.token}`)
        .send({
          storeId: store.body._id,
          customerName: 'Test Customer',
          customerPhone: '08012345678',
          customerAddress: 'Test Address',
          customerLocation: 'Abuja',
          items: [{ menuItemId: await addMenuItem(vendorReg.body.token, store.body._id), quantity: 1 }],
        });
 
      expect(res.status).toBe(403);
      expect(res.body.needsPhoneVerification).toBe(true);
    });
 
    it('POST /api/orders succeeds for guest checkout regardless of phone verification', async () => {
      const vendorReg = await registerVendor({ email: 'phonetest-vendor2@test.com' });
      const store = await request(app)
        .post('/api/stores')
        .set('Authorization', `Bearer ${vendorReg.body.token}`)
        .send({ name: 'Guest Test Store', address: 'Abuja', imageUrl: 'https://x.com/img.jpg' });
 
      const res = await request(app).post('/api/orders').send({
        storeId: store.body._id,
        customerName: 'Guest Buyer',
        customerPhone: '08099998888',
        customerAddress: 'Guest Address',
        customerLocation: 'Abuja',
        items: [{ menuItemId: await addMenuItem(vendorReg.body.token, store.body._id), quantity: 1 }],
      });
 
      expect(res.status).toBe(201);
    });
  });
 
  describe('Setting the number', () => {
    it('a vendor with no number can add one, then verify it', async () => {
      const reg = await registerVendor({ email: 'nophone@test.com' });
      const token = reg.body.token;
      const bad = await request(app).post('/api/vendors/me/phone/number').set('Authorization', `Bearer ${token}`).send({ phone: '123' });
      expect(bad.status).toBe(400);
      const ok = await request(app).post('/api/vendors/me/phone/number').set('Authorization', `Bearer ${token}`).send({ phone: '0803 123 4567' });
      expect(ok.status).toBe(200);
      expect(ok.body.phone).toBe('08031234567');
      await request(app).post('/api/vendors/me/phone/send').set('Authorization', `Bearer ${token}`);
      const verified = await request(app).post('/api/vendors/me/phone/verify').set('Authorization', `Bearer ${token}`).send({ code: '654321' });
      expect(verified.status).toBe(200);
    });
  });

  describe('Vendor phone verification', () => {
    it('POST /api/vendors/me/phone/send and /verify works', async () => {
      const reg = await registerVendor({ email: 'vendorphone@test.com', phoneNumber: '08011112222' });
      const token = reg.body.token;
 
      const sendRes = await request(app)
        .post('/api/vendors/me/phone/send')
        .set('Authorization', `Bearer ${token}`);
      expect(sendRes.status).toBe(200);
 
      const verifyRes = await request(app)
        .post('/api/vendors/me/phone/verify')
        .set('Authorization', `Bearer ${token}`)
        .send({ code: '654321' });
      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body.account.phoneVerified).toBe(true);
    });
 
    it('Admin cannot approve vendor with unverified phone', async () => {
      const { token: adminToken } = await createAdmin();
      const reg = await registerVendor({ 
        email: 'unverifiedvendor@test.com',
        phoneNumber: '08055556666'
      });
 
      const res = await request(app)
        .post('/api/admin/verify')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ id: reg.body.vendor._id, type: 'vendor', action: 'approve' });
 
      expect(res.status).toBe(400);
    });

    it('Admin can approve vendor once phone is verified', async () => {
      const { token: adminToken } = await createAdmin();
      const reg = await registerVendor({
        email: 'verifiedvendor@test.com',
        phoneNumber: '08055556666'
      });

      // Phone verify
      await request(app)
        .post('/api/vendors/me/phone/send')
        .set('Authorization', `Bearer ${reg.body.token}`);
      await request(app)
        .post('/api/vendors/me/phone/verify')
        .set('Authorization', `Bearer ${reg.body.token}`)
        .send({ code: '654321' });
      
      // KYC — declare formal, verify CAC + TIN
      await request(app)
        .post('/api/vendors/me/kyc/declare')
        .set('Authorization', `Bearer ${reg.body.token}`)
        .send({ isInformalVendor: false });
      await request(app)
        .post('/api/vendors/me/kyc/cac')
        .set('Authorization', `Bearer ${reg.body.token}`)
        .send({ rcNumber: 'RC123456' });
      await request(app)
        .post('/api/vendors/me/kyc/tin')
        .set('Authorization', `Bearer ${reg.body.token}`)
        .send({ tin: '12345678-0001' });

      const res = await request(app)
        .post('/api/admin/verify')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ id: reg.body.vendor._id, type: 'vendor', action: 'approve' });

      expect(res.status).toBe(200);
    });
  });
 
  describe('Rider phone verification', () => {
    it('POST /api/riders/me/phone/send and /verify works', async () => {
      const reg = await registerRider({ email: 'riderphone@test.com', phoneNumber: '08033334444' });
      const token = reg.body.token;
 
      const sendRes = await request(app)
        .post('/api/riders/me/phone/send')
        .set('Authorization', `Bearer ${token}`);
      expect(sendRes.status).toBe(200);
 
      const verifyRes = await request(app)
        .post('/api/riders/me/phone/verify')
        .set('Authorization', `Bearer ${token}`)
        .send({ code: '654321' });
      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body.account.phoneVerified).toBe(true);
    });
 
    it('Admin cannot approve rider with unverified phone', async () => {
      const { token: adminToken } = await createAdmin();
      const reg = await registerRider({ 
        email: 'unverifiedrider@test.com',
        phoneNumber: '08033334444'
      });
 
      const res = await request(app)
        .post('/api/admin/verify')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ id: reg.body.rider._id, type: 'rider', action: 'approve' });
 
      expect(res.status).toBe(400);
    });
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

  it('GET /api/stores?search= also finds stores by the dishes they sell', async () => {
    const store = await request(app)
      .post('/api/stores')
      .set('Authorization', `Bearer ${vendorToken}`)
      .send({ name: 'Mama Put', address: 'Wuse', imageUrl: 'https://example.com/img.jpg' });
    await addMenuItem(vendorToken, store.body._id, 'Chicken Shawarma', 2500);

    const res = await request(app).get('/api/stores?search=shawarma');
    expect(res.body.map((s) => s.name)).toEqual(['Mama Put']);
    expect(res.body[0].matchedItems).toEqual(['Chicken Shawarma']);

    // Regex characters in the search box must not crash the server
    const weird = await request(app).get('/api/stores?search=' + encodeURIComponent('(shawarma['));
    expect(weird.status).toBe(200);
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
  let vendorToken;
  let shawarmaId;

  beforeEach(async () => {
    const reg = await registerVendor();
    vendorId = reg.body.vendor._id;
    vendorToken = reg.body.token;
    const store = await request(app)
      .post('/api/stores')
      .set('Authorization', `Bearer ${reg.body.token}`)
      .send({ name: 'Order Test Store', address: 'Abuja', imageUrl: 'https://x.com/img.jpg' });
    storeId = store.body._id;
    shawarmaId = await addMenuItem(vendorToken, storeId, 'Shawarma', 1200);
  });

  const placeOrder = (items, extra = {}) =>
    request(app).post('/api/orders').send({
      storeId,
      customerName: 'Amaka Obi',
      customerPhone: '08012345678',
      customerAddress: '5 Nnamdi Azikiwe Way, Abuja',
      customerLocation: 'Abuja, Nigeria',
      items,
      ...extra,
    });

  it('POST /api/orders creates an order as guest', async () => {
    const res = await placeOrder([{ menuItemId: shawarmaId, quantity: 2 }]);
    expect(res.status).toBe(201);
    expect(res.body.totalAmount).toBe(2400);
    expect(res.body.items[0].name).toBe('Shawarma');
    expect(res.body.status).toBe('pending');
  });

  it('uses menu prices, ignoring prices and fees sent by the browser', async () => {
    const res = await placeOrder(
      [{ menuItemId: shawarmaId, quantity: 2, price: 5, name: 'Free food' }],
      { deliveryFee: 0 },
    );
    expect(res.status).toBe(201);
    expect(res.body.items[0]).toMatchObject({ name: 'Shawarma', price: 1200, quantity: 2 });
    expect(res.body.totalAmount).toBe(2400);
    expect(res.body.deliveryFee).toBe(800);
    expect(res.body.serviceFee).toBe(120);   // 5% of 2400
    expect(res.body.totalPaid).toBe(3320);   // 2400 + 800 + 120
  });

  it('POST /api/orders/quote matches what the order will charge', async () => {
    const quote = await request(app)
      .post('/api/orders/quote')
      .send({ storeId, items: [{ menuItemId: shawarmaId, quantity: 2 }], promotionId: '000000000000000000000000' });
    expect(quote.status).toBe(200);
    expect(quote.body).toMatchObject({ subtotal: 2400, deliveryFee: 800, serviceFee: 120, discount: 0, total: 3320 });
    // A bad promo is reported on a quote, not an error
    expect(quote.body.promotion.eligible).toBe(false);
  });

  it('rejects items from another store, unknown items and bad quantities', async () => {
    const other = await registerVendor({ email: 'other-shop@test.com' });
    const otherStore = await request(app)
      .post('/api/stores')
      .set('Authorization', `Bearer ${other.body.token}`)
      .send({ name: 'Other Shop', address: 'Abuja', imageUrl: 'https://x.com/i.jpg' });
    const foreignItem = await addMenuItem(other.body.token, otherStore.body._id, 'Cheap thing', 10);

    const foreign = await placeOrder([{ menuItemId: foreignItem, quantity: 1 }]);
    expect(foreign.status).toBe(400);
    expect(foreign.body.cartInvalid).toBe(true);

    const noId = await placeOrder([{ name: 'Shawarma', quantity: 1, price: 1 }]);
    expect(noId.status).toBe(400);

    for (const quantity of [0, -3, 1.5, 999]) {
      const bad = await placeOrder([{ menuItemId: shawarmaId, quantity }]);
      expect(bad.status).toBe(400);
    }
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
      items: [{ menuItemId: await addMenuItem(vendorToken, store2.body._id, 'Rice', 1000), quantity: 1 }],
    });

    const res = await request(app)
      .patch(`/api/orders/${order.body._id}/status`)
      .set('Authorization', `Bearer ${vendorToken}`)
      .send({ status: 'preparing' });
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

  it('order stats load at both /order-stats and /orders/stats', async () => {
    const { token } = await createAdmin();
    for (const path of ['/api/admin/order-stats', '/api/admin/orders/stats']) {
      const res = await request(app).get(path).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('totalOrders');
    }
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
    const reg = await registerVendor({
      email: 'approvedvendor@test.com',
      phoneNumber: '08102589790',
  
    });
    const vendorId = reg.body.vendor._id;

    //Phone verify
    await request(app)
      .post('/api/vendors/me/phone/send')
      .set('Authorization', `Bearer ${reg.body.token}`);

    await request(app)
      .post('/api/vendors/me/phone/verify')
      .set('Authorization', `Bearer ${reg.body.token}`)
      .send({ code: '654321' });

    // KYC
    await request(app)
      .post('/api/vendors/me/kyc/declare')
      .set('Authorization', `Bearer ${reg.body.token}`)
      .send({ isInformalVendor: false });
    await request(app)
      .post('/api/vendors/me/kyc/cac')
      .set('Authorization', `Bearer ${reg.body.token}`)
      .send({ rcNumber: 'RC123456' });
   await request(app)
      .post('/api/vendors/me/kyc/tin')
      .set('Authorization', `Bearer ${reg.body.token}`)
      .send({ tin: '12345678-0001' });


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


describe('Bank Verification', () => {
  describe('Vendor bank verification', () => {
    let vendorToken;
    let vendorId;

    beforeEach(async () => {
      const reg = await registerVendor({ email: 'bankvendor@test.com', phoneNumber: '08012345678' });
      vendorToken = reg.body.token;
      vendorId = reg.body.vendor._id;
    });

    it('GET /api/vendors/me/bank/banks returns bank list', async () => {
      const res = await request(app)
        .get('/api/vendors/me/bank/banks')
        .set('Authorization', `Bearer ${vendorToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body[0]).toHaveProperty('name');
      expect(res.body[0]).toHaveProperty('code');
    });

    it('GET /api/vendors/me/bank returns unverified state initially', async () => {
      const res = await request(app)
        .get('/api/vendors/me/bank')
        .set('Authorization', `Bearer ${vendorToken}`);
      expect(res.status).toBe(200);
      expect(res.body.bankVerified).toBe(false);
    });

    it('POST /api/vendors/me/bank/resolve returns account name', async () => {
      const res = await request(app)
        .post('/api/vendors/me/bank/resolve')
        .set('Authorization', `Bearer ${vendorToken}`)
        .send({ accountNumber: '0123456789', bankCode: '058' });
      expect(res.status).toBe(200);
      expect(res.body.accountName).toBe('JOHN DOE');
    });

    it('POST /api/vendors/me/bank/resolve returns 400 for invalid format', async () => {
      const res = await request(app)
        .post('/api/vendors/me/bank/resolve')
        .set('Authorization', `Bearer ${vendorToken}`)
        .send({ accountNumber: '123', bankCode: '058' });
      expect(res.status).toBe(400);
    });

    it('POST /api/vendors/me/bank/save saves verified bank details', async () => {
      const res = await request(app)
        .post('/api/vendors/me/bank/save')
        .set('Authorization', `Bearer ${vendorToken}`)
        .send({ accountNumber: '0123456789', bankCode: '058' });
      expect(res.status).toBe(200);
      expect(res.body.bankVerified).toBe(true);
      expect(res.body.bankAccountName).toBe('JOHN DOE');
      expect(res.body.bankAccountNumber).toBe('******6789');
    });

    it('GET /api/vendors/me/bank returns verified details after saving', async () => {
      await request(app)
        .post('/api/vendors/me/bank/save')
        .set('Authorization', `Bearer ${vendorToken}`)
        .send({ accountNumber: '0123456789', bankCode: '058' });

      const res = await request(app)
        .get('/api/vendors/me/bank')
        .set('Authorization', `Bearer ${vendorToken}`);
      expect(res.body.bankVerified).toBe(true);
      expect(res.body.bankAccountNumber).toBe('******6789');
    });

    it('POST /api/vendors/me/bank/remove clears bank details', async () => {
      await request(app)
        .post('/api/vendors/me/bank/save')
        .set('Authorization', `Bearer ${vendorToken}`)
        .send({ accountNumber: '0123456789', bankCode: '058' });

      await request(app)
        .post('/api/vendors/me/bank/remove')
        .set('Authorization', `Bearer ${vendorToken}`);

      const check = await request(app)
        .get('/api/vendors/me/bank')
        .set('Authorization', `Bearer ${vendorToken}`);
      expect(check.body.bankVerified).toBe(false);
    });

    it('GET /api/vendors/:id/earnings blocked without bank verification', async () => {
      const res = await request(app)
        .get(`/api/vendors/${vendorId}/earnings`)
        .set('Authorization', `Bearer ${vendorToken}`);
      expect(res.status).toBe(403);
      expect(res.body.needsBankVerification).toBe(true);
    });

    it('GET /api/vendors/:id/earnings succeeds after bank verification', async () => {
      await request(app)
        .post('/api/vendors/me/bank/save')
        .set('Authorization', `Bearer ${vendorToken}`)
        .send({ accountNumber: '0123456789', bankCode: '058' });

      const res = await request(app)
        .get(`/api/vendors/${vendorId}/earnings`)
        .set('Authorization', `Bearer ${vendorToken}`);
      expect(res.status).toBe(200);
    });
  });

  describe('Rider bank verification', () => {
    let riderToken;
    let riderId;

    beforeEach(async () => {
      const reg = await registerRider({ email: 'bankrider@test.com', phoneNumber: '08099998888' });
      riderToken = reg.body.token;
      riderId = reg.body.rider._id;
    });

    it('POST /api/riders/me/bank/save saves verified bank details', async () => {
      const res = await request(app)
        .post('/api/riders/me/bank/save')
        .set('Authorization', `Bearer ${riderToken}`)
        .send({ accountNumber: '0123456789', bankCode: '044' });
      expect(res.status).toBe(200);
      expect(res.body.bankVerified).toBe(true);
    });

    it('GET /api/riders/:id/earnings blocked without bank verification', async () => {
      const res = await request(app)
        .get(`/api/riders/${riderId}/earnings`)
        .set('Authorization', `Bearer ${riderToken}`);
      expect(res.status).toBe(403);
      expect(res.body.needsBankVerification).toBe(true);
    });

    it('GET /api/riders/:id/earnings succeeds after bank verification', async () => {
      await request(app)
        .post('/api/riders/me/bank/save')
        .set('Authorization', `Bearer ${riderToken}`)
        .send({ accountNumber: '0123456789', bankCode: '044' });

      const res = await request(app)
        .get(`/api/riders/${riderId}/earnings`)
        .set('Authorization', `Bearer ${riderToken}`);
      expect(res.status).toBe(200);
    });

    it('Rider cannot access vendor bank endpoint', async () => {
      const res = await request(app)
        .get('/api/vendors/me/bank')
        .set('Authorization', `Bearer ${riderToken}`);
      expect(res.status).toBe(403);
    });
  });
});

describe('KYC Verification', () => {
  // ── Rider KYC ────────────────────────────────────────────────────────────
  describe('Rider KYC', () => {
    let riderToken;
    let riderId;
 
    beforeEach(async () => {
      const reg = await registerRider({
        email: 'kycrider@test.com',
        phoneNumber: '08011112222',
      });
      riderToken = reg.body.token;
      riderId = reg.body.rider._id;
    });
 
    it('GET /api/riders/me/kyc returns pending status initially', async () => {
      const res = await request(app)
        .get('/api/riders/me/kyc')
        .set('Authorization', `Bearer ${riderToken}`);
      expect(res.status).toBe(200);
      expect(res.body.kycStatus).toBe('pending');
      expect(res.body.checks.nin.verified).toBe(false);
    });
 
    it('POST /api/riders/me/kyc/nin verifies NIN', async () => {
      const res = await request(app)
        .post('/api/riders/me/kyc/nin')
        .set('Authorization', `Bearer ${riderToken}`)
        .send({ nin: '12345678901' });
      expect(res.status).toBe(200);
      expect(res.body.verified).toBe(true);
      expect(res.body.data.firstName).toBe('John');
      expect(res.body.kycStatus).toBe('in_progress');
    });
 
    it('POST /api/riders/me/kyc/nin returns 400 for invalid NIN format', async () => {
      const res = await request(app)
        .post('/api/riders/me/kyc/nin')
        .set('Authorization', `Bearer ${riderToken}`)
        .send({ nin: '123' }); // too short
      expect(res.status).toBe(422);
    });
 
    it('POST /api/riders/me/kyc/license requires NIN first', async () => {
      const res = await request(app)
        .post('/api/riders/me/kyc/license')
        .set('Authorization', `Bearer ${riderToken}`)
        .send({ licenseNumber: 'ABC123456789', dateOfBirth: '1990-01-01' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/NIN/);
    });
 
    it('POST /api/riders/me/kyc/license verifies license after NIN', async () => {
      await request(app)
        .post('/api/riders/me/kyc/nin')
        .set('Authorization', `Bearer ${riderToken}`)
        .send({ nin: '12345678901' });
 
      const res = await request(app)
        .post('/api/riders/me/kyc/license')
        .set('Authorization', `Bearer ${riderToken}`)
        .send({ licenseNumber: 'ABC123456789', dateOfBirth: '1990-01-01' });
 
      expect(res.status).toBe(200);
      expect(res.body.verified).toBe(true);
      expect(res.body.data.stateOfIssue).toBe('Lagos');
    });
 
    it('POST /api/riders/me/kyc/address submits utility bill', async () => {
      const res = await request(app)
        .post('/api/riders/me/kyc/address')
        .set('Authorization', `Bearer ${riderToken}`)
        .send({ documentUrl: 'https://cloudinary.com/utility-bill.jpg' });
      expect(res.status).toBe(200);
      expect(res.body.submitted).toBe(true);
    });
 
    it('Admin can approve rider utility bill', async () => {
      await request(app)
        .post('/api/riders/me/kyc/address')
        .set('Authorization', `Bearer ${riderToken}`)
        .send({ documentUrl: 'https://cloudinary.com/utility-bill.jpg' });
 
      const { token: adminToken } = await createAdmin();
      const res = await request(app)
        .post(`/api/admin/kyc/rider/${riderId}/address`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ action: 'approve' });
 
      expect(res.status).toBe(200);
      expect(res.body.action).toBe('approve');
    });
 
    it('Admin cannot approve rider before KYC is passed', async () => {
      // Phone verify first
      await request(app)
        .post('/api/riders/me/phone/send')
        .set('Authorization', `Bearer ${riderToken}`);
      await request(app)
        .post('/api/riders/me/phone/verify')
        .set('Authorization', `Bearer ${riderToken}`)
        .send({ code: '654321' });
 
      const { token: adminToken } = await createAdmin();
      const res = await request(app)
        .post('/api/admin/verify')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ id: riderId, type: 'rider', action: 'approve' });
 
      expect(res.status).toBe(400);
      expect(res.body.kycStatus).toBeDefined();
    });
  });
 
  // ── Vendor KYC (Formal) ───────────────────────────────────────────────────
  describe('Vendor KYC - Formal', () => {
    let vendorToken;
    let vendorId;
 
    beforeEach(async () => {
      const reg = await registerVendor({
        email: 'kycvendorformal@test.com',
        phoneNumber: '08033334444',
      });
      vendorToken = reg.body.token;
      vendorId = reg.body.vendor._id;
 
      // Declare as formal vendor
      await request(app)
        .post('/api/vendors/me/kyc/declare')
        .set('Authorization', `Bearer ${vendorToken}`)
        .send({ isInformalVendor: false });
    });
 
    it('GET /api/vendors/me/kyc returns formal vendor status', async () => {
      const res = await request(app)
        .get('/api/vendors/me/kyc')
        .set('Authorization', `Bearer ${vendorToken}`);
      expect(res.status).toBe(200);
      expect(res.body.vendorType).toBe('formal');
      expect(res.body.checks.cac.verified).toBe(false);
    });
 
    it('POST /api/vendors/me/kyc/cac verifies CAC', async () => {
      const res = await request(app)
        .post('/api/vendors/me/kyc/cac')
        .set('Authorization', `Bearer ${vendorToken}`)
        .send({ rcNumber: 'RC123456' });
      expect(res.status).toBe(200);
      expect(res.body.verified).toBe(true);
      expect(res.body.data.companyName).toBe('Test Company Ltd');
    });
 
    it('POST /api/vendors/me/kyc/tin verifies TIN', async () => {
      await request(app)
        .post('/api/vendors/me/kyc/cac')
        .set('Authorization', `Bearer ${vendorToken}`)
        .send({ rcNumber: 'RC123456' });
 
      const res = await request(app)
        .post('/api/vendors/me/kyc/tin')
        .set('Authorization', `Bearer ${vendorToken}`)
        .send({ tin: '12345678-0001' });
 
      expect(res.status).toBe(200);
      expect(res.body.verified).toBe(true);
      expect(res.body.kycStatus).toBe('passed');
    });
 
    it('Informal-only endpoints blocked for formal vendors', async () => {
      const res = await request(app)
        .post('/api/vendors/me/kyc/nin')
        .set('Authorization', `Bearer ${vendorToken}`)
        .send({ nin: '12345678901' });
      expect(res.status).toBe(400);
    });
  });
 
  // ── Vendor KYC (Informal) ─────────────────────────────────────────────────
  describe('Vendor KYC - Informal', () => {
    let vendorToken;
    let vendorId;
 
    beforeEach(async () => {
      const reg = await registerVendor({
        email: 'kycvendorinformal@test.com',
        phoneNumber: '08055556666',
      });
      vendorToken = reg.body.token;
      vendorId = reg.body.vendor._id;
 
      await request(app)
        .post('/api/vendors/me/kyc/declare')
        .set('Authorization', `Bearer ${vendorToken}`)
        .send({ isInformalVendor: true });
    });
 
    it('GET /api/vendors/me/kyc shows both paths for informal vendor', async () => {
      const res = await request(app)
        .get('/api/vendors/me/kyc')
        .set('Authorization', `Bearer ${vendorToken}`);
      expect(res.status).toBe(200);
      expect(res.body.vendorType).toBe('informal');
      expect(res.body.paths.agentPath).toBeDefined();
      expect(res.body.paths.digitalPath).toBeDefined();
    });
 
    it('Informal Path B: NIN + T&Cs sets kycStatus to passed', async () => {
      // Note: selfie is deferred, so Path B = NIN + terms for now
      await request(app)
        .post('/api/vendors/me/kyc/nin')
        .set('Authorization', `Bearer ${vendorToken}`)
        .send({ nin: '12345678901' });
 
      // Temporarily override selfieVerified to test terms path
      // (in real usage, SmileID sets this)
      const Vendor = require('../models/vendorModel');
      await Vendor.findByIdAndUpdate(vendorId, { selfieVerified: true });
 
      const res = await request(app)
        .post('/api/vendors/me/kyc/terms')
        .set('Authorization', `Bearer ${vendorToken}`)
        .send({ agreed: true, termsVersion: 'v1.0' });
 
      expect(res.status).toBe(200);
      expect(res.body.kycStatus).toBe('passed');
    });
 
    it('Informal Path A: NIN + agent visit sets kycStatus to passed', async () => {
      await request(app)
        .post('/api/vendors/me/kyc/nin')
        .set('Authorization', `Bearer ${vendorToken}`)
        .send({ nin: '12345678901' });
 
      const { token: adminToken } = await createAdmin();
      const res = await request(app)
        .post(`/api/admin/kyc/vendor/${vendorId}/agent`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ verified: true, notes: 'Visited suya stand at Wuse Market. Legitimate.' });
 
      expect(res.status).toBe(200);
      expect(res.body.kycStatus).toBe('passed');
    });
 
    it('Formal-only endpoints blocked for informal vendors', async () => {
      const res = await request(app)
        .post('/api/vendors/me/kyc/cac')
        .set('Authorization', `Bearer ${vendorToken}`)
        .send({ rcNumber: 'RC123456' });
      expect(res.status).toBe(400);
    });
 
    it('POST /api/vendors/me/kyc/terms requires NIN first', async () => {
      const res = await request(app)
        .post('/api/vendors/me/kyc/terms')
        .set('Authorization', `Bearer ${vendorToken}`)
        .send({ agreed: true });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/NIN/);
    });
  });
 
  // ── Admin KYC overview ────────────────────────────────────────────────────
  describe('Admin KYC overview', () => {
    it('GET /api/admin/kyc/pending returns pending vendors and riders', async () => {
      const { token: adminToken } = await createAdmin();
      const res = await request(app)
        .get('/api/admin/kyc/pending')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('vendors');
      expect(res.body).toHaveProperty('riders');
    });
  });
});

// ── Contact & newsletter ─────────────────────────────────────────────────────

describe('Contact & newsletter', () => {
  const mailer = require('../utils/mailer');

  it('POST /api/contact saves and emails the message', async () => {
    const res = await request(app)
      .post('/api/contact')
      .send({ firstName: 'Ada', lastName: 'O', email: 'ada@test.com', message: 'Hello there' });
    expect(res.status).toBe(201);
    expect(mailer.sendContactNotification).toHaveBeenCalled();
    const ContactMessage = require('../models/contactMessageModel');
    expect(await ContactMessage.countDocuments()).toBe(1);
  });

  it('POST /api/contact rejects a missing message', async () => {
    const res = await request(app).post('/api/contact').send({ firstName: 'Ada', email: 'ada@test.com' });
    expect(res.status).toBe(400);
  });

  it('POST /api/newsletter subscribes once', async () => {
    const first = await request(app).post('/api/newsletter').send({ email: 'Sub@Test.com' });
    expect(first.status).toBe(201);
    const again = await request(app).post('/api/newsletter').send({ email: 'sub@test.com' });
    expect(again.status).toBe(200);
    const Subscriber = require('../models/subscriberModel');
    expect(await Subscriber.countDocuments()).toBe(1);
  });

  it('POST /api/newsletter rejects a bad email', async () => {
    const res = await request(app).post('/api/newsletter').send({ email: 'nope' });
    expect(res.status).toBe(400);
  });
});

// ── Vendor business type ─────────────────────────────────────────────────────

describe('Vendor business type', () => {
  it('rejects a business type outside the list', async () => {
    const res = await registerVendor({ businessType: 'Restaurant' });
    expect(res.status).toBe(400);
    expect(res.body.allowed).toContain('Food');
  });

  it('GET /api/vendors/business-types lists the options', async () => {
    const res = await request(app).get('/api/vendors/business-types');
    expect(res.body).toEqual(['Food', 'Groceries', 'Pharmacy', 'Drinks', 'Clubs/Lounges']);
  });
});

// ── Geolocation ──────────────────────────────────────────────────────────────

describe('Geolocation', () => {
  let vendorToken;
  beforeEach(async () => {
    vendorToken = (await registerVendor()).body.token;
  });

  const makeStore = (body) =>
    request(app)
      .post('/api/stores')
      .set('Authorization', `Bearer ${vendorToken}`)
      .send({ imageUrl: 'https://example.com/i.jpg', ...body });

  it('GET /api/stores?lat&lng returns nearby stores nearest-first with distance', async () => {
    await makeStore({ name: 'Wuse Spot', address: 'Wuse 2, Abuja', lat: 9.0765, lng: 7.4803 });
    await makeStore({ name: 'Garki Spot', address: 'Garki, Abuja', lat: 9.0333, lng: 7.4833 });
    await makeStore({ name: 'Lekki Spot', address: 'Lekki, Lagos', lat: 6.4474, lng: 3.4723 });

    const res = await request(app).get('/api/stores?lat=9.0770&lng=7.4800');
    expect(res.status).toBe(200);
    expect(res.body.map((s) => s.name)).toEqual(['Wuse Spot', 'Garki Spot']);
    expect(res.body[0].distance).toBeLessThan(1);
    expect(res.body[0].latitude).toBeCloseTo(9.0765);
  });

  it('a store whose address cannot be located gets no fake coordinates', async () => {
    const res = await makeStore({ name: 'Nowhere', address: 'Somewhere unknown' });
    expect(res.status).toBe(201);
    expect(res.body.latitude).toBeNull();
  });

  it('PATCH /api/riders/:id/location stores the rider position', async () => {
    const reg = await registerRider();
    const res = await request(app)
      .patch(`/api/riders/${reg.body.rider._id}/location`)
      .set('Authorization', `Bearer ${reg.body.token}`)
      .send({ latitude: 9.07, longitude: 7.48 });
    expect(res.status).toBe(204);
  });

  it('customer addresses accept coordinates and come back with id + lat/lng', async () => {
    const token = await loginUser();
    const res = await request(app)
      .post('/api/users/me/addresses')
      .set('Authorization', `Bearer ${token}`)
      .send({ label: 'Home', address: '5 Aminu Kano Cres', city: 'Abuja', latitude: 9.07, longitude: 7.47 });
    expect(res.status).toBe(201);
    expect(res.body.addresses[0].id).toBeDefined();
    expect(res.body.addresses[0].latitude).toBe(9.07);
  });
});

// ── Profile avatar ───────────────────────────────────────────────────────────

describe('Profile avatar', () => {
  it('accepts a small image and rejects an oversized one', async () => {
    const token = await loginUser();
    const small = 'data:image/jpeg;base64,' + 'A'.repeat(1000);
    const ok = await request(app).patch('/api/users/me').set('Authorization', `Bearer ${token}`).send({ avatar: small });
    expect(ok.status).toBe(200);
    expect(ok.body.avatar).toBe(small);

    const huge = 'data:image/jpeg;base64,' + 'A'.repeat(700 * 1024);
    const bad = await request(app).patch('/api/users/me').set('Authorization', `Bearer ${token}`).send({ avatar: huge });
    expect(bad.status).toBe(400);
  });
});

describe('Signup location pins', () => {
  it('vendor and rider signup keep the map pin', async () => {
    const v = await registerVendor({ latitude: 9.0765, longitude: 7.4803 });
    expect(v.status).toBe(201);
    expect(v.body.vendor.latitude).toBeCloseTo(9.0765);

    const r = await registerRider({ latitude: 6.45, longitude: 3.47 });
    expect(r.status).toBe(201);
    expect(r.body.rider.longitude).toBeCloseTo(3.47);
  });
});

// ── Promotions ───────────────────────────────────────────────────────────────

describe('Promotions', () => {
  let adminToken;
  let storeId;
  let otherStoreId;
  let burgerId;

  beforeEach(async () => {
    adminToken = (await createAdmin()).token;
    const vendorToken = (await registerVendor({ email: 'promo-vendor@test.com' })).body.token;
    const mk = (name) =>
      request(app)
        .post('/api/stores')
        .set('Authorization', `Bearer ${vendorToken}`)
        .send({ name, address: 'Wuse, Abuja', imageUrl: 'https://x.com/i.jpg' });
    storeId = (await mk('Promo Store')).body._id;
    otherStoreId = (await mk('Other Store')).body._id;
    burgerId = await addMenuItem(vendorToken, storeId, 'Burger', 3000);
  });

  const createPromo = (body) =>
    request(app).post('/api/admin/promotions').set('Authorization', `Bearer ${adminToken}`).send(body);

  const order = (extra = {}) =>
    request(app).post('/api/orders').send({
      storeId,
      customerName: 'Ada',
      customerPhone: '08012345678',
      customerAddress: 'Wuse, Abuja',
      items: [{ menuItemId: burgerId, quantity: 2 }],
      ...extra,
    });

  it('only admins can create promos', async () => {
    const res = await request(app).post('/api/admin/promotions').send({ title: 'x', discountType: 'fixed', discountValue: 1 });
    expect(res.status).toBe(401);
  });

  it('shows live promos, filters stores by promo, and badges store cards', async () => {
    const promo = (await createPromo({
      title: '50% off at Promo Store', badge: '50% OFF', discountType: 'percent', discountValue: 50,
      scope: 'stores', storeIds: [storeId],
    })).body;
    await createPromo({ title: 'Old', discountType: 'fixed', discountValue: 100, endsAt: '2020-01-01' });

    const live = await request(app).get('/api/promotions');
    expect(live.body.map((p) => p.title)).toEqual(['50% off at Promo Store']);

    const stores = await request(app).get(`/api/stores?promotion=${promo.id}`);
    expect(stores.body.map((s) => s.name)).toEqual(['Promo Store']);
    expect(stores.body[0].promotions[0].badge).toBe('50% OFF');
  });

  it('applies a percent promo on the server, capped by maxDiscount', async () => {
    const promo = (await createPromo({
      title: 'Half off', discountType: 'percent', discountValue: 50, maxDiscount: 2000,
    })).body;
    const res = await order({ promotionId: promo.id });
    expect(res.status).toBe(201);
    expect(res.body.discountAmount).toBe(2000); // 50% of 6000 = 3000, capped at 2000
    expect(res.body.promotionTitle).toBe('Half off');
  });

  it('free delivery waives the delivery fee', async () => {
    const promo = (await createPromo({ title: 'Free delivery', discountType: 'free_delivery' })).body;
    const res = await order({ promotionId: promo.id });
    expect(res.body.discountAmount).toBe(800);
  });

  it('rejects a promo for the wrong store or below the minimum order', async () => {
    const onlyOther = (await createPromo({
      title: 'Other only', discountType: 'fixed', discountValue: 500, scope: 'stores', storeIds: [otherStoreId],
    })).body;
    const wrongStore = await order({ promotionId: onlyOther.id });
    expect(wrongStore.status).toBe(400);
    expect(wrongStore.body.promotionInvalid).toBe(true);

    const bigMin = (await createPromo({
      title: 'Big spenders', discountType: 'fixed', discountValue: 500, minOrderAmount: 10000,
    })).body;
    const quote = await request(app)
      .post(`/api/promotions/${bigMin.id}/quote`)
      .send({ storeId, subtotal: 6000, deliveryFee: 800 });
    expect(quote.body.eligible).toBe(false);
    expect(quote.body.amountNeeded).toBe(4000);
  });
});
