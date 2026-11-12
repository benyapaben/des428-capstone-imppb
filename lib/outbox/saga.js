import { config } from "../config.js";
import { expireUnpaidOrders } from "../modules/booking/service.js";
import { logger } from "../logger.js";

const TIMER = Symbol.for("edemand.sagaTimer");

export function startSagaTimeouts() {
  if (globalThis[TIMER]) return;
  const handle = setInterval(() => {
    try {
      const n = expireUnpaidOrders();
      if (n > 0) logger.info({ expired: n }, "saga: cancelled unpaid bookings after the payment timeout");
    } catch (err) {
      logger.error({ err: err.message }, "saga: timeout sweep failed");
    }
  }, config.sweepIntervalMs);
  if (typeof handle.unref === "function") handle.unref();
  globalThis[TIMER] = handle;
}