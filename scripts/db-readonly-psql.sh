#!/usr/bin/env bash
{ set +x +v; } 2>/dev/null   # FIRST: never trace (bash -x / SHELLOPTS=xtrace) — the password passes through this script
# scripts/db-readonly-psql.sh — read-only psql for diagnosing a POOLED database
# (Supabase/Supavisor), FAIL CLOSED. The owner uses it for masked, read-only
# investigations against PRODUCTION.
#
#   DIAG_DATABASE_URL='postgresql://user:pass@host:port/db' [DIAG_REQUIRE_ROLE=fm_diag_ro] \
#     scripts/db-readonly-psql.sh -f FILE | -c "select …" [-c …] [-A] [-t] [-q] [-x] [-F X] [-P X]
#
# ⚠️ WHY THIS EXISTS (docs/operations/database-safety.md §4b). On 2026-10-25 a
# credential check ran `SET default_transaction_read_only=on` as a standalone
# statement through the transaction pooler. In transaction mode a session-level
# SET stays on the SERVER connection after the client leaves, and the pooler
# hands that connection to the application: the next write transaction on it
# failed with 25006 and Preview's AI allowance gate returned 503s.
#
# Guarantees:
#   - every command runs in ONE transaction (`psql -1`) whose first statement is
#     `SET TRANSACTION READ ONLY; SET LOCAL statement_timeout …` — transaction-
#     scoped, gone at COMMIT, impossible to leak; the first row is read_only_guard;
#   - arguments: only exact `-c TEXT` / `-f FILE` and the output flags -A -t -q -x
#     -F X -P X. Everything else (-d/--dbname, -h, -p, -U, -v, -1, -o, -fFILE,
#     --file=…) is REFUSED, so nothing can override the URL, ON_ERROR_STOP or -1;
#   - every -c text and the contents of every -f file (copied once, privately,
#     and that copy is what psql runs) are scanned BEFORE connecting. Refused:
#     any backslash meta-command except \echo \qecho \pset (never \pset pager),
#     backticks, psql `:var` / `:'var'` / `:"var"` / `:{?var}` interpolation,
#     transaction control, DDL/DML/side-effect statements, session-level
#     SET / RESET, and set_config in any form. The scan is quote-unaware on
#     purpose: it fails closed;
#   - the URL comes from DIAG_DATABASE_URL only and is NEVER printed. It is
#     trimmed of quotes / whitespace / a NAME= prefix, must be
#     postgres(ql)://user:password@host[:port][/db][?params] with ONE plain
#     host name, and is refused when it points at a local/loopback host
#     (localhost, *.localhost, 127/8, 0/8, numeric shorthands, IPv6 literals,
#     socket paths) or carries host= / hostaddr= / service= / options= or any
#     unknown parameter. sslmode=require is added (disable/allow/prefer are
#     refused), Prisma's pgbouncer= / connection_limit= / pool_timeout= are
#     dropped;
#   - the password is split out of the URL, percent-decoded HERE (a malformed
#     escape is refused without echoing it), and handed to psql as PGPASSWORD in
#     its environment; psql's argv (visible in `ps`) carries a password-free URL.
#     Every inherited PG* variable (PGPASSWORD, PGHOST, PGOPTIONS, PGSERVICE, …)
#     is cleared first, and PAGER / PSQL_PAGER / PSQLRC are unset;
#   - DIAG_REQUIRE_ROLE=<role> makes the DATABASE verify, before anything else
#     runs, that the session is exactly that role and that neither it nor any
#     role it can become is superuser / BYPASSRLS / CREATEROLE / CREATEDB /
#     REPLICATION / pg_write_all_data, holds INSERT/UPDATE/DELETE/TRUNCATE on any
#     table or column, USAGE/UPDATE on any sequence, CREATE on any schema, or
#     CREATE on the database. Success prints read_only_role_guard = verified;
#     anything else aborts the whole run with "role guard refused: …".
#
# TEST-ONLY: DIAG_ALLOW_LOCAL=1 accepts a local/loopback host and (for that
# local host only) sslmode=disable, for the throwaway-container tests in
# scripts/db-readonly-psql-container.test.ts. It prints a loud warning. Never
# set it for Production or Preview.
unset SHELLOPTS 2>/dev/null || true   # readonly in bash; harmless if it cannot be unset
unset BASH_ENV ENV PS4 2>/dev/null || true
set -euo pipefail

