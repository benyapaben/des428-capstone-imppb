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
import { getDb } from "../db/index.js";
import { listUnprocessed, markProcessed } from "../db/events.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import * as catalogRepository from "../modules/catalog/repository.js";
import * as providersRepository from "../modules/providers/repository.js";

const RELAY = Symbol.for("edemand.relay.interval");
const BUSY = Symbol.for("edemand.relay.busy");
export const SOURCE = "monolith";

// Handlers for events the monolith itself reacts to.
const localHandlers = {
  "review.created": (payload) => {
    catalogRepository.recomputeRatingAggregate(payload.service_id);
    providersRepository.recomputeRatingAggregate(payload.provider_id);
  },
};

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

// Drain up to 100 unprocessed events, in id order. Returns how many were fully delivered.
export async function runRelayOnce({ subscribers = config.eventSubscribers } = {}) {
  if (globalThis[BUSY]) return 0; // a previous tick is still delivering
  globalThis[BUSY] = true;
  let processed = 0;
  try {
    for (const row of listUnprocessed(100)) {
      const envelope = toEnvelope(row);
      try {
        const local = localHandlers[row.type];
        if (local) getDb().transaction(() => local(envelope.payload))();
        for (const url of subscribers) await deliver(url, envelope);
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
  logger.info({ subscribers: config.eventSubscribers }, "outbox relay started");
}

export function stopRelay() {
  if (globalThis[RELAY]) {
    clearInterval(globalThis[RELAY]);
    globalThis[RELAY] = undefined;
  }
}
