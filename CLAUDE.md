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
extracted behind an nginx gateway. Step 3 (Area B, security) is **done**: the BOLA fix on
`GET /api/jobs/:id`, the Keycloak realm, all three processes verifying Keycloak tokens, ownership
tests in the services, and curl evidence — summarised in `docs/step3-security-evidence.md`.
Step 4 (Area C, outbox / RabbitMQ / saga) is **done**: both relays publish to RabbitMQ with publisher
confirms, every consumer is idempotent (`processed_messages`), failing messages are dead-lettered, and
Booking runs the payment-timeout / late-payment saga — see the README's "Step 4" section and the
"Outbox + relay + RabbitMQ" section below. Step 5 (Area D, resilience) is **in progress**: `POST /intents`
has a per-attempt timeout and retries with jittered backoff, and Payments has the three fault switches
(`/internal/faults`); the race demo (STEPS.md 5.3) and the Step 5 evidence script/report are still to
come. Step 6 (Area E) belongs to another owner — check open PRs before assuming its status.

```
Browser ──▶ nginx gateway :8080  (gateway/nginx.conf)
             ├─ = /api/notifications, ^~ /api/notifications/ ─▶ services/notifications :4001  Express + Postgres notif_db
             ├─ ^~ /api/payments/, = /api/provider/wallet,
             │  = /api/customer/transactions ─────────────────▶ services/payments      :4002  Express + Postgres pay_db
             ├─ ^~ /api/internal/  → 404 (service-to-service only)
             └─ everything else ───────────────────────────────▶ monolith (repo root)   :3000  Next.js + SQLite

RabbitMQ :5672 (management UI :15672, guest/guest) — events between the three processes (Step 4);
the gateway is not involved. Only POST /intents (monolith → Payments) is still a direct HTTP call.
```

The monolith still owns Identity, Catalog, Providers, Booking, Bidding, Reviews, the `events`
outbox and a `processed_messages` inbox table. `lib/modules/` has **no `payments/` or `notifications/`** any
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

Verified with Node 20.20.2 — run `npm test` for the current counts (they change every step, so none are recorded here).

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
Run them in Docker (below) and read the summary line; counts change as tests are added.

`docker compose --profile test run` starts `test-db` as a dependency and **leaves it running**
afterwards; clean up with `docker compose --profile test rm -sf test-db`.

### Docker — the full system (the path the course intends)

```bash
docker compose up -d --build --wait                         # gateway on http://localhost:8080
docker compose --profile test run --rm --build test                 # monolith suite (services faked)
docker compose --profile test run --rm --build notifications-test   # real Postgres (test-db)
docker compose --profile test run --rm --build payments-test        # real Postgres (test-db)
bash deploy/keycloak/step3-evidence.sh   # stack must be up; real Keycloak tokens -> 200/401 table, ~70 s
PAYMENT_TIMEOUT_SECONDS=30 docker compose up -d --build --wait     # short saga timeout for the demo ...
PAYMENT_TIMEOUT_SECONDS=30 bash deploy/rabbitmq/step4-evidence.sh  # ... then RabbitMQ / DLQ / saga evidence, ~2-3 min
bash deploy/rabbitmq/amqp-robustness-evidence.sh   # consumers survive a broker restart mid-delivery + a DB blip, ~1-2 min
docker compose down -v
```

`step4-evidence.sh` is the Step 4 evidence: topology exists, events flow and queues drain, a booking
succeeds while RabbitMQ is stopped and its events arrive after the restart, a poison message lands in
`payments.events.dlq`, and an unpaid gateway booking is cancelled by the saga timeout (that case is
SKIPped unless the stack was started with a short `PAYMENT_TIMEOUT_SECONDS`); exit 0 = all PASS.
`SKIP_OUTAGE=1` skips the stop/start case.

`amqp-robustness-evidence.sh` checks the consumer hardening: with both service DBs paused (handlers
hang), RabbitMQ is restarted and the DBs resumed, so the handlers ack on closed channels — payments and
notifications must stay up and the events still be processed; then pay-db is stopped for a few seconds
while `booking.cancelled` arrives — it must be processed once the DB is back and nothing dead-lettered.
It pauses/stops containers itself; exit 0 = all PASS.

