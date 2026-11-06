# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`des428-capstone-imppb` — "Bangkok Homeservice" (internally still `edemand` / eDemand), a
multi-vendor home-services marketplace for the DES428 course, being **migrated from a monolith to
services one step at a time** per `docs/STEPS.md`. It started as a single-process Next.js 14 App
Router monolith over one SQLite file; the eight bounded contexts are the deliberate extraction seams,
and several "monolith pains" were left in on purpose. `README.md` is the spec, not just docs — read
it before any architectural change (its "Step 2 — Area A" section documents the current split).

**Migration status:** Step 2 (Area A) is **merged** — Notifications and Payments & Wallet are
extracted behind an nginx gateway. Step 3 (Area B, security) is in progress: the BOLA fix on
`GET /api/jobs/:id` and the Keycloak realm are merged; all three processes now verify Keycloak
tokens (B2 + B3). Steps 4–6 are not started on `main`.

```
Browser ──▶ nginx gateway :8080  (gateway/nginx.conf)
             ├─ = /api/notifications, ^~ /api/notifications/ ─▶ services/notifications :4001  Express + Postgres notif_db
             ├─ ^~ /api/payments/, = /api/provider/wallet,
             │  = /api/customer/transactions ─────────────────▶ services/payments      :4002  Express + Postgres pay_db
             ├─ ^~ /api/internal/  → 404 (service-to-service only)
             └─ everything else ───────────────────────────────▶ monolith (repo root)   :3000  Next.js + SQLite
```

The monolith still owns Identity, Catalog, Providers, Booking, Bidding, Reviews, the `events`
outbox and an `inbox_events` table. `lib/modules/` has **no `payments/` or `notifications/`** any
more — don't recreate them or reintroduce their tables (`test/schema-split.test.js` guards this).

ESM only (`"type": "module"`) — in the monolith and in both services.

**Node version matters more than `engines` says.** `engines` is `>=20`, but the pinned
`better-sqlite3@11.10.0` only publishes prebuilt binaries for ABI 108/115/127/131 — i.e. Node
18/20/22/23. On **Node 24+ `npm install` fails**: `prebuild-install` 404s, falls back to
`node-gyp rebuild`, and needs a full C++ toolchain. npm then *rolls the whole install back*, leaving
`node_modules` empty — which surfaces later as a confusing
`ERR_MODULE_NOT_FOUND: Cannot find package 'pino'`.

`.nvmrc` pins **Node 20** to match the Dockerfiles' `node:20-slim`. Check `node -v` before any
npm command; if it isn't v20, switch with the developer's version manager (nvm / fnm / volta) or use
Docker instead. Machine-specific setup (how Node 20 is selected on a given machine, shell quirks)
belongs in the git-ignored `CLAUDE.local.md`, not here.

## Personal setup: `CLAUDE.local.md`

This file (`CLAUDE.md`) is **shared by the whole team** and must stay true on every machine.
Each teammate also keeps a **`CLAUDE.local.md`** in the repo root. Claude Code loads it
automatically alongside this file, and it is **git-ignored** (`/CLAUDE.local.md` in `.gitignore`),
so it never reaches GitHub.

**What goes where:**

| `CLAUDE.md` (shared, committed) | `CLAUDE.local.md` (personal, ignored) |
|---|---|
| Architecture, rules, tests, gotchas | How Node 20 is selected on *this* machine (nvm / fnm / volta / Docker-only) |
| Commands in their plain form (`npm test`) | OS/shell quirks (e.g. `npm.cmd` on Windows, `docker` not on PATH) |
| Git workflow, team decisions | Local paths (Docker Desktop install location, etc.) |
| | Which `docs/STEPS.md` step/area *I* own right now |
| | Personal preferences (reply language, verbosity) |

**Rules:**
- If `CLAUDE.local.md` is missing, Claude should **offer to create it** from the template below,
  asking the developer for each value instead of guessing.
- Never put machine-specific commands, absolute paths or personal preferences in `CLAUDE.md`.
  Never commit `CLAUDE.local.md`.
