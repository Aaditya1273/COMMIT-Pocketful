"""Builder's own browser checks for stage 2, written from the specification.

Run with any Python that has pytest, httpx and playwright (e.g. the harness venv):
    POCKETFUL_URL=http://127.0.0.1:8080 [POCKETFUL_S1_URL=http://127.0.0.1:8081] \
        python -m pytest -q stage-2/test/test_ui_spec.py
POCKETFUL_S1_URL points at a running stage-1 service for the upgrade check.
"""
from __future__ import annotations

import datetime as dt
import os
import uuid

import httpx
import pytest
from playwright.sync_api import expect, sync_playwright

BASE = os.environ.get("POCKETFUL_URL", "http://127.0.0.1:8080").rstrip("/")
S1 = os.environ.get("POCKETFUL_S1_URL", "").rstrip("/")
PW = "correct horse"


def user(handle, balance, **extra):
    return {"id": f"u_{handle}", "email": f"{handle}@example.com", "password": PW,
            "display_name": handle.title(), "handle": handle, "balance": balance, **extra}


def fixture(**over):
    body = {"currency": "EUR", "minor_units": 2,
            "users": [user("ada", 10000), user("bob", 2500), user("cy", 500)]}
    body.update(over)
    return body


def sel(name):
    return f"[data-testid='{name}']"


def reset(f=None, base=BASE):
    r = httpx.post(f"{base}/_test/reset", json=f or fixture(), timeout=10)
    assert r.status_code == 204, r.text


def token(handle, base=BASE):
    r = httpx.post(f"{base}/auth/login", json={"email": f"{handle}@example.com", "password": PW})
    assert r.status_code == 200, r.text
    return r.json()["token"]


def call(method, path, tok, body=None, key=None, base=BASE):
    headers = {"Authorization": f"Bearer {tok}"}
    if key:
        headers["Idempotency-Key"] = key
    return httpx.request(method, f"{base}{path}", json=body, headers=headers)


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as p:
        b = p.chromium.launch()
        yield b
        b.close()


@pytest.fixture
def page(browser):
    ctx = browser.new_context(base_url=BASE)
    pg = ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    yield pg
    ctx.close()
    assert not errors, errors


def log_in(page, handle="ada"):
    page.goto("/login")
    page.fill(sel("login-email"), f"{handle}@example.com")
    page.fill(sel("login-password"), PW)
    page.click(sel("login-submit"))
    page.wait_for_selector(sel("current-user"))


def fill_pay(page, handle="bob", amount="15.00", note=None):
    page.fill(sel("pay-handle"), handle)
    page.fill(sel("pay-amount"), amount)
    if note is not None:
        page.fill(sel("pay-note"), note)


# ---- lost responses, refusals and retries ------------------------------------------

def test_lost_payment_response_is_uncertain_and_retry_moves_money_once(page):
    reset()
    log_in(page)
    page.goto("/")
    expect(page.locator(sel("wallet-balance"))).to_have_attribute("data-amount", "10000")
    keys = []

    def lose_after_commit(route):
        keys.append(route.request.headers.get("idempotency-key"))
        route.fetch()          # the server commits the payment ...
        route.abort()          # ... and the browser never sees the response

    page.route("**/payments", lose_after_commit)
    fill_pay(page, amount="15.00", note="lost")
    page.click(sel("pay-submit"))
    expect(page.locator(sel("pay-uncertain"))).to_be_visible()
    assert page.locator(sel("pay-uncertain")).inner_text().strip()
    assert page.query_selector(sel("pay-error")) is None, "an unknown outcome is not a refusal"
    page.unroute("**/payments")
    seen = []
    page.on("request", lambda r: seen.append(r) if r.url.endswith("/payments") else None)
    page.click(sel("pay-submit"))
    expect(page.locator(sel("wallet-balance"))).to_have_attribute("data-amount", "8500")
    assert page.query_selector(sel("pay-uncertain")) is None
    assert page.query_selector(sel("pay-error")) is None
    assert seen[-1].headers.get("idempotency-key") == keys[0], "the retry reuses the same key"
    feed = call("GET", "/activity", token("ada")).json()["payments"]
    assert len([p for p in feed if p["note"] == "lost"]) == 1
    expect(page.locator(sel("activity-list") + " > *")).to_have_count(1)


