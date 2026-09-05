/*
 * CASTTCO consultation booking.
 *
 * Loads free appointment slots from /api/availability, shows them as a month
 * calendar, and hands the booking to /api/create-booking-session, which returns
 * a Stripe Checkout URL to follow.
 *
 * Two things this file deliberately does not do.
 *
 * It does not work out availability. The server sends the free times and this
 * renders them. Deciding it here would mean shipping the diary to the browser,
 * and the diary is a record of when a named person is with a client. A day with
 * no free slots is simply absent from the response, so an empty square on the
 * calendar says "nothing available" without saying why.
 *
 * It does not send a price, and it is not trusted about the slot either. The
 * amount is set server-side, and the chosen time is rechecked against the diary
 * before anything is written, because a time this page offered some seconds ago
 * and a time claimed in a request are not the same thing.
 */
(function () {
  'use strict';

  var cfg = window.CASTTCO_CONFIG || {};
  var SYMBOL = cfg.currencySymbol || '£';

  var ENDPOINT = '/api/create-booking-session';
  var AVAILABILITY = '/api/availability';

  var days = [];          // [{ date: 'YYYY-MM-DD', slots: [iso] }]
  var byDate = {};
  var view = null;        // { year, month } of the visible month, month 0-11
  var selectedDate = null;
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

  /* A bare date has no timezone, so it is read as UTC and formatted as UTC.
   * Treating it as local would shift the label a day for anyone west of here. */
  function dateParts(dateStr) {
    var p = dateStr.split('-').map(Number);
    return { year: p[0], month: p[1] - 1, day: p[2] };
  }

  function longDate(dateStr) {
    var p = dateParts(dateStr);
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long'
    }).format(new Date(Date.UTC(p.year, p.month, p.day)));
  }

  function monthName(year, month) {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC', month: 'long', year: 'numeric'
    }).format(new Date(Date.UTC(year, month, 1)));
  }

  /* Monday-first column index, as a UK diary reads. getUTCDay is Sunday-first. */
  function mondayIndex(year, month, day) {
    return (new Date(Date.UTC(year, month, day)).getUTCDay() + 6) % 7;
  }

  function daysInMonth(year, month) {
    return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  }

  function pad(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function key(year, month, day) {
    return year + '-' + pad(month + 1) + '-' + pad(day);
  }

  /* ------------------------------------------------------------- calendar */

  function monthsSpanned() {
    if (!days.length) return { first: null, last: null };
    var a = dateParts(days[0].date);
    var b = dateParts(days[days.length - 1].date);
    return {
      first: { year: a.year, month: a.month },
      last: { year: b.year, month: b.month }
    };
  }

  function monthValue(m) {
    return m.year * 12 + m.month;
  }

  function renderCalendar() {
    var grid = byId('cal-grid');
    var label = byId('cal-month');
    var prev = byId('cal-prev');
    var next = byId('cal-next');
    var empty = byId('cal-empty');
    if (!grid || !view) return;

    label.textContent = monthName(view.year, view.month);
    grid.textContent = '';

    var span = monthsSpanned();
    if (prev) prev.disabled = monthValue(view) <= monthValue(span.first);
    if (next) next.disabled = monthValue(view) >= monthValue(span.last);

    // Blank cells so the first of the month lands under the right weekday.
    var lead = mondayIndex(view.year, view.month, 1);
    for (var b = 0; b < lead; b++) {
      grid.appendChild(document.createElement('span'));
    }

    var total = daysInMonth(view.year, view.month);
    var offered = 0;

    for (var d = 1; d <= total; d++) {
      var dateStr = key(view.year, view.month, d);
      var day = byDate[dateStr];
      var cell = document.createElement('button');
      cell.type = 'button';
      cell.textContent = String(d);

      if (day) {
        offered++;
        var isSelected = dateStr === selectedDate;
        cell.className = 'aspect-square flex items-center justify-center ' +
          'font-body-md text-sm transition-colors ' +
          (isSelected
            ? 'bg-primary text-on-primary'
            : 'border border-primary/40 text-primary hover:bg-primary/10');
        cell.setAttribute('aria-label',
          longDate(dateStr) + ', ' + day.slots.length +
          (day.slots.length === 1 ? ' time available' : ' times available'));
        cell.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
        cell.setAttribute('data-date', dateStr);
        cell.addEventListener('click', function () {
          selectDay(this.getAttribute('data-date'));
        });
      } else {
        // Unavailable rather than hidden: an empty square still shows the shape
        // of the month, which a missing cell would not.
        cell.className = 'aspect-square flex items-center justify-center ' +
          'font-body-md text-sm text-on-surface/20 cursor-not-allowed';
        cell.disabled = true;
        cell.setAttribute('aria-label', longDate(dateStr) + ', no appointments');
      }

      grid.appendChild(cell);
    }

    if (empty) {
      if (offered) {
        empty.hidden = true;
      } else {
        empty.textContent = 'No appointments available in ' +
          monthName(view.year, view.month) + '. Try another month.';
        empty.hidden = false;
      }
    }
  }

  function shiftMonth(delta) {
    var v = new Date(Date.UTC(view.year, view.month + delta, 1));
    view = { year: v.getUTCFullYear(), month: v.getUTCMonth() };
    renderCalendar();
  }

  /* ------------------------------------------------------------ open/close */

  function calendarOpen() {
    var panel = byId('cal-panel');
    return panel && !panel.hidden;
  }

  function openCalendar() {
    var panel = byId('cal-panel');
    var toggle = byId('cal-toggle');
    if (!panel) return;

    panel.hidden = false;
    if (toggle) toggle.setAttribute('aria-expanded', 'true');

    // Land on the selected month rather than wherever the user last browsed,
    // so reopening shows the date they already chose.
    if (selectedDate) {
      var p = dateParts(selectedDate);
      view = { year: p.year, month: p.month };
    }
    renderCalendar();

    // Focus the chosen day if there is one, otherwise the first bookable day,
    // so the keyboard lands somewhere useful instead of at the top of the grid.
    var target = panel.querySelector('button[aria-pressed="true"]') ||
      panel.querySelector('#cal-grid button:not([disabled])');
    if (target) target.focus();
  }

  function closeCalendar(returnFocus) {
    var panel = byId('cal-panel');
    var toggle = byId('cal-toggle');
    if (!panel || panel.hidden) return;

    panel.hidden = true;
    if (toggle) {
      toggle.setAttribute('aria-expanded', 'false');
      // Only on a deliberate close. Doing it after a click elsewhere would
      // yank focus away from whatever the visitor just reached for.
      if (returnFocus) toggle.focus();
    }
  }

  function setToggleLabel() {
    var label = byId('cal-toggle-label');
    if (!label) return;

    if (selectedDate) {
      label.textContent = longDate(selectedDate);
      label.className = 'font-body-md text-white';
    } else {
      label.textContent = 'Select date';
      label.className = 'font-body-md text-on-surface/40';
    }
  }

  /* ------------------------------------------------------------ selection */

  function renderTimes() {
    var wrap = byId('slot-times');
    var box = byId('slot-times-wrap');
    if (!wrap) return;

    wrap.textContent = '';
    var day = byDate[selectedDate];

    if (!day) {
      if (box) box.hidden = true;
      return;
    }

    day.slots.forEach(function (iso) {
      var button = document.createElement('button');
      button.type = 'button';
      button.textContent = londonTime(iso);
      button.setAttribute('data-slot', iso);
      button.className = 'border border-primary/40 text-primary px-5 py-3 ' +
        'font-label-md text-label-md tracking-widest hover:bg-primary/10 ' +
        'transition-all duration-300';
      button.addEventListener('click', function () {
        chooseTime(this.getAttribute('data-slot'));
      });
      wrap.appendChild(button);
    });

    if (box) box.hidden = false;
  }

  function selectDay(dateStr) {
    selectedDate = dateStr;
    chosen = null;
    var field = byId('booking-starts-at');
    if (field) field.value = '';
    var note = byId('slot-chosen');
    if (note) note.hidden = true;

    renderCalendar();
    setToggleLabel();
    renderTimes();

    /* Picking a date is the whole job of the calendar, so it closes itself and
     * hands over to the times below rather than sitting open on top of them. */
    closeCalendar(false);
    var times = byId('slot-times-wrap');
    if (times && !times.hidden) {
      var first = times.querySelector('button');
      if (first) first.focus();
    }
  }

  function chooseTime(iso) {
    chosen = iso;

    var field = byId('booking-starts-at');
    if (field) field.value = iso;

    // Selection is shown by restyling the buttons rather than by a separate
    // control, so what is chosen and what is clickable are the same thing.
    var buttons = document.querySelectorAll('#slot-times button');
    Array.prototype.forEach.call(buttons, function (b) {
      var isChosen = b.getAttribute('data-slot') === iso;
      b.className = (isChosen
        ? 'bg-primary text-on-primary'
        : 'border border-primary/40 text-primary hover:bg-primary/10') +
        ' px-5 py-3 font-label-md text-label-md tracking-widest transition-all duration-300';
    });

    var note = byId('slot-chosen');
    if (note) {
      note.textContent = 'Booking ' + longDate(selectedDate) + ' at ' + londonTime(iso) + '.';
      note.hidden = false;
    }
  }

  function clearChoice() {
    chosen = null;
    selectedDate = null;
    var field = byId('booking-starts-at');
    if (field) field.value = '';
    var note = byId('slot-chosen');
    if (note) note.hidden = true;
    var box = byId('slot-times-wrap');
    if (box) box.hidden = true;
    setToggleLabel();
  }

  /* --------------------------------------------------------- availability */

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
        byDate = {};
        days.forEach(function (day) { byDate[day.date] = day; });

        if (!days.length) {
          showSlotError('There are no appointments available at the moment. Please contact us and we will arrange one directly.');
          return;
        }

        clearChoice();

        // Open on the first month that actually has something in it.
        var first = dateParts(days[0].date);
        view = { year: first.year, month: first.month };

        var loading = byId('slot-loading');
        var picker = byId('slot-picker');
        if (loading) loading.hidden = true;
        if (picker) picker.hidden = false;

        renderCalendar();
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
       * form being submitted. Reloading means the visitor sees a corrected
       * calendar rather than being told to try again against times that are no
       * longer real. */
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

    var prev = byId('cal-prev');
    var next = byId('cal-next');
    if (prev) prev.addEventListener('click', function () { shiftMonth(-1); });
    if (next) next.addEventListener('click', function () { shiftMonth(1); });

    var toggle = byId('cal-toggle');
    if (toggle) {
      toggle.addEventListener('click', function () {
        if (calendarOpen()) closeCalendar(true); else openCalendar();
      });
    }

    /* A panel floating over the form has to close on the two things people
     * reflexively do to dismiss one. Without these it can only be closed by
     * finding the control that opened it, which is a trap on a phone. */
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && calendarOpen()) closeCalendar(true);
    });

    document.addEventListener('click', function (event) {
      if (!calendarOpen()) return;
      var panel = byId('cal-panel');
      var button = byId('cal-toggle');
      if (panel.contains(event.target) || (button && button.contains(event.target))) return;
      closeCalendar(false);
    });

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
        say(status, selectedDate
          ? 'Please choose a time for your appointment.'
          : 'Please choose a date and time for your appointment.', 'error');
        var picker = byId('slot-picker');
        if (picker) picker.scrollIntoView({ behavior: 'smooth', block: 'center' });
        // Open the calendar for them rather than leaving them to work out which
        // control the complaint is about.
        if (!selectedDate) openCalendar();
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
