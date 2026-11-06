# Bangkok Homeservice — a home-services marketplace monolith

> Formerly **eDemand**. Only the course-facing name changed: inside the code the service, the
> database file, the seed logins and the password below still say `edemand` / `eDemand`.

A production-grade, **self-contained full-stack Next.js monolith** for the DES428 course
(*Web Services and Service Architecture*). One process, one SQLite file, UI + API together. It is
the sibling of `bangkok-ride`: same production bar (typed errors, zod validation, JWT auth, pino
logging, idempotency, atomic conditional writes, real transactions, an outbox, deterministic
reseed, `node:test` rigor) — but a **multi-vendor on-demand services marketplace** (cleaning,
repair, beauty, appliance) instead of ride-hailing.

Students run this as a monolith, feel where it strains, and use it as the system they migrate
toward microservices. The bounded-context boundaries below **are** the future service seams.

---

## Step 2 — Area A: Notifications + Payments extracted, behind a gateway

```
Browser / curl ──▶ nginx gateway :8080
                     ├─ = /api/notifications, ^~ /api/notifications/ ───────────▶ notifications svc :4001 (Express, Postgres notif_db)
                     ├─ ^~ /api/payments/, = /api/provider/wallet,
                     │  = /api/customer/transactions ───────────────────────────▶ payments svc :4002 (Express, Postgres pay_db + outbox)
                     ├─ ^~ /api/internal/  → 404 (service-to-service only)
                     └─ everything else ─────────────────────────────────────────▶ monolith :3000 (Next.js, SQLite + events outbox)
```

The gateway forwards `X-Request-Id` (minting one if absent) and `traceparent`; every service echoes
and logs them, and the monolith passes them on when it calls Payments or renders a page that reads a
service.

**What moved**

| | Before (monolith) | After |
|---|---|---|
| `notifications` table | SQLite | `notif_db` (notifications svc) |
| `payment_intents` (+ new `customer_id`, `provider_id`), `transactions`, `provider_wallets`, `webhook_events` | SQLite | `pay_db` (payments svc) |
| place gateway booking | intent inserted in the booking tx | booking tx commits, then **sync** `POST /intents` (`Idempotency-Key = order_id`); `gateway_ref` copied onto `orders`. Payments down ⇒ order cancelled again (compensation) + 503 |
| `GET /api/bookings/:id` | read `payment_intents` | reads its own copy (`orders.gateway_ref`, `orders.payment_status`) |
| complete booking | wallet credit inside the OTP-gated tx | OTP-gated `UPDATE` kept; emits `booking.completed`; **Payments** credits the wallet (upserting it on first credit) |
| cancel booking | refund inserted inline | emits `booking.cancelled`; Payments refunds (→ `payment.refunded`) or voids an unpaid intent |
| webhook | Payments wrote `orders.payment_status` | Payments emits `payment.succeeded`; **Booking** marks its own order paid |
| provider approval | inserted a notification | writes `provider.approved` to the outbox |
| provider register | created a wallet row | no wallet (removed `insertProviderWallet`) |
| `/notifications`, `/provider/wallet`, `/provider/dashboard` pages | in-process service calls | HTTP to the service, cookie forwarded as `Bearer`, `cache: 'no-store'` |

**Event transport (Step 2, until RabbitMQ in Step 4).** Each side keeps an outbox (`events` in
SQLite, `outbox` in pay_db). A relay POSTs every event, in order, to each subscriber's
`/internal/events` (monolith: `/api/internal/events`) with the shared `INTERNAL_TOKEN`, and marks it
processed only after every subscriber answered 2xx — at-least-once. Each consumer records
`(source, id)` in an inbox table in the same transaction as the effect, so it is applied exactly once.

| Event | Producer | Consumers |
|---|---|---|
| `booking.status_changed`, `bid.accepted`, `review.created`, `provider.approved` | monolith | notifications (`review.created` also recomputes ratings locally) |
| `booking.completed` | monolith | payments (wallet credit / commission owed), notifications |
| `booking.cancelled` | monolith | payments (refund or void) |
| `payment.succeeded`, `payment.refunded` | payments | monolith (Booking: mark paid / refunded), notifications |