def test_server_error_is_uncertain_not_refusal(page):
    reset()
    log_in(page)
    page.goto("/")
    page.route("**/payments", lambda route: route.fulfill(status=503, body="upstream down"))
    fill_pay(page, amount="1.00")
    page.click(sel("pay-submit"))
    expect(page.locator(sel("pay-uncertain"))).to_be_visible()
    assert page.query_selector(sel("pay-error")) is None


def test_refused_payment_keeps_inputs_and_refreshes(page):
    reset()
    log_in(page, "cy")
    page.goto("/")
    expect(page.locator(sel("wallet-balance"))).to_have_attribute("data-amount", "500")
    # another client spends Cy's money after the page read it
    assert call("POST", "/payments", token("cy"), {"to_handle": "bob", "amount": 400}, str(uuid.uuid4())).status_code == 201
    fill_pay(page, amount="2.00", note="keep me")
    page.select_option(sel("pay-visibility"), "private")
    page.click(sel("pay-submit"))
    expect(page.locator(sel("pay-error"))).to_be_visible()
    expect(page.locator(sel("wallet-balance"))).to_have_attribute("data-amount", "100")
    assert page.input_value(sel("pay-handle")) == "bob"
    assert page.input_value(sel("pay-amount")) == "2.00"
    assert page.input_value(sel("pay-note")) == "keep me"
    assert page.input_value(sel("pay-visibility")) == "private"
    # after money arrives, the unchanged form succeeds (a refused key is reusable)
    assert call("POST", "/payments", token("bob"), {"to_handle": "cy", "amount": 1000}, str(uuid.uuid4())).status_code == 201
    page.click(sel("pay-submit"))
    expect(page.locator(sel("wallet-balance"))).to_have_attribute("data-amount", "900")
    assert page.query_selector(sel("pay-error")) is None


@pytest.mark.parametrize("amount", ["15.005", "abc", "1,000", "-5", "15.", ".5", "1e3", ""])
def test_bad_decimal_input_shows_error_without_a_request(page, amount):
    reset()
    log_in(page)
    page.goto("/")
    page.wait_for_selector(sel("pay-submit"))
    posted = []
    page.on("request", lambda r: posted.append(r) if r.method == "POST" else None)
    fill_pay(page, amount=amount)
    page.click(sel("pay-submit"))
    expect(page.locator(sel("pay-error"))).to_be_visible()
    page.wait_for_timeout(200)
    assert posted == []


def test_latest_refresh_wins_when_responses_arrive_out_of_order(page):
    reset()
    log_in(page)
    page.goto("/")
    expect(page.locator(sel("wallet-balance"))).to_have_attribute("data-amount", "10000")
    held = {}

    def hold_first(route):
        if "first" not in held:
            held["first"] = (route, route.fetch())  # read the old state now, deliver it later
        else:
            route.continue_()

    page.route("**/me", hold_first)
    page.click(sel("wallet-refresh"))
    page.wait_for_timeout(300)
    assert call("POST", "/payments", token("ada"), {"to_handle": "bob", "amount": 300}, str(uuid.uuid4())).status_code == 201
    page.click(sel("wallet-refresh"))
    expect(page.locator(sel("wallet-balance"))).to_have_attribute("data-amount", "9700")
    route, stale = held["first"]
    route.fulfill(response=stale)
    page.wait_for_timeout(500)
    expect(page.locator(sel("wallet-balance"))).to_have_attribute("data-amount", "9700")


def test_refresh_keeps_the_pay_form(page):
    reset()
    log_in(page)
    page.goto("/")
    fill_pay(page, amount="3.21", note="draft")
    page.click(sel("wallet-refresh"))
    page.wait_for_timeout(300)
    assert page.input_value(sel("pay-amount")) == "3.21"
    assert page.input_value(sel("pay-note")) == "draft"


