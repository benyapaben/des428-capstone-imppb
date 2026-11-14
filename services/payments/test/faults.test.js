// Step 5: input checks on the /internal/faults switch (the behaviour of each fault is covered by
// resilience.test.js).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { boot, request, config } from "./helpers.js";

const app = await boot();
after(() => app.close());

const internal = { "x-internal-token": config.internalToken };
const setFaults = (body) => request(app.base, "/internal/faults", { body, headers: internal });
const clearFaults = () => request(app.base, "/internal/faults", { method: "DELETE", headers: internal });

test("/internal/faults rejects settings that would be unbounded or silently do nothing", async (t) => {
  t.afterEach(clearFaults);

  await t.test("values above the caps -> 400, nothing switched on", async () => {
    assert.equal((await setFaults({ down_ms: 600_001 })).status, 400);
    assert.equal((await setFaults({ delay_replies: 1, delay_ms: 60_001 })).status, 400);
    assert.equal((await setFaults({ drop_replies: 101 })).status, 400);
    const now = await request(app.base, "/internal/faults", { headers: internal });
    assert.equal(now.body.down, false);
    assert.equal(now.body.drop_replies, 0);
  });

  await t.test("delay_replies without a delay_ms -> 400", async () => {
    const res = await setFaults({ delay_replies: 2 });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /delay_ms/);
  });

  await t.test("unknown keys -> 400", async () => {
    assert.equal((await setFaults({ down: true })).status, 400);
  });

  await t.test("a valid setting is applied and reported back", async () => {
    const res = await setFaults({ delay_replies: 1, delay_ms: 50 });
    assert.equal(res.status, 200);
    assert.equal(res.body.delay_replies, 1);
    assert.equal(res.body.delay_ms, 50);
  });
});
