#!/usr/bin/env python3
"""Independent browser checks for pocketful stage 2 (spec stage-2.md), black-box via the
UI's data-testid contract. usage: python ui_checks.py BASE_URL [--out report.json]
Needs playwright + httpx (the harness venv)."""
import json, os, re, sys, time, uuid
import httpx
from playwright.sync_api import sync_playwright

BASE = sys.argv[1].rstrip('/')
OUT = sys.argv[sys.argv.index('--out') + 1] if '--out' in sys.argv else None
PW = 'correct horse'
results = []
api = httpx.Client(base_url=BASE, timeout=10)


def fixture(currency='EUR', mu=2, auths=None, extra_users=(), payments=None, requests=None):
    users = [
        {'id': 'u_ada', 'email': 'ada@example.com', 'password': PW, 'display_name': 'Ada Lovelace', 'handle': 'ada', 'balance': 10000},
        {'id': 'u_bob', 'email': 'bob@example.com', 'password': PW, 'display_name': 'Bob', 'handle': 'bob', 'balance': 2500},
        {'id': 'u_cy', 'email': 'cy@example.com', 'password': PW, 'display_name': 'Cy', 'handle': 'cy', 'balance': 500},
        *extra_users,
    ]
    f = {'currency': currency, 'minor_units': mu, 'users': users,
         'payments': payments if payments is not None else [], 'requests': requests if requests is not None else []}
    if auths is not None:
        f['authorizations'] = auths
    return f


def reset(f):
    r = api.post('/_test/reset', json=f)
    assert r.status_code == 204, r.text


def token(email):
    return api.post('/auth/login', json={'email': email, 'password': PW}).json()['token']


def me(email):
    return api.get('/me', headers={'Authorization': 'Bearer ' + token(email)}).json()


def iso(sec):
    return time.strftime('%Y-%m-%dT%H:%M:%S+00:00', time.gmtime(time.time() + sec))


class Check:
    def __init__(self, name, reqs):
        self.name, self.reqs, self.fails = name, reqs, []

    def ok(self, cond, label):
        if not cond:
            self.fails.append(label)

    def eq(self, a, b, label):
        if a != b:
            self.fails.append(f'{label}: expected {b!r}, got {a!r}')


def run(name, reqs):
    def deco(fn):
        c = Check(name, reqs)
        try:
            fn(c)
        except Exception as e:  # noqa: BLE001
            c.fails.append(f'exception: {type(e).__name__}: {str(e)[:400]}')
        results.append({'id': name, 'requirements': reqs, 'passed': not c.fails, 'failures': c.fails})
        print(('ok   ' if not c.fails else 'FAIL ') + name + ('' if not c.fails else '\n      ' + '\n      '.join(c.fails)), flush=True)
        if c.fails and os.environ.get('VF_FAIL_FAST'):
            print('ui: failing fast (VF_FAIL_FAST)', flush=True)
            os._exit(1)
        return fn
    return deco


pw = sync_playwright().start()
browser = pw.chromium.launch()


def new_page(width=1280):
    ctx = browser.new_context(viewport={'width': width, 'height': 900})
    page = ctx.new_page()
    page.set_default_timeout(int(os.environ.get('VF_UI_TIMEOUT_MS', '6000')))
    external = []
    page.on('request', lambda r: external.append(r.url) if not r.url.startswith(BASE) and not r.url.startswith('data:') and not r.url.startswith('blob:') else None)
    page.external = external
    return page


def login(page, email='ada@example.com'):
    page.goto(BASE + '/login')
    page.get_by_test_id('login-email').fill(email)
    page.get_by_test_id('login-password').fill(PW)
    page.get_by_test_id('login-submit').click()
    page.get_by_test_id('current-user').wait_for()


def tid(page, t):
    return page.get_by_test_id(t)


