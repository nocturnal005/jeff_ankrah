/*
 * Booking emails: a confirmation to the customer, a notification to Jeffery.
 *
 * Sent from the webhook, at the only moment we actually know a booking has been
 * paid for. Not from the browser returning to the confirmation page, which
 * anyone can load without having paid.
 *
 * The governing rule: SENDING MUST NEVER BREAK A BOOKING. Every function here
 * reports failure by returning rather than throwing, and the caller logs and
 * carries on. A customer whose money has been taken and whose slot is held has
 * been served, even if the receipt never arrives; failing the webhook over it
 * would make Stripe retry, and a retry after a successful charge is a far worse
 * problem than a missing email.
 *
 * Resend is the provider. Swapping it means rewriting send() and nothing else.
 */
import { describeSlot } from './slots.js';
import { env } from './bookings.js';

const ENDPOINT = 'https://api.resend.com/emails';

/* Address the mail comes FROM. Must be on a domain verified with the provider,
 * or it is silently spam-filed rather than rejected, which is worse. */
export function fromAddress() {
  return env('BOOKING_FROM_EMAIL', 'CASTTCO <bookings@casttco.online>');
}

/* Where Jeffery is told about new bookings. Falls back to the address already
 * published on the site, so a missing variable still reaches somebody. */
export function notifyAddress() {
  return env('BOOKING_NOTIFY_EMAIL', 'casttcompany@gmail.com');
}

export function emailConfigured() {
  return Boolean(env('RESEND_API_KEY'));
}

/* ------------------------------------------------------------------ helpers */

/* Everything interpolated into the HTML below comes from a booking form, so it
 * is a stranger's text. Escaped rather than trusted: a name containing a stray
 * angle bracket should look odd, not rewrite the email. */
function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function money(pence, currency) {
  if (typeof pence !== 'number' || !isFinite(pence)) return '';
  var symbol = String(currency || 'GBP').toUpperCase() === 'GBP' ? '£' : '';
  return symbol + (pence / 100).toFixed(2);
}

/* A short, quotable reference. The booking id is a UUID, which nobody is going
 * to read down a phone line. */
function reference(id) {
  return String(id || '').split('-')[0].toUpperCase();
}

/* Deliberately plain markup. Email clients are not browsers: no flexbox, no
 * grid, no external stylesheet, and Outlook will ignore half of what is left.
 * Inline styles on tables is the format that survives. */
function shell(heading, rows, footnote) {
  const cells = rows.map(function (row) {
    return '<tr>' +
      '<td style="padding:8px 16px 8px 0;color:#8a8a8a;font-size:13px;' +
      'text-transform:uppercase;letter-spacing:1px;white-space:nowrap;' +
      'vertical-align:top;">' + esc(row[0]) + '</td>' +
      '<td style="padding:8px 0;color:#1a1a1a;font-size:15px;">' + esc(row[1]) + '</td>' +
      '</tr>';
  }).join('');

  return '<!doctype html><html><body style="margin:0;padding:24px;' +
    'background:#f5f5f3;font-family:Helvetica,Arial,sans-serif;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" ' +
    'style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e5e0;">' +
    '<tr><td style="padding:28px 28px 8px;">' +
    '<div style="font-size:20px;letter-spacing:3px;color:#8a7320;font-weight:bold;">CASTTCO</div>' +
    '<h1 style="margin:18px 0 20px;font-size:20px;color:#1a1a1a;font-weight:normal;">' +
    esc(heading) + '</h1>' +
    '<table role="presentation" cellpadding="0" cellspacing="0">' + cells + '</table>' +
    '</td></tr>' +
    '<tr><td style="padding:8px 28px 28px;color:#6a6a6a;font-size:13px;line-height:20px;">' +
    footnote +
    '</td></tr></table></body></html>';
}

/* ------------------------------------------------------------------- send */

/* Returns true on success, false on any failure. Never throws: the caller is a
 * webhook that must answer 200 regardless. */
async function send(to, subject, html, text) {
  const key = env('RESEND_API_KEY');
  if (!key) {
    console.log('[email] not configured, skipping:', subject);
    return false;
  }

  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + key,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ from: fromAddress(), to: [to], subject, html, text })
    });

    if (!response.ok) {
      // Body names the reason -- usually an unverified domain. Never the key.
      console.error('[email] send failed:', response.status, await response.text());
      return false;
    }
    console.log('[email] sent:', subject);
    return true;
  } catch (error) {
    console.error('[email] send threw:', error.message);
    return false;
  }
}

/* -------------------------------------------------------------- customer */

export async function sendCustomerConfirmation(booking) {
  const when = booking.starts_at ? describeSlot(booking.starts_at) : null;
  const paid = money(booking.price_pence, booking.currency);
  const ref = reference(booking.id);

  const rows = [
    ['Booked', booking.service || 'Consultation'],
    ['Paid', paid],
    ['Reference', ref]
  ];
  if (when) rows.splice(1, 0, ['Appointment', when]);

  const subject = when
    ? 'Your CASTTCO consultation — ' + when
    : 'Your CASTTCO consultation is booked';

  const footnote =
    '<p style="margin:0 0 12px;">Please make a note of the time above. ' +
    'Cancellations need 24 hours&rsquo; notice.</p>' +
    '<p style="margin:0 0 12px;">Need to change or cancel? Reply to this email, ' +
    'or call 07310 061564.</p>' +
    '<p style="margin:0;color:#9a9a9a;">CASTTCO &middot; Greater London &middot; ' +
    'casttco.online</p>';

  const text = [
    'Your CASTTCO consultation is booked.',
    '',
    'Booked:      ' + (booking.service || 'Consultation'),
    when ? 'Appointment: ' + when : null,
    'Paid:        ' + paid,
    'Reference:   ' + ref,
    '',
    'Please make a note of the time. Cancellations need 24 hours’ notice.',
    'To change or cancel, reply to this email or call 07310 061564.',
    '',
    'CASTTCO, Greater London. casttco.online'
  ].filter(Boolean).join('\n');

  return send(booking.email, subject,
    shell('Your consultation is booked', rows, footnote), text);
}

/* ---------------------------------------------------------------- jeffery */

export async function sendOwnerNotification(booking) {
  const when = booking.starts_at ? describeSlot(booking.starts_at) : 'no time recorded';

  const rows = [
    ['Appointment', when],
    ['Service', booking.service || '—'],
    ['Name', booking.name],
    ['Email', booking.email],
    ['Phone', booking.phone || '—'],
    ['Paid', money(booking.price_pence, booking.currency)],
    ['Reference', reference(booking.id)]
  ];
  if (booking.notes) rows.push(['Notes', booking.notes]);

  const subject = 'New booking: ' + when + ' — ' + (booking.service || 'Consultation');

  const text = rows.map(function (r) { return r[0] + ': ' + r[1]; }).join('\n');

  return send(notifyAddress(), subject,
    shell('New consultation booking', rows,
      '<p style="margin:0;">Paid through the website. The slot is held in the ' +
      'diary and will not be offered to anyone else.</p>'),
    text);
}
