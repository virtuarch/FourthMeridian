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
# Guarantees (each proved by scripts/db-session-set-guard.test.ts and, against a
# throwaway container, scripts/db-readonly-psql-container.test.ts):
#   - every command runs in ONE transaction (`psql -1`) whose first statement is
#     `SET TRANSACTION READ ONLY; SET LOCAL statement_timeout …` — transaction-
#     scoped, gone at COMMIT, impossible to leak; the first row is read_only_guard;
#   - arguments: only exact `-c TEXT` / `-f FILE` and the output flags -A -t -q -x
#     -F X -P X. Everything else (-d/--dbname, -h, -p, -U, -v, -1, -o, -fFILE,
#     --file=…) is REFUSED, so nothing can override the URL, ON_ERROR_STOP or -1;
#   - every -c text and every -f file is copied once into a private directory;
#     the copy is what is checked and what psql runs. Refused before connecting:
#     NUL or any control byte except TAB/CR/LF, invalid UTF-8, non-ASCII outside
#     quotes and comments, any backslash meta-command except \echo \qecho \pset
#     (never with `pager`), backticks, `:` followed by anything that can start a
#     psql variable (so also `::type` casts — write CAST(x AS type)), dollar
#     quoting, U&'…' / U&"…" / UESCAPE, more END words than CASE words (a bare
#     END commits), transaction control, DDL/DML and side-effect statements and
#     functions, timeouts, session-level SET / RESET and set_config in any form.
#     The checks are deliberately coarse: they fail closed;
#   - the URL comes from DIAG_DATABASE_URL only and is NEVER printed. It is
#     trimmed of quotes / whitespace / a NAME= prefix, must be
#     postgres(ql)://user:password@host[:port][/db][?params] with ONE plain
#     host name, and is refused when it points at a local/loopback host
#     (localhost, *.localhost, 127/8, 0/8, numeric shorthands, IPv6 literals,
#     socket paths) or carries host= / hostaddr= / service= / options= or any
#     unknown parameter. sslmode=require is added (disable/allow/prefer are
#     refused; sslrootcert= only with sslmode=verify-full), require_auth=
#     scram-sha-256 is ALWAYS added, channel_binding=require is optional, and
#     Prisma's pgbouncer= / connection_limit= / pool_timeout= are dropped;
#   - the password is split out of the URL and percent-decoded HERE (a malformed
#     escape is refused without echoing it). It never appears in an argv (`ps`),
#     a trace, an error or psql's environment: it is written to a 0600 pgpass
#     file inside a private 0700 directory that is removed on exit, and psql runs
#     under `env -i` with only PATH, HOME, LANG, TERM, PGCONNECT_TIMEOUT and
#     PGPASSFILE. The resolved psql path is printed before connecting;
#   - DIAG_REQUIRE_ROLE=<role> makes the DATABASE verify, before anything else
#     runs, that the session is exactly that role and that neither it nor any
#     role it can become (pg_has_role MEMBER) is superuser / BYPASSRLS /
#     CREATEROLE / CREATEDB / REPLICATION, a member of pg_write_all_data,
#     pg_execute_server_program, pg_write_server_files, pg_signal_backend,
#     pg_checkpoint, pg_maintain or pg_create_subscription, owns any object,
#     holds INSERT/UPDATE/DELETE/TRUNCATE on any table or column, USAGE/UPDATE on
#     any sequence, UPDATE on any large object, CREATE on any schema or the
#     database, or can EXECUTE a SECURITY DEFINER function in a schema it can use
#     (except the two allowlisted STABLE read-only functions
#     public.fm_visible_space_ids() and public.fm_may_join_space(text)). The
#     guard schema-qualifies every catalog reference and pins search_path to
#     pg_catalog while it runs. Success prints read_only_role_guard = verified;
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