# ---- requests ------------------------------------------------------------------------

def test_request_cancelled_elsewhere_shows_error_and_removes_stale_button(page):
    reset()
    bob = token("bob")
    rid = call("POST", "/requests", bob, {"payer_handle": "ada", "amount": 100}, str(uuid.uuid4())).json()["request_id"]
    log_in(page)
    page.goto("/requests")
    page.wait_for_selector(sel(f"request-pay-{rid}"))
    assert call("POST", f"/requests/{rid}/cancel", bob).status_code == 200
    page.click(sel(f"request-pay-{rid}"))
    expect(page.locator(sel("request-error"))).to_be_visible()
    expect(page.locator(sel(f"request-item-{rid}"))).to_have_attribute("data-status", "cancelled")
    assert page.query_selector(sel(f"request-pay-{rid}")) is None


def test_request_form_and_lists(page):
    reset()
    log_in(page)
    page.goto("/")
    page.fill(sel("request-handle"), "bob")
    page.fill(sel("request-amount"), "12.5")
    page.fill(sel("request-note"), "taxi")
    page.click(sel("request-submit"))
    expect(page.locator(sel("request-success"))).to_be_visible()
    rq = call("GET", "/requests", token("bob")).json()["requests"]
    assert [(r["amount"], r["note"]) for r in rq] == [(1250, "taxi")]
    page.fill(sel("request-handle"), "ada")
    page.click(sel("request-submit"))
    expect(page.locator(sel("request-error"))).to_be_visible()
    page.goto("/requests")
    rid = rq[0]["request_id"]
    expect(page.locator(sel(f"request-amount-{rid}"))).to_have_text("12.50 EUR")
    assert page.query_selector(sel(f"request-cancel-{rid}")) is not None
    assert page.query_selector(sel("empty-requests")) is None


# ---- holds -----------------------------------------------------------------------------

def test_seeded_hold_shows_available_as_headline_and_capture_void_flow(page):
    future = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=2)).replace(microsecond=0).isoformat()
    reset(fixture(authorizations=[
        {"id": "a_1", "from_user_id": "u_ada", "to_user_id": "u_bob", "amount": 2000, "note": "deposit",
         "visibility": "public", "status": "open", "expires_at": future}]))
    log_in(page)
    page.goto("/")
    expect(page.locator(sel("wallet-available"))).to_have_text("80.00 EUR")
    expect(page.locator(sel("wallet-available"))).to_have_attribute("data-amount", "8000")
    expect(page.locator(sel("wallet-balance"))).to_have_text("100.00 EUR")
    expect(page.locator(sel("wallet-held"))).to_have_text("20.00 EUR")
    # authorize form
    page.fill(sel("authorize-handle"), "cy")
    page.fill(sel("authorize-amount"), "5")
    page.click(sel("authorize-submit"))
    expect(page.locator(sel("wallet-available"))).to_have_attribute("data-amount", "7500")
    expect(page.locator(sel("wallet-held"))).to_have_attribute("data-amount", "2500")
    page.fill(sel("authorize-amount"), "999.00")
    page.click(sel("authorize-submit"))
    expect(page.locator(sel("authorize-error"))).to_be_visible()
    # payer view: void button only on outgoing open
    page.goto("/authorizations")
    page.wait_for_selector(sel("authorization-item-a_1"))
    assert page.text_content(sel("authorization-expires-a_1")).strip() == future
    assert page.text_content(sel("authorization-amount-a_1")).strip() == "20.00 EUR"
    assert page.query_selector(sel("authorization-capture-a_1")) is None
    cy_auth = [a for a in call("GET", "/authorizations", token("ada")).json()["authorizations"] if a["to_handle"] == "cy"][0]
    page.click(sel(f"authorization-void-{cy_auth['authorization_id']}"))
    expect(page.locator(sel(f"authorization-item-{cy_auth['authorization_id']}"))).to_have_attribute("data-status", "voided")
    # receiver view: partial final capture
    page.click(sel("logout-button"))
    log_in(page, "bob")
    page.goto("/authorizations")
    page.wait_for_selector(sel("authorization-capture-a_1"))
    assert page.input_value(sel("authorization-capture-amount-a_1")) == "20.00"
    assert page.query_selector(sel("authorization-void-a_1")) is None
    page.fill(sel("authorization-capture-amount-a_1"), "15.00")
    page.click(sel("authorization-capture-a_1"))
    expect(page.locator(sel("authorization-item-a_1"))).to_have_attribute("data-status", "captured")
    expect(page.locator(sel("authorization-captured-a_1"))).to_have_text("15.00 EUR")
    assert page.query_selector(sel("authorization-capture-a_1")) is None
    me = call("GET", "/me", token("ada")).json()
    assert (me["total"], me["available"], me["held"]) == (8500, 8500, 0)
    page.goto("/")
    expect(page.locator(sel("wallet-balance"))).to_have_attribute("data-amount", "4000")
    assert page.query_selector(sel("wallet-held")) is None


