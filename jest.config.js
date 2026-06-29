// jest.config.js
// Place this in your project root
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  collectCoverage: true,
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov'],
  coveragePathIgnorePatterns: ['/node_modules/', '/tests/'],
  testTimeout: 60000, // 60s — MongoMemoryServer can be slow on cold start
  verbose: true,
};

/*
  ── Add to package.json ──────────────────────────────────────────────────────

  "scripts": {
    "test": "jest --forceExit",
    "test:watch": "jest --watch",
    "test:coverage": "jest --coverage --forceExit",
    "lint": "eslint . --ext .js --ignore-path .gitignore"
  },
  "devDependencies": {
    "jest": "^29.x",
    "supertest": "^6.x",
    "mongodb-memory-server": "^9.x",
    "eslint": "^8.x"
  }

  ── .env.test (optional, jest picks up NODE_ENV=test automatically) ──────────

  NODE_ENV=test
  MONGODB_URI=mongodb://localhost:27017/nightcrawlers_test
  JWT_SECRET=test_jwt_secret_not_for_prod
  SMTP_HOST=smtp.example.com
  SMTP_PORT=465
  SMTP_USER=test@example.com
  SMTP_PASS=test
  SMTP_FROM=test@nightcrawlers.com
  FRONTEND_URL=https://night-crawlers.vercel.app
*/
