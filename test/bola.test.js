import { test } from "node:test";
import assert from "node:assert/strict";
import { freshBoot, getDb } from "../test-helpers/boot.js";
import { call } from "../test-helpers/call.js";
import { registerCustomer, futureWeekday } from "../test-helpers/auth.js";

import * as jobs from "../app/api/jobs/route.js";
import * as jobDetail from "../app/api/jobs/[id]/route.js";

freshBoot();

// BOLA (Broken Object Level Authorization) on GET /api/jobs/:id.
// The route only checks that the caller is logged in; getJob never checks who owns the job.

test("BOLA: GET /api/jobs/:id", async (t) => {
  const victim = await registerCustomer({ name: "Victim" });
  const attacker = await registerCustomer({ name: "Attacker" });

  const category = getDb().prepare("SELECT id FROM categories WHERE slug='appliance'").get().id;
  const date = futureWeekday(5);
  const posted = await call(jobs.POST, {
    token: victim.token,
    body: {
      category_id: category, title: "Private: fix fridge at home",
      description: "Gate code 4421, key under the mat",
      min_price_cents: 30000, max_price_cents: 90000,
      window_start: `${date} 10:00`, window_end: `${date} 17:00`,
    },
  });
  assert.equal(posted.status, 201);
  const jobId = String(posted.body.id);

  await t.test("attack: another customer reads the victim's job -> LEAKS (200)", async () => {
    const res = await call(jobDetail.GET, { token: attacker.token, params: { id: jobId } });
    assert.equal(res.status, 200, "the leak: a non-owner customer gets the job");
    assert.equal(res.body.job.description, "Gate code 4421, key under the mat");
    assert.equal(res.body.job.customer_id, victim.id);
  });
});
