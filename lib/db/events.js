// The outbox. Every state change writes an events row in the SAME transaction as the change, so a
// crash can never leave "state changed but event lost" (or vice-versa). The outbox relay
// (lib/outbox/relay.js) is the sole consumer: it applies local handlers, delivers the event to every
// subscriber service, and only THEN stamps processed_at — at-least-once delivery, made exactly-once
// by each consumer's inbox. Shared infra, so it lives under lib/db rather than in any one context.
import { getDb } from "./index.js";

// Insert a domain event. MUST be called from inside the caller's transaction so it commits or rolls
// back atomically with the state change that produced it.
export function insertEvent(type, aggregateType, aggregateId, payload) {
  return getDb()
    .prepare(
      "INSERT INTO events (type, aggregate_type, aggregate_id, payload_json) VALUES (?, ?, ?, ?)"
    )
    .run(type, aggregateType, aggregateId, JSON.stringify(payload)).lastInsertRowid;
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
