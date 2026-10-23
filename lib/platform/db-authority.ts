/**
 * lib/platform/db-authority.ts  (RLS-PREP-B)
 *
 * WHAT THIS DEPLOYMENT'S DATABASE CONNECTIONS ACTUALLY ARE.
 *
 * `FM_RLS_STRICT` and the three role URLs are CONFIGURATION, and configuration
 * is a claim. lib/db/strict-mode.ts checks the claim at boot — is each URL
 * present, and does its username spell the right role — and that check is
 * forgeable by construction: a URL can name `fm_app` and authenticate as a role
 * that carries BYPASSRLS, or owns the tables, or can `SET ROLE` to something
 * that does. Every one of those leaves the application working perfectly and
 * tenant isolation switched off, and nothing in a running system would say so.
 *
 * `verifyDbAuthorities()` has always been able to ask the SERVER instead. Until
 * this file its only callers were the acceptance suites, on throwaway
 * databases. So the one question a cutover has to answer —
 *
 *     "DATABASE_URL_APP looks like fm_app"
 *         versus
 *     "this deployed connection executes as a non-owner, NOBYPASSRLS fm_app"
 *
 * — could not be asked of a deployment at all. The runbook's verification step
 * had no tooling behind it. This is that tooling.
 *
 * ── WHY A ROUTE AND NOT A SCRIPT ─────────────────────────────────────────────
 * A script proves a CREDENTIAL. It runs on an operator's machine with whatever
 * URLs the operator exported, and says nothing about which clients the deployed
 * process bound — the exact gap scripts/lib/rls-harness.ts documents from the
 * day a suite printed "tenant principal verified: fm_app" while Prisma was
 * connected as the owner. Vercel's variables are also Sensitive and cannot be
 * read back, so a script could not even be handed the deployed values. The only
 * thing that can answer for the deployed binding is the deployed process.
 *
 * ── WHY IT IS NOT /api/health ────────────────────────────────────────────────
 * Health is unauthenticated and is polled. This names roles and reports
 * privilege posture; it is operator information behind the same Platform Ops
 * gate as every other operator read, with the live-revocation re-check.
 *
 * ── WHAT IT NEVER RETURNS ────────────────────────────────────────────────────
 * No connection string, no password, no host name, no project reference, no
 * environment value. A URL is reduced to four facts about its SHAPE (is it set,
 * its port, whether it asks for pgbouncer mode, and which username form it
 * uses), and the role names in the response are the three fixed names this
 * repository already publishes in its migrations.
 *
 * ── AUTHORITY ────────────────────────────────────────────────────────────────
 * Each role client is interrogated THROUGH ITSELF — that is the point — via
 * `configuredRoleClients()`, which returns only the clients that are genuinely
 * distinct from the legacy one. A fallback client is reported as NOT CONFIGURED
 * and is never queried: it would answer for the migration principal and make
 * the report lie. This module does not import `db`, `tenantDb`, `authDb` or
 * `systemDb`, so it adds nothing to the authority ratchet.
 */

import "server-only";

import {
  ROLE_URL_VARS,
  hostOf,
  isMigrationPrincipal,
  isSupabasePoolerHost,
  principalOf,
  splitPrincipal,
  strictConfigProblems,
  strictRlsEnabled,
  verifyAuthority,
  type AuthorityVerdict,
  type RoleUrlVar,
} from "@/lib/db/strict-mode";

/** Anything that can run one raw read. A role client, or a fake in a test. */
export type AuthorityProbeClient = {
  $queryRawUnsafe<T = unknown>(sql: string): Promise<T>;
};

/** The shape of a connection URL. Deliberately incapable of carrying its value. */
export interface ConnectionShape {
  configured: boolean;
  /** "bare" = `<role>`; "pooler" = `<role>.<ref>`; "unparseable"; null when unset. */
  usernameForm: "bare" | "pooler" | "unparseable" | null;
  port: string | null;
  /** True when the URL asks Prisma for pgbouncer (transaction-pooler) mode. */
  pgbouncer: boolean | null;
  /** True when the host is a Supabase pooler host. Never the host itself. */
  supabasePoolerHost: boolean | null;
}

export interface RoleAuthorityReport {
  variable: RoleUrlVar;
  expectedRole: string;
  /** A distinct client was constructed for this role (not the legacy fallback). */
  bound: boolean;
  shape: ConnectionShape;
  /** What the SERVER said. Null when the role is not bound — it is never guessed. */
  verdict: Omit<AuthorityVerdict, "variable" | "expected"> | null;
  /** Problems a correct cutover does not have. Empty ⇒ this role is as intended. */
  problems: string[];
}

