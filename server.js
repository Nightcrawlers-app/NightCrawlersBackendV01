require('dotenv').config();
const app = require('./app');
const connectDB = require('./config/dbConfig');
const PORT = process.env.PORT || 5000;

connectDB();

// Log clearly at boot whether email works, instead of failing silently later.
require('./utils/mailer').verifyMailer();
if (!process.env.SENDCHAMP_API_KEY) {
  console.error('❌ SMS disabled — SENDCHAMP_API_KEY is not set (phone verification will fail)');
}


app.listen(PORT, () => { 
    console.log(`We are live on http://localhost:${PORT}`); 
});

module.exports = app; // Export the app for testing purposes