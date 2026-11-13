# Step 4 (Area C, Outbox, RabbitMQ and saga): evidence

This report covers Step 4 of [`docs/STEPS.md`](STEPS.md): 4.1 outbox and relay, 4.2 idempotent consumers,
4.3 events between services, 4.4 the orchestrated saga, and 4.5 the dead-letter queue. For each part it
gives what was done, where it lives in the code, and the evidence. That evidence is the automated tests,
a run of [`deploy/rabbitmq/step4-evidence.sh`](../deploy/rabbitmq/step4-evidence.sh) against the real
stack, and a manual outage run.

| Part | Status | Commit / PR |
|---|---|---|
| 4.1 outbox + relay with publisher confirms | done | `4518aa5` |
| 4.2 every consumer idempotent (`processed_messages`) | done | `4518aa5` |
| 4.3 events between services over RabbitMQ | done | `4518aa5` |
| 4.4 saga orchestrated by Booking (timeout, late payment) | done | `4518aa5` |
| 4.5 dead-letter queue per consumer queue | done | `4518aa5` |
| Test fixes after the merge (test helper, saga test isolation, stale config) | done | #12 |
| Hardening: in-process retries, closed-channel ack/nack, publish timeout, reconnects | done | #13 |

---

## 1. The evidence script, on the latest `main`

The script checks the topology, a normal event flow, a RabbitMQ outage, a poison message and the saga's
payment timeout, all through the gateway on `:8080` and the RabbitMQ management API on `:15672`. It needs
bash, curl, node and `docker compose`. Exit code 0 means every row passed.

```bash
docker compose down -v
PAYMENT_TIMEOUT_SECONDS=30 docker compose up -d --build --wait
PAYMENT_TIMEOUT_SECONDS=30 bash deploy/rabbitmq/step4-evidence.sh     # about 2-3 minutes
```

`PAYMENT_TIMEOUT_SECONDS=30` shortens the saga's payment timeout from 15 minutes so the timeout case can
run; without it that row is skipped.