export interface TenantChannelReport {
  /** Inside a tenant transaction, `app.user_id` reads back as the bound identity. */
  boundInsideTransaction: boolean | null;
  /** Bare statements on the tenant client that carried a leftover identity. Must be 0. */
  residueObserved: number | null;
  /** How many bare statements were sampled for residue. */
  residueSamples: number;
  problems: string[];
}

export interface RlsPostureReport {
  publicTables: number | null;
  rlsEnabled: number | null;
  rlsForced: number | null;
  policies: number | null;
  problems: string[];
}

export interface DbAuthorityReport {
  /** The single answer: every role is bound, verified, and the channel is clean. */
  ok: boolean;
  checkedAt: string;
  strict: boolean;
  /** Boot-time configuration problems, as strict mode would state them. */
  configProblems: { variable: string; reason: string }[];
  /** The legacy client's configured principal class. Never queried. */
  legacyClient: { configured: boolean; migrationPrincipal: boolean | null };
  roles: RoleAuthorityReport[];
  tenantChannel: TenantChannelReport;
  rls: RlsPostureReport;
}

/** Reduce a URL to its shape. Never returns, logs or throws any part of the value. */
export function connectionShape(raw: string | undefined): ConnectionShape {
  if (!raw) return { configured: false, usernameForm: null, port: null, pgbouncer: null, supabasePoolerHost: null };
  try {
    const u = new URL(raw);
    const who = principalOf(raw);
    return {
      configured: true,
      usernameForm: who === null ? "unparseable" : splitPrincipal(who).tenantRef === null ? "bare" : "pooler",
      port: u.port || null,
      pgbouncer: u.searchParams.get("pgbouncer") === "true",
      supabasePoolerHost: isSupabasePoolerHost(hostOf(raw)),
    };
  } catch {
    return { configured: true, usernameForm: "unparseable", port: null, pgbouncer: null, supabasePoolerHost: null };
  }
}

/** How many bare statements are sampled for a leftover identity. */
export const RESIDUE_SAMPLES = 8;

export interface DbAuthorityDeps {
  env: NodeJS.ProcessEnv;
  /** Only the clients that are genuinely distinct — see `configuredRoleClients()`. */
  clients: Partial<Record<RoleUrlVar, AuthorityProbeClient>>;
  /**
   * Run `fn` in a tenant transaction bound to `userId` and return what
   * `app.user_id` reads back as. Injected so this stays testable without a
   * database, and so the probe uses the REAL channel rather than a copy of it.
   */
  readIdentityInsideTenantTransaction: (userId: string) => Promise<string | null>;
  /** The operator's own id — the only identity this probe ever binds. */
  probeUserId: string;
  now?: Date;
}

const IDENTITY_SQL = `SELECT nullif(current_setting('app.user_id', true), '') AS v`;

const POSTURE_SQL = `
  SELECT count(*)::int                                          AS tables,
         count(*) FILTER (WHERE c.relrowsecurity)::int          AS enabled,
         count(*) FILTER (WHERE c.relforcerowsecurity)::int     AS forced,
         (SELECT count(*)::int FROM pg_policy p
            JOIN pg_class pc ON pc.oid = p.polrelid
            JOIN pg_namespace pn ON pn.oid = pc.relnamespace
           WHERE pn.nspname = 'public')                         AS policies
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> '_prisma_migrations'
`;

/**
 * Assemble the report. Never throws: a probe that cannot run is a PROBLEM in the
 * report, because "the verifier crashed" must not read as "nothing was wrong".
 */
