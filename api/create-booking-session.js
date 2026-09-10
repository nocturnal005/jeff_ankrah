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
  countRecentPending,
  env,
  fetchAvailability,
  fetchBlackouts,
  fetchTakenSlots,
  insertBooking,
  json,
  siteUrl,
  supabaseConfigured,
  updateBooking,
  validateBooking
} from './_lib/bookings.js';
import {
  HORIZON_DAYS,
  addDays,
  describeSlot,
  isBookable,
  londonToday
} from './_lib/slots.js';

/* Stripe's floor is 30 minutes, and short is what we want: an unpaid booking
 * holds a real appointment slot, so the sooner an abandoned checkout dies the
 * sooner that time is back on sale. */
const SESSION_MINUTES = 30;

/* Generous enough that a real person abandoning checkout and trying again is
 * never blocked, tight enough that a loop stops within seconds. */
const MAX_PENDING_PER_EMAIL = 5;
const PENDING_WINDOW_MINUTES = 60;

/* The backstop for the cap above, which is keyed on an address the caller
 * chooses and so is defeated by rotating it. This one counts every unpaid
 * booking regardless of address, and there is nothing in it to vary.
 *
 * Set far above any plausible real demand rather than close to it. The diary
 * holds eight appointments a day; twenty unpaid bookings started inside a
 * quarter of an hour is roughly seven times the busiest genuine burst this
 * business could produce, so a real customer should never meet it. That
 * headroom is deliberate: a ceiling tight enough to catch an attacker sooner
 * would also turn away people trying to pay. */
const MAX_PENDING_GLOBAL = 20;
const GLOBAL_WINDOW_MINUTES = 15;

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

  /* The slot the browser asked for, checked against the diary rather than
   * taken on trust. The page offered a set of times some seconds ago; this
   * request claims one. Those are different things, and only the second is
   * under the caller's control -- so a slot outside working hours, on a closed
   * day, inside the notice period, or already taken is refused here.
   *
   * Fails CLOSED, unlike the abuse cap below. A booking whose availability
   * could not be confirmed is a booking that might double-book a real client,
   * and refusing to take money is the safer half of that trade. */
  try {
    const [availability, blackouts, taken] = await Promise.all([
      fetchAvailability(),
      fetchBlackouts(londonToday(), addDays(londonToday(), HORIZON_DAYS)),
      fetchTakenSlots(new Date().toISOString(),
        new Date(Date.now() + HORIZON_DAYS * 86400000).toISOString())
    ]);

    if (!isBookable(checked.booking.starts_at, { availability, blackouts, taken, now: new Date() })) {
      return json({
        error: 'That time is no longer available. Please choose another.'
      }, 409);
    }
  } catch (error) {
    console.error('[booking] availability check failed:', error.message);
    return json({
      error: 'We could not confirm that time just now. Please try again shortly.'
    }, 503);
  }

  /* Fails OPEN on purpose. If this check cannot run, the booking still goes
   * through: turning away a paying customer because a defensive query errored
   * is a worse outcome than letting one extra row through. */
  try {
    const [perEmail, everyone] = await Promise.all([
      countRecentPending(checked.booking.email, PENDING_WINDOW_MINUTES, MAX_PENDING_PER_EMAIL),
      countRecentPending(null, GLOBAL_WINDOW_MINUTES, MAX_PENDING_GLOBAL)
    ]);

    if (perEmail >= MAX_PENDING_PER_EMAIL) {
      console.warn('[booking] pending cap reached for an address');
      return json({
        error: 'You already have a booking waiting for payment. Please complete or cancel it before starting another, or contact us and we will help.'
      }, 429);
    }

    /* Logged as an error rather than a warning: at this volume the ceiling
     * being touched at all means either something is wrong or somebody is
     * trying it on, and either is worth seeing in the logs. */
    if (everyone >= MAX_PENDING_GLOBAL) {
      console.error('[booking] GLOBAL pending ceiling reached —',
        everyone, 'unpaid bookings in the last', GLOBAL_WINDOW_MINUTES, 'minutes');
      return json({
        error: 'Our booking system is unusually busy just now. Please try again in a few minutes, or contact us and we will book you in directly.'
      }, 429);
    }
  } catch (error) {
    console.error('[booking] pending checks failed, allowing anyway:', error.message);
  }

  let booking;
  try {
    booking = await insertBooking(checked.booking);
  } catch (error) {
    /* Two people clicked the same slot and the unique index decided it. The
     * loser is told to pick again, and nobody has been charged -- which is the
     * entire reason the slot is claimed before Stripe is involved. */
    if (error.slotTaken) {
      return json({
        error: 'Someone just booked that time. Please choose another.'
      }, 409);
    }
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
        starts_at: booking.starts_at || ''
      },
      /* Short-lived on purpose: this booking is holding an appointment slot,
       * and the slot cannot go back on sale until the session can no longer be
       * paid. */
      expires_at: Math.floor(Date.now() / 1000) + SESSION_MINUTES * 60,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: CURRENCY,
          unit_amount: amount,
          product_data: {
            name: 'CASTTCO consultation',
            // The appointment itself, on Stripe's page and on the receipt, so
            // what someone is paying for is legible without cross-referencing.
            description: booking.service + ' — ' + describeSlot(booking.starts_at)
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
