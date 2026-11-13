// All environment configuration for the payments service, in one grep-able place.
const NODE_ENV = process.env.NODE_ENV || "development";

export const config = Object.freeze({
  serviceName: "payments",
  nodeEnv: NODE_ENV,
  port: parseInt(process.env.PORT, 10) || 4002,
  databaseUrl: process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/pay_db",
  // Step 3: user tokens are issued by Keycloak (RS256) and verified here against its JWKS: signature,
  // iss, aud, exp. The issuer is the same string inside and outside docker (KC_HOSTNAME is pinned).
  keycloakIssuer: process.env.KEYCLOAK_ISSUER || "http://localhost:8081/realms/edemand",
  jwksUrl: process.env.JWKS_URL ||
    `${process.env.KEYCLOAK_ISSUER || "http://localhost:8081/realms/edemand"}/protocol/openid-connect/certs`,
  jwtAudience: process.env.JWT_AUDIENCE || "payments-api",
  internalToken: process.env.INTERNAL_TOKEN || "edemand-internal-token",
  // Shared secret the (mock) gateway signs its webhook callbacks with.
  webhookSecret: process.env.WEBHOOK_SECRET || "edemand-webhook-secret",
  // Step 4: the outbox relay publishes payment.* events to RabbitMQ every relayIntervalMs, and the
  // consumer reads booking.* events from the same broker.
  relayIntervalMs: parseInt(process.env.RELAY_INTERVAL_MS, 10) || 1000,
  amqpUrl: process.env.AMQP_URL || "amqp://guest:guest@localhost:5672",
  // Wallet rows seeded on boot — the same provider ids the monolith seeds (sparkle, fixit, glow).
  seedProviderIds: (process.env.SEED_PROVIDER_IDS || "1,2,3").split(",").map(Number).filter(Boolean),
  logLevel: process.env.LOG_LEVEL || (NODE_ENV === "test" ? "silent" : "info"),
});
