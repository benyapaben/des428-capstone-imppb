// Step 6 (E6): Prometheus metrics for the monolith, scraped from GET /api/metrics (inside the compose
// network only — the gateway answers 404 for it) every 5 s; the Grafana dashboard "eDemand RED" reads
// them.
//
// The same histogram as the services (services/*/src/metrics.js): its _count gives the Rate, the _count
// with a 5xx status_code the Errors, its buckets the Duration percentiles. handle() records one
// observation per API call. `route` is the App Router pattern (/api/bookings/[id]/complete), rebuilt
// from the path and the route's params, so order ids never become label values. UI pages and Next's
// own 404s do not go through handle() and are not counted: the dashboard shows the API.
//
// prom-client stays external in next.config.js, so the route bundles and instrumentation.js (whose
// RabbitMQ consumer records messaging_process_duration_seconds, lib/amqp/connection.js) share ONE
// registry. This module itself may still be evaluated once per bundle, hence getSingleMetric().
import client from "prom-client";

export const registry = client.register;

export const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

function histogram(name, help, labelNames) {
  return registry.getSingleMetric(name) ?? new client.Histogram({ name, help, labelNames, buckets: BUCKETS });
}

if (!registry.getSingleMetric("process_cpu_user_seconds_total")) client.collectDefaultMetrics();

export const httpDuration = histogram(
  "http_server_request_duration_seconds",
  "HTTP requests served, by route pattern and status (RED: rate = _count, errors = 5xx, duration = buckets)",
  ["method", "route", "status_code"],
);

// The compose healthcheck (every 10 s) and the scrape itself are neither logged nor measured.
export const UNMEASURED = new Set(["/api/health", "/api/metrics"]);

function decode(segment) {
  try { return decodeURIComponent(segment); } catch { return segment; }
}

// /api/jobs/12/bids/7/accept + { id: "12", bidId: "7" } -> /api/jobs/[id]/bids/[bidId]/accept.
// Params come in path order, so each one replaces the first segment after the previous match that
// equals its value. Only static words of a real route can remain, so the label set stays bounded.
export function routeOf(pathname, params) {
  const entries = Object.entries(params ?? {}).filter(([, v]) => typeof v === "string");
  if (entries.length === 0) return pathname;
  const segments = pathname.split("/");
  let next = 0;
  for (let i = 0; i < segments.length && next < entries.length; i++) {
    const [name, value] = entries[next];
    if (decode(segments[i]) === value) {
      segments[i] = `[${name}]`;
      next++;
    }
  }
  return segments.join("/");
}

export function observeRequest({ method, pathname, params, status, seconds }) {
  if (UNMEASURED.has(pathname)) return;
  httpDuration.observe(
    { method, route: routeOf(pathname, params), status_code: String(status ?? 500) },
    seconds,
  );
}