@run('auth-screens-identity-navigation', ['R2-17', 'R2-18'])
def _(c):
    reset(fixture())
    p = new_page()
    p.goto(BASE + '/login')
    tid(p, 'login-email').fill('ada@example.com')
    tid(p, 'login-password').fill('wrong password')
    c.eq(tid(p, 'auth-error').count(), 0, 'auth-error absent before an error')
    tid(p, 'login-submit').click()
    tid(p, 'auth-error').wait_for()
    c.ok(tid(p, 'auth-error').inner_text().strip() != '', 'auth-error text on wrong password')
    tid(p, 'login-password').fill(PW)
    tid(p, 'login-submit').click()
    tid(p, 'current-user').wait_for()
    for route in ['/', '/requests', '/split', '/authorizations']:
        p.goto(BASE + route)
        tid(p, 'current-user').wait_for()
        c.ok('Ada Lovelace' in tid(p, 'current-user').inner_text(), f'current-user has display name on {route}')
        c.eq(tid(p, 'current-handle').inner_text().strip(), 'ada', f'current-handle exact on {route}')
        c.eq(tid(p, 'logout-button').count(), 1, f'logout on {route}')
    tid(p, 'logout-button').click()
    p.wait_for_timeout(300)
    p.goto(BASE + '/')
    p.wait_for_timeout(500)
    c.eq(tid(p, 'current-user').count(), 0, 'signed out after logout')
    p.goto(BASE + '/signup')
    tid(p, 'signup-email').fill('Zed.Q@example.com')
    tid(p, 'signup-password').fill('longenough')
    tid(p, 'signup-display-name').fill('Zed Q')
    tid(p, 'signup-submit').click()
    tid(p, 'current-handle').wait_for()
    c.eq(tid(p, 'current-handle').inner_text().strip(), 'zed_q', 'derived handle after signup')
    p.goto(BASE + '/signup')
    tid(p, 'signup-email').fill('ada@example.com')
    tid(p, 'signup-password').fill('longenough')
    tid(p, 'signup-display-name').fill('Dup')
    tid(p, 'signup-submit').click()
    tid(p, 'auth-error').wait_for()
    c.eq(p.external, [], 'no external requests')


@run('wallet-format-headline-held', ['R2-19', 'R2-20', 'R2-26'])
def _(c):
    reset(fixture(auths=[{'id': 'a_1', 'from_user_id': 'u_ada', 'to_user_id': 'u_bob', 'amount': 2000, 'note': 'deposit',
                          'visibility': 'public', 'status': 'open', 'expires_at': iso(7200)}]))
    p = new_page()
    login(p)
    p.goto(BASE + '/')
    tid(p, 'wallet-available').wait_for()
    c.eq(tid(p, 'wallet-balance').inner_text().strip(), '100.00 EUR', 'wallet-balance = formatted total')
    c.eq(tid(p, 'wallet-balance').get_attribute('data-amount'), '10000', 'balance data-amount')
    c.eq(tid(p, 'wallet-available').inner_text().strip(), '80.00 EUR', 'available formatted')
    c.eq(tid(p, 'wallet-available').get_attribute('data-amount'), '8000', 'available data-amount')
    c.eq(tid(p, 'wallet-held').inner_text().strip(), '20.00 EUR', 'held formatted')
    fa = float(tid(p, 'wallet-available').evaluate('e => parseFloat(getComputedStyle(e).fontSize)'))
    fb = float(tid(p, 'wallet-balance').evaluate('e => parseFloat(getComputedStyle(e).fontSize)'))
    c.ok(fa > fb, f'available is the headline (font {fa}px vs total {fb}px)')
    p2 = new_page()
    login(p2, 'cy@example.com')
    p2.goto(BASE + '/')
    tid(p2, 'wallet-balance').wait_for()
    c.eq(tid(p2, 'wallet-held').count(), 0, 'wallet-held absent when zero')
    reset(fixture(currency='JPY', mu=0))
    p3 = new_page()
    login(p3, 'bob@example.com')
    tid(p3, 'wallet-balance').wait_for()
    c.eq(tid(p3, 'wallet-balance').inner_text().strip(), '2500 JPY', 'JPY has no decimal point')
    reset(fixture(currency='BHD', mu=3))
    p4 = new_page()
    login(p4, 'cy@example.com')
    tid(p4, 'wallet-balance').wait_for()
    c.eq(tid(p4, 'wallet-balance').inner_text().strip(), '0.500 BHD', 'BHD three decimals')


