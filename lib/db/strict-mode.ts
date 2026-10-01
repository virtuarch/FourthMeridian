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

export type StrictConfigProblem = { variable: string; reason: string };

/**
 * Configuration-level verdict. Pure, so CI can assert it without a database.
 */
export function strictConfigProblems(env: NodeJS.ProcessEnv = process.env): StrictConfigProblem[] {
  if (!strictRlsEnabled(env)) return [];
  const problems: StrictConfigProblem[] = [];

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
    if (who !== expected) {
      problems.push({ variable: v, reason: `names "${who}" but must authenticate as "${expected}".` });
    }
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
      `${STRICT_ENV}=true, but the database role configuration is not safe to run under:`,
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

  try {
    const rows = await client.$queryRawUnsafe<Array<{
      who: string; super: boolean; bypass: boolean; owned: bigint;
    }>>(`
      SELECT current_user                                        AS who,
             r.rolsuper                                          AS super,
             r.rolbypassrls                                      AS bypass,
             (SELECT count(*) FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = 'public' AND c.relkind = 'r'
                 AND c.relowner = r.oid)                         AS owned
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

      if (actual !== expected)   problems.push(`authenticates as "${actual}", not "${expected}".`);
      if (superuser)             problems.push(`is a SUPERUSER, so no policy constrains it.`);
      if (bypassRls)             problems.push(`carries BYPASSRLS, so every policy is inert for it.`);
      if (ownedTables && ownedTables > 0) {
        problems.push(`OWNS ${ownedTables} table(s) in public; an owner is exempt from its own tables' policies unless FORCE is set.`);
      }
    }
  } catch (e) {
    problems.push(`could not be interrogated: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { variable, expected, actual, superuser, bypassRls, ownedTables, ok: problems.length === 0, problems };
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
