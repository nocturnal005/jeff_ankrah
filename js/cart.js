/*
 * CASTTCO basket.
 *
 * Holds only product ids and quantities, never names or prices. Prices are
 * looked up fresh from the database on every render, so a basket left open
 * overnight cannot show yesterday's price, and the checkout function on the
 * server re-reads them again before charging anything. A basket that stored
 * its own prices would be a basket a customer could edit.
 *
 * Guests get a working basket without an account, which is the whole point of
 * keeping it in localStorage rather than behind a login.
 */
(function (global) {
  'use strict';

  var KEY = 'casttco.cart.v1';
  var MAX_QTY = 99;
  var listeners = [];

  // Private browsing and hardened settings can make localStorage throw on
  // access rather than simply return null, so every touch is guarded and the
  // basket degrades to memory-only rather than taking the page down with it.
  var memoryFallback = null;

  function canUseStorage() {
    try {
      var probe = '__casttco_probe__';
      global.localStorage.setItem(probe, '1');
      global.localStorage.removeItem(probe);
      return true;
    } catch (err) {
      return false;
    }
  }

  var storageAvailable = canUseStorage();

  function readRaw() {
    if (!storageAvailable) return memoryFallback;
    try {
      return global.localStorage.getItem(KEY);
    } catch (err) {
      return null;
    }
  }

  function writeRaw(value) {
    if (!storageAvailable) {
      memoryFallback = value;
      return;
    }
    try {
      global.localStorage.setItem(KEY, value);
    } catch (err) {
      // Quota exceeded, or storage disabled mid-session. Keep the basket in
      // memory so the current visit still works.
      storageAvailable = false;
      memoryFallback = value;
    }
  }

  /* Returns a clean array of {id, qty}. Anything malformed is dropped rather
   * than thrown, because a corrupt basket must not break the whole page. */
  function load() {
    var raw = readRaw();
    if (!raw) return [];

    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return [];
    }
    if (!Array.isArray(parsed)) return [];

    var seen = Object.create(null);
    var clean = [];

    parsed.forEach(function (entry) {
      if (!entry || typeof entry.id !== 'string') return;
      var qty = Math.floor(Number(entry.qty));
      if (!isFinite(qty) || qty < 1) return;
      if (seen[entry.id]) return;
      seen[entry.id] = true;
      clean.push({ id: entry.id, qty: Math.min(qty, MAX_QTY) });
    });

    return clean;
  }

  function save(items) {
    writeRaw(JSON.stringify(items));
    notify();
  }

  function notify() {
    var snapshot = load();
    listeners.forEach(function (fn) {
      try {
        fn(snapshot);
      } catch (err) {
        // One broken listener must not stop the others updating.
        if (global.console) global.console.error('cart listener failed', err);
      }
    });
  }

  var Cart = {
    items: load,

    count: function () {
      return load().reduce(function (sum, item) { return sum + item.qty; }, 0);
    },

    /* Adds to the existing quantity rather than replacing it, so clicking Add
     * twice gives two, which is what people expect. */
    add: function (id, qty) {
      if (typeof id !== 'string' || !id) return;
      var amount = Math.floor(Number(qty));
      if (!isFinite(amount) || amount < 1) amount = 1;

      var items = load();
      var found = false;

      items.forEach(function (item) {
        if (item.id === id) {
          item.qty = Math.min(item.qty + amount, MAX_QTY);
          found = true;
        }
      });

      if (!found) items.push({ id: id, qty: Math.min(amount, MAX_QTY) });
      save(items);
    },

    /* Setting a quantity of zero or less removes the line, which is how the
     * minus button empties a row without needing a separate call. */
    setQty: function (id, qty) {
      var amount = Math.floor(Number(qty));
      if (!isFinite(amount) || amount < 1) return Cart.remove(id);

      var items = load().map(function (item) {
        if (item.id === id) item.qty = Math.min(amount, MAX_QTY);
        return item;
      });
      save(items);
    },

    remove: function (id) {
      save(load().filter(function (item) { return item.id !== id; }));
    },

    clear: function () {
      save([]);
    },

    /* Returns an unsubscribe function so callers can tidy up after themselves. */
    subscribe: function (fn) {
      if (typeof fn !== 'function') return function () {};
      listeners.push(fn);
      return function () {
        listeners = listeners.filter(function (item) { return item !== fn; });
      };
    },

    /* True when the basket is memory-only. The UI warns the customer that it
     * will not survive a refresh rather than letting them lose a full basket
     * silently. */
    isEphemeral: function () {
      return !storageAvailable;
    }
  };

  // Keep two open tabs in agreement. Without this, adding an item in one tab
  // leaves the other showing a stale count and overwriting it on next write.
  if (global.addEventListener) {
    global.addEventListener('storage', function (event) {
      if (event.key === KEY) notify();
    });
  }

  global.CasttcoCart = Cart;
}(window));
