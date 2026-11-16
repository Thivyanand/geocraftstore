# GeoCraft Official Store

Node.js 22.13+ Express storefront for `store.geocraft.live`. The application uses Neon Postgres for durable orders, products, audit logs, and delivery jobs, with Drizzle ORM for database access. It supports guest checkout; customers do not need store accounts.

## Current launch state

VIP and VIP+ are seeded as **inactive**, with zero prices and placeholder perks. Set final product values in `config/products.js`, or sign into `/admin.html` and save them. Admin changes persist in Neon. A product cannot be purchased until it has a positive price, is active, and Razorpay credentials are configured. INR is the only enabled checkout currency. Do not enable sales until prices, benefits, merchant settings, privacy/contact details, and deployment have been reviewed.

## Local setup

1. Install Node.js 22.13 or newer.
2. Connect the Neon integration to the Vercel project so `DATABASE_URL` is supplied automatically. For local development, put the Neon-provided connection string in an ignored `.env` file; never commit it.
3. Set a unique `ADMIN_PASSWORD` and any Razorpay or RCON credentials in the environment.
4. Run `npm install` and `npm start`, then open `http://localhost:3000`.
5. Run `npm test` to exercise checkout, payment idempotency, webhooks, and admin authorization against an isolated in-memory PostgreSQL test database.

The schema is versioned in `migrations/0001_store.sql` and has been applied to the connected Neon database. Apply that migration to any new database before startup. The app seeds missing product rows from `config/products.js` and preserves existing Neon product settings; it does not write application data to the deployment filesystem.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP listener port; terminate HTTPS at a trusted reverse proxy. |
| `DATABASE_URL` | Pooled PostgreSQL connection URL supplied by the Neon integration. |
| `ADMIN_PASSWORD` | Strong secret for the single administrator login. |
| `RAZORPAY_KEY_ID` | Razorpay public checkout key ID. |
| `RAZORPAY_KEY_SECRET` | Private server-only API and payment verification secret. |
| `RAZORPAY_WEBHOOK_SECRET` | Secret configured for the Razorpay webhook endpoint. |
| `RCON_HOST`, `RCON_PORT`, `RCON_PASSWORD` | Private Velocity/backend server RCON settings for LuckPerms delivery. Keep RCON firewall restricted to this backend. |

Never commit `.env` or put private credentials in browser code. Admin login uses a signed HTTP-only SameSite cookie that works across serverless instances, expires after eight hours, and is invalidated when `ADMIN_PASSWORD` changes.

## Razorpay configuration

Create/configure the Razorpay merchant account and confirm permitted products and compliance details independently. Set the key ID and secret on the server. Register `https://store.geocraft.live/api/payments/webhook` for `payment.captured` and `payment.failed` and use the generated webhook secret in `RAZORPAY_WEBHOOK_SECRET`. The app creates INR orders server-side, checks Standard Checkout's HMAC signature, verifies webhook signatures against the raw body, and records paid state and one delivery row transactionally. Never treat the browser callback alone as evidence of payment; the verified callback and captured-payment webhook both use the same idempotent transition. Test in Razorpay test mode before enabling production keys. International currencies are not enabled.

## Rank delivery

The Neon-backed queue uses bounded exponential retries and exposes failed-delivery retry in the protected admin dashboard. The worker sends LuckPerms commands over RCON only for verified payments. It assumes groups named `vip` and `vipplus`; confirm those exact group identifiers and the `parent set` behavior on your server before enabling delivery. `parent set vipplus` replaces the prior primary parent, so VIP+ supersedes VIP. RCON must be private and limited at the network layer. If RCON settings are absent, jobs remain queued with a retryable configuration error. RCON command response is treated as success when the connection returns; confirm server-side command behavior before launch.

## Deployment

Deploy the Express app to Vercel with the Neon integration connected to the same project and `DATABASE_URL` available in Production, Preview, and Development. Vercel function filesystems are not durable; all application data is stored in Neon. Point `store.geocraft.live` to the project, require HTTPS, and configure health monitoring on `/api/health`. Set `NODE_ENV=production` so the admin cookie is Secure. Start with Razorpay test credentials and a staging Minecraft environment, then switch to live credentials only after merchant approval and end-to-end manual verification.

## Admin and policies

Visit `/admin.html` and use `ADMIN_PASSWORD`. The dashboard displays order totals and payment/delivery records, searches usernames, permits product changes, and retries failed deliveries. The public legal pages are starter text and need a business owner review; support email is `support@geocraft.live` and should be replaced if that address is not monitored. No customer account/history feature is implemented.
