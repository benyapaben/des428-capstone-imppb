// Central environment configuration. Every module reads settings from here — nothing else in the
// codebase touches process.env directly (except db/index.js resolving the db path at open time),
// so the whole config surface is grep-able in one file.
const NODE_ENV = process.env.NODE_ENV || "development";

export const config = Object.freeze({
  nodeEnv: NODE_ENV,
  isTest: NODE_ENV === "test",
  port: parseInt(process.env.PORT, 10) || 3000,
  jwtSecret: process.env.JWT_SECRET || "dev secret - do not use in production",
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "12h",
  logLevel: process.env.LOG_LEVEL || (NODE_ENV === "test" ? "silent" : "info"),
  bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS, 10) || 10,
  // First order id after a fresh seed. sqlite_sequence is primed to (firstOrderId - 1) so the next
  // AUTOINCREMENT insert lands here, deterministically, on every boot.
  firstOrderId: 8001,
  // One flat tax rate, snapshotted onto each order_item at booking time (tax-excluded).
  taxPercent: 7.0,
  // Shared secret the mock payment gateway signs its webhook callbacks with.
  webhookSecret: process.env.WEBHOOK_SECRET || "edemand-webhook-secret",
});
