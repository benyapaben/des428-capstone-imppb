// Notifications context owns the notifications table. SQL only. Notifications are written both
// synchronously (e.g. admin approval) and, mostly, by the outbox relay draining domain events.
import { getDb } from "../../db/index.js";

export function insert({ recipientRole, recipientId, type, title, body, orderId }) {
  return getDb()
    .prepare(
      `INSERT INTO notifications (recipient_role, recipient_id, type, title, body, order_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(recipientRole, recipientId, type, title, body, orderId ?? null).lastInsertRowid;
}

export function listForRecipient(role, id) {
  return getDb()
    .prepare(
      "SELECT * FROM notifications WHERE recipient_role = ? AND recipient_id = ? ORDER BY id DESC"
    )
    .all(role, id);
}

export function findById(id) {
  return getDb().prepare("SELECT * FROM notifications WHERE id = ?").get(id);
}

export function markRead(id, role, recipientId) {
  return getDb()
    .prepare(
      "UPDATE notifications SET read_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND recipient_role = ? AND recipient_id = ? AND read_at IS NULL"
    )
    .run(id, role, recipientId).changes;
}