@run('pay-decimal-rules-no-request', ['R2-21', 'plan:A2-03'])
def _(c):
    reset(fixture())
    p = new_page()
    login(p)
    posts = []
    p.on('request', lambda r: posts.append(r) if r.method == 'POST' and r.url.endswith('/payments') else None)
    for bad in ['15.005', 'abc', '1,000', '-5', '15.', '.5', '1e3', '', '1.2.3']:
        tid(p, 'pay-handle').fill('bob')
        tid(p, 'pay-amount').fill(bad)
        tid(p, 'pay-submit').click()
        p.wait_for_timeout(250)
        c.ok(tid(p, 'pay-error').count() == 1 and tid(p, 'pay-error').is_visible(), f'pay-error for {bad!r}')
    c.eq(len(posts), 0, 'no POST /payments sent for invalid decimals')
    tid(p, 'pay-amount').fill('15.5')
    tid(p, 'pay-note').fill('lunch <b>x</b> 🍜')
    with p.expect_request(lambda r: r.method == 'POST' and r.url.endswith('/payments')) as rq:
        tid(p, 'pay-submit').click()
    body = json.loads(rq.value.post_data)
    c.eq(body.get('amount'), 1550, '15.5 submits 1550')
    p.wait_for_function("() => document.querySelector('[data-testid=wallet-balance]')?.getAttribute('data-amount') === '8450'")
    c.eq(tid(p, 'pay-error').count(), 0, 'pay-error cleared after success')
    for v, want in [('15', 1500), ('15.00', 1500)]:
        tid(p, 'pay-amount').fill(v)
        with p.expect_request(lambda r: r.method == 'POST' and r.url.endswith('/payments')) as rq:
            tid(p, 'pay-submit').click()
        c.eq(json.loads(rq.value.post_data).get('amount'), want, f'{v} submits {want}')
        p.wait_for_timeout(400)


@run('pay-resubmit-insufficient-feed', ['R2-22', 'R2-23'])
def _(c):
    reset(fixture())
    p = new_page()
    login(p)
    tid(p, 'pay-handle').fill('bob')
    tid(p, 'pay-amount').fill('12.34')
    tid(p, 'pay-note').fill('<i>tea</i> & 🍵')
    tid(p, 'pay-visibility').select_option('private')
    opts = tid(p, 'pay-visibility').evaluate("e => [...e.options].map(o => o.value).sort()")
    c.eq(opts, ['private', 'public'], 'visibility option values')
    tid(p, 'pay-submit').click()
    p.wait_for_function("() => document.querySelector('[data-testid=wallet-balance]')?.getAttribute('data-amount') === '8766'")
    c.eq([tid(p, 'pay-handle').input_value(), tid(p, 'pay-amount').input_value(), tid(p, 'pay-note').input_value(), tid(p, 'pay-visibility').input_value()],
         ['bob', '12.34', '<i>tea</i> & 🍵', 'private'], 'form keeps values after success')
    tid(p, 'pay-submit').click()
    p.wait_for_timeout(800)
    c.eq(me('ada@example.com')['balance'], 8766, 'unchanged resubmission moves no money')
    c.eq(tid(p, 'pay-error').count(), 0, 'no pay-error on resubmission')
    items = p.locator('[data-testid^=activity-item-]')
    c.eq(items.count(), 1, 'feed shows one payment')
    pid = items.first.get_attribute('data-testid').removeprefix('activity-item-')
    c.eq(items.first.get_attribute('data-visibility'), 'private', 'data-visibility')
    c.eq(tid(p, f'activity-amount-{pid}').inner_text().strip(), '12.34 EUR', 'activity amount exact')
    c.eq(tid(p, f'activity-note-{pid}').inner_text(), '<i>tea</i> & 🍵', 'note rendered as exact text')
    parties = tid(p, f'activity-parties-{pid}').inner_text()
    c.ok('ada' in parties and 'bob' in parties, 'parties contain both handles')
    tid(p, 'pay-amount').fill('1.00')
    tid(p, 'pay-submit').click()
    p.wait_for_function("() => document.querySelectorAll('[data-testid^=activity-item-]').length === 2")
    first = p.locator('[data-testid=activity-list] > *').first.get_attribute('data-testid')
    c.ok(first is not None and first != f'activity-item-{pid}', 'newest first in the DOM')
    tid(p, 'pay-amount').fill('999.00')
    tid(p, 'pay-note').fill('too much')
    tid(p, 'pay-submit').click()
    tid(p, 'pay-error').wait_for()
    c.eq([tid(p, 'pay-handle').input_value(), tid(p, 'pay-amount').input_value(), tid(p, 'pay-note').input_value()], ['bob', '999.00', 'too much'], 'inputs kept after refusal')
    tid(p, 'pay-amount').fill('1.00')
    tid(p, 'pay-note').fill('n')
    tid(p, 'pay-handle').fill('ghost')
    tid(p, 'pay-submit').click()
    p.wait_for_timeout(500)
    c.ok(tid(p, 'pay-error').count() == 1, 'pay-error for unknown handle')
    q = new_page()
    login(q, 'cy@example.com')
    q.goto(BASE + '/')
    tid(q, 'empty-activity').wait_for()
    c.eq(q.locator('[data-testid^=activity-item-]').count(), 0, 'third party sees no private items; empty-activity shown')


