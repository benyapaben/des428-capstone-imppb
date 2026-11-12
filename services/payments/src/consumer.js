import { startConsumer } from "./amqp.js";
import * as service from "./service.js";
import { logger } from "./logger.js";

export function startPaymentsConsumer() {
  return startConsumer("payments.events", (envelope) => service.handleEvent(envelope), logger);
}