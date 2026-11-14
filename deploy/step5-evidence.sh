#!/usr/bin/env bash
# Step 5 / Area D evidence: POST /intents survives the three fault switches (STEPS.md 5.1-5.2), and a
# booking.completed delivered many times at once credits the wallet exactly once (5.3).
#
#   docker compose up -d --build --wait
#   bash deploy/step5-evidence.sh            # ~30 s
#
# Cases (each uses its own slot on a random future day, so the script can be re-run):
#   0. the fault switch is not reachable through the gateway
#   1. baseline gateway booking: 201, one payment intent
#   2. fault 1 (drop): the intent is written, the reply is cut -> the retry gets it back; still one intent
#   3. fault 2 (delay): the intent is written, the reply is later than the 2 s timeout -> same
#   4. fault 3 (down): every attempt gets 503 -> after the retries Booking compensates: 503 to the
#      caller, the order cancelled, no intent, and the slot can be booked again once Payments is back
#   5. race (5.3): 10 copies of one booking.completed published at once -> one payout_credit, and the
#      wallet grows by exactly one credit. The event names a provider and customer that do not exist,
#      so no real wallet or inbox is touched. To make the copies really race, the script first warms
#      Payments' pg pool with 10 no-op events, then pauses the payments container for ~1 s while the
#      copies are published, so its consumer (prefetch 10) handles them all at the same moment.
#      Against the broken check-then-insert dedupe (the "Race demo (5.3), step 1" commit) this case
#      failed in 3 of 3 runs (credited 2x); services/payments/test/race.test.js is the test-suite proof.
#
# Needs bash, curl, node and docker compose. Exit 0 = every row PASS, 1 = something failed.
# It switches faults on and off itself and always clears them (and unpauses payments) on exit.
set -u
cd "$(dirname "$0")/.." || exit 2

GW="${GW:-http://localhost:8080}"
KC="${KC:-http://localhost:8081}"
RMQ="${RMQ:-http://localhost:15672}"
RMQ_AUTH="${RMQ_AUTH:-guest:guest}"
USER_EMAIL="${USER_EMAIL:-nong@example.com}"      # a seeded customer
PASSWORD='eDemand-2026!'                          # SEED_PASSWORD (lib/db/seed.js)
PROVIDER_ID=1                                     # sparkle@example.com
SERVICE_ID=2                                      # 90 minutes, so the slots below are 2 h apart

FAILS=0
row()  { printf '%-62s %-5s %s\n' "$@"; }
pass() { row "$1" PASS "${2:-}"; }
fail() { row "$1" FAIL "${2:-}"; FAILS=$((FAILS + 1)); }
die()  { echo "ERROR: $*" >&2; exit 2; }

jget() {
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{let v=JSON.parse(s);for(const k of process.argv[1].split("."))v=v?.[k];console.log(v??"")}catch{console.log("")}})' "$1"
}
wait_for() {   # wait_for <seconds> <command...>
  local end=$((SECONDS + $1)); shift
  while [ "$SECONDS" -lt "$end" ]; do "$@" && return 0; sleep 2; done
  return 1
}
pay_sql() { docker compose exec -T pay-db psql -U postgres -d pay_db -tAc "$1" 2>/dev/null | tr -d '[:space:]'; }
intents() { pay_sql "SELECT count(*) FROM payment_intents WHERE order_id = $1"; }
qcount()  { curl -s --max-time 10 -u "$RMQ_AUTH" "$RMQ/api/queues/%2F/$1" | jget messages; }

# faults <GET|POST|DELETE> [json]: the switch is internal-token only and not routed by the gateway, so
# call it from inside the payments container (its image has node, not curl).
faults() {
  docker compose exec -T payments node -e '
    const [method, body] = process.argv.slice(1);
    fetch("http://localhost:4002/internal/faults", { method, body: body || undefined,
      headers: { "x-internal-token": process.env.INTERNAL_TOKEN, "content-type": "application/json" } })
      .then((r) => r.text()).then((t) => console.log(t));' "$@"
}

