// Keycloak's public signing keys (JWKS), cached in-process.
//
// Fetched with the global fetch on purpose: jose's own createRemoteJWKSet uses node:http, which the
// socket-free test suite can't intercept (test-helpers/fakeServices.js replaces fetch). The cache is
// refreshed when a token names a key id we don't have — Keycloak generates new keys whenever its
// realm is re-imported (every container start) — but at most once per REFRESH_MIN_MS, so a flood of
// forged tokens with random kids can't turn into a flood of requests to Keycloak.
import { createLocalJWKSet } from "jose";
import { config } from "../config.js";
import { ServiceUnavailableError } from "../errors.js";

const REFRESH_MIN_MS = 10_000;

let keySet = null;       // the jose key-set function, once loaded
let loadedAt = 0;
let inFlight = null;     // shared promise while a fetch is running

async function load() {
  let res;
  try {
    res = await fetch(config.jwksUrl, { signal: AbortSignal.timeout(5000), cache: "no-store" });
  } catch (err) {
    throw new ServiceUnavailableError(`identity provider unreachable: ${err.message}`);
  }
  if (!res.ok) throw new ServiceUnavailableError(`identity provider answered ${res.status} for JWKS`);
  let jwks;
  try {
    jwks = await res.json();
    keySet = createLocalJWKSet(jwks);
  } catch (err) {
    throw new ServiceUnavailableError(`identity provider sent an invalid JWKS: ${err.message}`);
  }
  loadedAt = Date.now();
  return keySet;
}

function refresh() {
  inFlight ??= load().finally(() => { inFlight = null; });
  return inFlight;
}

/** The current key set; loads it on first use. */
export async function getKeySet() {
  return keySet ?? refresh();
}

/**
 * Called when verification fails with "no matching key": re-fetch if the cache is old enough and
 * report whether there is a new key set worth retrying with.
 */
export async function refreshAfterUnknownKey() {
  if (Date.now() - loadedAt < REFRESH_MIN_MS) return null;
  return refresh();
}

/** Tests only: forget the cached keys (a fresh fake Keycloak has fresh keys). */
export function resetKeySetCache() {
  keySet = null;
  loadedAt = 0;
  inFlight = null;
}