sslmode=""; extra=""; sslrootcert=""
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
      channel_binding)  [[ "$(lower "$v")" == require ]] || refuse "channel_binding accepts only 'require'."; extra+="&channel_binding=require" ;;
      sslrootcert)      [[ "$v" =~ ^[A-Za-z0-9_./~-]{1,255}$ && -f "${v/#\~/${HOME:-}}" && -r "${v/#\~/${HOME:-}}" ]] \
                          || refuse "sslrootcert must be a plain path to a readable file."
                        sslrootcert="${v/#\~/${HOME:-}}" ;;
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
if [[ -n "$sslrootcert" ]]; then
  [[ "$sslmode" == verify-full ]] || refuse "sslrootcert is accepted only together with sslmode=verify-full."
  extra+="&sslrootcert=$sslrootcert"
fi
extra+="&require_auth=scram-sha-256"   # never send the password in clear / to a non-SCRAM server

# Password: validate every percent-escape BEFORE anything else sees it (psql
# echoes a bad escape — and the password with it — in its error), then decode,
# and build its pgpass form (\ and : escaped).
decode_password() {
  local LC_ALL=C s="$1" out="" ch esc=""
  while [[ -n "$s" ]]; do
    if [[ "${s:0:1}" == "%" ]]; then
      [[ "${s:1:2}" =~ ^[0-9A-Fa-f]{2}$ ]] || refuse "the password contains a malformed percent-escape (value not shown; write a literal % as %25)."
      printf -v ch "\\x${s:1:2}"; s="${s:3}"
    else
      ch="${s:0:1}"; s="${s:1}"
    fi
    [[ ! "$ch" =~ [[:cntrl:]] && -n "$ch" ]] || refuse "the password contains a control character (value not shown)."
    out+="$ch"
    case "$ch" in '\') esc+='\\' ;; ':') esc+='\:' ;; *) esc+="$ch" ;; esac
  done
  printf -v PGPASS_LINE '*:*:*:*:%s' "$esc"
}
PGPASS_LINE=""
decode_password "$pw_enc"
unset pw_enc userinfo rest raw

timeout="${PGCONNECT_TIMEOUT:-10}"
[[ "$timeout" =~ ^[0-9]{1,3}$ ]] || timeout=10

workdir="$(umask 077; mktemp -d "${TMPDIR:-/tmp}/db-readonly-psql.XXXXXX")"
cleanup() { rm -rf -- "$workdir"; }
trap cleanup EXIT
trap 'cleanup; exit 129' HUP
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM
passfile="$workdir/pgpass"
(umask 077; printf '%s\n' "$PGPASS_LINE" > "$passfile")
unset PGPASS_LINE