def test_capture_refused_shows_authorization_error(page):
    reset()
    ada = token("ada")
    aid = call("POST", "/authorizations", ada, {"to_handle": "bob", "amount": 1000}, str(uuid.uuid4())).json()["authorization_id"]
    log_in(page, "bob")
    page.goto("/authorizations")
    page.wait_for_selector(sel(f"authorization-capture-{aid}"))
    assert call("POST", f"/authorizations/{aid}/void", ada).status_code == 200
    page.click(sel(f"authorization-capture-{aid}"))
    expect(page.locator(sel("authorization-error"))).to_be_visible()
    expect(page.locator(sel(f"authorization-item-{aid}"))).to_have_attribute("data-status", "voided")


def test_empty_authorizations(page):
    reset()
    log_in(page)
    page.goto("/authorizations")
    expect(page.locator(sel("empty-authorizations"))).to_be_visible()


# ---- formatting -------------------------------------------------------------------------

@pytest.mark.parametrize("currency,mu,balance_text,good,bad,after", [
    ("JPY", 0, "10000 JPY", "15", "15.5", 9985),
    ("BHD", 3, "10.000 BHD", "1.5", "1.5005", 8500),
])
def test_currency_formatting_and_parsing(page, currency, mu, balance_text, good, bad, after):
    reset(fixture(currency=currency, minor_units=mu))
    log_in(page)
    page.goto("/")
    expect(page.locator(sel("wallet-balance"))).to_have_text(balance_text)
    fill_pay(page, amount=bad)
    page.click(sel("pay-submit"))
    expect(page.locator(sel("pay-error"))).to_be_visible()
    fill_pay(page, amount=good)
    page.click(sel("pay-submit"))
    expect(page.locator(sel("wallet-balance"))).to_have_attribute("data-amount", str(after))


def test_split_preview_matches_server_and_html_in_notes_is_text(page):
    reset()
    ada = token("ada")
    pid = call("POST", "/payments", ada, {"to_handle": "bob", "amount": 1, "note": "<b>bold</b> 😀"}, str(uuid.uuid4())).json()["payment_id"]
    log_in(page)
    page.goto("/")
    expect(page.locator(sel(f"activity-note-{pid}"))).to_have_text("<b>bold</b> 😀")
    page.goto("/split")
    page.fill(sel("split-amount"), "0.01")
    page.fill(sel("split-handles"), "bob, ada,cy")
    expect(page.locator(sel("split-share-bob"))).to_have_text("0.01 EUR")
    expect(page.locator(sel("split-share-cy"))).to_have_text("0.00 EUR")
    page.click(sel("split-submit"))
    expect(page.locator(sel("split-success"))).to_be_visible()
    bob_rq = call("GET", "/requests", token("bob")).json()["requests"]
    assert [r["amount"] for r in bob_rq] == [1]


