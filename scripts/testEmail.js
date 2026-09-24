/**
 * Send the real contact + newsletter emails to an address and show the result.
 *
 *   node scripts/testEmail.js you@example.com
 */
require('dotenv').config();
const mailer = require('../utils/mailer');

(async () => {
  const to = process.argv[2];
  if (!to) {
    console.log('Usage: node scripts/testEmail.js <email>');
    process.exit(1);
  }
  console.log('From  :', process.env.SMTP_FROM, '| login:', process.env.SMTP_USER);
  console.log('Inbox :', process.env.CONTACT_INBOX || `${process.env.SMTP_FROM} (CONTACT_INBOX not set)`);

  if (!(await mailer.verifyMailer())) process.exit(1);

  const steps = [
    ['contact → support inbox', () =>
      mailer.sendContactNotification({ firstName: 'Test', lastName: 'User', email: to, message: 'Test message', id: 'test' })],
    ['contact acknowledgement', () => mailer.sendContactAcknowledgement(to, 'Test')],
    ['newsletter welcome', () => mailer.sendNewsletterWelcome(to, 'test-token')],
  ];
  for (const [name, run] of steps) {
    try {
      await run();
      console.log(`✅ ${name}`);
    } catch (err) {
      console.log(`❌ ${name}: ${err.message}`);
    }
  }
  console.log('\nCheck the inboxes (and spam folders).');
  process.exit(0);
})();
