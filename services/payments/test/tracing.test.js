// Step 6 (E4): the trace continues through Payments' side of RabbitMQ. A booking.cancelled delivery
// carrying the monolith's traceparent runs its handler inside a consumer span; the payment.refunded
// row it writes to the outbox keeps that trace, and the relay's publish span continues it. Real
// handleDelivery(), service and relay; spans go to an in-memory exporter, the broker is a fake publisher.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { boot, sql, createIntent, webhook } from "./helpers.js";
import { NodeSDK, tracing } from "@opentelemetry/sdk-node";
import { SpanKind, trace } from "@opentelemetry/api";

// No resource detectors: their async attributes would make SimpleSpanProcessor export later.
const exporter = new tracing.InMemorySpanExporter();
const sdk = new NodeSDK({ spanProcessors: [new tracing.SimpleSpanProcessor(exporter)], resourceDetectors: [] });
sdk.start();

// Dynamic on purpose: src/ must evaluate after helpers.js has set the test env.
const { handleDelivery } = await import("../src/amqp.js");
const service = await import("../src/service.js");
const { runRelayOnce } = await import("../src/relay.js");

const app = await boot();
after(async () => { await app.close(); await sdk.shutdown(); });

const spans = (name) => exporter.getFinishedSpans().filter((s) => s.name === name);
const parentId = (span) => span.parentSpanContext?.spanId ?? span.parentSpanId;

test("booking.cancelled -> refund -> payment.refunded publish stays in the caller's trace", async () => {
  const ORDER = 8101;
  const intent = (await createIntent(app.base, { order_id: ORDER, customer_id: 1, provider_id: 1, amount_cents: 10700 })).body;
  const paid = await webhook(app.base, { gateway_event_id: "evt-e4", type: "payment_intent.succeeded", gateway_ref: intent.gateway_ref });
  assert.equal(paid.status, 200);
  await runRelayOnce({ publisher: { publish: (_e, _k, _c, _o, cb) => { cb(null); return true; } } });   // drain payment.succeeded
  exporter.reset();

  // What the monolith's relay would send: its publish span's traceparent in the AMQP headers.
  const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
  const monolithPublishSpanId = "00f067aa0ba902b7";
  const envelope = { source: "monolith", id: 9001, type: "booking.cancelled", payload: { order_id: ORDER, reason: "customer_cancelled" } };
  const msg = {
    content: Buffer.from(JSON.stringify(envelope)),
    properties: { messageId: "monolith:9001", headers: { traceparent: `00-${traceId}-${monolithPublishSpanId}-01` } },
    fields: { routingKey: "booking.cancelled", redelivered: false },
  };
  const acks = [];
  await handleDelivery({ ack: () => acks.push("ack"), nack: () => acks.push("nack") }, msg,
    (e) => service.handleEvent(e), console, { queue: "payments.events" });
  assert.deepEqual(acks, ["ack"]);

  const [consumer] = spans("process booking.cancelled");
  assert.equal(consumer.kind, SpanKind.CONSUMER);
  assert.equal(consumer.spanContext().traceId, traceId);
  assert.equal(parentId(consumer), monolithPublishSpanId);

  const [row] = await sql("SELECT trace_context FROM outbox WHERE type = 'payment.refunded' AND aggregate_id = $1", [ORDER]);
  assert.equal(row.trace_context.traceparent, `00-${traceId}-${consumer.spanContext().spanId}-01`);

  const published = [];
  await runRelayOnce({
    publisher: { publish(_e, routingKey, _c, options, cb) { published.push({ routingKey, options }); cb(null); return true; } },
  });
  const [publishSpan] = spans("publish payment.refunded");
  assert.equal(publishSpan.kind, SpanKind.PRODUCER);
  assert.equal(publishSpan.spanContext().traceId, traceId);
  assert.equal(parentId(publishSpan), consumer.spanContext().spanId);
  const refunded = published.find((m) => m.routingKey === "payment.refunded");
  assert.equal(refunded.options.headers.traceparent, `00-${traceId}-${publishSpan.spanContext().spanId}-01`);
});

test("without a trace the outbox row keeps NULL", async () => {
  assert.equal(trace.getActiveSpan(), undefined);
  const rows = await sql("SELECT trace_context FROM outbox WHERE type = 'payment.succeeded'");
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.trace_context === null), "the webhook ran without an HTTP span in tests");
});