**Run it**

```bash
docker compose up -d --build --wait            # http://localhost:8080 — every old URL still works
docker compose --profile test run --rm test                 # monolith suite (in-memory; services faked)
docker compose --profile test run --rm notifications-test   # real Postgres (test-db)
docker compose --profile test run --rm payments-test
docker compose down -v
```

Without Docker: run Postgres locally, then `npm test` in the repo root, and
`DATABASE_URL=postgres://… npm test` in `services/notifications` and `services/payments`.

**Done-check:** `grep -rE "payment_intents|transactions|provider_wallets|webhook_events|notifications" lib/modules`
prints nothing, and `test/schema-split.test.js` asserts those tables are gone from the SQLite schema.

---

## What it is

- **One deployable.** Next.js 14 App Router. UI pages are Server Components that call the service
  layer **directly, in-process** (the honest monolith read path). Mutations POST to **route
  handlers** under `app/api/**`. The same code, one `node server.js`.
- **One database.** `better-sqlite3`, one file `data/edemand.db` (`:memory:` under test). WAL,
  `foreign_keys=ON`. Dropped, migrated and **reseeded on every boot** — a fresh `docker compose up`
  is always identical. `sqlite_sequence` for `orders` is primed to 8000, so the **first booking on a
  fresh boot is always id 8001**.
- **Layered.** `route handler → service → repository → db`. No SQL outside repositories; no business
  logic in route files. Every route is zod-validated, typed-error-mapped, JWT+role-gated where
  required, and request-id + pino logged.

### Run it

```bash
npm install
npm run dev            # http://localhost:3000  (dev)
# or
npm run build && npm start
npm test               # node --test, in-memory DB, no server needed

# Docker
docker compose up -d --wait edemand      # boots healthy on :3000 (fresh DB, first booking 8001)
docker compose run --rm test             # runs the suite in-memory
docker compose down -v
```

**Seed logins** (password for all: `eDemand-2026!`):
`nong@example.com` / `somchai@example.com` / `aom@example.com` (customers),
`sparkle@example.com` / `fixit@example.com` (approved providers), `glow@example.com` (pending),
`admin@edemand.test` (admin).

---

## The eight bounded contexts

Each context **owns its tables** — that ownership is the seam. Nothing reads another context's
tables through its own repository; it goes through the owning context's service/repository.

| # | Context | Owns (tables) | Responsibility |
|---|---------|---------------|----------------|
| 1 | **Identity** | `customers`, `providers`, `admins` | Registration, login (bcrypt), JWT issuance, `/me`. |
| 2 | **Catalog** | `categories`, `services` | Provider-owned services, browse/search, rating aggregate (recomputed by the relay). |
| 3 | **Provider Profile** | `provider_profiles`, `provider_timings` | Approval, commission, 30-min weekly availability. |
| 4 | **Booking** | `orders`, `order_items`, `slot_holds`, `addresses` | The place-booking transaction, the status machine, OTP-gated completion, slots. |
| 5 | **Bidding** | `job_requests`, `bids` | Custom jobs + provider bids; the bid-accept race that spins up a booking. |
| 6 | **Payments & Wallet** | `payment_intents`, `transactions`, `provider_wallets`, `webhook_events` | Gateway intents, the idempotent webhook, the commission split. |
| 7 | **Reviews** | `reviews` | One review per completed booking; emits `review.created`. |
| 8 | **Notifications** | `notifications` + the **outbox relay** | Drains the shared `events` table, recomputes aggregates, writes notifications. |

Shared infra (under `lib/db`, not a context): `events` (the outbox) and `idempotency_keys`.

Directory shape:

