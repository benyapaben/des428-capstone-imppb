// Pact provider verification for edemand -> notifications (Step 6 / E7). Replays every interaction in
// the contract the monolith wrote (pacts/edemand-notifications.json, from `npm run test:pact` in the
// repo root, or PACT_DIR in CI) against the real Express app on a real Postgres, and fails if any
// response does not match. State handlers put the database into the state an interaction names.
import { boot, sendEvent, tokenFor, config } from "../helpers.js";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Verifier } from "@pact-foundation/pact";

const { query } = await import("../../src/db.js");   // after helpers.js has set the env

const PACT_DIR = process.env.PACT_DIR ?? fileURLToPath(new URL("../../../../pacts/", import.meta.url));
const pactFile = `${PACT_DIR.replace(/\/?$/, "/")}edemand-notifications.json`;

const app = await boot();
after(() => app.close());

let eventId = 0;   // boot() recreated the schema; a fresh id per state, so none is deduped away
const clearCustomer1 = () => query("DELETE FROM notifications WHERE recipient_role = 'customer' AND recipient_id = 1");

const stateHandlers = {
  "customer 1 has an unread notification": async () => {
    await clearCustomer1();
    // The way it really happens: the provider confirms, Booking emits booking.status_changed.
    const res = await sendEvent(app.base, {
      source: "edemand", id: ++eventId, type: "booking.status_changed",
      payload: { order_id: 8001, customer_id: 1, provider_id: 1, actor_role: "provider", from: "pending", to: "confirmed" },
    });
    assert.equal(res.status, 200);
  },
  "customer 1 has no notifications": clearCustomer1,
};

// Pact only logs a state handler that throws and then verifies anyway, against the wrong state. Record
// the failures and fail the test on them, so a broken setup is never reported as a contract mismatch.
const stateErrors = [];
const guarded = Object.fromEntries(Object.entries(stateHandlers).map(([name, fn]) => [name, async (params) => {
  try {
    return await fn(params);
  } catch (err) {
    stateErrors.push(`${name}: ${err.message}`);
    throw err;
  }
}]));

// The contract names the caller ("Bearer customer-1"), not a token: swap in a real signed token.
function requestFilter(req, _res, next) {
  const m = /^Bearer (customer|provider|admin)-(\d+)$/.exec(req.headers.authorization ?? "");
  if (m) req.headers.authorization = `Bearer ${tokenFor(m[1], Number(m[2]))}`;
  if (req.headers["x-internal-token"]) req.headers["x-internal-token"] = config.internalToken;
  next();
}

test("Notifications honours the edemand -> notifications contract", async () => {
  assert.ok(existsSync(pactFile), `${pactFile} not found: run \`npm run test:pact\` in the repo root first`);
  // the verifier rejects on any mismatch; a state that could not be set up is reported first
  const failure = await new Verifier({
    provider: "notifications",
    providerBaseUrl: app.base,
    pactUrls: [pactFile],
    stateHandlers: guarded,
    requestFilter,
    logLevel: "warn",
  }).verifyProvider().then(() => null, (err) => err);
  assert.deepEqual(stateErrors, [], "a provider state could not be set up");
  if (failure) throw failure;
});
