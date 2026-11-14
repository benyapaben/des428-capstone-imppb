# Step 5 (Area D, Resilience): evidence

This report covers Step 5 of [`docs/STEPS.md`](STEPS.md): 5.1 resilience on the one remaining
synchronous call (`POST /intents`), 5.2 the three fault switches, and 5.3 the race on the wallet
credit. For each part it gives what was done, where it lives in the code, and the evidence: a script
run against the full Docker stack plus the automated tests.

| Part | Status | Evidence |
|---|---|---|
| 5.1 `POST /intents`: 2 s timeout, 3 retries, exponential backoff with full jitter | done | script cases 2–4, `test/resilience.test.js` |
| 5.1 Payments: a repeated `Idempotency-Key` returns the stored answer | done (already true since Step 2) | script cases 2–3, `services/payments/test/resilience.test.js` |
| 5.2 fault 1: reply cut after the write → one intent | done | script case 2 |
| 5.2 fault 2: reply slower than the timeout → one intent | done | script case 3 |
| 5.2 fault 3: Payments down longer than the retries → saga compensation | done | script case 4 |
| 5.3 race: concurrent `booking.completed` must credit the wallet once | done: broken commit, then fixed commit | §3, `services/payments/test/race.test.js`, script case 5 |

All of it is on the branch `feature/step5-resilience`. The pull request is squash-merged, so the
individual commits named below (by title, since a rebase changes their hashes) are kept in the PR's
commit list, not on `main`.

---

## 1. The evidence script

[`deploy/step5-evidence.sh`](../deploy/step5-evidence.sh) runs against the live stack, switches the
faults on and off itself, and prints one row per check (exit 0 = every row PASS). Each case books its
own slot on a random future day, so it can be re-run.

```bash
docker compose up -d --build --wait
bash deploy/step5-evidence.sh          # ~30 s
```

It reads the stack's own `PAYMENTS_TIMEOUT_MS` / `PAYMENTS_MAX_RETRIES` (fault 2 uses a delay one
second longer than the timeout), picks another day if an earlier run already used the slots, and the
race case uses a provider and customer that do not exist, so no real wallet or inbox is touched.

Recorded on the branch (2026-11-14; every run on the branch passed, five runs in all):

```
gateway http://localhost:8080   day …   POST /intents timeout 2000 ms, 3 retries

CASE                                                           RESULT DETAIL
----                                                           ------ ------
fault switch not reachable through the gateway                 PASS  /internal/faults 404, /api/internal/faults 404
baseline: gateway booking                                      PASS  201, order 8023, 1 intent
fault 1 drop: retried, intent saved exactly once               PASS  201, order 8024, 1 intent, 1 retry
fault 2 delay (reply later than the timeout): saved once       PASS  201, order 8025, 1 intent, retry after 2000 ms timeout
fault 3 down: 503 after the retries, order compensated         PASS  503 after 1s, order 8026 cancelled, 0 intents, 3 retries
fault 3 down: slot released, booked again once Payments is back PASS  201, order 8027
race 5.3: 10 copies of one booking.completed -> credited once  PASS  1 payout_credit, wallet +54570

ALL PASS
```

**The script detects the failures it checks for.** It was also run against code without the fixes:

| Images | Result |
|---|---|
| monolith from `main` (no retries, 5 s timeout) + payments from this branch | fault 1 **FAIL** (503: the lost reply is not retried, so the booking is cancelled although the intent was written); fault 2 **FAIL** (no retry: the old 5 s timeout outlasts the 3 s delay); fault 3 **FAIL** (cancelled after 0 retries) |
| payments with the broken dedupe from `Race demo (5.3), step 1: check-then-insert inbox dedupe (broken)` | race case **FAIL** in 3 of 3 runs (`2 payout_credit, wallet +109140`) |
| this branch | every case PASS |

The edemand log of the down case shows the retries and the jittered delays (from three runs):

```
"orderId":8004,"attempt":1,"delay":136,"reason":"payments service answered 503"
"orderId":8004,"attempt":2,"delay":373,"reason":"payments service answered 503"
"orderId":8004,"attempt":3,"delay":438,"reason":"payments service answered 503"
"orderId":8009,"attempt":1,"delay":100,…  "attempt":2,"delay":92,…  "attempt":3,"delay":327,…
"orderId":8014,"attempt":1,"delay":33,…   "attempt":2,"delay":249,…  "attempt":3,"delay":179,…
"orderId":8014,"err":"payments service unavailable after 4 attempts: payments service answered 503"
```

