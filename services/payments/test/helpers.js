// Test bootstrap: env first (before any src import evaluates config), then a fresh schema in the
// test database and the app on an ephemeral port. Requires a reachable Postgres — DATABASE_URL, or
// the local default below (docker compose's test profile provides one).
process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgres://postgres:postgres@localhost:5432/pay_test";

const { createApp } = await import("../src/app.js");
const { getPool, closePool } = await import("../src/db.js");
const { migrate, seed } = await import("../src/schema.js");
const { config } = await import("../src/config.js");
const jwt = (await import("jsonwebtoken")).default;

export { config };

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
    },
  };
}

export function tokenFor(role, sub) {
  return jwt.sign({ sub, role, email: `${role}${sub}@example.com` }, config.jwtSecret, { expiresIn: "1h" });
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

// A throwaway HTTP server standing in for a subscriber (monolith / notifications) of the relay.
export async function startSubscriber() {
  const http = await import("node:http");
  const received = [];
  const state = { down: false };
  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      if (state.down) { res.writeHead(503); return res.end(); }
      received.push({ headers: req.headers, body: JSON.parse(data) });
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"received":true}');
    });
  });
  await new Promise((r) => server.listen(0, r));
  return {
    url: `http://127.0.0.1:${server.address().port}/internal/events`,
    received,
    state,
    close: () => new Promise((r) => server.close(r)),
  };
}
