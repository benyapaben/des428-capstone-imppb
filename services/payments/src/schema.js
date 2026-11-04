// pay_db schema — the four tables that moved out of the monolith, plus this service's own outbox and
// inbox. Dropped and recreated on every boot (deterministic, like the monolith). There are no foreign
// keys to orders/providers any more: those live in another database, and ids are just values here.
export const SCHEMA_SQL = `
DROP TABLE IF EXISTS processed_events;
DROP TABLE IF EXISTS outbox;
DROP TABLE IF EXISTS webhook_events;
DROP TABLE IF EXISTS provider_wallets;
DROP TABLE IF EXISTS transactions;
DROP TABLE IF EXISTS payment_intents;

CREATE TABLE payment_intents (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL UNIQUE,          -- the Idempotency-Key of POST /intents
  customer_id INTEGER NOT NULL,              -- new in Step 2: lets /simulate authorize without reading orders
  provider_id INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  gateway_ref TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'requires_payment'
        CHECK (status IN ('requires_payment','succeeded','failed','refunded','canceled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE transactions (
  id SERIAL PRIMARY KEY,
  order_id INTEGER,
  customer_id INTEGER,
  provider_id INTEGER,
  kind TEXT NOT NULL CHECK (kind IN ('charge','payout_credit','commission_owed','refund')),
  amount_cents INTEGER NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('cod','gateway')),
  gateway_ref TEXT,
  status TEXT NOT NULL DEFAULT 'succeeded' CHECK (status IN ('pending','succeeded','failed','refunded')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_transactions_provider ON transactions (provider_id);
CREATE INDEX idx_transactions_customer ON transactions (customer_id);
CREATE INDEX idx_transactions_order ON transactions (order_id);

CREATE TABLE provider_wallets (
  provider_id INTEGER PRIMARY KEY,
  balance_cents INTEGER NOT NULL DEFAULT 0,
  commission_owed_cents INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Webhook idempotency: the gateway's event id is the dedupe key. UNIQUE = a replay cannot double-credit.
CREATE TABLE webhook_events (
  id SERIAL PRIMARY KEY,
  gateway_event_id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);

-- Outbox: payment.* events written in the SAME transaction as the state change; drained by relay.js.
CREATE TABLE outbox (
  id SERIAL PRIMARY KEY,
  type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id INTEGER NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);
CREATE INDEX idx_outbox_unpublished ON outbox (id) WHERE published_at IS NULL;

-- Inbox: events consumed from the monolith (booking.completed / booking.cancelled), deduped by (source, id).
CREATE TABLE processed_events (
  source TEXT NOT NULL,
  event_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source, event_id)
);
`;

export async function migrate(db) {
  await db.query(SCHEMA_SQL);
}

// Same provider ids as the monolith's seed, each with an empty wallet.
export async function seed(db, providerIds) {
  for (const id of providerIds) {
    await db.query(
      "INSERT INTO provider_wallets (provider_id) VALUES ($1) ON CONFLICT (provider_id) DO NOTHING",
      [id]
    );
  }
}
