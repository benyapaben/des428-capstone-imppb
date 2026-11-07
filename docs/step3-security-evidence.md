# Step 3 (Area B, Security): evidence

This report covers Step 3 of [`docs/STEPS.md`](STEPS.md): 3.1 Keycloak realm, 3.2 every service verifies
its own tokens, 3.3 ownership checks, 3.4 the monolith off HS256, and 3.5 BOLA. For each part it gives
what was done, where it lives in the code, and the evidence. That evidence is the automated tests plus,
for 3.2, a curl run against the real Keycloak.

| Part | Status | PR |
|---|---|---|
| 3.1 Keycloak realm | done | #6 |
| 3.2 services verify tokens via JWKS | done | #7 |
| 3.4 monolith on Keycloak, HS256 removed | done | #8 |
| 3.5 BOLA on `GET /api/jobs/:id` | done | #5 |
| 3.3 ownership checks in the services | done | #9 |
| Done-when: curl evidence for forged / expired / wrong-audience tokens | done | this document |

---

## 1. Done-when: bad tokens get 401 from both services

> *Forged, expired and wrong-audience tokens all get `401` from both services, with tests and curl as evidence.*
> (`docs/STEPS.md`, Step 3 "done when")

### How every process verifies a token

The gateway (nginx) only forwards the request. It does not check tokens. Each of the three processes checks
the token itself with `jose`:

- the RS256 signature, against the realm's JWKS;
- `iss`, pinned to `http://localhost:8081/realms/edemand`;
- `aud`, which must name *its own* API: monolith `edemand-api`, Payments `payments-api`,
  Notifications `notifications-api`;
- `exp`, with no clock tolerance.

A failed check gets **401**. If Keycloak or the JWKS cannot be reached, the response is **503**.

| Process | Code |
|---|---|
| Payments | `services/payments/src/http.js#authenticate` |
| Notifications | `services/notifications/src/http.js#authenticate` |
| Monolith | `lib/http/auth.js#getAuth` (JWKS fetched by `lib/http/jwks.js`) |

### Curl against the real Keycloak

The script is [`deploy/keycloak/step3-evidence.sh`](../deploy/keycloak/step3-evidence.sh). It needs only
bash, curl, sed, base64 and openssl.

```bash
docker compose up -d --build --wait
bash deploy/keycloak/step3-evidence.sh     # takes about 70 s; exit code 0 means every row passed
```

