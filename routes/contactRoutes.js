const express = require('express');
const ContactMessage = require('../models/contactMessageModel');
const Subscriber = require('../models/subscriberModel');
const {
  sendContactNotification,
  sendContactAcknowledgement,
  sendNewsletterWelcome,
} = require('../utils/mailer');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const clean = (v, max) => String(v ?? '').trim().slice(0, max);

// ── Very small per-IP rate limit (no extra dependency) ───────────────────────
// Stops a bot from flooding the support inbox. 5 requests / 10 minutes / IP.
const hits = new Map();
const rateLimit = (limit = 5, windowMs = 10 * 60 * 1000) => (req, res, next) => {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip;
  const key = `${req.path}:${ip}`;
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) {
    return res.status(429).json({ message: 'Too many requests. Please try again in a few minutes.' });
  }
  recent.push(now);
  hits.set(key, recent);
  next();
};

// POST /api/contact — contact form
router.post('/contact', rateLimit(), async (req, res) => {
  try {
    const firstName = clean(req.body.firstName, 100);
    const lastName = clean(req.body.lastName, 100);
    const email = clean(req.body.email, 254).toLowerCase();
    const message = clean(req.body.message, 5000);

    // Honeypot: real users never fill a hidden "website" field
    if (req.body.website) return res.status(201).json({ message: 'Message received.' });

    if (!firstName || !email || !message) {
      return res.status(400).json({ message: 'First name, email and message are required.' });
    }
    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ message: 'Please enter a valid email address.' });
    }

    const saved = await ContactMessage.create({ firstName, lastName, email, message });

    try {
      await sendContactNotification({ firstName, lastName, email, message, id: saved._id });
      saved.emailed = true;
    } catch (err) {
      // Message is safely stored; log the mail failure but don't fail the user.
      console.error('Contact notification email failed:', err.message);
      saved.emailError = err.message;
    }
    await saved.save();

    sendContactAcknowledgement(email, firstName).catch((err) =>
      console.error('Contact acknowledgement email failed:', err.message)
    );

    res.status(201).json({ message: "Thanks, we've got your message." });
  } catch (err) {
    console.error('Contact form failed:', err);
    res.status(500).json({ message: 'Could not send your message. Please try again.' });
  }
});

// POST /api/newsletter — subscribe
router.post('/newsletter', rateLimit(), async (req, res) => {
  try {
    const email = clean(req.body.email, 254).toLowerCase();
    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ message: 'Please enter a valid email address.' });
    }

    const existing = await Subscriber.findOne({ email });
    if (existing && existing.status === 'subscribed') {
      // Same response either way — don't reveal who is on the list.
      return res.status(200).json({ message: "You're on the list." });
    }

    const sub = existing || new Subscriber({ email });
    sub.status = 'subscribed';
    sub.subscribedAt = new Date();
    sub.unsubscribedAt = null;
    await sub.save();

    sendNewsletterWelcome(email, sub.unsubscribeToken).catch((err) =>
      console.error('Newsletter welcome email failed:', err.message)
    );

    res.status(201).json({ message: "You're on the list." });
  } catch (err) {
    console.error('Newsletter subscribe failed:', err);
    res.status(500).json({ message: 'Could not subscribe you just now. Please try again.' });
  }
});

// GET /api/newsletter/unsubscribe?token=... — one-click unsubscribe from email
router.get('/newsletter/unsubscribe', async (req, res) => {
  const token = clean(req.query.token, 100);
  const sub = token ? await Subscriber.findOne({ unsubscribeToken: token }) : null;
  if (sub && sub.status !== 'unsubscribed') {
    sub.status = 'unsubscribed';
    sub.unsubscribedAt = new Date();
    await sub.save();
  }
  res
    .type('html')
    .send(
      '<div style="font-family:sans-serif;max-width:420px;margin:80px auto;text-align:center">' +
        '<h2 style="color:#C62222">Night Crawlers</h2>' +
        "<p>You've been unsubscribed. You won't get any more newsletter emails.</p></div>"
    );
});

module.exports = router;
