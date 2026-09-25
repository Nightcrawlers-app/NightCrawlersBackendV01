require('dotenv').config();
const app = require('./app');
const PORT = process.env.PORT || 5000;

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


app.listen(PORT, () => { 
    console.log(`We are live on http://localhost:${PORT}`); 
});

module.exports = app; // Export the app for testing purposes