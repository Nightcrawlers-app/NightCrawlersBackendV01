const express = require('express');
const router = express.Router();
const { sendContactEmail } = require('../utils/mailer');

router.post('/', async (req, res) => {
  try {
    const { firstName, lastName, email, message } = req.body;

    if (!email || !message) {
      return res.status(400).json({ message: 'Email and message are required.' });
    }

    await sendContactEmail({ firstName, lastName, email, message });

    res.json({ message: "Thanks, we've got your message. We'll be in touch shortly." });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;