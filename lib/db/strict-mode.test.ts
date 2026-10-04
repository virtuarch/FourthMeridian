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
  rolePrincipalProblem, isSupabasePoolerHost, splitPrincipal, migrationProjectRef,
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
} as unknown as NodeJS.ProcessEnv;

// ── the flag is opt-in and exact ─────────────────────────────────────────────
check("strict is OFF when unset", !strictRlsEnabled({} as NodeJS.ProcessEnv));
check("strict is OFF for 'True', '1', 'yes' — only the exact string arms it",
  !strictRlsEnabled({ FM_RLS_STRICT: "True" } as unknown as NodeJS.ProcessEnv) &&
  !strictRlsEnabled({ FM_RLS_STRICT: "1" } as unknown as NodeJS.ProcessEnv) &&
  !strictRlsEnabled({ FM_RLS_STRICT: "yes" } as unknown as NodeJS.ProcessEnv));
check("strict is ON for exactly 'true'", strictRlsEnabled({ FM_RLS_STRICT: "true" } as unknown as NodeJS.ProcessEnv));

// ── fallback survives only while strict is OFF ───────────────────────────────
check("with strict OFF, a missing role URL is NOT a problem (adoption fallback)",
  strictConfigProblems({} as NodeJS.ProcessEnv).length === 0);

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

