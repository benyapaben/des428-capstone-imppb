// RabbitMQ plumbing: topology, a confirm-channel publisher for the outbox relay, and a consumer loop.
//
// NOTE: this file is copied verbatim to services/payments/src/amqp.js and
// services/notifications/src/amqp.js (only the config import path differs). Change all three
// together: every process asserts the same topology on connect, and queues whose arguments differ
// fail with PRECONDITION_FAILED. test/amqp-copies.test.js checks the copies still match.
//
// Step 6 (E4): a trace continues across RabbitMQ through the message headers. publish() opens a
// PRODUCER span ("publish <type>") as a child of the trace context the outbox row stored when the
// event was written, and puts that span's `traceparent` in the AMQP headers; handleDelivery() opens a
// CONSUMER span ("process <type>") per attempt as a child of it, and runs the handler inside it — so the
// handler's own spans (SQL, the events it writes to its outbox) join the same trace. amqplib is not
// auto-instrumented: it would hang the publish off the relay's timer tick, not off the request that
// caused the event. Without an OpenTelemetry SDK (tests) every span is a no-op and no header is sent.
//
// Step 6 (E6): every handler attempt is also one observation of messaging_process_duration_seconds
// {queue, type, outcome="success"|"error"} in prom-client's default registry, which /metrics serves —
// RED for the event side (rate, failed attempts, handling time), next to the HTTP histogram.
import amqp from "amqplib";
import client from "prom-client";
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, context, propagation, trace } from "@opentelemetry/api";
import { config } from "./config.js";

export const EXCHANGE = "edemand.events";
export const DLX = "edemand.dlx";

// queue -> routing keys it listens to (routing key = event type)
export const QUEUES = {
  "payments.events": ["booking.completed", "booking.cancelled"],
  "booking.events": ["payment.succeeded", "payment.refunded", "review.created"],
  "notifications.events": [
    "booking.status_changed", "booking.completed", "bid.accepted",
    "review.created", "provider.approved", "payment.succeeded", "payment.refunded",
  ],
};

export async function assertTopology(ch) {
  await ch.assertExchange(EXCHANGE, "topic", { durable: true });
  await ch.assertExchange(DLX, "direct", { durable: true });
  for (const [queue, keys] of Object.entries(QUEUES)) {
    await ch.assertQueue(`${queue}.dlq`, { durable: true });
    await ch.bindQueue(`${queue}.dlq`, DLX, queue);
    await ch.assertQueue(queue, {
      durable: true,
      arguments: {
        "x-queue-type": "quorum",
        "x-delivery-limit": 3,
        "x-dead-letter-exchange": DLX,
        "x-dead-letter-routing-key": queue,
      },
    });
    for (const key of keys) await ch.bindQueue(queue, EXCHANGE, key);
  }
}

const tracer = trace.getTracer("edemand-amqp");

// Reused if the registry already has it (in Next.js this module can be evaluated once per bundle).
const processDuration = client.register.getSingleMetric("messaging_process_duration_seconds") ??
  new client.Histogram({
    name: "messaging_process_duration_seconds",
    help: "RabbitMQ deliveries handled, one per in-process attempt (outcome = success | error)",
    labelNames: ["queue", "type", "outcome"],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  });

// The attributes every messaging span carries (OpenTelemetry messaging semantic conventions).
function messagingAttributes(operation, envelope, destination) {
  return {
    "messaging.system": "rabbitmq",
    "messaging.operation.name": operation,
    "messaging.destination.name": destination,
    "messaging.rabbitmq.destination.routing_key": envelope.type,
    "messaging.message.id": `${envelope.source}:${envelope.id}`,
  };
}

function endSpan(span, err) {
  if (err) {
    span.recordException(err);
    span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
  }
  span.end();
}

const defaultConnect = (url) => amqp.connect(url);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// close() on an amqplib connection rejects if it is already closing; that is fine to ignore here.
function closeQuietly(c) {
  try { Promise.resolve(c.close()).catch(() => {}); } catch { /* already closed */ }
}

// Rejects if `promise` has not settled within `ms`.
export function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------- publisher (used by the outbox relay)

let conn, pubCh, blocked = false;

