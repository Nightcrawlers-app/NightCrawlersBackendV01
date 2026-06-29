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

const generateCode = () =>
  Math.floor(100000 + Math.random() * 900000).toString();

// ─── Shared style wrapper ─────────────────────────────────────────────────────

const wrap = (content) => `
  <div style="font-family:Poppins,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#fff;border:1px solid #eaecf0;border-radius:12px">
    <h1 style="color:#C62222;font-size:24px;margin:0 0 24px">Night Crawlers</h1>
    ${content}
    <p style="color:#98a2b3;font-size:12px;margin:32px 0 0;border-top:1px solid #eaecf0;padding-top:16px">
      Night Crawlers Inc. · Lagos, Nigeria<br/>
      Questions? Email <a href="mailto:${process.env.SMTP_FROM}" style="color:#C62222">${process.env.SMTP_FROM}</a>
    </p>
  </div>
`;

const codeBlock = (code) => `
  <div style="background:#f9fafb;border:1px solid #eaecf0;border-radius:8px;padding:24px;text-align:center;margin:0 0 24px">
    <span style="font-size:36px;font-weight:700;letter-spacing:12px;color:#C62222">${code}</span>
  </div>
`;

const button = (href, label) => `
  <a href="${href}" style="display:inline-block;background:#C62222;color:#fff;text-decoration:none;padding:12px 28px;border-radius:6px;font-weight:600;font-size:15px;margin:0 0 24px">
    ${label}
  </a>
`;

// ─── Customer emails ──────────────────────────────────────────────────────────

const sendVerificationEmail = async (to, firstName, code) => {
  await transporter.sendMail({
    from: `"Night Crawlers" <${process.env.SMTP_FROM}>`,
    to,
    subject: 'Verify your Night Crawlers account',
    html: wrap(`
      <p style="color:#222;font-size:16px;margin:0 0 8px">Hi ${firstName},</p>
      <p style="color:#667085;font-size:15px;margin:0 0 24px">
        Hello there! Use the code below to verify your email address. This code will expire in <strong>30 minutes</strong>.
      </p>
      ${codeBlock(code)}
      <p style="color:#667085;font-size:13px;margin:0">
        If you didn't create a Night Crawlers account, you can safely ignore this email.
      </p>
    `),
  });
};

const sendWelcomeEmail = async (to, firstName) => {
  await transporter.sendMail({
    from: `"Night Crawlers" <${process.env.SMTP_FROM}>`,
    to,
    subject: 'Welcome to Night Crawlers 🎉',
    html: wrap(`
      <p style="color:#222;font-size:16px;margin:0 0 8px">Welcome, ${firstName}! 🎉</p>
      <p style="color:#667085;font-size:15px;margin:0 0 16px">
        Hello there! Your account is verified and ready to go. Here's what you can do:
      </p>
      <ul style="color:#667085;font-size:15px;padding-left:20px;margin:0 0 24px">
        <li style="margin-bottom:8px">Browse hundreds of restaurants, groceries, pharmacies and more</li>
        <li style="margin-bottom:8px">Get fast delivery right to your door</li>
        <li style="margin-bottom:8px">Track your orders in real time</li>
        <li>Save your favourite vendors for next time</li>
      </ul>
      ${button(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/explore`, 'Start exploring')}
    `),
  });
};

const sendPasswordResetEmail = async (to, firstName, code) => {
  await transporter.sendMail({
    from: `"Night Crawlers" <${process.env.SMTP_FROM}>`,
    to,
    subject: 'Reset your Night Crawlers password',
    html: wrap(`
      <p style="color:#222;font-size:16px;margin:0 0 8px">Hi ${firstName},</p>
      <p style="color:#667085;font-size:15px;margin:0 0 24px">
        Hello there! We received a request to reset your password. Use the code below — it will expire in <strong>30 minutes</strong>.
      </p>
      ${codeBlock(code)}
      <p style="color:#667085;font-size:13px;margin:0">
        If you didn't request a password reset, you can safely ignore this email. Your password won't change.
      </p>
    `),
  });
};

const sendNewLocationEmail = async (to, firstName, code, ip) => {
  await transporter.sendMail({
    from: `"Night Crawlers" <${process.env.SMTP_FROM}>`,
    to,
    subject: 'New login detected on your Night Crawlers account',
    html: wrap(`
      <p style="color:#222;font-size:16px;margin:0 0 8px">Hi ${firstName},</p>
      <p style="color:#667085;font-size:15px;margin:0 0 24px">
        Hello there! We detected a login attempt from a new location${ip ? ` <strong>(${ip})</strong>` : ''}.
        Enter the code below to confirm it's you. It will expire in <strong>30 minutes</strong>.
      </p>
      ${codeBlock(code)}
      <p style="color:#667085;font-size:13px;margin:0">
        If this wasn't you, please reset your password immediately.
      </p>
    `),
  });
};

const sendPasswordChangedEmail = async (to, firstName) => {
  await transporter.sendMail({
    from: `"Night Crawlers" <${process.env.SMTP_FROM}>`,
    to,
    subject: 'Your Night Crawlers password was changed',
    html: wrap(`
      <p style="color:#222;font-size:16px;margin:0 0 8px">Hi ${firstName},</p>
      <p style="color:#667085;font-size:15px;margin:0 0 24px">
        Hello there! Your account password was successfully changed on <strong>${new Date().toUTCString()}</strong>.
      </p>
      <p style="color:#667085;font-size:15px;margin:0 0 24px">
        If you made this change, no further action is needed.
        If you didn't change your password, please reset it immediately.
      </p>
      ${button(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/forgot-password`, 'Reset my password')}
    `),
  });
};

