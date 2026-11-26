// Progressive enhancement only: every feature here has a plain HTML fallback.
(function () {
  'use strict';
  document.documentElement.classList.add('js');

  var toastTimer;
  function toast(html) {
    var el = document.querySelector('[data-toast]');
    if (!el) return;
    el.innerHTML = html;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 4000);
  }

  function escapeText(text) {
    var div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function setCartCount(count) {
    var badge = document.querySelector('[data-cart-count]');
    var label = document.querySelector('[data-cart-label]');
    if (badge) {
      badge.textContent = String(count);
      badge.hidden = count === 0;
      badge.classList.remove('bump');
      void badge.offsetWidth; // restart the animation
      badge.classList.add('bump');
    }
    if (label) label.textContent = ' (' + count + (count === 1 ? ' item)' : ' items)');
  }

  // Express add-to-cart (release 1.5 catalog): stay on the page and update the badge.
  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.hasAttribute('data-express')) return;
    if (!window.fetch || !window.URLSearchParams) return;
    event.preventDefault();
    var button = form.querySelector('button');
    if (button) button.setAttribute('aria-busy', 'true');
    fetch(form.action, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(new FormData(form)).toString(),
      credentials: 'same-origin',
    })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        setCartCount(data.count);
        toast('Added ' + escapeText(data.added) + ' to your cart. <a href="/cart">View cart</a>');
      })
      .catch(function () {
        form.submit(); // fall back to the normal form post
      })
      .then(function () {
        if (button) button.removeAttribute('aria-busy');
      });
  });

  // Cart quantity selects submit on change; the Update button is the no-JS fallback.
  document.addEventListener('change', function (event) {
    var target = event.target;
    if (target instanceof HTMLSelectElement && target.hasAttribute('data-autosubmit') && target.form) {
      target.form.submit();
    }
  });

  // Card number in groups of four, and MM/YY expiry, tidied when the field loses focus.
  document.addEventListener('focusout', function (event) {
    var input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    if (input.hasAttribute('data-card-number')) {
      var digits = input.value.replace(/\D/g, '').slice(0, 19);
      input.value = digits.replace(/(\d{4})(?=\d)/g, '$1 ');
    } else if (input.hasAttribute('data-card-expiry')) {
      var m = /^(\d{1,2})\D*(\d{2})$/.exec(input.value.trim());
      if (m) input.value = (m[1].length === 1 ? '0' + m[1] : m[1]) + '/' + m[2];
    }
  });

  // Release receipt: when a release router (Turnover) sits in front of the shop, it answers
  // /__turnover/receipt with which release this visitor is on and what happened to their latest event.
  // Without one the request 404s and the footer line stays hidden.
  var STATUS_TEXT = {
    accepted: 'accepted',
    rejected: 'rejected',
    batch_rejected: 'rejected (whole batch)',
    store_not_connected: 'not stored (no event store connected)',
    not_delivered: 'not delivered',
  };

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function clock(at) {
    var d = new Date(at);
    if (isNaN(d.getTime())) return '';
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function receiptText(data) {
    if (!data || typeof data !== 'object' || typeof data.variant !== 'string') return '';
    var release = typeof data.release === 'string' && data.release ? data.release : 'the default release';
    var text = data.enrolled
      ? "You're in " + data.variant + ' (' + release + ') of a release experiment.'
      : "You're on " + release + ' (not in a release experiment).';
    var r = data.receipt;
    if (!r || typeof r !== 'object') return text + ' No events recorded for you yet.';
    var status = Object.prototype.hasOwnProperty.call(STATUS_TEXT, r.status) ? STATUS_TEXT[r.status] : String(r.status);
    var what = typeof r.event === 'string' && r.event ? ' (' + r.event + ')' : '';
    var http = r.status !== 'accepted' && typeof r.httpStatus === 'number' && r.httpStatus > 0 ? ', HTTP ' + r.httpStatus : '';
    var time = clock(r.at);
    return text + ' Your latest event' + what + ': ' + status + http + (time ? ' at ' + time : '') + '.';
  }

  function showReceipt() {
    var el = document.querySelector('[data-release-receipt]');
    if (!el || !window.fetch) return;
    fetch('/__turnover/receipt', { credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then(function (res) {
        var type = res.headers.get('content-type') || '';
        if (res.status !== 200 || type.indexOf('json') === -1) return null;
        return res.json();
      })
      .then(function (data) {
        var text = data ? receiptText(data) : '';
        if (!text) return;
        el.textContent = 'Turnover: ' + text;
        el.hidden = false;
      })
      .catch(function () { /* no router in front: stay hidden */ });
  }
  showReceipt();

  // Move focus to the error summary so screen reader and keyboard users land on it.
  document.addEventListener('DOMContentLoaded', function () {
    var summary = document.querySelector('[data-error-summary]');
    if (summary) summary.focus();
  });
})();
