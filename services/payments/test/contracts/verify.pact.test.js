// Pact provider verification for edemand -> payments (Step 6 / E7). Replays every interaction in the
// contract the monolith wrote (pacts/edemand-payments.json, from `npm run test:pact` in the repo root,
// or PACT_DIR in CI) against the real Express app on a real Postgres, and fails if any response does
// not match. State handlers put the database into the state an interaction names, through the
// service's own endpoints where it has one.
import { boot, sql, sendEvent, createIntent, tokenFor, config } from "../helpers.js";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Verifier } from "@pact-foundation/pact";

const PACT_DIR = process.env.PACT_DIR ?? fileURLToPath(new URL("../../../../pacts/", import.meta.url));
const pactFile = `${PACT_DIR.replace(/\/?$/, "/")}edemand-payments.json`;

const app = await boot();
after(() => app.close());

const ORDER = { order_id: 8001, customer_id: 1, provider_id: 1, amount_cents: 64200 };
let eventId = 0;   // boot() recreated the schema; a fresh id per state, so none is deduped away

const stateHandlers = {
  "no payment intent exists for order 8001": async () => {
    await sql("DELETE FROM payment_intents WHERE order_id = $1", [ORDER.order_id]);
  },
  "a payment intent exists for order 8001": async () => {
    await sql("DELETE FROM payment_intents WHERE order_id = $1", [ORDER.order_id]);
    assert.equal((await createIntent(app.base, ORDER)).status, 201);
  },
  "provider 1 has been paid for order 8001": async () => {
    await sql("DELETE FROM transactions WHERE provider_id = 1");
    await sql("DELETE FROM provider_wallets WHERE provider_id = 1");
    // The way it really happens: Booking's booking.completed event credits the wallet.
    const res = await sendEvent(app.base, {
      source: "edemand", id: ++eventId, type: "booking.completed",
      payload: { ...ORDER, payment_method: "gateway", provider_earnings_cents: 54570, commission_cents: 9630 },
    });
    assert.equal(res.status, 200);
  },
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

// The contract names the caller ("Bearer provider-1"), not a token: swap in a real signed token for that
// role and id, and this service's own internal token.
function requestFilter(req, _res, next) {
  const m = /^Bearer (customer|provider|admin)-(\d+)$/.exec(req.headers.authorization ?? "");
  if (m) req.headers.authorization = `Bearer ${tokenFor(m[1], Number(m[2]))}`;
  if (req.headers["x-internal-token"]) req.headers["x-internal-token"] = config.internalToken;
  next();
}

test("Payments honours the edemand -> payments contract", async () => {
  assert.ok(existsSync(pactFile), `${pactFile} not found: run \`npm run test:pact\` in the repo root first`);
  // the verifier rejects on any mismatch; a state that could not be set up is reported first
  const failure = await new Verifier({
    provider: "payments",
    providerBaseUrl: app.base,
    pactUrls: [pactFile],
    stateHandlers: guarded,
    requestFilter,
    logLevel: "warn",
  }).verifyProvider().then(() => null, (err) => err);
  assert.deepEqual(stateErrors, [], "a provider state could not be set up");
  if (failure) throw failure;
});
