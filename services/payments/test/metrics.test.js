// Step 6 (E6): GET /metrics and the RED histogram (http_server_request_duration_seconds) in Payments.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { boot, request, createIntent, tokenFor, config } from "./helpers.js";

const app = await boot();
after(() => app.close());

const internal = { "x-internal-token": config.internalToken };
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

// The observation is made when the connection is done with the request, just after the client has
// its reply (or its error): poll the scrape briefly instead of reading it once.
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

test("requests are counted by route pattern and status", async () => {
  assert.equal((await request(app.base, "/api/provider/wallet", { token: tokenFor("provider", 1) })).status, 200);
  assert.equal((await request(app.base, "/api/provider/wallet")).status, 401);
  assert.equal((await createIntent(app.base, { order_id: 9301, customer_id: 1, provider_id: 1, amount_cents: 100 })).status, 201);
  assert.equal((await request(app.base, "/api/no-such-route/123")).status, 404);

  await eventually(count('method="GET",route="/api/provider/wallet",status_code="200"'), 1);
  await eventually(count('method="GET",route="/api/provider/wallet",status_code="401"'), 1);
  await eventually(count('method="POST",route="/intents",status_code="201"'), 1);
  await eventually(count('method="GET",route="unmatched",status_code="404"'), 1);
  assert.doesNotMatch((await scrape()).text, /no-such-route/, "an unmatched path never becomes a label");
});

test("a reply cut by the drop_replies fault is counted as aborted", async () => {
  await request(app.base, "/internal/faults", { body: { drop_replies: 1 }, headers: internal });
  try {
    await assert.rejects(createIntent(app.base, { order_id: 9302, customer_id: 1, provider_id: 1, amount_cents: 100 }));
    await eventually(count('method="POST",route="/intents",status_code="aborted"'), 1);
  } finally {
    await request(app.base, "/internal/faults", { method: "DELETE", headers: internal });
  }
});

test("the health check and the scrape itself are not counted", async () => {
  assert.equal((await request(app.base, "/health")).status, 200);
  await scrape();
  assert.doesNotMatch((await scrape()).text, /route="\/(health|metrics)"/);
});