- A fact that turns out true for everyone (a new gotcha, a team rule) moves *up* into `CLAUDE.md`
  via a PR, not into each person's local file.
- When `CLAUDE.local.md` and `CLAUDE.md` disagree on a command, the local file wins (it knows the
  machine); on project rules or architecture, `CLAUDE.md` wins.

**Template** — copy into `CLAUDE.local.md` and fill in:

```markdown
# CLAUDE.local.md — this machine only (git-ignored)

## Node / npm on this machine
<!-- How Node 20 is selected, e.g. "nvm use" / "fnm exec --using=20 --" / "Docker only".
     Exact command forms to use, and any shell quirks (npm vs npm.cmd). -->

## Docker on this machine
<!-- Docker Desktop version, where docker lives if it's not on PATH, anything odd. -->

## Language
<!-- e.g. "Reply in Thai. Code, commit messages and CLAUDE.md stay in English." -->

## My current work
<!-- Which Step / Area of docs/STEPS.md I own, who owns the areas I depend on,
     and which shared files I expect to touch. -->
```

## Commands

### Monolith (repo root) — no Postgres, no sockets

Verified with Node 20.20.2: **80/80 tests across 13 files**.

```bash
npm install
npm run dev                                   # http://localhost:3000 (monolith only, no gateway)
npm test                                      # = node --test test/*.test.js
node --test test/booking.test.js              # one test file
node --test --test-name-pattern "slot" test/*.test.js
```

⚠️ **`npm test` fails on Windows** with `Could not find '...\test\*.test.js'`: npm runs scripts
through `cmd.exe`, which doesn't expand globs, and Node 20's `--test` doesn't expand them either.
Run `node --test test/*.test.js` from a POSIX shell (Git Bash / WSL) instead, or use Docker. The
glob exists so a bare `node --test` doesn't also pick up `services/*/test/` (those need Postgres).

Without the services running, `npm run dev` still serves the monolith, but gateway bookings return
503 (Payments unreachable → compensation) and the notifications / wallet / dashboard pages show an
upstream error. Use Docker for the full system.

### Services (`services/notifications`, `services/payments`) — need Postgres

Each is its own npm package (own `package.json` / lockfile, Express 4, `pg`, `jose`,
`zod`, `pino`). Tests run against a **real Postgres** via `DATABASE_URL`, serially
(`--test-concurrency=1`). Easiest through Docker (below); otherwise
`cd services/<name> && npm install && DATABASE_URL=postgres://… npm test`.
Verified 2026-11-07 in Docker: **notifications 13/13, payments 21/21**.

`docker compose --profile test run` starts `test-db` as a dependency and **leaves it running**
afterwards; clean up with `docker compose --profile test rm -sf test-db`.

### Docker — the full system (the path the course intends)

```bash
docker compose up -d --build --wait                         # gateway on http://localhost:8080
docker compose --profile test run --rm --build test                 # monolith suite (services faked)
docker compose --profile test run --rm --build notifications-test   # real Postgres (test-db)
docker compose --profile test run --rm --build payments-test        # real Postgres (test-db)
docker compose down -v
```

