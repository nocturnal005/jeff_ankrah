/*
 * Shared server-side helpers for consultation bookings.
 *
 * Everything in this file runs inside a Vercel function and never reaches the
 * browser. Files under api/ whose name begins with an underscore are not
 * routed by Vercel, so this module cannot be called over HTTP.
 *
 * The single most important rule here: the price is decided by this file and
 * never by the request. A booking endpoint that accepts an amount from the
 * client is a booking endpoint that sells a fifty pound consultation for one
 * penny, and the browser is not a place where that decision can be defended.
 */

/* ------------------------------------------------------------------ config */

/* Read at call time rather than at module load. A missing variable should
 * surface as a clear 503 on the request that needed it, not as a crash while
 * the function is still cold-starting, which Vercel reports only as a 500. */
export function env(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    if (fallback !== undefined) return fallback;
    return null;
  }
  return value;
}

/* The canonical origin comes from configuration, not from the request's Host
 * header. Host is attacker controlled: were the return URLs built from it,
 * a forged request could send a paying customer to a lookalike site after
 * checkout. */
export function siteUrl() {
  return (env('SITE_URL', 'https://casttco.online') || '').replace(/\/+$/, '');
}

/* Price in pence, server-side. The floor is Stripe's own minimum charge for
 * GBP; anything below it would be rejected at the API with a message the
 * customer should never have been shown in the first place. */
export function consultationPricePence() {
  const raw = env('CONSULTATION_PRICE_PENCE', '5000');
  const pence = Number.parseInt(raw, 10);
  if (!Number.isInteger(pence) || pence < 30) return 5000;
  return pence;
}

export const CURRENCY = 'gbp';

/* The services offered on the booking page. Kept here as well as in the page
 * so the server can reject anything else: without this, "service" is an open
 * text field that anyone can post arbitrary content into, and it is read later
 * by a human in an inbox. */
export const SERVICES = [
  'Wellness Consultation',
  'Corporate Wellness Strategy',
  'Executive Coaching Sanctuary',
  'Private Performance Retainer'
];

/* ---------------------------------------------------------------- validate */

const LIMITS = { name: 120, email: 254, phone: 40, notes: 2000 };

function clean(value, max) {
  if (typeof value !== 'string') return '';
  // Strip control characters before trimming: they are invisible in an inbox
  // but can forge line breaks in a plain-text notification email.
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

/* Deliberately permissive. Email validation by regular expression cannot be
 * both correct and strict, and the address is confirmed in practice by Stripe
 * sending a receipt to it. This rejects only what is obviously not an address. */
function looksLikeEmail(value) {
  return /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(value);
}

/* The London calendar date an instant falls on. Appointments are stored in UTC,
 * but a 17:00 booking in June is 16:00 UTC, and reading the date straight off
 * the UTC value would put a late-evening appointment on the wrong day. */
function londonDateOf(instant) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(instant);
}

/* Returns { ok: true, booking } or { ok: false, error }. The error text is
 * safe to show a visitor: it names the field, never the internals. */
export function validateBooking(input) {
  if (!input || typeof input !== 'object') {
    return { ok: false, error: 'Booking details are missing.' };
  }

  // Honeypot. A field positioned off-screen and hidden from assistive
  // technology, which a person never sees and a form-filling bot fills in.
  // Silently accepted at the edge and refused here.
  if (clean(input.website, 200)) {
    return { ok: false, error: 'Booking could not be processed.' };
  }

  const name = clean(input.name, LIMITS.name);
  if (name.length < 2) {
    return { ok: false, error: 'Please give the name the consultation is for.' };
  }

  const email = clean(input.email, LIMITS.email).toLowerCase();
  if (!looksLikeEmail(email)) {
    return { ok: false, error: 'Please give a valid email address.' };
  }

  const service = clean(input.service, 120);
  if (!SERVICES.includes(service)) {
    return { ok: false, error: 'Please choose one of the listed services.' };
  }

  /* The chosen appointment, as an instant. Only the shape is checked here;
   * whether it is a real, free, still-bookable slot is decided against the
   * diary by the caller. A well-formed time is not the same as an available
   * one, and only the second matters. */
  const startsAt = typeof input.starts_at === 'string' ? new Date(input.starts_at) : null;
  if (!startsAt || Number.isNaN(startsAt.getTime())) {
    return { ok: false, error: 'Please choose an appointment time.' };
  }

  return {
    ok: true,
    booking: {
      name,
      email,
      phone: clean(input.phone, LIMITS.phone) || null,
      service,
      starts_at: startsAt.toISOString(),
      // Kept in step with the booked slot so the date is readable in the table
      // editor without converting from UTC in your head.
      preferred_date: londonDateOf(startsAt),
      notes: clean(input.notes, LIMITS.notes) || null,
      price_pence: consultationPricePence(),
      currency: 'GBP',
      status: 'pending'
    }
  };
}

