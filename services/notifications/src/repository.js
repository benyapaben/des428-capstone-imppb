// The notifications service owns the notifications + processed_messages tables. SQL only.
import { query } from "./db.js";

export async function insert(db, { recipientRole, recipientId, type, title, body, orderId }) {
  const { rows } = await db.query(
    `INSERT INTO notifications (recipient_role, recipient_id, type, title, body, order_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [recipientRole, recipientId, type, title, body, orderId ?? null]
  );
  return rows[0].id;
}

export async function listForRecipient(role, id) {
  const { rows } = await query(
    "SELECT * FROM notifications WHERE recipient_role = $1 AND recipient_id = $2 ORDER BY id DESC",
    [role, id]
  );
  return rows;
}

export async function findById(id) {
  const { rows } = await query("SELECT * FROM notifications WHERE id = $1", [id]);
  return rows[0];
}

export async function markRead(id, role, recipientId) {
  const { rowCount } = await query(
    `UPDATE notifications SET read_at = now()
     WHERE id = $1 AND recipient_role = $2 AND recipient_id = $3 AND read_at IS NULL`,
    [id, role, recipientId]
  );
  return rowCount;
}

// Inbox dedupe. true = first time we see this message_id; false = a redelivery.
export async function recordEvent(db, source, eventId, type) {
  const { rowCount } = await db.query(
    `INSERT INTO processed_messages (message_id, source, event_id, type) VALUES ($1, $2, $3, $4)
     ON CONFLICT (message_id) DO NOTHING`,
    [`${source}:${eventId}`, source, eventId, type]
  );
  return rowCount === 1;
}