# ── Arguments: exact forms only. Each text is copied once; the copy is checked
#    and the copy (or the identical -c string) is what psql runs. ─────────────
psql_args=(); copies=(); n=0
while (( $# )); do
  case "$1" in
    -c) (( $# >= 2 )) || refuse "-c needs a value."
        n=$((n + 1)); copy="$workdir/input-$n.sql"
        (umask 077; printf '%s' "$2" > "$copy")
        copies+=("$copy"); psql_args+=(-c "$2"); shift 2 ;;
    -f) (( $# >= 2 )) || refuse "-f needs a value."
        [[ -f "$2" && -r "$2" ]] || refuse "-f needs a readable regular file (not a pipe or <(…))."
        n=$((n + 1)); copy="$workdir/input-$n.sql"
        (umask 077; cat -- "$2" > "$copy")
        copies+=("$copy"); psql_args+=(-f "$copy"); shift 2 ;;
    -A|-t|-q|-x) psql_args+=("$1"); shift ;;
    -F) (( $# >= 2 )) && [[ "$2" =~ ^[^[:cntrl:]]{1,8}$ ]] || refuse "-F needs a short separator."
        psql_args+=(-F "$2"); shift 2 ;;
    -P) (( $# >= 2 )) || refuse "-P needs a value."
        [[ "$2" =~ ^(format|border|footer|tuples_only|null|expanded|title|fieldsep|recordsep|numericlocale|linestyle|columns|csv_fieldsep|xheader_width)(=[^[:cntrl:]]*)?$ ]] \
          && [[ "$(lower "$2")" != *pager* ]] || refuse "-P accepts only output-format options (never pager)."
        psql_args+=(-P "$2"); shift 2 ;;
    *) refuse "argument not allowed (only exact '-c TEXT', '-f FILE' and -A -t -q -x -F X -P X; -d/--dbname, -h, -p, -U, -v, -1, -o, joined forms like -fFILE or --file=… are refused)." ;;
  esac
done

# Lexer used ONLY to count CASE words outside quotes / comments / meta-command
# lines (PostgreSQL rules: '…', "…", -- …, nested /* */). END words are counted
# EVERYWHERE, so any mistake here can only over-count END: it fails closed. Also
# flags any non-ASCII byte outside quotes and comments.
IFS= read -r -d '' COUNT_AWK <<'AWK' || true
BEGIN { pr = " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~" }
{ t = t $0 "\n" }
END {
  n = length(t); i = 1; cases = 0; ends = 0; bad = 0
  while (i <= n) {
    c = substr(t, i, 1); d = substr(t, i + 1, 1)
    if (c == "-" && d == "-") { j = index(substr(t, i), "\n"); i = (j ? i + j : n + 1); continue }
    if (c == "\\")            { j = index(substr(t, i), "\n"); i = (j ? i + j : n + 1); continue }
    if (c == "/" && d == "*") {
      depth = 1; i += 2
      while (i <= n && depth > 0) {
        c = substr(t, i, 1); d = substr(t, i + 1, 1)
        if (c == "/" && d == "*") { depth++; i += 2 } else if (c == "*" && d == "/") { depth--; i += 2 } else i++
      }
      continue
    }
    if (c == "'" || c == "\"") { j = index(substr(t, i + 1), c); i = (j ? i + j + 1 : n + 1); continue }
    if (c ~ /[A-Za-z0-9_$]/) {
      w = ""
      while (i <= n && substr(t, i, 1) ~ /[A-Za-z0-9_$]/) { w = w substr(t, i, 1); i++ }
      if (toupper(w) == "CASE") cases++
      continue
    }
    if (c == "\n" || c == "\t" || c == "\r" || index(pr, c) > 0) { i++; continue }
    bad = 1; i++
  }
  m = split(toupper(t), ws, /[^A-Z0-9_$]+/)
  for (k = 1; k <= m; k++) if (ws[k] == "END") ends++
  print cases, ends, bad
}
AWK

KW='COMMIT|ROLLBACK|BEGIN|ABORT|SAVEPOINT|RELEASE|START[[:space:]]+TRANSACTION|READ[[:space:]]+WRITE|SESSION[[:space:]]+CHARACTERISTICS|PREPARE|COPY|DO|CALL|LISTEN|UNLISTEN|NOTIFY|PG_NOTIFY|DISCARD|LOAD|INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE|LOCK|VACUUM|ANALYZE|ANALYSE|CLUSTER|REINDEX|REFRESH|COMMENT|SECURITY[[:space:]]+LABEL|IMPORT|REASSIGN|CHECKPOINT|INTO|DECLARE|DBLINK[A-Z_]*|LO_[A-Z_]+|PG_(TERMINATE|CANCEL)_BACKEND|PG_RELOAD_CONF|PG_ROTATE_LOGFILE|PG_(TRY_)?ADVISORY[A-Z_]*|PG_LOGICAL_EMIT_MESSAGE|TXID_CURRENT[A-Z_]*|PG_CURRENT_XACT_ID[A-Z_]*|PG_SLEEP[A-Z_]*|[A-Z_]*TIMEOUT'
for copy in ${copies[@]+"${copies[@]}"}; do
  # Bytes first: bash $(…) silently drops NUL, so check the FILE, byte-wise.
  ctl="$(LC_ALL=C tr -d '\t\r\n\040-\176\200-\377' < "$copy" | LC_ALL=C wc -c | tr -d '[:space:]')"
  [[ "$ctl" == "0" ]] || refuse "input contains a NUL or control byte (only TAB, CR and LF are allowed)."
  iconv -f UTF-8 -t UTF-8 < "$copy" > /dev/null 2>&1 || refuse "input is not valid UTF-8."
  text="$(cat -- "$copy")"
  u="$(upper "$text")"
  # psql meta-commands: only \echo, \qecho and \pset — and never `pager`.
  if grep -q '\\' <<< "$text"; then
    while IFS= read -r tok; do
      case "$tok" in '\echo'|'\qecho'|'\pset') ;; *) refuse "psql meta-command not allowed (only \\echo, \\qecho, \\pset)." ;; esac
    done < <(grep -oE '\\[^[:space:]A-Za-z]?[A-Za-z_]*' <<< "$text")
    grep -Eqi '\\pset.*pager' <<< "$text" && refuse "\\pset pager is not allowed."
  fi
  [[ "$text" != *'`'* ]] || refuse "backticks are not allowed (psql runs them as shell commands)."
  LC_ALL=C grep -Eq ':[^[:space:]=),;:-]' <<< "$text" \
    && refuse "':' followed by a name, quote or brace is not allowed (psql variable interpolation); write casts as CAST(x AS type)."
  LC_ALL=C grep -Eq '\$[A-Za-z_]*\$' <<< "$text" && refuse "dollar quoting is not allowed."
  grep -Eq "U&[[:space:]]*['\"]|(^|[^A-Z0-9_])UESCAPE([^A-Z0-9_]|\$)" <<< "$u" && refuse "U&'…' / U&\"…\" / UESCAPE are not allowed."
  grep -Eq '(^|[^A-Z0-9_])SET_CONFIG([^A-Z0-9_]|$)' <<< "$u" \
    && refuse "set_config is not allowed (use SET LOCAL inside the helper's transaction)."
  if grep -Eq "(^|[^A-Z0-9_])($KW)([^A-Z0-9_]|\$)" <<< "$u"; then
    refuse "transaction control / write / side-effect command or function in input."
  fi
  read -r n_case n_end n_bad < <(LC_ALL=C awk "$COUNT_AWK" < "$copy")
  [[ "$n_bad" == 0 ]] || refuse "non-ASCII characters are allowed only inside quotes and comments."
  (( n_end <= n_case )) || refuse "an END that does not close a CASE is refused (END commits the transaction)."
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
# (pg_has_role MEMBER: inherited OR via SET ROLE) can write, run server
# programs, signal backends, own objects or run an unexpected SECURITY DEFINER
# function. Every catalog reference is pg_catalog-qualified and search_path is
# pinned to pg_catalog while it runs (restored before the investigation).
role_guard=""
if [[ -n "${DIAG_REQUIRE_ROLE:-}" ]]; then
  [[ "$DIAG_REQUIRE_ROLE" =~ ^[a-z_][a-z0-9_]*$ ]] || refuse "invalid DIAG_REQUIRE_ROLE."
  IFS= read -r -d '' role_guard <<'SQL' || true
DO $fm_role_guard$
DECLARE
  expected CONSTANT pg_catalog.name := '__ROLE__';
  saved_path CONSTANT pg_catalog.text := pg_catalog.current_setting('search_path');
  m record;
  found pg_catalog.text;
BEGIN
  PERFORM pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', true);
  IF current_user OPERATOR(pg_catalog.<>) expected OR session_user OPERATOR(pg_catalog.<>) expected THEN
    RAISE EXCEPTION 'role guard refused: connected as %, expected %', session_user, expected;
  END IF;
  IF pg_catalog.current_setting('lo_compat_privileges') OPERATOR(pg_catalog.=) 'on' THEN
    RAISE EXCEPTION 'role guard refused: lo_compat_privileges is on (anyone can write large objects)';
  END IF;
  FOR m IN SELECT r.oid, r.rolname, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolreplication
             FROM pg_catalog.pg_roles r WHERE pg_catalog.pg_has_role(current_user, r.oid, 'MEMBER')
            ORDER BY (r.rolname OPERATOR(pg_catalog.=) current_user) DESC, r.rolname LOOP
    IF m.rolsuper THEN
      RAISE EXCEPTION 'role guard refused: % is superuser (via %)', expected, m.rolname;
    END IF;
    IF m.rolbypassrls THEN
      RAISE EXCEPTION 'role guard refused: % can bypass row-level security (BYPASSRLS via %)', expected, m.rolname;
    END IF;
    IF m.rolcreaterole OR m.rolcreatedb OR m.rolreplication THEN
      RAISE EXCEPTION 'role guard refused: % holds CREATEROLE/CREATEDB/REPLICATION (via %)', expected, m.rolname;
    END IF;
    IF m.rolname OPERATOR(pg_catalog.=) ANY (ARRAY['pg_write_all_data', 'pg_execute_server_program', 'pg_write_server_files',
                     'pg_signal_backend', 'pg_checkpoint', 'pg_maintain', 'pg_create_subscription']::pg_catalog.name[]) THEN
      RAISE EXCEPTION 'role guard refused: % is a member of %', expected, m.rolname;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_shdepend d
                WHERE d.refclassid OPERATOR(pg_catalog.=) 'pg_catalog.pg_authid'::pg_catalog.regclass
                  AND d.refobjid OPERATOR(pg_catalog.=) m.oid AND d.deptype OPERATOR(pg_catalog.=) 'o'
                  AND (d.dbid OPERATOR(pg_catalog.=) 0::pg_catalog.oid
                       OR d.dbid OPERATOR(pg_catalog.=) (SELECT db.oid FROM pg_catalog.pg_database db
                                                          WHERE db.datname OPERATOR(pg_catalog.=) pg_catalog.current_database())))
       OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c     WHERE c.relowner OPERATOR(pg_catalog.=) m.oid)
       OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p      WHERE p.proowner OPERATOR(pg_catalog.=) m.oid)
       OR EXISTS (SELECT 1 FROM pg_catalog.pg_type t      WHERE t.typowner OPERATOR(pg_catalog.=) m.oid)
       OR EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspowner OPERATOR(pg_catalog.=) m.oid) THEN
      RAISE EXCEPTION 'role guard refused: % owns database objects (via %)', expected, m.rolname;
    END IF;
    SELECT pg_catalog.string_agg(x.t, ', ') INTO found FROM (
      SELECT pg_catalog.quote_ident(n.nspname) OPERATOR(pg_catalog.||) '.' OPERATOR(pg_catalog.||) pg_catalog.quote_ident(c.relname) AS t
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid OPERATOR(pg_catalog.=) c.relnamespace
       WHERE n.nspname OPERATOR(pg_catalog.<>) ALL (ARRAY['pg_catalog', 'information_schema']::pg_catalog.name[])
         AND n.nspname OPERATOR(pg_catalog.!~) '^pg_(toast|temp_)'
         AND ((c.relkind OPERATOR(pg_catalog.=) ANY (ARRAY['r', 'p', 'v', 'm', 'f']::pg_catalog."char"[])
               AND (pg_catalog.has_table_privilege(m.oid, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE')
                    OR pg_catalog.has_any_column_privilege(m.oid, c.oid, 'INSERT,UPDATE')))
           OR (c.relkind OPERATOR(pg_catalog.=) 'S' AND pg_catalog.has_sequence_privilege(m.oid, c.oid, 'USAGE,UPDATE')))
       ORDER BY 1 LIMIT 5) x;
    IF found IS NOT NULL THEN
      RAISE EXCEPTION 'role guard refused: % can write (INSERT/UPDATE/DELETE/TRUNCATE or sequence USAGE/UPDATE, via %) on: %', expected, m.rolname, found;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_largeobject_metadata l
                WHERE l.lomowner OPERATOR(pg_catalog.=) m.oid
                   OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(l.lomacl) a
                               WHERE a.grantee OPERATOR(pg_catalog.=) ANY (ARRAY[m.oid, 0::pg_catalog.oid])
                                 AND a.privilege_type OPERATOR(pg_catalog.=) 'UPDATE')) THEN
      RAISE EXCEPTION 'role guard refused: % can write a large object (via %)', expected, m.rolname;
    END IF;
    SELECT pg_catalog.string_agg(pg_catalog.quote_ident(n.nspname), ', ') INTO found
      FROM pg_catalog.pg_namespace n
     WHERE n.nspname OPERATOR(pg_catalog.<>) ALL (ARRAY['pg_catalog', 'information_schema']::pg_catalog.name[])
       AND n.nspname OPERATOR(pg_catalog.!~) '^pg_(toast|temp_)'
       AND pg_catalog.has_schema_privilege(m.oid, n.oid, 'CREATE');
    IF found IS NOT NULL THEN
      RAISE EXCEPTION 'role guard refused: % has CREATE (via %) on schema: %', expected, m.rolname, found;
    END IF;
    IF pg_catalog.has_database_privilege(m.oid, pg_catalog.current_database(), 'CREATE') THEN
      RAISE EXCEPTION 'role guard refused: % has CREATE on database % (via %)', expected, pg_catalog.current_database(), m.rolname;
    END IF;
    -- SECURITY DEFINER functions this role can reach run with their OWNER's rights.
    -- Allowlisted: the two Production RLS helpers, by schema, name, argument types,
    -- and only while they are STABLE/IMMUTABLE (read-only by declaration).
    SELECT pg_catalog.string_agg(pg_catalog.quote_ident(n.nspname) OPERATOR(pg_catalog.||) '.' OPERATOR(pg_catalog.||) pg_catalog.quote_ident(p.proname)
             OPERATOR(pg_catalog.||) '(' OPERATOR(pg_catalog.||) pg_catalog.oidvectortypes(p.proargtypes) OPERATOR(pg_catalog.||) ')', ', ') INTO found
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid OPERATOR(pg_catalog.=) p.pronamespace
     WHERE p.prosecdef
       AND n.nspname OPERATOR(pg_catalog.<>) ALL (ARRAY['pg_catalog', 'information_schema']::pg_catalog.name[])
       AND n.nspname OPERATOR(pg_catalog.!~) '^pg_(toast|temp_)'
       AND pg_catalog.has_schema_privilege(m.oid, n.oid, 'USAGE')
       AND pg_catalog.has_function_privilege(m.oid, p.oid, 'EXECUTE')
       AND NOT (n.nspname OPERATOR(pg_catalog.=) 'public'
                AND p.provolatile OPERATOR(pg_catalog.=) ANY (ARRAY['s', 'i']::pg_catalog."char"[])
                AND ((p.proname OPERATOR(pg_catalog.=) 'fm_visible_space_ids' AND pg_catalog.oidvectortypes(p.proargtypes) OPERATOR(pg_catalog.=) '')
                  OR (p.proname OPERATOR(pg_catalog.=) 'fm_may_join_space' AND pg_catalog.oidvectortypes(p.proargtypes) OPERATOR(pg_catalog.=) 'text')));
    IF found IS NOT NULL THEN
      RAISE EXCEPTION 'role guard refused: % can execute SECURITY DEFINER function(s) (via %): %', expected, m.rolname, found;
    END IF;
  END LOOP;
  PERFORM pg_catalog.set_config('search_path', saved_path, true);
