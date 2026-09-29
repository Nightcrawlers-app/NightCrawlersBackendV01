const mongoose = require('mongoose');

/**
 * Connect to MongoDB (Atlas in production) and STAY connected.
 *
 * Before: if Atlas couldn't be reached at start-up the API exited, Docker
 * restarted it, it failed again… an endless loop in which nobody could use the
 * app. Mongo hiccups after start-up weren't logged at all.
 *
 * Now: start-up keeps retrying (the API stays up and /health reports the
 * database as down), and every disconnect/reconnect is logged with a time so
 * `docker logs nightcrawlers_api` shows exactly when and why.
 */
const RETRY_MS = 5000;

mongoose.connection.on('connected', () => console.log(`[${new Date().toISOString()}] MongoDB connected`));
mongoose.connection.on('reconnected', () => console.log(`[${new Date().toISOString()}] MongoDB reconnected`));
mongoose.connection.on('disconnected', () => console.warn(`[${new Date().toISOString()}] ⚠️  MongoDB disconnected`));
mongoose.connection.on('error', (err) => console.error(`[${new Date().toISOString()}] MongoDB error:`, err.message));

// app.js and server.js both call connectDB(); only connect once.
let connecting = null;
const connectDB = () => {
  if (!connecting) connecting = connectOnce();
  return connecting;
};

const connectOnce = async () => {
  if (!process.env.MONGODB_URI) {
    console.error('❌ MONGODB_URI is not set — the API cannot reach the database.');
    return;
  }
  for (let attempt = 1; ; attempt++) {
    try {
      console.log(attempt === 1 ? 'Connecting to MongoDB...' : `Connecting to MongoDB (attempt ${attempt})...`);
      await mongoose.connect(process.env.MONGODB_URI, {
        serverSelectionTimeoutMS: 10000, // give up on a request after 10s instead of hanging
        socketTimeoutMS: 45000,
        maxPoolSize: 20,
      });
      return;
    } catch (err) {
      console.error(`MongoDB connection failed: ${err.message}`);
      if (/IP|whitelist|not allowed|ENOTFOUND|querySrv/i.test(err.message)) {
        console.error('   → Check Atlas → Network Access: this server\'s public IP must be on the allow list.');
      }
      if (process.env.NODE_ENV === 'test') throw err;
      await new Promise((r) => setTimeout(r, RETRY_MS));
    }
  }
};

module.exports = connectDB;
