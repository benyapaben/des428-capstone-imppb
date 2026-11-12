// Applies a message consumed by the monolith from the booking.events queue (payment.* and review.created).// Dedupe (inbox) and the state change commit in ONE transaction, so a redelivered event is a no-op.
// Booking owns orders.payment_status, so Booking — not Payments — flips it, reacting to the event.
import { getDb } from "../db/index.js";
import { recordInbound } from "../db/inbox.js";
import { logger } from "../logger.js";
import * as booking from "../modules/booking/service.js";
import * as catalogRepository from "../modules/catalog/repository.js";
import * as providersRepository from "../modules/providers/repository.js";

const handlers = {
  "payment.succeeded": (p) => booking.applyPaymentSucceeded(p.order_id),
  "payment.refunded": (p) => booking.applyPaymentRefunded(p.order_id),
  "review.created": (p) => {
    catalogRepository.recomputeRatingAggregate(p.service_id);
    providersRepository.recomputeRatingAggregate(p.provider_id);
  },
};

export function receiveEvent(envelope) {
  const run = getDb().transaction(() => {
    if (!recordInbound(envelope.source, envelope.id, envelope.type)) {
      return { duplicate: true };
    }
    const handler = handlers[envelope.type];
    if (!handler) {
      logger.debug({ type: envelope.type }, "inbound: no handler, acknowledged");
      return { duplicate: false, handled: false };
    }
    handler(envelope.payload);
    return { duplicate: false, handled: true };
  });
  return run.immediate();
}
