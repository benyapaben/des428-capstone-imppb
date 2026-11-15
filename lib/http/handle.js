// The single wrapper every route handler is built with. It derives a request id, runs the handler,
// stamps X-Request-Id on whatever response comes back, and funnels any thrown error through
// toResponse so status + body + logging stay uniform. This is the App Router analogue of Ride's
// requestId + errorHandler middleware pair.
//
// Step 6 (E5): the handler runs with the request id in the OpenTelemetry context (baggage), so every
// log line it writes carries request_id + trace_id, and so do the events it writes to the outbox. The
// response also gets X-Trace-Id: paste it into Jaeger (http://localhost:16686/trace/<id>). One
// "request" log line per call (method, path, status, ms), as the services write, except for the
// health check and the metrics scrape, which would otherwise add a line every few seconds.
//
// Step 6 (E6): each call is also one observation of http_server_request_duration_seconds (lib/metrics.js)
// labelled with the route pattern, so Prometheus/Grafana get rate, errors and duration per route.
import { trace, isSpanContextValid } from "@opentelemetry/api";
import { requestId } from "./requestId.js";
import { toResponse } from "./respond.js";
import { logger, withRequestId } from "../logger.js";
import { UNMEASURED, observeRequest } from "../metrics.js";

export function handle(fn) {
  return (req, ctx = {}) => {
    const id = requestId(req);
    return withRequestId(id, async () => {
      const started = Date.now();
      let res;
      try {
        res = await fn(req, ctx, id);
      } catch (err) {
        res = toResponse(err, id);
      }
      if (res && res.headers) {
        if (!res.headers.get("X-Request-Id")) res.headers.set("X-Request-Id", id);
        const span = trace.getActiveSpan()?.spanContext();
        if (span && isSpanContextValid(span) && !res.headers.get("X-Trace-Id")) {
          res.headers.set("X-Trace-Id", span.traceId);
        }
      }
      const path = new URL(req.url).pathname;
      if (!UNMEASURED.has(path)) {
        const ms = Date.now() - started;
        logger.info({ request_id: id, method: req.method, path, status: res?.status, ms }, "request");
        observeRequest({ method: req.method, pathname: path, params: ctx.params, status: res?.status, seconds: ms / 1000 });
      }
      return res;
    });
  };
}
