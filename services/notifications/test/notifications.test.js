import { test, after } from "node:test";
import assert from "node:assert/strict";
import { boot, tokenFor, request, sendEvent } from "./helpers.js";

const app = await boot();
after(() => app.close());

const PROVIDER = 1;
const CUSTOMER = 1;
const provider = tokenFor("provider", PROVIDER);
const customer = tokenFor("customer", CUSTOMER);

test("notifications service", async (t) => {
  await t.test("/health is 200; /ready reaches Postgres", async () => {
    assert.equal((await request(app.base, "/health")).status, 200);
    const ready = await request(app.base, "/ready");
    assert.equal(ready.status, 200);
    assert.equal(ready.body.status, "ok");
  });

  await t.test("X-Request-Id is echoed back", async () => {
    const res = await request(app.base, "/health", { headers: { "x-request-id": "abc-123" } });
    assert.equal(res.headers.get("x-request-id"), "abc-123");
  });

  await t.test("GET /api/notifications: 401 without a token, [] for a fresh user", async () => {
    assert.equal((await request(app.base, "/api/notifications")).status, 401);
    assert.equal((await request(app.base, "/api/notifications", { token: "garbage" })).status, 401);
    const res = await request(app.base, "/api/notifications", { token: provider });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, []);
  });

  await t.test("/internal/events rejects a missing or wrong internal token", async () => {
    const env = { source: "monolith", id: 1, type: "provider.approved", payload: { provider_id: PROVIDER } };
    assert.equal((await sendEvent(app.base, env, "nope")).status, 401);
    assert.equal((await request(app.base, "/internal/events", { body: env })).status, 401);
  });

  await t.test("provider.approved -> one 'provider_approved' message; a redelivery is a no-op", async () => {
    const env = { source: "monolith", id: 10, type: "provider.approved", payload: { provider_id: PROVIDER } };
    const first = await sendEvent(app.base, env);
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, { received: true, duplicate: false, created: 1 });

    const again = await sendEvent(app.base, env);
    assert.equal(again.status, 200);
    assert.equal(again.body.duplicate, true);

    const list = await request(app.base, "/api/notifications", { token: provider });
    assert.equal(list.body.filter((n) => n.type === "provider_approved").length, 1);
  });

  await t.test("the same id from a DIFFERENT source is a different event", async () => {
    const env = { source: "payments", id: 10, type: "payment.succeeded", payload: { order_id: 8001, provider_id: PROVIDER, amount_cents: 64200 } };
    const res = await sendEvent(app.base, env);
    assert.equal(res.body.duplicate, false);
    assert.equal(res.body.created, 1);
  });

  await t.test("booking.status_changed notifies the counterparty of the actor", async () => {
    await sendEvent(app.base, {
      source: "monolith", id: 11, type: "booking.status_changed",
      payload: { order_id: 8001, from: "awaiting", to: "confirmed", customer_id: CUSTOMER, provider_id: PROVIDER, actor_role: "provider" },
    });
    const list = await request(app.base, "/api/notifications", { token: customer });
    const msg = list.body.find((n) => n.type === "booking_status");
    assert.ok(msg, "customer was notified");
    assert.equal(msg.title, "Booking confirmed");
    assert.equal(msg.order_id, 8001);
  });

  await t.test("bid.accepted notifies the winner and every loser", async () => {
    const res = await sendEvent(app.base, {
      source: "monolith", id: 12, type: "bid.accepted",
      payload: { job_request_id: 2, order_id: 8002, winner_provider_id: 2, loser_provider_ids: [3, 4] },
    });
    assert.equal(res.body.created, 3);
  });

  await t.test("an unknown event type is acknowledged and recorded, but creates nothing", async () => {
    const res = await sendEvent(app.base, { source: "monolith", id: 13, type: "booking.cancelled", payload: { order_id: 8001 } });
    assert.equal(res.status, 200);
    assert.equal(res.body.created, 0);
  });

  await t.test("invalid envelope -> 400 with details", async () => {
    const res = await sendEvent(app.base, { source: "monolith", type: "x" });
    assert.equal(res.status, 400);
    assert.ok(Array.isArray(res.body.details));
  });

  await t.test("mark read: owner 200, someone else 403, unknown 404", async () => {
    const list = await request(app.base, "/api/notifications", { token: provider });
    const n = list.body[0];
    const stranger = await request(app.base, `/api/notifications/${n.id}/read`, { method: "POST", token: tokenFor("provider", 99) });
    assert.equal(stranger.status, 403);
    const missing = await request(app.base, "/api/notifications/999999/read", { method: "POST", token: provider });
    assert.equal(missing.status, 404);

    // The browser reaches this through the gateway with only the httpOnly cookie, so cookie auth works too.
    const ok = await request(app.base, `/api/notifications/${n.id}/read`, {
      method: "POST", headers: { cookie: `edemand_token=${provider}` },
    });
    assert.equal(ok.status, 200);
    assert.ok(ok.body.read_at);
  });
});