# edemand log lines since a timestamp (pino JSON, one object per line)
edemand_log() { docker compose logs edemand --no-color --since "$1" 2>/dev/null; }
# An edemand setting as the running container sees it (empty = unset, so lib/config.js uses its default)
edemand_env() { docker compose exec -T edemand node -e "console.log(process.env['$1'] || '')" 2>/dev/null | tr -d '\r'; }

future_date() {
  local d dow
  d="$(date -d "+$1 days" +%F 2>/dev/null || date -v+"$1"d +%F)"
  dow="$(date -d "$d" +%u 2>/dev/null || date -j -f %F "$d" +%u)"
  if [ "$dow" = 7 ]; then d="$(date -d "$d +1 day" +%F 2>/dev/null || date -j -v+1d -f %F "$d" +%F)"; fi
  echo "$d"
}

TOKEN="$(curl -s --max-time 10 -d grant_type=password -d client_id=web -d "username=$USER_EMAIL" \
  --data-urlencode "password=$PASSWORD" "$KC/realms/edemand/protocol/openid-connect/token" | jget access_token)"
[ -n "$TOKEN" ] || die "no Keycloak token for $USER_EMAIL (is the stack up at $KC?)"
docker compose version >/dev/null 2>&1 || die "docker compose not available"
[ -n "$(faults GET | jget drop_replies)" ] || die "cannot reach /internal/faults inside the payments container"
AUTH=(-H "Authorization: Bearer $TOKEN")

# book <HH:MM>: sets CODE and ORDER (empty when the response carries no order)
book() {
  local out
  out="$(curl -s --max-time 60 -w '\n%{http_code}' "${AUTH[@]}" -H 'content-type: application/json' \
    -d "{\"provider_id\":$PROVIDER_ID,\"service_date\":\"$DAY\",\"starting_time\":\"$1\",\"items\":[{\"service_id\":$SERVICE_ID,\"quantity\":1}],\"payment_method\":\"gateway\"}" \
    "$GW/api/bookings")"
  CODE="$(printf '%s' "$out" | tail -n1)"
  ORDER="$(printf '%s' "$out" | sed '$d' | jget order.id)"
}
order_status() { curl -s --max-time 10 "${AUTH[@]}" "$GW/api/bookings/$1" | jget status; }
retries_for() {   # retries_for <since> <order id>: the client's retry log lines for that order
  edemand_log "$1" | grep "\"orderId\":$2[,}]" | grep -c "POST /intents failed, retrying"
}
retry_reasons() { edemand_log "$1" | grep "\"orderId\":$2[,}]" | grep -o '"reason":"[^"]*"' | sort -u | tr '\n' ' '; }
# A log window start 60 s back: Docker Desktop's VM clock can lag the host's, and every log check
# below also filters on an order id that is new in this run, so a wider window is harmless.
since() { date -u -d '-60 seconds' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-60S +%Y-%m-%dT%H:%M:%SZ; }

cleanup() { docker compose unpause payments >/dev/null 2>&1; faults DELETE >/dev/null 2>&1; }
trap cleanup EXIT
faults DELETE >/dev/null

TIMEOUT_MS="$(edemand_env PAYMENTS_TIMEOUT_MS)"; TIMEOUT_MS="${TIMEOUT_MS:-2000}"
RETRIES="$(edemand_env PAYMENTS_MAX_RETRIES)"; RETRIES="${RETRIES:-3}"
DELAY_MS=$((TIMEOUT_MS + 1000))                   # fault 2 answers later than the client waits

DAY="$(future_date $((10 + RANDOM % 300)))"
echo "gateway $GW   day $DAY   POST /intents timeout ${TIMEOUT_MS} ms, ${RETRIES} retries"
echo
row CASE RESULT DETAIL
row ---- ------ ------

# ------------------------------------------------------------------ 0. not reachable from outside
a="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$GW/internal/faults")"
b="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$GW/api/internal/faults")"
if [ "$a" = 404 ] && [ "$b" = 404 ]; then pass "fault switch not reachable through the gateway" "/internal/faults $a, /api/internal/faults $b"
else fail "fault switch not reachable through the gateway" "/internal/faults $a, /api/internal/faults $b"; fi