@run('pay-refused-after-other-client-spent', ['R2-22', 'R2-27'])
def _(c):
    reset(fixture())
    p = new_page()
    login(p, 'bob@example.com')
    tid(p, 'wallet-balance').wait_for()
    api.post('/payments', headers={'Authorization': 'Bearer ' + token('bob@example.com'), 'Idempotency-Key': str(uuid.uuid4())}, json={'to_handle': 'cy', 'amount': 2000})
    tid(p, 'pay-handle').fill('ada')
    tid(p, 'pay-amount').fill('10.00')
    tid(p, 'pay-note').fill('keep me')
    tid(p, 'pay-submit').click()
    tid(p, 'pay-error').wait_for()
    p.wait_for_function("() => document.querySelector('[data-testid=wallet-balance]')?.getAttribute('data-amount') === '500'")
    c.eq([tid(p, 'pay-handle').input_value(), tid(p, 'pay-amount').input_value(), tid(p, 'pay-note').input_value()], ['ada', '10.00', 'keep me'], 'inputs preserved')
    c.eq(tid(p, 'pay-uncertain').count(), 0, 'refusal is not uncertain')


@run('pay-lost-response-uncertain-retry', ['R2-22'])
def _(c):
    reset(fixture())
    p = new_page()
    login(p)
    state = {'n': 0, 'keys': []}

    def lose(route):
        state['n'] += 1
        state['keys'].append(route.request.headers.get('idempotency-key'))
        if state['n'] == 1:
            route.fetch()  # the server commits; the browser never hears back
            route.abort('failed')
        else:
            route.continue_()
    p.route('**/payments', lose)
    tid(p, 'pay-handle').fill('bob')
    tid(p, 'pay-amount').fill('7.00')
    tid(p, 'pay-submit').click()
    tid(p, 'pay-uncertain').wait_for()
    c.ok(tid(p, 'pay-uncertain').inner_text().strip() != '', 'pay-uncertain has text')
    c.eq(tid(p, 'pay-error').count(), 0, 'not pay-error')
    c.eq(me('ada@example.com')['balance'], 9300, 'server committed the lost payment')
    tid(p, 'pay-submit').click()
    p.wait_for_function("() => document.querySelector('[data-testid=wallet-balance]')?.getAttribute('data-amount') === '9300'")
    p.wait_for_timeout(300)
    c.eq(tid(p, 'pay-uncertain').count(), 0, 'uncertain removed after retry')
    c.eq(tid(p, 'pay-error').count(), 0, 'no error after retry')
    c.ok(len(state['keys']) >= 2 and state['keys'][0] == state['keys'][1], f'retry used the same key {state["keys"][:2]}')
    c.eq(me('ada@example.com')['balance'], 9300, 'money moved exactly once')
    c.eq(p.locator('[data-testid^=activity-item-]').count(), 1, 'one payment in feed')
    p.unroute('**/payments')
    p.route('**/payments', lambda r: r.fulfill(status=503, body='down'))
    tid(p, 'pay-amount').fill('1.00')
    tid(p, 'pay-submit').click()
    p.wait_for_timeout(600)
    c.ok(tid(p, 'pay-uncertain').count() == 1 and tid(p, 'pay-error').count() == 0, '5xx is an unknown outcome, not a refusal')


@run('latest-refresh-wins', ['R2-27'])
def _(c):
    reset(fixture())
    p = new_page()
    login(p)
    tid(p, 'wallet-balance').wait_for()
    tid(p, 'pay-handle').fill('cy')
    tid(p, 'pay-amount').fill('3.00')
    order = {'n': 0}

    def slow_first(route):
        order['n'] += 1
        if order['n'] == 1:
            resp = route.fetch()
            time.sleep(1.5)
            route.fulfill(response=resp)
        else:
            route.continue_()
    p.route(re.compile(r'.*/me$'), slow_first)
    tid(p, 'wallet-refresh').click()
    p.wait_for_timeout(150)
    api.post('/payments', headers={'Authorization': 'Bearer ' + token('ada@example.com'), 'Idempotency-Key': str(uuid.uuid4())}, json={'to_handle': 'bob', 'amount': 1000})
    tid(p, 'wallet-refresh').click()
    p.wait_for_timeout(2500)
    c.ok(order['n'] >= 2, f'the delayed /me interception fired ({order["n"]} reads)')
    c.eq(tid(p, 'wallet-balance').get_attribute('data-amount'), '9000', 'later refresh not overwritten by the delayed earlier read')
    c.eq([tid(p, 'pay-handle').input_value(), tid(p, 'pay-amount').input_value()], ['cy', '3.00'], 'refresh keeps the pay form')


