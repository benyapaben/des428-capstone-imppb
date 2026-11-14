// Central environment configuration. Every module reads settings from here — nothing else in the
// codebase touches process.env directly (except db/index.js resolving the db path at open time),
// so the whole config surface is grep-able in one file.
const NODE_ENV = process.env.NODE_ENV || "development";

// A non-negative integer setting: 0 is a valid value, while unset, empty or malformed falls back.
const intEnv = (name, fallback) => (/^\d+$/.test(process.env[name] ?? "") ? Number(process.env[name]) : fallback);

export const config = Object.freeze({
  nodeEnv: NODE_ENV,
  isTest: NODE_ENV === "test",
  port: parseInt(process.env.PORT, 10) || 3000,
  logLevel: process.env.LOG_LEVEL || (NODE_ENV === "test" ? "silent" : "info"),
  bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS, 10) || 10,
  // First order id after a fresh seed. sqlite_sequence is primed to (firstOrderId - 1) so the next
  // AUTOINCREMENT insert lands here, deterministically, on every boot.
  firstOrderId: 8001,
  // One flat tax rate, snapshotted onto each order_item at booking time (tax-excluded).
  taxPercent: 7.0,
  // Shared secret the mock payment gateway signs its webhook callbacks with.
  webhookSecret: process.env.WEBHOOK_SECRET || "edemand-webhook-secret",

  // ---- Step 2: extracted services ----
  // Base URLs the monolith calls server-to-server (inside the compose network, never via nginx).
  paymentsUrl: (process.env.PAYMENTS_URL || "http://localhost:4002").replace(/\/$/, ""),
  notificationsUrl: (process.env.NOTIFICATIONS_URL || "http://localhost:4001").replace(/\/$/, ""),
  // Shared secret for service-to-service calls (POST /intents, event delivery). Never sent by a browser.
  internalToken: process.env.INTERNAL_TOKEN || "edemand-internal-token",
  // ---- Step 5: resilience of the one remaining sync call, POST /intents ----
  // Each attempt is cut off after paymentsTimeoutMs; failed attempts (network error, timeout, 5xx) are
  // retried up to paymentsMaxRetries times with full-jitter exponential backoff (base / cap below).
  // Retrying is safe because every attempt carries the same Idempotency-Key (= order_id).
  paymentsTimeoutMs: intEnv("PAYMENTS_TIMEOUT_MS", 2000) || 2000,   // 0 would abort every attempt at once
  paymentsMaxRetries: intEnv("PAYMENTS_MAX_RETRIES", 3),
  paymentsBackoffBaseMs: intEnv("PAYMENTS_BACKOFF_BASE_MS", 200),
  paymentsBackoffCapMs: intEnv("PAYMENTS_BACKOFF_CAP_MS", 2000),
  // ---- Step 4: the outbox relay publishes every domain event to RabbitMQ ----
  // How often the relay drains the events table, and the broker it publishes to / consumes from.
  relayIntervalMs: parseInt(process.env.RELAY_INTERVAL_MS, 10) || 1000,
  amqpUrl: process.env.AMQP_URL || "amqp://guest:guest@localhost:5672",
  // RabbitMQ resilience: a publish with no broker confirm after publishTimeoutMs fails (the relay retries
  // it next tick); a consumer retries a failing handler consumerRetries times, waiting consumerRetryBaseMs
  // doubled each time (~15.5 s with the defaults), before handing the message back to the broker.
  publishTimeoutMs: parseInt(process.env.PUBLISH_TIMEOUT_MS, 10) || 5000,
  // 0 is allowed (no in-process retry); empty or invalid falls back to 5 rather than silently to 0.
  consumerRetries: intEnv("CONSUMER_RETRIES", 5),
  consumerRetryBaseMs: parseInt(process.env.CONSUMER_RETRY_BASE_MS, 10) || 500,
  paymentTimeoutSeconds: parseInt(process.env.PAYMENT_TIMEOUT_SECONDS, 10) || 900,
  sweepIntervalMs: parseInt(process.env.SWEEP_INTERVAL_MS, 10) || 5000,

  // ---- Step 3: Keycloak is the identity provider (realm: deploy/keycloak/edemand-realm.json) ----
  // keycloakUrl is how THIS process reaches Keycloak (http://keycloak:8080 inside compose). The issuer
  // is pinned to one string everywhere, so it is configured separately from the URL we call.
  keycloakUrl: (process.env.KEYCLOAK_URL || "http://localhost:8081").replace(/\/$/, ""),
  keycloakRealm: process.env.KEYCLOAK_REALM || "edemand",
  keycloakIssuer: process.env.KEYCLOAK_ISSUER || "http://localhost:8081/realms/edemand",
  jwksUrl: process.env.JWKS_URL ||
    `${(process.env.KEYCLOAK_URL || "http://localhost:8081").replace(/\/$/, "")}/realms/${process.env.KEYCLOAK_REALM || "edemand"}/protocol/openid-connect/certs`,
  // The audience the monolith accepts; tokens from the `web` client carry it.
  jwtAudience: process.env.JWT_AUDIENCE || "edemand-api",
  // Login: Direct Access Grant with the public `web` client (the three login forms stay as they are).
  keycloakClientId: process.env.KEYCLOAK_CLIENT_ID || "web",
  // Registration: the confidential `edemand-backend` service account creates the Keycloak user.
  keycloakAdminClientId: process.env.KEYCLOAK_ADMIN_CLIENT_ID || "edemand-backend",
  keycloakAdminSecret: process.env.KEYCLOAK_ADMIN_CLIENT_SECRET || "edemand-backend-secret",
});
