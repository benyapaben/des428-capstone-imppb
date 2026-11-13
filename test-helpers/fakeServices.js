// In-process stand-ins for the extracted services and the broker, so the monolith suite still needs
// no sockets. Replaces globalThis.fetch: POST /intents on the fake payments host and the fake Keycloak
// host are answered here, anything else falls through to the real fetch. `fakeBroker` stands in for
// RabbitMQ: the real relay publishes into it (with confirms) and `consume()` plays a consumer,
// redelivering failed messages and dead-lettering them after 3 tries. Tests flip `fake.paymentsDown`,
// `fakeBroker.down` and `fakeKeycloak.down` to exercise the failure paths (compensation, relay retry).
import { randomUUID } from "node:crypto";
import { fakeKeycloak, handleKeycloak } from "./fakeKeycloak.js";
import { QUEUES } from "../lib/amqp/connection.js";

export { fakeKeycloak };

export const PAYMENTS_URL = "http://payments.test";
export const NOTIFICATIONS_URL = "http://notifications.test";

// ---- Step 4: a stand-in for RabbitMQ ----
// `channel` has the same publish() signature as amqplib's ConfirmChannel, so the real relay and the
// real publish() run unchanged. `consume()` plays the consumer loop: a throw = nack + redelivery,
// and after 3 failed deliveries the message lands in the dead-letter queue (like the real broker).
const queueNames = Object.keys(QUEUES);
export const fakeBroker = {
  down: false,
  published: [],                                                  // every confirmed publish
  queues: new Map(queueNames.map((q) => [q, []])),
  dlq: new Map(queueNames.map((q) => [q, []])),
  channel: {
    publish(exchange, routingKey, content, options, cb) {
      if (fakeBroker.down) { cb(new Error("broker down")); return false; }
      const msg = { routingKey, messageId: options.messageId, envelope: JSON.parse(content.toString()) };
      fakeBroker.published.push(msg);
      for (const [queue, keys] of Object.entries(QUEUES)) {
        if (keys.includes(routingKey)) fakeBroker.queues.get(queue).push(msg);
      }
      cb(null);
      return true;
    },
  },
  async consume(queue, handle, { maxDeliveries = 3 } = {}) {
    const pending = fakeBroker.queues.get(queue).splice(0);
    for (const msg of pending) {
      let ok = false;
      for (let n = 1; n <= maxDeliveries && !ok; n++) {
        try { await handle(msg.envelope, msg); ok = true; } catch { /* nack -> redeliver */ }
      }
      if (!ok) fakeBroker.dlq.get(queue).push(msg);
    }
  },
  reset() {
    this.down = false;
    this.published.length = 0;
    for (const list of this.queues.values()) list.length = 0;
    for (const list of this.dlq.values()) list.length = 0;
  },
};

export const fake = {
  paymentsDown: false,
  intents: new Map(),          // Idempotency-Key -> intent
  intentCalls: [],             // every POST /intents { headers, body }
  reset() {
    this.paymentsDown = false;
    this.intents.clear();
    this.intentCalls.length = 0;
    fakeBroker.reset();
    fakeKeycloak.down = false; // its users are kept: tests rely on accounts registered earlier
  },
};

const realFetch = globalThis.fetch;

function reply(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  const headers = new Headers(init.headers || {});

  const keycloakReply = await handleKeycloak(url, init);
  if (keycloakReply) return keycloakReply;

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


  return realFetch(input, init);
};
