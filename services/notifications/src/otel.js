// Step 6 / Area E (E2): OpenTelemetry tracing for this service. It must run BEFORE the app, so the
// container starts it with `node --import ./src/otel.js src/server.js` (see the Dockerfile). Tests
// import src/app.js directly and never load this file, so the test suite is untouched.
//
// Kept identical in services/payments and services/notifications.
//
// Settings are the standard OpenTelemetry environment variables, read by the SDK itself (set in
// docker-compose.yml):
//   OTEL_SERVICE_NAME              payments | notifications
//   OTEL_EXPORTER_OTLP_ENDPOINT    http://jaeger:4318  (OTLP/HTTP straight to Jaeger, no collector)
//   OTEL_BSP_SCHEDULE_DELAY        how often finished spans are flushed (ms)
//   OTEL_SDK_DISABLED=true         turns all of this off
import { register } from "node:module";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";

// Our code is ESM and *imports* express and pg. The classic require() hook never sees an import, so
// register OpenTelemetry's ESM loader hook first; it lets the instrumentations below patch them.
register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);

// Requests that would only add noise: compose healthchecks every 10 s and Prometheus scrapes every 5 s.
const UNTRACED_PATHS = new Set(["/health", "/metrics"]);

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter(),   // endpoint from OTEL_EXPORTER_OTLP_ENDPOINT (+ /v1/traces)
  instrumentations: [
    // Incoming requests become SERVER spans; an incoming `traceparent` header (forwarded by nginx or
    // sent by the monolith) makes them children of the caller's span, so the trace continues here.
    new HttpInstrumentation({
      ignoreIncomingRequestHook: (req) => UNTRACED_PATHS.has((req.url || "").split("?")[0]),
    }),
    // One span per Express middleware / route handler, named after the route template.
    new ExpressInstrumentation(),
    // One span per SQL query — but only inside a request. Without requireParentSpan the outbox relay,
    // which polls Postgres every second, would create a new one-span trace every second.
    new PgInstrumentation({ requireParentSpan: true }),
  ],
});

sdk.start();

// Flush spans that are still buffered when compose stops the container.
process.once("SIGTERM", () => {
  sdk.shutdown().catch(() => {});
});