# ---- responsive -------------------------------------------------------------------------

def test_no_horizontal_scroll_at_375px(browser):
    reset()
    ada = token("ada")
    call("POST", "/payments", ada, {"to_handle": "bob", "amount": 123456, "note": "x" * 200}, str(uuid.uuid4()))
    call("POST", "/requests", ada, {"payer_handle": "bob", "amount": 1000, "note": "y" * 200}, str(uuid.uuid4()))
    call("POST", "/authorizations", ada, {"to_handle": "bob", "amount": 1000}, str(uuid.uuid4()))
    ctx = browser.new_context(base_url=BASE, viewport={"width": 375, "height": 800})
    pg = ctx.new_page()
    log_in(pg)
    for route in ["/", "/requests", "/split", "/authorizations", "/login", "/signup"]:
        pg.goto(route)
        pg.wait_for_timeout(400)
        width = pg.evaluate("document.documentElement.scrollWidth")
        assert width <= 375, f"{route} scrolls horizontally: {width}px"
    ctx.close()


# ---- upgrade ------------------------------------------------------------------------------

def test_browser_session_and_lost_payment_survive_export_import(page):
    reset()
    log_in(page)
    page.goto("/")
    expect(page.locator(sel("wallet-balance"))).to_have_attribute("data-amount", "10000")

    def lose(route):
        route.fetch()
        route.abort()

    page.route("**/payments", lose)
    fill_pay(page, amount="15.00", note="before upgrade")
    page.click(sel("pay-submit"))
    expect(page.locator(sel("pay-uncertain"))).to_be_visible()
    page.unroute("**/payments")
    snapshot = httpx.get(f"{BASE}/_test/export").json()
    reset()  # wipe the destination, then upgrade into it
    assert httpx.post(f"{BASE}/_test/import", json=snapshot).status_code == 204
    page.click(sel("pay-submit"))
    expect(page.locator(sel("wallet-balance"))).to_have_attribute("data-amount", "8500")
    assert page.query_selector(sel("pay-uncertain")) is None
    expect(page.locator(sel("current-user"))).to_be_visible()
    feed = call("GET", "/activity", token("ada")).json()["payments"]
    assert len([p for p in feed if p["note"] == "before upgrade"]) == 1


@pytest.mark.skipif(not S1, reason="POCKETFUL_S1_URL not set")
def test_stage_1_export_upgrades_into_stage_2(browser):
    reset(base=S1)
    ada1 = token("ada", base=S1)
    bob1 = token("bob", base=S1)
    lost_key = str(uuid.uuid4())
    body = {"to_handle": "bob", "amount": 700, "note": "lost before export"}
    original = call("POST", "/payments", ada1, body, lost_key, base=S1).json()   # response "lost"
    rid = call("POST", "/requests", bob1, {"payer_handle": "ada", "amount": 300}, str(uuid.uuid4()), base=S1).json()["request_id"]
    snapshot = httpx.get(f"{S1}/_test/export").json()
    reset()
    assert httpx.post(f"{BASE}/_test/import", json=snapshot).status_code == 204
    me = call("GET", "/me", ada1).json()
    assert (me["balance"], me["total"], me["available"], me["held"]) == (9300, 9300, 9300, 0)
    replay = call("POST", "/payments", ada1, body, lost_key)
    assert replay.status_code == 200 and replay.json() == original
    # the browser signed in on stage 1 (same token in storage) stays signed in
    ctx = browser.new_context(base_url=BASE)
    ctx.add_init_script(f"window.localStorage.setItem('pocketful.token', {ada1!r})")
    pg = ctx.new_page()
    pg.goto("/requests")
    pg.wait_for_selector(sel("current-user"))
    pg.click(sel(f"request-pay-{rid}"))
    expect(pg.locator(sel(f"request-item-{rid}"))).to_have_attribute("data-status", "paid")
    pg.goto("/")
    expect(pg.locator(sel("wallet-balance"))).to_have_attribute("data-amount", "9000")
    ctx.close()
