// All environment configuration for the notifications service, in one grep-able place.
const NODE_ENV = process.env.NODE_ENV || "development";

export const config = Object.freeze({
  serviceName: "notifications",
  nodeEnv: NODE_ENV,
  port: parseInt(process.env.PORT, 10) || 4001,
  databaseUrl: process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/notif_db",
  // Step 2: the same HS256 secret the monolith signs with. Step 3 replaces this with Keycloak's JWKS.
  jwtSecret: process.env.JWT_SECRET || "dev secret - do not use in production",
  internalToken: process.env.INTERNAL_TOKEN || "edemand-internal-token",
  logLevel: process.env.LOG_LEVEL || (NODE_ENV === "test" ? "silent" : "info"),
});