@run('requests-screen', ['R2-24', 'R2-27'])
def _(c):
    reset(fixture(requests=[
        {'id': 'rq_in', 'requester_id': 'u_bob', 'payer_id': 'u_ada', 'amount': 1200, 'note': 'taxi', 'status': 'pending'},
        {'id': 'rq_out', 'requester_id': 'u_ada', 'payer_id': 'u_cy', 'amount': 300, 'note': '', 'status': 'pending'},
        {'id': 'rq_done', 'requester_id': 'u_bob', 'payer_id': 'u_ada', 'amount': 50, 'note': '', 'status': 'declined'},
        {'id': 'rq_gone', 'requester_id': 'u_bob', 'payer_id': 'u_ada', 'amount': 70, 'note': '', 'status': 'pending'},
    ]))
    p = new_page()
    login(p)
    p.goto(BASE + '/requests')
    tid(p, 'request-item-rq_in').wait_for()
    c.eq(tid(p, 'request-item-rq_in').get_attribute('data-status'), 'pending', 'data-status')
    c.eq(tid(p, 'request-amount-rq_in').inner_text().strip(), '12.00 EUR', 'request amount')
    c.ok(tid(p, 'incoming-list').locator('[data-testid=request-item-rq_in]').count() == 1, 'incoming list holds incoming')
    c.ok(tid(p, 'outgoing-list').locator('[data-testid=request-item-rq_out]').count() == 1, 'outgoing list holds outgoing')
    c.eq([tid(p, 'request-pay-rq_in').count(), tid(p, 'request-decline-rq_in').count(), tid(p, 'request-cancel-rq_in').count()], [1, 1, 0], 'buttons on pending incoming')
    c.eq([tid(p, 'request-pay-rq_out').count(), tid(p, 'request-cancel-rq_out').count()], [0, 1], 'buttons on pending outgoing')
    c.eq([tid(p, 'request-pay-rq_done').count(), tid(p, 'request-decline-rq_done').count()], [0, 0], 'no buttons on declined')
    tid(p, 'request-pay-rq_in').click()
    p.wait_for_function("() => document.querySelector('[data-testid=request-item-rq_in]')?.getAttribute('data-status') === 'paid'")
    c.eq(tid(p, 'request-pay-rq_in').count(), 0, 'pay button gone after paying')
    c.eq(me('ada@example.com')['balance'], 8800, 'paid once')
    api.post('/requests/rq_gone/cancel', headers={'Authorization': 'Bearer ' + token('bob@example.com')})
    tid(p, 'request-pay-rq_gone').click()
    tid(p, 'request-error').wait_for()
    p.wait_for_timeout(500)
    c.eq(tid(p, 'request-pay-rq_gone').count(), 0, 'stale pay button removed after refusal')
    tid(p, 'request-cancel-rq_out').click()
    p.wait_for_function("() => document.querySelector('[data-testid=request-item-rq_out]')?.getAttribute('data-status') === 'cancelled'")
    q = new_page()
    reset(fixture())
    login(q, 'cy@example.com')
    q.goto(BASE + '/requests')
    tid(q, 'empty-requests').wait_for()


