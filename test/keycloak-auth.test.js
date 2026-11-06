import { test } from "node:test";
import assert from "node:assert/strict";
import { freshBoot, getDb, fakeKeycloak } from "../test-helpers/boot.js";
import { call } from "../test-helpers/call.js";
import { SEED_PASSWORD } from "../lib/db/seed.js";
import {
  tokenFor, forgedToken, expiredToken, wrongAudienceToken, hs256Token,
} from "../test-helpers/fakeKeycloak.js";

import * as me from "../app/api/me/route.js";
import * as customerLogin from "../app/api/auth/customer/login/route.js";
import * as customerRegister from "../app/api/auth/customer/register/route.js";
import * as providerLogin from "../app/api/auth/provider/login/route.js";
import * as providerRegister from "../app/api/auth/provider/register/route.js";

freshBoot();

// Step 3 / B3: the monolith no longer signs or accepts its own HS256 JWT. Login is a Direct Access
// Grant against Keycloak; every token is a Keycloak RS256 token checked against the JWKS.

const decode = (jwt) => JSON.parse(Buffer.from(jwt.split(".")[1], "base64url"));
const countCustomers = (email) => getDb().prepare("SELECT COUNT(*) AS n FROM customers WHERE email = ?").get(email).n;
const countProviders = (email) => getDb().prepare("SELECT COUNT(*) AS n FROM providers WHERE email = ?").get(email).n;

test("Keycloak auth in the monolith", async (t) => {
  await t.test("login returns a Keycloak token (RS256, iss, aud edemand-api, app_id) and /api/me reads it", async () => {
    const res = await call(customerLogin.POST, { body: { email: "nong@example.com", password: SEED_PASSWORD } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("set-cookie"), /^edemand_token=/);
    const header = JSON.parse(Buffer.from(res.body.token.split(".")[0], "base64url"));
    const p = decode(res.body.token);
    assert.equal(header.alg, "RS256");
    assert.equal(p.iss, "http://localhost:8081/realms/edemand");
    assert.ok(p.aud.includes("edemand-api"));
    assert.equal(p.app_id, 1);
    assert.equal(p.role, "customer");

    const who = await call(me.GET, { token: res.body.token });
    assert.equal(who.status, 200);
    assert.equal(who.body.role, "customer");
    assert.equal(who.body.id, 1, "auth.sub is the token's app_id (the monolith DB id)");
  });

  await t.test("forged, expired, wrong audience, wrong issuer, old HS256 ... -> 401", async () => {
    const refused = {
      "forged signature": forgedToken("customer", 1),
      "expired": expiredToken("customer", 1),
      "wrong audience": wrongAudienceToken("customer", 1),
      "only the payments-api audience": wrongAudienceToken("customer", 1, "payments-api"),
      "wrong issuer": tokenFor("customer", 1, { iss: "http://evil.example/realms/edemand" }),
      "old Step 2 HS256 token": hs256Token("customer", 1),
      "no app_id claim": tokenFor("customer", 1, { app_id: undefined }),
      "unknown role": tokenFor("superuser", 1),
    };
    for (const [why, token] of Object.entries(refused)) {
      const res = await call(me.GET, { token });
      assert.equal(res.status, 401, `${why} -> expected 401, got ${res.status}`);
    }
    assert.equal((await call(me.GET, { token: tokenFor("customer", 1) })).status, 200, "a valid token still works");
  });

  await t.test("each login endpoint only accepts its own role", async () => {
    const providerAtCustomer = await call(customerLogin.POST, { body: { email: "sparkle@example.com", password: SEED_PASSWORD } });
    assert.equal(providerAtCustomer.status, 401);
    const customerAtProvider = await call(providerLogin.POST, { body: { email: "nong@example.com", password: SEED_PASSWORD } });
    assert.equal(customerAtProvider.status, 401);
    const wrongPassword = await call(customerLogin.POST, { body: { email: "nong@example.com", password: "nope-nope" } });
    assert.equal(wrongPassword.status, 401);
    const provider = await call(providerLogin.POST, { body: { email: "sparkle@example.com", password: SEED_PASSWORD } });
    assert.equal(provider.status, 200);
    assert.equal(provider.body.is_approved, true, "is_approved still comes from the monolith's provider profile");
  });

  await t.test("register creates the Keycloak user with app_id = the new DB id; then login works", async () => {
    const email = "kc-new@example.com";
    const reg = await call(customerRegister.POST, { body: { email, password: "TestPass123!", name: "Kc New" } });
    assert.equal(reg.status, 201);
    const kcUser = fakeKeycloak.users.get(email);
    assert.deepEqual({ role: kcUser.role, appId: kcUser.appId }, { role: "customer", appId: reg.body.id });

    const login = await call(customerLogin.POST, { body: { email, password: "TestPass123!" } });
    assert.equal(login.status, 200);
    assert.equal(decode(login.body.token).app_id, reg.body.id);
  });

  await t.test("Keycloak down: login -> 503; register -> 503 and the DB row is compensated away", async () => {
    fakeKeycloak.down = true;
    try {
      const login = await call(customerLogin.POST, { body: { email: "nong@example.com", password: SEED_PASSWORD } });
      assert.equal(login.status, 503);

      const c = await call(customerRegister.POST, { body: { email: "kc-down@example.com", password: "TestPass123!", name: "Down" } });
      assert.equal(c.status, 503);
      assert.equal(countCustomers("kc-down@example.com"), 0, "no customer row left behind");

      const p = await call(providerRegister.POST, { body: { email: "kc-down-p@example.com", password: "TestPass123!", name: "Down P" } });
      assert.equal(p.status, 503);
      assert.equal(countProviders("kc-down-p@example.com"), 0, "no provider row (nor profile) left behind");
    } finally {
      fakeKeycloak.down = false;
    }
    const retry = await call(customerRegister.POST, { body: { email: "kc-down@example.com", password: "TestPass123!", name: "Down" } });
    assert.equal(retry.status, 201, "once Keycloak is back, the same email registers fine");
  });

  await t.test("an email Keycloak already has (another role) -> 409 and no DB row", async () => {
    // sparkle@ is a provider; the same email can't also become a customer (Keycloak username = email).
    const res = await call(customerRegister.POST, { body: { email: "sparkle@example.com", password: "TestPass123!", name: "Dup" } });
    assert.equal(res.status, 409);
    assert.equal(countCustomers("sparkle@example.com"), 0);
  });
});