refuse() { printf 'db-readonly-psql: REFUSED — %s\n' "$1" >&2; exit 2; }
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
upper() { printf '%s' "$1" | tr '[:lower:]' '[:upper:]'; }

allow_local=0
if [[ "${DIAG_ALLOW_LOCAL:-}" == "1" ]]; then
  allow_local=1
  printf '%s\n' "db-readonly-psql: ⚠️  WARNING — DIAG_ALLOW_LOCAL=1 is a TEST-ONLY override (local/loopback host and sslmode=disable accepted). NEVER set it for Production or Preview." >&2
fi

# ── Connection URL: normalised and validated, NEVER printed. ─────────────────
# A pasted value commonly carries surrounding quotes, whitespace or a
# `DATABASE_URL=` prefix (copied from a .env file / Vercel). psql does not treat
# such a string as a URL: it falls back to a LOCAL socket — the failure the
# owner hit. So: strip those, then parse strictly or refuse before psql runs.
raw="${DIAG_DATABASE_URL:-}"
raw="${raw#"${raw%%[![:space:]]*}"}"; raw="${raw%"${raw##*[![:space:]]}"}"   # trim
for _ in 1 2; do                                                              # 'NAME="value"' / NAME='value'
  raw="${raw#\"}"; raw="${raw%\"}"; raw="${raw#\'}"; raw="${raw%\'}"        # quotes
  if [[ "$raw" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then raw="${raw#*=}"; fi        # NAME=value
done
[[ -n "$raw" ]] || refuse "DIAG_DATABASE_URL is empty (it is never printed)."
NOT_URL="DIAG_DATABASE_URL is not a postgres://user:password@host/... URL (value not shown)."
case "$raw" in postgres://*|postgresql://*) ;; *) refuse "$NOT_URL" ;; esac
rest="${raw#*://}"
[[ "$rest" == *@* ]] || refuse "$NOT_URL"
userinfo="${rest%@*}"        # the password may contain raw '@', '/', ':' — the host part follows the LAST '@'
hostpart="${rest##*@}"
[[ "$userinfo" == *:* ]] || refuse "the URL has no password (value not shown)."
db_user="${userinfo%%:*}"
pw_enc="${userinfo#*:}"
[[ "$db_user" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]*$ ]] || refuse "the URL's user name must be plain letters, digits, '_', '.', '-' (value not shown)."
[[ -n "$pw_enc" ]] || refuse "the URL has an empty password (value not shown)."

query=""
if [[ "$hostpart" == *\?* ]]; then query="${hostpart#*\?}"; hostpart="${hostpart%%\?*}"; fi
db_name=""
if [[ "$hostpart" == */* ]]; then db_name="${hostpart#*/}"; hostpart="${hostpart%%/*}"; fi
[[ "$hostpart" != *,* ]] || refuse "multi-host URLs are refused (one host only)."
[[ "$hostpart" != *\[* ]] || refuse "IPv6 literal hosts are refused; use the host name."
db_port=""
if [[ "$hostpart" == *:* ]]; then db_port="${hostpart##*:}"; hostpart="${hostpart%:*}"; fi
host="$(lower "$hostpart")"
[[ -n "$host" ]] || refuse "the URL has no host (a local-socket fallback is refused)."
[[ "$host" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.?$ ]] \
  || refuse "the URL's host must be one plain host name (no socket paths, percent-escapes or lists)."
[[ -z "$db_port" || "$db_port" =~ ^[0-9]{1,5}$ ]] || refuse "the URL's port must be digits."
[[ "$db_name" =~ ^[A-Za-z0-9_.-]*$ ]] || refuse "the URL's database name must be plain letters, digits, '_', '.', '-'."

is_local=0
h="${host%.}"
if [[ "$h" == localhost || "$h" == *.localhost ]]; then is_local=1; fi
if [[ "$h" =~ ^(0x[0-9a-f]*|[0-9]+)(\.(0x[0-9a-f]*|[0-9]+))*$ ]]; then
  # A numeric host: only a canonical dotted quad is accepted (127.1, 2130706433,
  # 0x7f000001 and 0177.0.0.1 all resolve to loopback).
  octet='(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])'
  [[ "$h" =~ ^$octet\.$octet\.$octet\.$octet$ ]] || refuse "non-canonical numeric host (refused: it may resolve to loopback)."
  case "${h%%.*}" in 127|0) is_local=1 ;; esac
fi
if (( is_local )) && (( ! allow_local )); then
  refuse "URL points at a local/loopback host; this helper is for remote databases."
fi

sslmode=""; extra=""
if [[ -n "$query" ]]; then
  IFS='&' read -r -a params <<< "$query"
  for p in "${params[@]}"; do
    [[ -n "$p" ]] || continue
    k="$(lower "${p%%=*}")"; v=""; [[ "$p" == *=* ]] && v="${p#*=}"
    case "$k" in
      sslmode)          sslmode="$(lower "$v")" ;;
      pgbouncer|connection_limit|pool_timeout) ;;   # Prisma-only; psql rejects them
      connect_timeout)  [[ "$v" =~ ^[0-9]{1,3}$ ]] || refuse "connect_timeout must be digits."; extra+="&connect_timeout=$v" ;;
      application_name) [[ "$v" =~ ^[A-Za-z0-9_.-]{1,63}$ ]] || refuse "application_name must be plain."; extra+="&application_name=$v" ;;
      host|hostaddr|service|options)
        refuse "the URL carries a '$k=' parameter, which can redirect the connection or change session settings." ;;
      *) if [[ "$k" =~ ^[a-z_]{1,40}$ ]]; then refuse "unsupported URL parameter '$k'."; else refuse "unsupported URL parameter (not shown)."; fi ;;
    esac
  done
fi
case "$sslmode" in
  "") sslmode=require ;;   # remote connections require TLS
  require|verify-ca|verify-full) ;;
  disable|allow|prefer)
    (( is_local && allow_local )) || refuse "sslmode=$sslmode is refused (TLS is required for a remote database)." ;;
  *) refuse "invalid sslmode." ;;
esac

# Password: validate every percent-escape BEFORE anything else sees it (psql
# echoes a bad escape — and the password with it — in its error), then decode.
decode_password() {
  local LC_ALL=C s="$1" out="" ch
  while [[ -n "$s" ]]; do
    if [[ "${s:0:1}" == "%" ]]; then
      [[ "${s:1:2}" =~ ^[0-9A-Fa-f]{2}$ ]] || refuse "the password contains a malformed percent-escape (value not shown; write a literal % as %25)."
      [[ "${s:1:2}" != "00" ]] || refuse "the password contains %00 (value not shown)."
      printf -v ch "\\x${s:1:2}"; out+="$ch"; s="${s:3}"
    else
      out+="${s:0:1}"; s="${s:1}"
    fi
  done
  printf -v DECODED_PW '%s' "$out"
}
DECODED_PW=""
decode_password "$pw_enc"
unset pw_enc userinfo rest raw

timeout="${PGCONNECT_TIMEOUT:-10}"
[[ "$timeout" =~ ^[0-9]{1,3}$ ]] || timeout=10

# ── Arguments: exact forms only, every text scanned before connecting. ───────
workdir="$(mktemp -d "${TMPDIR:-/tmp}/db-readonly-psql.XXXXXX")"
trap 'rm -rf -- "$workdir"' EXIT
psql_args=(); scan=(); nfile=0
while (( $# )); do
  case "$1" in
    -c) (( $# >= 2 )) || refuse "-c needs a value."
        scan+=("$2"); psql_args+=(-c "$2"); shift 2 ;;
    -f) (( $# >= 2 )) || refuse "-f needs a value."
        [[ -f "$2" && -r "$2" ]] || refuse "-f needs a readable regular file (not a pipe or <(…))."
        nfile=$((nfile + 1)); copy="$workdir/input-$nfile.sql"
        cat -- "$2" > "$copy"                       # psql runs THIS copy: what was scanned is what runs
        scan+=("$(cat -- "$copy")"); psql_args+=(-f "$copy"); shift 2 ;;
    -A|-t|-q|-x) psql_args+=("$1"); shift ;;
    -F) (( $# >= 2 )) && [[ "$2" =~ ^[^[:cntrl:]]{1,8}$ ]] || refuse "-F needs a short separator."
        psql_args+=(-F "$2"); shift 2 ;;
    -P) (( $# >= 2 )) || refuse "-P needs a value."
        [[ "$2" =~ ^(format|border|footer|tuples_only|null|expanded|title|fieldsep|recordsep|numericlocale|linestyle|columns|csv_fieldsep|xheader_width)(=[^[:cntrl:]]*)?$ ]] \
          || refuse "-P accepts only output-format options (never pager)."
        psql_args+=(-P "$2"); shift 2 ;;
    *) refuse "argument not allowed (only exact '-c TEXT', '-f FILE' and -A -t -q -x -F X -P X; -d/--dbname, -h, -p, -U, -v, -1, -o, joined forms like -fFILE or --file=… are refused)." ;;
  esac
done

KW='COMMIT|ROLLBACK|BEGIN|ABORT|SAVEPOINT|RELEASE|START[[:space:]]+TRANSACTION|READ[[:space:]]+WRITE|SESSION[[:space:]]+CHARACTERISTICS|PREPARE|COPY|DO|CALL|LISTEN|UNLISTEN|NOTIFY|DISCARD|LOAD|INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE|LOCK|VACUUM|CLUSTER|REINDEX|REFRESH|COMMENT|SECURITY[[:space:]]+LABEL|IMPORT|REASSIGN|CHECKPOINT|INTO|DBLINK[A-Z_]*|LO_[A-Z_]+|PG_(TERMINATE|CANCEL)_BACKEND|PG_RELOAD_CONF|PG_ROTATE_LOGFILE|PG_(TRY_)?ADVISORY[A-Z_]*'
for text in ${scan[@]+"${scan[@]}"}; do
  u="$(upper "$text")"
  # psql meta-commands: only \echo, \qecho and \pset (not \pset pager).
  if grep -q '\\' <<< "$text"; then
    while IFS= read -r tok; do
      case "$tok" in '\echo'|'\qecho'|'\pset') ;; *) refuse "psql meta-command not allowed (only \\echo, \\qecho, \\pset)." ;; esac
    done < <(grep -oE '\\[^[:space:]A-Za-z]?[A-Za-z_]*' <<< "$text")
    grep -Eqi '\\pset[[:space:]]+pager' <<< "$text" && refuse "\\pset pager is not allowed."
  fi
  [[ "$text" != *'`'* ]] || refuse "backticks are not allowed (psql runs them as shell commands)."
  grep -Eq "(^|[^:]):[A-Za-z0-9_'\"{]" <<< "$text" \
    && refuse "psql variable interpolation (:var, :'var', :\"var\", :{?var}) is not allowed."
  grep -Eq '(^|[^A-Z0-9_])SET_CONFIG([^A-Z0-9_]|$)' <<< "$u" \
    && refuse "set_config is not allowed (use SET LOCAL inside the helper's transaction)."
  if grep -Eq "(^|[^A-Z0-9_])($KW)([^A-Z0-9_]|\$)|^[[:space:]]*END[[:space:]]*;|(^|[^A-Z0-9_])END[[:space:]]+(TRANSACTION|WORK)" <<< "$u"; then
    refuse "transaction control / write / side-effect command in input."
  fi
  # A SET that is not SET LOCAL / SET TRANSACTION / SET CONSTRAINTS is session-scoped:
  # remove the allowed forms, then ANY remaining SET is refused.
  rest_u="$(sed -E 's/(^|[^A-Z0-9_])SET[[:space:]]+(LOCAL|TRANSACTION|CONSTRAINTS)([^A-Z0-9_]|$)/\1\3/g' <<< "$u")"
  grep -Eq '(^|[^A-Z0-9_])SET([^A-Z0-9_]|$)' <<< "$rest_u" \
    && refuse "session-level SET through a pooler leaks to the application (use SET LOCAL)."
  grep -Eq '(^|[^A-Z0-9_])RESET([^A-Z0-9_]|$)' <<< "$u" && refuse "RESET is session-scoped."
  true
done

# ── Optional database-side role guard. ───────────────────────────────────────
# A plpgsql DO block (cannot be constant-folded away) RAISEs "role guard
# refused: …" — aborting the whole run under ON_ERROR_STOP — unless the session
# is exactly DIAG_REQUIRE_ROLE and neither it nor any role it can become
# (pg_has_role MEMBER: inherited OR via SET ROLE) can write. Then a plain
# SELECT prints read_only_role_guard = verified.
role_guard=""
if [[ -n "${DIAG_REQUIRE_ROLE:-}" ]]; then
  [[ "$DIAG_REQUIRE_ROLE" =~ ^[a-z_][a-z0-9_]*$ ]] || refuse "invalid DIAG_REQUIRE_ROLE."
  role_guard=$(cat <<'SQL'
DO $fm_role_guard$
DECLARE
  expected CONSTANT name := '__ROLE__';
  m record;
  found text;
BEGIN
  IF current_user <> expected OR session_user <> expected THEN
    RAISE EXCEPTION 'role guard refused: connected as %, expected %', session_user, expected;
  END IF;
  FOR m IN SELECT r.oid, r.rolname, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolreplication
             FROM pg_roles r WHERE pg_has_role(current_user, r.oid, 'MEMBER')
            ORDER BY (r.rolname = current_user) DESC, r.rolname LOOP
    IF m.rolsuper THEN
      RAISE EXCEPTION 'role guard refused: % is superuser (via %)', expected, m.rolname;
    END IF;
    IF m.rolbypassrls THEN
      RAISE EXCEPTION 'role guard refused: % can bypass row-level security (BYPASSRLS via %)', expected, m.rolname;
    END IF;
    IF m.rolcreaterole OR m.rolcreatedb OR m.rolreplication THEN
      RAISE EXCEPTION 'role guard refused: % holds CREATEROLE/CREATEDB/REPLICATION (via %)', expected, m.rolname;
    END IF;
    IF m.rolname = 'pg_write_all_data' THEN
      RAISE EXCEPTION 'role guard refused: % is a member of pg_write_all_data', expected;
    END IF;
    SELECT string_agg(t, ', ') INTO found FROM (
      SELECT quote_ident(n.nspname) || '.' || quote_ident(c.relname) AS t
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_(toast|temp_)'
         AND ((c.relkind IN ('r', 'p', 'v', 'm', 'f')
               AND (has_table_privilege(m.oid, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE')
                    OR has_any_column_privilege(m.oid, c.oid, 'INSERT,UPDATE')))
           OR (c.relkind = 'S' AND has_sequence_privilege(m.oid, c.oid, 'USAGE,UPDATE')))
       ORDER BY 1 LIMIT 5) x;
    IF found IS NOT NULL THEN
      RAISE EXCEPTION 'role guard refused: % can write (INSERT/UPDATE/DELETE/TRUNCATE or sequence USAGE/UPDATE, via %) on: %', expected, m.rolname, found;
    END IF;
    SELECT string_agg(quote_ident(n.nspname), ', ') INTO found
      FROM pg_namespace n
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_(toast|temp_)'
       AND has_schema_privilege(m.oid, n.oid, 'CREATE');
    IF found IS NOT NULL THEN
      RAISE EXCEPTION 'role guard refused: % has CREATE (via %) on schema: %', expected, m.rolname, found;
    END IF;
    IF has_database_privilege(m.oid, current_database(), 'CREATE') THEN
      RAISE EXCEPTION 'role guard refused: % has CREATE on database % (via %)', expected, current_database(), m.rolname;
    END IF;
  END LOOP;
END
$fm_role_guard$;
SELECT 'verified'::text AS read_only_role_guard;
SQL
)
  role_guard="${role_guard//__ROLE__/$DIAG_REQUIRE_ROLE}"
fi

# ── psql's environment: nothing inherited can redirect or weaken it. ────────
for v in $(compgen -e); do
  case "$v" in PG*|PSQL*|PAGER|DIAG_DATABASE_URL) unset "$v" ;; esac
done
export PGCONNECT_TIMEOUT="$timeout"
export PGPASSWORD="$DECODED_PW"
unset DECODED_PW

url="postgresql://${db_user}@${host}${db_port:+:$db_port}/${db_name}?sslmode=${sslmode}${extra}"

set +e
psql "$url" -X -w -q -1 -v ON_ERROR_STOP=1 -P pager=off \
  -c "SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = '60s'; SET LOCAL idle_in_transaction_session_timeout = '60s'; SELECT current_setting('transaction_read_only') AS read_only_guard" \
  ${role_guard:+-c "$role_guard"} ${psql_args[@]+"${psql_args[@]}"}
rc=$?
unset PGPASSWORD
exit "$rc"
