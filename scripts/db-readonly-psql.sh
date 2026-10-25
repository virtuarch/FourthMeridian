#!/usr/bin/env bash
# scripts/db-readonly-psql.sh — read-only psql for diagnosing a POOLED database
# (Supabase/Supavisor), safe by construction.
#
#   DIAG_DATABASE_URL='postgresql://…' scripts/db-readonly-psql.sh -c "select …" [-c "select …"]
#
# ⚠️ WHY THIS EXISTS (docs/operations/database-safety.md §4b). On 2026-10-25 a
# credential check ran `SET default_transaction_read_only=on` as a standalone
# statement through the transaction pooler. In transaction mode a session-level
# SET stays on the SERVER connection after the client leaves, and the pooler
# hands that connection to the application: the next write transaction on it
# failed with 25006 and Preview's AI allowance gate returned 503s.
#
# So, here:
#   - every command runs in ONE transaction (`psql -1`) that begins
#     `SET TRANSACTION READ ONLY; SET LOCAL statement_timeout` — transaction-
#     scoped, gone at COMMIT, impossible to leak;
#   - any argument containing a session-level SET, RESET, or set_config(…, false)
#     is REFUSED before connecting;
#   - the URL comes from DIAG_DATABASE_URL only (never printed), and Prisma's
#     `pgbouncer=true` parameter (which psql rejects) is removed.
set -euo pipefail

if [[ -z "${DIAG_DATABASE_URL:-}" ]]; then
  echo "db-readonly-psql: REFUSED — set DIAG_DATABASE_URL (it is never printed)." >&2
  exit 2
fi

for arg in "$@"; do
  upper=$(printf '%s' "$arg" | tr '[:lower:]' '[:upper:]')
  # A SET that is not SET LOCAL / SET TRANSACTION / SET CONSTRAINTS is session-scoped.
  if printf '%s' "$upper" | grep -Eq '(^|[^A-Z_])SET[[:space:]]+(SESSION[[:space:]]+)?([A-Z_."]+)' \
     && ! printf '%s' "$upper" | grep -Eq '(^|[^A-Z_])SET[[:space:]]+(LOCAL|TRANSACTION|CONSTRAINTS)[[:space:]]' ; then
    echo "db-readonly-psql: REFUSED — session-level SET through a pooler leaks to the application (use SET LOCAL)." >&2
    exit 2
  fi
  if printf '%s' "$upper" | grep -Eq '(^|[^A-Z_])RESET[[:space:]]|SET_CONFIG\([^)]*,[[:space:]]*FALSE[[:space:]]*\)'; then
    echo "db-readonly-psql: REFUSED — RESET / set_config(…, false) is session-scoped." >&2
    exit 2
  fi
done

url="${DIAG_DATABASE_URL//\?pgbouncer=true&/?}"
url="${url//\?pgbouncer=true/}"
url="${url//&pgbouncer=true/}"

exec psql "$url" -X -q -1 -v ON_ERROR_STOP=1 -P pager=off \
  -c "SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = '60s'" "$@"
