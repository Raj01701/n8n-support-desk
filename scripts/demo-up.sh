#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Brings up the local proof stack: n8n, Postgres and the mock Gmail/LLM/Slack
# server, loads the support schema, imports the four workflow files with the
# n8n CLI, and attaches credentials so the workflows can be executed for real.
#
#   scripts/demo-up.sh
#
# Then: node scripts/run-scenarios.mjs
# Tear down with: scripts/demo-down.sh
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/infra"

COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.demo.yml --env-file .env.demo)

# Refuse to run on top of an existing stack. `n8n import:workflow` creates a new
# copy of every file each time it runs, and activating the copy then fails with a
# webhook-path conflict against the original. A second run must start clean.
if [[ -n "$("${COMPOSE[@]}" ps -q n8n 2>/dev/null)" ]]; then
  echo "A demo stack is already running."
  echo "  open it:      http://localhost:5681"
  echo "  start clean:  scripts/demo-down.sh && scripts/demo-up.sh"
  exit 1
fi

# Only the keys the scripts themselves need. docker compose reads the whole file.
read_env() { grep -E "^$1=" "$ROOT/infra/.env.demo" | head -1 | cut -d= -f2-; }
export POSTGRES_USER="$(read_env POSTGRES_USER)"
export POSTGRES_PASSWORD="$(read_env POSTGRES_PASSWORD)"
export SUPPORT_OPS_DB="$(read_env SUPPORT_OPS_DB)"
export N8N_HOST_PORT="$(read_env N8N_HOST_PORT)"

# The mock Gmail listener needs a certificate, because n8n's Gmail node insists
# on https://www.googleapis.com and the demo maps that name to the mock
# container.
if [[ ! -f "$ROOT/test/mocks/tls/mock.crt" ]]; then
  echo "==> generating a self-signed certificate for the mock Gmail listener"
  mkdir -p "$ROOT/test/mocks/tls"
  openssl req -x509 -newkey rsa:2048 -nodes -days 30 \
    -keyout "$ROOT/test/mocks/tls/mock.key" -out "$ROOT/test/mocks/tls/mock.crt" \
    -subj "/CN=www.googleapis.com" \
    -addext "subjectAltName=DNS:www.googleapis.com,DNS:oauth2.googleapis.com,DNS:mock,IP:172.31.10.10" 2>/dev/null
fi

echo "==> starting postgres, n8n and the mock server"
"${COMPOSE[@]}" up -d

echo "==> waiting for n8n on http://127.0.0.1:$N8N_HOST_PORT"
for _ in $(seq 1 90); do
  if curl -sf "http://127.0.0.1:$N8N_HOST_PORT/healthz" >/dev/null; then break; fi
  sleep 2
done
curl -sf "http://127.0.0.1:$N8N_HOST_PORT/healthz" >/dev/null || { echo "n8n did not become healthy"; exit 1; }

# healthz answers before the REST controllers are mounted, and /rest/settings
# answers before them too - both were tried and both let the next step race.
# So wait on the exact endpoint configure-n8n.mjs calls first: an empty POST to
# it answers 404 while it is unmounted and 400 once it is there. Waiting on the
# thing you are about to use is the only wait that means anything.
for _ in $(seq 1 90); do
  status="$(curl -s -o /dev/null -w '%{http_code}' -X POST \
    -H 'content-type: application/json' -H 'browser-id: demo-script' -d '{}' \
    "http://127.0.0.1:$N8N_HOST_PORT/rest/owner/setup")"
  [[ "$status" != "404" ]] && break
  sleep 1
done

# db/init applies the schema on the first boot of an empty volume. Re-applying it
# here is idempotent and covers the case where the volume already existed.
echo "==> loading sql/schema.sql into $SUPPORT_OPS_DB"
"${COMPOSE[@]}" exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" postgres \
  psql -U "$POSTGRES_USER" -d "$SUPPORT_OPS_DB" -v ON_ERROR_STOP=1 -q < "$ROOT/sql/schema.sql"

echo "==> importing workflows/ with the n8n CLI"
"${COMPOSE[@]}" exec -T n8n n8n import:workflow --separate --input=/workflows

echo "==> creating credentials, wiring the error workflow and the answer engine, activating"
node "$ROOT/scripts/configure-n8n.mjs"

echo
echo "n8n editor : http://localhost:$N8N_HOST_PORT  (demo@localhost.test / DemoRun-2026!x)"
echo "mock server: http://localhost:4181/__control/state"
echo "postgres   : psql postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@127.0.0.1:15681/$SUPPORT_OPS_DB"
echo "widget demo: open widget/demo.html"