export async function buildDbAuthorityReport(deps: DbAuthorityDeps): Promise<DbAuthorityReport> {
  const { env, clients } = deps;
  const strict = strictRlsEnabled(env);

  // ── each role, asked through its own connection ────────────────────────────
  const roles: RoleAuthorityReport[] = [];
  for (const [variable, expectedRole] of Object.entries(ROLE_URL_VARS) as [RoleUrlVar, string][]) {
    const shape = connectionShape(env[variable]);
    const client = clients[variable];
    const problems: string[] = [];
    let verdict: RoleAuthorityReport["verdict"] = null;

    if (!client) {
      problems.push(
        `no distinct ${expectedRole} client is bound. This path executes through the legacy client, i.e. as the migration principal, and no policy constrains it.`,
      );
    } else {
      const v = await verifyAuthority(variable, expectedRole, client);
      verdict = {
        actual: v.actual, superuser: v.superuser, bypassRls: v.bypassRls,
        ownedTables: v.ownedTables, memberOf: v.memberOf, ok: v.ok, problems: v.problems,
      };
      problems.push(...v.problems);
      // A pooled URL that does not ask for pgbouncer mode will fail on prepared
      // statements under a transaction pooler — an availability problem, stated
      // here because the boot check deliberately looks only at the username.
      if (shape.supabasePoolerHost && shape.pgbouncer === false) {
        problems.push(`targets a Supabase pooler without pgbouncer=true; prepared statements will fail in transaction mode.`);
      }
    }
    roles.push({ variable, expectedRole, bound: Boolean(client), shape, verdict, problems });
  }

  // ── the tenant channel ─────────────────────────────────────────────────────
  const tenantChannel: TenantChannelReport = {
    boundInsideTransaction: null, residueObserved: null, residueSamples: RESIDUE_SAMPLES, problems: [],
  };
  const app = clients.DATABASE_URL_APP;
  if (!app) {
    tenantChannel.problems.push("not probed: no distinct fm_app client is bound.");
  } else {
    try {
      const inside = await deps.readIdentityInsideTenantTransaction(deps.probeUserId);
      tenantChannel.boundInsideTransaction = inside === deps.probeUserId;
      if (!tenantChannel.boundInsideTransaction) {
        tenantChannel.problems.push("inside a tenant transaction, app.user_id did not read back as the bound identity.");
      }
      // ⚠️ AFTER the transaction above has committed, on the SAME client. A
      // session-level setting would still be on the pooled connection it used;
      // a transaction-local one cannot be. Sampled several times because the
      // pool hands out more than one connection.
      let residue = 0;
      for (let i = 0; i < RESIDUE_SAMPLES; i++) {
        const rows = await app.$queryRawUnsafe<Array<{ v: string | null }>>(IDENTITY_SQL);
        if (rows[0]?.v) residue++;
      }
      tenantChannel.residueObserved = residue;
      if (residue > 0) {
        tenantChannel.problems.push(
          `${residue} of ${RESIDUE_SAMPLES} bare statements carried a LEFTOVER identity. app.user_id is surviving the transaction that set it — a cross-tenant disclosure path.`,
        );
      }
    } catch (e) {
      tenantChannel.problems.push(`could not be probed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── the installed policies, as the tenant role sees the catalog ────────────
  const rls: RlsPostureReport = { publicTables: null, rlsEnabled: null, rlsForced: null, policies: null, problems: [] };
  if (app) {
    try {
      const rows = await app.$queryRawUnsafe<Array<{ tables: number; enabled: number; forced: number; policies: number }>>(POSTURE_SQL);
      const r = rows[0];
      if (r) {
        rls.publicTables = Number(r.tables); rls.rlsEnabled = Number(r.enabled);
        rls.rlsForced = Number(r.forced);    rls.policies = Number(r.policies);
        if (rls.policies === 0) rls.problems.push("no row-level-security policy exists in public; the RLS migrations are not applied.");
        if (rls.rlsEnabled !== rls.rlsForced) rls.problems.push("some tables have RLS enabled but not FORCED; their owner is exempt.");
      }
    } catch (e) {
      rls.problems.push(`could not be read: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    rls.problems.push("not read: no distinct fm_app client is bound.");
  }

  const legacyWho = principalOf(env.DATABASE_URL);
  const ok =
    strict &&
    roles.every((r) => r.bound && r.problems.length === 0) &&
    tenantChannel.problems.length === 0 &&
    rls.problems.length === 0;

  return {
    ok,
    checkedAt: (deps.now ?? new Date()).toISOString(),
    strict,
    configProblems: strictConfigProblems(env),
    legacyClient: {
      configured: Boolean(env.DATABASE_URL),
      migrationPrincipal: legacyWho === null ? null : isMigrationPrincipal(legacyWho),
    },
    roles,
    tenantChannel,
    rls,
  };
}

/** The deployed process's own report. The route's only call. */
export async function getDbAuthorityReport(probeUserId: string): Promise<DbAuthorityReport> {
  const { configuredRoleClients } = await import("@/lib/db");
  const { withTenantDb, currentTenantIdentity } = await import("@/lib/db/tenant-context");
  return buildDbAuthorityReport({
    env: process.env,
    clients: configuredRoleClients(),
    probeUserId,
    readIdentityInsideTenantTransaction: (userId) => withTenantDb(userId, (tx) => currentTenantIdentity(tx)),
  });
}
