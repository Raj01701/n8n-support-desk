#!/bin/sh
# Runs once, on the first boot of an empty postgres_data volume.
#
# n8n gets its own database (POSTGRES_DB, created by the base image) and the
# workflows get a second one (SUPPORT_OPS_DB) for the tables in sql/schema.sql.
# Keeping them apart means the support schema can be dropped and reloaded while
# testing without touching n8n's credentials, executions or workflow history.
set -eu

: "${SUPPORT_OPS_DB:?SUPPORT_OPS_DB must be set}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
  SELECT 'CREATE DATABASE ${SUPPORT_OPS_DB}'
   WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${SUPPORT_OPS_DB}')\gexec
SQL

# The schema is mounted at /schema/schema.sql by docker-compose.yml. Applying it
# here means a fresh volume comes up with the knowledge base already seeded.
if [ -f /schema/schema.sql ]; then
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$SUPPORT_OPS_DB" -f /schema/schema.sql
  echo "init: ${SUPPORT_OPS_DB} created and sql/schema.sql applied"
else
  echo "init: ${SUPPORT_OPS_DB} created. Load the tables with:"
  echo "  docker compose exec -T postgres psql -U ${POSTGRES_USER} -d ${SUPPORT_OPS_DB} < ../sql/schema.sql"
fi
