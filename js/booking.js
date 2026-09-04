/*
 * CASTTCO consultation booking.
 *
 * Collects the booking details, hands them to /api/create-booking-session and
 * follows the Stripe Checkout URL that comes back.
 *
 * There is no price in anything this file sends. The amount is decided by the
 * serverless function and re-read there from configuration, so editing the
 * number below, or anything else in the page, changes what a visitor is shown
 * and never what they are charged.
 *
 * Card details are never handled here either: the visitor leaves for Stripe's
 * own page to enter them, which is what keeps this site out of scope for
 * handling card data at all.
 */
(function () {
  'use strict';

  var cfg = window.CASTTCO_CONFIG || {};
  var SYMBOL = cfg.currencySymbol || '£';

  var ENDPOINT = '/api/create-booking-session';
  var CONTACT_URL = cfg.contactUrl || 'index.html#contact';

  /* ---------------------------------------------------------------- utils */

  function money(pence) {
    if (typeof pence !== 'number' || !isFinite(pence)) return null;
    // Whole pounds read better on a headline price than "£50.00" does.
    return SYMBOL + (pence % 100 === 0 ? String(pence / 100) : (pence / 100).toFixed(2));
  }

  function say(node, message, tone) {
    if (!node) return;
    node.textContent = message;
    node.className = 'text-center font-body-md min-h-[1.5rem] ' +
      (tone === 'error' ? 'text-error' : 'text-primary');
  }

  /* Today in the visitor's own timezone, as YYYY-MM-DD. Deliberately not
   * toISOString(), which converts to UTC first and offers yesterday as the
   * earliest bookable date for anyone west of Greenwich. */
  function todayLocal() {
    var now = new Date();
    var month = String(now.getMonth() + 1);
    var day = String(now.getDate());
    return now.getFullYear() + '-' +
      (month.length < 2 ? '0' + month : month) + '-' +
      (day.length < 2 ? '0' + day : day);
  }

  /* ------------------------------------------------------------ price copy */

  /* The displayed price comes from js/config.js so the page and the basket
   * share one number. The server keeps its own copy in CONSULTATION_PRICE_PENCE
   * and that is the one that is charged; if the two ever disagree, the visitor
   * sees this one and pays that one, so they are meant to be changed together. */
  function renderPrice() {
    var priceNode = document.getElementById('booking-price');
    var label = document.querySelector('#booking-submit span');
    var shown = money(cfg.consultationPricePence);
    if (!shown) return;

    if (priceNode) priceNode.textContent = shown;
    if (label) label.textContent = 'PAY ' + shown + ' & CONFIRM BOOKING';
  }

  /* ------------------------------------------------------------- submitting */

  function submit(form, status, button) {
    var payload = {};
    var data = new FormData(form);
    data.forEach(function (value, key) {
      payload[key] = value;
    });

    button.disabled = true;
    say(status, 'Taking you to our payment page…');

    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (response) {
      // Read the body either way: the server explains a refusal in it, and
      // that explanation is written to be shown to the visitor.
      return response.json().then(function (body) {
        return { ok: response.ok, body: body };
      }).catch(function () {
        return { ok: response.ok, body: {} };
      });
    }).then(function (result) {
      if (result.ok && result.body && result.body.url) {
        // Leaving the site, so the button stays disabled. Re-enabling it here
        // invites a second click during the redirect and a second booking.
        window.location.assign(result.body.url);
        return;
      }

      button.disabled = false;
      say(status, (result.body && result.body.error) ||
        'We could not start your booking just now. Please try again shortly.', 'error');
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
    var form = document.getElementById('booking-form');
    if (!form) return;

    var status = document.getElementById('booking-status');
    var button = document.getElementById('booking-submit');

    renderPrice();

    // A date input will happily accept 1974 by keyboard, whatever the picker
    // offers. The server refuses past dates as well; this is only so the
    // visitor finds out before they have paid rather than after.
    var date = document.getElementById('booking-date');
    if (date) date.min = todayLocal();

    /* Someone who abandons Stripe's page comes back to ?cancelled=1. Saying
     * plainly that no money was taken heads off the obvious worry, and the
     * message lives in the page rather than being written by script so it is
     * still there if this file fails to load. */
    if (window.location.search.indexOf('cancelled=1') !== -1) {
      var cancelled = document.getElementById('booking-cancelled');
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

      submit(form, status, button);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}());
