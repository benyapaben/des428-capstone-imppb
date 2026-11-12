// Boot: fresh schema + seed wallets, start the outbox relay, then listen. Retries the database so
// `docker compose up` does not depend on start order.
import { createApp } from "./app.js";
import { config } from "./config.js";
import { getPool, closePool } from "./db.js";
import { migrate, seed } from "./schema.js";
import { startRelay, stopRelay } from "./relay.js";
import { logger } from "./logger.js";
  import { startPaymentsConsumer } from "./consumer.js";

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
await seed(getPool(), config.seedProviderIds);
logger.info({ wallets: config.seedProviderIds }, "pay_db migrated and seeded");
startPaymentsConsumer().catch((err) => logger.error({ err: err.message }, "payments consumer failed to start"));
startRelay();

const server = createApp().listen(config.port, () => logger.info({ port: config.port }, "payments service listening"));

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    stopRelay();
    server.close(() => closePool().then(() => process.exit(0)));
  });
}
