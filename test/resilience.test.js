import { test } from "node:test";
import assert from "node:assert/strict";
import { freshBoot, getDb, fake } from "../test-helpers/boot.js";
import { call } from "../test-helpers/call.js";
import { loginSeededCustomer, loginSeededProvider, futureWeekday } from "../test-helpers/auth.js";
import { config } from "../lib/config.js";
import { backoffDelay } from "../lib/clients/payments.js";

import * as bookings from "../app/api/bookings/route.js";

freshBoot();

const orderRow = (id) => getDb().prepare("SELECT status, payment_status, gateway_ref FROM orders WHERE id = ?").get(id);
const maxOrderId = () => getDb().prepare("SELECT COALESCE(MAX(id), 0) AS id FROM orders").get().id;
const count = (sql, ...args) => getDb().prepare(sql).get(...args).n;

test("backoffDelay: exponential cap with full jitter", () => {
  const opts = { baseMs: 200, capMs: 2000 };
  for (let attempt = 0; attempt < 6; attempt++) assert.equal(backoffDelay(attempt, opts, () => 0), 0);
  const ceilings = [0, 1, 2, 3, 4, 5].map((a) => backoffDelay(a, opts, () => 0.999999));
  assert.deepEqual(ceilings, [199, 399, 799, 1599, 1999, 1999]);
  for (let i = 0; i < 200; i++) {
    const d = backoffDelay(2, opts);
    assert.ok(d >= 0 && d < 800, `delay ${d} out of range`);
  }
});

test("booking -> payments resilience", async (t) => {
  const customer = await loginSeededCustomer("nong@example.com");
  const provider = await loginSeededProvider("sparkle@example.com");
  const addressId = getDb().prepare("SELECT id FROM addresses WHERE customer_id = ? LIMIT 1").get(customer.id).id;
  const date = futureWeekday(3);
  const place = (starting_time) =>
    call(bookings.POST, {
      token: customer.token,
      body: {
        provider_id: provider.id, address_id: addressId, service_date: date,
        starting_time, items: [{ service_id: 2, quantity: 1 }], payment_method: "gateway",
      },
    });
  const assertSingleIntent = (res) => {
    assert.equal(res.status, 201);
    assert.equal(fake.intents.size, 1, "exactly one intent was stored");
    const keys = new Set(fake.intentCalls.map((c) => c.headers.get("idempotency-key")));
    assert.deepEqual([...keys], [String(res.body.order.id)], "every attempt carried the same Idempotency-Key");
    const [stored] = [...fake.intents.values()];
    assert.equal(res.body.payment_intent.gateway_ref, stored.gateway_ref);
    assert.equal(orderRow(res.body.order.id).gateway_ref, stored.gateway_ref);
  };

  await t.test("fault 1: reply lost after the write -> retried, saved exactly once", async () => {
    fake.reset();
    fake.loseReplies = 1;
    const res = await place("09:00");
    assertSingleIntent(res);
    assert.equal(fake.intentCalls.length, 2);
  });

  await t.test("fault 2: reply slower than the timeout -> retried, saved exactly once", async () => {
    fake.reset();
    fake.slowReplies = 1;
    const res = await place("10:00");
    assertSingleIntent(res);
    assert.equal(fake.intentCalls.length, 2);
  });

  await t.test("fault 3a: a short outage is ridden out by the retries", async () => {
    fake.reset();
    fake.failNextCalls = config.paymentsMaxRetries;
    const res = await place("11:00");
    assertSingleIntent(res);
    assert.equal(fake.intentCalls.length, config.paymentsMaxRetries + 1);
  });

  await t.test("fault 3b: an outage that outlasts the retries -> 503 and the saga compensates", async () => {
    fake.reset();
    fake.failNextCalls = 1000;
    const id = maxOrderId() + 1;
    const res = await place("12:00");
    const attempts = fake.intentCalls.length;
    assert.equal(fake.intents.size, 0, "no intent was ever stored");
    fake.reset();

    assert.equal(res.status, 503);
    assert.equal(attempts, config.paymentsMaxRetries + 1, "1 attempt + maxRetries retries, then it gives up");
    assert.equal(orderRow(id).status, "cancelled", "order cancelled, not stuck");
    assert.equal(count("SELECT COUNT(*) AS n FROM slot_holds WHERE order_id = ?", id), 0, "slot released");
    assert.equal(
      count("SELECT COUNT(*) AS n FROM events WHERE type = 'booking.cancelled' AND aggregate_id = ?", id), 1,
      "Payments is told to void any intent it may have created"
    );
    const again = await place("12:00");
    assert.equal(again.status, 201, "the released slot can be booked again once Payments is back");
  });
});
