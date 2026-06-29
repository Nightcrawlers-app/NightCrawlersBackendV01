const jwt = require('jsonwebtoken');

const signToken = (id, role) =>
  jwt.sign({ id, role }, process.env.JWT_SECRET, { expiresIn: '30d' });

module.exports = { signToken };