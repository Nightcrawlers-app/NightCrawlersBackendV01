/**
 * Send a real test SMS and print exactly what Sendchamp says.
 *
 *   node scripts/testSms.js 08012345678
 *
 * If the reply looks fine but nothing arrives, the usual causes are:
 *   - a TEST key (starts with "sendchamp_test_") — test keys never deliver
 *   - no money in the Sendchamp wallet
 *   - SENDCHAMP_SENDER_NAME not approved yet (leave it as "Sendchamp" until it is)
 */
require('dotenv').config();
const axios = require('axios');
const { sendSms, normalizePhone, smsProvider } = require('../utils/smsService');

(async () => {
  const to = process.argv[2];
  if (!to) {
    console.log('Usage: node scripts/testSms.js <phone number>');
    process.exit(1);
  }
  console.log('Provider :', smsProvider(), '(set SMS_PROVIDER=termii to switch)');
  console.log('To       :', normalizePhone(to));
  if (smsProvider() === 'termii') {
    console.log('Sender   :', process.env.TERMII_SENDER_ID || 'N-Alert (default)');
    console.log('Base URL :', process.env.TERMII_BASE_URL || 'https://api.ng.termii.com (default)');
    try {
      await sendSms(to, 'NightCrawlers test message. If you got this, SMS works.');
      console.log('\n✅ Termii accepted the message (reply above).');
    } catch (err) {
      console.log('\n❌', err.message);
    }
    return;
  }
  const key = process.env.SENDCHAMP_API_KEY || '';
  console.log('Key type :', !key ? 'MISSING' : /test/i.test(key) ? 'TEST key (will not deliver)' : 'live key');
  console.log('Sender   :', process.env.SENDCHAMP_SENDER_NAME || 'Sendchamp (default)');

  try {
    const { data } = await axios.get('https://api.sendchamp.com/api/v1/wallet/wallet_balance', {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      timeout: 10000,
    });
    console.log('Wallet   :', JSON.stringify(data?.data ?? data));
  } catch (err) {
    console.log('Wallet   : could not check —', err.response?.data?.message || err.message);
  }

  try {
    await sendSms(to, 'NightCrawlers test message. If you got this, SMS works.');
    console.log('\n✅ Sendchamp accepted the message (full reply above).');
  } catch (err) {
    console.log('\n❌', err.message);
  }
})();
