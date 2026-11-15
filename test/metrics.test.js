// Step 6 (E6): the monolith's Prometheus metrics. handle() records every API call in
// http_server_request_duration_seconds under its App Router route pattern, the RabbitMQ consumer records
// each handler attempt in messaging_process_duration_seconds, and GET /api/metrics serves both from the
// one prom-client registry.
import { freshBoot } from "../test-helpers/boot.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { call } from "../test-helpers/call.js";
import * as metricsRoute from "../app/api/metrics/route.js";
import * as health from "../app/api/health/route.js";
import * as serviceById from "../app/api/services/[id]/route.js";
import { routeOf } from "../lib/metrics.js";
import { handleDelivery } from "../lib/amqp/connection.js";

freshBoot();

async function scrape() {
  const res = await call(metricsRoute.GET, { path: "/api/metrics" });
  assert.equal(res.status, 200);
  return { text: res.body, type: res.headers.get("content-type") };
}

// The value of one sample line, e.g. sample(text, 'x_count{a="b"}'); undefined if absent.
function sample(text, series) {
  const line = text.split("\n").find((l) => l.startsWith(`${series} `));
  return line === undefined ? undefined : Number(line.slice(series.length + 1));
}

const count = (labels) => `http_server_request_duration_seconds_count{${labels}}`;

test("GET /api/metrics serves the Prometheus text format with the default process metrics", async () => {
  const { text, type } = await scrape();
  assert.match(type, /^text\/plain/);
  assert.match(text, /^# TYPE http_server_request_duration_seconds histogram$/m);
  assert.match(text, /^process_cpu_user_seconds_total /m);
});

test("an API call is counted under its route pattern and status, never its raw path", async () => {
  const ok = await call(serviceById.GET, { path: "/api/services/1", params: { id: "1" } });
  assert.equal(ok.status, 200);
  const missing = await call(serviceById.GET, { path: "/api/services/999999", params: { id: "999999" } });
  assert.equal(missing.status, 404);

  const { text } = await scrape();
  assert.equal(sample(text, count('method="GET",route="/api/services/[id]",status_code="200"')), 1);
  assert.equal(sample(text, count('method="GET",route="/api/services/[id]",status_code="404"')), 1);
  assert.doesNotMatch(text, /route="\/api\/services\/(1|999999)"/);
  // the duration lands in the buckets too (+Inf always counts every observation)
  assert.equal(sample(text, 'http_server_request_duration_seconds_bucket{le="+Inf",method="GET",route="/api/services/[id]",status_code="200"}'), 1);
});

test("the health check and the scrape itself are not counted", async () => {
  await call(health.GET, { path: "/api/health" });
  await scrape();
  const { text } = await scrape();
  assert.doesNotMatch(text, /route="\/api\/(health|metrics)"/);
});

test("routeOf rebuilds the App Router pattern from the path and the params", () => {
  assert.equal(routeOf("/api/jobs/12/bids/7/accept", { id: "12", bidId: "7" }), "/api/jobs/[id]/bids/[bidId]/accept");
  assert.equal(routeOf("/api/jobs/5/bids/5/accept", { id: "5", bidId: "5" }), "/api/jobs/[id]/bids/[bidId]/accept");
  assert.equal(routeOf("/api/categories/home%20care/services", { slug: "home care" }), "/api/categories/[slug]/services");
  assert.equal(routeOf("/api/bookings", {}), "/api/bookings");
  assert.equal(routeOf("/api/bookings", undefined), "/api/bookings");
  // an id that equals an earlier static word can only leave static words in the label
  assert.equal(routeOf("/api/bookings/bookings/complete", { id: "bookings" }), "/api/[id]/bookings/complete");
});

test("each consumer attempt is observed with its outcome", async () => {
  const ch = { ack() {}, nack() {} };
  const msg = { content: Buffer.from(JSON.stringify({ source: "payments", id: 41, type: "payment.succeeded", payload: {} })) };
  let calls = 0;
  await handleDelivery(ch, msg, async () => {
    if (++calls === 1) throw new Error("db blip");
  }, { warn() {}, info() {}, error() {} }, { queue: "booking.events", retries: 2, wait: async () => {} });
  assert.equal(calls, 2);

  const { text } = await scrape();
  const series = (outcome) =>
    `messaging_process_duration_seconds_count{queue="booking.events",type="payment.succeeded",outcome="${outcome}"}`;
  assert.equal(sample(text, series("error")), 1);
  assert.equal(sample(text, series("success")), 1);
});
