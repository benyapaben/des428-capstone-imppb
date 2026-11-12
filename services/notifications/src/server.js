// Boot: fresh schema, then listen. Retries the database for a while so `docker compose up` does not
// depend on start order.
import { createApp } from "./app.js";
import { config } from "./config.js";
import { getPool, closePool } from "./db.js";
import { migrate } from "./schema.js";
import { logger } from "./logger.js";
import { startNotificationsConsumer } from "./consumer.js";

async function waitForDb(attempts = 30) {
  for (let i = 1; ; i++) {
    try {
      await getPool().query("SELECT 1");
      return;
    } catch (err) {
      if (i >= attempts) throw err;
      logger.warn({ attempt: i, err: err.message }, "database not ready, retrying");
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

await waitForDb();
await migrate(getPool());
logger.info("notif_db migrated");
startNotificationsConsumer().catch((err) => logger.error({ err: err.message }, "notifications consumer failed to start"));

const server = createApp().listen(config.port, () => logger.info({ port: config.port }, "notifications service listening"));

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => server.close(() => closePool().then(() => process.exit(0))));
}
