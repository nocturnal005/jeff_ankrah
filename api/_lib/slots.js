/*
 * Appointment slot arithmetic.
 *
 * Deliberately pure: nothing here touches the network or the database, so the
 * awkward parts -- British Summer Time, the notice period, the booking horizon
 * -- can be tested directly instead of inferred from a booking that went wrong.
 *
 * The one rule that governs everything below: working hours are stated in LOCAL
 * time and appointments are stored in UTC. "Nine to five" means nine to five in
 * London in both June and December, which are different instants. Storing local
 * times, or converting with a fixed offset, is how every appointment in the
 * diary silently moves by an hour twice a year.
 */

export const SLOT_MINUTES = 60;
export const TIMEZONE = 'Europe/London';

/* A day's slots are simply its working hours divided by the duration, so
 * 09:00-17:00 at 60 minutes gives eight starting 09:00 through 16:00. The daily
 * cap is therefore a consequence of the hours rather than a separate setting:
 * widen the hours and the cap rises with them. */

/* Long enough that someone cannot book a consultation for twenty minutes from
 * now, and consistent with the 24 hours' notice the refund policy asks of
 * customers cancelling. */
export const MIN_NOTICE_HOURS = 24;

/* Far enough ahead to be useful, near enough that the diary is not committed
 * months out. */
export const HORIZON_DAYS = 56;

/* ------------------------------------------------------------------ timezone */

/* The UTC offset London is on at a given instant, in minutes: 0 in winter, 60
 * during British Summer Time. Read from the platform's own timezone database
 * rather than hardcoded, because the dates BST starts and ends move each year
 * and legislation has changed them before. */
export function londonOffsetMinutes(instant) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    timeZoneName: 'longOffset'
  }).formatToParts(instant);

  const name = parts.find((p) => p.type === 'timeZoneName');
  if (!name) return 0;

  // "GMT" in winter, "GMT+01:00" in summer.
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name.value);
  if (!match) return 0;

  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}

/* A local London wall-clock time turned into the actual instant it refers to.
 *
 * Done in two steps because the offset depends on the instant, and the instant
 * is what is being worked out. Reading the wall time as if it were UTC lands
 * within an hour of the answer, which is close enough to look up the right
 * offset for every hour this site offers. The ambiguity that remains only
 * affects the two clock-change hours themselves, at 01:00 on a Sunday, and no
 * consultation is bookable then. */
export function londonToUtc(dateStr, hours, minutes) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const asIfUtc = new Date(Date.UTC(y, m - 1, d, hours, minutes, 0, 0));
  return new Date(asIfUtc.getTime() - londonOffsetMinutes(asIfUtc) * 60000);
}

/* Postgres dow for a calendar date: 0 Sunday ... 6 Saturday. A bare date has no
 * timezone, so this is unambiguous. */
export function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/* Today in London, as YYYY-MM-DD. Not toISOString(), which is UTC and would
 * roll the date over an hour early on summer evenings. */
export function londonToday(now) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(now || new Date());
}

export function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const moved = new Date(Date.UTC(y, m - 1, d + days));
  return moved.toISOString().slice(0, 10);
}

/* An appointment written the way a person would say it, in London time.
 * Used on Stripe's checkout page, on the receipt and in the confirmation, so
 * nobody has to convert a UTC timestamp to work out when they are expected. */
export function describeSlot(iso) {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return '';

  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).format(when);
}

/* --------------------------------------------------------------- generation */

function parseTime(value) {
  const [h, m] = String(value).split(':').map(Number);
  return { hours: h, minutes: m || 0 };
}

/* Every slot a given date could offer, before anything is subtracted. */
export function slotsForDate(dateStr, availability) {
  const weekday = weekdayOf(dateStr);
  const out = [];

  availability
    .filter((rule) => rule.weekday === weekday && rule.is_active !== false)
    .forEach((rule) => {
      const from = parseTime(rule.start_time);
      const to = parseTime(rule.end_time);

      const startMins = from.hours * 60 + from.minutes;
      const endMins = to.hours * 60 + to.minutes;

      // The last slot must finish by end_time, so it starts one duration
      // before it: 09:00-17:00 at 60 minutes ends at 16:00, not 17:00.
      for (let m = startMins; m + SLOT_MINUTES <= endMins; m += SLOT_MINUTES) {
        out.push(londonToUtc(dateStr, Math.floor(m / 60), m % 60));
      }
    });

  return out.sort((a, b) => a - b);
}

/* The bookable slots across a range: working hours, minus closures, minus what
 * is already taken, minus anything too soon or too far ahead.
 *
 * `taken` is a list of ISO strings; comparison is by exact instant, so a slot
 * held by a pending booking is as unavailable as one already paid for. */
export function availableSlots({ availability, blackouts, taken, now }) {
  const at = now || new Date();
  const today = londonToday(at);
  const earliest = new Date(at.getTime() + MIN_NOTICE_HOURS * 3600000);
  const closed = new Set(blackouts || []);
  const busy = new Set((taken || []).map((t) => new Date(t).getTime()));

  const byDate = [];

  for (let i = 0; i <= HORIZON_DAYS; i++) {
    const dateStr = addDays(today, i);
    if (closed.has(dateStr)) continue;

    const free = slotsForDate(dateStr, availability)
      .filter((slot) => slot >= earliest)
      .filter((slot) => !busy.has(slot.getTime()));

    if (free.length) {
      byDate.push({ date: dateStr, slots: free.map((s) => s.toISOString()) });
    }
  }

  return byDate;
}

/* Whether one specific instant is a slot that may still be booked. The booking
 * endpoint re-checks this rather than trusting what the browser sends: the page
 * offered a slot some seconds ago, and the request arrives claiming one. Those
 * are not the same thing, and only the second is under an attacker's control. */
export function isBookable(iso, { availability, blackouts, taken, now }) {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return false;

  const days = availableSlots({ availability, blackouts, taken, now });
  return days.some((day) => day.slots.includes(when.toISOString()));
}