END
$fm_role_guard$;
SELECT 'verified'::pg_catalog.text AS read_only_role_guard;
SQL
  role_guard="${role_guard//__ROLE__/$DIAG_REQUIRE_ROLE}"
fi

# ── psql: resolved path printed; clean environment (env -i + allowlist). ─────
psql_bin="$(type -P psql || true)"
[[ "$psql_bin" == /* ]] || refuse "psql was not found on PATH."
printf 'db-readonly-psql: using psql at %s\n' "$psql_bin" >&2
psql_env=(PATH="$PATH" PGCONNECT_TIMEOUT="$timeout" PGPASSFILE="$passfile")
[[ -n "${HOME:-}" ]] && psql_env+=(HOME="$HOME")
[[ -n "${LANG:-}" ]] && psql_env+=(LANG="$LANG")
[[ -n "${TERM:-}" ]] && psql_env+=(TERM="$TERM")

url="postgresql://${db_user}@${host}${db_port:+:$db_port}/${db_name}?sslmode=${sslmode}${extra}"

set +e
env -i "${psql_env[@]}" "$psql_bin" "$url" -X -w -q -1 -v ON_ERROR_STOP=1 -P pager=off \
  -c "SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = '60s'; SET LOCAL idle_in_transaction_session_timeout = '60s'; SELECT pg_catalog.current_setting('transaction_read_only') AS read_only_guard" \
  ${role_guard:+-c "$role_guard"} ${psql_args[@]+"${psql_args[@]}"}
rc=$?
exit "$rc"
