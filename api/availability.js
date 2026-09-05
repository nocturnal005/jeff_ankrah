/*
 * GET /api/availability
 *
 * The free consultation slots, as a list of dates each holding a list of UTC
 * start times. The booking page renders these; it does not work them out.
 *
 * Deliberately server-side. Deciding availability in the browser would mean
 * shipping the diary to it, and the diary is a list of when a named person is
 * with a client. Only free times leave this endpoint -- never a booking, never
 * a customer, never a reason a slot is unavailable.
 *
 * Exported as GET, not as a default export: on Vercel a default export takes
 * the (req, res) signature and its return value is discarded. See the note in
 * create-booking-session.js.
 */
import {
  env,
  fetchAvailability,
  fetchBlackouts,
  fetchTakenSlots,
  json,
  releaseStalePending,
  supabaseConfigured
} from './_lib/bookings.js';
import {
  HORIZON_DAYS,
  MIN_NOTICE_HOURS,
  SLOT_MINUTES,
  addDays,
  availableSlots,
  londonToday
} from './_lib/slots.js';

/* Matches the Stripe Checkout session lifetime set when a booking starts, so a
 * slot is never released while its customer could still pay for it. */
export const STALE_PENDING_MINUTES = 35;

export async function GET() {
  if (!supabaseConfigured()) {
    return json({ error: 'Booking is not switched on yet.' }, 503);
  }

  const today = londonToday();
  const horizon = addDays(today, HORIZON_DAYS);

  try {
    /* Sweep first, so a slot abandoned at Stripe becomes bookable again the
     * moment its session could no longer be paid. Not fatal if it fails: the
     * worst case is a slot that stays held slightly longer than necessary,
     * which is better than refusing to show availability at all. */
    try {
      const released = await releaseStalePending(STALE_PENDING_MINUTES);
      if (released) console.log('[availability] released', released, 'stale holds');
    } catch (error) {
      console.error('[availability] stale sweep failed:', error.message);
    }

    const [availability, blackouts, taken] = await Promise.all([
      fetchAvailability(),
      fetchBlackouts(today, horizon),
      fetchTakenSlots(new Date().toISOString(), new Date(Date.now() + HORIZON_DAYS * 86400000).toISOString())
    ]);

    const days = availableSlots({ availability, blackouts, taken, now: new Date() });

    return json({
      slotMinutes: SLOT_MINUTES,
      minNoticeHours: MIN_NOTICE_HOURS,
      timezone: 'Europe/London',
      days
    });
  } catch (error) {
    console.error('[availability] failed:', error.message);
    return json({ error: 'We could not load available times just now.' }, 500);
  }
}