@run('split-preview-equals-server', ['R2-25'])
def _(c):
    reset(fixture())
    p = new_page()
    login(p)
    p.goto(BASE + '/split')
    posts = []
    p.on('request', lambda r: posts.append(r) if r.method == 'POST' and r.url.endswith('/splits') else None)
    tid(p, 'split-amount').fill('10.00')
    tid(p, 'split-handles').fill('cy, bob, ada')
    p.wait_for_timeout(300)
    shares = {h: tid(p, f'split-share-{h}').inner_text().strip() for h in ['cy', 'bob', 'ada']}
    c.eq(shares, {'cy': '3.34 EUR', 'bob': '3.33 EUR', 'ada': '3.33 EUR'}, 'preview before posting (larger share first)')
    c.eq(len(posts), 0, 'nothing posted by the preview')
    tid(p, 'split-amount').fill('10.001')
    tid(p, 'split-submit').click()
    p.wait_for_timeout(300)
    c.ok(tid(p, 'split-error').count() == 1 and len(posts) == 0, 'invalid split amount: error, no request')
    tid(p, 'split-amount').fill('10.00')
    with p.expect_response(lambda r: r.request.method == 'POST' and r.url.endswith('/splits')) as rs:
        tid(p, 'split-submit').click()
    srv = {s['handle']: s['amount'] for s in rs.value.json()['shares']}
    c.eq(srv, {'cy': 334, 'bob': 333, 'ada': 333}, 'server shares equal the preview')
    tid(p, 'split-handles').fill('bob, ghost')
    tid(p, 'split-submit').click()
    tid(p, 'split-error').wait_for()


@run('authorizations-screen', ['R2-26', 'R2-27'])
def _(c):
    exp = iso(7200)
    reset(fixture(auths=[
        {'id': 'a_in', 'from_user_id': 'u_bob', 'to_user_id': 'u_ada', 'amount': 1500, 'note': 'rent', 'visibility': 'public', 'status': 'open', 'expires_at': exp},
        {'id': 'a_out', 'from_user_id': 'u_ada', 'to_user_id': 'u_cy', 'amount': 2000, 'note': '', 'visibility': 'private', 'status': 'open', 'expires_at': exp},
        {'id': 'a_old', 'from_user_id': 'u_ada', 'to_user_id': 'u_bob', 'amount': 100, 'note': '', 'visibility': 'public', 'status': 'expired', 'expires_at': iso(-7200)},
    ]))
    p = new_page()
    login(p)
    p.goto(BASE + '/authorizations')
    tid(p, 'authorization-item-a_in').wait_for()
    c.eq(tid(p, 'authorization-item-a_in').get_attribute('data-status'), 'open', 'status attr')
    c.eq(tid(p, 'authorization-amount-a_in').inner_text().strip(), '15.00 EUR', 'amount')
    c.eq(tid(p, 'authorization-expires-a_in').inner_text().strip(), exp, 'expires text is the RFC 3339 expires_at')
    c.eq(tid(p, 'authorization-capture-amount-a_in').input_value(), '15.00', 'capture input pre-filled with remaining')
    c.eq([tid(p, 'authorization-capture-a_in').count(), tid(p, 'authorization-void-a_in').count()], [1, 0], 'incoming open: capture only')
    c.eq([tid(p, 'authorization-capture-a_out').count(), tid(p, 'authorization-void-a_out').count(), tid(p, 'authorization-capture-amount-a_out').count()], [0, 1, 0], 'outgoing open: void only')
    c.eq([tid(p, 'authorization-capture-a_old').count(), tid(p, 'authorization-void-a_old').count(), tid(p, 'authorization-captured-a_old').count()], [0, 0, 0], 'expired: no actions')
    tid(p, 'authorization-capture-amount-a_in').fill('5.005')
    tid(p, 'authorization-capture-a_in').click()
    p.wait_for_timeout(300)
    c.ok(tid(p, 'authorization-error').count() == 1, 'invalid capture decimal shows authorization-error')
    tid(p, 'authorization-capture-amount-a_in').fill('5.00')
    tid(p, 'authorization-capture-a_in').click()
    p.wait_for_function("() => document.querySelector('[data-testid=authorization-item-a_in]')?.getAttribute('data-status') === 'captured'")
    c.eq(tid(p, 'authorization-captured-a_in').inner_text().strip(), '5.00 EUR', 'captured amount shown')
    c.eq(me('ada@example.com')['balance'], 10500, 'capture moved 5.00')
    c.eq(me('bob@example.com')['held'], 0, 'final capture released the rest')
    tid(p, 'authorization-void-a_out').click()
    p.wait_for_function("() => document.querySelector('[data-testid=authorization-item-a_out]')?.getAttribute('data-status') === 'voided'")
    order = [e.get_attribute('data-testid') for e in p.locator('[data-testid=authorization-list] > *').all()]
    c.ok(len(order) == 3, f'three items in the list {order}')
    p.goto(BASE + '/')
    tid(p, 'authorize-handle').fill('cy')
    tid(p, 'authorize-amount').fill('500.00')
    tid(p, 'authorize-submit').click()
    tid(p, 'authorize-error').wait_for()
    tid(p, 'authorize-amount').fill('20.00')
    tid(p, 'authorize-visibility').select_option('private')
    tid(p, 'authorize-submit').click()
    p.wait_for_function("() => document.querySelector('[data-testid=wallet-held]')?.getAttribute('data-amount') === '2000'")
    c.eq(tid(p, 'wallet-available').get_attribute('data-amount'), '8500', 'available refreshed after authorize')
    q = new_page()
    reset(fixture())
    login(q, 'cy@example.com')
    q.goto(BASE + '/authorizations')
    tid(q, 'empty-authorizations').wait_for()
    api_bob = token('bob@example.com')
    a = api.post('/authorizations', headers={'Authorization': 'Bearer ' + api_bob, 'Idempotency-Key': 'x1'}, json={'to_handle': 'cy', 'amount': 100}).json()
    q.reload()
    tid(q, f'authorization-item-{a["authorization_id"]}').wait_for()
    api.post(f'/authorizations/{a["authorization_id"]}/void', headers={'Authorization': 'Bearer ' + api_bob})
    tid(q, f'authorization-capture-{a["authorization_id"]}').click()
    tid(q, 'authorization-error').wait_for()


