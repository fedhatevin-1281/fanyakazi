# Supabase and NOWPayments setup

1. Run `supabase_schema.sql` in the Supabase SQL editor.
2. Enable **Phone** under Supabase Authentication providers. Configure whether phone verification is required for new accounts.
3. Copy the Supabase project URL and anon key into `scripts/supabase-config.js`.
4. Copy `.env.example` to `.env` and set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `NOWPAYMENTS_API_KEY`, `NOWPAYMENTS_IPN_SECRET`, `NOWPAYMENTS_PRICE_CURRENCY`, `NOWPAYMENTS_KES_TO_PRICE_CURRENCY_RATE`, `APP_URL`, and `PORT`. Set the conversion rate to the price currency units per KSh using a current rate. Configure the NOWPayments IPN URL as `https://your-domain.example/api/nowpayments/ipn`.
5. Start the API and static site with `npm start`. The API exposes authenticated invoice creation and verification routes; program access is only granted after a signed NOWPayments IPN confirms the payment.

The service-role key, NOWPayments API key, and IPN secret are server-only. Never place them in `scripts/supabase-config.js` or browser code. Program checkout pages can call `startNowPaymentsCheckout('hotel-reviews', 80)` after loading `scripts/nowpayments.js`. NOWPayments accepts cryptocurrency; confirm the configured invoice currency and KSh conversion rate before enabling live checkout.