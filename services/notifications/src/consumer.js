import { startConsumer } from "./amqp.js";
import * as service from "./service.js";
import { logger } from "./logger.js";

export function startNotificationsConsumer() {
  return startConsumer("notifications.events", (envelope) => service.handleEvent(envelope), logger);
}