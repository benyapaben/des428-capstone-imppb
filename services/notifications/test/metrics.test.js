// Step 6 (E6): GET /metrics and the RED histogram (http_server_request_duration_seconds) in Notifications.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { boot, request, tokenFor } from "./helpers.js";

const app = await boot();
after(() => app.close());

const count = (labels) => `http_server_request_duration_seconds_count{${labels}}`;

async function scrape() {
  const res = await fetch(`${app.base}/metrics`);
  assert.equal(res.status, 200);
  return { text: await res.text(), type: res.headers.get("content-type") };
}

function sample(text, series) {
  const line = text.split("\n").find((l) => l.startsWith(`${series} `));
  return line === undefined ? undefined : Number(line.slice(series.length + 1));
}

async function eventually(series, expected) {
  let last;
  for (let i = 0; i < 50; i++) {
    last = sample((await scrape()).text, series);
    if (last === expected) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(last, expected, series);
}

test("GET /metrics serves the Prometheus text format with the default process metrics", async () => {
  const { text, type } = await scrape();
  assert.match(type, /^text\/plain/);
  assert.match(text, /^# TYPE http_server_request_duration_seconds histogram$/m);
  assert.match(text, /^process_cpu_user_seconds_total /m);
});

test("requests are counted by route pattern (ids never become labels) and status", async () => {
  const customer = tokenFor("customer", 1);
  assert.equal((await request(app.base, "/api/notifications", { token: customer })).status, 200);
  assert.equal((await request(app.base, "/api/notifications/987654/read", { method: "POST", token: customer })).status, 404);
  assert.equal((await request(app.base, "/api/notifications")).status, 401);
  assert.equal((await request(app.base, "/nope")).status, 404);

  await eventually(count('method="GET",route="/api/notifications",status_code="200"'), 1);
  await eventually(count('method="GET",route="/api/notifications",status_code="401"'), 1);
  await eventually(count('method="POST",route="/api/notifications/:id/read",status_code="404"'), 1);
  await eventually(count('method="GET",route="unmatched",status_code="404"'), 1);
  assert.doesNotMatch((await scrape()).text, /987654|\/nope/);
});

test("the health check and the scrape itself are not counted", async () => {
  assert.equal((await request(app.base, "/health")).status, 200);
  await scrape();
  assert.doesNotMatch((await scrape()).text, /route="\/(health|metrics)"/);
});
