// Payments & Wallet owns payment_intents, transactions, provider_wallets, webhook_events, outbox and
// processed_events. SQL only. Every function takes `db` (the pool or a transaction client) so the
// service layer decides what runs inside one transaction.

// ---- payment_intents ----
// ON CONFLICT (order_id) DO NOTHING: two racing POST /intents for one order -> exactly one row.
export async function insertIntentIfAbsent(db, { orderId, customerId, providerId, amountCents, gatewayRef }) {
  const { rows } = await db.query(
    `INSERT INTO payment_intents (order_id, customer_id, provider_id, amount_cents, gateway_ref)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (order_id) DO NOTHING
     RETURNING *`,
    [orderId, customerId, providerId, amountCents, gatewayRef]
  );
  return rows[0];
}
export async function findIntentByOrderId(db, orderId) {
  const { rows } = await db.query("SELECT * FROM payment_intents WHERE order_id = $1", [orderId]);
  return rows[0];
}
export async function findIntentByGatewayRef(db, gatewayRef) {
  const { rows } = await db.query("SELECT * FROM payment_intents WHERE gateway_ref = $1", [gatewayRef]);
  return rows[0];
}
// Conditional status flip: the precondition lives in the WHERE, so a racing second caller gets 0 rows.
export async function transitionIntent(db, id, from, to) {
  const { rowCount } = await db.query(
    "UPDATE payment_intents SET status = $3, updated_at = now() WHERE id = $1 AND status = $2",
    [id, from, to]
  );
  return rowCount;
}

// ---- transactions ----
export async function insertTransaction(db, t) {
  const { rows } = await db.query(
    `INSERT INTO transactions (order_id, customer_id, provider_id, kind, amount_cents, method, gateway_ref, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [
      t.orderId ?? null, t.customerId ?? null, t.providerId ?? null, t.kind, t.amountCents,
      t.method, t.gatewayRef ?? null, t.status ?? "succeeded",
    ]
  );
  return rows[0].id;
}
export async function listTransactionsForProvider(db, providerId) {
  const { rows } = await db.query("SELECT * FROM transactions WHERE provider_id = $1 ORDER BY id DESC", [providerId]);
  return rows;
}
export async function listTransactionsForCustomer(db, customerId) {
  const { rows } = await db.query("SELECT * FROM transactions WHERE customer_id = $1 ORDER BY id DESC", [customerId]);
  return rows;
}

// ---- provider_wallets ----
export async function findWallet(db, providerId) {
  const { rows } = await db.query("SELECT * FROM provider_wallets WHERE provider_id = $1", [providerId]);
  return rows[0];
}
// Upsert on first credit: a provider registered after boot has no wallet row until money moves.
export async function addToWallet(db, providerId, { balanceCents = 0, commissionOwedCents = 0 }) {
  await db.query(
    `INSERT INTO provider_wallets (provider_id, balance_cents, commission_owed_cents)
     VALUES ($1, $2, $3)
     ON CONFLICT (provider_id) DO UPDATE SET
       balance_cents = provider_wallets.balance_cents + EXCLUDED.balance_cents,
       commission_owed_cents = provider_wallets.commission_owed_cents + EXCLUDED.commission_owed_cents,
       updated_at = now()`,
    [providerId, balanceCents, commissionOwedCents]
  );
}

// ---- webhook_events : the replay dedupe ----
// true on a fresh insert; false if the gateway_event_id was already recorded (a replay).
export async function recordWebhookEvent(db, gatewayEventId, type, payload) {
  const { rowCount } = await db.query(
    `INSERT INTO webhook_events (gateway_event_id, type, payload_json) VALUES ($1, $2, $3)
     ON CONFLICT (gateway_event_id) DO NOTHING`,
    [gatewayEventId, type, JSON.stringify(payload)]
  );
  return rowCount === 1;
}
export async function markWebhookProcessed(db, gatewayEventId) {
  await db.query("UPDATE webhook_events SET processed_at = now() WHERE gateway_event_id = $1", [gatewayEventId]);
}

// ---- outbox ----
export async function insertOutbox(db, type, aggregateType, aggregateId, payload) {
  await db.query(
    "INSERT INTO outbox (type, aggregate_type, aggregate_id, payload) VALUES ($1, $2, $3, $4)",
    [type, aggregateType, aggregateId, JSON.stringify(payload)]
  );
}
export async function listUnpublished(db, limit = 100) {
  const { rows } = await db.query(
    "SELECT * FROM outbox WHERE published_at IS NULL ORDER BY id LIMIT $1",
    [limit]
  );
  return rows;
}
export async function markPublished(db, id) {
  const { rowCount } = await db.query(
    "UPDATE outbox SET published_at = now() WHERE id = $1 AND published_at IS NULL",
    [id]
  );
  return rowCount;
}

// ---- processed_events : the inbox ----
export async function recordInbound(db, source, eventId, type) {
  const { rowCount } = await db.query(
    `INSERT INTO processed_events (source, event_id, type) VALUES ($1, $2, $3)
     ON CONFLICT (source, event_id) DO NOTHING`,
    [source, eventId, type]
  );
  return rowCount === 1;
}
