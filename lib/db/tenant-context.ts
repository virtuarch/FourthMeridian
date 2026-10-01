/**
 * lib/db/tenant-context.ts  (RLS-2)
 *
 * THE TRUSTED REQUEST IDENTITY CHANNEL.
 *
 * PostgreSQL policies decide what a query may see by reading one setting,
 * `app.user_id`. This module is the only thing that sets it, and it is the only
 * supported way to reach the tenant database role.
 *
 * ── WHY SET LOCAL, AND WHY PLAIN `SET` IS FORBIDDEN ──────────────────────────
 * Production connects through the Supabase Transaction Pooler (pgbouncer in
 * transaction mode). A server connection is handed back to the pool after every
 * transaction, so a SESSION-level setting outlives the request that set it and
 * is inherited by whichever tenant borrows that connection next. That is not a
 * bug class we are guarding against in theory — it is the single most likely way
 * to turn an isolation feature into a cross-tenant disclosure.
 *
 * `SET LOCAL` is scoped to the enclosing transaction and is discarded at COMMIT
 * *and* at ROLLBACK. The rollback half matters as much as the commit half: it is
 * what guarantees a FAILED transaction leaves no identity residue on a recycled
 * connection. Both are asserted in scripts/rls-acceptance.ts (cases 21-23).
 *
 * Consequence, stated plainly: tenant-scoped database access MUST happen inside
 * an interactive transaction. There is nowhere else a transaction-local setting
 * can live.
 *
 * ── WHY set_config() AND NOT A `SET LOCAL` STRING ────────────────────────────
 * `SET LOCAL app.user_id = $1` is not parameterisable — SET does not take bind
 * parameters — so expressing it as SQL would mean interpolating an identifier
 * into a statement. `set_config(name, value, is_local := true)` is an ordinary
 * function call, so the value is bound, and an identity can never be a SQL
 * injection site.
 *
 * ── WHERE THE IDENTITY COMES FROM ────────────────────────────────────────────
 * The caller passes a user id taken from SERVER-SIDE AUTHENTICATED SESSION STATE
 * and nothing else. Never a request body, query string, client header, the
 * active-Space cookie, or any client-supplied metadata. Space scope is NOT
 * passed in at all — the policies derive it from SpaceMember, so a stale or
 * tampered cookie cannot widen what a query can reach.
 */

import "server-only";

import type { Prisma, PrismaClient } from "@prisma/client";

import { tenantDb, activeDbRoles } from "@/lib/db";

/** The setting the policies read. Must match the migration. */
export const TENANT_GUC = "app.user_id";

/** A transaction-scoped client whose statements carry a tenant identity. */
export type TenantClient = Prisma.TransactionClient;

export class TenantIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantIdentityError";
  }
}

/**
 * Run `fn` against the tenant database role with `userId` bound as the request
 * identity for the duration of ONE transaction.
 *
 * Everything `fn` does is subject to row-level security. A query inside it that
 * forgets its application-level tenant predicate returns the caller's rows and
 * nothing else, rather than the whole platform's.
 *
 * Throws rather than running unidentified: an empty identity would make every
 * policy evaluate false and yield silent empty result sets, which this codebase
 * cannot distinguish from "no data". Failing loudly is the whole point.
 */
export async function withTenantDb<T>(
  userId: string,
  fn: (tx: TenantClient) => Promise<T>,
  opts?: { timeout?: number; maxWait?: number },
): Promise<T> {
  if (typeof userId !== "string" || userId.length === 0) {
    throw new TenantIdentityError(
      "withTenantDb called without a user id. The identity must come from server-side session state; refusing to run a tenant query with no identity.",
    );
  }

  return (tenantDb as PrismaClient).$transaction(
    async (tx) => {
      // is_local = true. See the header: this is the whole security property.
      await tx.$executeRaw`SELECT set_config(${TENANT_GUC}, ${userId}, true)`;
      return fn(tx);
    },
    opts,
  );
}

/**
 * Read back the identity in force. Exists so a test or a diagnostic can prove
 * the channel works end to end rather than trusting that it does.
 */
export async function currentTenantIdentity(tx: TenantClient): Promise<string | null> {
  const rows = await tx.$queryRaw<Array<{ v: string | null }>>`
    SELECT nullif(current_setting(${TENANT_GUC}, true), '') AS v
  `;
  return rows[0]?.v ?? null;
}

/**
 * True when the deployment actually has a distinct fm_app client. False means
 * tenantDb has fallen back to the shared legacy client, so the policies are not
 * yet being exercised by this process — a thing to surface, never to assume.
 */
export function tenantRoleIsActive(): boolean {
  return activeDbRoles().app;
}
