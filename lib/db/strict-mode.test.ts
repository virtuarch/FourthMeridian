/**
 * lib/db/strict-mode.test.ts  (RLS-4)
 *
 * The one state this mode exists to forbid:
 *
 *     FM_RLS_STRICT=true, DATABASE_URL_APP missing, so quietly use postgres.
 *
 * A deployment there believes it has tenant isolation, passes every application
 * test, and has none — `postgres` carries BYPASSRLS and sails through every
 * policy. These assertions are the difference between that being impossible and
 * that being Tuesday.
 *
 * Pure: the configuration half is checkable without a database, which is why it
 * is a separate function from the half that asks the server who it is.
 */

import {
  strictRlsEnabled, strictConfigProblems, assertStrictRoleConfiguration,
  principalOf, isMigrationPrincipal, verifyAuthority, ROLE_URL_VARS,
} from "./strict-mode";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) { failures++; console.error(`FAIL  ${name}${detail ? `  -> ${detail}` : ""}`); }
  else console.log(`pass  ${name}`);
}

const GOOD = {
  FM_RLS_STRICT: "true",
  DATABASE_URL_APP:    "postgresql://fm_app:x@h:5432/fintracker_x",
  DATABASE_URL_AUTH:   "postgresql://fm_auth:x@h:5432/fintracker_x",
  DATABASE_URL_SYSTEM: "postgresql://fm_system:x@h:5432/fintracker_x",
} as NodeJS.ProcessEnv;

// ── the flag is opt-in and exact ─────────────────────────────────────────────
check("strict is OFF when unset", !strictRlsEnabled({}));
check("strict is OFF for 'True', '1', 'yes' — only the exact string arms it",
  !strictRlsEnabled({ FM_RLS_STRICT: "True" }) &&
  !strictRlsEnabled({ FM_RLS_STRICT: "1" }) &&
  !strictRlsEnabled({ FM_RLS_STRICT: "yes" }));
check("strict is ON for exactly 'true'", strictRlsEnabled({ FM_RLS_STRICT: "true" }));

// ── fallback survives only while strict is OFF ───────────────────────────────
check("with strict OFF, a missing role URL is NOT a problem (adoption fallback)",
  strictConfigProblems({}).length === 0);

// ── THE CENTRAL CASE ─────────────────────────────────────────────────────────
{
  const env = { ...GOOD };
  delete env.DATABASE_URL_APP;
  const problems = strictConfigProblems(env);
  check("strict ON + DATABASE_URL_APP missing ⇒ a problem, never a silent fallback",
    problems.length === 1 && problems[0].variable === "DATABASE_URL_APP",
    JSON.stringify(problems));
  let threw = false;
  try { assertStrictRoleConfiguration(env); } catch { threw = true; }
  check("…and it REFUSES TO BOOT rather than returning", threw);
}

// ── the migration principal can never be a role URL ──────────────────────────
check("bare postgres is the migration principal", isMigrationPrincipal("postgres"));
check("Supabase's postgres.<ref> is ALSO the migration principal",
  isMigrationPrincipal("postgres.qirfzvvaeddukjiphims"));
check("supabase_admin is the migration principal", isMigrationPrincipal("supabase_admin"));
check("fm_app is not", !isMigrationPrincipal("fm_app"));

{
  const env = { ...GOOD, DATABASE_URL_APP: "postgresql://postgres.abc123:x@h:6543/postgres" };
  const problems = strictConfigProblems(env);
  check("a role URL naming Supabase's pooler principal is REFUSED",
    problems.length === 1 && /migration principal/.test(problems[0].reason),
    JSON.stringify(problems));
}

// ── a role URL must name its own role ────────────────────────────────────────
{
  const env = { ...GOOD, DATABASE_URL_AUTH: "postgresql://fm_app:x@h:5432/fintracker_x" };
  const problems = strictConfigProblems(env);
  check("DATABASE_URL_AUTH pointed at fm_app is REFUSED (roles are not interchangeable)",
    problems.length === 1 && /must authenticate as "fm_auth"/.test(problems[0].reason),
    JSON.stringify(problems));
}

check("a fully-provisioned strict environment has no problems",
  strictConfigProblems(GOOD).length === 0, JSON.stringify(strictConfigProblems(GOOD)));

// ── credentials never leak through the parser ────────────────────────────────
check("principalOf returns the username and never the password",
  principalOf("postgresql://fm_app:sup3rsecret@h:5432/d") === "fm_app");
check("principalOf is null-safe on junk", principalOf("not a url") === null && principalOf(undefined) === null);

check("every role variable has an expected principal",
  Object.entries(ROLE_URL_VARS).length === 3
  && ROLE_URL_VARS.DATABASE_URL_APP === "fm_app"
  && ROLE_URL_VARS.DATABASE_URL_AUTH === "fm_auth"
  && ROLE_URL_VARS.DATABASE_URL_SYSTEM === "fm_system");

// ── the authoritative half: the URL may lie, the server may not ──────────────
void (async () => {
  const fake = (row: Record<string, unknown> | null) => ({
    $queryRawUnsafe: async <T,>() => (row ? [row] : []) as T,
  });

  const good = await verifyAuthority("DATABASE_URL_APP", "fm_app",
    fake({ who: "fm_app", super: false, bypass: false, owned: 0n }));
  check("a correct fm_app connection verifies", good.ok, JSON.stringify(good.problems));

  const impostor = await verifyAuthority("DATABASE_URL_APP", "fm_app",
    fake({ who: "postgres", super: false, bypass: true, owned: 56n }));
  check("a URL labelled fm_app that authenticates as postgres is CAUGHT",
    !impostor.ok && impostor.problems.length === 3,
    JSON.stringify(impostor.problems));

  const bypass = await verifyAuthority("DATABASE_URL_APP", "fm_app",
    fake({ who: "fm_app", super: false, bypass: true, owned: 0n }));
  check("fm_app with BYPASSRLS is CAUGHT (the policies would be inert)",
    !bypass.ok && /BYPASSRLS/.test(bypass.problems.join()));

  const owner = await verifyAuthority("DATABASE_URL_APP", "fm_app",
    fake({ who: "fm_app", super: false, bypass: false, owned: 41n }));
  check("fm_app owning protected tables is CAUGHT (owners are exempt without FORCE)",
    !owner.ok && /OWNS 41/.test(owner.problems.join()));

  const unreachable = await verifyAuthority("DATABASE_URL_APP", "fm_app",
    { $queryRawUnsafe: async () => { throw new Error("connection refused"); } });
  check("an uninterrogable connection FAILS rather than passing by default",
    !unreachable.ok && /could not be interrogated/.test(unreachable.problems.join()));

  if (failures > 0) { console.error(`\nstrict-mode: ${failures} failure(s).`); process.exit(1); }
  console.log("\nstrict-mode: all passed.");
})();
