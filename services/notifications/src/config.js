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
});
