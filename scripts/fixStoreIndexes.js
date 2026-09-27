/**
 * Removes out-of-date indexes on the stores collection and creates the ones
 * the current code expects.
 *
 *   node scripts/fixStoreIndexes.js           show what would change
 *   node scripts/fixStoreIndexes.js --apply   do it
 *
 * Why: MongoDB keeps old indexes when the code changes. An older version of
 * the store model had a text index that included `categories`, and MongoDB
 * can't build that kind of index over a list — so saving ANY store with
 * categories fails with "Field 'categories' of text index contains an array".
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Store = require('../models/storeModel');

const APPLY = process.argv.includes('--apply');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`\nDatabase: "${mongoose.connection.name}" on ${mongoose.connection.host}`);

  const current = await Store.collection.indexes();
  console.log('\nIndexes now on "stores":');
  current.forEach((i) => console.log(`  - ${i.name}  ${JSON.stringify(i.key)}`));

  // What the code wants vs what exists
  const diff = await Store.diffIndexes();
  console.log('\nTo remove:', diff.toDrop.length ? diff.toDrop.join(', ') : 'nothing');
  console.log('To create:', diff.toCreate.length ? diff.toCreate.map((k) => JSON.stringify(k)).join(', ') : 'nothing');

  if (!APPLY) {
    console.log('\nDry run. Re-run with --apply to make these changes.');
    return;
  }
  await Store.syncIndexes(); // drops the stale ones, builds the missing ones
  console.log('\n✅ Store indexes are now in sync with the code.');
})()
  .catch((err) => {
    console.error('\n❌', err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());