The run below was recorded on 2026-11-14 from a fresh clone of `main` at `3de725e` (after #12 and #13),
on Windows through Git Bash. It is unedited.

```text
gateway  http://localhost:8080
rabbitmq http://localhost:15672   user nong@example.com   payment timeout 30s

CASE                                                 RESULT DETAIL
----                                                 ------ ------
topology: exchange, 3 queues, 3 DLQs exist           PASS
normal flow: events published, all queues drained    PASS  published +1
outage: booking OK while down; events published after restart PASS  published 1 message(s)
DLQ: poison message dead-lettered, queue not blocked PASS  payments.events.dlq = 1
saga: unpaid booking cancelled after the timeout     PASS  order 8003, 30s
saga: released slot can be booked again              PASS

ALL PASS
```

What each row does:

| Row | How |
|---|---|
| topology | Reads the management API: exchange `edemand.events`, the three queues and their `.dlq` queues exist. |
| normal flow | Places a COD booking, then waits until the exchange's publish counter rises and every queue is back to 0. |
| outage | `docker compose stop rabbitmq`, places a booking (it must still get 201), starts RabbitMQ again, then waits until the event that waited in the outbox is published and consumed. |
| DLQ | Publishes a `booking.completed` with no payload straight to the exchange. The Payments handler throws on it every time, so it must end in `payments.events.dlq` while the queue keeps draining. |
| saga timeout | Places an unpaid gateway booking and waits until the sweeper cancels it (`reason: payment_timeout`). |
| slot released | Books the same slot again; it must get 201. |

## 2. A consumer that is down loses nothing and doubles nothing

This run was done by hand on 2026-11-12 (before #13). Payments, the consumer of `payments.events`, was
stopped while two bookings were completed, then started again.

```text
$ date +%T; docker compose stop payments
02:19:28
 ✔ Container edemand-payments-1  Stopped

$ docker compose exec rabbitmq rabbitmqctl list_queues name messages
notifications.events.dlq   0
notifications.events       0
payments.events            2      <- two booking.completed events waiting for Payments
booking.events.dlq         0
payments.events.dlq        0
booking.events             0

$ docker compose start payments; date +%T
 ✔ Container edemand-payments-1  Started
02:22:09                          <- Payments was down for about 160 s

$ docker compose exec rabbitmq rabbitmqctl list_queues name messages
payments.events            0      <- drained once Payments was back (other queues still 0)

$ docker compose exec pay-db psql -U postgres -d pay_db \
    -c "select order_id, count(*) from transactions where kind='payout_credit' group by 1 order by 1;"
 order_id | count
----------+-------
     8001 |     1
     8002 |     1

$ docker compose exec pay-db psql -U postgres -d pay_db \
    -c "select provider_id, balance_cents from provider_wallets order by 1;"
 provider_id | balance_cents
-------------+---------------
           1 |        218280
           2 |             0
           3 |             0
```

Each completed booking credited the provider's wallet exactly once, after a 160 s outage of the consumer.
Notifications kept consuming its own queue the whole time. Under the Step 2 HTTP relay, one subscriber
down stopped the relay's pass for every subscriber.

---

## 3. What was built (4.1 to 4.5)

### 4.1 Outbox and relay

Every state change writes its event to its own outbox **in the same transaction**: the monolith's `events`
table, and Payments' `outbox` table. The relay (`lib/outbox/relay.js`, `services/payments/src/relay.js`)
reads unprocessed rows in id order, publishes each on a **confirm channel** (`persistent: true`,
`messageId = "<source>:<event id>"`), and marks the row processed **only after the broker confirms**. The
first failure stops the pass, so order is kept and nothing is marked sent that the broker did not accept.
If RabbitMQ is down, requests still succeed and events wait in the outbox (row "outage" above).

Since #13 a publish with no confirm after `PUBLISH_TIMEOUT_MS` (5 s) fails instead of hanging, and the
relay drops its cached publisher after a failed publish, so the next tick reconnects.

### 4.2 Idempotent consumers

Each consumer reads its own durable queue with manual ack. The handler runs **one transaction** that
inserts `processed_messages(message_id PRIMARY KEY)` **and** applies the effect; a redelivered message hits
the primary key, is a no-op, and is acked. The table exists in all three databases (SQLite in the monolith,
`pay_db`, `notif_db`).

### 4.3 Events between services

| Queue | Consumer | Routing keys |
|---|---|---|
| `payments.events` | Payments | `booking.completed`, `booking.cancelled` |
| `booking.events` | monolith (Booking, plus the rating aggregate) | `payment.succeeded`, `payment.refunded`, `review.created` |
| `notifications.events` | Notifications | `booking.status_changed`, `booking.completed`, `bid.accepted`, `review.created`, `provider.approved`, `payment.succeeded`, `payment.refunded` |

The exchange is `edemand.events` (topic); the routing key is the event type. Every process asserts the whole
topology on start-up (`assertTopology` in `lib/amqp/connection.js` and each service's `src/amqp.js`).

### 4.4 Saga (Booking orchestrates)

| Step | Action | Compensation |
|---|---|---|
| 1 | create the order and its `slot_holds` (one transaction) | cancel the order, release the slots |
| 2 | Payments `POST /intents` (sync, `Idempotency-Key = order_id`) | Payments down: order cancelled, slots released, 503 |
| 3 | `payment.succeeded` marks the order paid | `booking.cancelled` makes Payments refund or void |
| timeout | not paid within `PAYMENT_TIMEOUT_SECONDS` (default 900): the sweeper (`lib/outbox/saga.js`) cancels the order and emits `booking.cancelled` with `reason: payment_timeout` | cancel, release the slots, void the intent |
| late payment | `payment.succeeded` after the cancel: Booking records it as paid and emits `booking.cancelled` with `reason: late_payment` | Payments refunds; the order ends `refunded` |

The timeout fires only while `payment_status = 'pending'`, and the guard re-reads the order inside the
write lock, so a payment that lands first always wins. Payments' refund and void are conditional updates,
so a repeated `booking.cancelled` is harmless.

### 4.5 Dead-letter queue

All three queues are quorum queues with `x-delivery-limit: 3` and `x-dead-letter-exchange: edemand.dlx`;
each has a `<queue>.dlq`. Since #13 a failing handler is first **retried in-process** with exponential
backoff (`CONSUMER_RETRIES` = 5, `CONSUMER_RETRY_BASE_MS` = 500, about 15.5 s per delivery) before the
message is nacked back to the broker, so a database blip of a few seconds no longer dead-letters real
events. A message that keeps failing reaches the DLQ after the broker's delivery limit, about a minute with
the defaults. A message whose body is not valid JSON is dead-lettered at once.

The number of in-process attempts is read from the code and from `test/amqp.test.js`; the script checks
that the poison message ends in the DLQ and that the queue is not blocked, but it does not count attempts.

---

## 4. Automated tests

Run with `node --test` on `main` at `3de725e` (2026-11-14): **30 tests, 30 pass** in the four Area C
files below. The monolith suite as a whole is 104 tests with 103 passing; the one failure is
`test/resilience.test.js`, which belongs to Step 5 (Area D) and is waiting for its retry client.

| File | What it covers |
|---|---|
| `test/saga.test.js` | an unpaid gateway booking is cancelled after the timeout (slots released, Payments told to void); a paid booking is never expired; a late payment after a cancel is recorded as paid, refunded once, and a redelivery is a no-op |
| `test/reviews-outbox.test.js` | a broker outage leaves events unprocessed, in order; the relay publishes every event and the consumer recomputes the rating; a second relay pass publishes nothing; a duplicate `review.created` is processed once |
| `test/amqp.test.js` | 17 failure cases from #13: retry with backoff then ack, nack after the last retry, unparseable JSON dead-lettered at once, ack/nack on a closed channel, a publish with no confirm, publisher and consumer reconnects |
| `test/amqp-copies.test.js` | the three copies of the RabbitMQ code (monolith, payments, notifications) stay identical |

The service suites (`services/payments`, `services/notifications`) need Postgres and run in Docker:

```bash
docker compose --profile test run --rm --build payments-test
docker compose --profile test run --rm --build notifications-test
```

They were not re-run for this report.
