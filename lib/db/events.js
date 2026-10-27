// The outbox. Every state change writes an events row in the SAME transaction as the change, so a
// crash can never leave "state changed but event lost" (or vice-versa). The notifications relay is
// the sole consumer: it claims each row by stamping processed_at, then dispatches. Shared infra, so
// it lives under lib/db rather than in any one bounded context.
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

// Idempotent claim: only the first drainer to reach a row flips processed_at from NULL. A
// concurrent (or re-entrant) relay pass sees changes === 0 and skips — the event is applied once.
export function claim(eventId) {
  return getDb()
    .prepare(
      "UPDATE events SET processed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND processed_at IS NULL"
    )
    .run(eventId).changes;
}