Browse through the **gateway on :8080**. `:3000` is the monolith directly (debugging only — the
extracted routes don't exist there). Compose services: `gateway`, `edemand`, `notifications`,
`payments`, `notif-db`, `pay-db`, `keycloak` (:8081), plus the `test` profile (`test`, `test-db`,
`notifications-test`, `payments-test`). `deploy/test-db-init.sql` creates `notif_test` / `pay_test`.

**Always pass `--build`.** There is no source bind-mount (only `gateway/nginx.conf` is mounted):
each Dockerfile `COPY`s the source into the image at build time. Without `--build`, an existing image
is reused and the container silently runs the **pre-edit code**. `edemand` is a production
`next build`, so there is no hot-reload. Note the root `.dockerignore` excludes `services/`,
`gateway/` and `deploy/` — the services build from their own context.

On Docker Desktop (Windows/macOS) the engine only runs while the app is open — a
`failed to connect to the docker API` error means Docker Desktop isn't running, not a broken CLI.

There is **no linter, formatter, or TypeScript** configured. Don't invent `npm run lint`/`typecheck`.
`jsconfig.json` is for editor resolution only.

## Git workflow

This is a team repo. The full team convention (in Thai, written for teammates) is
`docs/GIT-WORKFLOW.md`. Rules that apply when working here:

- **Never commit or push to `main` directly.** Branch from an up-to-date `main` first:
  `git switch main && git pull && git switch -c <type>/<short-name>`.
- Branch prefixes: `feature/`, `fix/`, `docs/`, `refactor/`, `test/`, `chore/` (lowercase, `-`
  between words). One branch = one task; branches are short-lived and deleted after merge — never
  reuse a merged branch.
- Commit messages: English, imperative verb first (`Add …`, `Fix …`), ≤ ~70 chars.
- Before pushing: `git fetch && git rebase origin/main`, then tests must pass.
  After a rebase use `git push --force-with-lease` (own branch only — never force-push `main`).
- Changes land via a **Pull Request** with ≥ 1 approval, merged with **Squash and merge** only.
  After a squash merge the local branch needs `git branch -D` (not `-d`).
- On a `package-lock.json` conflict, don't hand-edit: take theirs and re-run `npm install` (there
  are three lockfiles: root + one per service).
- Shared hot-spot files — flag to the team before editing: `lib/db/schema.js`, `lib/db/seed.js`,
  `openapi.yaml`, `package.json`/`package-lock.json`, `app/globals.css`, `test/booking.test.js`,
  `docker-compose.yml`, `gateway/nginx.conf`, `lib/http/auth.js`, `lib/config.js`,
  `test-helpers/*`.
- Keep `docs/GIT-WORKFLOW.md` in step if any of these rules change.

Seed logins (all share `SEED_PASSWORD` = `eDemand-2026!`, exported from `lib/db/seed.js`):
`nong@example.com` (customer), `sparkle@example.com` (approved provider), `glow@example.com`
(pending provider), `admin@edemand.test`.

## Architecture — monolith

### The layering rule

`route handler → service → repository → db`

- **No SQL outside `lib/modules/*/repository.js`** (plus the `lib/db/` primitives: `events.js`,
  `inbox.js`, `idempotency.js`). No business logic in `app/api/**/route.js`.
- Route handlers only: zod-validate, role-gate, call a service, shape the response.
- A **bounded context owns its tables** (`README.md` has the table). Never read another context's
  tables from your own repository — go through the owning context's repository/service. That
  ownership *is* the extraction seam; violating it destroys the point of the codebase.
- Data owned by an **extracted service is reached only over HTTP**, never by SQL:
  - sync calls from the monolith go through a client in `lib/clients/` (today only
    `lib/clients/payments.js#createIntent`), with the shared `INTERNAL_TOKEN`;
  - Server Component pages that show service-owned data use `fetchUpstream()`
    (`lib/http/upstream.js`), which forwards the `edemand_token` cookie as `Bearer`, propagates
    `X-Request-Id` / `traceparent`, and uses `cache: 'no-store'`;
  - the monolith keeps a **local copy** where it needs one (e.g. `orders.gateway_ref`,
    `orders.payment_status`) instead of reading Payments' tables.

### Imports

`package.json` `imports` maps `#lib/*` → `./lib/*`. Everything under `app/` imports via
`#lib/http/...`, `#lib/modules/...`. Inside `lib/`, modules use **relative** paths (`../../db/index.js`).
Follow whichever convention the file you're in already uses.

### Route handler shape

Every file in `app/api/**` follows this exactly:

```js
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = handle(async (req, { params }) => {
  const auth = await getAuth(req, "customer");    // throws 401/403 (async!)
  const input = parse(schema, await readJson(req)); // throws 400 + field details
  return json(body, { status: 201 });
});
```

- `handle()` (`lib/http/handle.js`) is mandatory — it derives the request id, stamps
  `X-Request-Id`, and funnels thrown errors through `toResponse`.
