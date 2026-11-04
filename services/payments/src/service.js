// Payments & Wallet business logic.
//   * POST /intents       — idempotent on order_id (the caller's Idempotency-Key).
//   * webhook             — idempotent on gateway_event_id; settles the intent, records the charge and
//                           emits payment.succeeded. It does NOT touch orders: Booking owns
//                           orders.payment_status and marks it paid when it consumes the event.
//   * booking.completed   — credits the wallet (gateway) or books commission owed (COD), exactly once.
//   * booking.cancelled   — refunds a settled intent (emits payment.refunded) or voids an unpaid one.
// Every write path is one Postgres transaction with its dedupe row and its outbox row.
import { randomUUID } from "node:crypto";
import { getPool, tx } from "./db.js";
import * as repository from "./repository.js";
import { NotFoundError, ForbiddenError, ConflictError } from "./errors.js";
import { logger } from "./logger.js";

function iso(v) {
  return v ? new Date(v).toISOString() : null;
}

export function publicIntent(row) {
  return {
    id: row.id,
    order_id: row.order_id,
    customer_id: row.customer_id,
    provider_id: row.provider_id,
    amount_cents: row.amount_cents,
    gateway_ref: row.gateway_ref,
    status: row.status,
    created_at: iso(row.created_at),
  };
}

function publicTransaction(row) {
  return {
    id: row.id,
    order_id: row.order_id,
    kind: row.kind,
    amount_cents: row.amount_cents,
    method: row.method,
    gateway_ref: row.gateway_ref,
    status: row.status,
    created_at: iso(row.created_at),
  };
}

// ---------- intents ----------
// Returns { created, intent }. A repeat for the same order returns the existing intent (created=false);
// a repeat with a DIFFERENT amount/customer is a client bug -> 409.
export async function createIntent({ order_id, customer_id, provider_id, amount_cents }) {
  const inserted = await repository.insertIntentIfAbsent(getPool(), {
    orderId: order_id,
    customerId: customer_id,
    providerId: provider_id,
    amountCents: amount_cents,
    gatewayRef: `SIM-PI-${randomUUID()}`,
  });
  if (inserted) return { created: true, intent: publicIntent(inserted) };

  const existing = await repository.findIntentByOrderId(getPool(), order_id);
  if (existing.amount_cents !== amount_cents || existing.customer_id !== customer_id) {
    throw new ConflictError("Idempotency-Key has already been used for a different request");
  }
  return { created: false, intent: publicIntent(existing) };
}

// ---------- the idempotent webhook ----------
export async function handleWebhook(payload) {
  return tx(async (db) => {
    const fresh = await repository.recordWebhookEvent(db, payload.gateway_event_id, payload.type, payload);
    if (!fresh) return { replayed: true }; // the dedupe: a replay does NOTHING

    const intent = await repository.findIntentByGatewayRef(db, payload.gateway_ref);
    if (!intent) throw new NotFoundError(`payment intent ${payload.gateway_ref} not found`);

    // Conditional flip; already settled (or voided by a cancel) -> 0 rows -> no charge.
    const flipped = await repository.transitionIntent(db, intent.id, "requires_payment", "succeeded");
    if (flipped === 0) {
      await repository.markWebhookProcessed(db, payload.gateway_event_id);
      return { replayed: false, already_settled: true, status: intent.status };
    }

    await repository.insertTransaction(db, {
      orderId: intent.order_id, customerId: intent.customer_id, providerId: intent.provider_id,
      kind: "charge", amountCents: intent.amount_cents, method: "gateway",
      gatewayRef: intent.gateway_ref, status: "succeeded",
    });
    await repository.insertOutbox(db, "payment.succeeded", "order", intent.order_id, {
      order_id: intent.order_id,
      customer_id: intent.customer_id,
      provider_id: intent.provider_id,
      amount_cents: intent.amount_cents,
      gateway_ref: intent.gateway_ref,
    });
    await repository.markWebhookProcessed(db, payload.gateway_event_id);
    return { replayed: false, settled: true };
  });
}

// The mock gateway's "Pay now": authorize against the intent's own customer_id (no read of orders),
// then drive the very same idempotent webhook path.
export async function simulateSucceeded(orderId, customerId) {
  const intent = await repository.findIntentByOrderId(getPool(), orderId);
  if (!intent) throw new ConflictError("this booking has no gateway payment to settle");
  if (intent.customer_id !== customerId) throw new ForbiddenError("you are not the customer on this booking");
  const result = await handleWebhook({
    gateway_event_id: `SIM-EVT-${randomUUID()}`,
    type: "payment_intent.succeeded",
    gateway_ref: intent.gateway_ref,
  });
  return { ok: true, ...result };
}

// ---------- reads ----------
export async function getWallet(providerId) {
  const db = getPool();
  const wallet = await repository.findWallet(db, providerId);
  return {
    provider_id: providerId,
    balance_cents: wallet ? wallet.balance_cents : 0,
    commission_owed_cents: wallet ? wallet.commission_owed_cents : 0,
    transactions: (await repository.listTransactionsForProvider(db, providerId)).map(publicTransaction),
  };
}

export async function listCustomerTransactions(customerId) {
  return (await repository.listTransactionsForCustomer(getPool(), customerId)).map(publicTransaction);
}

// ---------- consuming the monolith's events ----------
async function onBookingCompleted(db, p) {
  if (p.payment_method === "gateway") {
    await repository.addToWallet(db, p.provider_id, { balanceCents: p.provider_earnings_cents });
    await repository.insertTransaction(db, {
      orderId: p.order_id, customerId: p.customer_id, providerId: p.provider_id,
      kind: "payout_credit", amountCents: p.provider_earnings_cents, method: "gateway",
    });
  } else {
    await repository.addToWallet(db, p.provider_id, { commissionOwedCents: p.commission_cents });
    await repository.insertTransaction(db, {
      orderId: p.order_id, customerId: p.customer_id, providerId: p.provider_id,
      kind: "commission_owed", amountCents: p.commission_cents, method: "cod",
    });
  }
}

async function onBookingCancelled(db, p) {
  const intent = await repository.findIntentByOrderId(db, p.order_id);
  if (!intent) return; // COD, or the intent was never created

  if (await repository.transitionIntent(db, intent.id, "succeeded", "refunded")) {
    await repository.insertTransaction(db, {
      orderId: intent.order_id, customerId: intent.customer_id, providerId: intent.provider_id,
      kind: "refund", amountCents: intent.amount_cents, method: "gateway",
      gatewayRef: intent.gateway_ref, status: "refunded",
    });
    await repository.insertOutbox(db, "payment.refunded", "order", intent.order_id, {
      order_id: intent.order_id,
      customer_id: intent.customer_id,
      provider_id: intent.provider_id,
      amount_cents: intent.amount_cents,
      gateway_ref: intent.gateway_ref,
    });
    return;
  }
  // Not paid yet: void it, so a late webhook for this intent cannot charge a cancelled booking.
  await repository.transitionIntent(db, intent.id, "requires_payment", "canceled");
}

const handlers = {
  "booking.completed": onBookingCompleted,
  "booking.cancelled": onBookingCancelled,
};

export async function handleEvent(envelope) {
  return tx(async (db) => {
    if (!(await repository.recordInbound(db, envelope.source, envelope.id, envelope.type))) {
      return { duplicate: true };
    }
    const handler = handlers[envelope.type];
    if (!handler) {
      logger.debug({ type: envelope.type }, "no payments reaction to this event type");
      return { duplicate: false, handled: false };
    }
    await handler(db, envelope.payload);
    return { duplicate: false, handled: true };
  });
}
