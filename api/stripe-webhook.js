/*
 * POST /api/stripe-webhook
 *
 * Stripe's report of what actually happened to a payment. This, not the
 * browser's return from checkout, is what marks a booking paid: the success
 * URL is just a redirect, and anyone can visit it without having paid.
 *
 * Every request is signature-checked before it is read as an event. An
 * unverified webhook endpoint is an open invitation to mark any booking paid
 * by posting made-up JSON at it, so a bad or missing signature is refused
 * outright rather than logged and tolerated.
 */
import Stripe from 'stripe';
import {
  env,
  findBookingById,
  json,
  supabaseConfigured,
  updateBooking
} from './_lib/bookings.js';

/* Stripe retries anything that is not a 2xx. That is the right behaviour for a
 * genuine outage on our side, and the wrong behaviour for an event we have
 * decided not to act on, which would be retried forever. Handled and
 * deliberately-ignored both answer 200; only real failures answer 5xx. */
const ACKNOWLEDGED = { received: true };

export default async function handler(request) {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed.' }, 405);
  }

  const stripeKey = env('STRIPE_SECRET_KEY');
  const webhookSecret = env('STRIPE_WEBHOOK_SECRET');

  if (!stripeKey || !webhookSecret || !supabaseConfigured()) {
    console.error('[webhook] refused: endpoint is not fully configured');
    return json({ error: 'Webhook not configured.' }, 503);
  }

  const signature = request.headers.get('stripe-signature');
  if (!signature) {
    return json({ error: 'Missing signature.' }, 400);
  }

  /* The exact bytes Stripe signed. Parsing the body to an object first and
   * re-serialising it would change the whitespace and break verification --
   * which is why this handler takes a Request rather than Vercel's parsed
   * req.body. */
  const rawBody = await request.text();

  const stripe = new Stripe(stripeKey, { apiVersion: '2026-06-24.dahlia' });

  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(rawBody, signature, webhookSecret);
  } catch (error) {
    // The message names why verification failed, never the secret itself.
    console.error('[webhook] signature verification failed:', error.message);
    return json({ error: 'Signature verification failed.' }, 400);
  }

  const session = event.data && event.data.object;

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        /* Completed does not always mean paid. Bank debits and other delayed
         * methods finish checkout as "unpaid" and settle minutes or days
         * later, so the money is confirmed by payment_status here and by the
         * async_payment_succeeded event below. Treating completion as payment
         * would mark a booking paid that may still fail. */
        if (session.payment_status === 'paid') {
          await markPaid(session);
        } else {
          console.log('[webhook] checkout completed, payment still pending:', session.id);
        }
        break;

      case 'async_payment_succeeded':
      case 'checkout.session.async_payment_succeeded':
        await markPaid(session);
        break;

      case 'checkout.session.async_payment_failed':
      case 'checkout.session.expired':
        await markCancelled(session, event.type);
        break;

      default:
        // Everything else is genuinely not our business. Acknowledged so
        // Stripe stops resending it.
        break;
    }
  } catch (error) {
    /* A 500 asks Stripe to retry, which is what we want when the database was
     * briefly unreachable. The event is not lost. */
    console.error('[webhook] handling', event.type, 'failed:', error.message);
    return json({ error: 'Handler failed.' }, 500);
  }

  return json(ACKNOWLEDGED, 200);
}

/* --------------------------------------------------------------- outcomes */

function bookingIdFrom(session) {
  return (session.metadata && session.metadata.booking_id) || session.client_reference_id || null;
}

async function markPaid(session) {
  const bookingId = bookingIdFrom(session);
  if (!bookingId) {
    console.error('[webhook] paid session carries no booking id:', session.id);
    return;
  }

  const booking = await findBookingById(bookingId);
  if (!booking) {
    console.error('[webhook] no booking row for id:', bookingId);
    return;
  }

  /* What Stripe collected must match what this booking asked for. A mismatch
   * means the session was not the one we created for this booking -- a
   * tampered or replayed event -- and marking it paid on the strength of a
   * valid signature alone would be trusting the amount to whoever sent it. */
  const expected = booking.price_pence;
  const paid = session.amount_total;
  const currencyOk = String(session.currency || '').toLowerCase() ===
    String(booking.currency || 'GBP').toLowerCase();

  if (paid !== expected || !currencyOk) {
    console.error(
      '[webhook] amount mismatch for booking', bookingId,
      '- expected', expected, booking.currency,
      'got', paid, session.currency
    );
    return;
  }

  // Setting a status that is already 'paid' is harmless, which is what makes
  // this safe to run again when Stripe redelivers the same event.
  const rows = await updateBooking(bookingId, {
    status: 'paid',
    stripe_session_id: session.id
  });

  if (!rows.length) {
    console.error('[webhook] paid update matched no row for booking', bookingId);
    return;
  }

  console.log('[webhook] booking', bookingId, 'marked paid');
}

async function markCancelled(session, reason) {
  const bookingId = bookingIdFrom(session);
  if (!bookingId) return;

  const booking = await findBookingById(bookingId);
  if (!booking) return;

  /* A booking that is already paid is never walked back by an expiry event.
   * Sessions can expire after a successful delayed payment, and the money is
   * the more reliable signal than the session's lifecycle. */
  if (booking.status === 'paid' || booking.status === 'confirmed' ||
      booking.status === 'completed') {
    console.log('[webhook] ignoring', reason, 'for already-paid booking', bookingId);
    return;
  }

  await updateBooking(bookingId, { status: 'cancelled' });
  console.log('[webhook] booking', bookingId, 'cancelled after', reason);
}