- **Throw typed errors** (`BadRequestError`/`UnauthorizedError`/`ForbiddenError`/`NotFoundError`/
  `ConflictError`/`ServiceUnavailableError` from `lib/errors.js`). Never construct an error
  `Response` by hand — `lib/http/respond.js` is the only place errors become HTTP. Error shape is
  always `{ error, requestId, details? }`; 5xx bodies are scrubbed.
- Responses use the **global web `Response`**, not `NextResponse` — that's what keeps handlers
  importable under plain `node --test`.
- Service-to-service routes live under `app/api/internal/**` (today: `POST /api/internal/events`).
  They authenticate with the `x-internal-token` header (`config.internalToken`), **never a user
  JWT**, and nginx blocks `/api/internal/` from outside.

### UI

Pages are **Server Components that call the service layer directly, in-process** (the honest
monolith read path) — e.g. `app/(customer)/services/[id]/page.js` imports
`#lib/modules/catalog/service.js`. Exceptions since Step 2: `/notifications`, `/provider/wallet`
and `/provider/dashboard` read from the extracted services via `fetchUpstream()`. Route groups
`(customer)` / `(provider)` / `(admin)` carry the three personas. Server-side identity comes from
**`await getSession()`** (`lib/http/session.js`, async since Step 3 — so a page that uses it is an
`async` Server Component), which verifies the httpOnly `edemand_token` cookie via `next/headers`;
it is UI-only and must never be used on the API path.

All **mutations** go through `fetch` to route handlers from the shared client components in
`app/_ui/client.js` (`Form`, `ActionButton`, `BookingForm`, …). Prefer extending those over writing
a new one-off client component. Styling is one hand-written `app/globals.css` with plain class names
(`panel`, `row`, `stack`, `muted`, `err`) — no CSS framework.

Auth tokens verify identically from either `Authorization: Bearer` (API + tests) or the
`edemand_token` cookie (browser) — see `lib/http/auth.js`.

### Auth (Step 3 — Keycloak everywhere, no HS256 anywhere)