const sendAccountUpdatedEmail = async (to, firstName, changes) => {
  const changeList = changes
    .map((c) => `<li style="margin-bottom:6px">${c}</li>`)
    .join('');

  await transporter.sendMail({
    from: `"Night Crawlers" <${process.env.SMTP_FROM}>`,
    to,
    subject: 'Your Night Crawlers account was updated',
    html: wrap(`
      <p style="color:#222;font-size:16px;margin:0 0 8px">Hi ${firstName},</p>
      <p style="color:#667085;font-size:15px;margin:0 0 16px">
        Hello there! The following changes were made to your account on <strong>${new Date().toUTCString()}</strong>:
      </p>
      <ul style="color:#667085;font-size:15px;padding-left:20px;margin:0 0 24px">
        ${changeList}
      </ul>
      <p style="color:#667085;font-size:13px;margin:0">
        If you didn't make these changes, please contact us immediately at
        <a href="mailto:${process.env.SMTP_FROM}" style="color:#C62222">${process.env.SMTP_FROM}</a>.
      </p>
    `),
  });
};

// ─── Vendor / Rider emails ────────────────────────────────────────────────────

const sendVendorWelcomeEmail = async (to, firstName, businessType) => {
  await transporter.sendMail({
    from: `"Night Crawlers" <${process.env.SMTP_FROM}>`,
    to,
    subject: 'Welcome to Night Crawlers — Partner Application Received',
    html: wrap(`
      <p style="color:#222;font-size:16px;margin:0 0 8px">Hi ${firstName},</p>
      <p style="color:#667085;font-size:15px;margin:0 0 16px">
        Hello there! Thanks for applying to become a <strong>${businessType}</strong> partner on Night Crawlers!
        We've received your application and our team will review it within <strong>24–48 hours</strong>.
      </p>
      <div style="background:#f9fafb;border:1px solid #eaecf0;border-radius:8px;padding:16px 20px;margin:0 0 24px">
        <p style="color:#222;font-size:14px;font-weight:600;margin:0 0 8px">What happens next?</p>
        <ul style="color:#667085;font-size:14px;padding-left:16px;margin:0">
          <li style="margin-bottom:6px">Our admin team reviews your application</li>
          <li style="margin-bottom:6px">You'll receive an email once approved</li>
          <li>You can then log in and start adding your stores and menu items</li>
        </ul>
      </div>
      <p style="color:#667085;font-size:13px;margin:0">
        Questions? Reply to this email or contact us at
        <a href="mailto:${process.env.SMTP_FROM}" style="color:#C62222">${process.env.SMTP_FROM}</a>.
      </p>
    `),
  });
};

