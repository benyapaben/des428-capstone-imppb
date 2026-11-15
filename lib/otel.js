// Step 6 / Area E (E3): OpenTelemetry tracing for the monolith. Loaded first thing from
// instrumentation.js (nodejs runtime only). The test suite never loads instrumentation.js, so tests
// run without an SDK and every trace call below is a no-op there.
//
// Next.js 14 already creates the spans we want once a tracer provider is registered: one SERVER span
// per request (continuing an incoming `traceparent`), the route handler / render under it, and a span
// per fetch(). What Next does NOT do is put `traceparent` on outgoing requests; lib/http/trace.js does
// that for the calls to Payments and Notifications.
//
// Settings are the standard OpenTelemetry environment variables, read by the SDK itself (set in
// docker-compose.yml, the same block the services use): OTEL_SERVICE_NAME=edemand,
// OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318, OTEL_SDK_DISABLED=true turns all of this off.
//
// No auto-instrumentations: Next's own spans cover HTTP in and fetch out, and better-sqlite3 has no
// OpenTelemetry instrumentation (its synchronous queries would add little to a trace anyway).
import { NodeSDK, tracing } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

const { ParentBasedSampler, SamplingDecision } = tracing;

// Requests that would only add noise: the compose healthcheck every 10 s, Prometheus scrapes, and
// static assets. Next puts the request path on its SERVER span as `http.target` when it starts it,
// so the sampler can drop the whole trace before anything is recorded.
const UNTRACED = /^\/(_next\/|favicon\.ico|api\/(health|metrics)(\?|\/|$))/;

const skipNoise = {
  shouldSample(_context, _traceId, _name, _kind, attributes) {
    const target = attributes?.["http.target"];
    const noise = typeof target === "string" && UNTRACED.test(target);
    return { decision: noise ? SamplingDecision.NOT_RECORD : SamplingDecision.RECORD_AND_SAMPLED };
  },
  toString: () => "SkipHealthMetricsAndAssets",
};

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter(),   // endpoint from OTEL_EXPORTER_OTLP_ENDPOINT (+ /v1/traces)
  // A request that arrives with a traceparent keeps the caller's sampling decision; a new trace is
  // recorded unless it is one of the noisy paths above.
  sampler: new ParentBasedSampler({ root: skipNoise }),
});

sdk.start();

// Flush spans that are still buffered when compose stops the container.
process.once("SIGTERM", () => {
  sdk.shutdown().catch(() => {});
});
