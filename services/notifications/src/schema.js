// notif_db schema. Like the monolith, the service drops and recreates its tables on every boot so a
// fresh `docker compose up` is deterministic.
export const SCHEMA_SQL = `
DROP TABLE IF EXISTS processed_events;
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

-- Inbox: (source, event_id) is the dedupe key for at-least-once delivery.
CREATE TABLE processed_events (
  source TEXT NOT NULL,
  event_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source, event_id)
);
`;

export async function migrate(db) {
  await db.query(SCHEMA_SQL);
}
