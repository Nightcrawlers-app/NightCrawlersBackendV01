/**
 * Create an admin account (or reset an admin's password).
 *
 *   node scripts/createAdmin.js
 *
 * It asks for a username, email and password. The password is typed hidden
 * and is never printed or saved anywhere except as a bcrypt hash in MongoDB.
 *
 * It writes to whichever database MONGODB_URI in .env points to — run it on
 * each environment (your laptop's DB, and the VM's) that needs an admin.
 * On the VM (Docker):
 *   docker exec -it nightcrawlers_api node scripts/createAdmin.js
 */
require('dotenv').config();
const readline = require('readline');
const mongoose = require('mongoose');
const Admin = require('../models/adminModel');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const ask = (q) => new Promise((resolve) => rl.question(q, (a) => resolve(a.trim())));

/** Ask without echoing what's typed. */
const askHidden = (q) =>
  new Promise((resolve) => {
    const write = rl._writeToOutput;
    rl._writeToOutput = (s) => {
      // Show the prompt, hide the keystrokes
      if (s.includes(q)) write.call(rl, q);
    };
    rl.question(q, (a) => {
      rl._writeToOutput = write;
      process.stdout.write('\n');
      resolve(a);
    });
  });

(async () => {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set in .env');
  await mongoose.connect(process.env.MONGODB_URI);
  const dbName = mongoose.connection.name;
  const host = mongoose.connection.host;
  console.log(`\nConnected to database "${dbName}" on ${host}\n`);

  const existing = await Admin.find({}, 'username email').lean();
  if (existing.length) {
    console.log('Existing admins:');
    existing.forEach((a) => console.log(`  - ${a.username} <${a.email}>`));
    console.log('');
  }

  const email = (await ask('Admin email: ')).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new Error('That email looks wrong.');

  const found = await Admin.findOne({ email });
  if (found) {
    const yes = (await ask(`${email} is already an admin. Reset their password? (y/N): `)).toLowerCase();
    if (yes !== 'y') {
      console.log('Nothing changed.');
      return;
    }
  }

  const username = found ? found.username : await ask('Username (shown in the dashboard): ');
  if (!username) throw new Error('Username is required.');

  const password = await askHidden('Password (min 12 characters, hidden): ');
  if (password.length < 12) throw new Error('Password must be at least 12 characters.');
  const confirm = await askHidden('Type it again: ');
  if (password !== confirm) throw new Error("Passwords don't match.");

  if (found) {
    found.password = password; // hashed by the model's pre-save hook
    await found.save();
    console.log(`\n✅ Password reset for ${email}.`);
  } else {
    await Admin.create({ username, email, password });
    console.log(`\n✅ Admin created: ${username} <${email}>. Log in at /admin-login.`);
  }
})()
  .catch((err) => {
    console.error(`\n❌ ${err.code === 11000 ? 'That username or email is already taken.' : err.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    rl.close();
    await mongoose.disconnect();
  });
