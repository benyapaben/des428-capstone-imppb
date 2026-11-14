// HTTP client for the payments service. The ONLY way Booking reaches Payments synchronously.
//
// Step 5 resilience: every attempt is cut off after config.paymentsTimeoutMs, and an attempt that
// fails in a way that may be temporary (network error, timeout, 5xx) is retried up to
// config.paymentsMaxRetries times, waiting a full-jitter exponential backoff in between. Retrying is
// safe because POST /intents is idempotent on Idempotency-Key = order_id: if an earlier attempt did
// create the intent but its reply was lost or arrived too late, the retry gets that same intent (200)
// instead of a second one. A 4xx is not retried — it will not get better. When every attempt has
// failed the caller gets ServiceUnavailableError and Booking compensates (cancels the order).
import { config } from "../config.js";
import { ServiceUnavailableError } from "../errors.js";
import { logger } from "../logger.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Full jitter: a random delay in [0, min(cap, base * 2^attempt)). `rand` is injectable for tests.
export function backoffDelay(attempt, { baseMs, capMs }, rand = Math.random) {
  return Math.floor(rand() * Math.min(capMs, baseMs * 2 ** attempt));
}

export async function createIntent({ orderId, amountCents, customerId, providerId }, ctx = {}) {
  const headers = {
    "content-type": "application/json",
    "x-internal-token": config.internalToken,
    "idempotency-key": String(orderId),             // the same key on every attempt
  };
  if (ctx.requestId) headers["x-request-id"] = ctx.requestId;
  if (ctx.traceparent) headers.traceparent = ctx.traceparent;
  const body = JSON.stringify({
    order_id: orderId,
    amount_cents: amountCents,
    customer_id: customerId,
    provider_id: providerId,
  });
  const backoff = { baseMs: config.paymentsBackoffBaseMs, capMs: config.paymentsBackoffCapMs };

  let lastReason;
  for (let attempt = 0; attempt <= config.paymentsMaxRetries; attempt++) {
    if (attempt > 0) {
      const delay = backoffDelay(attempt - 1, backoff);
      logger.warn({ orderId, attempt, delay, reason: lastReason, requestId: ctx.requestId },
        "payments: POST /intents failed, retrying");
      await sleep(delay);
    }

    let res;
    try {
      res = await fetch(`${config.paymentsUrl}/intents`, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(config.paymentsTimeoutMs),
      });
    } catch (err) {
      lastReason = err.name === "TimeoutError" ? `timeout after ${config.paymentsTimeoutMs} ms` : err.message;
      continue;                                      // network error or timeout: maybe temporary
    }
    if (res.ok) return res.json();
    if (res.status < 500) {
      throw new ServiceUnavailableError(`payments service answered ${res.status}`);   // not retryable
    }
    lastReason = `payments service answered ${res.status}`;
  }

  throw new ServiceUnavailableError(
    `payments service unavailable after ${config.paymentsMaxRetries + 1} attempts: ${lastReason}`
  );
}