// ── THE POOLER SPELLING (RLS-PREP-A) ─────────────────────────────────────────
// `<role>.<project-ref>` is how Supabase's shared pooler is addressed. It is a
// routing form, and it must be accepted as EXACTLY that and nothing looser.
{
  const REF   = "abcdefghijklmnopqrst";           // 20 lowercase alphanumerics
  const OTHER = "zyxwvutsrqponmlkjihg";
  const POOL  = "aws-0-ap-southeast-1.pooler.supabase.com";
  const pooled = (ref = REF) => ({
    FM_RLS_STRICT: "true",
    DATABASE_URL:        `postgresql://postgres.${ref}:x@${POOL}:6543/postgres?pgbouncer=true`,
    DATABASE_URL_APP:    `postgresql://fm_app.${ref}:x@${POOL}:6543/postgres?pgbouncer=true`,
    DATABASE_URL_AUTH:   `postgresql://fm_auth.${ref}:x@${POOL}:6543/postgres?pgbouncer=true`,
    DATABASE_URL_SYSTEM: `postgresql://fm_system.${ref}:x@${POOL}:6543/postgres?pgbouncer=true`,
  } as unknown as NodeJS.ProcessEnv);
  const withApp = (user: string, host = POOL) =>
    ({ ...pooled(), DATABASE_URL_APP: `postgresql://${user}:x@${host}:6543/postgres?pgbouncer=true` } as unknown as NodeJS.ProcessEnv);
  const refused = (env: NodeJS.ProcessEnv, pattern: RegExp) => {
    const p = strictConfigProblems(env);
    return p.length === 1 && p[0].variable === "DATABASE_URL_APP" && pattern.test(p[0].reason);
  };

  check("the pooler spelling <role>.<ref> on a Supabase pooler host is ACCEPTED",
    strictConfigProblems(pooled()).length === 0, JSON.stringify(strictConfigProblems(pooled())));
  check("…and so is the bare role on the same host (a dedicated pooler / options-routed connection)",
    strictConfigProblems(withApp("fm_app")).length === 0);
  check("the bare role on a direct host is ACCEPTED, as before",
    strictConfigProblems(GOOD).length === 0);

  check("a WRONG role in pooler form is REFUSED",
    refused(withApp(`fm_system.${REF}`), /must authenticate as "fm_app"/));
  check("the OWNER in pooler form is still the migration principal",
    refused(withApp(`postgres.${REF}`), /migration principal/));

  check("a PREFIX lookalike (fm_appx) is REFUSED — the role is matched whole, never by prefix",
    refused(withApp("fm_appx"), /must authenticate as "fm_app"/));
  check("a prefix lookalike in pooler form (fm_app2.<ref>) is REFUSED",
    refused(withApp(`fm_app2.${REF}`), /must authenticate as "fm_app"/));
  check("an UPPER-CASE role is REFUSED (role names are compared exactly)",
    refused(withApp(`FM_APP.${REF}`), /must authenticate as "fm_app"/));
  check("a suffix that is not a project reference (fm_app.postgres) is REFUSED",
    refused(withApp("fm_app.postgres"), /not a project reference/));
  check("a trailing dot (fm_app.) is REFUSED, not read as the bare role",
    refused(withApp("fm_app."), /not a project reference/));
  check("a second dot (fm_app.<ref>.x) is REFUSED",
    refused(withApp(`fm_app.${REF}.x`), /not a project reference/));

  check("the pooler spelling on a NON-pooler host is REFUSED (there the dot is a literal role name)",
    refused(withApp(`fm_app.${REF}`, "db.internal.example"), /not a Supabase pooler/));
  check("a host that merely CONTAINS the pooler domain is not a pooler host",
    !isSupabasePoolerHost("pooler.supabase.com.evil.example") && !isSupabasePoolerHost("evilpooler.supabase.com.x")
    && isSupabasePoolerHost("aws-0-ap-southeast-1.pooler.supabase.com") && !isSupabasePoolerHost(null));

  check("a role URL routed to a DIFFERENT project than DATABASE_URL is REFUSED",
    refused(withApp(`fm_app.${OTHER}`), /DIFFERENT project/));
  check("…and the message never contains the other project's reference",
    !strictConfigProblems(withApp(`fm_app.${OTHER}`))[0].reason.includes(OTHER));
  check("with a direct DATABASE_URL there is no project to compare, and the suffix rules still hold",
    rolePrincipalProblem(`fm_app.${REF}`, POOL, "fm_app", null) === null
    && rolePrincipalProblem(`fm_app.${REF}`, "h", "fm_app", null) !== null);

  check("splitPrincipal splits at the FIRST dot and keeps a trailing dot visible",
    splitPrincipal("fm_app").tenantRef === null
    && splitPrincipal("fm_app.").tenantRef === ""
    && splitPrincipal(`fm_app.${REF}.x`).tenantRef === `${REF}.x`);
  check("migrationProjectRef reads the project only from the pooler form of the OWNER url",
    migrationProjectRef(pooled()) === REF
    && migrationProjectRef(GOOD) === null
    && migrationProjectRef({ DATABASE_URL: "postgresql://fintracker:x@localhost:5432/d" } as unknown as NodeJS.ProcessEnv) === null);

  // The missing-URL rule does not soften for the pooler form.
  const missing = pooled(); delete missing.DATABASE_URL_SYSTEM;
  check("a missing role URL is still a refusal to boot in a pooled environment",
    strictConfigProblems(missing).length === 1 && strictConfigProblems(missing)[0].variable === "DATABASE_URL_SYSTEM");

  // With strict OFF none of this is examined: the adoption fallback is intact.
  const off = withApp("postgres"); delete off.FM_RLS_STRICT;
  check("with strict OFF an unsafe role URL is NOT a boot problem (adoption fallback, by design)",
    strictConfigProblems(off).length === 0);
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
    fake({ who: "fm_app", super: false, bypass: false, owned: BigInt(0), member_of: [] }));
  check("a correct fm_app connection verifies", good.ok, JSON.stringify(good.problems));

  const impostor = await verifyAuthority("DATABASE_URL_APP", "fm_app",
    fake({ who: "postgres", super: false, bypass: true, owned: BigInt(56), member_of: [] }));
  check("a URL labelled fm_app that authenticates as postgres is CAUGHT",
    !impostor.ok && impostor.problems.length === 3,
    JSON.stringify(impostor.problems));

  const bypass = await verifyAuthority("DATABASE_URL_APP", "fm_app",
    fake({ who: "fm_app", super: false, bypass: true, owned: BigInt(0), member_of: [] }));
  check("fm_app with BYPASSRLS is CAUGHT (the policies would be inert)",
    !bypass.ok && /BYPASSRLS/.test(bypass.problems.join()));

  const owner = await verifyAuthority("DATABASE_URL_APP", "fm_app",
    fake({ who: "fm_app", super: false, bypass: false, owned: BigInt(41), member_of: [] }));
  check("fm_app owning protected tables is CAUGHT (owners are exempt without FORCE)",
    !owner.ok && /OWNS 41/.test(owner.problems.join()));

  const member = await verifyAuthority("DATABASE_URL_APP", "fm_app",
    fake({ who: "fm_app", super: false, bypass: false, owned: BigInt(0), member_of: ["postgres"] }));
  check("fm_app that is a MEMBER of another role is CAUGHT (SET ROLE is one statement away)",
    !member.ok && /MEMBER of 1/.test(member.problems.join()) && !/postgres/.test(member.problems.join()));

  const unknownMembership = await verifyAuthority("DATABASE_URL_APP", "fm_app",
    fake({ who: "fm_app", super: false, bypass: false, owned: BigInt(0) }));
  check("a connection whose role membership cannot be read FAILS rather than passing by default",
    !unknownMembership.ok && /membership could not be read/.test(unknownMembership.problems.join()));

  const unreachable = await verifyAuthority("DATABASE_URL_APP", "fm_app",
    { $queryRawUnsafe: async () => { throw new Error("connection refused"); } });
  check("an uninterrogable connection FAILS rather than passing by default",
    !unreachable.ok && /could not be interrogated/.test(unreachable.problems.join()));

  if (failures > 0) { console.error(`\nstrict-mode: ${failures} failure(s).`); process.exit(1); }
  console.log("\nstrict-mode: all passed.");
})();
