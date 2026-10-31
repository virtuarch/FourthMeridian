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

# Every text psql will run: each -c argument AND the CONTENTS of each -f file
# (a file is read here and again by psql — pass a real file, not <(…)).
scan=(); prev=""
for arg in "$@"; do
  if [[ "$prev" == "-f" ]]; then
    [[ -f "$arg" && -r "$arg" ]] || { echo "db-readonly-psql: REFUSED — -f needs a readable regular file (not a pipe or <(…))." >&2; exit 2; }
    scan+=("$(cat -- "$arg")")
  else
    scan+=("$arg")
  fi
  prev="$arg"
done

# Transaction control or side-effect commands would let a statement escape the
# read-only transaction (proved on Preview: COMMIT in a file, SET TRANSACTION
# READ WRITE before the first query). Refused before connecting.
for text in "${scan[@]}"; do
  u=$(printf '%s' "$text" | sed 's/--.*$//' | tr '[:lower:]' '[:upper:]')
  if printf '%s' "$u" | grep -Eq '(^|[^A-Z_])(COMMIT|ROLLBACK|BEGIN|ABORT|SAVEPOINT|START[[:space:]]+TRANSACTION|READ[[:space:]]+WRITE|SESSION[[:space:]]+CHARACTERISTICS|COPY|DO|CALL|PREPARE|LISTEN|NOTIFY)([^A-Z_]|$)|^[[:space:]]*END[[:space:]]*;' \
     || printf '%s' "$text" | grep -Eq '\\(!|o|w|g[^a-z]|gexec|copy|i|ir|include|connect|c )'; then
    echo "db-readonly-psql: REFUSED — transaction control / side-effect command in input." >&2
    exit 2
  fi
done

for arg in "${scan[@]}"; do
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
  -c "SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = '60s'; SET LOCAL idle_in_transaction_session_timeout = '60s'; SELECT current_setting('transaction_read_only') AS read_only_guard" "$@"
