// Structured JSON logs (pino). Kept identical in services/payments and services/notifications.
//
// Step 6 (E5): every line written inside a request or a message handler carries `request_id`,
// `trace_id` and `span_id`, added by pino's mixin from the active OpenTelemetry context, so a log line
// leads to its trace in Jaeger and a trace to its log lines. `request_id` travels as W3C baggage:
// withRequestId() puts it into the context, the outbox and the AMQP headers carry it on (see amqp.js),
// so a consumer's lines show the id of the HTTP request that caused the event. A field the call passes
// itself (e.g. `request_id` on the request log) wins over the mixin. Without an OpenTelemetry SDK
// (tests, OTEL_SDK_DISABLED=true) there is no context, and only the explicit fields remain.
import pino from "pino";
import { context, isSpanContextValid, propagation, trace } from "@opentelemetry/api";
import { config } from "./config.js";

export function correlation() {
  const ctx = context.active();
  const out = {};
  const requestId = propagation.getBaggage(ctx)?.getEntry("request_id")?.value;
  if (requestId) out.request_id = requestId;
  const span = trace.getSpanContext(ctx);
  if (span && isSpanContextValid(span)) {
    out.trace_id = span.traceId;
    out.span_id = span.spanId;
  }
  return out;
}

// Runs fn with request_id in the context's baggage (kept with the trace context it already holds).
export function withRequestId(requestId, fn) {
  const ctx = context.active();
  const baggage = (propagation.getBaggage(ctx) ?? propagation.createBaggage())
    .setEntry("request_id", { value: requestId });
  return context.with(propagation.setBaggage(ctx, baggage), fn);
}

export const logger = pino({
  level: config.logLevel,
  base: { service: config.serviceName },
  timestamp: pino.stdTimeFunctions.isoTime,
  mixin: correlation,
});
