// The booking lifecycle + the transactional seams the course cares about:
//   awaiting -> confirmed -> started -> completed
//   awaiting|confirmed -> cancelled          (releases slot_holds, refunds a paid gateway order)
//   * -> rescheduled                         (re-holds slots atomically)
// Every transition writes an events row in the SAME transaction as the state change (the outbox).
//
// Step 2 — Payments is a separate service:
//   * place-booking is one .immediate() transaction (order + items + slot_holds + outbox); a gateway
//     booking THEN calls the payments service synchronously (POST /intents, Idempotency-Key =
//     order_id) and stores the returned gateway_ref on the order. If Payments cannot be reached the
//     order is cancelled again (compensation) and the caller gets a 503.
//   * completion keeps the OTP-gated conditional UPDATE; the wallet credit is no longer done here —
//     Booking emits booking.completed and Payments credits the wallet when it consumes the event.
//   * cancel emits booking.cancelled; Payments decides whether to refund (or void the intent).
//   * payment.succeeded / payment.refunded arrive from Payments; Booking flips its own
//     orders.payment_status (applyPaymentSucceeded / applyPaymentRefunded).
//
// Step 4 — saga (Booking orchestrates):
//   * expireUnpaidOrders: an unpaid gateway booking is cancelled after PAYMENT_TIMEOUT_SECONDS.
//   * applyPaymentSucceeded on an already-cancelled order = late payment: recorded as paid and a
//     second booking.cancelled (reason late_payment) asks Payments to refund it.
import { getDb } from "../../db/index.js";
import { withIdempotency } from "../../db/idempotency.js";
import { insertEvent } from "../../db/events.js";
import * as repository from "./repository.js";
import * as catalogRepository from "../catalog/repository.js";
import * as providersRepository from "../providers/repository.js";
import * as paymentsClient from "../../clients/payments.js";
import { slotRange, timeToMinutes, minutesToTime, weekdayOf, todayDate } from "./slots.js";
import {
  NotFoundError, ForbiddenError, ConflictError, BadRequestError, ServiceUnavailableError,
} from "../../errors.js";
import { logger } from "../../logger.js";
import { config } from "../../config.js";

const PLACE_ENDPOINT = "POST /api/bookings";

function round(n) {
  return Math.round(n);
}

