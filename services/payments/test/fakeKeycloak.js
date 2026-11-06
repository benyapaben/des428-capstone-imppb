// In-process stand-in for Keycloak, for tests only. It owns an RS256 key pair, serves the public half
// as a JWKS over real HTTP on an ephemeral port, and signs Keycloak-shaped access tokens with the
// private half. The service under test is pointed at this JWKS (JWKS_URL) and verifies tokens with
// exactly the code it runs in production; only the source of the keys differs.
// Signing uses node:crypto directly so tokenFor() stays synchronous.
import http from "node:http";
import { generateKeyPairSync, createHmac, sign, randomUUID } from "node:crypto";

export const ISSUER = "http://localhost:8081/realms/edemand"; // the realm's pinned issuer
export const AUDIENCES = ["payments-api", "notifications-api"];
const KID = "fake-keycloak-key";

const realm = generateKeyPairSync("rsa", { modulusLength: 2048 });
const impostor = generateKeyPairSync("rsa", { modulusLength: 2048 }); // same kid, different key
const publicJwk = { ...realm.publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" };

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ keys: [publicJwk] }));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
server.unref(); // never keeps the test process alive on its own

export const jwksUrl = `http://127.0.0.1:${server.address().port}/realms/edemand/protocol/openid-connect/certs`;
export const closeJwks = () => new Promise((resolve) => server.close(resolve));

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
const now = () => Math.floor(Date.now() / 1000);

function signRS256(payload, privateKey = realm.privateKey) {
  const head = `${b64({ alg: "RS256", typ: "JWT", kid: KID })}.${b64(payload)}`;
  return `${head}.${sign("RSA-SHA256", Buffer.from(head), privateKey).toString("base64url")}`;
}

// The claims Keycloak's `web` client puts in an access token (deploy/keycloak/edemand-realm.json).
function claims(role, appId, overrides = {}) {
  const iat = now();
  return {
    exp: iat + 3600, iat, jti: randomUUID(), iss: ISSUER, aud: AUDIENCES, sub: randomUUID(),
    typ: "Bearer", azp: "web", app_id: appId, role, email: `${role}${appId}@example.com`,
    ...overrides,
  };
}

/** A valid token for (role, appId) — what a real login would carry. */
export function tokenFor(role, appId, overrides) {
  return signRS256(claims(role, appId, overrides));
}

// ---- tokens every service must refuse with 401 (Step 3 "done when") ----

/** Right shape and kid, but signed by a key that is not in the JWKS. */
export function forgedToken(role, appId) {
  return signRS256(claims(role, appId), impostor.privateKey);
}
/** Correctly signed, but expired an hour ago. */
export function expiredToken(role, appId) {
  const iat = now() - 7200;
  return tokenFor(role, appId, { iat, exp: iat + 3600 });
}
/** Correctly signed, but issued for some other audience (e.g. the aud-test client). */
export function wrongAudienceToken(role, appId, aud = "account") {
  return tokenFor(role, appId, { aud });
}
/** The Step 2 token: HS256 with the old shared JWT_SECRET. */
export function hs256Token(role, appId, secret = "dev secret - do not use in production") {
  const head = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: appId, role, email: `${role}${appId}@example.com`, iat: now(), exp: now() + 3600 })}`;
  return `${head}.${createHmac("sha256", secret).update(head).digest("base64url")}`;
}
