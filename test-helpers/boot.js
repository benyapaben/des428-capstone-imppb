// Test bootstrap. Each test FILE is its own process under `node --test`, so importing this once at
// the top of a file gives that file an isolated in-memory database.
//
// IMPORTANT: this module sets NODE_ENV/DB_PATH and THEN dynamically imports the DB layer, using
// top-level await. Because it must be the FIRST import in every test file, its env vars are in
// place before any route handler's static graph (config, db) is evaluated. getDb() also resolves
// the path at open time, so :memory: is guaranteed regardless of ESM import ordering.
process.env.NODE_ENV = "test";
process.env.DB_PATH = ":memory:";

// The extracted services are faked in-process (see fakeServices.js) — point config at the fakes.
// Set synchronously, before the first await, like NODE_ENV above.
process.env.PAYMENTS_URL = "http://payments.test";
process.env.NOTIFICATIONS_URL = "http://notifications.test";
// Step 5: keep the POST /intents timeout and retry backoff short so fault tests stay fast.
// PAYMENTS_MAX_RETRIES keeps its default (test/resilience.test.js reads config.paymentsMaxRetries).
process.env.PAYMENTS_TIMEOUT_MS = "50";
process.env.PAYMENTS_BACKOFF_BASE_MS = "1";
process.env.PAYMENTS_BACKOFF_CAP_MS = "5";
// Step 3: Keycloak is faked too (fakeKeycloak.js). The issuer keeps the real pinned value; only the
// URL the monolith calls (token endpoint, JWKS, admin API) points at the fake.
process.env.KEYCLOAK_URL = "http://keycloak.test";
process.env.KEYCLOAK_ISSUER = "http://localhost:8081/realms/edemand";
delete process.env.JWKS_URL;      // derived from KEYCLOAK_URL
delete process.env.JWT_AUDIENCE;  // default: edemand-api

const fakes = await import("./fakeServices.js");
export const { fake, fakeBroker, fakeKeycloak } = fakes;

const { bootstrapDb } = await import("../lib/db/bootstrap.js");
const { getDb, closeDb } = await import("../lib/db/index.js");

export function freshBoot() {
  return bootstrapDb();
}

export { getDb, closeDb };
