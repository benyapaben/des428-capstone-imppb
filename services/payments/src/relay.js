// Payments' outbox relay. Same contract as the monolith's: deliver each payment.* event, in id order,
// to every subscriber (the monolith's /api/internal/events and the notifications service), and only
// then stamp published_at. A failure stops the pass; the event is retried next tick. Consumers dedupe
// by (source, id). Step 4 replaces the HTTP POST with a RabbitMQ publish.
// (Single instance assumed: two replicas would need SELECT ... FOR UPDATE SKIP LOCKED + ordering care.)
import { getPool } from "./db.js";
import * as repository from "./repository.js";
import { config } from "./config.js";
import { logger } from "./logger.js";

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

async function deliver(url, envelope) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-token": config.internalToken,
      "x-request-id": `evt-${SOURCE}-${envelope.id}`,
    },
    body: JSON.stringify(envelope),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`subscriber ${url} answered ${res.status}`);
}

export async function runRelayOnce({ subscribers = config.eventSubscribers } = {}) {
  if (busy) return 0;
  busy = true;
  let published = 0;
  try {
    const db = getPool();
    for (const row of await repository.listUnpublished(db, 100)) {
      const envelope = toEnvelope(row);
      try {
        for (const url of subscribers) await deliver(url, envelope);
      } catch (err) {
        logger.warn({ err: err.message, eventId: row.id, type: row.type }, "relay: delivery failed, will retry");
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
  logger.info({ subscribers: config.eventSubscribers }, "outbox relay started");
}

export function stopRelay() {
  clearInterval(timer);
  timer = undefined;
}
