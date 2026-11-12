// Central environment configuration. Every module reads settings from here — nothing else in the
// codebase touches process.env directly (except db/index.js resolving the db path at open time),
// so the whole config surface is grep-able in one file.
const NODE_ENV = process.env.NODE_ENV || "development";

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
  // Where the outbox relay delivers each domain event (Step 2 transport; RabbitMQ replaces it in Step 4).
  // Comma-separated list of full URLs. Empty string = deliver nowhere (local handlers still run).
  relayIntervalMs: parseInt(process.env.RELAY_INTERVAL_MS, 10) || 1000,
  amqpUrl: process.env.AMQP_URL || "amqp://guest:guest@localhost:5672",
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
