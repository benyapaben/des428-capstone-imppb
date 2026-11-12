// notif_db schema. Like the monolith, the service drops and recreates its tables on every boot so a
// fresh `docker compose up` is deterministic.
export const SCHEMA_SQL = `
DROP TABLE IF EXISTS processed_messages;
DROP TABLE IF EXISTS notifications;

CREATE TABLE notifications (
  id SERIAL PRIMARY KEY,
  recipient_role TEXT NOT NULL CHECK (recipient_role IN ('customer','provider','admin')),
  recipient_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  order_id INTEGER,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_notifications_recipient ON notifications (recipient_role, recipient_id);

-- Inbox: message_id ("<source>:<id>", the AMQP messageId) is the dedupe key for at-least-once delivery.
CREATE TABLE processed_messages (
  message_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  event_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

export async function migrate(db) {
  await db.query(SCHEMA_SQL);
}
