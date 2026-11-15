// Pact consumer tests (Step 6 / E7): env for the monolith's clients. Must be imported FIRST — before
// anything that loads lib/config.js — because config reads the service URLs once, at import time.
// Each provider's Pact mock server listens on a fixed port so the client's base URL can point at it.
// These tests open sockets, so they are not part of `npm test` (test/*.test.js); run `npm run test:pact`.
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const PAYMENTS_MOCK_PORT = 4802;
export const NOTIFICATIONS_MOCK_PORT = 4801;

process.env.NODE_ENV = "test";
process.env.PAYMENTS_URL = `http://127.0.0.1:${PAYMENTS_MOCK_PORT}`;
process.env.NOTIFICATIONS_URL = `http://127.0.0.1:${NOTIFICATIONS_MOCK_PORT}`;
process.env.PAYMENTS_MAX_RETRIES = "0";   // one request per call: a contract is about its shape, not Step 5's retries

// Where the pact files go: <repo>/pacts (git-ignored; CI passes them on as an artifact).
export const PACT_DIR = fileURLToPath(new URL("../../pacts/", import.meta.url));

// Pact merges new interactions into an existing file, so a stale one from an earlier run would stay in
// the contract. Each test file owns one pact file and starts it from scratch.
export function freshPactFile(consumer, provider) {
  rmSync(`${PACT_DIR}${consumer}-${provider}.json`, { force: true });
}

// The consumer sends "Bearer <role>-<id>" as its token here. The provider's verifier swaps it for a
// real signed token of that role and id (requestFilter), so the contract states WHO calls, not a token.
export const placeholderToken = (role, id) => `${role}-${id}`;
export const BEARER = /^Bearer (customer|provider|admin)-\d+$/;
// Pact matches a regex against the WHOLE value, so the charset suffix must be allowed for explicitly.
export const JSON_TYPE = /^application\/json(;.*)?$/;
export const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
