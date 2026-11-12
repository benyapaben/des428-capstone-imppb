// The outbox relay — the sole consumer of the monolith's `events` table. Started once from
// instrumentation.js; also exported so tests can drain it on demand.
//
// Step 2 transport: each event is (1) applied to local read models, then (2) POSTed to every
// subscriber service's /internal/events endpoint (notifications, payments), and only when ALL of
// that succeeds is it (3) stamped processed_at. A failure stops the pass and the event is retried
// on the next tick — at-least-once delivery, in order. Subscribers dedupe by (source, id) in their
// own inbox, so a redelivery is harmless. Step 4 swaps step (2) for a RabbitMQ publish.
//
// THE rating aggregate is still recomputed HERE, driven by review.created, never inline in the
// review handler — the deliberate eventual-consistency contrast the course teaches. Recomputing
// from the reviews table is naturally idempotent, so a retried event is safe.
import { listUnprocessed, markProcessed } from "../db/events.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { getPublisher, publish } from "../amqp/connection.js";

const RELAY = Symbol.for("edemand.relay.interval");
const BUSY = Symbol.for("edemand.relay.busy");
export const SOURCE = "monolith";


export function toEnvelope(row) {
  return {
    source: SOURCE,
    id: row.id,
    type: row.type,
    aggregate_type: row.aggregate_type,
    aggregate_id: row.aggregate_id,
    payload: JSON.parse(row.payload_json),
    occurred_at: row.created_at,
  };
}


// Drain up to 100 unprocessed events, in id order. Returns how many were fully delivered.
export async function runRelayOnce({ publisher } = {}) {
  if (globalThis[BUSY]) return 0; // a previous tick is still delivering
  globalThis[BUSY] = true;
  let processed = 0;
  try {
    for (const row of listUnprocessed(100)) {
      const envelope = toEnvelope(row);
      try {
        await publish(publisher ?? (await getPublisher()), envelope);
      } catch (err) {
        logger.warn({ err: err.message, eventId: row.id, type: row.type }, "relay: delivery failed, will retry");
        break; // keep ordering: do not skip ahead of a stuck event
      }
      if (markProcessed(row.id) === 1) processed += 1;
    }
  } finally {
    globalThis[BUSY] = false;
  }
  return processed;
}

export function startRelay() {
  if (globalThis[RELAY]) return;
  const handle = setInterval(() => {
    runRelayOnce().catch((err) => logger.error({ err: err.message }, "relay: pass failed"));
  }, config.relayIntervalMs);
  if (typeof handle.unref === "function") handle.unref();
  globalThis[RELAY] = handle;
  logger.info("outbox relay started (publishing to RabbitMQ)");
}

export function stopRelay() {
  if (globalThis[RELAY]) {
    clearInterval(globalThis[RELAY]);
    globalThis[RELAY] = undefined;
  }
}