# ------------------------------------------------------------------ 1. baseline
book 09:00
for _ in 1 2; do                                  # the random day was used by an earlier run: pick another
  [ "$CODE" = 409 ] || break
  DAY="$(future_date $((10 + RANDOM % 300)))"; book 09:00
done
if [ "$CODE" = 201 ] && [ "$(intents "$ORDER")" = 1 ]; then pass "baseline: gateway booking" "201, order $ORDER, 1 intent"
else fail "baseline: gateway booking" "HTTP $CODE, order ${ORDER:-?}, intents $(intents "${ORDER:-0}")"; fi

# ------------------------------------------------------------------ 2. fault 1: reply cut after the write
faults POST '{"drop_replies":1}' >/dev/null
t0="$(since)"; book 11:00
n="$(intents "${ORDER:-0}")"; r="$(retries_for "$t0" "${ORDER:-0}")"
if [ "$CODE" = 201 ] && [ "$n" = 1 ] && [ "$r" -ge 1 ]; then
  pass "fault 1 drop: retried, intent saved exactly once" "201, order $ORDER, 1 intent, $r retry"
else fail "fault 1 drop: retried, intent saved exactly once" "HTTP $CODE, order ${ORDER:-?}, intents $n, retries $r"; fi

# ------------------------------------------------------------------ 3. fault 2: reply slower than the timeout
faults POST "{\"delay_replies\":1,\"delay_ms\":$DELAY_MS}" >/dev/null
t0="$(since)"; book 13:00
n="$(intents "${ORDER:-0}")"; reasons="$(retry_reasons "$t0" "${ORDER:-0}")"
if [ "$CODE" = 201 ] && [ "$n" = 1 ] && printf '%s' "$reasons" | grep -q "timeout after ${TIMEOUT_MS} ms"; then
  pass "fault 2 delay (reply later than the timeout): saved once" "201, order $ORDER, 1 intent, retry after ${TIMEOUT_MS} ms timeout"
else fail "fault 2 delay (reply later than the timeout): saved once" "HTTP $CODE, order ${ORDER:-?}, intents $n, reasons: $reasons"; fi
last_order="${ORDER:-0}"
sleep $((DELAY_MS / 1000))                          # let the late reply of attempt 1 finish

# ------------------------------------------------------------------ 4. fault 3: down for longer than the retries
faults POST '{"down_ms":30000}' >/dev/null
t0="$(since)"; start=$SECONDS; book 15:00; took=$((SECONDS - start))
down_order="$(edemand_log "$t0" | grep "compensating by cancelling the order" | grep -o '"orderId":[0-9]*' | tail -1 | cut -d: -f2)"
[ "${down_order:-0}" -gt "$last_order" ] || down_order=""     # must be this run's order, not an older one
if [ "$CODE" != 503 ] || [ -z "$down_order" ]; then
  fail "fault 3 down: 503 after the retries, order compensated" "HTTP $CODE after ${took}s, compensated order ${down_order:-none}"
else
  status="$(order_status "$down_order")"; n="$(intents "$down_order")"; r="$(retries_for "$t0" "$down_order")"
  if [ "$status" = cancelled ] && [ "$n" = 0 ] && [ "$r" = "$RETRIES" ]; then
    pass "fault 3 down: 503 after the retries, order compensated" "503 after ${took}s, order $down_order cancelled, 0 intents, $r retries"
  else fail "fault 3 down: 503 after the retries, order compensated" "order $down_order status $status, intents $n, retries $r"; fi
fi
faults DELETE >/dev/null
book 15:00
if [ "$CODE" = 201 ]; then pass "fault 3 down: slot released, booked again once Payments is back" "201, order $ORDER"
else fail "fault 3 down: slot released, booked again once Payments is back" "HTTP $CODE"; fi

