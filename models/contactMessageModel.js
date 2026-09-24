const mongoose = require('mongoose');

// Every contact-form message is saved first, then emailed. If SMTP is down,
// nothing is lost — admins can still read them from the database.
const ContactMessageSchema = new mongoose.Schema(
  {
    firstName: { type: String, required: true, trim: true, maxlength: 100 },
    lastName: { type: String, default: '', trim: true, maxlength: 100 },
    email: { type: String, required: true, lowercase: true, trim: true, maxlength: 254 },
    message: { type: String, required: true, trim: true, maxlength: 5000 },
    emailed: { type: Boolean, default: false },
    emailError: { type: String, default: null },
    handled: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ContactMessage', ContactMessageSchema);
