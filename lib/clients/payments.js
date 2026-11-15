// HTTP client for the payments service. The ONLY way Booking reaches Payments synchronously.
//
// Step 5 resilience: every attempt is cut off after config.paymentsTimeoutMs, and an attempt that
// fails in a way that may be temporary (network error, timeout, 5xx) is retried up to
// config.paymentsMaxRetries times, waiting a full-jitter exponential backoff in between. Retrying is
// safe because POST /intents is idempotent on Idempotency-Key = order_id: if an earlier attempt did
// create the intent but its reply was lost or arrived too late, the retry gets that same intent (200)
// instead of a second one. A 4xx is not retried — it will not get better. When every attempt has
// failed the caller gets ServiceUnavailableError and Booking compensates (cancels the order).
//
// Step 6 (E3): each attempt is its own CLIENT span ("POST /intents", attribute edemand.attempt), and
// its traceparent goes on that attempt's request, so in Jaeger the Payments spans hang under the
// attempt that caused them and retries are visible as sibling spans. Without an SDK (tests) the
// spans are no-ops and the caller's incoming traceparent is forwarded as before.
import { SpanKind, SpanStatusCode, context, trace } from "@opentelemetry/api";
import { config } from "../config.js";
import { ServiceUnavailableError } from "../errors.js";
import { logger } from "../logger.js";
import { withTraceHeaders } from "../http/trace.js";

const tracer = trace.getTracer("edemand");

function failAttempt(span, reason) {
  span.setStatus({ code: SpanStatusCode.ERROR, message: reason });
  span.end();
}

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
  const url = `${config.paymentsUrl}/intents`;
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
      logger.warn({ orderId, attempt, delay, reason: lastReason, request_id: ctx.requestId },
        "payments: POST /intents failed, retrying");
      await sleep(delay);
    }

    const span = tracer.startSpan("POST /intents", {
      kind: SpanKind.CLIENT,
      attributes: {
        "http.request.method": "POST",
        "url.full": url,
        "edemand.attempt": attempt + 1,
        "edemand.order_id": orderId,
      },
    });
    let res;
    try {
      // The attempt span is active during fetch(), so Next's own fetch span nests under it.
      res = await context.with(trace.setSpan(context.active(), span), () =>
        fetch(url, {
          method: "POST",
          headers: withTraceHeaders({ ...headers }, { fallback: ctx.traceparent }),
          body,
          signal: AbortSignal.timeout(config.paymentsTimeoutMs),
        })
      );
      span.setAttribute("http.response.status_code", res.status);
      // Read the body inside the same try: a connection that drops (or times out) mid-body is the
      // same "intent written, reply lost" case as a missing reply, and the retry recovers it.
      if (res.ok) {
        const intent = await res.json();
        span.end();
        return intent;
      }
    } catch (err) {
      lastReason = err.name === "TimeoutError" ? `timeout after ${config.paymentsTimeoutMs} ms` : err.message;
      failAttempt(span, lastReason);
      continue;                                      // network error or timeout: maybe temporary
    }
    await res.body?.cancel().catch(() => {});       // free the pooled connection before retrying
    lastReason = `payments service answered ${res.status}`;
    failAttempt(span, lastReason);
    if (res.status < 500) {
      throw new ServiceUnavailableError(lastReason);   // not retryable
    }
  }

  throw new ServiceUnavailableError(
    `payments service unavailable after ${config.paymentsMaxRetries + 1} attempts: ${lastReason}`
  );
}
