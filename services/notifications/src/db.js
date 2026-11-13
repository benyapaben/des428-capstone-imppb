// One pg Pool per process. `tx` runs a callback inside BEGIN/COMMIT (ROLLBACK on throw) on a single
// pooled client, so the inbox dedupe row and the state change it guards commit together.
import pg from "pg";
import { config } from "./config.js";
import { logger } from "./logger.js";

let pool;

export function getPool() {
  if (!pool) {
    pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
    // An idle pooled client emits 'error' when the server drops it (e.g. Postgres restarts). Without a
    // listener that is an unhandled 'error' event and kills the process; the pool discards the broken
    // client by itself, so logging is enough and the next query opens a fresh connection.
    pool.on("error", (err) => logger.warn({ err: err.message }, "idle database client lost"));
  }
  return pool;
}

export function query(text, params) {
  return getPool().query(text, params);
}

export async function tx(fn) {
  const client = await getPool().connect();
  // A checked-out client has no pool 'error' listener. If Postgres drops the connection mid-transaction,
  // pg emits 'error' on the client as well as failing the query; unhandled, that kills the process.
  // Keep the error and hand the client back as broken so the pool discards it.
  let lost;
  const onError = (err) => {
    lost = err;
    logger.warn({ err: err.message }, "database connection lost during a transaction");
  };
  client.on("error", onError);
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.removeListener("error", onError);
    client.release(lost);
  }
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