// One cached confirm channel per process. It is forgotten as soon as its channel or connection
// closes, so the next call opens a fresh one instead of publishing into a dead channel forever.
export async function getPublisher({ connect = defaultConnect } = {}) {
  if (pubCh) return pubCh;
  const c = await connect(config.amqpUrl);
  c.on("error", () => {});                                     // the 'close' that follows does the work
  c.on("close", () => { if (conn === c) { conn = pubCh = undefined; blocked = false; } });
  // The broker blocks publishing connections during a memory/disk alarm; confirms then simply stop.
  c.on("blocked", () => { if (conn === c) blocked = true; });
  c.on("unblocked", () => { if (conn === c) blocked = false; });
  try {
    const ch = await c.createConfirmChannel();
    ch.on("error", () => {});                                  // a server-closed channel emits 'error', then 'close'
    ch.on("close", () => { if (pubCh === ch) dropPublisher(); });
    await assertTopology(ch);
    conn = c;
    pubCh = ch;
    return ch;
  } catch (err) {
    closeQuietly(c);                                           // do not leak a connection per failed attempt
    throw err;
  }
}

// Forget (and close) the cached publisher. The relay calls this after a failed or timed-out publish.
// Not while the broker has the connection blocked: the channel is healthy, a fresh connection would be
// blocked too, and close() on a blocked connection never completes — so each tick would leak one.
export function dropPublisher() {
  if (blocked) return;
  const c = conn;
  conn = pubCh = undefined;
  if (c) closeQuietly(c);
}

// Resolves only after the broker confirms the message; rejects on a nack, a closed channel, or when no
// confirm arrives within timeoutMs (e.g. a broker blocked by a memory or disk alarm).
// `traceContext` is the carrier the outbox stored with the event ({ traceparent, ... }); without one
// (an event written outside any trace, e.g. by the saga timeout) the publish span starts a new trace.
export async function publish(channel, envelope, { timeoutMs = config.publishTimeoutMs, traceContext } = {}) {
  const parent = traceContext ? propagation.extract(ROOT_CONTEXT, traceContext) : context.active();
  const span = tracer.startSpan(`publish ${envelope.type}`, {
    kind: SpanKind.PRODUCER,
    attributes: messagingAttributes("publish", envelope, EXCHANGE),
  }, parent);
  const headers = {};
  propagation.inject(trace.setSpan(parent, span), headers);

  const confirmed = new Promise((resolve, reject) => {
    channel.publish(
      EXCHANGE,
      envelope.type,
      Buffer.from(JSON.stringify(envelope)),
      {
        persistent: true,
        contentType: "application/json",
        messageId: `${envelope.source}:${envelope.id}`,
        ...(Object.keys(headers).length > 0 && { headers }),
      },
      (err) => (err ? reject(err) : resolve()),
    );
  });
  try {
    await withTimeout(confirmed, timeoutMs, `publish ${envelope.type}`);
    endSpan(span);
  } catch (err) {
    endSpan(span, err);
    throw err;
  }
}

// ---------------------------------------------------------------- consumer

// Handles one delivery. The handler runs the DB transaction (inbox dedupe row + effect), so calling it
// again after a failure is safe. A failure is retried in-process with exponential backoff first, so a
// dependency that is briefly down (e.g. Postgres restarting) does not burn the queue's 3-delivery limit
// within milliseconds and dead-letter a real event. Only after every retry fails is the message nacked
// back to the broker. ack/nack never throw out of here: if the channel closed meanwhile, the broker
// redelivers the unacked message on its own and the inbox makes the redelivery a no-op. `isOpen` lets
// the caller stop the retries once the channel is gone, since the broker is redelivering it anyway.
//
// Step 6 (E5): the whole delivery runs in the publisher's context from the message headers — its trace
// and the request_id baggage — so the consumer's own log lines (retries, dead-lettering) and the
// handler's carry the trace_id and the request_id of the request that caused the event.
export function handleDelivery(ch, msg, handle, log = console, options = {}) {
  const parent = propagation.extract(ROOT_CONTEXT, msg.properties?.headers ?? {});
  return context.with(parent, () => deliver(ch, msg, handle, log, options));
}

