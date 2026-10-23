/**
 * lib/db/strict-mode.ts  (RLS-4)
 *
 * MAKES "RLS IS ON" A CLAIM THE DEPLOYMENT HAS TO EARN.
 *
 * During adoption the role clients fall back to the shared client when their
 * URLs are unset, so the code can land ahead of the credentials. That fallback
 * is useful and it is also the most dangerous thing in the design, because it
 * produces exactly one bad state:
 *
 *     RLS_STRICT=true, DATABASE_URL_APP missing, so quietly use postgres.
 *
 * A deployment in that state believes it has tenant isolation, passes every
 * application test, and has none — because `postgres` carries BYPASSRLS and
 * sails through every policy. Nothing in the running system would say so.
 *
 * This module removes that state. When strict mode is declared, a missing or
 * unsafe role URL is a REFUSAL TO BOOT, not a downgrade.
 *
 * Two checks, deliberately separate:
 *
 *   assertStrictRoleConfiguration()  synchronous, at module load. Can only see
 *                                    configuration — are the URLs present, and
 *                                    do they name a principal other than the
 *                                    migration role. Cheap, and it runs before
 *                                    a single query is possible.
 *
 *   verifyDbAuthorities()            asynchronous, queries each connection and
 *                                    asks the DATABASE who it is. This is the
 *                                    authoritative check: a URL can claim
 *                                    anything, only `current_user` is true.
 *
 * The split matters. Configuration is checkable at boot but forgeable; identity
 * is authoritative but needs a round trip. Doing only the first would let a URL
 * labelled fm_app authenticate as postgres. Doing only the second would let a
 * misconfigured process serve requests until something happened to call it.
 *
 * ── THE USERNAME IS A CLAIM ABOUT A ROLE, NOT THE ROLE (RLS-PREP-A) ──────────
 * The first version of the configuration half compared the URL username to the
 * role name with `!==`. That is right for a DIRECT connection and wrong for a
 * multi-tenant pooler, where the username carries the pooler's own routing:
 * Supabase's shared pooler (Supavisor) is addressed as `<role>.<project-ref>`,
 * which is why `postgres.<ref>` was already special-cased below. Under the
 * literal comparison a correctly provisioned pooled `fm_app.<ref>` was a
 * REFUSAL TO BOOT, and the only spelling that booted (`fm_app`) is one the
 * shared pooler cannot route by username alone.
 *
 * The fix is NOT "accept anything that starts with the role name". The invariant
 * the configuration half can actually hold is narrower, and it is stated as a
 * grammar rather than a prefix:
 *
 *     <role>                       exactly the expected role, nothing appended
 *     <role>.<ref>                 ONLY when the host is a Supabase pooler host,
 *                                  <ref> has the shape of a project reference,
 *                                  and it is the SAME project DATABASE_URL names
 *
 * Everything else — `fm_appx`, `fm_app.postgres`, `fm_app.a.b`, `fm_app.` , a
 * suffixed name on a host that is not that pooler (where the dot would be part
 * of a literal role name), or a suffix naming a different project than the
 * migration URL — is refused. The same-project rule is the one check here that
 * is about more than spelling: a role URL that authenticates correctly against
 * SOMEBODY ELSE'S database is a correctly spelled catastrophe.
 *
 * ⚠️ WHAT THIS FILE DOES NOT KNOW. That Supavisor routes a CUSTOM role as
 * `<role>.<ref>` is the documented convention and is consistent with the
 * `postgres.<ref>` form this deployment already uses, but nothing in this
 * repository can prove a provider's behaviour. It is recorded as CHECK REQUIRED
 * in docs/operations/rls-preview-cutover.md, and it does not need to be taken on
 * trust: whichever spelling the pooler accepts, the AUTHORITATIVE half asks the
 * server `current_user`, and that answer carries no suffix. A wrong guess here
 * costs a failed boot or a failed login. It cannot cost isolation.
 */

const STRICT_ENV = "FM_RLS_STRICT";

/** Role URLs, and the principal each must authenticate as. */
export const ROLE_URL_VARS = {
  DATABASE_URL_APP:    "fm_app",
  DATABASE_URL_AUTH:   "fm_auth",
  DATABASE_URL_SYSTEM: "fm_system",
} as const;

export type RoleUrlVar = keyof typeof ROLE_URL_VARS;

/** Strict mode is OFF unless explicitly and exactly enabled. */
export function strictRlsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[STRICT_ENV] === "true";
}

/**
 * PRODUCTION REQUIRES STRICT MODE (launch-readiness, 2026-10-06).
 *
 * The adoption fallback above exists so code can land before credentials. In
 * Production that window is closed: a Production process without strict mode is
 * one missing variable away from running every tenant query as `postgres`
 * (BYPASSRLS) while looking healthy. So on a Vercel Production deployment the
 * flag is not optional — absent, "false", "TRUE", "1" or anything other than the
 * exact string "true" is a refusal to start, and the role URLs are validated
 * whatever the flag says.
 *
 * `VERCEL_ENV` is the authority on Vercel (lib/env.ts); Preview and local
 * development keep their current behaviour.
 */