```
app/                 UI pages ((customer) (provider) (admin) groups) + api/** route handlers
lib/
  config.js logger.js errors.js
  http/              handle, respond, auth, validate, pagination, requestId, session
  db/                index, schema, migrate, seed, bootstrap, idempotency, events
  modules/<context>/ repository.js + service.js  (+ booking/slots.js, booking/availability.js,
                                                   payments/gateway.js, notifications/relay.js)
test/ test-helpers/  node:test suite driving the real route handlers in-process
```

---

## Seam analysis — what extracts first, and why

The boundaries are drawn so a context can be lifted into its own service with a known, small set of
cross-context calls to replace with network calls. Ranked by *how cleanly it detaches today*:

1. **Notifications (extract first).** It already behaves like a separate service: it consumes the
   `events` outbox and only ever **writes** its own `notifications` table. Nothing calls into it
   synchronously on a request's hot path. Swap the in-process relay for a broker consumer (SQS/Kafka)
   and the monolith doesn't notice. Lowest-risk, highest-teaching-value first cut.
2. **Payments & Wallet (extract second).** The webhook is already an async, idempotent,
   secret-authenticated boundary — exactly what a payments service exposes. Its one inward coupling is
   writing `orders.payment_status='paid'` at settlement (a Booking-owned column). That single
   cross-context write becomes a `booking.mark_paid` call or a `payment.succeeded` event Booking
   subscribes to. Clear seam, one wire to cut.
3. **Catalog / Provider Profile (extract together).** Read-heavy, mostly independent. The catch is
   the rating aggregate on `services`/`provider_profiles` is recomputed by the **relay** on
   `review.created` — so extraction means Catalog subscribes to that event instead of sharing the
   table. The outbox already models this dependency, which is the point.
4. **Booking + Bidding (extract last / together).** The hardest, because they share the physical
   double-book guard: **both** the place-booking path and the bid-accept path insert into
   `slot_holds` (the `UNIQUE(provider_id, service_date, slot_time)` index). In one database that
   uniqueness is free; split them and the availability/slot-hold invariant becomes a distributed
   concurrency problem (a reservation service, or sagas). Extract these last, and only once you have a
   deliberate answer for cross-service slot reservation. Identity is a shared dependency of everything
   and is best pulled out early as an IdP, but it has no owned business logic worth arguing about.

### Seam choice for this migration

We follow the ranking above: **Notifications first, then Payments & Wallet** (both done in Step 2),
with Identity moving to an external IdP in Step 3. The course overview (`docs/README.md`) lists
"Providers / Booking" as this case study's first seam; we deliberately did not start there, because
Booking and Bidding share the `slot_holds` double-book guard, which turns into a distributed
reservation problem the moment they are split (see *Known monolith pains*). Provider Profile is the
natural next candidate (rank 3) if the team extracts a third service.

---

## The teaching hooks (all real, all tested)

Each is a genuine mechanism, not a stub, and each has a test proving it.

- **Place-booking = ONE transaction** (`booking/service.js#placeBooking`, `test/booking.test.js`).
  Order + items + `slot_holds` + optional payment intent + outbox event commit or roll back as a
  single `BEGIN IMMEDIATE` transaction. A slot clash leaves **zero** partial rows.
- **Slot double-book guard** — `UNIQUE(provider_id, service_date, slot_time)` on `slot_holds`. Two
  concurrent bookings for the same slot ⇒ **one 201, one 409** (`slot no longer available`). The
  read-side `get_available_slots` is advisory; the *write* is what makes a double-book physically
  impossible. (Contrast: the real product does an unguarded read-then-insert — two customers both pass.)
- **Bid-accept race** (`bidding/service.js#acceptBid`). `UPDATE job_requests SET status='booked'
  WHERE status='open'` then `UPDATE bids SET status='accepted' WHERE status='pending'` — both
  conditional. Two concurrent accepts ⇒ exactly one winner; accept-vs-withdraw ⇒ exactly one succeeds.
  No read-then-write gap.
