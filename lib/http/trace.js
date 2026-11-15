// Step 6 / Area E (E3): trace context on calls from the monolith to the extracted services.
//
// Next.js traces fetch() but does not add `traceparent` to the outgoing request, so the service on
// the other end would start a new trace. withTraceHeaders() writes the current span's context into
// the headers (W3C traceparent / tracestate), so the service's spans join this request's trace.
//
// With no SDK registered — the test suite, or OTEL_SDK_DISABLED=true — inject() writes nothing. The
// caller's incoming traceparent (`fallback`) is then forwarded unchanged, which is what the code did
// before E3, so a trace started by the client still continues into the service.
import { context, propagation, trace } from "@opentelemetry/api";

export function withTraceHeaders(headers, { span, fallback } = {}) {
  const ctx = span ? trace.setSpan(context.active(), span) : context.active();
  propagation.inject(ctx, headers);
  if (!headers.traceparent && fallback) headers.traceparent = fallback;
  return headers;
}
