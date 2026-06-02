# Refertium Security and PostgreSQL Migration Report

Branch: `andrey-design-fixes`

## Implemented

- Added PostgreSQL support through `DATABASE_URL` with automatic schema creation.
- Added `settings`, `users`, `licenses`, `sessions`, `login_attempts`, `payment_links`, and `payments` tables.
- Added one-time import from `backend/data/db.json` when `settings[key='import']` is not `1`; after import the app writes `settings.import=1`.
- Kept the old `db.json` path only as a local fallback when `DATABASE_URL` is missing and production mode is not enabled.
- Moved login sessions to PostgreSQL so sessions survive server restarts.
- Moved usage licenses and recognizer/AI limits to a dedicated `licenses` table; API checks hydrate license state from SQL, not from process memory.
- Login cookies now include `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` by default.
- Added login rate limiting: 5 failed attempts lock the login key for 1 hour.
- Added single active app-tab/session enforcement: opening `/app/:userId` rotates the active app session and old tabs are blocked.
- Added Cloudflare Worker authorization against the dashboard before OpenAI or Deepgram proxy calls.
- Added per-user monthly Stripe Checkout link generation with arbitrary amounts and an admin dashboard button.
- Added Stripe webhook handling for `checkout.session.completed` and `checkout.session.async_payment_succeeded`; paid sessions are matched to users through Stripe metadata.
- Added PostgreSQL indexes for auth/session lookup, user identity lookup, license status, proxy token lookup, payment links, and payment transaction queries.
- Added local Docker PostgreSQL setup used for verification.

## Local Verification

- PostgreSQL container: `refertium-postgres`
- PostgreSQL port: `localhost:55432`
- Database: `refertium`
- User: `refertium`
- Local app URL: `http://localhost:47825/`

Verified:

- PostgreSQL schema is created automatically.
- `db.json` users are imported and `settings.import=1` is set.
- Admin login works.
- Failed login attempts return `429` after the limit.
- Sessions are stored in PostgreSQL.
- Licenses are stored in PostgreSQL and verified by reading `licenses` joined with `users`.
- Opening the same user app twice invalidates the previous app tab.
- Payment link API returns a signed monthly URL.
- Stripe webhook can mark a user payment as paid and reset the paid month's usage counters.
- Admin dashboard loads in the browser and shows the payment-link button.

## Database Index Coverage

- `users`: primary key on `id`, unique lower-case indexes for `username` and `email`, role index, created-at ordering index, and unique `proxy_token` index.
- `licenses`: primary key on `user_id` and status index.
- `sessions`: primary key on `sid`, `(user_id, active)` index, and `(active, expires_at)` index for cleanup/listing.
- `login_attempts`: primary key on rate-limit key.
- `payment_links`: primary key on `id`, `(user_id, month)` index, and unique Stripe session index.
- `payments`: primary key on payment id, `(user_id, month)` index, `(status, month)` index, and Stripe session index.

## Security Review Notes

- SQL queries use parameterized `pgPool.query` values for all user-provided input.
- Public unauthenticated API surface is limited to login, Stripe webhook, worker proxy callbacks protected by `X-Worker-Secret`, and the intentionally public international demo flow.
- Stripe webhook requires `STRIPE_WEBHOOK_SECRET` in production and ignores unpaid `checkout.session.completed` events.
- Cloudflare Worker dashboard callbacks require explicit `WORKER_SHARED_SECRET`; no dev-secret fallback is used there.
- Admin-only methods cover user mutation, template upload, HTML upload, app generation, usage reset, and payment link generation.
- Finance/admin-only method covers user listing.
- Static serving blocks path traversal by resolving against the public directory root.
- Uploaded/generated app HTML filenames are generated server-side; user-provided upload names are stored as display names only.
- Cookie parsing tolerates malformed values without throwing.
- Live Stripe/OpenAI secrets were not committed.

## Environment Values Used Locally

The local run used placeholders where real production secrets are required:

- `DATABASE_URL=postgres://refertium:refertium_dev_password@localhost:55432/refertium`
- `PGSSLMODE=disable`
- `REFERTIUM_ADMIN_PASSWORD=refertium-admin`
- `REFERTIUM_FINANCE_PASSWORD=finance-dev`
- `OPENAI_API_KEY=local-placeholder`
- `PAYMENT_BASE_URL=https://payments.example.local/refertium`
- `PAYMENT_LINK_SECRET=local-payment-secret`
- `STRIPE_SECRET_KEY` was not set locally; payment generation falls back to signed placeholder URLs unless this env var is configured.
- `STRIPE_WEBHOOK_SECRET` was not set locally; unsigned webhook JSON is accepted only outside production.
- `STRIPE_CURRENCY=eur`
- `PUBLIC_BASE_URL=http://localhost:47825`

## Missing Production Inputs

Production still needs real values for:

- `DATABASE_URL`
- `OPENAI_API_KEY`
- `REFERTIUM_ADMIN_PASSWORD`
- `PAYMENT_BASE_URL`
- `PAYMENT_LINK_SECRET`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_CURRENCY`
- `PUBLIC_BASE_URL`
- `REFERTIUM_ADMIN_PASSWORD`
- `REFERTIUM_FINANCE_PASSWORD` if the finance account must exist
- Cloudflare Worker secrets: `PROXY_AUTH_TOKEN`, `WORKER_SHARED_SECRET`, `REFERTIUM_DASHBOARD_URL`, and provider API keys such as `OPENAI_API_KEY` / `DEEPGRAM_API_KEY`

## Notes

- The current app is still a single Node HTTP server. The change keeps the existing shape of the project and replaces storage/security behavior without a full backend rewrite.
- `REFERTIUM_COOKIE_SECURE=0` can be used only for unusual local HTTP clients that refuse to return Secure cookies. Production should keep the default Secure mode.
