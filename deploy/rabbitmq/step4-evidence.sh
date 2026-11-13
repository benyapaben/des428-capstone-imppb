#!/usr/bin/env bash
# Step 4 / Area C evidence: RabbitMQ topology, events flowing, survival of a broker outage,
# a poison message ending in the dead-letter queue, and the saga's payment timeout.
#
#   PAYMENT_TIMEOUT_SECONDS=30 docker compose up -d --build --wait
#   PAYMENT_TIMEOUT_SECONDS=30 bash deploy/rabbitmq/step4-evidence.sh      # ~2-3 minutes
#
# Needs bash, curl, node (any version that runs the repo), and docker compose for the outage case.
# Exit code 0 = every row PASS (SKIP rows are listed but are not failures), 1 = something failed.
# Switches:  SKIP_OUTAGE=1  skips the stop/start-RabbitMQ case.
# Management-API counters refresh about every 5 s, so every check polls instead of reading once.
set -u
cd "$(dirname "$0")/../.." || exit 2

GW="${GW:-http://localhost:8080}"
KC="${KC:-http://localhost:8081}"
RMQ="${RMQ:-http://localhost:15672}"
RMQ_AUTH="${RMQ_AUTH:-guest:guest}"
TOKEN_URL="$KC/realms/edemand/protocol/openid-connect/token"
USER_EMAIL="${USER_EMAIL:-nong@example.com}"      # a seeded customer
PASSWORD='eDemand-2026!'                          # SEED_PASSWORD (lib/db/seed.js)
PROVIDER_ID="${PROVIDER_ID:-1}"                   # sparkle@example.com
SERVICE_ID="${SERVICE_ID:-2}"
SKIP_OUTAGE="${SKIP_OUTAGE:-0}"
TIMEOUT="${PAYMENT_TIMEOUT_SECONDS:-900}"         # must match the value the stack was started with
QUEUES="payments.events booking.events notifications.events"

FAILS=0
SKIPS=0
CREATED=()          # order ids this run created; cancelled again at the end so the script is repeatable

row()  { printf '%-52s %-5s %s\n' "$@"; }
pass() { row "$1" PASS "${2:-}"; }
fail() { row "$1" FAIL "${2:-}"; FAILS=$((FAILS + 1)); }
skip() { row "$1" SKIP "${2:-}"; SKIPS=$((SKIPS + 1)); }
die()  { echo "ERROR: $*" >&2; exit 2; }

# jget <dotted.path>: reads JSON on stdin, prints the value (empty if missing or not JSON)
jget() {
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{let v=JSON.parse(s);for(const k of process.argv[1].split("."))v=v?.[k];console.log(v??"")}catch{console.log("")}})' "$1"
}

rmq()       { curl -s --max-time 10 -u "$RMQ_AUTH" "$@"; }
rmq_up()    { curl -sf --max-time 5 -u "$RMQ_AUTH" "$RMQ/api/overview" >/dev/null; }
qcount()    { rmq "$RMQ/api/queues/%2F/$1" | jget messages; }          # ready + unacked; empty if the queue is missing
published() { local p; p="$(rmq "$RMQ/api/exchanges/%2F/edemand.events" | jget message_stats.publish_in)"; echo "${p:-0}"; }
drained()   { local q; for q in $QUEUES; do [ "$(qcount "$q")" = 0 ] || return 1; done; }

wait_for() {   # wait_for <seconds> <command...>: polls every 2 s until the command succeeds
  local end=$((SECONDS + $1)); shift
  while [ "$SECONDS" -lt "$end" ]; do
    "$@" && return 0
    sleep 2
  done
  return 1
}

# a non-Sunday date N days ahead (GNU date, or macOS/BSD date)
future_date() {
  local d dow
  d="$(date -d "+$1 days" +%F 2>/dev/null || date -v+"$1"d +%F)"
  dow="$(date -d "$d" +%u 2>/dev/null || date -j -f %F "$d" +%u)"
  if [ "$dow" = 7 ]; then d="$(date -d "$d +1 day" +%F 2>/dev/null || date -j -v+1d -f %F "$d" +%F)"; fi
  echo "$d"
}

