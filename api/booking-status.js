/*
 * GET /api/booking-status?session_id=cs_...
 *
 * Tells the confirmation page whether a checkout session was actually paid.
 *
 * The page needs this because Stripe's success_url is an ordinary URL: anyone
 * can open it, with any session id, without having paid a penny. A page that
 * says "thank you, payment received" purely because it was loaded is telling
 * the visitor something nobody has checked.
 *
 * Only a summary is returned -- whether it is paid, what was booked and for
 * how much. The name, email, phone and notes on the booking stay server-side;
 * a session id in a URL is unguessable but it is not a password.
 *
 * Exported as GET, not as a default export. On Vercel a default export takes
 * the (req, res) signature and its return value is discarded, so returning a
 * Response hangs the request instead of answering it. See the longer note in
 * create-booking-session.js.
 */
import Stripe from 'stripe';
import { env, json } from './_lib/bookings.js';

export async function GET(request) {
  const stripeKey = env('STRIPE_SECRET_KEY');
  if (!stripeKey) {
    return json({ error: 'Booking is not switched on yet.' }, 503);
  }

  const sessionId = new URL(request.url).searchParams.get('session_id');

  /* Checked for shape before it is sent anywhere. Stripe would reject a
   * malformed id itself, but there is no reason to forward arbitrary strings
   * from a query parameter to another service to find that out. */
  if (!sessionId || !/^cs_[A-Za-z0-9_]{10,255}$/.test(sessionId)) {
    return json({ error: 'That booking reference is not valid.' }, 400);
  }

  const stripe = new Stripe(stripeKey, { apiVersion: '2026-06-24.dahlia' });

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    return json({
      // 'paid' is the only value the page treats as confirmed. Delayed payment
      // methods sit at 'unpaid' for a while after a completed checkout, which
      // is a real state and not an error.
      paid: session.payment_status === 'paid',
      payment_status: session.payment_status,
      service: (session.metadata && session.metadata.service) || null,
      amount_pence: session.amount_total,
      currency: session.currency
    });
  } catch (error) {
    console.error('[booking-status] lookup failed:', error.message);
    return json({ error: 'We could not look up that booking.' }, 404);
  }
}
