'use strict';
// Pocketful browser app. Plain DOM, no dependencies. Talks to the same JSON API the
// tests use, with the bearer token kept in localStorage so a session survives page
// loads and a state import that preserves the token.

(function () {
  const TOKEN_KEY = 'pocketful.token';

  // ---------------------------------------------------------------------------
  // State

  const S = {
    token: null,
    me: null,
    notice: null, // one-off message for the login screen
    // Latest-refresh-wins: every read gets a ticket; a response is applied only if
    // no later ticket for the same resource has been applied already.
    ticket: 0,
    applied: { me: 0, activity: 0, requests: 0, authorizations: 0 },
    activity: { status: 'idle', items: [] },
    requests: { status: 'idle', incoming: [], outgoing: [] },
    authorizations: { status: 'idle', items: [] },
    forms: {
      pay: blankMoneyForm(),
      request: blankMoneyForm(),
      authorize: blankMoneyForm(),
      split: { values: { amount: '', handles: '', note: '' }, key: null, sig: null, status: null, message: '', busy: false, result: null },
    },
    // Retry identity for list actions: one key per action+target+body, reused until it succeeds.
    actionKeys: new Map(),
    requestsMsg: null, // {kind: 'error'|'uncertain'|'success', text}
    authMsg: null,
  };
  try { S.token = window.localStorage.getItem(TOKEN_KEY); } catch (e) { S.token = null; }

  function blankMoneyForm() {
    return {
      values: { handle: '', amount: '', note: '', visibility: 'public' },
      key: null, sig: null, status: null, message: '', busy: false,
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    let value;
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'testid') el.setAttribute('data-testid', v);
        else if (k === 'value') value = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid instanceof Node ? kid : String(kid));
    }
    if (value !== undefined) el.value = value;
    return el;
  }

  function newKey() {
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  const units = () => (S.me ? S.me.minor_units : 2);
  const currency = () => (S.me ? S.me.currency : '');

  // Exactly `minor_units` decimals, a space, the currency code: 100.00 EUR, 1200 JPY.
  function formatNumber(minor) {
    const mu = units();
    const digits = String(Math.abs(minor));
    if (mu === 0) return digits;
    const padded = digits.padStart(mu + 1, '0');
    return padded.slice(0, -mu) + '.' + padded.slice(-mu);
  }
  const money = (minor) => formatNumber(minor) + ' ' + currency();

  // A decimal as a person types it -> integer minor units, or an error message.
  function parseDecimal(raw) {
    const text = String(raw == null ? '' : raw).trim();
    const mu = units();
    if (text === '') return { error: 'Enter an amount.' };
    const re = mu === 0 ? /^(\d+)$/ : new RegExp('^(\\d+)(?:\\.(\\d{1,' + mu + '}))?$');
    const m = re.exec(text);
    if (!m) {
      if (/^\d+\.\d+$/.test(text)) {
        return { error: mu === 0 ? 'Amounts in ' + currency() + ' have no decimal places.' : 'Use at most ' + mu + ' decimal places.' };
      }
      return { error: 'Enter an amount as a number, like ' + (mu === 0 ? '1200' : '15.' + '0'.repeat(mu)) + '.' };
    }
    const whole = m[1].replace(/^0+(?=\d)/, '');
    if (whole.length > 13) return { error: 'That amount is too large.' };
    const frac = (m[2] || '').padEnd(mu, '0');
    return { value: Number(whole) * Math.pow(10, mu) + (mu ? Number(frac) : 0) };
  }

  const dateFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  function when(iso) {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return iso;
    const diff = Date.now() - t;
    if (diff >= 0 && diff < 45 * 1000) return 'Just now';
    if (diff >= 0 && diff < 60 * 60 * 1000) return Math.round(diff / 60000) + ' min ago';
    return dateFmt.format(new Date(t));
  }
  function until(iso) {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return '';
    const diff = t - Date.now();
    if (diff <= 0) return 'expired ' + when(iso).toLowerCase();
    if (diff < 60 * 1000) return 'in under a minute';
    if (diff < 60 * 60 * 1000) return 'in ' + Math.round(diff / 60000) + ' min';
    if (diff < 24 * 60 * 60 * 1000) return 'in ' + Math.round(diff / 3600000) + ' h';
    return 'on ' + dateFmt.format(new Date(t));
  }

  function initial(name) {
    const ch = Array.from(String(name || '?').trim())[0] || '?';
    return ch.toUpperCase();
  }
  function avatar(handle) {
    let hash = 0;
    for (const c of String(handle)) hash = (hash * 31 + c.codePointAt(0)) >>> 0;
    return h('span', { class: 'avatar tone-' + (hash % 6), 'aria-hidden': 'true' }, initial(handle));
  }
  const handleEl = (handle) => h('span', { class: 'handle' }, handle);

  const FRIENDLY = {
    insufficient_funds: 'Not enough available funds for this.',
    not_found: 'We couldn’t find anyone with that handle.',
    self_payment: 'You can’t send money to yourself.',
    self_request: 'You can’t request money from yourself.',
    request_not_pending: 'This request is no longer pending.',
    authorization_not_open: 'This hold is no longer open.',
    authorization_expired: 'This hold has expired.',
    capture_exceeds_authorization: 'That is more than the amount still on hold.',
    forbidden: 'You’re not allowed to do that.',
    email_taken: 'An account with this email already exists.',
    handle_taken: 'The handle made from this email is already taken. Try a different email.',
    idempotency_key_reuse: 'This conflicts with an earlier submission. Change a field and try again.',
  };
  function friendly(r, overrides) {
    const code = r && r.code;
    if (overrides && overrides[code]) return overrides[code];
    if (FRIENDLY[code]) return FRIENDLY[code];
    if (code === 'validation_failed') return 'Please check the details: ' + (r.message || 'something is not valid') + '.';
    return (r && r.message) || 'Something went wrong. Please try again.';
  }

  // ---------------------------------------------------------------------------
  // API

  class Lost extends Error {}

  async function api(method, path, opts = {}) {
    const headers = { Accept: 'application/json' };
    if (S.token && !opts.anonymous) headers.Authorization = 'Bearer ' + S.token;
    if (opts.key) headers['Idempotency-Key'] = opts.key;
    let payload;
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(opts.body);
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeout || 15000);
    let res; let text;
    try {
      res = await fetch(path, { method, headers, body: payload, signal: ctl.signal, cache: 'no-store', credentials: 'omit' });
      text = await res.text();
    } catch (e) {
      throw new Lost('no response');
    } finally {
      clearTimeout(timer);
    }
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
    // A 5xx or an unreadable success body tells us nothing about the outcome.
    if (res.status >= 500 || (res.ok && text && data === null)) throw new Lost('unknown outcome');
    const err = data && data.error ? data.error : null;
    const r = { status: res.status, ok: res.ok, data, code: err && err.code, message: err && err.message };
    if (res.status === 401 && !opts.anonymous) {
      sessionEnded();
      r.ended = true;
    }
    return r;
  }

  function setToken(token) {
    S.token = token;
    try {
      if (token) window.localStorage.setItem(TOKEN_KEY, token);
      else window.localStorage.removeItem(TOKEN_KEY);
    } catch (e) { /* storage unavailable: session lasts for this page only */ }
  }

  function sessionEnded() {
    if (!S.token) return;
    setToken(null);
    S.me = null;
    S.notice = 'Your session has ended. Please log in again.';
    navigate('/login', { replace: true });
  }

  // ---------------------------------------------------------------------------
  // Data loading (latest refresh wins per resource)

  function accept(resource, ticket) {
    if (ticket < S.applied[resource]) return false;
    S.applied[resource] = ticket;
    return true;
  }

  async function loadMe(ticket = ++S.ticket) {
    const r = await api('GET', '/me');
    if (r.ok && accept('me', ticket)) {
      S.me = r.data;
      paintIdentity();
      paintWallet();
    }
    return r;
  }

  async function loadActivity(ticket = ++S.ticket) {
    if (S.activity.status !== 'ready') { S.activity.status = 'loading'; paintFeed(); }
    try {
      const r = await api('GET', '/activity?limit=100');
      if (!accept('activity', ticket)) return;
      if (r.ok) S.activity = { status: 'ready', items: r.data.payments };
      else if (!r.ended) S.activity = { status: 'error', items: S.activity.items };
    } catch (e) {
      if (accept('activity', ticket)) S.activity = { status: 'error', items: S.activity.items };
    }
    paintFeed();
  }

  // Balance and feed together; both reads share one ticket.
  async function refreshWallet() {
    const ticket = ++S.ticket;
    const btn = document.querySelector('[data-testid="wallet-refresh"]');
    if (btn) btn.classList.add('is-busy');
    try {
      await Promise.all([loadMe(ticket).catch(() => { markWalletError(ticket); }), loadActivity(ticket)]);
    } finally {
      const b = document.querySelector('[data-testid="wallet-refresh"]');
      if (b && ticket === S.ticket) b.classList.remove('is-busy');
    }
  }

  function markWalletError(ticket) {
    if (ticket < S.applied.me) return;
    const slot = document.getElementById('wallet-status');
    if (slot) slot.replaceChildren(h('p', { class: 'msg msg-uncertain', role: 'status' }, 'Couldn’t refresh your balance. Check your connection and try again.'));
  }

  async function loadRequests(ticket = ++S.ticket) {
    if (S.requests.status !== 'ready') { S.requests.status = 'loading'; paintRequests(); }
    try {
      const [inc, out] = await Promise.all([
        api('GET', '/requests?direction=incoming&limit=200'),
        api('GET', '/requests?direction=outgoing&limit=200'),
      ]);
      if (!accept('requests', ticket)) return;
      if (inc.ok && out.ok) S.requests = { status: 'ready', incoming: inc.data.requests, outgoing: out.data.requests };
      else if (!inc.ended && !out.ended) S.requests.status = 'error';
    } catch (e) {
      if (accept('requests', ticket)) S.requests.status = 'error';
    }
    paintRequests();
  }

  async function loadAuthorizations(ticket = ++S.ticket) {
    if (S.authorizations.status !== 'ready') { S.authorizations.status = 'loading'; paintAuthorizations(); }
    try {
      const r = await api('GET', '/authorizations?limit=200');
      if (!accept('authorizations', ticket)) return;
      if (r.ok) S.authorizations = { status: 'ready', items: r.data.authorizations };
      else if (!r.ended) S.authorizations.status = 'error';
    } catch (e) {
      if (accept('authorizations', ticket)) S.authorizations.status = 'error';
    }
    paintAuthorizations();
  }

  // ---------------------------------------------------------------------------
  // Routing

  const SCREENS = {
    '/': { title: 'Home', auth: true, build: homeScreen },
    '/requests': { title: 'Requests', auth: true, build: requestsScreen },
    '/split': { title: 'Split a bill', auth: true, build: splitScreen },
    '/authorizations': { title: 'Holds', auth: true, build: authorizationsScreen },
    '/login': { title: 'Log in', auth: false, build: loginScreen },
    '/signup': { title: 'Sign up', auth: false, build: signupScreen },
  };

  function navigate(path, opts = {}) {
    if (path !== window.location.pathname) {
      window.history[opts.replace ? 'replaceState' : 'pushState']({}, '', path);
    }
    render();
  }

  let renderToken = 0;
  async function render() {
    const mine = ++renderToken;
    const path = window.location.pathname;
    const screen = SCREENS[path] || SCREENS['/'];
    if (screen.auth && !S.token) {
      navigate('/login', { replace: true });
      return;
    }
    if (S.token && !S.me) {
      paintShell(h('div', { class: 'loading-screen', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Loading your wallet…'));
      try {
        const r = await loadMe();
        if (mine !== renderToken) return;
        if (!r.ok) {
          if (!S.token) return; // session ended -> already redirected
          paintShell(errorScreen('We couldn’t load your account.'));
          return;
        }
      } catch (e) {
        if (mine !== renderToken) return;
        paintShell(errorScreen('We couldn’t reach Pocketful. Check your connection.'));
        return;
      }
    }
    if (mine !== renderToken) return;
    document.title = screen.title + ' · Pocketful';
    paintShell(screen.build());
  }

  function errorScreen(text) {
    return h('section', { class: 'card center-card' },
      h('h1', { class: 'h2' }, 'Something went wrong'),
      h('p', { class: 'muted' }, text),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => render() }, 'Try again'));
  }

  // ---------------------------------------------------------------------------
  // Shell: header + main

  function paintShell(content) {
    const app = document.getElementById('app');
    app.replaceChildren(header(), h('main', { id: 'main', class: 'page', tabindex: '-1' }, content));
  }

  function navLink(path, label) {
    const active = window.location.pathname === path;
    return h('a', { href: path, 'data-link': true, class: 'nav-link' + (active ? ' is-active' : ''), 'aria-current': active ? 'page' : null }, label);
  }

  function header() {
    const signedIn = Boolean(S.token && S.me);
    return h('header', { class: 'topbar' },
      h('div', { class: 'topbar-inner' },
        h('a', { href: signedIn ? '/' : '/login', 'data-link': true, class: 'brand' }, h('span', { class: 'brand-mark', 'aria-hidden': 'true' }), 'Pocketful'),
        signedIn
          ? [
            h('nav', { class: 'nav', 'aria-label': 'Main' },
              navLink('/', 'Home'), navLink('/requests', 'Requests'), navLink('/split', 'Split'), navLink('/authorizations', 'Holds')),
            h('div', { class: 'who', id: 'who' }, identity()),
          ]
          : h('nav', { class: 'nav', 'aria-label': 'Account' }, navLink('/login', 'Log in'), navLink('/signup', 'Sign up'))));
  }

  function identity() {
    return [
      avatar(S.me.handle),
      h('span', { class: 'who-text' },
        h('span', { class: 'who-name', testid: 'current-user' }, S.me.display_name || S.me.handle),
        h('span', { class: 'who-handle handle', testid: 'current-handle' }, S.me.handle)),
      h('button', { class: 'btn btn-ghost btn-sm', type: 'button', testid: 'logout-button', onclick: logout }, 'Log out'),
    ];
  }

  function paintIdentity() {
    const slot = document.getElementById('who');
    if (slot && S.me) slot.replaceChildren(...identity());
  }

  function logout() {
    setToken(null);
    S.me = null;
    S.activity = { status: 'idle', items: [] };
    S.requests = { status: 'idle', incoming: [], outgoing: [] };
    S.authorizations = { status: 'idle', items: [] };
    S.forms.pay = blankMoneyForm();
    S.forms.request = blankMoneyForm();
    S.forms.authorize = blankMoneyForm();
    S.notice = 'You’re logged out.';
    navigate('/login');
  }

  // ---------------------------------------------------------------------------
  // Auth screens

  function authCard(kind) {
    const isSignup = kind === 'signup';
    const state = { busy: false };
    const field = (name, label, type, autocomplete, hint) => {
      const id = kind + '-' + name;
      return h('div', { class: 'field' },
        h('label', { for: id }, label),
        h('input', { id, name, type, testid: id, autocomplete, class: 'input', spellcheck: 'false' }),
        hint ? h('p', { class: 'hint' }, hint) : null);
    };
    const msgSlot = h('div', { class: 'msg-slot', 'aria-live': 'polite' });
    if (S.notice) {
      msgSlot.append(h('p', { class: 'msg msg-info', role: 'status' }, S.notice));
      S.notice = null;
    }
    const submit = h('button', { class: 'btn btn-primary btn-block', type: 'submit', testid: kind + '-submit' }, isSignup ? 'Create account' : 'Log in');
    const form = h('form', { class: 'stack', novalidate: true },
      isSignup ? field('display-name', 'Your name', 'text', 'name') : null,
      field('email', 'Email', 'email', 'email', isSignup ? 'Your handle is made from the part before the @.' : null),
      field('password', 'Password', 'password', isSignup ? 'new-password' : 'current-password', isSignup ? 'At least 8 characters.' : null),
      msgSlot,
      submit);
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (state.busy) return;
      const val = (n) => form.querySelector('[name="' + n + '"]').value;
      const body = isSignup
        ? { email: val('email').trim(), password: val('password'), display_name: val('display-name').trim() }
        : { email: val('email').trim(), password: val('password') };
      state.busy = true;
      submit.disabled = true;
      submit.textContent = isSignup ? 'Creating account…' : 'Logging in…';
      const showError = (text) => msgSlot.replaceChildren(h('p', { class: 'msg msg-error', role: 'alert', testid: 'auth-error' }, text));
      try {
        const r = await api('POST', isSignup ? '/auth/signup' : '/auth/login', { body, anonymous: true });
        if (r.ok) {
          setToken(r.data.token);
          S.me = null;
          navigate('/');
          return;
        }
        showError(r.status === 401 ? 'That email and password don’t match an account.' : friendly(r));
      } catch (e) {
        showError('We couldn’t reach Pocketful. Check your connection and try again.');
      } finally {
        state.busy = false;
        submit.disabled = false;
        submit.textContent = isSignup ? 'Create account' : 'Log in';
      }
    });
    return h('section', { class: 'auth-wrap' },
      h('div', { class: 'auth-intro' },
        h('h1', { class: 'h1' }, isSignup ? 'Create your Pocketful' : 'Welcome back'),
        h('p', { class: 'muted' }, isSignup
          ? 'Send money by handle, split bills and keep track of who owes what.'
          : 'Log in to see your balance, requests and activity.')),
      h('div', { class: 'card auth-card' }, form,
        h('p', { class: 'muted small center' }, isSignup ? 'Already have an account? ' : 'New to Pocketful? ',
          h('a', { href: isSignup ? '/login' : '/signup', 'data-link': true }, isSignup ? 'Log in' : 'Create an account'))));
  }
  function loginScreen() { return authCard('login'); }
  function signupScreen() { return authCard('signup'); }

  // ---------------------------------------------------------------------------
  // Home: wallet, money forms, activity

  function homeScreen() {
    const root = h('div', { class: 'home-grid' },
      h('section', { class: 'card wallet-card', 'aria-labelledby': 'wallet-title', id: 'wallet-card' }),
      moneyForm('pay'),
      moneyForm('request'),
      moneyForm('authorize'),
      h('section', { class: 'card feed-card', 'aria-labelledby': 'feed-title' },
        h('div', { class: 'card-head' }, h('h2', { class: 'h2', id: 'feed-title' }, 'Activity'),
          h('span', { class: 'muted small' }, 'Public payments and your own')),
        h('div', { id: 'feed-body' })));
    queueMicrotask(() => { paintWallet(); paintFeed(); refreshWallet(); });
    return root;
  }

  function paintWallet() {
    const card = document.getElementById('wallet-card');
    if (!card || !S.me) return;
    const me = S.me;
    const total = me.total !== undefined ? me.total : me.balance;
    const held = me.held || 0;
    const available = me.available !== undefined ? me.available : total;
    const refresh = h('button', { class: 'btn btn-ghost btn-sm refresh-btn', type: 'button', testid: 'wallet-refresh', onclick: () => refreshWallet() },
      h('span', { class: 'refresh-icon', 'aria-hidden': 'true' }), 'Refresh');
    card.replaceChildren(
      h('div', { class: 'card-head' }, h('h2', { class: 'eyebrow', id: 'wallet-title' }, 'Available to spend'), refresh),
      h('p', { class: 'headline-amount amount', testid: 'wallet-available', 'data-amount': available }, money(available)),
      h('dl', { class: 'wallet-meta' },
        h('div', null, h('dt', null, 'Total balance'), h('dd', null, h('span', { class: 'amount', testid: 'wallet-balance', 'data-amount': total }, money(total)))),
        held > 0
          ? h('div', { class: 'is-held' }, h('dt', null, h('span', { class: 'dot dot-held', 'aria-hidden': 'true' }), 'On hold'),
            h('dd', null, h('span', { class: 'amount', testid: 'wallet-held', 'data-amount': held }, money(held)),
              ' ', h('a', { href: '/authorizations', 'data-link': true, class: 'small' }, 'View holds')))
          : null),
      h('div', { id: 'wallet-status', 'aria-live': 'polite' }));
  }

  const FORM_COPY = {
    pay: {
      title: 'Send money', blurb: 'Moves money right away.', handleLabel: 'To', path: '/payments', submit: 'Send', busy: 'Sending…', visibility: true,
      success: (d) => 'Sent ' + money(d.amount) + ' to ' + d.to_handle + '.',
      errors: { insufficient_funds: 'You don’t have enough available to send this.' },
    },
    request: {
      title: 'Request money', blurb: 'They can pay or decline.', handleLabel: 'From', path: '/requests', submit: 'Request', busy: 'Requesting…', visibility: false,
      success: (d) => 'Asked ' + d.payer_handle + ' for ' + money(d.amount) + '.',
      errors: {},
    },
    authorize: {
      title: 'Hold money', blurb: 'Reserve money for someone to collect later.', handleLabel: 'For', path: '/authorizations', submit: 'Place hold', busy: 'Placing hold…', visibility: true,
      success: (d) => 'Holding ' + money(d.amount) + ' for ' + d.to_handle + ' until ' + dateFmt.format(new Date(Date.parse(d.expires_at))) + '.',
      errors: { insufficient_funds: 'You don’t have enough available to hold this amount.' },
    },
  };

  function moneyForm(kind) {
    const copy = FORM_COPY[kind];
    const f = S.forms[kind];
    const id = (name) => kind + '-' + name;
    const input = (name, label, attrs, adorn) => h('div', { class: 'field' + (name === 'amount' ? ' field-amount' : '') },
      h('label', { for: id(name) }, label),
      h('div', { class: 'input-wrap' + (adorn ? ' has-' + adorn.side : '') },
        adorn && adorn.side === 'pre' ? h('span', { class: 'adorn', 'aria-hidden': 'true' }, adorn.text) : null,
        h('input', Object.assign({
          id: id(name), name, class: 'input', testid: id(name), value: f.values[name], autocomplete: 'off', spellcheck: 'false',
          oninput: (e) => { f.values[name] = e.target.value; },
        }, attrs)),
        adorn && adorn.side === 'post' ? h('span', { class: 'adorn', 'aria-hidden': 'true' }, adorn.text) : null));
    const fields = [
      input('handle', copy.handleLabel, { placeholder: 'handle', autocapitalize: 'none' }, { side: 'pre', text: '@' }),
      input('amount', 'Amount', { inputmode: 'decimal', placeholder: units() === 0 ? '0' : '0.' + '0'.repeat(units()) }, { side: 'post', text: currency() }),
      input('note', 'Note (optional)', { placeholder: kind === 'request' ? 'What’s it for?' : 'Add a note', maxlength: null }),
    ];
    if (copy.visibility) {
      fields.push(h('div', { class: 'field' },
        h('label', { for: id('visibility') }, 'Who can see it'),
        h('select', {
          id: id('visibility'), name: 'visibility', class: 'input select', testid: id('visibility'), value: f.values.visibility,
          onchange: (e) => { f.values.visibility = e.target.value; },
        }, h('option', { value: 'public' }, 'Public — everyone'), h('option', { value: 'private' }, 'Private — just you two'))));
    }
    const submit = h('button', { class: 'btn btn-primary', type: 'submit', testid: id('submit') }, copy.submit);
    const form = h('form', { class: 'card money-form form-' + kind, novalidate: true, 'aria-labelledby': id('title') },
      h('div', { class: 'card-head' }, h('h2', { class: 'h2', id: id('title') }, copy.title), h('span', { class: 'muted small' }, copy.blurb)),
      h('div', { class: 'form-grid' }, fields),
      h('div', { class: 'form-foot' }, submit, h('div', { class: 'msg-slot', id: id('status'), 'aria-live': 'polite' })));
    form.addEventListener('submit', (ev) => { ev.preventDefault(); submitMoneyForm(kind); });
    queueMicrotask(() => paintFormStatus(kind));
    return form;
  }

  function paintFormStatus(kind) {
    const f = S.forms[kind];
    const slot = document.getElementById(kind + '-status');
    const btn = document.querySelector('[data-testid="' + kind + '-submit"]');
    if (btn) {
      btn.disabled = f.busy;
      btn.classList.toggle('is-busy', f.busy);
      btn.textContent = f.busy ? FORM_COPY[kind] ? FORM_COPY[kind].busy : 'Working…' : (FORM_COPY[kind] ? FORM_COPY[kind].submit : 'Split');
    }
    if (!slot) return;
    if (f.status === 'error') slot.replaceChildren(h('p', { class: 'msg msg-error', role: 'alert', testid: kind + '-error' }, f.message));
    else if (f.status === 'uncertain') slot.replaceChildren(h('p', { class: 'msg msg-uncertain', role: 'status', testid: kind + '-uncertain' }, f.message));
    else if (f.status === 'success') slot.replaceChildren(h('p', { class: 'msg msg-success', role: 'status', testid: kind + '-success' }, f.message));
    else slot.replaceChildren();
  }

  function setFormStatus(kind, status, message) {
    const f = S.forms[kind];
    f.status = status;
    f.message = message || '';
    paintFormStatus(kind);
  }

  async function submitMoneyForm(kind) {
    const f = S.forms[kind];
    const copy = FORM_COPY[kind];
    if (f.busy) return;
    const v = f.values;
    const handle = v.handle.trim();
    const parsed = parseDecimal(v.amount);
    if (parsed.error) return setFormStatus(kind, 'error', parsed.error);
    if (!handle) return setFormStatus(kind, 'error', 'Enter a handle.');
    const body = kind === 'request'
      ? { payer_handle: handle, amount: parsed.value, note: v.note }
      : { to_handle: handle, amount: parsed.value, note: v.note, visibility: v.visibility };
    // The same body keeps its idempotency key, so resubmitting an unchanged form (after a
    // success, a refusal or a lost response) can never move money twice. Any change to the
    // body starts a new payment with a new key.
    const sig = JSON.stringify(body);
    if (f.sig !== sig || !f.key) {
      f.sig = sig;
      f.key = newKey();
    }
    f.busy = true;
    paintFormStatus(kind);
    try {
      const r = await api('POST', copy.path, { body, key: f.key });
      if (r.ended) return;
      if (r.ok) {
        f.status = 'success';
        f.message = copy.success(r.data);
      } else {
        f.status = 'error';
        f.message = friendly(r, copy.errors);
      }
    } catch (e) {
      f.status = 'uncertain';
      f.message = kind === 'pay'
        ? 'We couldn’t confirm this payment — it may or may not have gone through. Press Send again to check; you won’t be charged twice.'
        : 'We couldn’t confirm this. Submit again to check; it won’t be duplicated.';
    } finally {
      f.busy = false;
      paintFormStatus(kind);
    }
    if (kind !== 'request') refreshWallet();
  }

  function paintFeed() {
    const body = document.getElementById('feed-body');
    if (!body) return;
    const a = S.activity;
    if ((a.status === 'loading' || a.status === 'idle') && !a.items.length) {
      body.replaceChildren(h('div', { class: 'placeholder', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Loading activity…'));
      return;
    }
    const notes = [];
    if (a.status === 'error') {
      notes.push(h('p', { class: 'msg msg-uncertain', role: 'status' }, 'Couldn’t refresh activity. ',
        h('button', { class: 'link-btn', type: 'button', onclick: () => refreshWallet() }, 'Try again')));
    }
    if (!a.items.length) {
      body.replaceChildren(...notes, h('div', { class: 'empty', testid: 'empty-activity' },
        h('span', { class: 'empty-icon', 'aria-hidden': 'true' }),
        h('p', { class: 'empty-title' }, 'No activity yet'),
        h('p', { class: 'muted small' }, 'Payments you send or receive, and public payments, show up here.')));
      return;
    }
    body.replaceChildren(...notes, h('ul', { class: 'feed', testid: 'activity-list' }, a.items.map(feedItem)));
  }

  function feedItem(p) {
    const me = S.me ? S.me.user_id : null;
    const out = p.from_user_id === me;
    const inc = p.to_user_id === me;
    const dir = out ? 'out' : inc ? 'in' : 'other';
    const counterpart = out ? p.to_handle : p.from_handle;
    const tags = [];
    if (p.request_id) tags.push('Request');
    if (p.settlement_id) tags.push('Settlement');
    if (p.authorization_id) tags.push('Hold collected');
    return h('li', { class: 'feed-item dir-' + dir, testid: 'activity-item-' + p.payment_id, 'data-visibility': p.visibility },
      avatar(counterpart),
      h('div', { class: 'feed-main' },
        h('p', { class: 'feed-parties', testid: 'activity-parties-' + p.payment_id }, handleEl(p.from_handle), ' paid ', handleEl(p.to_handle)),
        h('p', { class: 'feed-note', testid: 'activity-note-' + p.payment_id }, p.note),
        h('p', { class: 'feed-meta' },
          h('time', { datetime: p.created_at, title: p.created_at }, when(p.created_at)),
          h('span', { class: 'chip chip-' + p.visibility }, p.visibility === 'private' ? 'Private' : 'Public'),
          tags.map((t) => h('span', { class: 'chip' }, t)))),
      h('div', { class: 'feed-amount' },
        h('span', { class: 'sr-only' }, out ? 'You sent ' : inc ? 'You received ' : ''),
        h('span', { class: 'sign', 'aria-hidden': 'true' }, out ? '−' : inc ? '+' : ''),
        h('span', { class: 'amount', testid: 'activity-amount-' + p.payment_id }, money(p.amount))));
  }

  // ---------------------------------------------------------------------------
  // Requests

  function requestsScreen() {
    const root = h('div', { class: 'stack-lg' },
      h('div', { class: 'page-head' },
        h('div', null, h('h1', { class: 'h1' }, 'Requests'), h('p', { class: 'muted' }, 'Money people have asked you for, and money you’ve asked for.')),
        h('a', { href: '/', 'data-link': true, class: 'btn btn-secondary' }, 'New request')),
      h('div', { id: 'requests-msg', 'aria-live': 'polite' }),
      h('div', { id: 'requests-empty' }),
      h('div', { class: 'two-col' },
        h('section', { class: 'card', 'aria-labelledby': 'incoming-title' },
          h('div', { class: 'card-head' }, h('h2', { class: 'h2', id: 'incoming-title' }, 'Waiting on you'), h('span', { class: 'count', id: 'incoming-count' })),
          h('div', { id: 'incoming-note' }),
          h('ul', { class: 'req-list', testid: 'incoming-list', id: 'incoming-list' })),
        h('section', { class: 'card', 'aria-labelledby': 'outgoing-title' },
          h('div', { class: 'card-head' }, h('h2', { class: 'h2', id: 'outgoing-title' }, 'You asked'), h('span', { class: 'count', id: 'outgoing-count' })),
          h('div', { id: 'outgoing-note' }),
          h('ul', { class: 'req-list', testid: 'outgoing-list', id: 'outgoing-list' }))));
    S.requestsMsg = null;
    queueMicrotask(() => { paintRequests(); loadRequests(); });
    return root;
  }

  const STATUS_LABEL = { pending: 'Pending', paid: 'Paid', declined: 'Declined', cancelled: 'Cancelled', open: 'On hold', captured: 'Collected', voided: 'Released', expired: 'Expired' };

  function paintRequests() {
    const inc = document.getElementById('incoming-list');
    const out = document.getElementById('outgoing-list');
    if (!inc || !out) return;
    const r = S.requests;
    const msg = document.getElementById('requests-msg');
    const m = S.requestsMsg;
    msg.replaceChildren(m ? h('p', {
      class: 'msg msg-' + m.kind, role: m.kind === 'error' ? 'alert' : 'status',
      testid: m.kind === 'error' ? 'request-error' : m.kind === 'uncertain' ? 'request-uncertain' : 'request-success',
    }, m.text) : '');
    const loading = r.status === 'loading' || r.status === 'idle';
    const noteFor = (list) => {
      if (loading && !list.length) return h('div', { class: 'placeholder', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Loading…');
      if (r.status === 'error') return h('p', { class: 'msg msg-uncertain' }, 'Couldn’t refresh. ', h('button', { class: 'link-btn', type: 'button', onclick: () => loadRequests() }, 'Try again'));
      if (!list.length) return h('p', { class: 'muted small list-empty' }, 'Nothing here.');
      return '';
    };
    document.getElementById('incoming-note').replaceChildren(noteFor(r.incoming));
    document.getElementById('outgoing-note').replaceChildren(noteFor(r.outgoing));
    const pendingIn = r.incoming.filter((x) => x.status === 'pending').length;
    const pendingOut = r.outgoing.filter((x) => x.status === 'pending').length;
    document.getElementById('incoming-count').textContent = pendingIn ? pendingIn + ' pending' : '';
    document.getElementById('outgoing-count').textContent = pendingOut ? pendingOut + ' pending' : '';
    inc.replaceChildren(...r.incoming.map((x) => requestItem(x, 'in')));
    out.replaceChildren(...r.outgoing.map((x) => requestItem(x, 'out')));
    const empty = document.getElementById('requests-empty');
    empty.replaceChildren(r.status === 'ready' && !r.incoming.length && !r.outgoing.length
      ? h('div', { class: 'card empty', testid: 'empty-requests' },
        h('span', { class: 'empty-icon', 'aria-hidden': 'true' }),
        h('p', { class: 'empty-title' }, 'No requests yet'),
        h('p', { class: 'muted small' }, 'Request money from Home, or split a bill to ask several people at once.'))
      : '');
  }

  function requestItem(q, dir) {
    const pending = q.status === 'pending';
    const other = dir === 'in' ? q.requester_handle : q.payer_handle;
    const actions = [];
    if (pending && dir === 'in') {
      const visId = 'request-visibility-' + q.request_id;
      actions.push(
        h('label', { class: 'sr-only', for: visId }, 'Who can see this payment'),
        h('select', { id: visId, class: 'input select select-sm', testid: visId },
          h('option', { value: 'public' }, 'Public'), h('option', { value: 'private' }, 'Private')),
        h('button', { class: 'btn btn-primary btn-sm', type: 'button', testid: 'request-pay-' + q.request_id, onclick: (e) => payRequest(q, e.currentTarget) }, 'Pay'),
        h('button', { class: 'btn btn-secondary btn-sm', type: 'button', testid: 'request-decline-' + q.request_id, onclick: (e) => resolveRequest(q, 'decline', e.currentTarget) }, 'Decline'));
    }
    if (pending && dir === 'out') {
      actions.push(h('button', { class: 'btn btn-secondary btn-sm', type: 'button', testid: 'request-cancel-' + q.request_id, onclick: (e) => resolveRequest(q, 'cancel', e.currentTarget) }, 'Cancel request'));
    }
    return h('li', { class: 'req-item status-' + q.status, testid: 'request-item-' + q.request_id, 'data-status': q.status },
      avatar(other),
      h('div', { class: 'req-main' },
        h('p', { class: 'req-title' }, dir === 'in' ? [handleEl(other), ' asked you'] : ['You asked ', handleEl(other)]),
        q.note ? h('p', { class: 'req-note' }, q.note) : null,
        h('p', { class: 'feed-meta' }, h('time', { datetime: q.created_at, title: q.created_at }, when(q.created_at)),
          h('span', { class: 'chip chip-status chip-' + q.status }, STATUS_LABEL[q.status] || q.status))),
      h('div', { class: 'req-side' },
        h('span', { class: 'amount req-amount', testid: 'request-amount-' + q.request_id }, money(q.amount)),
        actions.length ? h('div', { class: 'req-actions' }, actions) : null));
  }

  function actionKey(id, sig) {
    const k = id + '|' + sig;
    if (!S.actionKeys.has(k)) S.actionKeys.set(k, newKey());
    return S.actionKeys.get(k);
  }

  function setRequestsMsg(kind, text) {
    S.requestsMsg = kind ? { kind, text } : null;
    paintRequests();
  }

  async function payRequest(q, btn) {
    const sel = document.querySelector('[data-testid="request-visibility-' + q.request_id + '"]');
    const visibility = sel ? sel.value : 'public';
    const body = { visibility };
    const key = actionKey('pay:' + q.request_id, JSON.stringify(body));
    if (btn) { btn.disabled = true; btn.textContent = 'Paying…'; }
    try {
      const r = await api('POST', '/requests/' + encodeURIComponent(q.request_id) + '/pay', { body, key });
      if (r.ended) return;
      if (r.ok) setRequestsMsg('success', 'Paid ' + money(r.data.amount) + ' to ' + r.data.to_handle + '.');
      else setRequestsMsg('error', friendly(r, { insufficient_funds: 'You don’t have enough available to pay this request.' }));
    } catch (e) {
      setRequestsMsg('uncertain', 'We couldn’t confirm this payment. Press Pay again to check; you won’t pay twice.');
      if (btn) { btn.disabled = false; btn.textContent = 'Pay'; }
    }
    loadRequests();
  }

  async function resolveRequest(q, action, btn) {
    if (btn) btn.disabled = true;
    try {
      const r = await api('POST', '/requests/' + encodeURIComponent(q.request_id) + '/' + action);
      if (r.ended) return;
      if (r.ok) setRequestsMsg('success', action === 'decline' ? 'Request declined.' : 'Request cancelled.');
      else setRequestsMsg('error', friendly(r));
    } catch (e) {
      setRequestsMsg('uncertain', 'We couldn’t confirm that. Please try again.');
      if (btn) btn.disabled = false;
    }
    loadRequests();
  }

  // ---------------------------------------------------------------------------
  // Split

  function splitHandles(text) {
    return String(text).split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  }

  function equalSplit(amount, n) {
    const base = Math.floor(amount / n);
    const rem = amount - base * n;
    return Array.from({ length: n }, (_, i) => base + (i < rem ? 1 : 0));
  }

  function splitScreen() {
    const f = S.forms.split;
    const input = (name, label, attrs, hint) => h('div', { class: 'field' },
      h('label', { for: 'split-' + name }, label),
      h('input', Object.assign({
        id: 'split-' + name, name, class: 'input', testid: 'split-' + name, value: f.values[name], autocomplete: 'off', spellcheck: 'false',
        oninput: (e) => { f.values[name] = e.target.value; paintPreview(); },
      }, attrs)),
      hint ? h('p', { class: 'hint' }, hint) : null);
    const submit = h('button', { class: 'btn btn-primary', type: 'submit', testid: 'split-submit' }, 'Send requests');
    const form = h('form', { class: 'card stack', novalidate: true, 'aria-labelledby': 'split-title' },
      h('div', { class: 'card-head' }, h('h2', { class: 'h2', id: 'split-title' }, 'Bill details')),
      input('amount', 'Total amount (' + currency() + ')', { inputmode: 'decimal', placeholder: units() === 0 ? '0' : '0.' + '0'.repeat(units()) }),
      input('handles', 'Who’s splitting', { placeholder: S.me.handle + ', bob, cy', autocapitalize: 'none' },
        'Handles separated by commas, in order. Include yourself to take a share; you won’t be asked to pay it.'),
      input('note', 'Note (optional)', { placeholder: 'Dinner, tickets…' }),
      h('div', { class: 'form-foot' }, submit, h('div', { class: 'msg-slot', id: 'split-status', 'aria-live': 'polite' })));
    form.addEventListener('submit', (ev) => { ev.preventDefault(); submitSplit(); });
    const root = h('div', { class: 'stack-lg' },
      h('div', { class: 'page-head' }, h('div', null, h('h1', { class: 'h1' }, 'Split a bill'),
        h('p', { class: 'muted' }, 'You paid; everyone else gets a request for their share. Shares differ by at most one cent and the extra goes to the first people listed.'))),
      h('div', { class: 'two-col' }, form,
        h('section', { class: 'card', 'aria-labelledby': 'preview-title' },
          h('div', { class: 'card-head' }, h('h2', { class: 'h2', id: 'preview-title' }, 'Shares')),
          h('div', { id: 'preview-body', 'aria-live': 'polite' }))));
    queueMicrotask(() => { paintPreview(); paintSplitStatus(); });
    return root;
  }

  function paintPreview() {
    const body = document.getElementById('preview-body');
    if (!body) return;
    const f = S.forms.split;
    const parsed = parseDecimal(f.values.amount);
    const handles = splitHandles(f.values.handles);
    if (parsed.error || !handles.length) {
      body.replaceChildren(h('p', { class: 'muted small' }, 'Enter an amount and at least one handle to see each share.'));
      return;
    }
    const shares = equalSplit(parsed.value, handles.length);
    const dupes = new Set(handles).size !== handles.length;
    const seen = new Set();
    body.replaceChildren(
      dupes ? h('p', { class: 'msg msg-uncertain' }, 'Each person can appear only once.') : null,
      h('ul', { class: 'share-list', testid: 'split-preview' }, handles.map((hd, i) => {
        const first = !seen.has(hd);
        seen.add(hd);
        return h('li', { class: 'share-row' }, avatar(hd),
          h('span', { class: 'share-who' }, handleEl(hd), hd === S.me.handle ? h('span', { class: 'chip' }, 'You') : null),
          h('span', { class: 'amount', testid: first ? 'split-share-' + hd : null }, money(shares[i])));
      })),
      h('p', { class: 'muted small' }, 'Total ', h('span', { class: 'amount' }, money(parsed.value))));
  }

  function paintSplitStatus() {
    const f = S.forms.split;
    const slot = document.getElementById('split-status');
    const btn = document.querySelector('[data-testid="split-submit"]');
    if (btn) {
      btn.disabled = f.busy;
      btn.textContent = f.busy ? 'Sending…' : 'Send requests';
    }
    if (!slot) return;
    if (f.status === 'error') slot.replaceChildren(h('p', { class: 'msg msg-error', role: 'alert', testid: 'split-error' }, f.message));
    else if (f.status === 'uncertain') slot.replaceChildren(h('p', { class: 'msg msg-uncertain', role: 'status', testid: 'split-uncertain' }, f.message));
    else if (f.status === 'success') {
      slot.replaceChildren(h('p', { class: 'msg msg-success', role: 'status', testid: 'split-success' }, f.message, ' ',
        h('a', { href: '/requests', 'data-link': true }, 'See requests')));
    } else slot.replaceChildren();
  }

  async function submitSplit() {
    const f = S.forms.split;
    if (f.busy) return;
    const parsed = parseDecimal(f.values.amount);
    const handles = splitHandles(f.values.handles);
    const fail = (m) => { f.status = 'error'; f.message = m; paintSplitStatus(); };
    if (parsed.error) return fail(parsed.error);
    if (!handles.length) return fail('Add at least one handle.');
    const body = { amount: parsed.value, participant_handles: handles, note: f.values.note };
    const sig = JSON.stringify(body);
    if (f.sig !== sig || !f.key) { f.sig = sig; f.key = newKey(); }
    f.busy = true;
    paintSplitStatus();
    try {
      const r = await api('POST', '/splits', { body, key: f.key });
      if (r.ended) return;
      if (r.ok) {
        const n = r.data.requests.length;
        f.status = 'success';
        f.message = n ? 'Split ' + money(r.data.amount) + ' — sent ' + n + (n === 1 ? ' request.' : ' requests.') : 'Split saved. Nobody else needed a request.';
      } else {
        f.status = 'error';
        f.message = friendly(r, {
          not_found: 'One of those handles doesn’t belong to anyone.',
          validation_failed: handles.length !== new Set(handles).size ? 'Each person can appear only once.' : 'Please check the details: ' + (r.message || '') + '.',
        });
      }
    } catch (e) {
      f.status = 'uncertain';
      f.message = 'We couldn’t confirm the split. Submit again to check; requests won’t be duplicated.';
    } finally {
      f.busy = false;
      paintSplitStatus();
    }
  }

  // ---------------------------------------------------------------------------
  // Authorizations

  function authorizationsScreen() {
    const root = h('div', { class: 'stack-lg' },
      h('div', { class: 'page-head' },
        h('div', null, h('h1', { class: 'h1' }, 'Holds'),
          h('p', { class: 'muted' }, 'Money reserved now and collected later. Held money stays in the payer’s total but can’t be spent.')),
        h('a', { href: '/', 'data-link': true, class: 'btn btn-secondary' }, 'Place a hold')),
      h('div', { id: 'auth-msg', 'aria-live': 'polite' }),
      h('section', { class: 'card', 'aria-labelledby': 'auth-title' },
        h('div', { class: 'card-head' }, h('h2', { class: 'h2', id: 'auth-title' }, 'All holds'),
          h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => loadAuthorizations() }, h('span', { class: 'refresh-icon', 'aria-hidden': 'true' }), 'Refresh')),
        h('div', { id: 'auth-note' }),
        h('ul', { class: 'req-list', testid: 'authorization-list', id: 'authorization-list' })));
    S.authMsg = null;
    queueMicrotask(() => { paintAuthorizations(); loadAuthorizations(); });
    return root;
  }

  function setAuthMsg(kind, text) {
    S.authMsg = kind ? { kind, text } : null;
    paintAuthorizations();
  }

  function paintAuthorizations() {
    const list = document.getElementById('authorization-list');
    if (!list) return;
    const a = S.authorizations;
    const m = S.authMsg;
    document.getElementById('auth-msg').replaceChildren(m ? h('p', {
      class: 'msg msg-' + m.kind, role: m.kind === 'error' ? 'alert' : 'status',
      testid: m.kind === 'error' ? 'authorization-error' : m.kind === 'uncertain' ? 'authorization-uncertain' : 'authorization-success',
    }, m.text) : '');
    const note = document.getElementById('auth-note');
    if ((a.status === 'loading' || a.status === 'idle') && !a.items.length) {
      note.replaceChildren(h('div', { class: 'placeholder', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Loading holds…'));
    } else if (a.status === 'error') {
      note.replaceChildren(h('p', { class: 'msg msg-uncertain' }, 'Couldn’t refresh holds. ', h('button', { class: 'link-btn', type: 'button', onclick: () => loadAuthorizations() }, 'Try again')));
    } else if (!a.items.length) {
      note.replaceChildren(h('div', { class: 'empty', testid: 'empty-authorizations' },
        h('span', { class: 'empty-icon', 'aria-hidden': 'true' }),
        h('p', { class: 'empty-title' }, 'No holds'),
        h('p', { class: 'muted small' }, 'Place a hold from Home to reserve money for someone to collect later.')));
    } else note.replaceChildren();
    list.replaceChildren(...a.items.map(authItem));
  }

  function authItem(a) {
    const me = S.me.user_id;
    const out = a.from_user_id === me;
    const other = out ? a.to_handle : a.from_handle;
    const open = a.status === 'open';
    const remaining = a.remaining_amount !== undefined ? a.remaining_amount : Math.max(0, a.amount - a.captured_amount);
    const actions = [];
    if (open && !out) {
      const inputId = 'authorization-capture-amount-' + a.authorization_id;
      const finalId = 'authorization-final-' + a.authorization_id;
      actions.push(h('div', { class: 'capture-row' },
        h('div', { class: 'field field-inline' },
          h('label', { for: inputId }, 'Collect'),
          h('div', { class: 'input-wrap has-post' },
            h('input', { id: inputId, class: 'input input-sm', testid: inputId, inputmode: 'decimal', autocomplete: 'off', value: formatNumber(remaining) }),
            h('span', { class: 'adorn', 'aria-hidden': 'true' }, currency()))),
        h('label', { class: 'check', for: finalId },
          h('input', { type: 'checkbox', id: finalId, testid: finalId, checked: true }), 'Release the rest'),
        h('button', { class: 'btn btn-primary btn-sm', type: 'button', testid: 'authorization-capture-' + a.authorization_id, onclick: (e) => captureAuth(a, e.currentTarget) }, 'Collect')));
    }
    if (open && out) {
      actions.push(h('button', { class: 'btn btn-secondary btn-sm', type: 'button', testid: 'authorization-void-' + a.authorization_id, onclick: (e) => voidAuth(a, e.currentTarget) }, 'Release hold'));
    }
    return h('li', { class: 'req-item auth-item status-' + a.status, testid: 'authorization-item-' + a.authorization_id, 'data-status': a.status },
      avatar(other),
      h('div', { class: 'req-main' },
        h('p', { class: 'req-title' }, out ? ['You’re holding for ', handleEl(other)] : [handleEl(other), ' is holding for you']),
        a.note ? h('p', { class: 'req-note' }, a.note) : null,
        h('p', { class: 'feed-meta' },
          h('span', { class: 'chip chip-status chip-' + a.status }, STATUS_LABEL[a.status] || a.status),
          h('span', { class: 'chip chip-' + a.visibility }, a.visibility === 'private' ? 'Private' : 'Public'),
          h('span', null, open ? 'Expires ' : a.status === 'expired' ? 'Expired ' : 'Expiry ', h('time', { class: 'mono', datetime: a.expires_at, testid: 'authorization-expires-' + a.authorization_id }, a.expires_at),
            open ? h('span', { class: 'muted' }, ' (' + until(a.expires_at) + ')') : null)),
        a.captured_amount > 0 && a.status !== 'captured'
          ? h('p', { class: 'small muted' }, 'Collected so far ', h('span', { class: 'amount' }, money(a.captured_amount)), open ? [' · ', h('span', { class: 'amount' }, money(remaining)), ' still held'] : '')
          : null),
      h('div', { class: 'req-side' },
        h('span', { class: 'amount req-amount', testid: 'authorization-amount-' + a.authorization_id }, money(a.amount)),
        a.status === 'captured'
          ? h('span', { class: 'small captured' }, 'Collected ', h('span', { class: 'amount', testid: 'authorization-captured-' + a.authorization_id }, money(a.captured_amount)))
          : null,
        actions.length ? h('div', { class: 'req-actions' }, actions) : null));
  }

  async function captureAuth(a, btn) {
    const input = document.querySelector('[data-testid="authorization-capture-amount-' + a.authorization_id + '"]');
    const finalBox = document.querySelector('[data-testid="authorization-final-' + a.authorization_id + '"]');
    const parsed = parseDecimal(input ? input.value : '');
    if (parsed.error) return setAuthMsg('error', parsed.error);
    const body = { amount: parsed.value };
    if (finalBox && !finalBox.checked) body.final = false;
    const key = actionKey('capture:' + a.authorization_id, JSON.stringify(body));
    if (btn) { btn.disabled = true; btn.textContent = 'Collecting…'; }
    try {
      const r = await api('POST', '/authorizations/' + encodeURIComponent(a.authorization_id) + '/capture', { body, key });
      if (r.ended) return;
      if (r.ok) setAuthMsg('success', 'Collected ' + money(r.data.amount) + ' from ' + r.data.from_handle + '.');
      else setAuthMsg('error', friendly(r));
    } catch (e) {
      setAuthMsg('uncertain', 'We couldn’t confirm the collection. Press Collect again to check; it won’t happen twice.');
    }
    loadAuthorizations();
  }

  async function voidAuth(a, btn) {
    if (btn) btn.disabled = true;
    try {
      const r = await api('POST', '/authorizations/' + encodeURIComponent(a.authorization_id) + '/void');
      if (r.ended) return;
      if (r.ok) setAuthMsg('success', 'Hold released. ' + money(a.remaining_amount || 0) + ' is available again.');
      else setAuthMsg('error', friendly(r));
    } catch (e) {
      setAuthMsg('uncertain', 'We couldn’t confirm the release. Please try again.');
    }
    loadAuthorizations();
  }

  // ---------------------------------------------------------------------------
  // Boot

  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[data-link]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(a.getAttribute('href'));
  });
  window.addEventListener('popstate', () => render());
  render();
})();
