// In-process stand-in for Keycloak (Step 3), so the monolith suite still needs no sockets. It is
// reached through the same fetch replacement as the other fakes (fakeServices.js routes every
// http://keycloak.test/* request here) and implements just what the monolith calls:
//   POST /realms/edemand/protocol/openid-connect/token   password (client web) + client_credentials
//   GET  /realms/edemand/protocol/openid-connect/certs   the JWKS
//   POST /admin/realms/edemand/users                     create user (201, or 409 on a taken email)
// Users start as the realm's 7 seed users (same app_ids as lib/db/seed.js). Tokens are RS256 with
// the same claims the real `web` client puts in (deploy/keycloak/edemand-realm.json), signed with
// node:crypto so the token builders below stay synchronous.
import { generateKeyPairSync, createHmac, sign, randomUUID } from "node:crypto";
import { SEED_PASSWORD } from "../lib/db/seed.js";

export const KEYCLOAK_URL = "http://keycloak.test";
export const ISSUER = "http://localhost:8081/realms/edemand"; // pinned issuer, as in compose
export const AUDIENCES = ["edemand-api", "payments-api", "notifications-api"];
const REALM = `${KEYCLOAK_URL}/realms/edemand`;
const KID = "fake-keycloak-key";
const ADMIN_CLIENT = { id: "edemand-backend", secret: "edemand-backend-secret" };

const realmKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const impostorKeys = generateKeyPairSync("rsa", { modulusLength: 2048 }); // same kid, wrong key
const publicJwk = { ...realmKeys.publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" };
const adminToken = `fake-admin-${randomUUID()}`;

const SEED_USERS = [
  ["admin@edemand.test", "admin", 1],
  ["nong@example.com", "customer", 1],
  ["somchai@example.com", "customer", 2],
  ["aom@example.com", "customer", 3],
  ["sparkle@example.com", "provider", 1],
  ["fixit@example.com", "provider", 2],
  ["glow@example.com", "provider", 3],
];

export const fakeKeycloak = {
  down: false,                 // true -> every call fails like a dead network
  users: new Map(),            // email -> { id, password, role, appId }
  created: [],                 // bodies of every successful admin create-user call
  reset() {
    this.down = false;
    this.created.length = 0;
    this.users.clear();
    for (const [email, role, appId] of SEED_USERS) {
      this.users.set(email, { id: randomUUID(), password: SEED_PASSWORD, role, appId });
    }
  },
};
fakeKeycloak.reset();

// ---------------- token building ----------------
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
const now = () => Math.floor(Date.now() / 1000);

function signRS256(payload, privateKey = realmKeys.privateKey) {
  const head = `${b64({ alg: "RS256", typ: "JWT", kid: KID })}.${b64(payload)}`;
  return `${head}.${sign("RSA-SHA256", Buffer.from(head), privateKey).toString("base64url")}`;
}
function claims(role, appId, overrides = {}) {
  const iat = now();
  return {
    exp: iat + 12 * 3600, iat, jti: randomUUID(), iss: ISSUER, aud: AUDIENCES, sub: randomUUID(),
    typ: "Bearer", azp: "web", app_id: appId, role, email: `${role}${appId}@example.com`,
    ...overrides,
  };
}

/** A valid token for (role, appId), exactly what a real login would return. */
export function tokenFor(role, appId, overrides) {
  return signRS256(claims(role, appId, overrides));
}
/** Right shape and kid, but signed by a key that is not in the JWKS. */
export function forgedToken(role, appId) {
  return signRS256(claims(role, appId), impostorKeys.privateKey);
}
/** Correctly signed, but expired an hour ago. */
export function expiredToken(role, appId) {
  const iat = now() - 7200;
  return tokenFor(role, appId, { iat, exp: iat + 3600 });
}
/** Correctly signed, but not for the monolith (e.g. what the aud-test client gets). */
export function wrongAudienceToken(role, appId, aud = "account") {
  return tokenFor(role, appId, { aud });
}
/** The Step 2 token: HS256 with the old shared JWT_SECRET. */
export function hs256Token(role, appId, secret = "dev secret - do not use in production") {
  const head = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: appId, role, email: `${role}${appId}@example.com`, iat: now(), exp: now() + 3600 })}`;
  return `${head}.${createHmac("sha256", secret).update(head).digest("base64url")}`;
}

// ---------------- the fake HTTP surface ----------------
function reply(status, body) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function tokenEndpoint(params) {
  const grant = params.get("grant_type");
  if (grant === "password" && params.get("client_id") === "web") {
    const email = params.get("username");
    const user = fakeKeycloak.users.get(email);
    if (!user || user.password !== params.get("password")) {
      return reply(401, { error: "invalid_grant", error_description: "Invalid user credentials" });
    }
    const access_token = tokenFor(user.role, user.appId, { sub: user.id, email });
    return reply(200, { access_token, token_type: "Bearer", expires_in: 43200 });
  }
  if (grant === "client_credentials" && params.get("client_id") === ADMIN_CLIENT.id
      && params.get("client_secret") === ADMIN_CLIENT.secret) {
    return reply(200, { access_token: adminToken, token_type: "Bearer", expires_in: 300 });
  }
  return reply(401, { error: "unauthorized_client" });
}

function createUser(headers, body) {
  if (headers.get("authorization") !== `Bearer ${adminToken}`) return reply(401, { error: "HTTP 401 Unauthorized" });
  const user = JSON.parse(body);
  if (fakeKeycloak.users.has(user.email)) return reply(409, { errorMessage: "User exists with same email" });
  fakeKeycloak.users.set(user.email, {
    id: randomUUID(),
    password: user.credentials?.[0]?.value,
    role: user.attributes?.role?.[0],
    appId: Number(user.attributes?.app_id?.[0]),
  });
  fakeKeycloak.created.push(user);
  return reply(201);
}

/** Answers a fetch aimed at the fake Keycloak; returns null for any other URL. */
export async function handleKeycloak(url, init = {}) {
  if (!url.startsWith(KEYCLOAK_URL)) return null;
  if (fakeKeycloak.down) throw new TypeError("fetch failed");
  const method = (init.method || "GET").toUpperCase();
  const headers = new Headers(init.headers || {});

  if (method === "POST" && url === `${REALM}/protocol/openid-connect/token`) {
    return tokenEndpoint(new URLSearchParams(String(init.body)));
  }
  if (method === "GET" && url === `${REALM}/protocol/openid-connect/certs`) {
    return reply(200, { keys: [publicJwk] });
  }
  if (method === "POST" && url === `${KEYCLOAK_URL}/admin/realms/edemand/users`) {
    return createUser(headers, String(init.body));
  }
  return reply(404, { error: "not found in fake Keycloak" });
}