Keycloak alone signs tokens (RS256); there is no shared JWT secret any more. All three processes
verify the same way with `jose`: signature against the realm's JWKS, then `iss` (pinned, below),
`aud` (each checks its own: monolith `edemand-api`, services `payments-api` / `notifications-api`)
and `exp`. Bad token → **401**; Keycloak/JWKS unreachable → **503**. The token's `app_id` claim is
normalised to **`auth.sub`** (Keycloak's own user id → `auth.kcSub`), so every owner check is still
`(role, sub)` — ids are **not unique across roles** (customer#1, provider#1, admin#1 all exist).

**Monolith** (`lib/http/auth.js`): **`await getAuth(req, roles)`** — async since Step 3; forgetting
the `await` gives you a Promise, not an identity. JWKS is fetched with `fetch` by
`lib/http/jwks.js` (cached; re-fetched on an unknown `kid`, at most every 10 s — Keycloak makes new
keys each time it re-imports the realm) instead of jose's `createRemoteJWKSet`, which uses
`node:http` and couldn't be faked in the socket-free suite. **Login** (`identity/service.js`) is a
Direct Access Grant through `lib/clients/keycloak.js#passwordGrant`; the endpoint's role must match
the token's (a provider at `/api/auth/customer/login` → 401). **Registration** inserts the monolith
row first (its id = `app_id`), then `createUser()` via the `edemand-backend` service account; if
Keycloak says 409 or is down, the row is **deleted again (compensation)** → 409 / 503. Keycloak's
username is the email, so **one email = one account across all roles**. `password_hash` is still
written (legacy NOT NULL column) but never read.

**Services** (`services/*/src/http.js#requireAuth`): same rules, `jose` `createRemoteJWKSet`.

**Keycloak (Step 3, in progress).** Compose service `keycloak` (`quay.io/keycloak/keycloak:26.0`,
`start-dev`) imports `deploy/keycloak/edemand-realm.json` on every boot — realm `edemand`, the 7 seed
users (same `SEED_PASSWORD`), login client `web` (Direct Access Grant), audiences `edemand-api` /
`payments-api` / `notifications-api`, the confidential `edemand-backend` service account
(`manage-users`, used only by registration), and an evidence-only client `aud-test` that has no API
audience. Access tokens
carry `app_id` (number — the monolith DB id of *that role's* table, so compare `(role, app_id)`) and
`role`, and live 12 h like the cookie. The issuer is pinned with `KC_HOSTNAME`, so it is
**`http://localhost:8081/realms/edemand` everywhere**, even for tokens fetched inside the network;
containers fetch JWKS from `http://keycloak:8080/realms/edemand/protocol/openid-connect/certs`.
Admin console: http://localhost:8081/admin (`admin` / `admin`). `edemand`, `payments` and
`notifications` `depends_on` it (healthy) and get `KEYCLOAK_ISSUER` / `JWKS_URL` from
`x-keycloak-env`; `edemand` also gets `KEYCLOAK_URL` (token + admin API) and the service-account
secret. Users registered at runtime live only until Keycloak restarts (the realm is re-imported) —
like the monolith's own data, nothing is durable.

### Database (monolith)

- One `better-sqlite3` connection, **synchronous**, cached on a `globalThis` Symbol
  (`lib/db/index.js`) so dev hot-reload can't open a second one. Because it's one shared sync
  connection, a service in one context can open `db.transaction()` and write through *another*
  context's repository atomically. That is relied on throughout.
- **Never `await` inside a `better-sqlite3` transaction** — it's synchronous. Network calls to a
  service happen *after* the transaction commits (see `placeBooking`).
- The DB is **dropped, migrated and reseeded on every boot** (`lib/db/bootstrap.js`, called from
  `instrumentation.js`). There is no migration history: to change the schema, edit
  `lib/db/schema.js` and `lib/db/seed.js`. **Data is not durable** — never write code or advice that
  assumes persistence across restarts. (The services' Postgres schemas are in
  `services/*/src/schema.js`; Payments seeds wallets for `SEED_PROVIDER_IDS`, matching the
  monolith's provider ids.)
- `sqlite_sequence` for `orders` is primed so the **first booking on a fresh boot is always id 8001**
  (`config.firstOrderId`). Tests assert this.
- Money is **integer cents** everywhere. Tax is one flat `config.taxPercent` (7%), snapshotted onto
  each `order_item` at booking time.
- `lib/config.js` is the only place that reads `process.env` (plus `db/index.js` resolving
  `DB_PATH`). Add new settings there. Step 2 added `PAYMENTS_URL`, `NOTIFICATIONS_URL`,
  `INTERNAL_TOKEN`, `EVENT_SUBSCRIBERS`, `RELAY_INTERVAL_MS`. Step 3 removed `JWT_SECRET` /
  `JWT_EXPIRES_IN` and added `KEYCLOAK_URL`, `KEYCLOAK_REALM`, `KEYCLOAK_ISSUER`, `JWKS_URL`,
  `JWT_AUDIENCE`, `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_ADMIN_CLIENT_ID`, `KEYCLOAK_ADMIN_CLIENT_SECRET`.

### Concurrency idioms — do not regress these

The whole point of several modules is that they are race-free. When touching them, keep the pattern:

- **Atomic conditional writes, never read-then-write.**
  `UPDATE ... SET status='x' WHERE status='y'` then check `.changes` / `rowsAffected`. Examples:
  `bidding/service.js#acceptBid` (two concurrent accepts ⇒ exactly one winner),
  `booking/service.js#completeBooking` (`WHERE status='started' AND otp=?` — the
  `booking.completed` event is written *inside* that update's transaction, so it is emitted exactly
  once; Payments credits the wallet when it consumes it).
- **`slot_holds` `UNIQUE(provider_id, service_date, slot_time)`** is the physical double-book guard.
  `get_available_slots` reads are advisory only; the uniqueness on the *write* is what makes a
  double-book impossible (one 201, one 409). Both the place-booking and bid-accept paths insert here.
- **`placeBooking` = one `.immediate()` transaction, then a sync call.** The transaction holds
  order + items + slot_holds + outbox event (a clash leaves zero partial rows). Only after it commits
  does a gateway booking call `POST /intents` (`Idempotency-Key = order_id`) and store
  `gateway_ref` on the order. If Payments is unreachable the order is **cancelled again
  (compensation)** — releasing its slots and emitting `booking.cancelled` so Payments voids any
  intent it did create — and the caller gets **503**.
- **Idempotency**: `withIdempotency()` (`lib/db/idempotency.js`) replays a stored `{statusCode, body}`.
  Keys are scoped to the actor (`${actor}:${key}`). Used by `POST /api/bookings`. A replay of a
  gateway booking that already has `gateway_ref` does not call Payments again.
- **Inbox dedupe (consumer side)**: every consumer records `(source, event_id)` under a PRIMARY KEY
  **in the same transaction as the effect** — monolith `inbox_events` (`lib/db/inbox.js`,
  `lib/outbox/inbound.js`), services `processed_events`. A redelivered event is a no-op.
- **Webhook dedupe** now lives in Payments: `webhook_events.gateway_event_id UNIQUE`
  (`services/payments`). Payments emits `payment.succeeded`; **Booking** flips its own
  `orders.payment_status` (`applyPaymentSucceeded` / `applyPaymentRefunded`).
- **Intent idempotency** in Payments: `payment_intents.order_id UNIQUE`; a repeated `POST /intents`
  returns the existing intent (200) instead of creating a second (201).

### Outbox + relay (eventual consistency) — Step 2 transport

Every state change calls `insertEvent()` (`lib/db/events.js`) **inside the same transaction** as the
change. The relay is **`lib/outbox/relay.js`** (`startRelay()` from `instrumentation.js`, every
`RELAY_INTERVAL_MS`, default 1000 ms). For each unprocessed event, in id order, it (1) runs local
handlers, (2) POSTs the envelope `{ source, id, type, aggregate_type, aggregate_id, payload,
occurred_at }` to **every** URL in `EVENT_SUBSCRIBERS` with `x-internal-token`, and (3) only when all
of that succeeded stamps `processed_at`. A failure stops the pass (ordering is preserved) and the
event is retried next tick — **at-least-once**; consumers dedupe via their inbox. Payments has its
own `outbox` + relay (`services/payments/src/relay.js`) delivering to the monolith's
`/api/internal/events` and to Notifications. Step 4 replaces the HTTP delivery with RabbitMQ.

| Event | Producer | Consumers |
|---|---|---|
| `booking.status_changed`, `bid.accepted`, `review.created`, `provider.approved` | monolith | notifications (`review.created` also recomputes ratings locally) |
| `booking.completed` | monolith | payments (wallet credit), notifications |
| `booking.cancelled` | monolith | payments (refund or void) |
| `payment.succeeded`, `payment.refunded` | payments | monolith (mark paid / refunded), notifications |

**The rating aggregate on `services`/`provider_profiles` is recomputed in the relay's local
handler**, driven by `review.created` — deliberately *not* inline in the review handler. A fresh
review leaves the aggregate stale until the relay runs. This staleness is a tested, intentional
teaching point; do not "fix" it by updating the aggregate inline.

## Tests

### Monolith

`node --test test/*.test.js`, **80 tests across 13 files**, no socket. The suite **imports the real
App Router route handlers and calls them in-process**. Conventions that matter:

- `test-helpers/boot.js` **must be the first import in every test file** — it sets
  `NODE_ENV=test` / `DB_PATH=:memory:` / the service URLs, installs the fakes, and *then*
  dynamically imports the DB layer, so the env is in place before any handler's static module graph
  (config, db) evaluates.
- **The extracted services are faked in-process** by `test-helpers/fakeServices.js`, which
  replaces `globalThis.fetch`: `POST http://payments.test/intents` and the two subscriber
  `/internal/events` URLs are answered locally; anything else falls through to the real fetch.
  Flip `fake.paymentsDown` / `fake.subscribersDown` to exercise compensation and relay retry;
  inspect `fake.intentCalls` / `fake.delivered`; call `fake.reset()` between scenarios.
- **Keycloak is faked the same way** (`test-helpers/fakeKeycloak.js`, host `http://keycloak.test`):
  token endpoint (password + client_credentials), JWKS and admin create-user, starting with the 7 seed
  users. So `test-helpers/auth.js` logins/registrations go through the real routes unchanged.
  `fakeKeycloak.down = true` → 503 paths; `tokenFor` / `forgedToken` / `expiredToken` /
  `wrongAudienceToken` / `hs256Token` build tokens directly (`test/keycloak-auth.test.js`).
- Each test *file* is its own process, so each gets an isolated `:memory:` DB. Call `freshBoot()` at
  module top level.
- `call(handler, { token, params, query, body, secret })` from `test-helpers/call.js` builds a real
  `Request` and invokes `handler(req, { params })`. `test-helpers/auth.js` provides
  `registerCustomer`, `loginSeededCustomer/Provider`, `loginAdmin`, `futureWeekday()` (returns a
  Mon–Sat date so bookings land inside seeded 09:00–18:00 hours).
- The relay is async now: `await runRelayOnce()` (from `lib/outbox/relay.js`) to drain events
  synchronously in a test instead of waiting for the interval.
- `test/booking.test.js` uses **sequential subtests that share state** and asserts the first order is
  `8001`. Don't reorder them or add a booking before the first subtest.
- `test/schema-split.test.js` asserts the moved tables are gone from the SQLite schema.

### Services

Each service has `test/helpers.js` + one suite, run against a real Postgres (`DATABASE_URL`),
mounting the Express app from `createApp()` (`src/app.js`, no `listen`) on an ephemeral port.

- **User tokens come from `test/fakeKeycloak.js`**: an RS256 key pair whose public half is served as
  a JWKS over real HTTP; `helpers.js` points `JWKS_URL` / `KEYCLOAK_ISSUER` at it, so `requireAuth`
  runs its production code path. `tokenFor(role, appId)` signs Keycloak-shaped tokens (sync);
  `forgedToken` / `expiredToken` / `wrongAudienceToken` / `hs256Token` build the ones that must 401.
- **Never import `../src/*` statically in a test file** — ESM evaluates it (and `config.js`) before
  `helpers.js` has set the env, and every user token then fails with 503. Import `src/` dynamically
  after `helpers.js` (see `payments.test.js` → `runRelayOnce`).

## Gotchas

- `better-sqlite3` is a native addon and must stay in `next.config.js`
  `experimental.serverComponentsExternalPackages`, or `output: "standalone"` traces the wrong binary.
- `experimental.instrumentationHook: true` is required for `instrumentation.js` on Next 14.2 — the
  DB bootstrap and relay won't run without it.
- `openapi.yaml` documents the full API surface; keep it in step when adding or changing a route.
  The extracted routes keep their old public URLs — nginx decides who serves them.
- Adding a route that an extracted service should serve means **editing `gateway/nginx.conf`**
  too, or the request silently lands on the monolith (404). Anything under `/api/internal/` must
  stay unreachable from outside.
- The product name changed (eDemand → Bangkok Homeservice) **only** course-facing. Identifiers, the
  DB file (`data/edemand.db`), the cookie (`edemand_token`), and the package names still say
  `edemand` — leave them alone.
- **Do not run `npm audit fix --force`.** `npm audit` reports advisories (critical `next`; high
  `nanoid`/`postcss`/`source-map-js`/`zod`; moderate `uuid`). The deps are pinned on purpose as the
  course baseline, and `--force` would bump `next`, `zod`, `postcss` and `uuid` across majors — zod 4
  alone would break every route's validation. Left as-is deliberately (team decision, 2026-11-02).
- **Migration work in scope** (per `docs/STEPS.md`): Step 2 extraction + nginx gateway is done; the
  team still adds an external IdP (Keycloak, Step 3), a real broker (RabbitMQ) with outbox/saga/DLQ
  (Step 4), resilience — timeouts, retries, fault switches (Step 5), and observability —
  OpenTelemetry, Prometheus/Grafana, Pact (Step 6). These are **in scope** — don't refuse or
  second-guess them; follow `docs/STEPS.md` for each step's requirements and "done when" criteria.
- Still out of scope: real payment gateways, chat, cart, subscriptions, SOAP/WSDL.
