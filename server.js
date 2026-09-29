require('dotenv').config();
const app = require('./app');
const connectDB = require('./config/dbConfig');
const PORT = process.env.PORT || 5000;

// ─── Never die silently ─────────────────────────────────────────────────────
// A promise that fails with nobody handling it used to crash the whole API
// (Node's default), dropping every customer mid-request until Docker restarted
// it. Now it's logged and the server keeps running.
process.on('unhandledRejection', (reason) => {
  console.error('⚠️  Unhandled promise rejection (server kept running):', reason);
});
// A thrown error nobody caught leaves the process in an unknown state, so log
// it clearly and exit; Docker (restart: unless-stopped) starts a fresh one.
process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught exception — restarting:', err);
  shutdown('uncaughtException', 1);
});

connectDB();

// Log clearly at boot whether email works, instead of failing silently later.
require('./utils/mailer').verifyMailer();
{
  const provider = (process.env.SMS_PROVIDER || 'sendchamp').toLowerCase();
  const key = provider === 'termii' ? 'TERMII_API_KEY' : 'SENDCHAMP_API_KEY';
  if (!process.env[key]) console.error(`❌ SMS disabled — ${key} is not set (SMS_PROVIDER=${provider})`);
  else console.log(`📱 SMS provider: ${provider}`);
  if (process.env.REQUIRE_PHONE_VERIFICATION === 'false') {
    console.warn('⚠️  REQUIRE_PHONE_VERIFICATION=false — orders and approvals do NOT need a verified phone');
  }
}


const server = app.listen(PORT, () => {
  console.log(`We are live on http://localhost:${PORT}`);
});

// Keep idle connections open a little longer than nginx/load balancers do, so
// the proxy never reuses a connection Node has just closed (a common source of
// random "connection reset" failures).
server.keepAliveTimeout = 65 * 1000;
server.headersTimeout = 66 * 1000;

// ─── Graceful shutdown ──────────────────────────────────────────────────────
// On deploy Docker sends SIGTERM. Finish the requests in flight instead of
// cutting them off (customers would see "Could not reach the server").
let shuttingDown = false;
function shutdown(signal, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received — finishing open requests, then stopping.`);
  const force = setTimeout(() => process.exit(code), 10 * 1000);
  force.unref();
  server.close(async () => {
    try {
      await require('mongoose').connection.close(false);
    } catch {
      // closing anyway
    }
    process.exit(code);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app; // Export the app for testing purposes