/* ---------------------------------------------------------------- supabase */

/* PostgREST is called directly with fetch rather than through the Supabase
 * client library. One dependency instead of two, and the requests here are
 * simple enough that the library would only be hiding the headers that matter.
 *
 * The service role key bypasses row level security. That is precisely why the
 * schema grants no insert policy to anon: a booking can only be written by
 * this code, running on the server, with a price this code chose. */
function supabaseHeaders() {
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  return {
    apikey: key,
    Authorization: 'Bearer ' + key,
    'Content-Type': 'application/json'
  };
}

export function supabaseConfigured() {
  return Boolean(env('SUPABASE_URL') && env('SUPABASE_SERVICE_ROLE_KEY'));
}

export async function insertBooking(booking) {
  const response = await fetch(env('SUPABASE_URL') + '/rest/v1/consultation_bookings', {
    method: 'POST',
    headers: { ...supabaseHeaders(), Prefer: 'return=representation' },
    body: JSON.stringify(booking)
  });

  if (!response.ok) {
    // The response body can echo column names and constraint text. Useful in a
    // server log, never in something the visitor sees.
    const detail = await response.text();

    /* 23505 is Postgres refusing a duplicate key, which here means the unique
     * index on the slot rejected a second booking for the same time. That is
     * not a fault: it is two people having clicked the same slot, and the
     * database deciding the race the application could not. The caller turns it
     * into "pick another time" rather than an error, and crucially it happens
     * before anyone is charged. */
    if (detail.includes('23505') || /duplicate key/i.test(detail)) {
      const clash = new Error('Slot already taken');
      clash.slotTaken = true;
      throw clash;
    }

    throw new Error('Booking insert failed: ' + response.status + ' ' + detail);
  }

  const rows = await response.json();
  if (!Array.isArray(rows) || !rows.length) {
    throw new Error('Booking insert returned no row');
  }
  return rows[0];
}

export async function updateBooking(id, patch) {
  const response = await fetch(
    env('SUPABASE_URL') + '/rest/v1/consultation_bookings?id=eq.' + encodeURIComponent(id),
    {
      method: 'PATCH',
      headers: { ...supabaseHeaders(), Prefer: 'return=representation' },
      body: JSON.stringify(patch)
    }
  );

  if (!response.ok) {
    throw new Error('Booking update failed: ' + response.status + ' ' + (await response.text()));
  }

  // PostgREST answers 204 whether it changed a row or none at all, so the
  // representation is requested and counted. Without it, an update that
  // matched nothing looks exactly like a successful one.
  const rows = await response.json();
  return Array.isArray(rows) ? rows : [];
}

/* ------------------------------------------------------------------- slots */

export async function fetchAvailability() {
  const response = await fetch(
    env('SUPABASE_URL') + '/rest/v1/consultation_availability' +
      '?select=weekday,start_time,end_time,is_active&is_active=eq.true',
    { headers: supabaseHeaders() }
  );
  if (!response.ok) throw new Error('Availability read failed: ' + response.status);
  return response.json();
}

export async function fetchBlackouts(fromDate, toDate) {
  const response = await fetch(
    env('SUPABASE_URL') + '/rest/v1/consultation_blackouts' +
      '?select=blackout_date' +
      '&blackout_date=gte.' + encodeURIComponent(fromDate) +
      '&blackout_date=lte.' + encodeURIComponent(toDate),
    { headers: supabaseHeaders() }
  );
  if (!response.ok) throw new Error('Blackout read failed: ' + response.status);
  const rows = await response.json();
  return rows.map((r) => r.blackout_date);
}

/* Slots that are spoken for. A pending booking counts: someone is at Stripe's
 * page with their card out, and selling their slot to somebody else while they
 * type would be worse than briefly showing one fewer time. */
