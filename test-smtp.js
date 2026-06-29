require('dotenv').config();
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: true,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

transporter.verify((err, success) => {
  if (err) {
    console.error('❌ SMTP connection failed:', err.message);
    process.exit(1);
  }
  console.log('✅ SMTP connection successful — sending test email...');

  transporter.sendMail({
    from: `"Night Crawlers" <${process.env.SMTP_FROM}>`,
    to: process.env.SMTP_USER, // sends to yourself as a test
    subject: 'Night Crawlers SMTP test',
    text: 'If you received this, your Hostinger SMTP is working correctly.',
  }, (err, info) => {
    if (err) {
      console.error('❌ Send failed:', err.message);
    } else {
      console.log('✅ Test email sent:', info.messageId);
    }
    process.exit(0);
  });
});