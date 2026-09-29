# Backend changes — promo codes, rewards, referrals, favourites, notes, ads

## New
- **Promo codes** (`models/promotionModel.js`, `routes/promotionRoutes.js`)
  - New promo fields: `code`, `audience` ('everyone' | 'new_customers'), `usageLimit`, `perCustomerLimit`, `timesUsed`, `listed`.
  - A promo with a code is only applied when the customer types it. It is never auto-applied.
  - `listed: false` hides a code promo from the banner and store badges (a "secret" code).
  - `POST /api/promotions/code` `{ code, storeId? }` returns the promo, or a clear reason why not. It is rate-limited to 20 tries per 15 minutes.
  - Each use is claimed atomically when the order is placed, and given back if the order is cancelled.
- **Rewards and referrals** (`utils/rewards.js`, `models/userModel.js`)
  - New user fields: `rewards.points`, `rewards.deliveryCredit` (₦, pays delivery only), `rewards.freeDeliveries`, `referralCode`, `referredBy`, `referralRewarded`.
  - Points are earned when an order is **delivered**.
  - A friend who signs up with a code gets a free delivery once they verify their email. The referrer is rewarded when that friend's first order is delivered.
  - Checkout uses free deliveries and credit automatically (`useRewards: false` turns it off). Balances are spent atomically and refunded if the order is cancelled.
  - Rewards are paid for by the platform. The rider still gets the full delivery fee.
  - `GET /api/users/me/rewards` returns balances, the referral code and link, and the rules.
  - `POST /api/users/me/rewards/redeem` `{ blocks? }` converts points to delivery credit.
- **Favourites** (`routes/userRoutes.js`)
  - `GET /api/users/me/favorites`
  - `PUT|DELETE /api/users/me/favorites/stores/:id`
  - `PUT|DELETE /api/users/me/favorites/orders/:id`
- **Notes:** orders accept `noteForVendor` and `noteForRider` (300 characters each), shown to the store, the rider and the customer.
- **Delivery estimate:** `GET /api/orders/delivery-estimate?storeId=&lat=&lng=` gives the store page the same distance-based fee checkout uses.
- **Ads** (`models/placementModel.js`, `routes/placementRoutes.js`)
  - Sponsored tiles in "Popular on Nightcrawlers".
  - `GET /api/placements?category=` returns live ads and counts a view for each.
  - `POST /api/placements/:id/click` counts a tap.
  - Admin create, edit and delete at `/api/admin/placements`.
- **In-app card payment:** `POST /api/payments/paystack/initialize` accepts `channel: 'card'` and now also returns `accessCode`, so the frontend can open Paystack's card popup. Card details go to Paystack only.

## Changed
- `POST /api/orders/quote` now accepts the signed-in customer (optional). It returns `rewardDiscount` and `rewards`, and takes `promoCode` and `useRewards`.
- `POST /api/orders` takes `promoCode`, `useRewards`, `noteForVendor` and `noteForRider`.
- Signup (`POST /api/auth/signup`) accepts an optional `referralCode`. A wrong code returns a 400 error rather than being silently ignored.
- The order status change to `delivered` awards points and any referral reward. The change to `cancelled` gives back the rewards and the promo use.
- `GET /api/orders/:id/track` also returns `rewardDiscount`, `noteForVendor` and `noteForRider`.
- The banner and store badges only show listed promos.

## Settings (.env, all optional)
`POINTS_PER_100_NAIRA=1`, `POINTS_REDEEM_BLOCK=100`, `POINTS_REDEEM_VALUE=500`,
`REFERRAL_REWARD=free_delivery` (or `credit`), `REFERRAL_CREDIT_AMOUNT=5000`,
`REFERRAL_NEW_USER_FREE_DELIVERIES=1`

## Deploying
- No migration is needed. Old users start with 0 points. Each user gets a referral code the first time they open Rewards.
- MongoDB builds two new unique indexes on start-up: `users.referralCode` and `promotions.code`, both only where the value is set.
- New tests: `tests/rewards.test.js`. They need no database: `npx jest tests/rewards.test.js`.

---

# Codes tied to accounts (second round)

## Two new ways to limit who can use a promo
- **Specific accounts.** A promo with `customerIds` and a `code` only works for those customers. Anyone else gets the message "This code isn't linked to your account." These promos are never shown in the banner or on store badges.
- **Personal-code campaigns.** A promo with `isCampaign: true` has no shared code. Instead, each chosen customer gets their own single-use code, like `ADA-7K2Q`. Only that customer can use it, and only once. The code is claimed when the order is placed and given back if the order is cancelled. Codes stop working when the promo ends or is paused.

