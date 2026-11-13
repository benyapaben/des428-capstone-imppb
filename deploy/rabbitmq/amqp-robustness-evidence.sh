#!/usr/bin/env bash
# Evidence for fix/amqp-robustness: the RabbitMQ consumers survive a broker restart in the middle of a
# delivery, and a short database outage no longer dead-letters real events.
#
#   docker compose up -d --build --wait
#   bash deploy/rabbitmq/amqp-robustness-evidence.sh        # ~1-2 minutes
#
# Each case cancels a fresh COD booking, which emits booking.cancelled (consumed by payments) and
# booking.status_changed (consumed by notifications).
#
#   1. broker restart mid-delivery: both service DBs are paused so the handlers hang, RabbitMQ restarts
#      (their channels close), then the DBs resume and the handlers try to ack on a closed channel.
#      Before the fix this killed the payments and notifications processes.
#   2. short DB outage: pay-db is stopped for a few seconds while booking.cancelled arrives. Before the
#      fix the handler failed 3 times within milliseconds and the event went to payments.events.dlq.
#
# Needs bash, curl, node and docker compose. Exit 0 = every row PASS, 1 = something failed.
set -u
cd "$(dirname "$0")/../.." || exit 2

GW="${GW:-http://localhost:8080}"
KC="${KC:-http://localhost:8081}"
RMQ="${RMQ:-http://localhost:15672}"
RMQ_AUTH="${RMQ_AUTH:-guest:guest}"
USER_EMAIL="${USER_EMAIL:-nong@example.com}"
PASSWORD='eDemand-2026!'                     # SEED_PASSWORD (lib/db/seed.js)
OUTAGE_SECONDS="${OUTAGE_SECONDS:-4}"

FAILS=0
row()  { printf '%-58s %-5s %s\n' "$@"; }
pass() { row "$1" PASS "${2:-}"; }
fail() { row "$1" FAIL "${2:-}"; FAILS=$((FAILS + 1)); }
die()  { echo "ERROR: $*" >&2; exit 2; }

jget() {
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{let v=JSON.parse(s);for(const k of process.argv[1].split("."))v=v?.[k];console.log(v??"")}catch{console.log("")}})' "$1"
}
rmq_up()  { curl -sf --max-time 5 -u "$RMQ_AUTH" "$RMQ/api/overview" >/dev/null; }
qcount()  { curl -s --max-time 10 -u "$RMQ_AUTH" "$RMQ/api/queues/%2F/$1" | jget messages; }
running() { [ "$(docker compose ps --status running --services 2>/dev/null | grep -cx "$1")" = 1 ]; }
drained() { [ "$(qcount payments.events)" = 0 ] && [ "$(qcount notifications.events)" = 0 ]; }
psql_count() {   # psql_count <db-service> <db> <sql>
  docker compose exec -T "$1" psql -U postgres -d "$2" -tAc "$3" 2>/dev/null | tr -d '[:space:]'
}
inbox() { psql_count "$1" "$2" "SELECT count(*) FROM processed_messages WHERE type = '$3'"; }

wait_for() {   # wait_for <seconds> <command...>
  local end=$((SECONDS + $1)); shift
  while [ "$SECONDS" -lt "$end" ]; do "$@" && return 0; sleep 2; done
  return 1
}

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
rmq_up || die "RabbitMQ management API not reachable at $RMQ"
docker compose version >/dev/null 2>&1 || die "docker compose not available"
AUTH=(-H "Authorization: Bearer $TOKEN")

book_cod() {   # book_cod <date> <HH:MM>: prints the new order id
  curl -s --max-time 25 "${AUTH[@]}" -H 'content-type: application/json' \
    -d "{\"provider_id\":1,\"service_date\":\"$1\",\"starting_time\":\"$2\",\"items\":[{\"service_id\":2,\"quantity\":1}],\"payment_method\":\"cod\"}" \
    "$GW/api/bookings" | jget order.id
}
cancel() { curl -s -o /dev/null -w '%{http_code}' --max-time 25 -X POST "${AUTH[@]}" "$GW/api/bookings/$1/cancel"; }

