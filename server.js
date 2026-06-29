require('dotenv').config();
const express = require('express');
const cors = require('cors');
const connectDB = require('./config/dbConfig');

const userAuthRoutes = require('./routes/userAuthRoutes');
const userRoutes = require('./routes/userRoutes');
const vendorAuthRoutes = require('./routes/vendorAuthRoutes');
const vendorRoutes = require('./routes/vendorRoutes');
const riderAuthRoutes = require('./routes/riderAuthRoutes');
const riderRoutes = require('./routes/riderRoutes');
const adminAuthRoutes = require('./routes/adminAuthRoutes');
const storeRoutes = require('./routes/storeRoutes');
const menuItemRoutes = require('./routes/menuItemRoutes');
const orderRoutes = require('./routes/orderRoutes');
const adminRoutes = require('./routes/adminRoutes');
const earningsRoutes = require('./routes/earningsRoutes');

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' })); // 10mb to allow base64 image uploads

connectDB();

// ─── Auth ───────────────────────────────────────────────────────────────────
app.use('/api/auth', userAuthRoutes);          // customer signup/login/me
app.use('/api/users', userRoutes);         // customer profile, addresses, password
app.use('/api/vendors', vendorRoutes);     // vendor signup/login/me
app.use('/api/riders', riderRoutes);       // rider signup/login/me/status
app.use('/api/admins', adminAuthRoutes);   // admin login/me

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

// 404 handler
app.use((req, res) => res.status(404).json({ message: 'Not found' }));

// Global error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ message: 'Internal server error' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`We are live on http://localhost:${PORT}`));
module.exports = app; // Export the app for testing
