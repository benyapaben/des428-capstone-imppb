import amqp from "amqplib";
import { config } from "./config.js";

export const EXCHANGE = "edemand.events";
export const DLX = "edemand.dlx";

// queue -> routing keys it listens to (routing key = event type)
export const QUEUES = {
  "payments.events": ["booking.completed", "booking.cancelled"],
  "booking.events": ["payment.succeeded", "payment.refunded", "review.created"],
  "notifications.events": [
    "booking.status_changed", "booking.completed", "bid.accepted",
    "review.created", "provider.approved", "payment.succeeded", "payment.refunded",
  ],
};

export async function assertTopology(ch) {
  await ch.assertExchange(EXCHANGE, "topic", { durable: true });
  await ch.assertExchange(DLX, "direct", { durable: true });
  for (const [queue, keys] of Object.entries(QUEUES)) {
    await ch.assertQueue(`${queue}.dlq`, { durable: true });
    await ch.bindQueue(`${queue}.dlq`, DLX, queue);
    await ch.assertQueue(queue, {
      durable: true,
      arguments: {
        "x-queue-type": "quorum",
        "x-delivery-limit": 3,
        "x-dead-letter-exchange": DLX,
        "x-dead-letter-routing-key": queue,
      },
    });
    for (const key of keys) await ch.bindQueue(queue, EXCHANGE, key);
  }
}

let conn, pubCh;

export async function getPublisher() {
  if (pubCh) return pubCh;
  const c = await amqp.connect(config.amqpUrl);
  c.on("error", () => {});
  c.on("close", () => { conn = pubCh = undefined; });
  const ch = await c.createConfirmChannel();
  await assertTopology(ch);
  conn = c;
  pubCh = ch;
  return ch;
}

export function publish(channel, envelope) {
  return new Promise((resolve, reject) => {
    channel.publish(
      EXCHANGE,
      envelope.type,
      Buffer.from(JSON.stringify(envelope)),
      { persistent: true, contentType: "application/json", messageId: `${envelope.source}:${envelope.id}` },
      (err) => (err ? reject(err) : resolve()),   // resolves only after the broker confirms
    );
  });
}



// Reads one queue forever, reconnecting if RabbitMQ drops. The handler runs the DB transaction
// (dedupe row + effect); we ack only after it succeeds. A throw -> nack -> redelivered, and after
// 3 deliveries the broker moves the message to the dead-letter queue.
export async function startConsumer(queue, handle, log = console) {
  const run = async () => {
    try {
      const c = await amqp.connect(config.amqpUrl);
      c.on("error", () => {});
      c.on("close", () => setTimeout(run, 2000).unref?.());
      const ch = await c.createChannel();
      ch.on("error", () => {});
      await assertTopology(ch);
      await ch.prefetch(10);
      await ch.consume(queue, async (msg) => {
        if (!msg) return;
        try {
          await handle(JSON.parse(msg.content.toString()), msg);
          ch.ack(msg);
        } catch (err) {
          log.warn?.({ err: err.message, queue }, "consumer: handler failed, will redeliver");
          ch.nack(msg, false, true);
        }
      });
      log.info?.({ queue }, "consumer started");
    } catch (err) {
      log.warn?.({ err: err.message, queue }, "consumer: cannot connect yet, retrying");
      setTimeout(run, 2000).unref?.();
    }
  };
  await run();
}