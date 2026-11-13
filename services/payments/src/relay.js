// Payments' outbox relay. Same contract as the monolith's: publish each payment.* event, in id order,
// to the RabbitMQ exchange on a confirm channel (the monolith and notifications consume it from their
// own queues), and only once the broker confirms it stamp published_at. A failure stops the pass; the
// event is retried next tick. Consumers dedupe on "<source>:<id>" built from the envelope.
// (Single instance assumed: two replicas would need SELECT ... FOR UPDATE SKIP LOCKED + ordering care.)
import { getPool } from "./db.js";
import * as repository from "./repository.js";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { getPublisher, publish, dropPublisher } from "./amqp.js";

export const SOURCE = "payments";
let busy = false;
let timer;

export function toEnvelope(row) {
  return {
    source: SOURCE,
    id: row.id,
    type: row.type,
    aggregate_type: row.aggregate_type,
    aggregate_id: row.aggregate_id,
    payload: row.payload,
    occurred_at: new Date(row.created_at).toISOString(),
  };
}


// `publisher` / `publishTimeoutMs` let tests inject a fake channel and a short confirm timeout.
export async function runRelayOnce({ publisher, publishTimeoutMs } = {}) {
  if (busy) return 0;
  busy = true;
  let published = 0;
  try {
    const db = getPool();
    for (const row of await repository.listUnpublished(db, 100)) {
      const envelope = toEnvelope(row);
      try {
        await publish(publisher ?? (await getPublisher()), envelope, { timeoutMs: publishTimeoutMs });
      } catch (err) {
        logger.warn({ err: err.message, eventId: row.id, type: row.type }, "relay: delivery failed, will retry");
        if (!publisher) dropPublisher(); // a failed or timed-out channel is not reused next tick
        break;
      }
      published += await repository.markPublished(db, row.id);
    }
  } finally {
    busy = false;
  }
  return published;
}

export function startRelay() {
  if (timer) return;
  timer = setInterval(() => {
    runRelayOnce().catch((err) => logger.error({ err: err.message }, "relay: pass failed"));
  }, config.relayIntervalMs);
  timer.unref?.();
  logger.info("outbox relay started (publishing to RabbitMQ)");
}

export function stopRelay() {
  clearInterval(timer);
  timer = undefined;
}
