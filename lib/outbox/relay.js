// The outbox relay — the sole consumer of the monolith's `events` table. Started once from
// instrumentation.js; also exported so tests can drain it on demand.
//
// Step 4 transport: each event, in id order, is published to the RabbitMQ topic exchange (routing
// key = event type) on a confirm channel, and only once the broker confirms it is the row stamped
// processed_at. A failure stops the pass and the event is retried on the next tick — at-least-once
// delivery, in order. Consumers dedupe on "<source>:<id>" built from the envelope (the PRIMARY KEY of
// their own processed_messages inbox), so a redelivery is harmless.
//
// The relay no longer applies anything locally: the rating aggregate is recomputed by the monolith's
// own consumer of review.created (lib/outbox/inbound.js), never inline in the review handler — the
// deliberate eventual-consistency contrast the course teaches.
import { listUnprocessed, markProcessed } from "../db/events.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { getPublisher, publish, dropPublisher } from "../amqp/connection.js";

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
// `publisher` / `publishTimeoutMs` let tests inject a fake channel and a short confirm timeout.
export async function runRelayOnce({ publisher, publishTimeoutMs } = {}) {
  if (globalThis[BUSY]) return 0; // a previous tick is still delivering
  globalThis[BUSY] = true;
  let processed = 0;
  try {
    for (const row of listUnprocessed(100)) {
      const envelope = toEnvelope(row);
      try {
        await publish(publisher ?? (await getPublisher()), envelope, { timeoutMs: publishTimeoutMs });
      } catch (err) {
        logger.warn({ err: err.message, eventId: row.id, type: row.type }, "relay: delivery failed, will retry");
        if (!publisher) dropPublisher(); // a failed or timed-out channel is not reused next tick
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