export function toPublicOrder(row) {
  return {
    id: row.id,
    customer_id: row.customer_id,
    provider_id: row.provider_id,
    address_id: row.address_id,
    service_date: row.service_date,
    starting_time: row.starting_time,
    ending_time: row.ending_time,
    duration_min: row.duration_min,
    subtotal_cents: row.subtotal_cents,
    tax_cents: row.tax_cents,
    total_cents: row.total_cents,
    commission_pct: row.commission_pct,
    commission_cents: row.commission_cents,
    provider_earnings_cents: row.provider_earnings_cents,
    payment_method: row.payment_method,
    payment_status: row.payment_status,
    status: row.status,
    job_request_id: row.job_request_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// The intent as the payments service returned it from POST /intents.
function publicIntent(intent) {
  if (!intent) return undefined;
  return {
    id: intent.id,
    order_id: intent.order_id,
    amount_cents: intent.amount_cents,
    gateway_ref: intent.gateway_ref,
    status: intent.status,
  };
}

// The intent as Booking KNOWS it from its own copy on the order — no call to Payments.
const INTENT_STATUS = { pending: "requires_payment", paid: "succeeded", refunded: "refunded" };
function intentFromOrder(order) {
  if (order.payment_method !== "gateway" || !order.gateway_ref) return undefined;
  return {
    order_id: order.id,
    amount_cents: order.total_cents,
    gateway_ref: order.gateway_ref,
    status: INTENT_STATUS[order.payment_status],
  };
}

function assertParticipant(order, auth) {
  const isCustomer = auth.role === "customer" && order.customer_id === auth.sub;
  const isProvider = auth.role === "provider" && order.provider_id === auth.sub;
  if (!isCustomer && !isProvider) throw new ForbiddenError("you are not a participant on this booking");
}

// Validate that a [start, start+duration) window on `date` fits inside the provider's open hours
// for that weekday, and the date is not in the past. Returns the ending 'HH:MM'.
function validateWindow(providerId, date, startingTime, durationMin) {
  if (date < todayDate()) {
    throw new BadRequestError("validation failed", [{ path: "service_date", message: "service_date is in the past" }]);
  }
  const timing = providersRepository.findTiming(providerId, weekdayOf(date));
  if (!timing || !timing.is_open) {
    throw new BadRequestError("validation failed", [{ path: "service_date", message: "provider is closed on that day" }]);
  }
  const start = timeToMinutes(startingTime);
  const end = start + durationMin;
  const opening = timeToMinutes(timing.opening_time);
  const closing = timeToMinutes(timing.closing_time);
  if (start < opening || end > closing) {
    throw new BadRequestError("validation failed", [
      { path: "starting_time", message: "requested time is outside the provider's working hours" },
    ]);
  }
  return minutesToTime(end);
}

// ---------- the place-booking transaction ----------
// `ctx` carries { requestId, traceparent } so the call to Payments joins the same trace.
export async function placeBooking(customerId, input, idempotencyKey, ctx = {}) {
  const { statusCode, body } = withIdempotency(idempotencyKey, PLACE_ENDPOINT, () => {
    // (idempotency keys are scoped to this customer — see the actor arg passed below)
    // 1. Load services; assert same provider, provider approved, status=1.
    if (!input.items || input.items.length === 0) {
      throw new BadRequestError("validation failed", [{ path: "items", message: "at least one item is required" }]);
    }
    const profile = providersRepository.findProfile(input.provider_id);
    if (!profile) throw new NotFoundError(`provider ${input.provider_id} not found`);
    if (!profile.is_approved) throw new ConflictError("provider is not approved");

    let addressId = null;
    if (input.address_id != null) {
      const addr = repository.findAddress(input.address_id);
      if (!addr || addr.customer_id !== customerId) {
        throw new BadRequestError("validation failed", [{ path: "address_id", message: "unknown address" }]);
      }
      addressId = addr.id;
    }

    const items = [];
    let subtotal = 0;
    let tax = 0;
    let duration = 0;
    for (const line of input.items) {
      const service = catalogRepository.findServiceRaw(line.service_id);
      if (!service) throw new NotFoundError(`service ${line.service_id} not found`);
      if (service.provider_id !== input.provider_id) {
        throw new BadRequestError("validation failed", [{ path: "items", message: "all services must belong to the same provider" }]);
      }
      if (service.status !== 1) throw new ConflictError(`service ${service.id} is not available`);
      const qty = line.quantity;
      const lineSubtotal = service.price_cents * qty;
      const lineTax = round((lineSubtotal * service.tax_percent) / 100);
      subtotal += lineSubtotal;
      tax += lineTax;
      duration += service.duration_min * qty;
      items.push({
        serviceId: service.id,
        serviceTitle: service.title,
        unitPriceCents: service.price_cents,
        taxPercent: service.tax_percent,
        taxCents: lineTax,
        quantity: qty,
        subtotalCents: lineSubtotal,
      });
    }

    // 2. window fits provider hours + not past.
    const endingTime = validateWindow(input.provider_id, input.service_date, input.starting_time, duration);
    const total = subtotal + tax;

    // 4. otp + commission snapshot.
    const otp = 100000 + Math.floor(Math.random() * 900000);
    const commissionPct = profile.commission_pct;

    // 5. order.
    const orderId = repository.insertOrder({
      customerId,
      providerId: input.provider_id,
      addressId,
      serviceDate: input.service_date,
      startingTime: input.starting_time,
      endingTime,
      durationMin: duration,
      subtotalCents: subtotal,
      taxCents: tax,
      totalCents: total,
      commissionPct,
      paymentMethod: input.payment_method,
      otp,
      jobRequestId: null,
    });

    // 6. items.
    for (const it of items) repository.insertOrderItem(orderId, it);

    // 7. slot_holds — the atomic conditional insert. A clash throws ConflictError (mapped in the
    //    repository) and rolls the whole transaction back: zero partial rows survive.
    for (const slot of slotRange(input.starting_time, duration)) {
      repository.insertSlotHold(input.provider_id, input.service_date, slot, orderId);
    }

    // 8. outbox event, same tx. (The payment intent is created AFTER commit — see below.)
    insertEvent("booking.status_changed", "order", orderId, {
      order_id: orderId,
      from: null,
      to: "awaiting",
      customer_id: customerId,
      provider_id: input.provider_id,
      actor_role: "customer",
    });

    const order = repository.findOrderById(orderId);
    return {
      statusCode: 201,
      body: { order: toPublicOrder(order), otp },
    };
  }, customerId);

  if (body.order.payment_method !== "gateway") return { statusCode, body };

  // 9. gateway booking -> payment intent from the payments service (sync HTTP, outside the SQLite tx:
  //    a better-sqlite3 transaction is synchronous and must never wait on the network).
  const orderId = body.order.id;
  const current = repository.findOrderById(orderId);
  if (current.status === "cancelled") {
    throw new ConflictError(`booking ${orderId} has been cancelled`);
  }
  if (current.gateway_ref) {
    // Idempotent replay: Booking already holds the intent copy — no need to ask Payments again.
    return { statusCode, body: { ...body, order: toPublicOrder(current), payment_intent: intentFromOrder(current) } };
  }

  let intent;
  try {
    intent = await paymentsClient.createIntent(
      { orderId, amountCents: current.total_cents, customerId, providerId: current.provider_id },
      ctx
    );
  } catch (err) {
    // Compensation: the order must not keep its slots without a way to pay. booking.cancelled also
    // tells Payments to void an intent in case it WAS created but the response was lost.
    logger.warn({ orderId, err: err.message }, "payment intent failed; compensating by cancelling the order");
    cancelInTx(current, "system", { reason: "payment_unavailable" });
    throw new ServiceUnavailableError("payment service unavailable — the booking was not placed, please retry");
  }

  repository.setGatewayRef(orderId, intent.gateway_ref);
  return {
    statusCode,
    body: { ...body, order: toPublicOrder(repository.findOrderById(orderId)), payment_intent: publicIntent(intent) },
  };
}

// ---------- state transitions ----------
export function confirmBooking(orderId, providerId) {
  const order = repository.findOrderById(orderId);
  if (!order) throw new NotFoundError(`booking ${orderId} not found`);
  if (order.provider_id !== providerId) throw new ForbiddenError("you are not the provider on this booking");

  const run = getDb().transaction(() => {
    const changes = repository.confirmAtomic(orderId, providerId);
    if (changes === 0) throw new ConflictError(`cannot confirm booking from status '${order.status}'`);
    insertEvent("booking.status_changed", "order", orderId, {
      order_id: orderId, from: order.status, to: "confirmed",
      customer_id: order.customer_id, provider_id: providerId, actor_role: "provider",
    });
    return toPublicOrder(repository.findOrderById(orderId));
  });
  return run.immediate();
}

export function startBooking(orderId, providerId) {
  const order = repository.findOrderById(orderId);
  if (!order) throw new NotFoundError(`booking ${orderId} not found`);
  if (order.provider_id !== providerId) throw new ForbiddenError("you are not the provider on this booking");

  const run = getDb().transaction(() => {
    const changes = repository.startAtomic(orderId, providerId);
    if (changes === 0) throw new ConflictError(`cannot start booking from status '${order.status}'`);
    insertEvent("booking.status_changed", "order", orderId, {
      order_id: orderId, from: order.status, to: "started",
      customer_id: order.customer_id, provider_id: providerId, actor_role: "provider",
    });
    return toPublicOrder(repository.findOrderById(orderId));
  });
  return run.immediate();
}

// OTP-gated completion. The booking.completed event is written *inside* the same transaction as the
// WHERE status='started' AND otp=? update, so a replay (or a second provider) matches zero rows and
// the event — and therefore the wallet credit Payments performs when it consumes it — happens exactly
// once. (Payments also dedupes the event by id in its inbox, covering at-least-once redelivery.)
export function completeBooking(orderId, providerId, otp) {
  const order = repository.findOrderById(orderId);
  if (!order) throw new NotFoundError(`booking ${orderId} not found`);
  if (order.provider_id !== providerId) throw new ForbiddenError("you are not the provider on this booking");
  if (otp === undefined || otp === null || Number.isNaN(otp)) {
    throw new BadRequestError("OTP is required");
  }

  const run = getDb().transaction(() => {
    const commission = round((order.total_cents * order.commission_pct) / 100);
    const earnings = order.total_cents - commission;

    const changes = repository.completeAtomic(orderId, providerId, otp, commission, earnings);
    if (changes === 0) {
      const fresh = repository.findOrderById(orderId);
      if (fresh.status === "completed") throw new ConflictError("booking is already completed");
      if (fresh.otp !== otp) throw new ConflictError("incorrect OTP");
      throw new ConflictError(`cannot complete booking from status '${fresh.status}'`);
    }

    insertEvent("booking.completed", "order", orderId, {
      order_id: orderId, total_cents: order.total_cents, commission_cents: commission,
      provider_earnings_cents: earnings, customer_id: order.customer_id, provider_id: providerId,
      payment_method: order.payment_method,
    });
    insertEvent("booking.status_changed", "order", orderId, {
      order_id: orderId, from: "started", to: "completed",
      customer_id: order.customer_id, provider_id: providerId, actor_role: "provider",
    });

    return toPublicOrder(repository.findOrderById(orderId));
  });
  return run.immediate();
}

// Cancel + release slots + outbox, in one transaction. booking.cancelled is what Payments consumes
// to refund a paid order (or void a still-unpaid intent); the refund itself comes back later as
// payment.refunded, which flips orders.payment_status to 'refunded'.
// `reason` is recorded in the event; `onlyIfUnpaid` is used by the payment-timeout sweeper so a
// payment that lands at the last moment wins over the timeout.
function cancelInTx(order, actorRole, { reason = "customer_cancelled", onlyIfUnpaid = false } = {}) {
  const run = getDb().transaction(() => {
    if (onlyIfUnpaid) {
      // Re-read inside the write lock: a payment that landed since we listed the order wins.
      const fresh = repository.findOrderById(order.id);
      if (!fresh || fresh.payment_status !== "pending") throw new ConflictError("booking is no longer unpaid");
    }

    const changes = repository.cancelAtomic(order.id, order.customer_id);
    if (changes === 0) throw new ConflictError(`cannot cancel booking from status '${order.status}'`);

    repository.deleteSlotHoldsForOrder(order.id);

    insertEvent("booking.cancelled", "order", order.id, {
      order_id: order.id, customer_id: order.customer_id, provider_id: order.provider_id,
      total_cents: order.total_cents, payment_method: order.payment_method,
      payment_status: order.payment_status, gateway_ref: order.gateway_ref,
      reason,
    });
    insertEvent("booking.status_changed", "order", order.id, {
      order_id: order.id, from: order.status, to: "cancelled",
      customer_id: order.customer_id, provider_id: order.provider_id, actor_role: actorRole,
    });

    return toPublicOrder(repository.findOrderById(order.id));
  });
  return run.immediate();
}

export function cancelBooking(orderId, customerId) {
  const order = repository.findOrderById(orderId);
  if (!order) throw new NotFoundError(`booking ${orderId} not found`);
  if (order.customer_id !== customerId) throw new ForbiddenError("you are not the customer on this booking");

  const updated = cancelInTx(order, "customer");
  // The refund is asynchronous now: Payments performs it when it consumes booking.cancelled.
  return { order: updated, refund_pending: order.payment_status === "paid" };
}

// Saga timeout: a gateway booking that is not paid within PAYMENT_TIMEOUT_SECONDS is cancelled and its
// slots are released. booking.cancelled (reason payment_timeout) tells Payments to void the intent.
export function expireUnpaidOrders(now = Date.now()) {
  const cutoff = new Date(now - config.paymentTimeoutSeconds * 1000).toISOString();
  let expired = 0;
  for (const order of repository.listExpiredUnpaid(cutoff)) {
    try {
      cancelInTx(order, "system", { reason: "payment_timeout", onlyIfUnpaid: true });
      expired += 1;
    } catch (err) {
      if (!(err instanceof ConflictError)) throw err; // raced with a payment or a cancel: skip it
    }
  }
  return expired;
}

// ---------- reactions to Payments' events (called from lib/outbox/inbound.js, inside its tx) ----------
export function applyPaymentSucceeded(orderId) {
  const order = repository.findOrderById(orderId);
  const changes = repository.markPaid(orderId);
  if (order && order.status === "cancelled" && changes === 1) {
    // Late payment: the money arrived after the booking was cancelled (timeout or customer). Record the
    // truth (paid), and ask Payments again to refund. Payments' refund is conditional, so it is safe
    // even if the original booking.cancelled already triggered one. Runs inside receiveEvent's tx.
    insertEvent("booking.cancelled", "order", orderId, {
      order_id: orderId, customer_id: order.customer_id, provider_id: order.provider_id,
      total_cents: order.total_cents, payment_method: order.payment_method,
      payment_status: "paid", gateway_ref: order.gateway_ref, reason: "late_payment",
    });
  }
  return changes;
}
export function applyPaymentRefunded(orderId) {
  return repository.markRefunded(orderId);
}

export function rescheduleBooking(orderId, auth, { service_date, starting_time }) {
  const order = repository.findOrderById(orderId);
  if (!order) throw new NotFoundError(`booking ${orderId} not found`);
  assertParticipant(order, auth);
  if (["completed", "cancelled"].includes(order.status)) {
    throw new ConflictError(`cannot reschedule a ${order.status} booking`);
  }

  const run = getDb().transaction(() => {
    const endingTime = validateWindow(order.provider_id, service_date, starting_time, order.duration_min);
    // Drop this order's own holds first (so re-holding an overlapping window is fine), then re-hold.
    // A clash with ANOTHER order's holds throws ConflictError -> the whole tx rolls back, which
    // undoes the delete too, leaving the old holds intact.
    repository.deleteSlotHoldsForOrder(orderId);
    for (const slot of slotRange(starting_time, order.duration_min)) {
      repository.insertSlotHold(order.provider_id, service_date, slot, orderId);
    }
    repository.rescheduleAtomic(orderId, service_date, starting_time, endingTime, order.duration_min);
    insertEvent("booking.status_changed", "order", orderId, {
      order_id: orderId, from: order.status, to: "rescheduled",
      customer_id: order.customer_id, provider_id: order.provider_id, actor_role: auth.role,
    });
    return toPublicOrder(repository.findOrderById(orderId));
  });
  return run.immediate();
}

// ---------- reads ----------
export function getBooking(orderId, auth) {
  const order = repository.findOrderById(orderId);
  if (!order) throw new NotFoundError(`booking ${orderId} not found`);
  assertParticipant(order, auth);
  const out = {
    ...toPublicOrder(order),
    items: repository.listOrderItems(orderId),
    slot_times: repository.heldSlotTimes(order.provider_id, order.service_date).filter((s) => s), // advisory
    // Booking's own copy (gateway_ref + payment_status on the order) — never a read of Payments' DB.
    payment_intent: intentFromOrder(order),
  };
  // OTP is the proof-of-presence code the customer reads to the provider — customer-only.
  if (auth.role === "customer") out.otp = order.otp;
  return out;
}

export function listBookings(auth, { status, page, size }) {
  const offset = (page - 1) * size;
  if (auth.role === "provider") {
    const items = repository.listForProvider(auth.sub, { status, limit: size, offset });
    const total = repository.countForProvider(auth.sub, status);
    return { items: items.map(toPublicOrder), total, page, size };
  }
  const items = repository.listForCustomer(auth.sub, { status, limit: size, offset });
  const total = repository.countForCustomer(auth.sub, status);
  return { items: items.map(toPublicOrder), total, page, size };
}

export function listAllBookings({ status, page, size }) {
  const offset = (page - 1) * size;
  const items = repository.listAllOrders({ status, limit: size, offset });
  const total = repository.countAllOrders(status);
  return { items: items.map(toPublicOrder), total, page, size };
}

// ---------- addresses (customer) ----------
export function listAddresses(customerId) {
  return repository.listAddresses(customerId);
}
export function addAddress(customerId, input) {
  const id = repository.insertAddress(customerId, input);
  return repository.findAddress(id);
}

// slot_holds count for an order (used by tests + the UI schedule view).
export function orderById(orderId) {
  return repository.findOrderById(orderId);
}