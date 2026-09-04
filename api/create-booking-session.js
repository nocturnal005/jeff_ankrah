/*
 * POST /api/create-booking-session
 *
 * Takes the booking form's fields, records a pending consultation booking,
 * and hands back the URL of a Stripe Checkout Session to send the visitor to.
 *
 * The browser posts details. It does not post a price, and this endpoint would
 * ignore one if it did: the amount charged is read from the server's own
 * configuration further down. That is the whole reason this function exists
 * rather than the page talking to Stripe directly.
 *
 * Written as a Web-standard handler (a Request in, a Response out) rather than
 * the older (req, res) signature, because the webhook alongside it needs the
 * unparsed request body and this is the style that gives it.
 *
 * Exported as POST rather than as a default export, and that distinction is
 * load-bearing on Vercel: a default export is invoked with the (req, res)
 * signature, where the return value is ignored. Returning a Response from a
 * default export does not fail loudly -- nothing ever calls res.end(), so the
 * request simply hangs until the platform gives up. A named method export is
 * what opts into the Web signature. Vercel answers 405 by itself for methods
 * with no matching export, so there is no method check below.
 */
import Stripe from 'stripe';
import {
  CURRENCY,
  consultationPricePence,
  env,
  insertBooking,
  json,
  siteUrl,
  supabaseConfigured,
  updateBooking,
  validateBooking
} from './_lib/bookings.js';

export async function POST(request) {
  const stripeKey = env('STRIPE_SECRET_KEY');

  /* Refuse clearly rather than half-working. An endpoint that took the
   * booking, failed to reach Stripe and answered 200 would leave someone
   * believing they had booked and paid for a consultation that does not
   * exist. */
  if (!stripeKey || !supabaseConfigured()) {
    return json({
      error: 'Online booking is not switched on yet. Please contact us and we will arrange your consultation directly.'
    }, 503);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'Booking details could not be read.' }, 400);
  }

  const checked = validateBooking(payload);
  if (!checked.ok) {
    return json({ error: checked.error }, 400);
  }

  let booking;
  try {
    booking = await insertBooking(checked.booking);
  } catch (error) {
    console.error('[booking] insert failed:', error.message);
    return json({ error: 'We could not start your booking. Please try again shortly.' }, 500);
  }

  const stripe = new Stripe(stripeKey, { apiVersion: '2026-06-24.dahlia' });
  const amount = consultationPricePence();

  /* One Stripe customer per person, looked up by email and reused.
   *
   * Passing customer_email instead would let Checkout take the payment without
   * ever creating a reusable customer, and every booking would stand alone.
   * Consultations are usually the start of paid work that gets invoiced later,
   * and an invoice is raised against a customer -- so the customer is created
   * here, at the first payment, and the follow-up invoice attaches to the same
   * record with the consultation already in its history.
   *
   * A failure to resolve the customer is not fatal. Taking the booking matters
   * more than the bookkeeping, so it falls back to a plain email checkout. */
  let customerId = null;
  try {
    const existing = await stripe.customers.list({ email: booking.email, limit: 1 });
    customerId = existing.data.length
      ? existing.data[0].id
      : (await stripe.customers.create({
          email: booking.email,
          name: booking.name,
          phone: booking.phone || undefined,
          metadata: { source: 'casttco.online booking', first_service: booking.service }
        })).id;
  } catch (error) {
    console.error('[booking] could not resolve stripe customer:', error.message);
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      submit_type: 'book',
      // Exactly one of these: Stripe rejects a session given both.
      ...(customerId ? { customer: customerId } : { customer_email: booking.email }),
      /* Both of these carry the booking's identity through Stripe and back to
       * the webhook. The webhook resolves the booking from metadata rather
       * than from the session id written below, so a payment is still matched
       * even if that write fails. */
      client_reference_id: booking.id,
      metadata: {
        booking_id: booking.id,
        service: booking.service,
        preferred_date: booking.preferred_date || ''
      },
      line_items: [{
        quantity: 1,
        price_data: {
          currency: CURRENCY,
          unit_amount: amount,
          product_data: {
            name: 'CASTTCO consultation',
            description: booking.service
          }
        }
      }],
      /* payment_method_types is deliberately absent. Omitting it lets Stripe
       * decide which methods to show from the dashboard settings and the
       * customer's own context; hardcoding ['card'] here would quietly switch
       * off everything else and is the single most common way to lose a sale. */
      success_url: siteUrl() + '/booking-confirmed.html?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: siteUrl() + '/book.html?cancelled=1'
    }, {
      // Keyed on the booking row, so a double-submitted form cannot produce
      // two checkout sessions and two chances to be charged.
      idempotencyKey: 'booking-session-' + booking.id
    });

    /* Recorded for reconciliation against Stripe later. Deliberately not
     * awaited as a precondition for returning: the customer should not be
     * blocked from paying because a bookkeeping write was slow, and the
     * webhook does not depend on it. */
    try {
      await updateBooking(booking.id, { stripe_session_id: session.id });
    } catch (error) {
      console.error('[booking] could not store session id:', error.message);
    }

    return json({ url: session.url });
  } catch (error) {
    console.error('[booking] stripe session failed:', error.message);
    return json({
      error: 'We could not reach the payment provider. Please try again shortly.'
    }, 502);
  }
}
