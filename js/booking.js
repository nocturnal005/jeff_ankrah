/*
 * CASTTCO consultation booking.
 *
 * Loads the free appointment slots from /api/availability, lets the visitor
 * pick one, and hands the booking to /api/create-booking-session, which returns
 * a Stripe Checkout URL to follow.
 *
 * Two things this file deliberately does not do.
 *
 * It does not work out availability. The server sends a list of free times and
 * this renders them. Deciding it here would mean shipping the diary to the
 * browser, and the diary is a record of when a named person is with a client.
 *
 * It does not send a price, and it is not trusted about the slot either. The
 * amount is set server-side, and the chosen time is re-checked against the
 * diary before anything is written, because a time this page offered some
 * seconds ago and a time claimed in a request are not the same thing.
 */
(function () {
  'use strict';

  var cfg = window.CASTTCO_CONFIG || {};
  var SYMBOL = cfg.currencySymbol || '£';

  var ENDPOINT = '/api/create-booking-session';
  var AVAILABILITY = '/api/availability';

  var days = [];
  var chosen = null;

  /* ---------------------------------------------------------------- utils */

  function byId(id) {
    return document.getElementById(id);
  }

  function money(pence) {
    if (typeof pence !== 'number' || !isFinite(pence)) return null;
    return SYMBOL + (pence % 100 === 0 ? String(pence / 100) : (pence / 100).toFixed(2));
  }

  function say(node, message, tone) {
    if (!node) return;
    node.textContent = message;
    node.className = 'text-center font-body-md min-h-[1.5rem] ' +
      (tone === 'error' ? 'text-error' : 'text-primary');
  }

  /* Slots arrive as UTC instants and must be shown in London time, or a 4pm
   * appointment reads as 3pm to anyone whose device is set elsewhere. */
  function londonTime(iso) {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London', hour: 'numeric', minute: '2-digit', hour12: true
    }).format(new Date(iso));
  }

  function londonDate(dateStr) {
    var parts = dateStr.split('-');
    var utc = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long'
    }).format(utc);
  }

  /* ---------------------------------------------------------- availability */

  function showSlotError(message) {
    var box = byId('slot-error');
    var loading = byId('slot-loading');
    var picker = byId('slot-picker');
    if (loading) loading.hidden = true;
    if (picker) picker.hidden = true;
    if (box) {
      box.textContent = message;
      box.hidden = false;
    }
  }

  function renderTimes() {
    var wrap = byId('slot-times');
    var select = byId('slot-date');
    if (!wrap || !select) return;

    var day = days.filter(function (d) { return d.date === select.value; })[0];
    wrap.textContent = '';
    if (!day) return;

    day.slots.forEach(function (iso) {
      var button = document.createElement('button');
      button.type = 'button';
      button.textContent = londonTime(iso);
      button.setAttribute('data-slot', iso);
      button.className = 'border border-primary/40 text-primary px-5 py-3 ' +
        'font-label-md text-label-md tracking-widest hover:bg-primary/10 ' +
        'transition-all duration-300';
      button.addEventListener('click', function () { choose(iso); });
      wrap.appendChild(button);
    });
  }

  function choose(iso) {
    chosen = iso;

    var field = byId('booking-starts-at');
    if (field) field.value = iso;

    // Selection is shown by restyling the buttons rather than by a separate
    // control, so what is chosen and what is clickable are the same thing.
    var buttons = document.querySelectorAll('#slot-times button');
    Array.prototype.forEach.call(buttons, function (b) {
      var isChosen = b.getAttribute('data-slot') === iso;
      b.className = (isChosen
        ? 'bg-primary text-on-primary '
        : 'border border-primary/40 text-primary hover:bg-primary/10 ') +
        'px-5 py-3 font-label-md text-label-md tracking-widest transition-all duration-300' +
        (isChosen ? '' : ' border');
    });

    var note = byId('slot-chosen');
    if (note) {
      var select = byId('slot-date');
      note.textContent = 'Booking ' + londonDate(select.value) + ' at ' + londonTime(iso) + '.';
      note.hidden = false;
    }
  }

  function clearChoice() {
    chosen = null;
    var field = byId('booking-starts-at');
    if (field) field.value = '';
    var note = byId('slot-chosen');
    if (note) note.hidden = true;
  }

  function renderDates() {
    var select = byId('slot-date');
    var loading = byId('slot-loading');
    var picker = byId('slot-picker');
    if (!select) return;

    if (!days.length) {
      showSlotError('There are no appointments available at the moment. Please contact us and we will arrange one directly.');
      return;
    }

    select.textContent = '';
    days.forEach(function (day) {
      var option = document.createElement('option');
      option.value = day.date;
      option.className = 'bg-surface';
      option.textContent = londonDate(day.date) + ' (' + day.slots.length +
        (day.slots.length === 1 ? ' time' : ' times') + ')';
      select.appendChild(option);
    });

    if (loading) loading.hidden = true;
    if (picker) picker.hidden = false;
    renderTimes();
  }

  function loadAvailability() {
    return fetch(AVAILABILITY, { headers: { Accept: 'application/json' } })
      .then(function (response) {
        return response.json().then(function (body) {
          return { ok: response.ok, body: body };
        });
      })
      .then(function (result) {
        if (!result.ok) {
          showSlotError((result.body && result.body.error) ||
            'We could not load available times. Please contact us and we will book you in directly.');
          return;
        }
        days = (result.body && result.body.days) || [];
        clearChoice();
        renderDates();
      })
      .catch(function (error) {
        if (window.console) window.console.error(error);
        showSlotError('We could not reach our booking service. Please check your connection, or contact us directly.');
      });
  }

  /* ------------------------------------------------------------ price copy */

  function renderPrice() {
    var priceNode = byId('booking-price');
    var label = document.querySelector('#booking-submit span');
    var shown = money(cfg.consultationPricePence);
    if (!shown) return;

    if (priceNode) priceNode.textContent = shown;
    if (label) label.textContent = 'PAY ' + shown + ' & CONFIRM BOOKING';
  }

  /* ------------------------------------------------------------- submitting */

  function submit(form, status, button) {
    var payload = {};
    new FormData(form).forEach(function (value, key) {
      payload[key] = value;
    });

    button.disabled = true;
    say(status, 'Taking you to our payment page…');

    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (response) {
      return response.json().then(function (body) {
        return { ok: response.ok, status: response.status, body: body };
      }).catch(function () {
        return { ok: response.ok, status: response.status, body: {} };
      });
    }).then(function (result) {
      if (result.ok && result.body && result.body.url) {
        // Leaving the site, so the button stays disabled: re-enabling it invites
        // a second click during the redirect and a second booking.
        window.location.assign(result.body.url);
        return;
      }

      button.disabled = false;
      say(status, (result.body && result.body.error) ||
        'We could not start your booking just now. Please try again shortly.', 'error');

      /* Somebody took the slot in the seconds between this page loading and the
       * form being submitted. Reloading availability means the visitor sees a
       * corrected list rather than being told to try again against times that
       * are no longer real. */
      if (result.status === 409) loadAvailability();
    }).catch(function (error) {
      if (window.console) window.console.error(error);
      button.disabled = false;
      say(status,
        'We could not reach our payment service. Please check your connection, or contact us and we will book you in directly.',
        'error');
    });
  }

  /* ------------------------------------------------------------------ init */

  function init() {
    var form = byId('booking-form');
    if (!form) return;

    var status = byId('booking-status');
    var button = byId('booking-submit');

    renderPrice();
    loadAvailability();

    var select = byId('slot-date');
    if (select) {
      select.addEventListener('change', function () {
        clearChoice();
        renderTimes();
      });
    }

    /* Someone who abandons Stripe's page comes back to ?cancelled=1. Saying
     * plainly that no money was taken heads off the obvious worry. */
    if (window.location.search.indexOf('cancelled=1') !== -1) {
      var cancelled = byId('booking-cancelled');
      if (cancelled) cancelled.hidden = false;
    }

    form.addEventListener('submit', function (event) {
      event.preventDefault();

      if (!form.checkValidity()) {
        say(status, 'Please complete the required fields with a valid email address.', 'error');
        var firstInvalid = form.querySelector(':invalid');
        if (firstInvalid) firstInvalid.focus();
        return;
      }

      // Checked here as well as on the server, so the visitor is told before
      // they wait on a request that was never going to succeed.
      if (!chosen) {
        say(status, 'Please choose an appointment time.', 'error');
        var picker = byId('slot-picker');
        if (picker) picker.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }

      submit(form, status, button);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}());
