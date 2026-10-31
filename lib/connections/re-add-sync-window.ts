/**
 * lib/connections/re-add-sync-window.ts  (BETA LIFECYCLE L2 — the wallet re-add sync claim)
 *
 * ONE atomic statement: a wallet re-add / reactivation may re-read the chain
 * only when the Connection's last manual refresh is older than the customer's
 * entitled window, and claiming the window IS the check — the same
 * `UPDATE … WHERE … RETURNING`, so two concurrent re-adds cannot both pass.
 *
 * Runs on the CALLER's tenant transaction (fm_app under RLS): a row that is not
 * the caller's is simply not updated (no row returned ⇒ not claimed). It is not
 * a count-returning bulk write — it returns the claimed key, or nothing — and
 * it is the one raw statement the RLS foreground ratchet allowlists in the
 * converted routes (scripts/rls-foreground-acceptance.ts check 34), proven on
 * real Postgres there (check 72).
 */

import { Prisma } from "@prisma/client";

/** The narrow client: a tenant transaction (or any client) that can run one raw query. */
export interface ReAddWindowClient {
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>;
}

/**
 * Claim the window. True ⇔ exactly this call moved `lastManualRefreshAt` to
 * `now` (the window was open: null, or at/before `windowOpensAt`).
 */
export async function claimReAddSyncWindowAtomic(
  tx: ReAddWindowClient,
  input: { connectionId: string; userId: string; now: Date; windowOpensAt: Date },
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
    UPDATE "Connection"
       SET "lastManualRefreshAt" = ${input.now}, "updatedAt" = ${input.now}
     WHERE "id" = ${input.connectionId} AND "userId" = ${input.userId}
       AND ("lastManualRefreshAt" IS NULL OR "lastManualRefreshAt" <= ${input.windowOpensAt})
    RETURNING "id"`);
  return Array.isArray(rows) && rows.length === 1;
}
