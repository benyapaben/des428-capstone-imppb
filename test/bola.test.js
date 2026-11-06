import { test } from "node:test";
import assert from "node:assert/strict";
import { freshBoot, getDb } from "../test-helpers/boot.js";
import { call } from "../test-helpers/call.js";
import { registerCustomer, loginSeededProvider, loginAdmin, futureWeekday } from "../test-helpers/auth.js";

import * as jobs from "../app/api/jobs/route.js";
import * as jobDetail from "../app/api/jobs/[id]/route.js";
import * as jobBids from "../app/api/jobs/[id]/bids/route.js";
import * as acceptBid from "../app/api/jobs/[id]/bids/[bidId]/accept/route.js";

freshBoot();

// BOLA (Broken Object Level Authorization) on GET /api/jobs/:id.
// Before the fix the route only checked that the caller was logged in, and getJob never checked
// who owned the job. Read policy now:
//   customer -> own jobs only; provider -> open jobs + jobs they bid on; admin -> all.

async function postJob(customer, time) {
  const category = getDb().prepare("SELECT id FROM categories WHERE slug='appliance'").get().id;
  const date = futureWeekday(5);
  const res = await call(jobs.POST, {
    token: customer.token,
    body: {
      category_id: category, title: "Private: fix fridge at home",
      description: "Gate code 4421, key under the mat",
      min_price_cents: 30000, max_price_cents: 90000,
      window_start: `${date} ${time}`, window_end: `${date} 17:00`,
    },
  });
  assert.equal(res.status, 201);
  return String(res.body.id);
}

test("BOLA: GET /api/jobs/:id", async (t) => {
  const victim = await registerCustomer({ name: "Victim" });
  const attacker = await registerCustomer({ name: "Attacker" });
  const fixit = await loginSeededProvider("fixit@example.com");
  const sparkle = await loginSeededProvider("sparkle@example.com");
  const admin = await loginAdmin();

  const openJob = await postJob(victim, "10:00");

  await t.test("attack: another customer reads the victim's job -> 403, nothing leaked", async () => {
    const res = await call(jobDetail.GET, { token: attacker.token, params: { id: openJob } });
    assert.equal(res.status, 403);
    assert.equal(res.body.job, undefined, "no job data in the error body");
  });

  await t.test("owner reads their own job -> 200", async () => {
    const res = await call(jobDetail.GET, { token: victim.token, params: { id: openJob } });
    assert.equal(res.status, 200);
    assert.equal(res.body.job.customer_id, victim.id);
  });

  await t.test("provider reads an open job (to bid on it) -> 200", async () => {
    const res = await call(jobDetail.GET, { token: sparkle.token, params: { id: openJob } });
    assert.equal(res.status, 200);
  });

  await t.test("booked job: winning bidder -> 200, provider who never bid -> 403", async () => {
    const jobId = await postJob(victim, "13:00");
    const bid = await call(jobBids.POST, { token: fixit.token, params: { id: jobId }, body: { counter_price_cents: 50000, duration_min: 60 } });
    assert.equal(bid.status, 201);
    const accepted = await call(acceptBid.POST, { token: victim.token, params: { id: jobId, bidId: String(bid.body.id) }, method: "POST" });
    assert.equal(accepted.status, 200);

    const asBidder = await call(jobDetail.GET, { token: fixit.token, params: { id: jobId } });
    assert.equal(asBidder.status, 200, "a provider can follow a job it bid on after it closes");
    assert.equal(asBidder.body.bids.length, 1, "and still sees only its own bid");

    const asStranger = await call(jobDetail.GET, { token: sparkle.token, params: { id: jobId } });
    assert.equal(asStranger.status, 403, "a closed job is hidden from providers that never bid");
  });

  await t.test("admin reads any job -> 200", async () => {
    const res = await call(jobDetail.GET, { token: admin.token, params: { id: openJob } });
    assert.equal(res.status, 200);
  });

  await t.test("unknown job -> 404; no token -> 401", async () => {
    const missing = await call(jobDetail.GET, { token: victim.token, params: { id: "999999" } });
    assert.equal(missing.status, 404);
    const anon = await call(jobDetail.GET, { params: { id: openJob } });
    assert.equal(anon.status, 401);
  });
});
