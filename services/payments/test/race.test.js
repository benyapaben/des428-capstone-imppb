import { test, after } from "node:test";
import assert from "node:assert/strict";
import { boot, sendEvent, sql } from "./helpers.js";

const app = await boot();
after(() => app.close());

const PROVIDER = 1;
const EARNINGS = 54570;
const N = 10;
const completed = (id, order_id) => ({
  source: "monolith", id, type: "booking.completed",
  payload: {
    order_id, total_cents: 64200, commission_cents: 9630, provider_earnings_cents: EARNINGS,
    customer_id: 1, provider_id: PROVIDER, payment_method: "gateway",
  },
});

test("booking.completed delivered N times at the same moment credits the wallet once", async () => {
  const before = (await sql("SELECT balance_cents FROM provider_wallets WHERE provider_id = $1", [PROVIDER]))[0].balance_cents;

  const results = await Promise.all(Array.from({ length: N }, () => sendEvent(app.base, completed(701, 9701))));
  assert.ok(results.every((r) => r.status === 200));

  const [{ balance_cents }] = await sql("SELECT balance_cents FROM provider_wallets WHERE provider_id = $1", [PROVIDER]);
  const credits = Number((await sql("SELECT COUNT(*) AS n FROM transactions WHERE order_id = 9701 AND kind = 'payout_credit'"))[0].n);

  console.log(`# ${N} concurrent deliveries -> credited ${credits}x, balance +${balance_cents - before}`);
  assert.equal(credits, 1, "exactly one payout_credit transaction");
  assert.equal(balance_cents - before, EARNINGS, "wallet grew by exactly one credit");
});
