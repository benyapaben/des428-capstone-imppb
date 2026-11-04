// Notifications business logic: the per-user inbox (read side) and turning domain events from the
// monolith and from Payments into messages (write side). Every event is applied inside one
// transaction together with its inbox row, so a redelivered event never produces a duplicate message.
import { tx } from "./db.js";
import * as repository from "./repository.js";
import { NotFoundError, ForbiddenError } from "./errors.js";
import { logger } from "./logger.js";

function publicNotification(row) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    order_id: row.order_id,
    read_at: row.read_at ? new Date(row.read_at).toISOString() : null,
    created_at: new Date(row.created_at).toISOString(),
  };
}

export async function listForUser(auth) {
  return (await repository.listForRecipient(auth.role, auth.sub)).map(publicNotification);
}

export async function markRead(notificationId, auth) {
  const n = await repository.findById(notificationId);
  if (!n) throw new NotFoundError(`notification ${notificationId} not found`);
  if (n.recipient_role !== auth.role || n.recipient_id !== auth.sub) {
    throw new ForbiddenError("not your notification");
  }
  await repository.markRead(notificationId, auth.role, auth.sub);
  return publicNotification(await repository.findById(notificationId));
}

// event type -> list of messages to write. Unknown types produce nothing (and are still acknowledged).
const builders = {
  "review.created": (p) => [{
    recipientRole: "provider", recipientId: p.provider_id, type: "new_review", title: "New review",
    body: `You received a ${p.rating}-star review on booking #${p.order_id}.`, orderId: p.order_id,
  }],
  "booking.status_changed": (p) => {
    // Notify the counterparty of whoever drove the transition.
    const toCustomer = p.actor_role === "provider";
    return [{
      recipientRole: toCustomer ? "customer" : "provider",
      recipientId: toCustomer ? p.customer_id : p.provider_id,
      type: "booking_status", title: `Booking ${p.to}`,
      body: `Booking #${p.order_id} is now ${p.to}.`, orderId: p.order_id,
    }];
  },
  "booking.completed": (p) => [{
    recipientRole: "customer", recipientId: p.customer_id, type: "rating_request", title: "How did it go?",
    body: `Booking #${p.order_id} is complete — leave a review for your provider.`, orderId: p.order_id,
  }],
  "bid.accepted": (p) => [
    {
      recipientRole: "provider", recipientId: p.winner_provider_id, type: "bid_accepted",
      title: "Your bid was accepted",
      body: `Your bid on job #${p.job_request_id} was accepted — booking #${p.order_id} created.`,
      orderId: p.order_id,
    },
    ...(p.loser_provider_ids || []).map((loserId) => ({
      recipientRole: "provider", recipientId: loserId, type: "bid_rejected", title: "Bid not selected",
      body: `Your bid on job #${p.job_request_id} was not selected.`, orderId: null,
    })),
  ],
  "payment.succeeded": (p) => (p.provider_id == null ? [] : [{
    recipientRole: "provider", recipientId: p.provider_id, type: "payment_received", title: "Payment received",
    body: `Payment of ${p.amount_cents} cents was received for booking #${p.order_id}.`, orderId: p.order_id,
  }]),
  "payment.refunded": (p) => (p.customer_id == null ? [] : [{
    recipientRole: "customer", recipientId: p.customer_id, type: "payment_refunded", title: "Refund issued",
    body: `Your payment of ${p.amount_cents} cents for booking #${p.order_id} was refunded.`, orderId: p.order_id,
  }]),
  "provider.approved": (p) => [{
    recipientRole: "provider", recipientId: p.provider_id, type: "provider_approved", title: "You're approved",
    body: "Your provider account has been approved. Your services are now visible to customers.", orderId: null,
  }],
};

export async function handleEvent(envelope) {
  return tx(async (client) => {
    const fresh = await repository.recordEvent(client, envelope.source, envelope.id, envelope.type);
    if (!fresh) return { duplicate: true, created: 0 };
    const build = builders[envelope.type];
    if (!build) {
      logger.debug({ type: envelope.type }, "no notification for this event type");
      return { duplicate: false, created: 0 };
    }
    const messages = build(envelope.payload);
    for (const m of messages) await repository.insert(client, m);
    return { duplicate: false, created: messages.length };
  });
}