const sendVendorApprovedEmail = async (to, firstName) => {
  await transporter.sendMail({
    from: `"Night Crawlers" <${process.env.SMTP_FROM}>`,
    to,
    subject: '🎉 Your Night Crawlers partner account is approved!',
    html: wrap(`
      <p style="color:#222;font-size:16px;margin:0 0 8px">Great news, ${firstName}!</p>
      <p style="color:#667085;font-size:15px;margin:0 0 24px">
        Hello there! Your partner account has been approved. You can now log in to your dashboard,
        add your stores, and start receiving orders.
      </p>
      ${button(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/vendor-signin`, 'Go to my dashboard')}
    `),
  });
};

const sendVendorRejectedEmail = async (to, firstName) => {
  await transporter.sendMail({
    from: `"Night Crawlers" <${process.env.SMTP_FROM}>`,
    to,
    subject: 'Update on your Night Crawlers partner application',
    html: wrap(`
      <p style="color:#222;font-size:16px;margin:0 0 8px">Hi ${firstName},</p>
      <p style="color:#667085;font-size:15px;margin:0 0 24px">
        Hello there! Unfortunately, we were unable to approve your partner application at this time.
        Please contact us if you have questions or would like to reapply.
      </p>
      <p style="color:#667085;font-size:13px;margin:0">
        Email us at <a href="mailto:${process.env.SMTP_FROM}" style="color:#C62222">${process.env.SMTP_FROM}</a>.
      </p>
    `),
  });
};

const sendRiderWelcomeEmail = async (to, firstName, vehicleType) => {
  await transporter.sendMail({
    from: `"Night Crawlers" <${process.env.SMTP_FROM}>`,
    to,
    subject: 'Welcome to Night Crawlers — Rider Application Received',
    html: wrap(`
      <p style="color:#222;font-size:16px;margin:0 0 8px">Hi ${firstName},</p>
      <p style="color:#667085;font-size:15px;margin:0 0 16px">
        Hello there! Thanks for applying to join the Night Crawlers rider fleet with your <strong>${vehicleType}</strong>!
        Our team will review your application within <strong>24–48 hours</strong>.
      </p>
      <div style="background:#f9fafb;border:1px solid #eaecf0;border-radius:8px;padding:16px 20px;margin:0 0 24px">
        <p style="color:#222;font-size:14px;font-weight:600;margin:0 0 8px">What happens next?</p>
        <ul style="color:#667085;font-size:14px;padding-left:16px;margin:0">
          <li style="margin-bottom:6px">Our admin team reviews your application</li>
          <li style="margin-bottom:6px">You'll receive an email once approved</li>
          <li>You can then go online and start accepting deliveries</li>
        </ul>
      </div>
      <p style="color:#667085;font-size:13px;margin:0">
        Hello there! Questions? Contact us at
        <a href="mailto:${process.env.SMTP_FROM}" style="color:#C62222">${process.env.SMTP_FROM}</a>.
      </p>
    `),
  });
};

const sendRiderApprovedEmail = async (to, firstName) => {
  await transporter.sendMail({
    from: `"Night Crawlers" <${process.env.SMTP_FROM}>`,
    to,
    subject: '🎉 Your Night Crawlers rider account is approved!',
    html: wrap(`
      <p style="color:#222;font-size:16px;margin:0 0 8px">Great news, ${firstName}!</p>
      <p style="color:#667085;font-size:15px;margin:0 0 24px">
        Hello there! Your rider account has been approved. Log in, go online, and start earning!
      </p>
      ${button(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/vendor-signin`, 'Go to rider dashboard')}
    `),
  });
};

const sendRiderRejectedEmail = async (to, firstName) => {
  await transporter.sendMail({
    from: `"Night Crawlers" <${process.env.SMTP_FROM}>`,
    to,
    subject: 'Update on your Night Crawlers rider application',
    html: wrap(`
      <p style="color:#222;font-size:16px;margin:0 0 8px">Hi ${firstName},</p>
      <p style="color:#667085;font-size:15px;margin:0 0 24px">
        Hello there! Unfortunately, we were unable to approve your rider application at this time.
        Please contact us if you have questions or would like to reapply.
      </p>
      <p style="color:#667085;font-size:13px;margin:0">
        Email us at <a href="mailto:${process.env.SMTP_FROM}" style="color:#C62222">${process.env.SMTP_FROM}</a>.
      </p>
    `),
  });
};

module.exports = {
  generateCode,
  sendVerificationEmail,
  sendWelcomeEmail,
  sendPasswordResetEmail,
  sendNewLocationEmail,
  sendPasswordChangedEmail,
  sendAccountUpdatedEmail,
  sendVendorWelcomeEmail,
  sendVendorApprovedEmail,
  sendVendorRejectedEmail,
  sendRiderWelcomeEmail,
  sendRiderApprovedEmail,
  sendRiderRejectedEmail,
};
