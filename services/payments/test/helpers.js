// Test bootstrap: env first (before any src import evaluates config), then a fresh schema in the
// test database and the app on an ephemeral port. Requires a reachable Postgres — DATABASE_URL, or
// the local default below (docker compose's test profile provides one).
process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgres://postgres:postgres@localhost:5432/pay_test";

// User tokens: an in-process fake Keycloak (RS256 + a real JWKS endpoint) — see fakeKeycloak.js.
const fakeKeycloak = await import("./fakeKeycloak.js");
process.env.KEYCLOAK_ISSUER = fakeKeycloak.ISSUER;
process.env.JWKS_URL = fakeKeycloak.jwksUrl;
delete process.env.JWT_AUDIENCE; // this service's own default audience

const { createApp } = await import("../src/app.js");
const { getPool, closePool } = await import("../src/db.js");
const { migrate, seed } = await import("../src/schema.js");
const { config } = await import("../src/config.js");

export { config };
export { tokenFor, forgedToken, expiredToken, wrongAudienceToken, hs256Token } from "./fakeKeycloak.js";

export async function boot() {
  await migrate(getPool());
  await seed(getPool(), config.seedProviderIds);
  const server = await new Promise((resolve) => {
    const s = createApp().listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    async close() {
      await new Promise((r) => server.close(r));
      await closePool();
      await fakeKeycloak.closeJwks();
    },
  };
}

export async function request(base, path, { method, body, token, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (body !== undefined) h["content-type"] = "application/json";
  const res = await fetch(base + path, {
    method: method || (body !== undefined ? "POST" : "GET"),
    headers: h,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, headers: res.headers, body: parsed };
}

export function sendEvent(base, envelope, token = config.internalToken) {
  return request(base, "/internal/events", { body: envelope, headers: { "x-internal-token": token } });
}

export { getPool };

export function sql(text, params) {
  return getPool().query(text, params).then((r) => r.rows);
}

export function createIntent(base, body, { key = String(body.order_id), token = config.internalToken } = {}) {
  return request(base, "/intents", { body, headers: { "x-internal-token": token, "idempotency-key": key } });
}

export function webhook(base, body, secret = config.webhookSecret) {
  return request(base, "/api/payments/webhook", { body, headers: { "x-webhook-secret": secret } });
}
