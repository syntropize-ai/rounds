#!/usr/bin/env bash
#
# seed.sh - first-time setup of an openobs instance for e2e tests.
#
# Idempotent. Safe to run multiple times. Walks the bootstrap wizard,
# configures the LLM datasource, attaches the in-cluster prometheus
# datasource, registers an in-cluster ops connector, and mints a
# service-account token. Persists outputs into tests/e2e/.state/ which
# is the contract every TypeScript scenario reads.
#
# Required env:
#   OPENOBS_TEST_LLM_PROVIDER  e.g. "anthropic"
#   OPENOBS_TEST_LLM_API_KEY   provider key
#   OPENOBS_TEST_LLM_MODEL     e.g. "claude-haiku-4-5"
#
# Optional env:
#   OPENOBS_TEST_BASE_URL          (default http://127.0.0.1:3000)
#   OPENOBS_TEST_PROM_URL          (default http://prometheus.openobs-e2e:9090)
#   OPENOBS_TEST_OPS_NAMESPACE     (default openobs-e2e)
#   OPENOBS_TEST_ADMIN_EMAIL       (default admin@example.com)
#   OPENOBS_TEST_ADMIN_PASSWORD    (default: random hex stored in .state/admin-password)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
E2E_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
STATE_DIR="$E2E_DIR/.state"
mkdir -p "$STATE_DIR"

BASE_URL="${OPENOBS_TEST_BASE_URL:-http://127.0.0.1:3000}"
PROM_URL="${OPENOBS_TEST_PROM_URL:-http://prometheus.openobs-e2e:9090}"
OPS_NS="${OPENOBS_TEST_OPS_NAMESPACE:-openobs-e2e}"
ADMIN_EMAIL="${OPENOBS_TEST_ADMIN_EMAIL:-admin@example.com}"

: "${OPENOBS_TEST_LLM_PROVIDER:?OPENOBS_TEST_LLM_PROVIDER is required}"
: "${OPENOBS_TEST_LLM_API_KEY:?OPENOBS_TEST_LLM_API_KEY is required}"
: "${OPENOBS_TEST_LLM_MODEL:?OPENOBS_TEST_LLM_MODEL is required}"

# Stable admin password persisted to .state so re-runs against the same
# DB don't create a "user already exists with different password" case.
PASSWORD_FILE="$STATE_DIR/admin-password"
if [[ -n "${OPENOBS_TEST_ADMIN_PASSWORD:-}" ]]; then
  printf "%s" "$OPENOBS_TEST_ADMIN_PASSWORD" > "$PASSWORD_FILE"
elif [[ ! -s "$PASSWORD_FILE" ]]; then
  # 32 hex chars = 128 bits.
  head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$PASSWORD_FILE"
fi
ADMIN_PASSWORD="$(cat "$PASSWORD_FILE")"

COOKIE_JAR="$STATE_DIR/cookies.txt"
ADMIN_COOKIE_FILE="$STATE_DIR/admin-cookie"
SA_TOKEN_FILE="$STATE_DIR/sa-token"
PROM_DS_FILE="$STATE_DIR/prometheus-datasource-id"
OPS_CONNECTOR_FILE="$STATE_DIR/ops-connector-id"

phase() { printf "\n[seed] === %s ===\n" "$1" >&2; }
fail() { printf "[seed] FAIL: %s\n" "$1" >&2; exit 1; }

# curl wrapper that prints body on non-2xx and exits.
api() {
  local method="$1"; shift
  local path="$1"; shift
  local outfile; outfile="$(mktemp)"
  local code
  # CSRF: when authenticated via session cookie, mutating verbs need
  # x-csrf-token mirroring the openobs_csrf cookie. Read from the
  # current cookie jar if present.
  local csrf_header=()
  if [[ -f "$COOKIE_JAR" && "$method" != "GET" && "$method" != "HEAD" && "$method" != "OPTIONS" ]]; then
    local csrf_token
    csrf_token=$(awk '$6 == "openobs_csrf" {print $7}' "$COOKIE_JAR" 2>/dev/null | tail -1)
    if [[ -n "$csrf_token" ]]; then
      csrf_header=(-H "x-csrf-token: $csrf_token")
    fi
  fi
  # Use --fail-with-body so non-2xx is fatal but body is still captured.
  code="$(curl -sS -o "$outfile" -w '%{http_code}' \
    -X "$method" \
    -H 'content-type: application/json' \
    "${csrf_header[@]+${csrf_header[@]}}" \
    "$@" \
    "$BASE_URL$path" || true)"
  if [[ "$code" -lt 200 || "$code" -ge 300 ]]; then
    printf "[seed] %s %s -> %s\n" "$method" "$path" "$code" >&2
    cat "$outfile" >&2
    printf "\n" >&2
    rm -f "$outfile"
    return 1
  fi
  cat "$outfile"
  rm -f "$outfile"
}

