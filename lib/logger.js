// Structured JSON logging (pino). One logger instance, shared everywhere, so log shape is
// consistent whether it's app bootstrap, a request handler, or the background relay.
//
// Step 6 (E5): every line written inside a request or a message handler carries `request_id`,
// `trace_id` and `span_id`, added by pino's mixin from the active OpenTelemetry context, so a log line
// leads to its trace in Jaeger and back. `request_id` is W3C baggage: handle() puts it into the
// context (withRequestId), and the outbox and the AMQP headers carry it on, so a consumer's lines show
// the id of the request that caused the event. A field the call passes itself wins over the mixin.
// Without an OpenTelemetry SDK (tests, OTEL_SDK_DISABLED=true) only the explicit fields remain.
// Same logic as services/*/src/logger.js.
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
  base: { service: "edemand" },
  timestamp: pino.stdTimeFunctions.isoTime,
  mixin: correlation,
});
