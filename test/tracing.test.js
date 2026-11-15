// Step 6 (E4): a trace continues across RabbitMQ. The outbox row keeps the trace context of the
// request that wrote the event, the relay's publish span is its child and puts its traceparent in the
// AMQP headers, and every consumer attempt is a span under that publish span, with the handler
// running inside it. Real relay, real publish() and handleDelivery(); spans go to an in-memory
// exporter instead of Jaeger.
import { freshBoot, getDb, fake, fakeBroker } from "../test-helpers/boot.js";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { NodeSDK, tracing } from "@opentelemetry/sdk-node";
import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { call } from "../test-helpers/call.js";
import { loginAdmin } from "../test-helpers/auth.js";
import { runRelayOnce } from "../lib/outbox/relay.js";
import { handleDelivery } from "../lib/amqp/connection.js";
import { insertEvent } from "../lib/db/events.js";
import * as approve from "../app/api/admin/providers/[id]/approve/route.js";

freshBoot();

// No resource detectors: their async attributes would make SimpleSpanProcessor export later.
const exporter = new tracing.InMemorySpanExporter();
const sdk = new NodeSDK({ spanProcessors: [new tracing.SimpleSpanProcessor(exporter)], resourceDetectors: [] });
sdk.start();
after(() => sdk.shutdown());

const tracer = trace.getTracer("test");
const spans = (name) => exporter.getFinishedSpans().filter((s) => s.name === name);
const parentId = (span) => span.parentSpanContext?.spanId ?? span.parentSpanId;
const ackChannel = { ack() {}, nack() {} };
const toAmqpMessage = (m) => ({
  content: Buffer.from(JSON.stringify(m.envelope)),
  properties: m.properties,
  fields: { routingKey: m.routingKey, redelivered: false },
});

test("request -> outbox -> publish -> consume is one trace", async () => {
  fake.reset();
  exporter.reset();
  const admin = await loginAdmin();
  const glowId = getDb().prepare("SELECT id FROM providers WHERE email = 'glow@example.com'").get().id;

  // The approval request, as Next's SERVER span would be in production.
  const request = await tracer.startActiveSpan("POST /api/admin/providers/:id/approve", async (span) => {
    const res = await call(approve.POST, { token: admin.token, params: { id: String(glowId) }, method: "POST" });
    assert.equal(res.status, 200);
    span.end();
    return span;
  });
  const traceId = request.spanContext().traceId;

  const row = getDb().prepare("SELECT trace_context FROM events WHERE type = 'provider.approved'").get();
  assert.match(JSON.parse(row.trace_context).traceparent, new RegExp(`^00-${traceId}-`), "the row keeps the request's trace");

  // The relay runs later, from its own timer: no active span here.
  await runRelayOnce({ publisher: fakeBroker.channel });
  const [publishSpan] = spans("publish provider.approved");
  assert.ok(publishSpan, "the relay opens a publish span");
  assert.equal(publishSpan.kind, SpanKind.PRODUCER);
  assert.equal(publishSpan.spanContext().traceId, traceId);
  assert.equal(parentId(publishSpan), request.spanContext().spanId);

  const message = fakeBroker.published.find((m) => m.routingKey === "provider.approved");
  assert.equal(message.properties.headers.traceparent,
    `00-${traceId}-${publishSpan.spanContext().spanId}-01`, "the AMQP headers carry the publish span");

  // A consumer that fails once: two attempt spans, both under the publish span; the handler runs inside.
  let calls = 0;
  let seenTraceId;
  await handleDelivery(ackChannel, toAmqpMessage(message), async () => {
    seenTraceId = trace.getActiveSpan()?.spanContext().traceId;
    if (++calls === 1) throw new Error("db blip");
  }, console, { queue: "notifications.events", retries: 1, wait: async () => {} });

  assert.equal(seenTraceId, traceId, "the handler runs inside the consumer span");
  const attempts = spans("process provider.approved");
  assert.equal(attempts.length, 2);
  for (const s of attempts) {
    assert.equal(s.kind, SpanKind.CONSUMER);
    assert.equal(s.spanContext().traceId, traceId);
    assert.equal(parentId(s), publishSpan.spanContext().spanId);
    assert.equal(s.attributes["messaging.destination.name"], "notifications.events");
  }
  assert.deepEqual(attempts.map((s) => s.attributes["edemand.attempt"]), [1, 2]);
  assert.deepEqual(attempts.map((s) => s.status.code), [SpanStatusCode.ERROR, SpanStatusCode.UNSET]);
});

test("an event written outside any trace starts a new one at publish", async () => {
  fake.reset();
  exporter.reset();
  getDb().transaction(() => insertEvent("booking.cancelled", "order", 1, { reason: "payment_timeout" }))();
  const row = getDb().prepare("SELECT trace_context FROM events WHERE type = 'booking.cancelled'").get();
  assert.equal(row.trace_context, null);

  await runRelayOnce({ publisher: fakeBroker.channel });
  const [publishSpan] = spans("publish booking.cancelled");
  assert.ok(publishSpan);
  assert.equal(parentId(publishSpan), undefined, "a root span");
  const message = fakeBroker.published.find((m) => m.routingKey === "booking.cancelled");
  assert.match(message.properties.headers.traceparent, new RegExp(`^00-${publishSpan.spanContext().traceId}-`));
});

test("a failed publish is an ERROR span and the event is retried in the same trace", async () => {
  fake.reset();
  exporter.reset();
  await tracer.startActiveSpan("request", async (span) => {
    getDb().transaction(() => insertEvent("bid.accepted", "order", 2, {}))();
    span.end();
  });
  fakeBroker.down = true;
  await runRelayOnce({ publisher: fakeBroker.channel });
  fakeBroker.down = false;
  await runRelayOnce({ publisher: fakeBroker.channel });

  const publishes = spans("publish bid.accepted");
  assert.equal(publishes.length, 2);
  assert.deepEqual(publishes.map((s) => s.status.code), [SpanStatusCode.ERROR, SpanStatusCode.UNSET]);
  assert.equal(new Set(publishes.map((s) => s.spanContext().traceId)).size, 1);
});
