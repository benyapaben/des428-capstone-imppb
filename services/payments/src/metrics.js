// Step 6 (E6): Prometheus metrics. Prometheus scrapes GET /metrics (inside the compose network only —
// the gateway never routes /metrics here) every 5 s; the Grafana dashboard "eDemand RED" reads them.
//
// RED per service comes from ONE histogram: its _count gives the Rate, the _count with a 5xx (or
// "aborted") status_code gives the Errors, and its buckets give the Duration percentiles. `route` is
// the Express route pattern (/api/notifications/:id/read), never the raw path, so ids and scanners
// cannot blow up the number of series; a request no route matched is "unmatched". The compose
// healthcheck and the scrape itself are not measured — they would bury the real traffic.
//
// This file is identical in services/payments and services/notifications (keep it that way); the
// monolith records the same histogram from lib/http/handle.js (lib/metrics.js). The RabbitMQ consumer
// histogram lives in amqp.js, next to the code it measures.
import client from "prom-client";

export const registry = client.register;

// Seconds. Covers a 5 ms SQL read up to Step 5's slow replies (fault 2) and retries.
export const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

// The process-wide registry may already hold the metric (a module evaluated twice); reuse it.
function histogram(name, help, labelNames) {
  return registry.getSingleMetric(name) ?? new client.Histogram({ name, help, labelNames, buckets: BUCKETS });
}

// CPU, memory, event-loop lag, GC: read on each scrape, no timers of their own.
if (!registry.getSingleMetric("process_cpu_user_seconds_total")) client.collectDefaultMetrics();

export const httpDuration = histogram(
  "http_server_request_duration_seconds",
  "HTTP requests served, by route pattern and status (RED: rate = _count, errors = 5xx, duration = buckets)",
  ["method", "route", "status_code"],
);

const UNMEASURED = new Set(["/health", "/metrics"]);

// Express middleware: one observation per request, when its connection is done with it. A reply that
// never finished (the client went away, or the Step 5 drop_replies fault cut the socket) is "aborted".
export function measureRequests(req, res, next) {
  if (UNMEASURED.has(req.path)) return next();
  const end = httpDuration.startTimer();
  res.once("close", () => {
    end({
      method: req.method,
      route: req.route ? req.baseUrl + req.route.path : "unmatched",
      status_code: res.writableFinished ? String(res.statusCode) : "aborted",
    });
  });
  next();
}

export async function metricsHandler(_req, res, next) {
  try {
    res.set("content-type", registry.contentType);
    res.end(await registry.metrics());
  } catch (err) {
    next(err);
  }
}
