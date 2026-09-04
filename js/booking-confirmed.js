/*
 * CASTTCO booking confirmation.
 *
 * Asks the server whether the checkout session in the URL was actually paid,
 * and says so. The page deliberately starts in a "checking" state rather than
 * a thank-you: this URL is reachable by anyone, with any reference, and
 * congratulating a visitor on a payment nobody has verified is how a booking
 * that silently failed still looks like a success.
 */
(function () {
  'use strict';

  var cfg = window.CASTTCO_CONFIG || {};
  var SYMBOL = cfg.currencySymbol || '£';

  function byId(id) {
    return document.getElementById(id);
  }

  function money(pence, currency) {
    if (typeof pence !== 'number' || !isFinite(pence)) return null;
    var symbol = (currency && String(currency).toLowerCase() !== 'gbp')
      ? String(currency).toUpperCase() + ' '
      : SYMBOL;
    return symbol + (pence / 100).toFixed(2);
  }

  function setIcon(name) {
    var icon = byId('confirm-icon');
    if (!icon) return;
    var glyph = icon.querySelector('.material-symbols-outlined');
    if (glyph) glyph.textContent = name;
  }

  function render(heading, message, icon) {
    var headingNode = byId('confirm-heading');
    var messageNode = byId('confirm-message');
    if (headingNode) headingNode.textContent = heading;
    if (messageNode) messageNode.textContent = message;
    setIcon(icon);
  }

  function showDetail(status) {
    var detail = byId('confirm-detail');
    var service = byId('confirm-service');
    var amount = byId('confirm-amount');
    var shown = money(status.amount_pence, status.currency);

    if (service) service.textContent = status.service || 'Consultation';
    if (amount) amount.textContent = shown || '—';
    if (detail && (status.service || shown)) detail.hidden = false;
  }

  function init() {
    if (!byId('confirm-heading')) return;

    var params = new URLSearchParams(window.location.search);
    var sessionId = params.get('session_id');

    if (!sessionId) {
      render(
        'Nothing to confirm here',
        'This page shows the result of a booking payment. If you have just booked and landed here without a reference, please contact us and we will confirm it for you.',
        'help'
      );
      return;
    }

    fetch('/api/booking-status?session_id=' + encodeURIComponent(sessionId), {
      headers: { Accept: 'application/json' }
    }).then(function (response) {
      return response.json().then(function (body) {
        return { ok: response.ok, body: body };
      });
    }).then(function (result) {
      if (!result.ok) {
        render(
          'We could not confirm this booking',
          (result.body && result.body.error) ||
            'Please contact us with your payment reference and we will confirm it for you.',
          'error'
        );
        return;
      }

      if (result.body.paid) {
        render(
          'Your consultation is booked',
          'Thank you. Your payment has gone through and your booking is confirmed.',
          'check_circle'
        );
        showDetail(result.body);
        return;
      }

      /* Not an error. Some payment methods take hours or days to clear, and
       * the booking is already recorded; it turns paid when the money lands. */
      render(
        'Your booking is being processed',
        'Your booking is recorded and your payment is still clearing with your bank. We will confirm as soon as it completes, and you do not need to pay again.',
        'hourglass_top'
      );
      showDetail(result.body);
    }).catch(function (error) {
      if (window.console) window.console.error(error);
      render(
        'We could not check your booking',
        'Your payment may well have gone through — please do not pay again. Contact us with your reference and we will confirm it for you.',
        'error'
      );
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}());
