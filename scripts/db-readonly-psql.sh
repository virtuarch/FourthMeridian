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
#   - the URL comes from DIAG_DATABASE_URL only (never printed), is trimmed of
#     quotes / whitespace / a NAME= prefix, must be a remote postgres:// URL
#     (never a silent local-socket fallback), gets sslmode=require, and Prisma's
#     `pgbouncer=true` parameter (which psql rejects) is removed;
#   - DIAG_REQUIRE_ROLE=<role> makes the database itself verify the connected
#     role is exactly that read-only role before anything else runs.
set -euo pipefail

# ── Connection URL: normalised and validated, NEVER printed. ─────────────────
# A pasted value commonly carries surrounding quotes, whitespace or a
# `DATABASE_URL=` prefix (copied from a .env file / Vercel). psql does not treat
# such a string as a URL: it falls back to a LOCAL socket (/tmp/.s.PGSQL.5432)
# — the failure the owner hit. So: strip those, then require a postgres URL
# with a remote host, or refuse before psql ever runs.
raw="${DIAG_DATABASE_URL:-}"
raw="${raw#"${raw%%[![:space:]]*}"}"; raw="${raw%"${raw##*[![:space:]]}"}"   # trim
[[ "$raw" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] && raw="${raw#*=}"                     # NAME=value
raw="${raw#\"}"; raw="${raw%\"}"; raw="${raw#\'}"; raw="${raw%\'}"          # quotes
if [[ -z "$raw" ]]; then
  echo "db-readonly-psql: REFUSED — DIAG_DATABASE_URL is empty (it is never printed)." >&2
  exit 2
fi
if [[ ! "$raw" =~ ^postgres(ql)?://[^/@]+@[^/:?]+ ]]; then
  echo "db-readonly-psql: REFUSED — DIAG_DATABASE_URL is not a postgres://user:pass@host/... URL (value not shown)." >&2
  exit 2
fi
db_host="${raw#*@}"; db_host="${db_host%%[:/?]*}"
if [[ "$db_host" =~ ^(localhost|127\.0\.0\.1|::1|\[::1\])$ && "${DIAG_ALLOW_LOCAL:-}" != "1" ]]; then
  echo "db-readonly-psql: REFUSED — URL points at localhost; this helper is for remote databases." >&2
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
  # No comment stripping: a '--' inside a string literal would hide what follows it
  # (proved on Preview). The scan fails closed instead.
  u=$(printf '%s' "$text" | tr '[:lower:]' '[:upper:]')
  if printf '%s' "$u" | grep -Eq '(^|[^A-Z_])(COMMIT|ROLLBACK|BEGIN|ABORT|SAVEPOINT|START[[:space:]]+TRANSACTION|READ[[:space:]]+WRITE|SESSION[[:space:]]+CHARACTERISTICS|COPY|DO|CALL|PREPARE|LISTEN|NOTIFY)([^A-Z_]|$)|^[[:space:]]*END[[:space:]]*;' \
     || printf '%s' "$text" | grep -Eq '\\(!|o|w|g[^a-z]|gx|gexec|s[[:space:]]|lo_|setenv|copy|i|ir|include|connect|c )'; then
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

url="${raw//\?pgbouncer=true&/?}"
url="${url//\?pgbouncer=true/}"
url="${url//&pgbouncer=true/}"

# Remote connections require TLS unless the URL already says otherwise.
[[ "$url" == *sslmode=* ]] || { [[ "$url" == *\?* ]] && url="${url}&sslmode=require" || url="${url}?sslmode=require"; }

# Optional database-side role guard: with DIAG_REQUIRE_ROLE set, the FIRST
# statement aborts the whole run (division by zero under ON_ERROR_STOP) unless
# the connected role is exactly that role, is not a superuser, cannot bypass
# RLS, and holds no INSERT/UPDATE/DELETE/TRUNCATE privilege on any table.
role_guard=""
if [[ -n "${DIAG_REQUIRE_ROLE:-}" ]]; then
  [[ "$DIAG_REQUIRE_ROLE" =~ ^[a-z_][a-z0-9_]*$ ]] || { echo "db-readonly-psql: REFUSED — invalid DIAG_REQUIRE_ROLE." >&2; exit 2; }
  role_guard="SELECT CASE WHEN current_user = '${DIAG_REQUIRE_ROLE}'
      AND NOT r.rolsuper AND NOT r.rolbypassrls
      AND NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants g
                       WHERE g.grantee = current_user AND g.privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE'))
      THEN 'verified' ELSE (1/0)::text END AS read_only_role_guard
    FROM pg_roles r WHERE r.rolname = current_user;"
fi

PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-10}" exec psql "$url" -X -q -1 -v ON_ERROR_STOP=1 -P pager=off \
  -c "SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = '60s'; SET LOCAL idle_in_transaction_session_timeout = '60s'; SELECT current_setting('transaction_read_only') AS read_only_guard" \
  ${role_guard:+-c "$role_guard"} "$@"
