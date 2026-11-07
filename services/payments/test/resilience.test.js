// Step 5 / Area D: the receiving side of POST /intents under the three fault switches.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { boot, request, sql, createIntent, config } from "./helpers.js";

const app = await boot();
after(() => app.close());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const intentBody = (order_id) => ({ order_id, customer_id: 1, provider_id: 1, amount_cents: 64200 });
const intentRows = async (order_id) => sql("SELECT * FROM payment_intents WHERE order_id = $1", [order_id]);
const internal = { "x-internal-token": config.internalToken };
const setFaults = (body) => request(app.base, "/internal/faults", { body, headers: internal });
const clearFaults = () => request(app.base, "/internal/faults", { method: "DELETE", headers: internal });

test("POST /intents under fault switches", async (t) => {
  t.afterEach(clearFaults);

  await t.test("the fault switch needs the internal token", async () => {
    assert.equal((await request(app.base, "/internal/faults", { body: { drop_replies: 1 } })).status, 401);
    assert.equal((await request(app.base, "/internal/faults")).status, 401);
  });

  await t.test("fault 1: reply cut after the write -> retry gets the stored intent; one row", async () => {
    await setFaults({ drop_replies: 1 });
    await assert.rejects(createIntent(app.base, intentBody(9101)), "the first reply never arrives");
    assert.equal((await intentRows(9101)).length, 1, "...but the write had already committed");

    const retry = await createIntent(app.base, intentBody(9101));
    assert.equal(retry.status, 200, "existing intent -> 200, not created again");
    const rows = await intentRows(9101);
    assert.equal(rows.length, 1, "retried write saved exactly once");
    assert.equal(retry.body.gateway_ref, rows[0].gateway_ref);
  });

  await t.test("fault 2: reply slower than the timeout -> retry gets the stored intent; one row", async () => {
    await setFaults({ delay_replies: 1, delay_ms: 400 });
    const first = fetch(`${app.base}/intents`, {
      method: "POST",
      headers: { ...internal, "content-type": "application/json", "idempotency-key": "9102" },
      body: JSON.stringify(intentBody(9102)),
      signal: AbortSignal.timeout(100),
    });
    await assert.rejects(first);

    const retry = await createIntent(app.base, intentBody(9102));
    assert.equal(retry.status, 200);
    await sleep(450);
    const rows = await intentRows(9102);
    assert.equal(rows.length, 1, "retried write saved exactly once");
    assert.equal(retry.body.gateway_ref, rows[0].gateway_ref);
  });

  await t.test("fault 3: service down for a window -> nothing written; after it the retry succeeds once", async () => {
    await setFaults({ down_ms: 400 });
    assert.equal((await request(app.base, "/health")).status, 200);
    assert.equal((await createIntent(app.base, intentBody(9103))).status, 503);
    assert.equal((await intentRows(9103)).length, 0, "a down service wrote nothing");

    let res;
    for (let attempt = 0; attempt < 20; attempt++) {
      res = await createIntent(app.base, intentBody(9103));
      if (res.status !== 503) break;
      await sleep(100);
    }
    assert.equal(res.status, 201);
    assert.equal((await createIntent(app.base, intentBody(9103))).status, 200);
    assert.equal((await intentRows(9103)).length, 1);
  });

  await t.test("ten simultaneous retries of one write -> one 201, nine 200, one row", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => createIntent(app.base, intentBody(9104))));
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 200, 200, 200, 200, 201]);
    assert.equal((await intentRows(9104)).length, 1);
  });
});
