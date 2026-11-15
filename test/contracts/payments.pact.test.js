// Pact consumer contract edemand -> payments (Step 6 / E7). Runs the monolith's real client code
// (lib/clients/payments.js) against a Pact mock server and writes pacts/edemand-payments.json, which
// Payments verifies against its real app (services/payments/test/contracts/verify.pact.test.js).
//
// Consumer-driven: a response lists only the fields the monolith actually reads, so Payments stays free
// to add or change everything else.
import { PAYMENTS_MOCK_PORT, PACT_DIR, freshPactFile, placeholderToken, BEARER, ISO_TIME, JSON_TYPE } from "./env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { PactV3, MatchersV3 } from "@pact-foundation/pact";

const { like, integer, string, regex, eachLike } = MatchersV3;
const { createIntent, getWallet } = await import("../../lib/clients/payments.js");

freshPactFile("edemand", "payments");
const pact = new PactV3({
  consumer: "edemand",
  provider: "payments",
  dir: PACT_DIR,
  port: PAYMENTS_MOCK_PORT,
  logLevel: "warn",
});

const order = { orderId: 8001, amountCents: 64200, customerId: 1, providerId: 1 };

// What placeBooking sends (Idempotency-Key = order_id, internal token, never a user token).
const intentRequest = {
  method: "POST",
  path: "/intents",
  headers: {
    "content-type": "application/json",
    "x-internal-token": like("edemand-internal-token"),
    "idempotency-key": "8001",
  },
  body: { order_id: 8001, amount_cents: 64200, customer_id: 1, provider_id: 1 },
};
// placeBooking stores only gateway_ref on the order (orders.gateway_ref).
const intentBody = { gateway_ref: string("SIM-PI-6f1c2b7e-0d4a-4a8e-9a65-1d2e3f405060") };

test("POST /intents for a new order creates the intent (201)", async () => {
  pact
    .given("no payment intent exists for order 8001")
    .uponReceiving("a request to create the payment intent for order 8001")
    .withRequest(intentRequest)
    .willRespondWith({ status: 201, headers: { "content-type": regex(JSON_TYPE, "application/json; charset=utf-8") }, body: intentBody });

  await pact.executeTest(async () => {
    const intent = await createIntent(order);
    assert.match(intent.gateway_ref, /\S/);
  });
});

test("POST /intents again for the same order returns the stored intent (200)", async () => {
  pact
    .given("a payment intent exists for order 8001")
    .uponReceiving("a repeated request to create the payment intent for order 8001")
    .withRequest(intentRequest)
    .willRespondWith({ status: 200, headers: { "content-type": regex(JSON_TYPE, "application/json; charset=utf-8") }, body: intentBody });

  await pact.executeTest(async () => {
    const intent = await createIntent(order);
    assert.match(intent.gateway_ref, /\S/);
  });
});

test("GET /api/provider/wallet returns the provider's balances and transactions", async () => {
  pact
    .given("provider 1 has been paid for order 8001")
    .uponReceiving("a request for provider 1's wallet")
    .withRequest({
      method: "GET",
      path: "/api/provider/wallet",
      headers: { authorization: regex(BEARER, "Bearer provider-1"), accept: "application/json" },
    })
    .willRespondWith({
      status: 200,
      headers: { "content-type": regex(JSON_TYPE, "application/json; charset=utf-8") },
      // The fields the wallet and dashboard pages render.
      body: {
        balance_cents: integer(54570),
        commission_owed_cents: integer(0),
        transactions: eachLike({
          id: integer(1),
          order_id: integer(8001),
          kind: string("payout_credit"),
          amount_cents: integer(54570),
          method: string("gateway"),
          created_at: regex(ISO_TIME, "2026-11-15T10:00:00.000Z"),
        }),
      },
    });

  await pact.executeTest(async () => {
    const res = await getWallet({ token: placeholderToken("provider", 1) });
    assert.equal(res.ok, true);
    assert.equal(typeof res.data.balance_cents, "number");
    assert.equal(res.data.transactions[0].kind, "payout_credit");
    assert.match(res.data.transactions[0].created_at.slice(0, 16), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });
});
