// The outbox. Every state change writes an events row in the SAME transaction as the change, so a
// crash can never leave "state changed but event lost" (or vice-versa). The outbox relay
// (lib/outbox/relay.js) is the sole consumer: it publishes the event to RabbitMQ, and only once the
// broker confirms it stamps processed_at — at-least-once delivery, made exactly-once by each
// consumer's inbox. Shared infra, so it lives under lib/db rather than in any one context.
import { context, propagation } from "@opentelemetry/api";
import { getDb } from "./index.js";

// Step 6 (E4): the trace this event was written in ({ traceparent, ... } as JSON), or null outside a
// trace. The relay publishes the event later, from a timer, so the request's context has to travel
// with the row; publish() continues the trace from it (lib/amqp/connection.js).
export function currentTraceContext() {
  const carrier = {};
  propagation.inject(context.active(), carrier);
  return Object.keys(carrier).length > 0 ? JSON.stringify(carrier) : null;
}

// Insert a domain event. MUST be called from inside the caller's transaction so it commits or rolls
// back atomically with the state change that produced it.
export function insertEvent(type, aggregateType, aggregateId, payload) {
  return getDb()
    .prepare(
      "INSERT INTO events (type, aggregate_type, aggregate_id, payload_json, trace_context) VALUES (?, ?, ?, ?, ?)"
    )
    .run(type, aggregateType, aggregateId, JSON.stringify(payload), currentTraceContext()).lastInsertRowid;
}

export function listUnprocessed(limit = 100) {
  return getDb()
    .prepare("SELECT * FROM events WHERE processed_at IS NULL ORDER BY id LIMIT ?")
    .all(limit);
}

// Mark an event delivered. Conditional on processed_at IS NULL so a second stamp is a no-op.
export function markProcessed(eventId) {
  return getDb()
    .prepare(
      "UPDATE events SET processed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND processed_at IS NULL"
    )
    .run(eventId).changes;
}