- **OTP-gated completion** (`booking/service.js#completeBooking`). The provider closes a job only by
  entering the **6-digit OTP the customer holds** (proof of presence). The wallet credit lives inside
  the `UPDATE ... WHERE status='started' AND otp=?` — so a replay (or a second provider) matches zero
  rows and **the balance is credited exactly once**. Commission split: gateway → provider balance;
  COD → commission owed to the platform (`total*pct/100`).
- **Payment-webhook idempotency** (`payments/service.js#handleWebhook`). The gateway's
  `gateway_event_id` is the dedupe key (`webhook_events.gateway_event_id UNIQUE`). A replayed callback
  short-circuits and credits nothing twice. (Contrast: the real product has no idempotency and
  double-processes retries.)
- **Outbox + relay** (`db/events.js`, `notifications/relay.js`). Every state change writes an `events`
  row **in the same transaction**. A relay drains it (`setInterval` in `instrumentation.js`, or
  `runRelayOnce()` in tests), claiming each event via `processed_at` so it applies **exactly once**.
- **Eventual consistency of ratings.** The service/provider rating aggregate is recomputed **in the
  relay**, driven by `review.created` — *not inline* in the review handler. So a fresh review leaves
  the aggregate momentarily stale until the relay runs. This is the deliberate contrast with Ride
  (which updates the aggregate inline) and the whole reason the outbox exists here.
- **Idempotency-Key** (`db/idempotency.js`). `POST /api/bookings` replays the stored `{status, body}`
  for a repeated key; the `idempotency_keys.key` PRIMARY KEY makes two racing writes on one key
  impossible.

---

## Known monolith pains (deliberately left in — this is the migration target)

- **One database, shared by all eight contexts.** Cross-context writes are just function calls
  (Payments writes `orders.payment_status`; the relay writes `services.rating_avg`). Cheap and atomic
  now; each one becomes a network call + a consistency decision after extraction.
- **The relay is in-process.** `setInterval(runRelayOnce, 1000)` shares the connection and dies with
  the process. Real deployments need a durable broker + at-least-once delivery + a dead-letter path.
  The `events` table + `processed_at` claim is the seam that makes swapping it in mechanical.
- **Shared deploy + blast radius.** A migration, a slow query, or a crash in any context stops all of
  them. There is no independent scaling: the read-heavy Catalog scales with the write-heavy Booking.
- **`slot_holds` is a single-DB invariant.** The strongest coupling. It is free in one SQLite file and
  becomes distributed reservation the moment Booking and Bidding live apart — which is exactly why
  they are the *last* thing to split.
- **Auth secret is process-local.** Fine for one process; an extracted fleet needs a shared IdP /
  JWKS. Not built here (out of scope) — the shape is left obvious.

Out of scope by design (course adds later): API gateway, external IdP, broker, tracing/metrics, real
gateways, service extraction, chat, cart, subscriptions. `SOAP`/`WSDL` appear nowhere.

---

## Tests

`node --test`, no socket — the suite imports the real App Router route handlers and drives them
in-process against per-file in-memory databases; the two extracted services are faked in-process
(`test-helpers/fakeServices.js`). 66 tests across:

`health` · `identity` (auth, 401/403/400/409) · `catalog` (pagination, ownership) · `booking`
(id 8001, the slot double-book race, idempotency, the full status machine, OTP-gated complete +
exactly-once `booking.completed`, cancel, reschedule) · `slots` · `bidding` (accept race,
accept-vs-withdraw) · `payments-integration` (POST /intents with Idempotency-Key = order_id, the
order's payment copy, compensation when Payments is down, inbound `payment.succeeded` /
`payment.refunded` deduped) · `reviews-outbox` (stale-then-relay-recomputed, delivery retried on
subscriber outage, relay idempotent) · `schema-split` · `admin`.

Each service has its own suite against a real Postgres: `services/notifications` (12 tests: auth,
cookie auth, inbox dedupe, every event → message mapping) and `services/payments` (20 tests: intent
idempotency + race, webhook replay + race, simulate auth, exactly-once wallet credit under concurrent
redelivery, refund/void on cancel, relay ordering + retry against a live HTTP subscriber).
