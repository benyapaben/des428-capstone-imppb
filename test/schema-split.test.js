// Step 2 done-check: the tables owned by the extracted services are gone from the monolith schema.
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshBoot, getDb } from "../test-helpers/boot.js";

freshBoot();

test("extracted tables are not in the monolith database", () => {
  const tables = getDb()
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((r) => r.name);
  for (const gone of ["payment_intents", "transactions", "provider_wallets", "webhook_events", "notifications"]) {
    assert.ok(!tables.includes(gone), `${gone} must live in its own service now`);
  }
  for (const kept of ["orders", "events", "inbox_events", "idempotency_keys"]) {
    assert.ok(tables.includes(kept), `${kept} is still the monolith's`);
  }
  const cols = getDb().prepare("PRAGMA table_info(orders)").all().map((c) => c.name);
  assert.ok(cols.includes("gateway_ref") && cols.includes("payment_status"), "orders keeps the payment copy");
});
