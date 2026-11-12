import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  boot, tokenFor, request, sendEvent, sql, createIntent, webhook, startSubscriber, config,
  forgedToken, expiredToken, wrongAudienceToken, hs256Token,
} from "./helpers.js";
// Dynamic on purpose: a static import of src/ would evaluate config.js before helpers.js has set the
// test env (JWKS_URL of the fake Keycloak), so every user token would fail with 503.
const { runRelayOnce } = await import("../src/relay.js");

const app = await boot();
after(() => app.close());

const SPARKLE = 1;
const CUSTOMER = 1;
const provider = tokenFor("provider", SPARKLE);
const customer = tokenFor("customer", CUSTOMER);
const intentBody = (order_id, amount_cents = 64200) => ({ order_id, customer_id: CUSTOMER, provider_id: SPARKLE, amount_cents });
const count = async (text, params) => Number((await sql(text, params))[0].n);

test("payments service", async (t) => {
  await t.test("/health and /ready", async () => {
    assert.equal((await request(app.base, "/health")).status, 200);
    assert.equal((await request(app.base, "/ready")).status, 200);
  });

  await t.test("seed: wallets for the monolith's provider ids 1..3, all zero", async () => {
    const rows = await sql("SELECT provider_id, balance_cents, commission_owed_cents FROM provider_wallets ORDER BY provider_id");
    assert.deepEqual(rows, [1, 2, 3].map((id) => ({ provider_id: id, balance_cents: 0, commission_owed_cents: 0 })));
    const res = await request(app.base, "/api/provider/wallet", { token: provider });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { provider_id: SPARKLE, balance_cents: 0, commission_owed_cents: 0, transactions: [] });
  });

  await t.test("wallet/transactions are role-gated", async () => {
    assert.equal((await request(app.base, "/api/provider/wallet")).status, 401);
    assert.equal((await request(app.base, "/api/provider/wallet", { token: customer })).status, 403);
    assert.equal((await request(app.base, "/api/customer/transactions", { token: provider })).status, 403);
    // app_id is not unique across roles: admin#1 shares id 1 with provider#1 but is not a provider.
    assert.equal((await request(app.base, "/api/provider/wallet", { token: tokenFor("admin", SPARKLE) })).status, 403);
  });

  // Step 3.3: the wallet owner comes from the token's app_id only — nothing in the request can pick another one.
  await t.test("wallet ignores any provider_id in the request", async () => {
    const res = await request(app.base, "/api/provider/wallet?provider_id=2", { token: provider });
    assert.equal(res.status, 200);
    assert.equal(res.body.provider_id, SPARKLE);
  });

  // Step 3: only Keycloak tokens for THIS service are accepted (signature via JWKS, iss, aud, exp).
  await t.test("Keycloak token checks: forged, expired, wrong audience, old HS256 -> 401", async () => {
    const get = (token) => request(app.base, "/api/provider/wallet", { token });
    const refused = {
      "forged signature": forgedToken("provider", SPARKLE),
      "expired": expiredToken("provider", SPARKLE),
      "wrong audience": wrongAudienceToken("provider", SPARKLE),
      "only the notifications-api audience": wrongAudienceToken("provider", SPARKLE, "notifications-api"),
      "wrong issuer": tokenFor("provider", SPARKLE, { iss: "http://evil.example/realms/edemand" }),
      "old Step 2 HS256 token": hs256Token("provider", SPARKLE),
      "no app_id claim": tokenFor("provider", SPARKLE, { app_id: undefined }),
      "unknown role": tokenFor("superuser", SPARKLE),
    };
    for (const [why, token] of Object.entries(refused)) {
      const res = await get(token);
      assert.equal(res.status, 401, `${why} -> expected 401, got ${res.status}`);
      assert.match(res.body.error, /invalid token/, why);
    }
    assert.equal((await get(provider)).status, 200, "a valid token still works");
  });

  // ---------------- POST /intents ----------------
  let intent;
  await t.test("POST /intents: internal token required; Idempotency-Key must equal order_id", async () => {
    assert.equal((await createIntent(app.base, intentBody(8001), { token: "nope" })).status, 401);
    const badKey = await createIntent(app.base, intentBody(8001), { key: "something-else" });
    assert.equal(badKey.status, 400);
    const invalid = await createIntent(app.base, { order_id: 8001 });
    assert.equal(invalid.status, 400);
    assert.ok(Array.isArray(invalid.body.details));
  });

  await t.test("POST /intents creates one intent (201); a retry returns the same one (200)", async () => {
    const first = await createIntent(app.base, intentBody(8001));
    assert.equal(first.status, 201);
    assert.equal(first.body.status, "requires_payment");
    assert.equal(first.body.customer_id, CUSTOMER);
    assert.match(first.body.gateway_ref, /^SIM-PI-/);
    intent = first.body;

    const retry = await createIntent(app.base, intentBody(8001));
    assert.equal(retry.status, 200);
    assert.equal(retry.body.gateway_ref, intent.gateway_ref);

    const conflict = await createIntent(app.base, intentBody(8001, 1));
    assert.equal(conflict.status, 409, "same key, different request");
  });

  await t.test("two concurrent POST /intents for one order -> exactly one row", async () => {
    const [a, b] = await Promise.all([createIntent(app.base, intentBody(8100)), createIntent(app.base, intentBody(8100))]);
    assert.deepEqual([a.status, b.status].sort(), [200, 201]);
    assert.equal(a.body.gateway_ref, b.body.gateway_ref);
    assert.equal(await count("SELECT COUNT(*) AS n FROM payment_intents WHERE order_id = 8100"), 1);
  });

  // ---------------- webhook ----------------
  await t.test("webhook: bad secret -> 401", async () => {
    const res = await webhook(app.base, { gateway_event_id: "evt-x", type: "payment_intent.succeeded", gateway_ref: intent.gateway_ref }, "wrong");
    assert.equal(res.status, 401);
  });

  await t.test("webhook: unknown gateway_ref -> 404 and the event is NOT recorded (rolled back)", async () => {
    const res = await webhook(app.base, { gateway_event_id: "evt-404", type: "payment_intent.succeeded", gateway_ref: "SIM-PI-nope" });
    assert.equal(res.status, 404);
    assert.equal(await count("SELECT COUNT(*) AS n FROM webhook_events WHERE gateway_event_id = 'evt-404'"), 0);
  });

  await t.test("first webhook settles the intent, records one charge + one payment.succeeded outbox row", async () => {
    const res = await webhook(app.base, { gateway_event_id: "evt-1", type: "payment_intent.succeeded", gateway_ref: intent.gateway_ref });
    assert.equal(res.status, 200);
    assert.equal(res.body.settled, true);
    assert.equal((await sql("SELECT status FROM payment_intents WHERE order_id = 8001"))[0].status, "succeeded");
    assert.equal(await count("SELECT COUNT(*) AS n FROM transactions WHERE order_id = 8001 AND kind = 'charge'"), 1);
    const [ev] = await sql("SELECT payload FROM outbox WHERE type = 'payment.succeeded' AND aggregate_id = 8001");
    assert.deepEqual(ev.payload, {
      order_id: 8001, customer_id: CUSTOMER, provider_id: SPARKLE, amount_cents: 64200, gateway_ref: intent.gateway_ref,
    });
  });

  await t.test("replaying the same gateway_event_id is a 200 no-op — no double charge", async () => {
    const res = await webhook(app.base, { gateway_event_id: "evt-1", type: "payment_intent.succeeded", gateway_ref: intent.gateway_ref });
    assert.equal(res.status, 200);
    assert.equal(res.body.replayed, true);
    assert.equal(await count("SELECT COUNT(*) AS n FROM transactions WHERE order_id = 8001 AND kind = 'charge'"), 1);
    assert.equal(await count("SELECT COUNT(*) AS n FROM webhook_events WHERE gateway_event_id = 'evt-1'"), 1);
    assert.equal(await count("SELECT COUNT(*) AS n FROM outbox WHERE type = 'payment.succeeded' AND aggregate_id = 8001"), 1);
  });

  await t.test("two DIFFERENT webhook events racing on one intent -> still one charge", async () => {
    const [a, b] = await Promise.all([
      webhook(app.base, { gateway_event_id: "evt-r1", type: "payment_intent.succeeded", gateway_ref: (await sql("SELECT gateway_ref FROM payment_intents WHERE order_id = 8100"))[0].gateway_ref }),
      webhook(app.base, { gateway_event_id: "evt-r2", type: "payment_intent.succeeded", gateway_ref: (await sql("SELECT gateway_ref FROM payment_intents WHERE order_id = 8100"))[0].gateway_ref }),
    ]);
    assert.deepEqual([a.status, b.status], [200, 200]);
    assert.equal(await count("SELECT COUNT(*) AS n FROM transactions WHERE order_id = 8100 AND kind = 'charge'"), 1);
  });

  // ---------------- simulate ----------------
  await t.test("simulate: only the intent's customer may pay; no intent -> 409; owner settles via the webhook path", async () => {
    await createIntent(app.base, intentBody(8002, 48150));
    const stranger = await request(app.base, "/api/payments/simulate", { body: { order_id: 8002 }, token: tokenFor("customer", 2) });
    assert.equal(stranger.status, 403);
    // Step 3.3: ownership is (role, app_id). provider#1 / admin#1 share app_id 1 with the intent's customer#1,
    // and a customer_id in the body cannot claim the intent either.
    const refused = {
      "provider#1 (same app_id)": { token: tokenFor("provider", CUSTOMER), body: { order_id: 8002 } },
      "admin#1 (same app_id)": { token: tokenFor("admin", CUSTOMER), body: { order_id: 8002 } },
      "customer#2 claiming customer_id 1 in the body": { token: tokenFor("customer", 2), body: { order_id: 8002, customer_id: CUSTOMER } },
    };
    for (const [who, { token, body }] of Object.entries(refused)) {
      const res = await request(app.base, "/api/payments/simulate", { body, token });
      assert.equal(res.status, 403, `${who} -> expected 403, got ${res.status}`);
    }
    assert.equal((await sql("SELECT status FROM payment_intents WHERE order_id = 8002"))[0].status, "requires_payment",
      "a refused simulate settles nothing");
    assert.equal(await count("SELECT COUNT(*) AS n FROM transactions WHERE order_id = 8002"), 0);
    const none = await request(app.base, "/api/payments/simulate", { body: { order_id: 9999 }, token: customer });
    assert.equal(none.status, 409);
    // Browser path: the gateway forwards the httpOnly cookie, not a Bearer header.
    const ok = await request(app.base, "/api/payments/simulate", { body: { order_id: 8002 }, headers: { cookie: `edemand_token=${customer}` } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.settled, true);
  });

  // ---------------- consuming booking.completed ----------------
  const completed = (id, order_id, payment_method, provider_id = SPARKLE) => ({
    source: "monolith", id, type: "booking.completed",
    payload: {
      order_id, total_cents: 64200, commission_cents: 9630, provider_earnings_cents: 54570,
      customer_id: CUSTOMER, provider_id, payment_method,
    },
  });

  await t.test("/internal/events requires the internal token", async () => {
    assert.equal((await sendEvent(app.base, completed(1, 8001, "cod"), "nope")).status, 401);
  });

  await t.test("booking.completed (COD) books commission owed exactly once, even when redelivered", async () => {
    const env = completed(1, 8003, "cod");
    assert.equal((await sendEvent(app.base, env)).body.handled, true);
    const dup = await sendEvent(app.base, env);
    assert.equal(dup.body.duplicate, true);
    const [w] = await sql("SELECT balance_cents, commission_owed_cents FROM provider_wallets WHERE provider_id = $1", [SPARKLE]);
    assert.deepEqual(w, { balance_cents: 0, commission_owed_cents: 9630 });
    assert.equal(await count("SELECT COUNT(*) AS n FROM transactions WHERE order_id = 8003 AND kind = 'commission_owed'"), 1);
  });

  await t.test("booking.completed (gateway) credits the balance; concurrent redeliveries credit once", async () => {
    const env = completed(2, 8001, "gateway");
    await Promise.all([sendEvent(app.base, env), sendEvent(app.base, env), sendEvent(app.base, env)]);
    const res = await request(app.base, "/api/provider/wallet", { token: provider });
    assert.equal(res.body.balance_cents, 54570);
    assert.equal(res.body.commission_owed_cents, 9630);
    assert.equal(res.body.transactions.filter((tx) => tx.kind === "payout_credit").length, 1);
  });

  await t.test("another provider's wallet shows none of provider#1's money", async () => {
    const res = await request(app.base, "/api/provider/wallet", { token: tokenFor("provider", 2) });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { provider_id: 2, balance_cents: 0, commission_owed_cents: 0, transactions: [] });
  });

  await t.test("first credit for a provider with no wallet row upserts the wallet", async () => {
    await sendEvent(app.base, completed(3, 8004, "gateway", 77));
    const [w] = await sql("SELECT balance_cents FROM provider_wallets WHERE provider_id = 77");
    assert.equal(w.balance_cents, 54570);
  });

  // ---------------- consuming booking.cancelled ----------------
  await t.test("booking.cancelled on a PAID order -> refund transaction + payment.refunded", async () => {
    await sendEvent(app.base, { source: "monolith", id: 4, type: "booking.cancelled", payload: { order_id: 8002, payment_status: "paid" } });
    assert.equal((await sql("SELECT status FROM payment_intents WHERE order_id = 8002"))[0].status, "refunded");
    assert.equal(await count("SELECT COUNT(*) AS n FROM transactions WHERE order_id = 8002 AND kind = 'refund'"), 1);
    assert.equal(await count("SELECT COUNT(*) AS n FROM outbox WHERE type = 'payment.refunded' AND aggregate_id = 8002"), 1);

    const tx = await request(app.base, "/api/customer/transactions", { token: customer });
    assert.equal(tx.status, 200);
    assert.ok(tx.body.some((t) => t.order_id === 8002 && t.kind === "refund"));
  });

  await t.test("customer transactions are scoped to the caller", async () => {
    const res = await request(app.base, "/api/customer/transactions", { token: tokenFor("customer", 2) });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, [], "customer#2 sees none of customer#1's charges or refunds");
  });

  await t.test("booking.cancelled on an UNPAID order voids the intent; a late webhook then charges nothing", async () => {
    const created = await createIntent(app.base, intentBody(8005));
    await sendEvent(app.base, { source: "monolith", id: 5, type: "booking.cancelled", payload: { order_id: 8005, payment_status: "pending" } });
    assert.equal((await sql("SELECT status FROM payment_intents WHERE order_id = 8005"))[0].status, "canceled");

    const late = await webhook(app.base, { gateway_event_id: "evt-late", type: "payment_intent.succeeded", gateway_ref: created.body.gateway_ref });
    assert.equal(late.status, 200);
    assert.equal(late.body.already_settled, true);
    assert.equal(await count("SELECT COUNT(*) AS n FROM transactions WHERE order_id = 8005"), 0);
  });

  await t.test("relay: broker down -> nothing published; back up -> every event published in order, once", async () => {
    const published = [];
    const state = { down: false };
    const publisher = {
      publish(exchange, routingKey, content, options, cb) {
        if (state.down) { cb(new Error("broker down")); return false; }
        published.push({ routingKey, messageId: options.messageId, envelope: JSON.parse(content.toString()) });
        cb(null);
        return true;
      },
    };

    state.down = true;
    assert.equal(await runRelayOnce({ publisher }), 0);
    assert.ok(await count("SELECT COUNT(*) AS n FROM outbox WHERE published_at IS NULL") > 0);

    state.down = false;
    const sent = await runRelayOnce({ publisher });
    const expected = await count("SELECT COUNT(*) AS n FROM outbox");
    assert.equal(sent, expected);
    assert.equal(published.length, expected);
    assert.ok(published.every((m) => m.envelope.source === "payments"));
    assert.ok(published.every((m) => m.messageId === `payments:${m.envelope.id}`));
    const ids = published.map((m) => m.envelope.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
    assert.deepEqual(
      [...new Set(published.map((m) => m.routingKey))].sort(),
      ["payment.refunded", "payment.succeeded"]
    );

    assert.equal(await runRelayOnce({ publisher }), 0, "second pass publishes nothing");
    assert.equal(published.length, expected, "no re-publish after confirm");
  });
});
