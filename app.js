require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser'); 

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
const smileIdRoutes = require('./routes/smileIdRoutes');
const swaggerUi = require("swagger-ui-express");
const swaggerFile = require("./swagger-output.json");

const app = express();

// ─── CORS ─────────────────────────────────────────────────────────────────────
// Must be before all routes. credentials: true is required for cookies to work
// cross-origin (Vercel frontend ↔ GCP backend).
const allowedOrigins = [
  process.env.FRONTEND_URL,          // https://night-crawlers.vercel.app
  'http://localhost:5173',           // Vite dev server
  'http://localhost:3000',
].filter(Boolean);
 
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (curl, Postman, Jest supertest)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,   // ← required for cookies
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
 
// ─── Body & Cookie parsing ────────────────────────────────────────────────────
app.use(cookieParser());                        // ← parse cookies from every request

app.use(express.json({ limit: '10mb' })); // 10mb to allow base64 image uploads

connectDB();


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
app.use('/api/kyc', smileIdRoutes); 

// ─── Stores & Menu ──────────────────────────────────────────────────────────
app.use('/api/stores', storeRoutes);       // explore, store CRUD
app.use('/api', menuItemRoutes);           // /api/menu-items, /api/stores/:id/menu-items

// ─── Orders ─────────────────────────────────────────────────────────────────
app.use('/api/orders', orderRoutes);       // order CRUD, status, rider accept

// ─── Earnings (vendor/rider self-service) ───────────────────────────────────
app.use('/api', earningsRoutes);

// ─── Admin dashboard ────────────────────────────────────────────────────────
app.use('/api/admin', adminRoutes);

app.get('/', (req, res) => res.json({ status: 'ok', message: 'Night Crawlers API' }));

app.get("/health", (req, res) => {
  res.json({ status: 'ok', message: 'API is healthy' });
});

app.get("/api-docs-test", (req, res) => {
  res.send("Swagger route works");
});

// 404 handler
app.use((req, res) => res.status(404).json({ message: 'Not found' }));

// Global error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ message: 'Internal server error' });
});


module.exports = app;
