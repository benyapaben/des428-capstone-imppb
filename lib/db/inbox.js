// The inbox: the consumer half of at-least-once delivery. Events this monolith RECEIVES from other
// services (payments -> payment.succeeded / payment.refunded) are recorded by processed_messages
// inside the same transaction that applies them. A redelivery hits the PRIMARY KEY and is skipped,
// so each event is applied exactly once even though the sender may deliver it several times.
import { getDb } from "./index.js";

// Returns true on first sight, false for a duplicate. MUST run inside the caller's transaction.
export function recordInbound(source, eventId, type) {
  const changes = getDb()
    .prepare("INSERT OR IGNORE INTO processed_messages (message_id, source, event_id, type) VALUES (?, ?, ?, ?)")
    .run(`${source}:${eventId}`, source, eventId, type).changes;
  return changes === 1;
}