# Leave the stack usable even if the script is interrupted mid-case.
restore() { docker compose unpause pay-db notif-db >/dev/null 2>&1; docker compose start pay-db >/dev/null 2>&1; }
trap restore EXIT

DAY="$(future_date $((10 + RANDOM % 40)))"
echo "gateway $GW   rabbitmq $RMQ   day $DAY"
echo
row CASE RESULT DETAIL
row ---- ------ ------

# ------------------------------------------------------------------ 1. broker restart mid-delivery
ID="$(book_cod "$DAY" 10:00)"
[ -n "$ID" ] || die "could not place a COD booking"
wait_for 30 drained || die "queues did not drain before the test"
pay0="$(inbox pay-db pay_db booking.cancelled)"
notif0="$(inbox notif-db notif_db booking.status_changed)"

docker compose pause pay-db notif-db >/dev/null 2>&1
code="$(cancel "$ID")"
sleep 5                                            # both consumers now hold an unacked message, waiting on their DB
docker compose restart rabbitmq >/dev/null 2>&1    # their channels close under them
docker compose unpause pay-db notif-db >/dev/null 2>&1
sleep 8                                            # the handlers finish and try to ack on the closed channels

if [ "$code" != 200 ]; then
  fail "broker restart: cancel booking $ID" "HTTP $code"
else
  for svc in payments notifications; do
    if running "$svc"; then pass "broker restart: $svc process still running"
    else fail "broker restart: $svc process still running" "$(docker compose ps -a --format '{{.Status}}' "$svc")"; fi
  done
  wait_for 90 rmq_up || fail "broker restart: RabbitMQ came back" "not reachable after 90 s"
  inbox_grew() { [ "$(inbox pay-db pay_db booking.cancelled)" -gt "$pay0" ] && [ "$(inbox notif-db notif_db booking.status_changed)" -gt "$notif0" ]; }
  if wait_for 60 inbox_grew && wait_for 30 drained; then
    pass "broker restart: both events processed, queues drained" "consumers reconnected by themselves"
  else
    fail "broker restart: both events processed" "inbox or queues not caught up within 90 s"
  fi
fi

# ------------------------------------------------------------------ 2. short DB outage
ID="$(book_cod "$DAY" 14:00)"
[ -n "$ID" ] || die "could not place a COD booking"
wait_for 30 drained || die "queues did not drain before the test"
pay0="$(inbox pay-db pay_db booking.cancelled)"
dlq0="$(qcount payments.events.dlq)"

docker compose stop pay-db >/dev/null 2>&1
code="$(cancel "$ID")"
sleep "$OUTAGE_SECONDS"
docker compose start pay-db >/dev/null 2>&1

if [ "$code" != 200 ]; then
  fail "DB outage: cancel booking $ID" "HTTP $code"
else
  if running payments; then pass "DB outage: payments process still running"
  else fail "DB outage: payments process still running" "$(docker compose ps -a --format '{{.Status}}' payments)"; fi
  processed() { [ "$(inbox pay-db pay_db booking.cancelled)" -gt "$pay0" ]; }
  if wait_for 60 processed; then pass "DB outage: booking.cancelled processed after pay-db returned" "retried in-process"
  else fail "DB outage: booking.cancelled processed" "not in processed_messages within 60 s"; fi
  sleep 6                                          # management counters refresh about every 5 s
  dlq1="$(qcount payments.events.dlq)"
  if [ "$dlq1" = "$dlq0" ]; then pass "DB outage: nothing dead-lettered" "payments.events.dlq stays $dlq1"
  else fail "DB outage: nothing dead-lettered" "payments.events.dlq $dlq0 -> $dlq1"; fi
fi

echo
if [ "$FAILS" = 0 ]; then echo "ALL PASS"; exit 0; else echo "$FAILS FAILED"; exit 1; fi
