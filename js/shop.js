/*
 * CASTTCO shop.
 *
 * Reads products from Supabase, renders the grid, and drives the basket
 * drawer. The basket itself only knows ids and quantities, so this file is
 * where those ids are married up with current prices from the database.
 *
 * Nodes are built with createElement and textContent rather than innerHTML.
 * Product copy is editable from the Supabase dashboard, and building markup
 * out of that copy by string concatenation is how a stray apostrophe becomes
 * a broken page and a stray script tag becomes something worse.
 */
(function () {
  'use strict';

  var cfg = window.CASTTCO_CONFIG || {};
  var Cart = window.CasttcoCart;

  var SYMBOL = cfg.currencySymbol || '£';
  var byId = Object.create(null);
  var loaded = false;

  /* ---------------------------------------------------------------- utils */

  function money(pence) {
    if (typeof pence !== 'number' || !isFinite(pence)) return null;
    return SYMBOL + (pence / 100).toFixed(2);
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /* Filenames such as "prife ring.jpeg" contain spaces and must be encoded
   * before they are used as a URL, or the request 404s. */
  function imageUrl(path) {
    return path ? encodeURI(path) : null;
  }

  /* ------------------------------------------------------------- data load */

  function fetchProducts() {
    var url = cfg.supabaseUrl + '/rest/v1/products' +
      '?select=id,slug,name,description,image_path,price_pence,stock' +
      '&is_active=eq.true&order=sort_order';

    return fetch(url, {
      headers: {
        apikey: cfg.supabasePublishableKey,
        Authorization: 'Bearer ' + cfg.supabasePublishableKey
      }
    }).then(function (res) {
      if (!res.ok) throw new Error('Products request failed: ' + res.status);
      return res.json();
    });
  }

  /* ------------------------------------------------------------- rendering */

  /* A product with no price is not for sale yet. It still appears, because
   * hiding it would make the range look thinner than it is, but it shows an
   * enquiry link instead of a button. Rendering a buy button against a null
   * price is how something gets sold for nothing. */
  function productCard(product) {
    var card = el('div', 'glass-card p-8 group flex flex-col');

    if (product.image_path) {
      var frame = el('div', 'w-full aspect-square mb-6 overflow-hidden rounded-md border border-primary/20');
      var img = document.createElement('img');
      img.src = imageUrl(product.image_path);
      img.alt = product.name;
      img.loading = 'lazy';
      img.decoding = 'async';
      img.className = 'w-full h-full object-cover group-hover:scale-110 transition-transform duration-[2000ms]';
      frame.appendChild(img);
      card.appendChild(frame);
    }

    card.appendChild(el('h3', 'font-headline-md text-primary mb-4', product.name));
    card.appendChild(el('p', 'font-body-md text-on-surface/60 flex-grow', product.description || ''));

    var priced = money(product.price_pence);
    var soldOut = product.stock === 0;
    var foot = el('div', 'mt-6 flex items-center justify-between gap-4');

    if (priced) {
      foot.appendChild(el('span', 'font-headline-md text-primary', priced));

      var button = el('button',
        'bg-primary text-on-primary px-6 py-3 font-label-md text-label-md ' +
        'tracking-widest hover:scale-105 transition-all duration-500 ' +
        'disabled:opacity-40 disabled:hover:scale-100 disabled:cursor-not-allowed',
        soldOut ? 'SOLD OUT' : 'ADD TO BASKET');
      button.type = 'button';
      button.disabled = soldOut;
      if (!soldOut) {
        button.addEventListener('click', function () {
          Cart.add(product.id, 1);
          button.textContent = 'ADDED';
          setTimeout(function () { button.textContent = 'ADD TO BASKET'; }, 1200);
          openDrawer();
        });
      }
      foot.appendChild(button);
    } else {
      foot.appendChild(el('span', 'font-body-md text-on-surface/40', 'Price on request'));
      var enquire = el('a',
        'border border-primary/40 text-primary px-6 py-3 font-label-md ' +
        'text-label-md tracking-widest hover:bg-primary/5 transition-all duration-500',
        'ENQUIRE');
      enquire.href = '#contact';
      foot.appendChild(enquire);
    }

    card.appendChild(foot);
    return card;
  }

  function renderGrid(products) {
    var grid = document.getElementById('shop-grid');
    if (!grid) return;

    grid.textContent = '';

    if (!products.length) {
      grid.appendChild(el('p', 'font-body-md text-on-surface/60 col-span-full text-center',
        'Our range is being updated. Please check back shortly.'));
      return;
    }

    products.forEach(function (product) {
      byId[product.id] = product;
      grid.appendChild(productCard(product));
    });
  }

  /* ---------------------------------------------------------------- basket */

  function basketLines() {
    return Cart.items().map(function (item) {
      return { product: byId[item.id], qty: item.qty };
    }).filter(function (line) {
      // No matching product means it was withdrawn from sale while it sat in
      // someone's basket. A product with no price is in the same position: it
      // is not sellable, and rendering it would put "null each" on screen and
      // a wrong subtotal underneath. Drop both rather than show either.
      return !!line.product && typeof line.product.price_pence === 'number';
    });
  }

  function subtotalPence() {
    return basketLines().reduce(function (sum, line) {
      return sum + (line.product.price_pence || 0) * line.qty;
    }, 0);
  }

  function renderDrawer() {
    var list = document.getElementById('basket-lines');
    var totalNode = document.getElementById('basket-subtotal');
    var empty = document.getElementById('basket-empty');
    var checkout = document.getElementById('basket-checkout');
    if (!list) return;

    var lines = basketLines();
    list.textContent = '';

    if (empty) empty.hidden = lines.length > 0;
    if (checkout) checkout.disabled = lines.length === 0;

    lines.forEach(function (line) {
      var row = el('div', 'flex gap-4 py-4 border-b border-primary/10');

      if (line.product.image_path) {
        var thumb = document.createElement('img');
        thumb.src = imageUrl(line.product.image_path);
        thumb.alt = '';
        thumb.className = 'w-16 h-16 object-cover rounded border border-primary/20 flex-shrink-0';
        row.appendChild(thumb);
      }

      var mid = el('div', 'flex-grow min-w-0');
      mid.appendChild(el('p', 'font-body-md text-on-surface truncate', line.product.name));
      mid.appendChild(el('p', 'font-body-md text-on-surface/50 text-sm',
        money(line.product.price_pence) + ' each'));

      var controls = el('div', 'flex items-center gap-3 mt-2');
      [['−', -1], ['+', 1]].forEach(function (pair) {
        var btn = el('button', 'w-7 h-7 border border-primary/40 text-primary leading-none', pair[0]);
        btn.type = 'button';
        btn.setAttribute('aria-label', pair[1] > 0 ? 'Increase quantity' : 'Decrease quantity');
        btn.addEventListener('click', function () {
          Cart.setQty(line.product.id, line.qty + pair[1]);
        });
        if (pair[1] < 0) controls.appendChild(btn);
        else {
          controls.appendChild(el('span', 'font-body-md text-on-surface w-6 text-center', String(line.qty)));
          controls.appendChild(btn);
        }
      });

      var remove = el('button', 'ml-2 font-body-md text-on-surface/40 hover:text-error text-sm underline', 'Remove');
      remove.type = 'button';
      remove.addEventListener('click', function () { Cart.remove(line.product.id); });
      controls.appendChild(remove);

      mid.appendChild(controls);
      row.appendChild(mid);
      row.appendChild(el('p', 'font-body-md text-primary flex-shrink-0',
        money(line.product.price_pence * line.qty)));
      list.appendChild(row);
    });

    if (totalNode) totalNode.textContent = money(subtotalPence()) || SYMBOL + '0.00';
  }

  /* Once products are known, anything unsellable is taken out of the stored
   * basket rather than merely hidden. Filtering it only at render time left
   * the badge counting items the drawer refused to show, so the icon read
   * three while the basket looked empty. */
  function pruneUnsellable() {
    if (!loaded) return;
    var doomed = Cart.items().filter(function (item) {
      var product = byId[item.id];
      return !product || typeof product.price_pence !== 'number';
    });
    doomed.forEach(function (item) { Cart.remove(item.id); });
  }

  function renderCount() {
    var badge = document.getElementById('basket-count');
    if (!badge) return;
    // Before products load, the raw count is the only number available. After,
    // it agrees with the drawer because the basket has been pruned.
    var n = loaded
      ? basketLines().reduce(function (sum, line) { return sum + line.qty; }, 0)
      : Cart.count();
    badge.textContent = String(n);
    badge.hidden = n === 0;
  }

  function openDrawer() {
    var drawer = document.getElementById('basket-drawer');
    var backdrop = document.getElementById('basket-backdrop');
    if (!drawer) return;
    drawer.classList.remove('translate-x-full');
    drawer.setAttribute('aria-hidden', 'false');
    if (backdrop) {
      backdrop.classList.remove('opacity-0', 'pointer-events-none');
    }
    var close = document.getElementById('basket-close');
    if (close) close.focus();
  }

  function closeDrawer() {
    var drawer = document.getElementById('basket-drawer');
    var backdrop = document.getElementById('basket-backdrop');
    if (!drawer) return;
    drawer.classList.add('translate-x-full');
    drawer.setAttribute('aria-hidden', 'true');
    if (backdrop) {
      backdrop.classList.add('opacity-0', 'pointer-events-none');
    }
  }

  /* ------------------------------------------------------------------ init */

  function init() {
    if (!cfg.supabaseUrl || !Cart) return;

    var toggle = document.getElementById('basket-toggle');
    if (toggle) toggle.addEventListener('click', openDrawer);

    var close = document.getElementById('basket-close');
    if (close) close.addEventListener('click', closeDrawer);

    var backdrop = document.getElementById('basket-backdrop');
    if (backdrop) backdrop.addEventListener('click', closeDrawer);

    // Checkout has no Stripe account behind it yet. Saying so plainly beats a
    // button that appears to work and then silently does nothing.
    var checkoutBtn = document.getElementById('basket-checkout');
    var note = document.getElementById('basket-note');
    if (checkoutBtn && note) {
      checkoutBtn.addEventListener('click', function () {
        note.textContent = 'Card payment is not switched on yet. Please contact us and we will complete your order directly.';
        note.hidden = false;
      });
    }

    if (Cart.isEphemeral() && note) {
      note.textContent = 'Your browser is blocking storage, so this basket will not survive a refresh.';
      note.hidden = false;
    }

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') closeDrawer();
    });

    Cart.subscribe(function () {
      renderCount();
      if (loaded) renderDrawer();
    });

    renderCount();

    fetchProducts().then(function (products) {
      renderGrid(products);
      loaded = true;
      pruneUnsellable();
      renderCount();
      renderDrawer();
    }).catch(function (err) {
      if (window.console) window.console.error(err);
      var grid = document.getElementById('shop-grid');
      if (grid) {
        grid.textContent = '';
        grid.appendChild(el('p', 'font-body-md text-on-surface/60 col-span-full text-center',
          'Our range could not be loaded just now. Please refresh, or contact us directly.'));
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}());
