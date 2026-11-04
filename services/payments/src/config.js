// All environment configuration for the payments service, in one grep-able place.
const NODE_ENV = process.env.NODE_ENV || "development";

export const config = Object.freeze({
  serviceName: "payments",
  nodeEnv: NODE_ENV,
  port: parseInt(process.env.PORT, 10) || 4002,
  databaseUrl: process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/pay_db",
  // Step 2: the same HS256 secret the monolith signs with. Step 3 replaces this with Keycloak's JWKS.
  jwtSecret: process.env.JWT_SECRET || "dev secret - do not use in production",
  internalToken: process.env.INTERNAL_TOKEN || "edemand-internal-token",
  // Shared secret the (mock) gateway signs its webhook callbacks with.
  webhookSecret: process.env.WEBHOOK_SECRET || "edemand-webhook-secret",
  // Where the outbox relay delivers payment.* events (Step 2 transport; RabbitMQ in Step 4).
  eventSubscribers: (process.env.EVENT_SUBSCRIBERS ??
    "http://localhost:3000/api/internal/events,http://localhost:4001/internal/events")
    .split(",").map((s) => s.trim()).filter(Boolean),
  relayIntervalMs: parseInt(process.env.RELAY_INTERVAL_MS, 10) || 1000,
  // Wallet rows seeded on boot — the same provider ids the monolith seeds (sparkle, fixit, glow).
  seedProviderIds: (process.env.SEED_PROVIDER_IDS || "1,2,3").split(",").map(Number).filter(Boolean),
  logLevel: process.env.LOG_LEVEL || (NODE_ENV === "test" ? "silent" : "info"),
});
