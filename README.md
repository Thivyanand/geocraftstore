# GeoCraft Official Store

Node.js 22.13+ and Express storefront for `store.geocraft.live`. This workspace had no existing application or repository, so the implementation uses a small Express server, plain responsive browser UI, Node's built-in SQLite support, and SQLite. It supports guest checkout; customers do not need store accounts.

## Current launch state

VIP and VIP+ are seeded as **inactive**, with zero prices and placeholder perks. Set final product values in `config/products.js`, or sign into `/admin.html` and save them. Admin changes persist in SQLite. A product cannot be purchased until it has a positive price, is active, and Razorpay credentials are configured. INR is the only enabled checkout currency. Do not enable sales until prices, benefits, merchant settings, privacy/contact details, and deployment have been reviewed.

## Local setup

1. Install Node.js 20 or newer.
2. Run `npm install`.
3. Copy `.env.example` to `.env`; set a unique `SESSION_SECRET` and `ADMIN_PASSWORD`.
4. Run `npm start` and open `http://localhost:3000`.
5. Run `npm test` for the included username and payment idempotency checks.

SQLite creates its schema and indexes on first boot at `DATABASE_PATH` (default `./data/geocraft.sqlite`). Back up this file regularly and restrict access to the host and its backups.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP listener port; terminate HTTPS at a trusted reverse proxy. |
| `ADMIN_PASSWORD` | Strong secret for the single administrator login. |
| `DATABASE_PATH` | Persistent SQLite file path on durable storage. |
| `RAZORPAY_KEY_ID` | Razorpay public checkout key ID. |
| `RAZORPAY_KEY_SECRET` | Private server-only API and payment verification secret. |
| `RAZORPAY_WEBHOOK_SECRET` | Secret configured for the Razorpay webhook endpoint. |
| `RCON_HOST`, `RCON_PORT`, `RCON_PASSWORD` | Private Velocity/backend server RCON settings for LuckPerms delivery. Keep RCON firewall restricted to this backend. |

Never commit `.env` or put private credentials in browser code. Admin login tokens are random, held in an HTTP-only SameSite cookie, and invalidated on process restart.

## Razorpay configuration

Create/configure the Razorpay merchant account and confirm permitted products and compliance details independently. Set the key ID and secret on the server. Register `https://store.geocraft.live/api/payments/webhook` for `payment.captured` and `payment.failed` and use the generated webhook secret in `RAZORPAY_WEBHOOK_SECRET`. The app creates INR orders server-side, checks Standard Checkout's HMAC signature, verifies webhook signatures against the raw body, and records paid state and one delivery row transactionally. Never treat the browser callback alone as evidence of payment; the verified callback and captured-payment webhook both use the same idempotent transition. Test in Razorpay test mode before enabling production keys. International currencies are not enabled.

## Rank delivery

The queue is stored in SQLite, uses bounded exponential retries, and exposes failed-delivery retry in the protected admin dashboard. The worker sends LuckPerms commands over RCON only for verified payments. It assumes groups named `vip` and `vipplus`; confirm those exact group identifiers and the `parent set` behavior on your server before enabling delivery. `parent set vipplus` replaces the prior primary parent, so VIP+ supersedes VIP. RCON must be private and limited at the network layer. If RCON settings are absent, jobs remain queued with a retryable configuration error. RCON command response is treated as success when the connection returns; confirm server-side command behavior before launch.

## Deployment

Deploy the Node service with durable disk for SQLite and set secrets through the hosting provider's secret manager. Point `store.geocraft.live` to the service through a reverse proxy/load balancer that provides HTTPS, redirects HTTP to HTTPS, and forwards only trusted proxy headers. Set `NODE_ENV=production` so the admin cookie is Secure. Restrict access to the SQLite file and backups, and configure health monitoring on `/api/health`. Set up regular encrypted database backups and restore checks. Start with Razorpay test credentials and a staging Minecraft environment, then switch to live credentials only after merchant approval and end-to-end manual verification.

## Admin and policies

Visit `/admin.html` and use `ADMIN_PASSWORD`. The dashboard displays order totals and payment/delivery records, searches usernames, permits product changes, and retries failed deliveries. The public legal pages are starter text and need a business owner review; support email is `support@geocraft.live` and should be replaced if that address is not monitored. No customer account/history feature is implemented.
