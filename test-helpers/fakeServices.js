// In-process stand-ins for the extracted services, so the monolith suite still needs no sockets.
// Replaces globalThis.fetch: requests to the fake payments / notifications hosts are answered here,
// anything else falls through to the real fetch. Tests flip `paymentsDown` / `subscribersDown` to
// exercise the failure paths (compensation, relay retry).
import { randomUUID } from "node:crypto";

export const PAYMENTS_URL = "http://payments.test";
export const NOTIFICATIONS_URL = "http://notifications.test";
export const SUBSCRIBERS = [`${NOTIFICATIONS_URL}/internal/events`, `${PAYMENTS_URL}/internal/events`];

export const fake = {
  paymentsDown: false,
  subscribersDown: false,
  intents: new Map(),          // Idempotency-Key -> intent
  intentCalls: [],             // every POST /intents { headers, body }
  delivered: new Map(SUBSCRIBERS.map((u) => [u, []])), // subscriber url -> envelopes
  reset() {
    this.paymentsDown = false;
    this.subscribersDown = false;
    this.intents.clear();
    this.intentCalls.length = 0;
    for (const list of this.delivered.values()) list.length = 0;
  },
};

const realFetch = globalThis.fetch;

function reply(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  const headers = new Headers(init.headers || {});

  if (url === `${PAYMENTS_URL}/intents`) {
    if (fake.paymentsDown) throw new TypeError("fetch failed");
    const body = JSON.parse(init.body);
    fake.intentCalls.push({ headers, body });
    const key = headers.get("idempotency-key");
    if (fake.intents.has(key)) return reply(200, fake.intents.get(key));
    const intent = {
      id: fake.intents.size + 1,
      order_id: body.order_id,
      amount_cents: body.amount_cents,
      customer_id: body.customer_id,
      provider_id: body.provider_id,
      gateway_ref: `SIM-PI-${randomUUID()}`,
      status: "requires_payment",
    };
    fake.intents.set(key, intent);
    return reply(201, intent);
  }

  if (fake.delivered.has(url)) {
    if (fake.subscribersDown) return reply(503, { error: "down" });
    fake.delivered.get(url).push(JSON.parse(init.body));
    return reply(200, { received: true });
  }

  return realFetch(input, init);
};
