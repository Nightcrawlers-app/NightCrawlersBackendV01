/**
 * One-off: re-locate stores that were saved with the old fake default
 * position (central Abuja, [7.4985, 9.0563]).
 *
 *   node scripts/fixStoreCoordinates.js           # dry run — shows what it would do
 *   node scripts/fixStoreCoordinates.js --apply   # writes the changes
 *
 * Each store's address is geocoded (1 request/second, so ~1 min per 60 stores).
 * Stores whose address can't be found have their fake coordinates removed, so
 * they stop showing up in the wrong city's "near me" results. Fix those by
 * editing the store address (or sending lat/lng) from the vendor dashboard.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Store = require('../models/storeModel');
const { geocodeAddress, toPoint } = require('../utils/geocoder');

const APPLY = process.argv.includes('--apply');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const stores = await Store.find({ 'coordinates.coordinates': [7.4985, 9.0563] });
  console.log(`${stores.length} store(s) have the placeholder Abuja position.${APPLY ? '' : ' (dry run)'}`);

  let fixed = 0;
  let cleared = 0;
  for (const store of stores) {
    const found = await geocodeAddress(store.address);
    if (found) {
      console.log(`✔ ${store.name}: "${store.address}" → ${found.latitude}, ${found.longitude} (${found.label})`);
      if (APPLY) {
        store.coordinates = toPoint(found);
        store.coordinatesApproximate = true;
        await store.save();
      }
      fixed++;
    } else {
      console.log(`✖ ${store.name}: "${store.address}" not found — removing placeholder`);
      if (APPLY) await Store.updateOne({ _id: store._id }, { $unset: { coordinates: 1 } });
      cleared++;
    }
  }

  console.log(`\nDone. Located ${fixed}, cleared ${cleared}.${APPLY ? '' : ' Re-run with --apply to save.'}`);
  await mongoose.disconnect();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
