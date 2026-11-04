// One pg Pool per process. `tx` runs a callback inside BEGIN/COMMIT (ROLLBACK on throw) on a single
// pooled client, so the inbox dedupe row and the state change it guards commit together.
import pg from "pg";
import { config } from "./config.js";

let pool;

export function getPool() {
  if (!pool) pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
  return pool;
}

export function query(text, params) {
  return getPool().query(text, params);
}

export async function tx(fn) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