async function deliver(ch, msg, handle, log, {
  retries = config.consumerRetries,
  baseMs = config.consumerRetryBaseMs,
  wait = sleep,
  isOpen = () => true,
  queue,
}) {
  const settle = (action, ...args) => {
    try {
      ch[action](msg, ...args);
    } catch (err) {
      log.warn?.({ err: err.message }, `consumer: channel closed before ${action}; the broker will redeliver`);
    }
  };

  let envelope;
  try {
    envelope = JSON.parse(msg.content.toString());
  } catch (err) {
    log.error?.({ err: err.message }, "consumer: unparseable message, dead-lettering it");
    return settle("nack", false, false);                       // retrying cannot fix bad JSON
  }

  // Each attempt is a child of the publisher's span (none in the headers: a new trace per attempt).
  const parent = context.active();
  for (let attempt = 0; ; attempt++) {
    const span = tracer.startSpan(`process ${envelope.type}`, {
      kind: SpanKind.CONSUMER,
      attributes: {
        ...messagingAttributes("process", envelope, queue ?? msg.fields?.routingKey),
        "edemand.attempt": attempt + 1,
        "edemand.redelivered": Boolean(msg.fields?.redelivered),
      },
    }, parent);
    const timer = processDuration.startTimer({ queue: queue ?? "unknown", type: envelope.type });
    try {
      await context.with(trace.setSpan(parent, span), async () => {
        await handle(envelope, msg);
        log.info?.({ queue, type: envelope.type, message_id: `${envelope.source}:${envelope.id}`, attempt: attempt + 1 },
          "consumer: processed");                              // inside the span: its span_id
      });
      timer({ outcome: "success" });
      endSpan(span);
      return settle("ack");
    } catch (err) {
      timer({ outcome: "error" });
      endSpan(span, err);
      if (attempt >= retries) {
        log.warn?.({ err: err.message, type: envelope.type, attempts: attempt + 1 },
          "consumer: handler failed, handing the message back to the broker");
        return settle("nack", false, true);
      }
      const delay = baseMs * 2 ** attempt;
      log.warn?.({ err: err.message, type: envelope.type, attempt: attempt + 1, delay }, "consumer: handler failed, retrying");
      await wait(delay);
      if (!isOpen()) {
        log.warn?.({ type: envelope.type }, "consumer: channel closed during retry backoff; leaving it to the redelivery");
        return;
      }
    }
  }
}

// Reads one queue forever. Any loss — connection closed, channel closed, consumer cancelled by the
// broker, or a failed setup — closes the connection and schedules exactly one reconnect.
export async function startConsumer(queue, handle, log = console, {
  connect = defaultConnect,
  retryDelayMs = 2000,
  delivery,
} = {}) {
  let current;                     // the live connection; close events from older ones are ignored
  let timer;

  const reconnect = (reason) => {
    current = undefined;
    if (timer) return;
    log.warn?.({ queue, reason }, "consumer: reconnecting");
    timer = setTimeout(() => { timer = undefined; run(); }, retryDelayMs);
    timer.unref?.();
  };

  const run = async () => {
    let c;
    try {
      c = await connect(config.amqpUrl);
      current = c;
      c.on("error", () => {});                                 // the 'close' that follows does the work
      c.on("close", () => { if (current === c) reconnect("connection closed"); });
      const ch = await c.createChannel();
      ch.on("error", (err) => log.warn?.({ queue, err: err.message }, "consumer: channel error"));
      ch.on("close", () => { if (current === c) closeQuietly(c); });   // channel-only close -> reconnect too
      await assertTopology(ch);
      await ch.prefetch(10);
      await ch.consume(queue, (msg) => {
        if (msg === null) {                                    // the broker cancelled us (e.g. queue deleted)
          log.warn?.({ queue }, "consumer: cancelled by the broker");
          if (current === c) closeQuietly(c);
          return;
        }
        handleDelivery(ch, msg, handle, log, { isOpen: () => current === c, queue, ...delivery })
          .catch((err) => log.error?.({ queue, err: err.message }, "consumer: delivery handling failed"));
      });
      log.info?.({ queue }, "consumer started");
    } catch (err) {
      log.warn?.({ err: err.message, queue }, "consumer: cannot start yet");
      if (c) closeQuietly(c);
      reconnect(err.message);                                  // also stops c's close event from scheduling a second run
    }
  };

  await run();
}
