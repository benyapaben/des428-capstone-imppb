// Notifications read side: a user's inbox and marking one read. The write side is the relay.
import * as repository from "./repository.js";
import { NotFoundError, ForbiddenError } from "../../errors.js";

function publicNotification(row) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    order_id: row.order_id,
    read_at: row.read_at,
    created_at: row.created_at,
  };
}

export function listForUser(auth) {
  return repository.listForRecipient(auth.role, auth.sub).map(publicNotification);
}

export function markRead(notificationId, auth) {
  const n = repository.findById(notificationId);
  if (!n) throw new NotFoundError(`notification ${notificationId} not found`);
  if (n.recipient_role !== auth.role || n.recipient_id !== auth.sub) {
    throw new ForbiddenError("not your notification");
  }
  repository.markRead(notificationId, auth.role, auth.sub);
  return publicNotification(repository.findById(notificationId));
}
