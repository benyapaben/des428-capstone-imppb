// HTTP client for the payments service. The ONLY way Booking reaches Payments synchronously.
// POST /intents is idempotent on Idempotency-Key = order_id, so a retry (or a lost response)
// can never create a second intent for the same order.
import { config } from "../config.js";
import { ServiceUnavailableError } from "../errors.js";

export async function createIntent({ orderId, amountCents, customerId, providerId }, ctx = {}) {
  const headers = {
    "content-type": "application/json",
    "x-internal-token": config.internalToken,
    "idempotency-key": String(orderId),
  };
  if (ctx.requestId) headers["x-request-id"] = ctx.requestId;
  if (ctx.traceparent) headers.traceparent = ctx.traceparent;

  let res;
  try {
    res = await fetch(`${config.paymentsUrl}/intents`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        order_id: orderId,
        amount_cents: amountCents,
        customer_id: customerId,
        provider_id: providerId,
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    throw new ServiceUnavailableError(`payments service unreachable: ${err.message}`);
  }
  if (!res.ok) {
    throw new ServiceUnavailableError(`payments service answered ${res.status}`);
  }
  return res.json();
}
