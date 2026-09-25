#!/usr/bin/env bash
# Removes the local proof stack and its volumes, so the next demo-up.sh starts
# from an empty database rather than from the last run's executions. Nothing in
# this stack is meant to outlive a recording session.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/infra"
docker compose -f docker-compose.yml -f docker-compose.demo.yml --env-file .env.demo down -v --remove-orphans
echo "stopped"