TOKEN="$(curl -s --max-time 10 -d grant_type=password -d client_id=web -d "username=$USER_EMAIL" \
  --data-urlencode "password=$PASSWORD" "$TOKEN_URL" | jget access_token)"
[ -n "$TOKEN" ] || die "no Keycloak token for $USER_EMAIL (is the stack up at $KC?)"
rmq_up || die "RabbitMQ management API not reachable at $RMQ"

AUTH=(-H "Authorization: Bearer $TOKEN")

# book <date> <HH:MM> <cod|gateway>: sets BOOK_CODE and BOOK_ID
book() {
  local out
  out="$(curl -s --max-time 25 -w '\n%{http_code}' "${AUTH[@]}" -H 'content-type: application/json' \
    -d "{\"provider_id\":$PROVIDER_ID,\"service_date\":\"$1\",\"starting_time\":\"$2\",\"items\":[{\"service_id\":$SERVICE_ID,\"quantity\":1}],\"payment_method\":\"$3\"}" \
    "$GW/api/bookings")"
  BOOK_CODE="$(printf '%s' "$out" | tail -n1)"
  BOOK_ID="$(printf '%s' "$out" | sed '$d' | jget order.id)"
  [ -n "$BOOK_ID" ] && [ "$BOOK_CODE" = 201 ] && CREATED+=("$BOOK_ID")
}

order_status() {
  local body s
  body="$(curl -s --max-time 10 "${AUTH[@]}" "$GW/api/bookings/$1")"
  s="$(printf '%s' "$body" | jget status)"
  [ -n "$s" ] || s="$(printf '%s' "$body" | jget order.status)"
  echo "$s"
}

cleanup() {
  local id
  for id in ${CREATED[@]+"${CREATED[@]}"}; do
    curl -s -o /dev/null --max-time 10 -X POST "${AUTH[@]}" "$GW/api/bookings/$id/cancel"
  done
}
trap cleanup EXIT

BASE=$((10 + RANDOM % 30))      # random day offset so re-runs rarely meet their own leftovers
DAY="$(future_date "$BASE")"    # one day for every case; each case uses its own time slot

echo "gateway  $GW"
echo "rabbitmq $RMQ   user $USER_EMAIL   payment timeout ${TIMEOUT}s"
echo
row CASE RESULT DETAIL
row ---- ------ ------

# ------------------------------------------------------------------ 1. topology
missing=""
rmq "$RMQ/api/exchanges/%2F/edemand.events" | jget name | grep -qx 'edemand.events' || missing="$missing exchange:edemand.events"
for q in $QUEUES; do
  [ -n "$(qcount "$q")" ]     || missing="$missing $q"
  [ -n "$(qcount "$q.dlq")" ] || missing="$missing $q.dlq"
done
if [ -z "$missing" ]; then pass "topology: exchange, 3 queues, 3 DLQs exist"; else fail "topology" "missing:$missing"; fi

# ------------------------------------------------------------------ 2. events flow and are consumed
p0="$(published)"
book "$DAY" 09:00 cod
if [ "$BOOK_CODE" != 201 ]; then
  fail "normal flow: place a COD booking" "got HTTP $BOOK_CODE (expected 201)"
else
  published_more() { [ "$(published)" -gt "$p0" ]; }
  if wait_for 40 published_more && wait_for 40 drained; then
    pass "normal flow: events published, all queues drained" "published +$(( $(published) - p0 ))"
  else
    fail "normal flow" "events not published or queues not drained within 40 s"
  fi
fi

# ------------------------------------------------------------------ 3. broker outage
if [ "$SKIP_OUTAGE" = 1 ]; then
  skip "outage: booking survives RabbitMQ down" "SKIP_OUTAGE=1"
