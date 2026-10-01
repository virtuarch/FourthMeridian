import { PrismaClient } from "@prisma/client";

import { runtimeDatasourceUrl, withConnectionLimit } from "@/lib/db/connection-url";
import { assertNonLiveDatabase } from "@/lib/db/live-guard";
import { assertStrictRoleConfiguration, strictRlsEnabled } from "@/lib/db/strict-mode";

// Prevent multiple Prisma Client instances in Next.js dev (hot-reload creates
// new module instances; without this guard you'd exhaust the connection pool).
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

// PROD-POOLER-AUTH-INCIDENT-1 — the runtime pool size is owned by
// lib/db/connection-url.ts, NOT by whatever `connection_limit` happens to be in
// the DATABASE_URL env var. Production and Preview both carried an accidental
// `connection_limit=1` (a local troubleshooting leftover), which under Vercel
// Fluid Compute serialised every concurrent request in a process onto ONE
// connection and produced P2024 pool timeouts. Host, port 6543 and
// `pgbouncer=true` are preserved exactly; only the pool size is normalised.
const datasourceUrl = runtimeDatasourceUrl();

// I1 — Slice 0. When `FM_DB_GUARD=clone-only` is set, this process may reach a
// clone and nothing else; anything it cannot identify as one is refused here,
// BEFORE a client exists, so a write-capable script cannot reach a query against
// live. Inert when the variable is unset, which is every ordinary runtime.
//
// ⚠️ IT CHECKS THE RESOLVED URL, NOT THE ENV FILE. An exported DATABASE_URL beats
// `--env-file`; that precedence is the mechanism behind the post-M1 incident, and
// a guard that read a file rather than the value in force would have missed it.
assertNonLiveDatabase(datasourceUrl ?? process.env.DATABASE_URL);

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
    // Omitted entirely when DATABASE_URL is unset, so Prisma still raises its
    // own (clearer) missing-configuration error rather than one from here.
    ...(datasourceUrl ? { datasources: { db: { url: datasourceUrl } } } : {}),
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}

// ── RLS-2 — ONE CLIENT PER DATABASE ROLE ─────────────────────────────────────
//
// Tenant isolation is enforced by PostgreSQL policies bound to the CONNECTING
// ROLE (prisma/migrations/*_rls_roles_and_policies). Three roles therefore need
// three clients, and which one a code path uses IS its authority:
//
//   tenantDb  fm_app     ordinary web requests. Subject to RLS. Only ever
//                        reached through withTenantDb(), which supplies the
//                        identity the policies read.
//   authDb    fm_auth    the PRE-IDENTITY path only — session validation and
//                        credential lookup, which must read User/UserSession
//                        BEFORE any app.user_id can exist. Granted three tables
//                        and no financial table at all.
//   systemDb  fm_system  cron, webhooks, ingestion, operator consoles. Reaches
//                        rows through role-scoped policies, NOT via BYPASSRLS.
//
// ⚠️ EVERY ONE FALLS BACK TO `db` WHEN ITS URL IS UNSET, and that is deliberate.
// Until an operator provisions the roles and their secrets, this module behaves
// exactly as it did before — so the code can land, be reviewed and run in CI
// ahead of the credential, instead of the credential and a large refactor
// having to arrive in the same change. The fallback is visible in
// activeDbRoles() so it can be asserted rather than assumed.
//
// `new PrismaClient` deliberately stays confined to THIS FILE: lib/db-safety.ts
// closes the set of files allowed to construct one, because each is a path
// around the clone guard above.

// RLS-4 — before any role client is built. In strict mode a missing or unsafe
// role URL is a refusal to boot, never a quiet downgrade to the migration
// principal. Inert when FM_RLS_STRICT is not exactly "true".
assertStrictRoleConfiguration();

function roleClient(envVar: string): PrismaClient | null {
  const raw = process.env[envVar];
  if (!raw) return null;
  const url = withConnectionLimit(raw);
  assertNonLiveDatabase(url ?? raw);
  return new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
    ...(url ? { datasources: { db: { url } } } : {}),
  });
}

const globalForRoles = globalThis as unknown as {
  fmTenant?: PrismaClient | null;
  fmAuth?:   PrismaClient | null;
  fmSystem?: PrismaClient | null;
};

const tenantClient = globalForRoles.fmTenant ?? roleClient("DATABASE_URL_APP");
const authClient   = globalForRoles.fmAuth   ?? roleClient("DATABASE_URL_AUTH");
const systemClient = globalForRoles.fmSystem ?? roleClient("DATABASE_URL_SYSTEM");

if (process.env.NODE_ENV !== "production") {
  globalForRoles.fmTenant = tenantClient;
  globalForRoles.fmAuth   = authClient;
  globalForRoles.fmSystem = systemClient;
}

/** fm_app. Do not query directly — go through withTenantDb(). */
export const tenantDb = tenantClient ?? db;
/** fm_auth. The pre-identity surface only. */
export const authDb   = authClient   ?? db;
/** fm_system. Background and operator work. */
export const systemDb = systemClient ?? db;

/**
 * Which role clients are actually distinct from the legacy shared client.
 * Lets a boot check, a test or an ops endpoint state the deployed posture
 * rather than infer it.
 */
export function activeDbRoles(): { app: boolean; auth: boolean; system: boolean } {
  return { app: tenantClient !== null, auth: authClient !== null, system: systemClient !== null };
}

/**
 * The role clients that are genuinely distinct, keyed by the variable that
 * configured them. Only these can be interrogated about their principal — a
 * fallback client would answer for the migration role and make the check lie.
 */
export function configuredRoleClients(): Partial<Record<
  "DATABASE_URL_APP" | "DATABASE_URL_AUTH" | "DATABASE_URL_SYSTEM", PrismaClient
>> {
  return {
    ...(tenantClient ? { DATABASE_URL_APP: tenantClient } : {}),
    ...(authClient   ? { DATABASE_URL_AUTH: authClient } : {}),
    ...(systemClient ? { DATABASE_URL_SYSTEM: systemClient } : {}),
  };
}

/** True when this process is declaring database-level tenant isolation. */
export const rlsStrict = strictRlsEnabled();
