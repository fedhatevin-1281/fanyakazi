# Supabase and Paystack setup

1. Run `supabase_schema.sql` in the Supabase SQL editor.
2. Enable **Phone** under Supabase Authentication providers. Configure whether phone verification is required for new accounts.
3. Copy the Supabase project URL and anon key into `scripts/supabase-config.js`.
4. Copy `.env.example` to `.env` and set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `PAYSTACK_SECRET_KEY`, `APP_URL`, and `PORT`.
5. Start the API and static site with `npm start`. The API serves the site and exposes the authenticated Paystack initialize and verify routes.

The service-role key and Paystack secret key are server-only. Never place either key in `scripts/supabase-config.js` or browser code. Program checkout pages can call `startPaystackCheckout('hotel-reviews', 80)` after loading `scripts/paystack.js`; the callback verifies the reference server-side before access is recorded.