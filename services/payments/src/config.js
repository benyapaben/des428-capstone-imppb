// All environment configuration for the payments service, in one grep-able place.
const NODE_ENV = process.env.NODE_ENV || "development";

// A non-negative integer setting: 0 is a valid value, while unset, empty or malformed falls back.
const intEnv = (name, fallback) => (/^\d+$/.test(process.env[name] ?? "") ? Number(process.env[name]) : fallback);

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
  // RabbitMQ resilience: a publish with no broker confirm after publishTimeoutMs fails (the relay retries
  // it next tick); a consumer retries a failing handler consumerRetries times, waiting consumerRetryBaseMs
  // doubled each time (~15.5 s with the defaults), before handing the message back to the broker.
  publishTimeoutMs: parseInt(process.env.PUBLISH_TIMEOUT_MS, 10) || 5000,
  // 0 is allowed (no in-process retry); empty or invalid falls back to 5 rather than silently to 0.
  consumerRetries: /^\d+$/.test(process.env.CONSUMER_RETRIES ?? "") ? Number(process.env.CONSUMER_RETRIES) : 5,
  consumerRetryBaseMs: parseInt(process.env.CONSUMER_RETRY_BASE_MS, 10) || 500,
  // Step 5 fault switches for POST /intents (src/faults.js), all off by default. These are the values
  // at boot; /internal/faults changes them at runtime. dropReplies / delayReplies count requests down.
  faults: Object.freeze({
    dropReplies: intEnv("FAULT_DROP_REPLIES", 0),   // write the intent, then cut the connection
    delayReplies: intEnv("FAULT_DELAY_REPLIES", 0), // write the intent, then answer delayMs late
    delayMs: intEnv("FAULT_DELAY_MS", 0),
    downMs: intEnv("FAULT_DOWN_MS", 0),             // answer 503 (writing nothing) for this long after boot
  }),
  // Wallet rows seeded on boot — the same provider ids the monolith seeds (sparkle, fixit, glow).
  seedProviderIds: (process.env.SEED_PROVIDER_IDS || "1,2,3").split(",").map(Number).filter(Boolean),
  logLevel: process.env.LOG_LEVEL || (NODE_ENV === "test" ? "silent" : "info"),
});
