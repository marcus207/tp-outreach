#!/usr/bin/env bash
# Reset the ISOLATED integration-test database from test/schema.sql.
#
# Safety:
#   - Refuses to run unless the target database is tpca_outreach_test or tpca_outreach_test_<lane>.
#   - Never touches tpca_platform (prod). Never reads /root/tp-outreach/.env.
#
# Usage:
#   scripts/test-db-reset.sh                       # uses TEST_DATABASE_URL or the default below
#   TEST_DATABASE_URL=postgresql://... scripts/test-db-reset.sh
set -euo pipefail

URL="${TEST_DATABASE_URL:-postgresql://tpca:tpca_secure_2026@localhost:5432/tpca_outreach_test}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCHEMA_FILE="${SCRIPT_DIR}/../test/schema.sql"

# Database name = path component after the last '/', minus any ?query string
DB_NAME="${URL##*/}"
DB_NAME="${DB_NAME%%\?*}"

if [[ ! "${DB_NAME}" =~ ^tpca_outreach_test(_[a-z0-9]+)?$ ]]; then
  echo "[test-db-reset] REFUSING: target database is '${DB_NAME}', must be tpca_outreach_test or tpca_outreach_test_<lane>." >&2
  exit 1
fi
REQUIRED_DB="${DB_NAME}"
if [[ ! -f "${SCHEMA_FILE}" ]]; then
  echo "[test-db-reset] schema file not found: ${SCHEMA_FILE}" >&2
  exit 1
fi

# Same server, maintenance URL (the postgres db) for the existence check
ADMIN_URL="${URL%/*}/postgres"
EXISTS="$(psql "${ADMIN_URL}" -Atqc "SELECT 1 FROM pg_database WHERE datname = '${REQUIRED_DB}'" || true)"
if [[ "${EXISTS}" != "1" ]]; then
  echo "[test-db-reset] ${REQUIRED_DB} does not exist; creating (tpca lacks CREATEDB, using postgres superuser)"
  sudo -n -u postgres createdb -O tpca "${REQUIRED_DB}"
fi

# Belt and braces: confirm the live connection really is the test database
ACTUAL="$(psql "${URL}" -Atqc 'SELECT current_database()')"
if [[ "${ACTUAL}" != "${REQUIRED_DB}" ]]; then
  echo "[test-db-reset] REFUSING: connected to '${ACTUAL}', expected '${REQUIRED_DB}'." >&2
  exit 1
fi

# Drop + recreate all content. tpca owns the database, so it can drop/recreate
# the public schema without CREATEDB.
psql "${URL}" -v ON_ERROR_STOP=1 -q <<'SQL'
SET client_min_messages = warning;
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
SQL
psql "${URL}" -v ON_ERROR_STOP=1 -q -f "${SCHEMA_FILE}" >/dev/null

TABLES="$(psql "${URL}" -Atqc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"
echo "[test-db-reset] ${REQUIRED_DB} reset OK (${TABLES} tables)"