export function productionRequiresStrict(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VERCEL_ENV === "production";
}

/** The username in a connection string, or null. Never returns the password. */
export function principalOf(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return decodeURIComponent(u.username) || null;
  } catch {
    return null;
  }
}

/**
 * Supabase authenticates the pooler as `postgres.<project-ref>`, which IS the
 * `postgres` role. A URL naming that is the migration principal, not a runtime
 * one, and must never be accepted as a role URL in strict mode.
 */
export function isMigrationPrincipal(user: string | null): boolean {
  if (!user) return false;
  return user === "postgres" || user.startsWith("postgres.") || user === "supabase_admin";
}

/** The host in a connection string, lower-cased, or null. */
export function hostOf(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * A Supabase pooler host. The ONLY place a `<role>.<ref>` username is a routing
 * instruction rather than a literal role name. Anchored on the registrable
 * suffix so `pooler.supabase.com.evil.example` does not qualify.
 */
export function isSupabasePoolerHost(host: string | null): boolean {
  return host !== null && /(^|\.)pooler\.supabase\.com$/.test(host);
}

/** The shape of a Supabase project reference: 20 lowercase alphanumerics. */
const PROJECT_REF = /^[a-z0-9]{20}$/;

/**
 * Split a pooler-style username at its FIRST dot. `tenantRef` is null when there
 * is no dot at all; it is the empty string for a trailing dot, which is a
 * malformed name and must not be mistaken for "no suffix".
 */
export function splitPrincipal(user: string): { role: string; tenantRef: string | null } {
  const i = user.indexOf(".");
  return i === -1
    ? { role: user, tenantRef: null }
    : { role: user.slice(0, i), tenantRef: user.slice(i + 1) };
}

/**
 * The project reference DATABASE_URL names, when it is in pooler form
 * (`postgres.<ref>`). Null when it is not — a direct URL names no project in its
 * username, and then there is nothing to hold a role URL's suffix against.
 */
export function migrationProjectRef(env: NodeJS.ProcessEnv = process.env): string | null {
  const who = principalOf(env.DATABASE_URL);
  if (!who) return null;
  const { role, tenantRef } = splitPrincipal(who);
  return role === "postgres" && tenantRef !== null && PROJECT_REF.test(tenantRef) ? tenantRef : null;
}

/**
 * Why a role URL's username is NOT an acceptable spelling of `expected`, or null
 * when it is. Pure. See the module header for the grammar and its limits.
 */
export function rolePrincipalProblem(
  who: string,
  host: string | null,
  expected: string,
  expectedProjectRef: string | null,
): string | null {
  const { role, tenantRef } = splitPrincipal(who);
  if (role !== expected) {
    return `names "${who}" but must authenticate as "${expected}".`;
  }
  if (tenantRef === null) return null; // the bare role: a direct or dedicated-pooler connection
  if (!PROJECT_REF.test(tenantRef)) {
    return `names "${who}": the part after "${expected}." is not a project reference, so this is not a pooler spelling of "${expected}" — it is a different name.`;
  }
  if (!isSupabasePoolerHost(host)) {
    return `names "${who}" on a host that is not a Supabase pooler. A "<role>.<ref>" username is only a routing form there; anywhere else the dot is part of a literal role name that is not "${expected}".`;
  }
  if (expectedProjectRef !== null && tenantRef !== expectedProjectRef) {
    return `routes to a DIFFERENT project than DATABASE_URL. A runtime role and the migration principal must name the same database.`;
  }
  return null;
}

export type StrictConfigProblem = { variable: string; reason: string };

/**
 * Configuration-level verdict. Pure, so CI can assert it without a database.
 */
export function strictConfigProblems(env: NodeJS.ProcessEnv = process.env): StrictConfigProblem[] {
  const production = productionRequiresStrict(env);
  if (!strictRlsEnabled(env) && !production) return [];
  const problems: StrictConfigProblem[] = [];
  if (production && !strictRlsEnabled(env)) {
    const raw = env[STRICT_ENV];
    problems.push({
      variable: STRICT_ENV,
      reason: `is ${raw === undefined ? "unset" : `"${raw}"`} on a Production deployment (VERCEL_ENV=production). Production must run with ${STRICT_ENV}=true exactly: without it a missing role URL silently falls back to the migration principal, which carries BYPASSRLS.`,
    });
  }
  const projectRef = migrationProjectRef(env);

  for (const [v, expected] of Object.entries(ROLE_URL_VARS) as [RoleUrlVar, string][]) {
    const raw = env[v];
    if (!raw) {
      problems.push({ variable: v, reason: `is not set. Strict RLS mode will not fall back to the migration principal — that fallback is precisely the state this mode exists to forbid.` });
      continue;
    }
    const who = principalOf(raw);
    if (who === null) {
      problems.push({ variable: v, reason: "could not be parsed as a connection URL, so its principal cannot be established." });
      continue;
    }
    if (isMigrationPrincipal(who)) {
      problems.push({ variable: v, reason: `names the migration principal "${who}". That role owns the tables and carries BYPASSRLS, so every policy would be inert.` });
      continue;
    }
    const shape = rolePrincipalProblem(who, hostOf(raw), expected, projectRef);
    if (shape) problems.push({ variable: v, reason: shape });
  }
  return problems;
}

/**
 * Called at module load from lib/db.ts. Throws rather than returning, because
 * there is no safe way to continue: a process that reaches this and carries on
 * is the silent-postgres deployment.
 */
export function assertStrictRoleConfiguration(env: NodeJS.ProcessEnv = process.env): void {
  const problems = strictConfigProblems(env);
  if (problems.length === 0) return;
  throw new Error(
    [
      `${strictRlsEnabled(env) ? `${STRICT_ENV}=true, but the` : "Production requires strict RLS mode, and the"} database role configuration is not safe to run under:`,
      ...problems.map((p) => `  - ${p.variable} ${p.reason}`),
      "",
      "  Refusing to start. Either provision the role URLs, or unset",
      `  ${STRICT_ENV} and accept that this deployment has NO database-level`,
      "  tenant isolation.",
    ].join("\n"),
  );
}

// ── The authoritative half ───────────────────────────────────────────────────

export type AuthorityVerdict = {
  variable: string;
  expected: string;
  /** What the database says this connection actually is. */
  actual: string | null;
  superuser: boolean | null;
  bypassRls: boolean | null;
  /** Protected tables in `public` owned by this role. Must be zero. */
  ownedTables: number | null;
  /**
   * Roles this principal is a MEMBER of. Must be empty: BYPASSRLS is not
   * inherited, but membership is what `SET ROLE` needs, and a runtime role that
   * can become the owner has the owner's authority one statement away.
   */
  memberOf: string[] | null;
  ok: boolean;
  problems: string[];
};

type Queryable = { $queryRawUnsafe<T = unknown>(sql: string): Promise<T> };

/**
 * Ask a connection who it is. A URL can claim any principal; only the server
 * can answer. This is what CI and /api/health assert against.
 */
export async function verifyAuthority(
  variable: string,
  expected: string,
  client: Queryable,
): Promise<AuthorityVerdict> {
  const problems: string[] = [];
  let actual: string | null = null;
  let superuser: boolean | null = null;
  let bypassRls: boolean | null = null;
  let ownedTables: number | null = null;
  let memberOf: string[] | null = null;

  try {
    const rows = await client.$queryRawUnsafe<Array<{
      who: string; super: boolean; bypass: boolean; owned: bigint; member_of: string[] | null;
    }>>(`
      SELECT current_user                                        AS who,
             r.rolsuper                                          AS super,
             r.rolbypassrls                                      AS bypass,
             (SELECT count(*) FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = 'public' AND c.relkind = 'r'
                 AND c.relowner = r.oid)                         AS owned,
             (SELECT coalesce(array_agg(g.rolname::text ORDER BY g.rolname), ARRAY[]::text[])
                FROM pg_auth_members m
                JOIN pg_roles g ON g.oid = m.roleid
               WHERE m.member = r.oid)                           AS member_of
        FROM pg_roles r
       WHERE r.rolname = current_user
    `);
    const row = rows[0];
    if (!row) {
      problems.push("the connection returned no identity row.");
    } else {
      actual      = row.who;
      superuser   = row.super;
      bypassRls   = row.bypass;
      ownedTables = Number(row.owned);
      // Absent ⇒ unknown ⇒ a problem. A check that cannot be made is not passed.
      memberOf    = Array.isArray(row.member_of) ? row.member_of : null;

      if (actual !== expected)   problems.push(`authenticates as "${actual}", not "${expected}".`);
      if (superuser)             problems.push(`is a SUPERUSER, so no policy constrains it.`);
      if (bypassRls)             problems.push(`carries BYPASSRLS, so every policy is inert for it.`);
      if (ownedTables && ownedTables > 0) {
        problems.push(`OWNS ${ownedTables} table(s) in public; an owner is exempt from its own tables' policies unless FORCE is set.`);
      }
      if (memberOf === null) {
        problems.push(`role membership could not be read, so SET ROLE escalation cannot be ruled out.`);
      } else if (memberOf.length > 0) {
        problems.push(`is a MEMBER of ${memberOf.length} other role(s), so it can SET ROLE away from "${expected}".`);
      }
    }
  } catch (e) {
    problems.push(`could not be interrogated: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { variable, expected, actual, superuser, bypassRls, ownedTables, memberOf, ok: problems.length === 0, problems };
}

/**
 * Verify every configured role connection. Returns one verdict per role.
 * Callers decide severity: strict mode treats any failure as fatal, non-strict
 * reports it so a deployment can see that it is NOT protected.
 */
export async function verifyDbAuthorities(
  clients: Partial<Record<RoleUrlVar, Queryable>>,
): Promise<AuthorityVerdict[]> {
  const out: AuthorityVerdict[] = [];
  for (const [v, expected] of Object.entries(ROLE_URL_VARS) as [RoleUrlVar, string][]) {
    const client = clients[v];
    if (!client) continue;
    out.push(await verifyAuthority(v, expected, client));
  }
  return out;
}
