import { startConsumer } from "../amqp/connection.js";
import { receiveEvent } from "./inbound.js";
import { logger } from "../logger.js";

export function startMonolithConsumer() {
  startConsumer("booking.events", (envelope) => receiveEvent(envelope), logger)
    .catch((err) => logger.error({ err: err.message }, "booking consumer failed to start"));
}