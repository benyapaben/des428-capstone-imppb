// Saga (Step 4 / Area C): payment timeout and late payment. Booking is the orchestrator.
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshBoot, getDb } from "../test-helpers/boot.js";
import { call } from "../test-helpers/call.js";
import { loginSeededCustomer, loginSeededProvider, futureWeekday } from "../test-helpers/auth.js";
import { config } from "../lib/config.js";
import { receiveEvent } from "../lib/outbox/inbound.js";
import { expireUnpaidOrders } from "../lib/modules/booking/service.js";
import * as bookings from "../app/api/bookings/route.js";
import * as cancel from "../app/api/bookings/[id]/cancel/route.js";

freshBoot();

let nextEventId = 5000;
const paymentEvent = (type, payload) => ({
  source: "payments", id: nextEventId++, type, aggregate_type: "order", aggregate_id: payload.order_id, payload,
});
const orderRow = (id) => getDb().prepare("SELECT status, payment_status FROM orders WHERE id = ?").get(id);
const holds = (id) => getDb().prepare("SELECT COUNT(*) AS n FROM slot_holds WHERE order_id = ?").get(id).n;
const cancelledEvents = (id) =>
  getDb().prepare("SELECT payload_json FROM events WHERE type = 'booking.cancelled' AND aggregate_id = ? ORDER BY id")
    .all(id).map((r) => JSON.parse(r.payload_json));
const afterTimeout = () => Date.now() + (config.paymentTimeoutSeconds + 1) * 1000;

test("saga: payment timeout and late payment", async (t) => {
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

  await t.test("an unpaid gateway booking is cancelled after the timeout; slots released; Payments told to void", async () => {
    const res = await place("09:00");
    assert.equal(res.status, 201);
    const id = res.body.order.id;
    assert.ok(holds(id) > 0);

    assert.equal(expireUnpaidOrders(), 0, "not expired yet");
    assert.equal(orderRow(id).status, "awaiting");

    assert.equal(expireUnpaidOrders(afterTimeout()), 1);
    assert.equal(orderRow(id).status, "cancelled");
    assert.equal(holds(id), 0, "slots released");
    const events = cancelledEvents(id);
    assert.equal(events.length, 1);
    assert.equal(events[0].reason, "payment_timeout");

    assert.equal(expireUnpaidOrders(afterTimeout()), 0, "a second sweep does nothing");
    assert.equal(cancelledEvents(id).length, 1);

    const again = await place("09:00");
    assert.equal(again.status, 201, "the released slot can be booked again");

    // Pay the re-booked order: expireUnpaidOrders() sweeps EVERY unpaid gateway order, so leaving it
    // unpaid would make the next subtest's sweep cancel it and count 1 instead of 0.
    receiveEvent(paymentEvent("payment.succeeded", { order_id: again.body.order.id }));
    assert.equal(orderRow(again.body.order.id).payment_status, "paid");
  });

  await t.test("a PAID booking is never expired", async () => {
    const res = await place("11:00");
    const id = res.body.order.id;
    receiveEvent(paymentEvent("payment.succeeded", { order_id: id }));
    assert.equal(orderRow(id).payment_status, "paid");

    assert.equal(expireUnpaidOrders(afterTimeout()), 0);
    assert.equal(orderRow(id).status, "awaiting");
    assert.ok(holds(id) > 0);
  });

  await t.test("late payment: paid after cancel -> recorded as paid, refund requested again, then refunded", async () => {
    const res = await place("14:00");
    const id = res.body.order.id;
    const cancelled = await call(cancel.POST, { token: customer.token, params: { id: String(id) }, method: "POST" });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelledEvents(id).length, 1);

    const late = paymentEvent("payment.succeeded", { order_id: id });
    receiveEvent(late);
    assert.deepEqual(orderRow(id), { status: "cancelled", payment_status: "paid" });
    const events = cancelledEvents(id);
    assert.equal(events.length, 2, "a second booking.cancelled asks Payments to refund");
    assert.equal(events[1].reason, "late_payment");
    assert.equal(events[1].payment_status, "paid");
    assert.equal(events[1].gateway_ref, res.body.payment_intent.gateway_ref);

    assert.deepEqual(receiveEvent(late), { duplicate: true }, "redelivery is a no-op");
    assert.equal(cancelledEvents(id).length, 2, "no third event");

    receiveEvent(paymentEvent("payment.refunded", { order_id: id }));
    assert.deepEqual(orderRow(id), { status: "cancelled", payment_status: "refunded" });
  });
});