# Same as api() but returns the http code in $HTTP_CODE without exiting
# on 4xx/5xx — used for "is the user already created?" probes.
api_probe() {
  local method="$1"; shift
  local path="$1"; shift
  local outfile; outfile="$(mktemp)"
  local csrf_header=()
  if [[ -f "$COOKIE_JAR" && "$method" != "GET" && "$method" != "HEAD" && "$method" != "OPTIONS" ]]; then
    local csrf_token
    csrf_token=$(awk '$6 == "openobs_csrf" {print $7}' "$COOKIE_JAR" 2>/dev/null | tail -1)
    if [[ -n "$csrf_token" ]]; then
      csrf_header=(-H "x-csrf-token: $csrf_token")
    fi
  fi
  HTTP_CODE="$(curl -sS -o "$outfile" -w '%{http_code}' \
    -X "$method" \
    -H 'content-type: application/json' \
    "${csrf_header[@]+${csrf_header[@]}}" \
    "$@" \
    "$BASE_URL$path" || true)"
  HTTP_BODY="$(cat "$outfile")"
  rm -f "$outfile"
}

# --- 1. wait for /api/health/ready ---------------------------------------
phase "wait for $BASE_URL/api/health/ready"
deadline=$(( $(date +%s) + 60 ))
while true; do
  code="$(curl -sS -o /dev/null -w '%{http_code}' "$BASE_URL/api/health/ready" || true)"
  if [[ "$code" == "200" ]]; then
    break
  fi
  if (( $(date +%s) > deadline )); then
    fail "/api/health/ready not 200 within 60s (last code=$code)"
  fi
  sleep 2
done

# --- 2. bootstrap admin --------------------------------------------------
phase "bootstrap first admin ($ADMIN_EMAIL)"
api_probe GET "/api/setup/status"
if [[ "$HTTP_CODE" != "200" ]]; then
  fail "GET /api/setup/status -> $HTTP_CODE: $HTTP_BODY"
fi

# Try to bootstrap. 409 = already done; that's fine.
rm -f "$COOKIE_JAR"
admin_body=$(cat <<JSON
{"email":"$ADMIN_EMAIL","name":"E2E Admin","login":"admin","password":"$ADMIN_PASSWORD"}
JSON
)
api_probe POST "/api/setup/admin" -c "$COOKIE_JAR" --data "$admin_body"
case "$HTTP_CODE" in
  201|200) printf "[seed] admin created\n" >&2 ;;
  409)     printf "[seed] admin already bootstrapped (idempotent)\n" >&2 ;;
  *)       fail "POST /api/setup/admin -> $HTTP_CODE: $HTTP_BODY" ;;
esac

# If we don't have a session cookie (because admin already existed), log in.
if ! grep -q -E 'oobs_session|session' "$COOKIE_JAR" 2>/dev/null; then
  phase "login (admin already existed)"
  login_body=$(cat <<JSON
{"user":"admin","password":"$ADMIN_PASSWORD"}
JSON
)
  api_probe POST "/api/login" -c "$COOKIE_JAR" --data "$login_body"
  if [[ "$HTTP_CODE" -lt 200 || "$HTTP_CODE" -ge 300 ]]; then
    fail "POST /api/auth/login -> $HTTP_CODE: $HTTP_BODY"
  fi
fi
cp "$COOKIE_JAR" "$ADMIN_COOKIE_FILE"

CURL_AUTH=(-b "$COOKIE_JAR" -c "$COOKIE_JAR")

# CSRF middleware mints `openobs_csrf` only on safe-method requests.
# Make one GET so we have a CSRF token in the jar before any PUT/POST.
api GET "/api/auth/me" "${CURL_AUTH[@]}" >/dev/null || true

# --- 3. configure LLM ----------------------------------------------------
phase "configure LLM ($OPENOBS_TEST_LLM_PROVIDER / $OPENOBS_TEST_LLM_MODEL)"
base_url_field=""
if [[ -n "${OPENOBS_TEST_LLM_BASE_URL:-}" ]]; then
  base_url_field=",\"baseUrl\":\"$OPENOBS_TEST_LLM_BASE_URL\""
