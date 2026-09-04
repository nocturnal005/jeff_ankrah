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

/* Accepts YYYY-MM-DD only, and refuses dates in the past. Date is a
 * preference, not a confirmed slot, so a wide future window is fine; a booking
 * for last week is a typo or a bot. */
function normaliseDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(value + 'T00:00:00Z');
  if (Number.isNaN(parsed.getTime())) return null;
  const today = new Date();
  const startOfToday = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  if (parsed.getTime() < startOfToday) return null;
  return value;
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

  return {
    ok: true,
    booking: {
      name,
      email,
      phone: clean(input.phone, LIMITS.phone) || null,
      service,
      preferred_date: normaliseDate(input.preferred_date),
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
    throw new Error('Booking insert failed: ' + response.status + ' ' + (await response.text()));
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
