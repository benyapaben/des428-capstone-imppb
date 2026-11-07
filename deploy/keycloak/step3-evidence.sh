#!/usr/bin/env bash
# Step 3 / B6 evidence: real Keycloak tokens, sent through the nginx gateway, against both extracted
# services (and the monolith as a bonus). Every bad token must get 401, every good one 200.
#
#   docker compose up -d --build --wait
#   bash deploy/keycloak/step3-evidence.sh          # ~70 s: it waits for a 60 s token to expire
#
# Needs only bash, curl, sed, base64 and openssl. Exit code 0 = every row PASS, 1 = something did not.
# The report that explains each case is docs/step3-security-evidence.md.
set -u

GW="${GW:-http://localhost:8080}"            # the gateway: the only way in to payments / notifications
KC="${KC:-http://localhost:8081}"            # Keycloak, as the browser / host sees it
TOKEN_URL="$KC/realms/edemand/protocol/openid-connect/token"
USER_EMAIL="${USER_EMAIL:-sparkle@example.com}"   # provider#1: allowed on all three routes below
PASSWORD='eDemand-2026!'                          # SEED_PASSWORD (lib/db/seed.js)

# label|path — one row per case per route
ROUTES=(
  "payments|/api/provider/wallet"
  "notifications|/api/notifications"
  "monolith|/api/me"
)

FAILS=0
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

b64url_enc() { base64 | tr -d '=\n' | tr '/+' '_-'; }
b64url_dec() {
  local s
  s="$(printf '%s' "$1" | tr '_-' '/+')"
  while [ $(( ${#s} % 4 )) -ne 0 ]; do s="$s="; done
  printf '%s' "$s" | base64 -d
}
part()  { printf '%s' "$1" | cut -d. -f"$2"; }                   # 1 header, 2 payload, 3 signature
claim() { b64url_dec "$(part "$1" 2)" | sed -nE "s/.*\"$2\":(\"[^\"]*\"|\[[^]]*\]|[0-9]+).*/\1/p"; }

token() {   # $1 = Keycloak client id; prints the access token (empty on failure)
  curl -s --max-time 10 -d grant_type=password -d "client_id=$1" -d "username=$USER_EMAIL" \
    --data-urlencode "password=$PASSWORD" "$TOKEN_URL" | sed -nE 's/.*"access_token":"([^"]+)".*/\1/p'
}

row() { printf '%-14s %-36s %-6s %-5s %-5s %s\n' "$@"; }

check() {   # $1 label  $2 path  $3 case  $4 expected status  [$5 token]
  local out code body err res
  if [ -n "${5:-}" ]; then
    out="$(curl -s --max-time 10 -w '\n%{http_code}' -H "Authorization: Bearer $5" "$GW$2")"
  else
    out="$(curl -s --max-time 10 -w '\n%{http_code}' "$GW$2")"
  fi
  code="$(printf '%s' "$out" | tail -n1)"
  body="$(printf '%s' "$out" | sed '$d')"
  err="$(printf '%s' "$body" | sed -nE 's/.*"error":"(([^"\\]|\\.)*)".*/\1/p' | sed 's/\\"/"/g')"
  if [ "$code" = "$4" ]; then res=PASS; else res=FAIL; FAILS=$((FAILS + 1)); fi
  row "$1" "$3" "$4" "$code" "$res" "$err"
}

each_route() {   # $1 case  $2 expected  [$3 token]
  local r
  for r in "${ROUTES[@]}"; do check "${r%%|*}" "${r#*|}" "$@"; done
}

die() { echo "ERROR: $*" >&2; exit 2; }

# ---------------------------------------------------------------- tokens
# The 60 s token first, so the other cases run while it ages.
EXPIRING="$(token expiry-test)";   [ -n "$EXPIRING" ] || die "no token from client expiry-test (is the realm re-imported? see CLAUDE.md)"
VALID="$(token web)";              [ -n "$VALID" ]    || die "no token from client web (is the stack up at $KC?)"
WRONG_AUD="$(token aud-test)";     [ -n "$WRONG_AUD" ] || die "no token from client aud-test"

# Forged 1: a real token whose payload is edited (app_id -> 999) while the original signature is kept.
TAMPERED_PAYLOAD="$(b64url_dec "$(part "$VALID" 2)" | sed -E 's/"app_id":[0-9]+/"app_id":999/' | b64url_enc)"
TAMPERED="$(part "$VALID" 1).$TAMPERED_PAYLOAD.$(part "$VALID" 3)"

# Forged 2: the exact same claims and kid, but signed with an attacker's own RSA key.
openssl genrsa -out "$WORK/attacker.pem" 2048 2>/dev/null || die "openssl genrsa failed"
SIGNING_INPUT="$(part "$VALID" 1).$(part "$VALID" 2)"
ATTACKER_SIG="$(printf '%s' "$SIGNING_INPUT" | openssl dgst -sha256 -sign "$WORK/attacker.pem" -binary | b64url_enc)"
ATTACKER="$SIGNING_INPUT.$ATTACKER_SIG"

echo "gateway  $GW"
echo "keycloak $KC   user $USER_EMAIL"
echo
echo "token claims (decoded from the real tokens):"
for t in VALID WRONG_AUD EXPIRING; do
  printf '  %-9s azp=%-12s aud=%-48s iat=%s exp=%s\n' "$t" "$(claim "${!t}" azp)" "$(a="$(claim "${!t}" aud)"; echo "${a:-(none)}")" \
    "$(claim "${!t}" iat)" "$(claim "${!t}" exp)"
done
echo "  EXPIRING lifetime = $(( $(claim "$EXPIRING" exp) - $(claim "$EXPIRING" iat) )) s"
echo

row ROUTE CASE EXPECT GOT RESULT "ERROR (response body)"
row ----- ---- ------ --- ------ ---------------------
each_route "valid web token (control)"            200 "$VALID"
each_route "no token (control)"                   401
each_route "forged: payload edited, old sig"      401 "$TAMPERED"
each_route "forged: signed by attacker key"       401 "$ATTACKER"
each_route "wrong audience (aud-test client)"     401 "$WRONG_AUD"
each_route "expiry-test token, not yet expired"   200 "$EXPIRING"

# ---------------------------------------------------------------- wait for the 60 s token to expire
EXP="$(claim "$EXPIRING" exp)"
WAIT=$(( EXP - $(date +%s) + 5 ))
if [ "$WAIT" -gt 0 ]; then
  echo "... waiting ${WAIT}s for the expiry-test token to pass its exp ($EXP)"
  sleep "$WAIT"
fi
each_route "expired (same token, after exp)"      401 "$EXPIRING"

echo
if [ "$FAILS" -eq 0 ]; then
  echo "ALL PASS"
  exit 0
fi
echo "$FAILS FAILED"
exit 1