fi
llm_body=$(cat <<JSON
{"provider":"$OPENOBS_TEST_LLM_PROVIDER","apiKey":"$OPENOBS_TEST_LLM_API_KEY","model":"$OPENOBS_TEST_LLM_MODEL"$base_url_field}
JSON
)
api PUT "/api/system/llm" "${CURL_AUTH[@]}" --data "$llm_body" >/dev/null

# --- 4. prometheus datasource -------------------------------------------
phase "prometheus datasource at $PROM_URL"
existing_ds=$(api GET "/api/datasources" "${CURL_AUTH[@]}")
prom_id=$(printf '%s' "$existing_ds" | python3 -c '
import json,sys
data = json.load(sys.stdin)
for ds in data.get("datasources", []):
    if ds.get("type") == "prometheus":
        print(ds["id"]); break
')
if [[ -z "$prom_id" ]]; then
  prom_body=$(cat <<JSON
{"type":"prometheus","name":"e2e-prometheus","url":"$PROM_URL","isDefault":true}
JSON
)
  created=$(api POST "/api/datasources" "${CURL_AUTH[@]}" --data "$prom_body")
  prom_id=$(printf '%s' "$created" | python3 -c 'import json,sys; print(json.load(sys.stdin)["datasource"]["id"])')
  printf "[seed] prometheus datasource created id=%s\n" "$prom_id" >&2
else
  printf "[seed] prometheus datasource already exists id=%s\n" "$prom_id" >&2
fi
printf "%s" "$prom_id" > "$PROM_DS_FILE"

# --- 5. ops connector (in-cluster) --------------------------------------
phase "ops connector (in-cluster, namespace=$OPS_NS)"
existing_ops=$(api GET "/api/ops/connectors" "${CURL_AUTH[@]}")
ops_id=$(printf '%s' "$existing_ops" | python3 -c '
import json,sys
data = json.load(sys.stdin)
for c in data.get("connectors", []):
    if c.get("name") == "e2e":
        print(c["id"]); break
')
if [[ -z "$ops_id" ]]; then
  ops_body=$(cat <<JSON
{"name":"e2e","type":"kubernetes","config":{"mode":"in-cluster"},"allowedNamespaces":["$OPS_NS"],"capabilities":["read","propose","execute_approved"]}
JSON
)
  created=$(api POST "/api/ops/connectors" "${CURL_AUTH[@]}" --data "$ops_body")
  ops_id=$(printf '%s' "$created" | python3 -c 'import json,sys; print(json.load(sys.stdin)["connector"]["id"])')
  printf "[seed] ops connector created id=%s\n" "$ops_id" >&2
else
  printf "[seed] ops connector already exists id=%s\n" "$ops_id" >&2
fi
printf "%s" "$ops_id" > "$OPS_CONNECTOR_FILE"

# --- 6. service account + token -----------------------------------------
phase "service account + token"
# Find or create the SA named "openobs".
sa_list=$(api GET "/api/serviceaccounts/search?perpage=100" "${CURL_AUTH[@]}")
sa_id=$(printf '%s' "$sa_list" | python3 -c '
import json,sys
data = json.load(sys.stdin)
for s in data.get("serviceAccounts", []):
    if s.get("name") == "openobs-e2e":
        print(s["id"]); break
')
if [[ -z "$sa_id" ]]; then
  sa_create=$(api POST "/api/serviceaccounts" "${CURL_AUTH[@]}" \
    --data '{"name":"openobs-e2e","role":"Admin"}')
  sa_id=$(printf '%s' "$sa_create" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
  printf "[seed] service account created id=%s\n" "$sa_id" >&2
fi

# Mint a fresh token only if we don't already have one cached. Tokens
# are non-recoverable after creation, so the cache is the source of truth.
if [[ ! -s "$SA_TOKEN_FILE" ]]; then
  token_resp=$(api POST "/api/serviceaccounts/$sa_id/tokens" "${CURL_AUTH[@]}" \
    --data '{"name":"e2e-token"}')
  token=$(printf '%s' "$token_resp" | python3 -c 'import json,sys; print(json.load(sys.stdin)["key"])')
  printf "%s" "$token" > "$SA_TOKEN_FILE"
  printf "[seed] sa token minted (cached at .state/sa-token)\n" >&2
else
  printf "[seed] sa token already cached\n" >&2
fi

phase "done"
printf "[seed] state files in %s:\n" "$STATE_DIR" >&2
ls -1 "$STATE_DIR" >&2
