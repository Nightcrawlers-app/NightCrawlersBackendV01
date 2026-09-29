require('dotenv').config();
require('./utils/asyncErrors'); // async route errors → error handler (must be first)
const express = require('express');
const cors = require('cors');

const connectDB = require('./config/dbConfig');
const userAuthRoutes = require('./routes/userAuthRoutes');
const userRoutes = require('./routes/userRoutes');
const vendorRoutes = require('./routes/vendorRoutes');
const riderRoutes = require('./routes/riderRoutes');
const adminAuthRoutes = require('./routes/adminAuthRoutes');
const storeRoutes = require('./routes/storeRoutes');
const menuItemRoutes = require('./routes/menuItemRoutes');
const orderRoutes = require('./routes/orderRoutes');
const adminRoutes = require('./routes/adminRoutes');
const earningsRoutes = require('./routes/earningsRoutes');
const { createPhoneVerificationRoutes } = require('./routes/phoneVerificationRoutes');
const { createBankVerificationRoutes } = require('./routes/bankVerificationRoutes');
const User = require('./models/userModel');
const Vendor = require('./models/vendorModel');
const Rider = require('./models/riderModel');
const riderKycRoutes = require('./routes/riderKycRoutes');
const vendorKycRoutes = require('./routes/vendorKycRoutes');
const adminKycRoutes = require('./routes/adminKycRoutes');
const geoRoutes = require('./routes/geoRoutes');
const contactRoutes = require('./routes/contactRoutes');
const promotionRoutes = require('./routes/promotionRoutes');
const placementRoutes = require('./routes/placementRoutes');
const { router: paymentRoutes } = require('./routes/paymentRoutes');
const swaggerUi = require("swagger-ui-express");
const swaggerFile = require("./swagger-output.json");

const app = express();

// Behind nginx: lets req.ip / req.protocol reflect the real client.
app.set('trust proxy', 1);

// ─── CORS: only our own frontends may call the API from a browser ───────────
// FRONTEND_URL (and optional CORS_ORIGINS) are comma-separated lists, e.g.
//   FRONTEND_URL=https://nightcrawlers.app,https://night-crawlers.vercel.app
// Requests with no Origin header (curl, Paystack webhooks, mobile apps) are
// not affected — CORS only restricts browsers.
const allowedOrigins = new Set(
  [process.env.FRONTEND_URL, process.env.CORS_ORIGINS]
    .filter(Boolean)
    .flatMap((v) => v.split(','))
    .map((v) => v.trim().replace(/\/$/, ''))
    .filter(Boolean)
);
if (process.env.NODE_ENV !== 'production') {
  ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:4173'].forEach((o) => allowedOrigins.add(o));
}
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.has(origin)) return callback(null, true);
      // Vercel preview deployments, if enabled: https://night-crawlers-git-branch-you.vercel.app
      if (process.env.CORS_ALLOW_VERCEL_PREVIEWS === 'true' && /^https:\/\/night-crawlers[a-z0-9-]*\.vercel\.app$/.test(origin)) {
        return callback(null, true);
      }
      return callback(null, false); // browser blocks it; no error noise in logs
    },
  })
);

// 10mb to allow base64 image uploads. `rawBody` is kept for verifying the
// signature on Paystack webhooks, which must be checked against exact bytes.
app.use(
  express.json({
    limit: '10mb',
    verify: (req, res, buf) => {
      if (req.originalUrl.startsWith('/api/payments/paystack/webhook')) req.rawBody = buf;
    },
  })
);

connectDB();

// While the database is fully disconnected, answer API calls straight away
// with 503 "try again" instead of making the customer wait 10 seconds for a
// generic error. (While it's reconnecting, requests wait briefly as usual.)
// /api/config needs no database, so it's left alone.
app.use('/api', (req, res, next) => {
  const mongoose = require('mongoose');
  if (mongoose.connection.readyState !== 0 || req.path === '/config' || process.env.NODE_ENV === 'test') return next();
  res.set('Retry-After', '10');
  res.status(503).json({ message: 'We’re having trouble reaching our database. Please try again in a few seconds.', retryAfter: 10 });
});


app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(swaggerFile));

// ─── Auth ───────────────────────────────────────────────────────────────────
app.use('/api/auth', userAuthRoutes);          // customer signup/login/me
app.use('/api/users', userRoutes);         // customer profile, addresses, password
app.use('/api/vendors', vendorRoutes);     // vendor signup/login/me
app.use('/api/riders', riderRoutes);       // rider signup/login/me/status
app.use('/api/admins', adminAuthRoutes);   // admin login/me