and of the drop and delay cases: `"orderId":8002,"attempt":1,"reason":"fetch failed"` and
`"orderId":8003,"attempt":1,"reason":"timeout after 2000 ms"`.

---

## 2. 5.1 and 5.2: retries on `POST /intents` and the fault switches

### The client (monolith)

[`lib/clients/payments.js`](../lib/clients/payments.js) `createIntent` (line 21) is the only
synchronous call left from the monolith to a service. Each attempt is cut off by
`AbortSignal.timeout(PAYMENTS_TIMEOUT_MS)` (line 52). A network error, a timeout, a 5xx, or a
connection that drops while the body is read is retried up to `PAYMENTS_MAX_RETRIES` times. Between
attempts it waits `backoffDelay()` (line 17): a random delay in `[0, min(cap, base × 2^attempt))`,
i.e. full jitter. A 4xx is not retried (line 62).

| Setting | Default | Meaning |
|---|---|---|
| `PAYMENTS_TIMEOUT_MS` | 2000 | per-attempt timeout |
| `PAYMENTS_MAX_RETRIES` | 3 | retries after the first attempt |
| `PAYMENTS_BACKOFF_BASE_MS` / `_CAP_MS` | 200 / 2000 | full-jitter backoff |

**Why retrying is safe.** Every attempt sends the same `Idempotency-Key`, which must equal
`order_id`, and `payment_intents.order_id` is `UNIQUE`
([`services/payments/src/schema.js`](../services/payments/src/schema.js)). A retry after a lost or
late reply therefore finds the intent the earlier attempt committed and gets it back with **200**
instead of creating a second one. 5.1 asks for "`Idempotency-Key` as the primary key"; we kept the
existing guard, `order_id UNIQUE` plus the rule that the key equals `order_id`, because it enforces
the same thing without a schema change.

When every attempt fails, Booking's existing compensation runs
([`lib/modules/booking/service.js`](../lib/modules/booking/service.js) line 244): the order is
cancelled with `reason: "payment_unavailable"`, its slots are released, `booking.cancelled` is emitted
(so Payments voids any intent it did create), and the caller gets **503**. The worst case with the
defaults is about 4 × 2 s plus backoff ≈ 9.4 s. In the down case it is about 1 s, because a 503
comes back at once.

### The fault switches (Payments)

[`services/payments/src/faults.js`](../services/payments/src/faults.js), applied by `POST /intents`
in [`services/payments/src/app.js`](../services/payments/src/app.js) (lines 73–94):

| Fault | Switch | What `POST /intents` does |
|---|---|---|
| 1 drop | `drop_replies` | commits the intent, then destroys the socket (no reply) |
| 2 delay | `delay_replies` + `delay_ms` | commits the intent, then answers `delay_ms` late |
| 3 down | `down_ms` | answers 503 **before** writing anything, for that long |

Drop and delay act **after** the write on purpose. That is the case a retry must survive: the
intent exists but the caller does not know it. The switches are set with `FAULT_*` env at boot
(`docker-compose.yml`) or at runtime through `GET` / `POST` / `DELETE /internal/faults` (lines 96–105).
That route needs the internal token, is not routed by the gateway (script case 0), and is bounded
(counts ≤ 100, `delay_ms` ≤ 60 s, `down_ms` ≤ 10 min) so it can only ever cause a limited outage. The
deliberate 503 of the down fault is logged at warn level, not as an unhandled error.

---

## 3. 5.3: the wallet credited twice

### Which race, and why

[`README.md`](../README.md) names two races (the slot double-book and the bid-accept race). Both are
already guarded correctly in the monolith, so there is nothing to show "broken, then fixed" without
tearing out a correct guard. As asked in Step 1, question (a), the team used a race that only exists
**after the split**: Payments consumes `booking.completed` from RabbitMQ, which delivers at least
once, so the same event can arrive several times at the same moment. If the dedupe is wrong, the
provider is paid more than once.

### The two commits

| Commit | Dedupe in `recordInbound` | `race.test.js` (10 concurrent deliveries), 3 runs | Payments suite |
|---|---|---|---|
| `Race demo (5.3), step 1: check-then-insert inbox dedupe (broken)` | `SELECT` the message id; if absent, `INSERT` it. `processed_messages.message_id` has no PRIMARY KEY | **credited 5×, 6×, 6×** | 33/36 |
| `Race demo (5.3), step 2: dedupe on the PRIMARY KEY in the transaction` | `INSERT … ON CONFLICT (message_id) DO NOTHING` on a PRIMARY KEY, in the same transaction as the credit | **credited 1×, 1×, 1×** | 36/36 |