# ------------------------------------------------------------------ 5. race: one booking.completed delivered 10x at once
# Ids far above anything the monolith produces, so the dedupe key "monolith:<id>" cannot collide, and a
# provider / customer that do not exist, so no real wallet, dashboard or inbox gets made-up data.
eid=$((1900000000 + RANDOM * 1000 + RANDOM % 1000)); oid=$((1900000000 + RANDOM * 1000 + RANDOM % 1000))
race_provider=$((900000 + RANDOM)); race_customer=$((900000 + RANDOM))
earn=54570
# publish_body <event id> <type> <order id>: a management-API publish request for one envelope
publish_body() {
  node -e '
    const [eid, type, oid, earn, provider, customer] = process.argv.slice(1);
    const envelope = { source: "monolith", id: Number(eid), type, aggregate_type: "order",
      aggregate_id: Number(oid), occurred_at: new Date().toISOString(),
      payload: { order_id: Number(oid), customer_id: Number(customer), provider_id: Number(provider), payment_method: "gateway",
                 total_cents: 64200, commission_cents: 9630, provider_earnings_cents: Number(earn) } };
    console.log(JSON.stringify({ routing_key: type, payload_encoding: "string",
      properties: { delivery_mode: 2, message_id: "monolith:" + eid, content_type: "application/json" },
      payload: JSON.stringify(envelope) }));' "$1" "$2" "$3" "$earn" "$race_provider" "$race_customer"
}
publish() { curl -s -o /dev/null --max-time 10 -u "$RMQ_AUTH" -H 'content-type: application/json' -X POST \
  -d "$1" "$RMQ/api/exchanges/%2F/edemand.events/publish"; }
# Warm Payments' pg pool first with 10 distinct no-op events (booking.cancelled for an order that has
# no intent). On a cold pool the consumer's connections open at staggered times, the 10 copies would
# reach Postgres one by one, and the race would not be exercised at all.
for i in 1 2 3 4 5 6 7 8 9 10; do publish "$(publish_body $((eid - 100 + i)) booking.cancelled $((oid - 100 + i)))" & done
wait
# Checked in Postgres, not with the management API's queue counter, which can be ~5 s stale.
warm_ids="$(for i in 1 2 3 4 5 6 7 8 9 10; do printf "'monolith:%s'," $((eid - 100 + i)); done)"
warmed() { [ "$(pay_sql "SELECT count(*) FROM processed_messages WHERE message_id IN (${warm_ids%,})")" = 10 ]; }
wait_for 30 warmed || fail "race 5.3: warm-up events" "the 10 no-op events were not all consumed within 30 s"
wallet() { local b; b="$(pay_sql "SELECT balance_cents FROM provider_wallets WHERE provider_id = $race_provider")"; echo "${b:-0}"; }
before="$(wallet)"
body="$(publish_body "$eid" booking.completed "$oid")"
# Freeze the payments process while the 10 copies are published, so they all wait in front of its
# consumer (prefetch 10) and are handled at the same moment when it resumes. Published one by one
# while it runs, each copy would be fully handled before the next one even arrived.
if ! docker compose pause payments >/dev/null 2>&1; then
  fail "race 5.3: 10 copies of one booking.completed" "could not pause payments, so the copies would not race"
else
for _ in 1 2 3 4 5 6 7 8 9 10; do publish "$body" & done
wait
sleep 1
docker compose unpause payments >/dev/null 2>&1
processed() { [ "$(pay_sql "SELECT count(*) FROM processed_messages WHERE message_id = 'monolith:$eid'")" -ge 1 ]; }
drained() { [ "$(qcount payments.events)" = 0 ]; }
if ! wait_for 60 processed; then
  fail "race 5.3: 10 copies of one booking.completed" "not consumed within 60 s"
else
  sleep 6                                            # the management API's counter refreshes about every 5 s
  wait_for 30 drained                                # then every copy has been handled (duplicates are no-ops)
  credits="$(pay_sql "SELECT count(*) FROM transactions WHERE order_id = $oid AND kind = 'payout_credit'")"
  after="$(wallet)"
  if [ "$credits" = 1 ] && [ $((after - before)) = "$earn" ]; then
    pass "race 5.3: 10 copies of one booking.completed -> credited once" "1 payout_credit, wallet +$((after - before))"
  else fail "race 5.3: 10 copies of one booking.completed -> credited once" "$credits payout_credit, wallet +$((after - before)) (one credit = $earn)"; fi
fi
fi

echo
if [ "$FAILS" = 0 ]; then echo "ALL PASS"; exit 0; else echo "$FAILS FAILED"; exit 1; fi