elif ! docker compose version >/dev/null 2>&1; then
  skip "outage: booking survives RabbitMQ down" "docker compose not available"
else
  docker compose stop rabbitmq >/dev/null 2>&1
  book "$DAY" 11:00 cod
  during="$BOOK_CODE"
  docker compose start rabbitmq >/dev/null 2>&1
  if [ "$during" != 201 ]; then
    fail "outage: booking succeeds while RabbitMQ is down" "got HTTP $during (expected 201)"
  elif ! wait_for 90 rmq_up; then
    fail "outage: RabbitMQ came back" "management API not reachable after 90 s"
  else
    # RabbitMQ's counters restart from 0, so any publish after the restart is an outbox event that waited.
    published_any() { [ "$(published)" -ge 1 ]; }
    if wait_for 60 published_any && wait_for 60 drained; then
      pass "outage: booking OK while down; events published after restart" "published $(published) message(s)"
    else
      fail "outage: events not delivered within 60 s of RabbitMQ coming back"
    fi
  fi
fi

# ------------------------------------------------------------------ 4. poison message -> DLQ
dlq0="$(qcount payments.events.dlq)"; dlq0="${dlq0:-0}"
id="$(date +%s)"
routed="$(rmq -H 'content-type: application/json' -X POST "$RMQ/api/exchanges/%2F/edemand.events/publish" \
  -d "{\"routing_key\":\"booking.completed\",\"payload_encoding\":\"string\",\"properties\":{\"delivery_mode\":2,\"message_id\":\"monolith:$id\",\"content_type\":\"application/json\"},\"payload\":\"{\\\"id\\\":$id,\\\"source\\\":\\\"monolith\\\",\\\"type\\\":\\\"booking.completed\\\"}\"}" \
  | jget routed)"
if [ "$routed" != true ]; then
  fail "DLQ: publish a poison booking.completed" "broker did not route it (routed=$routed)"
else
  in_dlq()  { [ "$(qcount payments.events.dlq)" -ge $((dlq0 + 1)) ]; }
  # Each delivery is first retried in-process (~15.5 s with the default CONSUMER_RETRIES /
  # CONSUMER_RETRY_BASE_MS) before it goes back to the broker, so with x-delivery-limit 3 a poison
  # message needs about a minute to reach the DLQ.
  if wait_for 120 in_dlq && wait_for 30 drained; then
    pass "DLQ: poison message dead-lettered, queue not blocked" "payments.events.dlq = $(qcount payments.events.dlq)"
  else
    fail "DLQ: poison message did not reach payments.events.dlq within 120 s"
  fi
fi

# ------------------------------------------------------------------ 5. saga: payment timeout
if [ "$TIMEOUT" -gt 120 ]; then
  skip "saga: unpaid gateway booking is cancelled" "stack not started with a short PAYMENT_TIMEOUT_SECONDS (now ${TIMEOUT}s)"
else
  book "$DAY" 14:00 gateway
  if [ "$BOOK_CODE" != 201 ]; then
    fail "saga: place an unpaid gateway booking" "got HTTP $BOOK_CODE (expected 201)"
  else
    first="$BOOK_ID"
    cancelled() { [ "$(order_status "$first")" = cancelled ]; }
    if wait_for $((TIMEOUT + 40)) cancelled; then
      pass "saga: unpaid booking cancelled after the timeout" "order $first, ${TIMEOUT}s"
      book "$DAY" 14:00 gateway
      if [ "$BOOK_CODE" = 201 ]; then pass "saga: released slot can be booked again"; else fail "saga: slot not released" "re-book got HTTP $BOOK_CODE"; fi
    else
      fail "saga: order $first still '$(order_status "$first")' ${TIMEOUT}+40 s after booking"
    fi
  fi
fi

echo
[ "$SKIPS" -gt 0 ] && echo "$SKIPS skipped (see SKIP rows)"
if [ "$FAILS" -eq 0 ]; then
  echo "ALL PASS"
  exit 0
fi
echo "$FAILS FAILED"
exit 1