@run('mobile-375-no-horizontal-scroll', ['R2-28', 'R2-17'])
def _(c):
    reset(fixture(requests=[{'id': 'rq_1', 'requester_id': 'u_bob', 'payer_id': 'u_ada', 'amount': 1200, 'note': 'a long note ' * 5, 'status': 'pending'}],
                  payments=[{'id': 'p_1', 'from_user_id': 'u_ada', 'to_user_id': 'u_bob', 'amount': 500, 'note': 'coffee with a rather long note text', 'visibility': 'public'}]))
    p = new_page(375)
    for route in ['/login', '/signup']:
        p.goto(BASE + route)
        p.wait_for_timeout(300)
        w = p.evaluate('() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]')
        c.ok(w[0] <= w[1], f'{route} scrollWidth {w[0]} <= {w[1]}')
    login(p)
    for route in ['/', '/requests', '/split', '/authorizations']:
        p.goto(BASE + route)
        tid(p, 'current-user').wait_for()
        p.wait_for_timeout(300)
        w = p.evaluate('() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]')
        c.ok(w[0] <= w[1], f'{route} scrollWidth {w[0]} <= {w[1]} at 375px')
    labels = p.evaluate("""() => { location.href; return 0 }""")
    p.goto(BASE + '/')
    tid(p, 'pay-amount').wait_for()
    unlabeled = p.evaluate("""() => [...document.querySelectorAll('input,select')].filter(i => i.type !== 'hidden' && !(i.labels && i.labels.length) && !i.getAttribute('aria-label') && !i.getAttribute('aria-labelledby')).map(i => i.getAttribute('data-testid'))""")
    c.eq(unlabeled, [], 'every input has a label')
    c.eq(p.external, [], 'no external requests')
    del labels


@run('no-external-assets', ['R2-28', 'R-01'])
def _(c):
    reset(fixture())
    p = new_page()
    login(p)
    for route in ['/', '/requests', '/split', '/authorizations']:
        p.goto(BASE + route)
        p.wait_for_load_state('networkidle')
    html = httpx.get(BASE + '/', headers={'Accept': 'text/html'}).text
    c.ok(not re.search(r'(src|href)=["\']https?://', html), 'no absolute external URLs in the HTML shell')
    c.eq(p.external, [], 'no request leaves the origin')