## New
- `models/personalCodeModel.js`: one document per customer per campaign. Codes are unique across the whole database.
- Admin endpoints:
  - `GET /api/admin/promotions/customers?search=` finds customers by name, email or phone for the picker.
  - `GET /api/admin/promotions/:id/codes` lists every code in a campaign, with who has it and whether it's been used.
  - `POST /api/admin/promotions/:id/codes` hands out codes. The `audience` can be `customers` (picked), `emails` (a pasted list), `inactive` (no order in N days, including people who never ordered) or `all`. Add `sendEmail: true` to email each person their code. Customers who already have a code in that campaign are skipped.
  - `DELETE /api/admin/promotions/:id/codes/:codeId` takes back an unused code.
- `GET /api/users/me/codes` returns the codes a customer can use: their personal codes plus any codes locked to their account.
- An email for personal codes (`sendPersonalCodeEmail` in `utils/mailer.js`).

## Changed
- `POST /api/promotions/code` also accepts personal codes. The customer has to be signed in, and the code has to be theirs and unused.
- Orders record `personalCodeId`.
- Deleting a promo also deletes its personal codes.
- The email footer said "Lagos, Nigeria". It now says "Abuja, Nigeria".

---

# Keeping the live API up (third round)

## Why the app showed "Could not reach the server"
- **nginx lost the API after deploys.** Every push to `main` recreates the API container with a new internal address. nginx only looked the address up when it started, so it kept sending traffic to the old one until nginx itself was restarted.
- **Errors the browser couldn't read.** When the API was restarting or a visitor was rate limited, nginx answered without CORS headers. The browser hid those answers, so the app could only say "Could not reach the server".
- **Shared mobile IPs got rate limited.** The limit was 10 requests per second per IP. Nigerian mobile networks put many customers behind one IP address, so a busy evening could block them all.
- **One stray error crashed the whole API.** An unhandled promise rejection stopped Node until Docker restarted it.
- **Database start-up failures looped.** If Atlas couldn't be reached at start-up, the API exited, restarted, failed again, and so on.
- **Deploys dropped requests.** Requests that were in progress during a deploy were cut off.

## Changes
- `server.js`:
  - Logs unhandled rejections instead of crashing.
  - Shuts down gracefully on SIGTERM, so requests in progress finish during deploys.
  - Keep-alive timeouts are longer than the proxy's.
- `config/dbConfig.js`:
  - Retries the Atlas connection every 5 seconds instead of exiting.
  - Logs every disconnect and reconnect with a timestamp.
  - Adds a hint when the VM's IP isn't on Atlas's allow list.
- `GET /health` now reports the database state, uptime and memory. It returns 503 while the database is down.
- `deployment/nginx/nightcrawlers.conf`:
  - Looks up the API container's address every 10 seconds.
  - Returns JSON errors with CORS headers for 429, 502, 503 and 504.
  - Rate limit raised to 30 requests per second (burst 120).
  - Domain changed to `api.nightcrawlers.app`.
- `deployment/safe-deploy.sh` reloads nginx after swapping containers, and retries the final health check.
- `docker/docker-compose.yml`:
  - Log rotation (10 MB × 3 per container), so logs can't fill the disk.
  - A 15-second grace period for shutdown.
- New `deployment/diagnose.sh`: one command on the VM that checks containers, crashes, memory, disk, logs, nginx, the SSL certificate and Atlas connectivity.

## On the server (GitHub Actions only ships the Docker image)
Copy these three files to `/opt/nightcrawlers/`:
- `deployment/nginx/nightcrawlers.conf` → `/opt/nightcrawlers/nginx/nightcrawlers.conf`
- `deployment/safe-deploy.sh` → `/opt/nightcrawlers/safe-deploy.sh`
- `deployment/diagnose.sh` → `/opt/nightcrawlers/diagnose.sh`

Then run `docker compose up -d --force-recreate nginx`.

## Follow-up after the first local test
- **Async errors no longer escape.** `utils/asyncErrors.js` makes Express 4 pass errors from `async` routes to the error handler. Before, one failed database call in a route without try/catch crashed the whole API. This was a likely cause of the live drops.
- **Fast 503 while the database is down.** While MongoDB is fully disconnected, `/api` calls get an immediate 503 "try again" instead of hanging 10 seconds and then failing. The frontend retries those automatically on page loads.
- **Database errors reported as 503.** The global error handler turns database-unreachable errors into 503 with `Retry-After`, instead of a generic 500.
- **One connection instead of two.** `connectDB()` was being called twice, once in `app.js` and once in `server.js`. It now connects only once.