export async function fetchTakenSlots(fromIso, toIso) {
  const response = await fetch(
    env('SUPABASE_URL') + '/rest/v1/consultation_bookings' +
      '?select=starts_at&starts_at=not.is.null' +
      '&status=in.(pending,paid,confirmed,completed)' +
      '&starts_at=gte.' + encodeURIComponent(fromIso) +
      '&starts_at=lte.' + encodeURIComponent(toIso),
    { headers: supabaseHeaders() }
  );
  if (!response.ok) throw new Error('Taken slot read failed: ' + response.status);
  const rows = await response.json();
  return rows.map((r) => r.starts_at);
}

/* Releases slots held by checkouts nobody completed.
 *
 * The webhook already cancels a booking when Stripe reports the session
 * expired, and that is the reliable path. This is the belt to its braces: if a
 * webhook is ever missed or delayed, a slot would otherwise stay held until
 * someone noticed. Sweeping on read means availability heals itself.
 *
 * The window matches the Stripe session lifetime set at checkout, so a slot is
 * never released while its customer could still legitimately pay for it. */
export async function releaseStalePending(olderThanMinutes) {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60000).toISOString();
  const response = await fetch(
    env('SUPABASE_URL') + '/rest/v1/consultation_bookings' +
      '?status=eq.pending&created_at=lt.' + encodeURIComponent(cutoff),
    {
      method: 'PATCH',
      headers: { ...supabaseHeaders(), Prefer: 'return=representation' },
      body: JSON.stringify({ status: 'cancelled' })
    }
  );
  if (!response.ok) {
    throw new Error('Stale release failed: ' + response.status);
  }
  const rows = await response.json();
  return Array.isArray(rows) ? rows.length : 0;
}

/* How many unpaid bookings this address has started recently.
 *
 * The booking endpoint is public, unauthenticated, and writes a row every time
 * it is called, so something has to stand between it and a script in a loop.
 *
 * This is deliberately NOT a general rate limiter, and it should not be sold as
 * one. A real limiter needs durable per-caller state, and the obvious key --
 * the client IP -- is personal data under UK GDPR: storing it would mean saying
 * so in the privacy policy and keeping it to a retention period, which is a
 * poor trade for a site taking a handful of bookings a week. Capping by email
 * uses a column already being stored for an obvious reason, and it stops the
 * realistic cases: a stuck retry loop, a double-submitting form, one actor
 * hammering the endpoint. It does not stop a distributed flood using fresh
 * addresses each time, and if that ever happens the answer is a real limiter
 * with durable storage, not a tighter number here. */
export async function countRecentPending(email, windowMinutes, cap) {
  const since = new Date(Date.now() - windowMinutes * 60000).toISOString();
  const response = await fetch(
    env('SUPABASE_URL') + '/rest/v1/consultation_bookings' +
      '?select=id&status=eq.pending' +
      '&email=eq.' + encodeURIComponent(email) +
      '&created_at=gte.' + encodeURIComponent(since) +
      // Only ever needs to know whether the cap is reached, so it never reads
      // more rows than that regardless of how many are sitting there.
      '&limit=' + (cap + 1),
    { headers: supabaseHeaders() }
  );

  if (!response.ok) {
    throw new Error('Pending count failed: ' + response.status);
  }
  const rows = await response.json();
  return Array.isArray(rows) ? rows.length : 0;
}

export async function findBookingById(id) {
  const response = await fetch(
    env('SUPABASE_URL') + '/rest/v1/consultation_bookings' +
      '?select=id,status,price_pence,currency,email,name,service' +
      '&id=eq.' + encodeURIComponent(id),
    { headers: supabaseHeaders() }
  );

  if (!response.ok) {
    throw new Error('Booking lookup failed: ' + response.status);
  }
  const rows = await response.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

export async function findBookingBySession(sessionId) {
  const response = await fetch(
    env('SUPABASE_URL') + '/rest/v1/consultation_bookings' +
      '?select=id,status,price_pence,currency,email,name' +
      '&stripe_session_id=eq.' + encodeURIComponent(sessionId),
    { headers: supabaseHeaders() }
  );

  if (!response.ok) {
    throw new Error('Booking lookup failed: ' + response.status);
  }
  const rows = await response.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

/* ----------------------------------------------------------------- replies */

export function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json',
      // Nothing here is cacheable, and a cached booking response shared
      // between visitors would be a privacy problem as well as a bug.
      'Cache-Control': 'no-store'
    }
  });
}