The script logs in as `sparkle@example.com` (provider#1), using the password grant against the real
Keycloak. It then calls each route **through the gateway on :8080**. The services publish no ports of their
own, so the gateway is the only way in. These are the cases:

| Case | How the token is made |
|---|---|
| valid web token (control) | A normal login through client `web`. It must get **200**, which shows that the 401s below come from the token and not from the route. |
| no token (control) | No `Authorization` header. |
| forged: payload edited, old sig | A real token with its payload changed (`app_id` → 999). Keycloak's original signature is kept. |
| forged: signed by attacker key | The *same* claims and `kid` as the real token, but signed by an RSA key the script generates itself. |
| wrong audience (aud-test client) | A real Keycloak token from client `aud-test`, which has no API audience mapper. |
| expiry-test token, not yet expired | A real token from client `expiry-test`, whose access tokens live 60 s. Before it expires it gets **200**. |
| expired (same token, after exp) | The *same* `expiry-test` token after the script waits until `exp` + 5 s. |

`expiry-test` and `aud-test` exist **only for this evidence**, in `deploy/keycloak/edemand-realm.json`.
`expiry-test` has the same claims and audiences as `web`. Its one difference is a shorter token lifetime,
so it grants nothing that `web` does not already grant. The realm's normal lifetime is 12 h, which is why a
second client is needed to show an expired real token.

The run below was recorded on 2026-11-07, unedited. The monolith rows (`/api/me`) are a bonus; the
done-when asks only for the two services.

```text
gateway  http://localhost:8080
keycloak http://localhost:8081   user sparkle@example.com

token claims (decoded from the real tokens):
  VALID     azp="web"        aud=["edemand-api","payments-api","notifications-api"] iat=1794030318 exp=1794073518
  WRONG_AUD azp="aud-test"   aud=(none)                                           iat=1794030318 exp=1794073518
  EXPIRING  azp="expiry-test" aud=["notifications-api","payments-api","edemand-api"] iat=1794030318 exp=1794030378
  EXPIRING lifetime = 60 s

ROUTE          CASE                                 EXPECT GOT   RESULT ERROR (response body)
-----          ----                                 ------ ---   ------ ---------------------
payments       valid web token (control)            200    200   PASS  
notifications  valid web token (control)            200    200   PASS  
monolith       valid web token (control)            200    200   PASS  
payments       no token (control)                   401    401   PASS  missing bearer token
notifications  no token (control)                   401    401   PASS  missing bearer token
monolith       no token (control)                   401    401   PASS  missing bearer token
payments       forged: payload edited, old sig      401    401   PASS  invalid token: signature verification failed
notifications  forged: payload edited, old sig      401    401   PASS  invalid token: signature verification failed
monolith       forged: payload edited, old sig      401    401   PASS  invalid token: signature verification failed
payments       forged: signed by attacker key       401    401   PASS  invalid token: signature verification failed
notifications  forged: signed by attacker key       401    401   PASS  invalid token: signature verification failed
monolith       forged: signed by attacker key       401    401   PASS  invalid token: signature verification failed
payments       wrong audience (aud-test client)     401    401   PASS  invalid token: missing required "aud" claim
notifications  wrong audience (aud-test client)     401    401   PASS  invalid token: missing required "aud" claim
monolith       wrong audience (aud-test client)     401    401   PASS  invalid token: missing required "aud" claim
payments       expiry-test token, not yet expired   200    200   PASS  
notifications  expiry-test token, not yet expired   200    200   PASS  
monolith       expiry-test token, not yet expired   200    200   PASS  
... waiting 58s for the expiry-test token to pass its exp (1794030378)
payments       expired (same token, after exp)      401    401   PASS  invalid token: "exp" claim timestamp check failed
notifications  expired (same token, after exp)      401    401   PASS  invalid token: "exp" claim timestamp check failed
monolith       expired (same token, after exp)      401    401   PASS  invalid token: "exp" claim timestamp check failed

ALL PASS
```

To check that the script can fail, it was also run with `GW=http://localhost:3000`, pointing at the monolith
directly, which does not serve the services' routes. The service rows came back 404, were marked FAIL, and
the script exited with code 1.

### Automated tests

These tests run on every change and need no real Keycloak. Each suite signs its own tokens with an
in-process fake Keycloak, which serves a real JWKS (`services/*/test/fakeKeycloak.js`,
`test-helpers/fakeKeycloak.js`). The verification code under test is the production code.

| Suite | Test | Bad tokens covered (all must get 401) |
|---|---|---|
| `services/payments/test/payments.test.js` | *Keycloak token checks: forged, expired, wrong audience, old HS256 -> 401* | forged signature, expired, wrong audience, **only the notifications-api audience**, wrong issuer, Step 2 HS256 token, no `app_id`, unknown role |
| `services/notifications/test/notifications.test.js` | same name | the same cases, with **only the payments-api audience** |
| `test/keycloak-auth.test.js` (monolith) | *forged, expired, wrong audience, wrong issuer, old HS256 ... -> 401* | the same idea for `edemand-api` |

The tests cover some tokens that curl cannot make from the real realm. One example is a token valid for
Payments but not Notifications: every real login token carries all three audiences. Another is a token
from the wrong issuer.

---

## 2. Ownership checks (3.3)

**Trap:** `app_id` is **not unique across roles**. customer#1, provider#1 and admin#1 all exist. Every
owner check must therefore compare the pair **(role, app_id)**, never the id alone. The services read
`app_id` from the token as `req.auth.sub`.

| Rule | Where it is enforced |
|---|---|
| A provider sees only their own wallet | `services/payments/src/app.js`, `GET /api/provider/wallet`: the route is limited to providers and calls `getWallet(req.auth.sub)`. The provider id comes **only from the token**; nothing in the request can choose it. |
| Simulate works only for an intent whose `customer_id` is the caller | `services/payments/src/service.js#simulateSucceeded` compares `payment_intents.customer_id` with the caller. Since the split, Payments cannot read the monolith's `orders`, which is why Step 2 added `customer_id` to the intent. |
| Mark read works only on your own notification | `services/notifications/src/service.js#markRead` checks **both** `recipient_role` and `recipient_id`. The `UPDATE` repeats both conditions in its `WHERE` (`repository.js#markRead`), so the write is safe on its own too. |

Area A wrote these rules during Step 2. Step 3 (PR #9) **added the tests** that check the cases the
original tests missed:

- **payments** (`payments.test.js`):
  - *wallet/transactions are role-gated*: admin#1, which shares `app_id` 1 with provider#1, gets 403.
  - *wallet ignores any provider_id in the request*: `?provider_id=2` still returns provider#1's wallet.
  - *another provider's wallet shows none of provider#1's money*.
  - *simulate: only the intent's customer may pay …*: these callers all get 403: customer#2;
    provider#1 and admin#1, which share `app_id` 1 with the intent's customer; and customer#2 sending
    `customer_id: 1` in the body. After every 403 the intent is still `requires_payment` with zero
    transactions.
  - *customer transactions are scoped to the caller*.
- **notifications** (`notifications.test.js`):
  - *mark read: owner 200, someone else 403, unknown 404*.
  - *ownership is (role, app_id): same id in another role gets 403 and changes nothing*: customer#1 and
    admin#1 cannot mark provider#1's notification read, and it stays unread. customer#1's list contains none
    of provider#1's messages.

**Do these tests catch a regression?** Two changes were made temporarily, then reverted:

- The role comparison was removed from `markRead`. The new test failed with
  `customer#1 (same app_id) -> expected 403, got 200`.
- The `customer_id` check was removed from simulate. The simulate test failed.

---

## 3. BOLA on `GET /api/jobs/:id` (3.5)

**Before:** the route only required the caller to be logged in (`getAuth(req)` with no role).
`lib/modules/bidding/service.js#getJob` loaded the job by id and returned it to anyone. Only the bids were
protected. A customer could therefore read another customer's job: title, description, budget range,
time window and `customer_id`.

**Steps** (as `docs/STEPS.md` 3.5 asks):

1. Wrote the attack test first. It returned 200, which showed the leak.
2. Fixed `getJob`.
3. Ran the same test again. It now returns 403.

**Read policy now** (`getJob`):

| Caller | May read |
|---|---|
| customer | only their own jobs; any other job is 403 |
| provider | open jobs (so they can bid), plus any job they have bid on, in any state; anything else is 403 |
| admin | all jobs |

**Tests:** `test/bola.test.js`, 7 tests. They cover:

- the attack: another customer gets 403 and nothing leaks;
- the owner gets 200;
- a provider reading an open job gets 200;
- a booked job: the winning bidder gets 200, and a provider who never bid gets 403;
- an admin gets 200;
- an unknown job gets 404, and no token gets 401.

The earlier bidding tests still pass. `openapi.yaml` documents the 401 and 403 responses.

---

## 4. Realm and monolith (3.1, 3.4)

- **Realm** (`deploy/keycloak/edemand-realm.json`): realm `edemand` with the 7 seed users (password
  `eDemand-2026!`). Mappers add `app_id` (number) and `role` to the token, and `iss` is pinned with
  `KC_HOSTNAME`. The clients are:
  - `web`: the login client (Direct Access Grant), with audiences `edemand-api` / `payments-api` /
    `notifications-api`;
  - `edemand-backend`: a service account with `manage-users`, used only by registration;
  - `aud-test` and `expiry-test`: for this evidence only.
- **Monolith:** HS256 and `JWT_SECRET` are gone. The monolith accepts only Keycloak tokens, as the step
  requires. The login routes get a token from Keycloak and set the same `edemand_token` cookie as before,
  so the UI is unchanged. Registration also creates the Keycloak user. If Keycloak refuses (409) or is down
  (503), the new database row is deleted again (compensation).