// ─── Phone Verification (mounted once per role) ─────────────────────────────
app.use('/api/users/me/phone', createPhoneVerificationRoutes(User, 'customer'));
app.use('/api/vendors/me/phone', createPhoneVerificationRoutes(Vendor, 'vendor'));
app.use('/api/riders/me/phone', createPhoneVerificationRoutes(Rider, 'rider'));

// ─── Bank Verification (mounted once per role) ──────────────────────────────
app.use('/api/vendors/me/bank', createBankVerificationRoutes(Vendor, 'vendor'));
app.use('/api/riders/me/bank', createBankVerificationRoutes(Rider, 'rider'));

// ─── KYC Routes ──────────────────────────────────────────────────────────────
app.use('/api/riders', riderKycRoutes);      // GET/POST /api/riders/me/kyc/...
app.use('/api/vendors', vendorKycRoutes);    // GET/POST /api/vendors/me/kyc/...
app.use('/api/admin', adminKycRoutes);       // GET/POST /api/admin/kyc/...
 
// ─── Geocoding (address search / reverse lookup) ────────────────────────────
app.use('/api/geo', geoRoutes);           // GET /api/geo/search, /api/geo/reverse

// ─── Payments (Paystack) ────────────────────────────────────────────────────
app.use('/api/payments', paymentRoutes);

// ─── Promotions ─────────────────────────────────────────────────────────────
app.use('/api/promotions', promotionRoutes.publicRouter);        // live promos, quotes
app.use('/api/admin/promotions', promotionRoutes.adminRouter);   // admin CRUD

// ─── Sponsored tiles ("Popular on Nightcrawlers" ads) ───────────────────────
app.use('/api/placements', placementRoutes.publicRouter);        // live ads per tab, click counts
app.use('/api/admin/placements', placementRoutes.adminRouter);   // admin CRUD

// ─── Marketing site ─────────────────────────────────────────────────────────
app.use('/api', contactRoutes);           // POST /api/contact, POST /api/newsletter

// ─── Stores & Menu ──────────────────────────────────────────────────────────
app.use('/api/stores', storeRoutes);       // explore, store CRUD
app.use('/api', menuItemRoutes);           // /api/menu-items, /api/stores/:id/menu-items

// ─── Orders ─────────────────────────────────────────────────────────────────
app.use('/api/orders', orderRoutes);       // order CRUD, status, rider accept

// ─── Earnings (vendor/rider self-service) ───────────────────────────────────
app.use('/api', earningsRoutes);

// ─── Admin dashboard ────────────────────────────────────────────────────────
app.use('/api/admin', adminRoutes);

app.get('/', (req, res) => res.json({ status: 'ok', message: 'Nightcrawlers API' }));

// GET /api/config — public settings the frontend needs (fees, feature switches)
app.get('/api/config', (req, res) => res.json(require('./utils/settings').publicConfig()));

// GET /health — is the API up, and can it reach the database?
// 503 while MongoDB is disconnected, so monitoring (and you) can tell
// "server down" apart from "database down".
app.get("/health", (req, res) => {
  const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];
  const state = require('mongoose').connection.readyState;
  const ok = state === 1;
  res.status(ok ? 200 : 503).json({
    status: ok ? 'ok' : 'degraded',
    database: states[state] || 'unknown',
    uptimeSeconds: Math.round(process.uptime()),
    memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
  });
});

app.get("/api-docs-test", (req, res) => {
  res.send("Swagger route works");
});

// 404 handler
app.use((req, res) => res.status(404).json({ message: 'Not found' }));

// Global error handler
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  // Database unreachable (Atlas blip, IP not allowed, network drop): tell the
  // app to try again shortly, rather than a generic 500. The frontend retries
  // 503s on page loads automatically.
  const dbDown =
    /^Mongo(ServerSelection|Network|NotConnected)Error$/.test(err?.name) ||
    /buffering timed out|Client must be connected|connection .* closed/i.test(err?.message || '');
  if (dbDown) {
    console.error(`[${new Date().toISOString()}] Database unavailable for ${req.method} ${req.originalUrl}: ${err.message}`);
    res.set('Retry-After', '10');
    return res.status(503).json({ message: 'We’re having trouble reaching our database. Please try again in a few seconds.', retryAfter: 10 });
  }
  console.error(err);
  res.status(500).json({ message: 'Internal server error' });
});


module.exports = app; // Export the app for testing