`step3-evidence.sh` is the Step 3 done-when evidence (forged / expired / wrong-audience tokens → 401
on both services, through the gateway); exit 0 = all PASS. Its recorded output and the rest of the
Step 3 report are in `docs/step3-security-evidence.md`. `.gitattributes` keeps `*.sh` at LF so the
script still runs from a Windows checkout.

Browse through the **gateway on :8080**. `:3000` is the monolith directly (debugging only — the
extracted routes don't exist there). Compose services: `gateway`, `edemand`, `notifications`,
`payments`, `notif-db`, `pay-db`, `keycloak` (:8081), `rabbitmq` (:5672, UI :15672), plus the `test` profile (`test`, `test-db`,
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
  `test-helpers/*`, and the three copies of the RabbitMQ topology (`lib/amqp/connection.js`,
  `services/payments/src/amqp.js`, `services/notifications/src/amqp.js` — they must stay identical).
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
  JWT**, and nginx blocks `/api/internal/` from outside. Since Step 4 events travel over RabbitMQ:
  the `/internal/events` HTTP endpoints (monolith and both services) are no longer called by any
  relay and remain only as a token-protected test / ops entry point.

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

**Keycloak (Step 3).** Compose service `keycloak` (`quay.io/keycloak/keycloak:26.0`,
`start-dev --import-realm`) imports `deploy/keycloak/edemand-realm.json` — realm `edemand`, the 7 seed
users (same `SEED_PASSWORD`), login client `web` (Direct Access Grant), audiences `edemand-api` /
`payments-api` / `notifications-api`, the confidential `edemand-backend` service account
(`manage-users`, used only by registration), and two evidence-only clients: `aud-test` (no API
audience) and `expiry-test` (same as `web`, but 60 s tokens — to show an expired real token).
**The import only happens in a fresh container:** `docker compose restart keycloak` logs
"Realm 'edemand' already exists. Import skipped", so after editing the realm JSON use
`docker compose up -d --force-recreate --wait keycloak` (or `down` / `up`). Access tokens
carry `app_id` (number — the monolith DB id of *that role's* table, so compare `(role, app_id)`) and
`role`, and live 12 h like the cookie. The issuer is pinned with `KC_HOSTNAME`, so it is
**`http://localhost:8081/realms/edemand` everywhere**, even for tokens fetched inside the network;
containers fetch JWKS from `http://keycloak:8080/realms/edemand/protocol/openid-connect/certs`.
Admin console: http://localhost:8081/admin (`admin` / `admin`). `edemand`, `payments` and
`notifications` `depends_on` it (healthy) and get `KEYCLOAK_ISSUER` / `JWKS_URL` from
`x-keycloak-env`; `edemand` also gets `KEYCLOAK_URL` (token + admin API) and the service-account
secret. Users registered at runtime live only as long as the Keycloak container (they survive a
`restart`, not a recreate) — while the monolith's rows for them vanish on *every* monolith boot, so
after an `edemand` restart such a Keycloak user is left with an `app_id` that no longer exists — or
that the next registration reuses for someone else.
Nothing is durable; recreate both together (`docker compose down` / `up`).

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
  `INTERNAL_TOKEN`, `RELAY_INTERVAL_MS`. Step 3 removed `JWT_SECRET` /
  `JWT_EXPIRES_IN` and added `KEYCLOAK_URL`, `KEYCLOAK_REALM`, `KEYCLOAK_ISSUER`, `JWKS_URL`,
  `JWT_AUDIENCE`, `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_ADMIN_CLIENT_ID`, `KEYCLOAK_ADMIN_CLIENT_SECRET`.
  Step 4 removed `EVENT_SUBSCRIBERS` (HTTP delivery is gone) and added `AMQP_URL` (all three
  processes; default `amqp://guest:guest@localhost:5672`), plus, in the monolith,
  `PAYMENT_TIMEOUT_SECONDS` (default 900) and `SWEEP_INTERVAL_MS` (default 5000) for the saga timeout.
  The RabbitMQ hardening added, to all three processes, `PUBLISH_TIMEOUT_MS` (default 5000),
  `CONSUMER_RETRIES` (default 5) and `CONSUMER_RETRY_BASE_MS` (default 500).
  Step 5 added, in the monolith, `PAYMENTS_TIMEOUT_MS` (default 2000), `PAYMENTS_MAX_RETRIES` (3),
  `PAYMENTS_BACKOFF_BASE_MS` (200) and `PAYMENTS_BACKOFF_CAP_MS` (2000) for `POST /intents`, and, in
  Payments, the fault switches `FAULT_DROP_REPLIES`, `FAULT_DELAY_REPLIES`, `FAULT_DELAY_MS` and
  `FAULT_DOWN_MS` (all default 0 = off). New integer settings use `intEnv()`: 0 is accepted, an empty or
  malformed value falls back to the default.

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
  `gateway_ref` on the order. The call (`lib/clients/payments.js#createIntent`) cuts each attempt off
  after `PAYMENTS_TIMEOUT_MS` and retries a network error, timeout or 5xx up to `PAYMENTS_MAX_RETRIES`
  times with full-jitter backoff (`backoffDelay`), always with the same `Idempotency-Key`, so a reply
  that was lost or late after the intent was written makes the retry get that intent back (200), not a
  second one; a 4xx is not retried. Only if every attempt fails is the order **cancelled again
  (compensation, `reason: "payment_unavailable"`)** — releasing its slots and emitting
  `booking.cancelled` so Payments voids any intent it did create — and the caller gets **503**
  (worst case about 4 × 2 s plus backoff).
- **Idempotency**: `withIdempotency()` (`lib/db/idempotency.js`) replays a stored `{statusCode, body}`.
  Keys are scoped to the actor (`${actor}:${key}`). Used by `POST /api/bookings`. A replay of a
  gateway booking that already has `gateway_ref` does not call Payments again.
- **Inbox dedupe (consumer side)**: every consumer inserts `processed_messages(message_id PRIMARY KEY)`
  **in the same transaction as the effect**, where `message_id = "<source>:<event id>"` (the AMQP
  `messageId`) — monolith via `lib/db/inbox.js#recordInbound` / `lib/outbox/inbound.js`, services via
  their repository. A redelivered message is a no-op and is acked.
- **Saga timeout and late payment** (Booking orchestrates): `expireUnpaidOrders()` cancels gateway
  orders that are still `payment_status = 'pending'` after `PAYMENT_TIMEOUT_SECONDS` through
  `cancelInTx(order, "system", { reason: "payment_timeout", onlyIfUnpaid: true })`; the guard re-reads
  the order **inside** the write lock so a payment that landed first wins. `applyPaymentSucceeded` on an
  already-cancelled order records it as paid and emits a second `booking.cancelled`
  (`reason: "late_payment"`) so Payments refunds; Payments' refund/void transitions are conditional, so
  repeated `booking.cancelled` is safe. The sweeper is `lib/outbox/saga.js`, started from
  `instrumentation.js`.
- **Webhook dedupe** now lives in Payments: `webhook_events.gateway_event_id UNIQUE`
  (`services/payments`). Payments emits `payment.succeeded`; **Booking** flips its own
  `orders.payment_status` (`applyPaymentSucceeded` / `applyPaymentRefunded`).
- **Intent idempotency** in Payments: `payment_intents.order_id UNIQUE`; a repeated `POST /intents`
  returns the existing intent (200) instead of creating a second (201).

### Outbox + relay + RabbitMQ (eventual consistency) — Step 4 transport

Every state change calls `insertEvent()` (`lib/db/events.js`) **inside the same transaction** as the
change. The relay is **`lib/outbox/relay.js`** (`startRelay()` from `instrumentation.js`, every
`RELAY_INTERVAL_MS`, default 1000 ms). For each unprocessed event, in id order, it **publishes** the
envelope `{ source, id, type, aggregate_type, aggregate_id, payload, occurred_at }` to the durable topic
exchange `edemand.events` on a **confirm channel** (routing key = event type, `persistent: true`,
`messageId = "<source>:<id>"`), and only after the broker confirms stamps `processed_at`. A failure stops
the pass (ordering is preserved) and the event is retried next tick — **at-least-once**; consumers
dedupe on `processed_messages`. If RabbitMQ is down, requests still succeed and events wait in the
outbox. Payments has its own `outbox` + relay (`services/payments/src/relay.js`) doing the same. The
publisher is injectable — `runRelayOnce({ publisher })` — so tests pass `fakeBroker.channel`.

**Topology** is declared by `assertTopology()` and every process runs it on start (so a message is never
published before its queue exists). It exists as **three identical copies** —
`lib/amqp/connection.js`, `services/payments/src/amqp.js`, `services/notifications/src/amqp.js` — keep
them in sync.

| Queue | Consumer | Bound routing keys |
|---|---|---|
| `payments.events` | payments | `booking.completed`, `booking.cancelled` |
| `booking.events` | monolith | `payment.succeeded`, `payment.refunded`, `review.created` |
| `notifications.events` | notifications | `booking.status_changed`, `booking.completed`, `bid.accepted`, `review.created`, `provider.approved`, `payment.succeeded`, `payment.refunded` |

All queues are **quorum queues** with `x-delivery-limit: 3`, `x-dead-letter-exchange: edemand.dlx` and a
dead-letter queue `<queue>.dlq`. Changing a queue argument makes RabbitMQ reject the declaration
(`PRECONDITION_FAILED`) — recreate the broker with `docker compose down -v` after editing the topology.

**Consumers** use `startConsumer(queue, handle, log)` (also in each `amqp.js`): `prefetch(10)`, manual
ack **after** `handle` has committed its DB transaction. Each delivery goes through `handleDelivery()`:
a throwing handler is first retried **in-process** (`CONSUMER_RETRIES` times, backoff
`CONSUMER_RETRY_BASE_MS` doubling, ~15.5 s by default) so a brief DB outage does not spend the delivery
limit; only then is it `nack`ed with requeue, and once the delivery limit is exceeded the broker moves
it to the `.dlq`. Unparseable JSON is dead-lettered at once. `ack`/`nack` on a channel that closed in the
meantime are logged, never thrown (the broker redelivers, the inbox dedupes). Losing the connection or
just the channel, or a broker-cancelled consumer, closes the connection and reconnects once after 2 s.
The relay's `publish()` fails after `PUBLISH_TIMEOUT_MS` without a confirm, and a failed publish drops
the cached publisher so the next tick reconnects — except while the broker has the connection
`blocked` (memory/disk alarm), when the channel is kept. Wiring:
monolith `lib/outbox/consumer.js` → `receiveEvent()` (`lib/outbox/inbound.js`, synchronous transaction),
Payments `src/consumer.js` → `service.handleEvent`, Notifications `src/consumer.js` →
`service.handleEvent`. Never `await` inside the monolith's SQLite transaction.

| Event | Producer | Consumers |
|---|---|---|
| `booking.status_changed`, `bid.accepted`, `provider.approved` | monolith | notifications |
| `review.created` | monolith | monolith (recomputes ratings), notifications |
| `booking.completed` | monolith | payments (wallet credit), notifications |
| `booking.cancelled` | monolith | payments (refund or void) — `reason` is `customer_cancelled`, `payment_unavailable`, `payment_timeout` or `late_payment` |
| `payment.succeeded`, `payment.refunded` | payments | monolith (mark paid / refunded), notifications |

**The rating aggregate on `services`/`provider_profiles` is recomputed by the monolith's own consumer of
`review.created`** (a handler in `lib/outbox/inbound.js`) — deliberately *not* inline in the review
handler. A fresh review leaves the aggregate stale until the event has been published and consumed. This
staleness is a tested, intentional teaching point; do not "fix" it by updating the aggregate inline.

## Tests

### Monolith

`node --test test/*.test.js`, no socket. The suite **imports the real
App Router route handlers and calls them in-process**. Conventions that matter:

- `test-helpers/boot.js` **must be the first import in every test file** — it sets
  `NODE_ENV=test` / `DB_PATH=:memory:` / the service URLs, installs the fakes, and *then*
  dynamically imports the DB layer, so the env is in place before any handler's static module graph
  (config, db) evaluates.
- **The extracted services are faked in-process** by `test-helpers/fakeServices.js`, which
  replaces `globalThis.fetch`: `POST http://payments.test/intents` is answered locally; anything else
  falls through to the real fetch. Flip `fake.paymentsDown` to exercise compensation; inspect
  `fake.intentCalls`; call `fake.reset()` between scenarios. Step 5 fault switches count down one call
  each: `fake.failNextCalls` (fails before storing), `fake.loseReplies` (stores, then the reply is lost)
  and `fake.slowReplies` (stores, then answers only after the caller's timeout). `boot.js` sets a 50 ms
  `PAYMENTS_TIMEOUT_MS` and a tiny backoff so these stay fast (`test/resilience.test.js`).
- **RabbitMQ is faked the same way** by `fakeBroker` (same file, re-exported from `boot.js`):
  `fakeBroker.channel.publish` has amqplib's confirm-channel signature, so the real relay and
  `publish()` run unchanged; `fakeBroker.down = true` simulates an outage; `fakeBroker.published` /
  `fakeBroker.queues` / `fakeBroker.dlq` show what happened; `await fakeBroker.consume(queue, handler)`
  plays the consumer loop (throw = nack + redelivery, then DLQ). `fake.reset()` resets it too.
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
- The relay is async: `await runRelayOnce({ publisher: fakeBroker.channel })` (from
  `lib/outbox/relay.js`) publishes pending events synchronously in a test instead of waiting for the
  interval, and `await fakeBroker.consume("booking.events", (e) => receiveEvent(e))` delivers them.
  `test/saga.test.js` covers the payment timeout (`expireUnpaidOrders(now)` takes a clock argument) and
  the late-payment path.
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
- The Payments relay test passes its own fake `publisher` (a `publish(exchange, key, content, options,
  cb)` object) to `runRelayOnce`; no RabbitMQ is needed for any service test.
- **Payments fault switches (Step 5)** — `src/faults.js`, driven by `GET` / `POST` / `DELETE
  /internal/faults` (internal token; not routed by the gateway) or the `FAULT_*` env at boot:
  `down_ms` answers `POST /intents` with 503 before writing; `drop_replies` commits the intent then
  destroys the socket; `delay_replies` + `delay_ms` commit it then answer late. The last two act after
  the write on purpose. `test/resilience.test.js` clears them after each subtest.
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
- **Editing `deploy/keycloak/edemand-realm.json` needs a recreated Keycloak container**, not a
  restart: `docker compose restart keycloak` keeps the old realm ("Realm 'edemand' already exists.
  Import skipped"). Use `docker compose up -d --force-recreate --wait keycloak` (or `down` / `up`).
  Tell teammates in the PR — after pulling a realm change they must recreate too.
- **RabbitMQ gotchas.** (1) Queue declarations are strict: change an argument (e.g. `x-delivery-limit`)
  and every process fails with `PRECONDITION_FAILED` until the broker is recreated
  (`docker compose down -v`). (2) Management-UI / API counters refresh about every 5 s — poll, don't
  read once (the evidence script does). (3) After a broker restart the exchange's counters start from 0.
  (4) A poison message (handler always throws) is retried in-process, then by redelivery, and then
  dead-lettered — `x-delivery-limit: 3` means 4 deliveries, so with the defaults about 4 × 15.5 s
  (~1 min); inspect `*.dlq` in the UI, nothing
  replays them automatically. (5) `lib/amqp/connection.js` is copied verbatim into
  `services/{payments,notifications}/src/amqp.js` (only the config import differs) — change all three;
  `test/amqp-copies.test.js` fails if they drift. (6) Each service's `pg.Pool` needs its `'error'`
  listener (`src/db.js`): without it a Postgres restart kills the process.
- **Migration work in scope** (per `docs/STEPS.md`): Step 2 extraction + nginx gateway, Step 3
  (Keycloak, per-service JWT verification, ownership, BOLA) and Step 4 (outbox, RabbitMQ, idempotent
  consumers, DLQ, saga) are done; the team still adds resilience — timeouts, retries, fault switches
  (Step 5), and observability — OpenTelemetry, Prometheus/Grafana, Pact (Step 6). These are **in scope** — don't refuse or
  second-guess them; follow `docs/STEPS.md` for each step's requirements and "done when" criteria.
- Still out of scope: real payment gateways, chat, cart, subscriptions, SOAP/WSDL.