// Step 6 (E4): the trace continues through Payments' side of RabbitMQ. A booking.cancelled delivery
// carrying the monolith's traceparent runs its handler inside a consumer span; the payment.refunded
// row it writes to the outbox keeps that trace, and the relay's publish span continues it. Real
// handleDelivery(), service and relay; spans go to an in-memory exporter, the broker is a fake publisher.
// Step 6 (E5): the request id rides along as W3C baggage, through the body parser, the outbox and the
// AMQP headers, so every log line on the way can carry it.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { boot, sql, createIntent, request, config } from "./helpers.js";
import { NodeSDK, tracing } from "@opentelemetry/sdk-node";
import { SpanKind, trace } from "@opentelemetry/api";

// No resource detectors: their async attributes would make SimpleSpanProcessor export later.
const exporter = new tracing.InMemorySpanExporter();
const sdk = new NodeSDK({ spanProcessors: [new tracing.SimpleSpanProcessor(exporter)], resourceDetectors: [] });
sdk.start();

// Dynamic on purpose: src/ must evaluate after helpers.js has set the test env.
const { handleDelivery } = await import("../src/amqp.js");
const service = await import("../src/service.js");
const { correlation } = await import("../src/logger.js");
const { runRelayOnce } = await import("../src/relay.js");

const app = await boot();
after(async () => { await app.close(); await sdk.shutdown(); });

const spans = (name) => exporter.getFinishedSpans().filter((s) => s.name === name);
const parentId = (span) => span.parentSpanContext?.spanId ?? span.parentSpanId;

test("booking.cancelled -> refund -> payment.refunded publish stays in the caller's trace", async () => {
  const ORDER = 8101;
  const intent = (await createIntent(app.base, { order_id: ORDER, customer_id: 1, provider_id: 1, amount_cents: 10700 })).body;
  const paid = await request(app.base, "/api/payments/webhook", {
    body: { gateway_event_id: "evt-e4", type: "payment_intent.succeeded", gateway_ref: intent.gateway_ref },
    headers: { "x-webhook-secret": config.webhookSecret, "x-request-id": "req-e5-webhook" },
  });
  assert.equal(paid.status, 200);
  // E5: the handler ran after express.json() with the request id still in its context.
  const [succeeded] = await sql("SELECT trace_context FROM outbox WHERE type = 'payment.succeeded' AND aggregate_id = $1", [ORDER]);
  assert.deepEqual(succeeded.trace_context, { baggage: "request_id=req-e5-webhook" });
  await runRelayOnce({ publisher: { publish: (_e, _k, _c, _o, cb) => { cb(null); return true; } } });   // drain payment.succeeded
  exporter.reset();

  // What the monolith's relay would send: its publish span's traceparent in the AMQP headers.
  const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
  const monolithPublishSpanId = "00f067aa0ba902b7";
  const envelope = { source: "monolith", id: 9001, type: "booking.cancelled", payload: { order_id: ORDER, reason: "customer_cancelled" } };
  const msg = {
    content: Buffer.from(JSON.stringify(envelope)),
    properties: { messageId: "monolith:9001", headers: {
      traceparent: `00-${traceId}-${monolithPublishSpanId}-01`, baggage: "request_id=req-e5-cancel",
    } },
    fields: { routingKey: "booking.cancelled", redelivered: false },
  };
  const acks = [];
  let fields;
  await handleDelivery({ ack: () => acks.push("ack"), nack: () => acks.push("nack") }, msg,
    (e) => { fields = correlation(); return service.handleEvent(e); }, console, { queue: "payments.events" });
  assert.deepEqual(acks, ["ack"]);
  assert.equal(fields.request_id, "req-e5-cancel", "E5: the consumer's log lines carry the monolith request's id");
  assert.equal(fields.trace_id, traceId);

  const [consumer] = spans("process booking.cancelled");
  assert.equal(consumer.kind, SpanKind.CONSUMER);
  assert.equal(consumer.spanContext().traceId, traceId);
  assert.equal(parentId(consumer), monolithPublishSpanId);

  const [row] = await sql("SELECT trace_context FROM outbox WHERE type = 'payment.refunded' AND aggregate_id = $1", [ORDER]);
  assert.equal(row.trace_context.traceparent, `00-${traceId}-${consumer.spanContext().spanId}-01`);
  assert.equal(row.trace_context.baggage, "request_id=req-e5-cancel");

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

test("outside any request or trace the outbox row keeps NULL", async () => {
  assert.equal(trace.getActiveSpan(), undefined);
  assert.deepEqual(correlation(), {});
  const { insertOutbox } = await import("../src/repository.js");
  const { getPool } = await import("../src/db.js");
  await insertOutbox(getPool(), "payment.refunded", "order", 8199, {});
  const [row] = await sql("SELECT trace_context FROM outbox WHERE aggregate_id = 8199");
  assert.equal(row.trace_context, null);
});
