// RabbitMQ plumbing: topology, a confirm-channel publisher for the outbox relay, and a consumer loop.
//
// NOTE: this file is copied verbatim to services/payments/src/amqp.js and
// services/notifications/src/amqp.js (only the config import path differs). Change all three
// together: every process asserts the same topology on connect, and queues whose arguments differ
// fail with PRECONDITION_FAILED. test/amqp-copies.test.js checks the copies still match.
import amqp from "amqplib";
import { config } from "../config.js";

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
export function publish(channel, envelope, { timeoutMs = config.publishTimeoutMs } = {}) {
  const confirmed = new Promise((resolve, reject) => {
    channel.publish(
      EXCHANGE,
      envelope.type,
      Buffer.from(JSON.stringify(envelope)),
      { persistent: true, contentType: "application/json", messageId: `${envelope.source}:${envelope.id}` },
      (err) => (err ? reject(err) : resolve()),
    );
  });
  return withTimeout(confirmed, timeoutMs, `publish ${envelope.type}`);
}

// ---------------------------------------------------------------- consumer

// Handles one delivery. The handler runs the DB transaction (inbox dedupe row + effect), so calling it
// again after a failure is safe. A failure is retried in-process with exponential backoff first, so a
// dependency that is briefly down (e.g. Postgres restarting) does not burn the queue's 3-delivery limit
// within milliseconds and dead-letter a real event. Only after every retry fails is the message nacked
// back to the broker. ack/nack never throw out of here: if the channel closed meanwhile, the broker
// redelivers the unacked message on its own and the inbox makes the redelivery a no-op. `isOpen` lets
// the caller stop the retries once the channel is gone, since the broker is redelivering it anyway.
export async function handleDelivery(ch, msg, handle, log = console, {
  retries = config.consumerRetries,
  baseMs = config.consumerRetryBaseMs,
  wait = sleep,
  isOpen = () => true,
} = {}) {
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

  for (let attempt = 0; ; attempt++) {
    try {
      await handle(envelope, msg);
      return settle("ack");
    } catch (err) {
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
        handleDelivery(ch, msg, handle, log, { isOpen: () => current === c, ...delivery })
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
