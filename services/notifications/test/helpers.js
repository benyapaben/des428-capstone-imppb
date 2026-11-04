// Test bootstrap: env first (before any src import evaluates config), then a fresh schema in the
// test database and the app on an ephemeral port. Requires a reachable Postgres — DATABASE_URL, or
// the local default below (docker compose's test profile provides one).
process.env.NODE_ENV = "test";
process.env.DATABASE_URL ||= "postgres://postgres:postgres@localhost:5432/notif_test";

const { createApp } = await import("../src/app.js");
const { getPool, closePool } = await import("../src/db.js");
const { migrate } = await import("../src/schema.js");
const { config } = await import("../src/config.js");
const jwt = (await import("jsonwebtoken")).default;

export { config };

export async function boot() {
  await migrate(getPool());
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
