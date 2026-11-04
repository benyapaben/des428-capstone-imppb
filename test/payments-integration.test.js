// Booking <-> Payments seam (Step 2). Payments is a separate service; here it is faked in-process
// (test-helpers/fakeServices.js). What the MONOLITH must guarantee:
//   * a gateway booking calls POST /intents with Idempotency-Key = order_id and keeps a copy
//     (gateway_ref + payment_status) on the order; GET /bookings/:id reads that copy;
//   * Payments down -> 503 and the order is compensated (cancelled, slots released, booking.cancelled);
//   * payment.succeeded / payment.refunded arriving at /api/internal/events flip payment_status
//     exactly once (inbox dedupe), and the endpoint rejects callers without the internal token.
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshBoot, getDb, fake } from "../test-helpers/boot.js";
import { call } from "../test-helpers/call.js";
import { loginSeededCustomer, loginSeededProvider, futureWeekday } from "../test-helpers/auth.js";
import { config } from "../lib/config.js";

import * as bookings from "../app/api/bookings/route.js";
import * as bookingDetail from "../app/api/bookings/[id]/route.js";
import * as cancel from "../app/api/bookings/[id]/cancel/route.js";
import * as internalEvents from "../app/api/internal/events/route.js";

freshBoot();

let nextEventId = 1;
function paymentEvent(type, payload, id = nextEventId++) {
  return { source: "payments", id, type, aggregate_type: "order", aggregate_id: payload.order_id, payload };
}
function deliver(envelope, token = config.internalToken) {
  return call(internalEvents.POST, { body: envelope, headers: { "x-internal-token": token } });
}
function orderRow(id) {
  return getDb().prepare("SELECT status, payment_status, gateway_ref FROM orders WHERE id = ?").get(id);
}

test("booking <-> payments seam", async (t) => {
  const customer = await loginSeededCustomer("nong@example.com");
  const provider = await loginSeededProvider("sparkle@example.com");
  const addressId = getDb().prepare("SELECT id FROM addresses WHERE customer_id = ? LIMIT 1").get(customer.id).id;
  const date = futureWeekday(3);
  const place = (starting_time, headers = {}) =>
    call(bookings.POST, {
      token: customer.token,
      headers,
      body: {
        provider_id: provider.id, address_id: addressId, service_date: date,
        starting_time, items: [{ service_id: 2, quantity: 1 }], payment_method: "gateway",
      },
    });

  let orderId, gatewayRef;

  await t.test("gateway booking -> first id is still 8001, intent via POST /intents (Idempotency-Key = order_id)", async () => {
    const res = await place("09:00", { "x-request-id": "rid-123", traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" });
    assert.equal(res.status, 201);
    orderId = res.body.order.id;
    assert.equal(orderId, 8001);
    assert.equal(res.body.payment_intent.status, "requires_payment");
    gatewayRef = res.body.payment_intent.gateway_ref;
    assert.match(gatewayRef, /^SIM-PI-/);

    assert.equal(fake.intentCalls.length, 1);
    const { headers, body } = fake.intentCalls[0];
    assert.equal(headers.get("idempotency-key"), String(orderId));
    assert.equal(headers.get("x-internal-token"), config.internalToken);
    assert.equal(headers.get("x-request-id"), "rid-123", "request id propagated");
    assert.match(headers.get("traceparent"), /^00-0af7/, "traceparent propagated");
    assert.deepEqual(body, { order_id: orderId, amount_cents: 64200, customer_id: customer.id, provider_id: provider.id });

    assert.equal(orderRow(orderId).gateway_ref, gatewayRef, "gateway_ref copied onto the order");
  });

  await t.test("Idempotency-Key replay returns the same order + intent without calling Payments again", async () => {
    const a = await place("11:00", { "idempotency-key": "pay-idem-1" });
    const callsAfterFirst = fake.intentCalls.length;
    const b = await place("11:00", { "idempotency-key": "pay-idem-1" });
    assert.equal(b.status, 201);
    assert.equal(b.body.order.id, a.body.order.id);
    assert.equal(b.body.payment_intent.gateway_ref, a.body.payment_intent.gateway_ref);
    assert.equal(fake.intentCalls.length, callsAfterFirst, "no second POST /intents");
  });

  await t.test("GET /api/bookings/:id reads the intent copy from the order", async () => {
    const res = await call(bookingDetail.GET, { token: customer.token, params: { id: String(orderId) } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.payment_intent, {
      order_id: orderId, amount_cents: 64200, gateway_ref: gatewayRef, status: "requires_payment",
    });
  });

  await t.test("/api/internal/events without the internal token -> 401", async () => {
    const res = await deliver(paymentEvent("payment.succeeded", { order_id: orderId }), "wrong");
    assert.equal(res.status, 401);
    assert.equal(orderRow(orderId).payment_status, "pending");
  });

  await t.test("payment.succeeded -> Booking marks its order paid; a redelivery is a no-op", async () => {
    const env = paymentEvent("payment.succeeded", { order_id: orderId, amount_cents: 64200, provider_id: provider.id });
    const first = await deliver(env);
    assert.equal(first.status, 200);
    assert.equal(first.body.duplicate, false);
    assert.equal(orderRow(orderId).payment_status, "paid");

    const again = await deliver(env);
    assert.equal(again.status, 200);
    assert.equal(again.body.duplicate, true);
    const inbox = getDb().prepare("SELECT COUNT(*) AS n FROM inbox_events WHERE source = 'payments' AND event_id = ?").get(env.id).n;
    assert.equal(inbox, 1);

    const detail = await call(bookingDetail.GET, { token: customer.token, params: { id: String(orderId) } });
    assert.equal(detail.body.payment_intent.status, "succeeded");
  });

  await t.test("cancelling a paid booking emits booking.cancelled; payment.refunded flips it to refunded", async () => {
    const res = await call(cancel.POST, { token: customer.token, params: { id: String(orderId) }, method: "POST" });
    assert.equal(res.status, 200);
    assert.equal(res.body.refund_pending, true);
    assert.equal(orderRow(orderId).payment_status, "paid", "refund is asynchronous — still paid until Payments says so");

    const ev = getDb().prepare("SELECT payload_json FROM events WHERE type = 'booking.cancelled' AND aggregate_id = ?").get(orderId);
    const payload = JSON.parse(ev.payload_json);
    assert.equal(payload.payment_status, "paid");
    assert.equal(payload.gateway_ref, gatewayRef);

    await deliver(paymentEvent("payment.refunded", { order_id: orderId, amount_cents: 64200 }));
    assert.equal(orderRow(orderId).payment_status, "refunded");
  });

  await t.test("Payments down -> 503, and the order is compensated (cancelled, slots released, booking.cancelled)", async () => {
    fake.paymentsDown = true;
    const before = getDb().prepare("SELECT MAX(id) AS id FROM orders").get().id;
    const res = await place("15:00");
    fake.paymentsDown = false;

    assert.equal(res.status, 503);
    const id = before + 1;
    assert.equal(orderRow(id).status, "cancelled");
    const holds = getDb().prepare("SELECT COUNT(*) AS n FROM slot_holds WHERE order_id = ?").get(id).n;
    assert.equal(holds, 0, "slots released");
    const ev = getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'booking.cancelled' AND aggregate_id = ?").get(id).n;
    assert.equal(ev, 1, "Payments is told to void any intent it may have created");

    const retry = await place("15:00");
    assert.equal(retry.status, 201, "the released slot can be booked again once Payments is back");
  });
});
