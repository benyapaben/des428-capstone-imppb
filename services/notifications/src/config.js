// All environment configuration for the notifications service, in one grep-able place.
const NODE_ENV = process.env.NODE_ENV || "development";

export const config = Object.freeze({
  serviceName: "notifications",
  nodeEnv: NODE_ENV,
  port: parseInt(process.env.PORT, 10) || 4001,
  databaseUrl: process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/notif_db",
  // Step 3: user tokens are issued by Keycloak (RS256) and verified here against its JWKS: signature,
  // iss, aud, exp. The issuer is the same string inside and outside docker (KC_HOSTNAME is pinned).
  keycloakIssuer: process.env.KEYCLOAK_ISSUER || "http://localhost:8081/realms/edemand",
  jwksUrl: process.env.JWKS_URL ||
    `${process.env.KEYCLOAK_ISSUER || "http://localhost:8081/realms/edemand"}/protocol/openid-connect/certs`,
  jwtAudience: process.env.JWT_AUDIENCE || "notifications-api",
  internalToken: process.env.INTERNAL_TOKEN || "edemand-internal-token",
  logLevel: process.env.LOG_LEVEL || (NODE_ENV === "test" ? "silent" : "info"),
  // Step 4: the consumer reads notification-worthy events from RabbitMQ.
  amqpUrl: process.env.AMQP_URL || "amqp://guest:guest@localhost:5672",
  // RabbitMQ resilience: a publish with no broker confirm after publishTimeoutMs fails (the relay retries
  // it next tick); a consumer retries a failing handler consumerRetries times, waiting consumerRetryBaseMs
  // doubled each time (~15.5 s with the defaults), before handing the message back to the broker.
  publishTimeoutMs: parseInt(process.env.PUBLISH_TIMEOUT_MS, 10) || 5000,
  consumerRetries: Math.max(0, parseInt(process.env.CONSUMER_RETRIES ?? "5", 10) || 0),
  consumerRetryBaseMs: parseInt(process.env.CONSUMER_RETRY_BASE_MS, 10) || 500,
});
