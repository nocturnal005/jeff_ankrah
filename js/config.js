/*
 * Public Supabase configuration.
 *
 * Both values below are meant to be public: they ship inside index.html and
 * every visitor can read them. They are safe only because row level security
 * is enabled on every table, which is what actually protects the data. The
 * publishable key can read active products and nothing else. It cannot read
 * orders or bookings, and it cannot write anything at all. That was verified
 * against this project by attempting a forged order and a price change, both
 * of which were refused.
 *
 * The service_role key must never appear in this file or anywhere else in the
 * repository. It bypasses every policy. It belongs in Vercel's environment
 * variables, read only by serverless functions.
 */
window.CASTTCO_CONFIG = {
  supabaseUrl: 'https://qnkorxneiphqmknctsor.supabase.co',
  supabasePublishableKey: 'sb_publishable_AH9K37NyNM7ojBwrPcfpzA_UaMgdy2y',
  currency: 'GBP',
  currencySymbol: '£',
  consultationPricePence: 5000
};