Why the first one breaks: under READ COMMITTED, each delivery's transaction runs its `SELECT`
before any of the others commits, so all of them see "not processed yet", all insert, and all credit
the wallet. Why the second one holds: the uniqueness is enforced **on the write**. A racing duplicate
blocks on the first transaction's row, then inserts nothing, and the credit is skipped. The fixed
code is the same as `main`
([`services/payments/src/repository.js`](../services/payments/src/repository.js) line 114,
`schema.js` line 74); only the comments explain the guard.

Two things found on the way:

- **The first commit must drop the PRIMARY KEY too.** With the key still in place, the second
  `INSERT` waits for the first transaction and then fails with a unique violation, so the delivery is
  answered with an error instead of a double credit, and the race the task asks for never appears.
- **The race test never exercised the race.** `race.test.js` (from PR #11) passed even against the
  broken dedupe (`credited 1x`). On a cold `pg` pool the connections' handshakes finish at different
  times, so the 10 "concurrent" deliveries reached Postgres one after another. The test now calls
  `warmPool(N)` first ([`services/payments/test/helpers.js`](../services/payments/test/helpers.js)
  line 67, which throws if `N` exceeds the pool max of 10). Only then does it show 5–6× on the broken
  code. The same effect is why script case 5 first warms Payments' pool with ten no-op events (and
  waits until Postgres shows all ten processed) and pauses the payments container for a second while
  the ten copies are published. Without those two steps the live case passed even against the broken
  dedupe; with them it fails there 3 runs out of 3.

---

## 4. Related hardening from the RabbitMQ fixes (PR #13)

Step 5's theme also covers the event path. These were done in `fix/amqp-robustness` (PR #13) and are
evidenced by [`deploy/rabbitmq/amqp-robustness-evidence.sh`](../deploy/rabbitmq/amqp-robustness-evidence.sh):
`publish()` times out when the broker sends no confirm (`PUBLISH_TIMEOUT_MS`); a failing consumer
handler is retried in-process with exponential backoff before the message goes back to the broker
(`CONSUMER_RETRIES`, `CONSUMER_RETRY_BASE_MS`), so a short database outage no longer dead-letters real
events; and neither a broker restart mid-delivery nor a Postgres restart kills a service any more.
That script still passes on this branch.

## 5. Automated tests

| Suite | Result on the branch | Step 5 tests |
|---|---|---|
| monolith (`node --test test/*.test.js`, also in Docker) | 109/109 | `test/resilience.test.js`: `backoffDelay` values; fault 1, fault 2, a short outage ridden out by the retries, and an outage that outlasts them (503 + compensation) |
| payments (Docker, real Postgres) | 36/36 | `test/resilience.test.js` (each fault on `POST /intents`, ten simultaneous retries → one row), `test/faults.test.js` (switch input checks), `test/race.test.js` (5.3) |
| notifications (Docker, real Postgres) | 14/14 | — |

The fake Payments used by the monolith suite (`test-helpers/fakeServices.js`) has matching switches:
`failNextCalls`, `loseReplies` and `slowReplies`. The Step 5 tests from PR #11 had never run before
this work. They also needed one fix of their own: the subtests booked 90-minute services one hour
apart, so they collided on `slot_holds` (409) before Payments was ever called.

Each fix was checked by putting the bug back. With retries off (`PAYMENTS_MAX_RETRIES=0`), a new
`Idempotency-Key` per attempt, or the socket cut **before** the write, the matching fault tests fail.

## 6. Known limitations

- **An attempt that timed out keeps running in Payments.** If Payments is slow (more than 2 s per
  insert) on every attempt, an insert can commit after Booking has compensated and Payments has
  already handled the `booking.cancelled`, which leaves a `requires_payment` intent on a cancelled
  order.
- **No overall deadline on the retries.** The defaults give about 9.4 s at worst. A much higher
  `PAYMENTS_TIMEOUT_MS` could exceed nginx's 60 s proxy timeout.
- **No Postgres timeouts in the services.** A database that hangs without answering (rather than
  refusing connections) stalls a consumer until it answers.
- **Every consumer error gets the same in-process backoff.** A permanently bad message takes about a
  minute to reach the dead-letter queue.
- The in-process backoff makes it slightly more likely that `payment.refunded` overtakes
  `payment.succeeded` for the same order.
- Other concurrency tests in the payments suite do not warm the pool yet (only `race.test.js` does).
- The team chose the post-split race under Step 1 question (a); the instructor's answer is not
  recorded here.