@run('import-between-requests-keeps-session-and-retry', ['R2-02', 'R2-18', 'R2-22'])
def _(c):
    reset(fixture())
    p = new_page()
    login(p)
    state = {'n': 0, 'keys': []}

    def lose(route):
        state['n'] += 1
        state['keys'].append(route.request.headers.get('idempotency-key'))
        if state['n'] == 1:
            route.fetch()
            route.abort('failed')
        else:
            route.continue_()
    p.route('**/payments', lose)
    tid(p, 'pay-handle').fill('bob')
    tid(p, 'pay-amount').fill('4.00')
    tid(p, 'pay-submit').click()
    tid(p, 'pay-uncertain').wait_for()
    exp = api.get('/_test/export').json()
    reset(fixture(extra_users=[{'id': 'u_zz', 'email': 'zz@example.com', 'password': PW, 'display_name': 'Z', 'handle': 'zz', 'balance': 1}]))
    c.eq(api.post('/_test/import', json=exp).status_code, 204, 'import between browser requests')
    tid(p, 'pay-submit').click()
    p.wait_for_function("() => document.querySelector('[data-testid=wallet-balance]')?.getAttribute('data-amount') === '9600'")
    p.wait_for_timeout(300)
    c.eq([tid(p, 'pay-uncertain').count(), tid(p, 'pay-error').count()], [0, 0], 'retry after import recovered the original payment')
    c.ok(state['keys'][:1] == state['keys'][1:2], 'same key across the import')
    c.eq(me('ada@example.com')['balance'], 9600, 'moved exactly once')
    p.goto(BASE + '/requests')
    tid(p, 'current-user').wait_for()
    c.ok('Ada' in tid(p, 'current-user').inner_text(), 'still signed in after import')


@run('decimal-input-jpy-bhd', ['R2-21', 'plan:edge-12'])
def _(c):
    for cur, mu, typed, want, bad in [('JPY', 0, '1200', 1200, '12.5'), ('BHD', 3, '12.345', 12345, '1.2345')]:
        reset(fixture(currency=cur, mu=mu, extra_users=[{'id': 'u_rich', 'email': 'rich@example.com', 'password': PW, 'display_name': 'Rich', 'handle': 'rich', 'balance': 100000000}]))
        p = new_page()
        login(p, 'rich@example.com')
        posts = []
        p.on('request', lambda r: posts.append(r) if r.method == 'POST' and r.url.endswith('/payments') else None)
        tid(p, 'pay-handle').fill('bob')
        tid(p, 'pay-amount').fill(bad)
        tid(p, 'pay-submit').click()
        p.wait_for_timeout(250)
        c.ok(tid(p, 'pay-error').count() == 1 and not posts, f'{cur}: {bad!r} rejected without a request')
        tid(p, 'pay-amount').fill(typed)
        with p.expect_request(lambda r: r.method == 'POST' and r.url.endswith('/payments')) as rq:
            tid(p, 'pay-submit').click()
        c.eq(json.loads(rq.value.post_data).get('amount'), want, f'{cur}: {typed} submits {want}')
        p.wait_for_timeout(400)
        pid = p.locator('[data-testid^=activity-item-]').first.get_attribute('data-testid').removeprefix('activity-item-')
        c.eq(tid(p, f'activity-amount-{pid}').inner_text().strip(), f'{typed} {cur}', f'{cur}: activity amount formatted')


@run('server-500-is-uncertain', ['R2-22'])
def _(c):
    reset(fixture())
    p = new_page()
    login(p)
    p.route('**/payments', lambda r: r.fulfill(status=500, content_type='application/json', body='{"error":{"code":"internal","message":"x"}}'))
    tid(p, 'pay-handle').fill('bob')
    tid(p, 'pay-amount').fill('1.00')
    tid(p, 'pay-submit').click()
    p.wait_for_timeout(600)
    c.ok(tid(p, 'pay-uncertain').count() == 1 and tid(p, 'pay-error').count() == 0, 'HTTP 500 is an unknown outcome (pay-uncertain, not pay-error)')


@run('unauthenticated-routes-go-to-login', ['R2-18', 'plan:A2-05'])
def _(c):
    reset(fixture())
    p = new_page()
    for route in ['/', '/requests', '/split', '/authorizations']:
        p.goto(BASE + route)
        p.wait_for_timeout(500)
        c.ok(tid(p, 'login-email').count() == 1 and tid(p, 'current-user').count() == 0, f'{route} without a session shows login')
    login(p)
    reset(fixture())
    p.goto(BASE + '/')
    p.wait_for_timeout(800)
    c.ok(tid(p, 'login-email').count() == 1 and tid(p, 'current-user').count() == 0, 'a token invalidated by reset leads back to login')


browser.close()
pw.stop()
failed = [r for r in results if not r['passed']]
report = {'kind': 'ui-checks', 'checks': len(results), 'passed': len(results) - len(failed), 'failed': len(failed), 'results': results}
if OUT:
    open(OUT, 'w').write(json.dumps(report, indent=2))
print(f"\nui: {report['passed']}/{report['checks']} checks passed, {report['failed']} failed")
sys.exit(1 if failed else 0)
