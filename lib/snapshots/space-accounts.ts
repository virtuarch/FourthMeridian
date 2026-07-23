/**
 * lib/snapshots/space-accounts.ts  (PS-1 — Background Snapshot Authority)
 *
 * THE SYSTEM-AUTHORITY account read for snapshot computation.
 *
 * WHY THIS EXISTS
 * ---------------
 * Snapshot regeneration is system-owned computation over explicit Space/account
 * authority. It has no viewer, so it must not resolve — or depend on — a
 * request-scoped identity.
 *
 * It used to. `regenerateSpaceSnapshot()` called `getAccounts({ spaceId })`
 * (lib/data/accounts.ts), the PRESENTATION-layer read whose job is to answer
 * "what may THIS PERSON see?". That helper resolves its context internally
 * unless the caller supplies BOTH `spaceId` and `userId`:
 *
 *     const needsResolve = !ctx?.spaceId || !ctx?.userId;   // accounts.ts
 *
 * The snapshot writer supplied only `spaceId`, so every call fell through to
 * `getSpaceContext()` → `getServerSession()`. On a user's own request that
 * silently succeeded (their cookie was on the request) and the resolved
 * identity was then DISCARDED — the only thing `userId` feeds is the
 * reconnect-badge ownership test, which a snapshot never reads. On a Plaid
 * webhook or a Vercel cron there is no session cookie, so it threw
 * "Not authenticated — no active session" and today's SpaceSnapshot was never
 * regenerated from any background path. Three layers of non-fatal catch made it
 * silent.
 *
 * The defect was never the missing `userId`. It was that a viewer-scoped read
 * was being used as a system read. Passing a `userId` would answer the wrong
 * question rather than stop asking it — and for a cron there is no correct
 * answer to give. So the boundary is drawn here instead: the snapshot writer
 * gets its own read, and the presentation helper stays exclusively on request
 * paths.
 *
 * OUTPUT IS PROVABLY IDENTICAL TO THE READ IT REPLACES
 * ----------------------------------------------------
 * This is not a judgement call; it is a field-level identity:
 *
 *  1. SAME ROW SET. The `where` clause below is the same one
 *     getAccountsWithVisibility() uses — ACTIVE SpaceAccountLink, non-deleted
 *     FinancialAccount. Visibility tier was never a filter there: non-FULL
 *     links are RETURNED (sanitized), not excluded. So including every ACTIVE
 *     link here is what preserves the set — dropping BALANCE_ONLY/SUMMARY_ONLY
 *     accounts would silently change net worth.
 *
 *  2. SAME FIELD VALUES. The snapshot consumes exactly four fields: `id` (the
 *     consent-gating query + the eligibility filter), `currency` (FX context),
 *     and `type`/`balance`/`currency` (classifyAccounts — whose input contract
 *     `ClassifiableAccount` declares only { type, balance, currency?,
 *     syncStatus? }, and whose body reads nothing else; `syncStatus` is
 *     documented as ignored). All four pass STRAIGHT THROUGH from
 *     FinancialAccount in the read being replaced — the FULL branch maps
 *     `id: r.id, type: r.type, balance: r.balance, currency: r.currency`, and
 *     sanitizeForBalanceOnly() preserves the same four, redacting only name,
 *     institution and debt metadata. Nothing the snapshot reads was ever
 *     redacted, which is why this read can skip the visibility layer without
 *     changing a single number.
 *
 *  3. SAME ORDER. The orderBy is carried over deliberately. classifyAccounts
 *     SUMS these balances, and floating-point addition is not associative, so a
 *     different row order could shift the last bits of netWorth. Keeping the
 *     order keeps the totals bit-identical, not merely equal.
 *
 * SCOPE
 * -----
 * Deliberately NOT a general-purpose account read. It returns the minimum the
 * snapshot needs and nothing more, so it can never grow into a second
 * presentation path. Anything with a viewer must keep using
 * lib/data/accounts.ts, which enforces KD-19 visibility.
 *
 * Enforced by lib/snapshots/background-authority.test.ts: nothing reachable
 * from regenerateSpaceSnapshot may import lib/space.ts or getServerSession.
 */

import { db } from "@/lib/db";
import { ShareStatus, type Prisma } from "@prisma/client";

/**
 * The minimum account shape snapshot computation needs. Structurally
 * compatible with ClassifiableAccount (lib/account-classifier.ts), plus the
 * `id` the consent gate and eligibility filter key on.
 */
export interface SnapshotAccount {
  id:       string;
  type:     string;
  balance:  number;
  currency: string;
}

/**
 * Narrow injection seam, following the house pattern
 * (lib/plaid/sync-lock.ts#PlaidItemSyncLockClient): an optional trailing client
 * that defaults to the shared Prisma client, so tests can execute this for real
 * against an in-memory fake instead of source-scanning it.
 *
 * The seam MUST be honoured by every query on the path. A helper that accepts a
 * client and then reaches for module-level `db` anyway looks injected but runs
 * against the real database — that mistake already caused unit tests in this
 * repo to write live SyncIssue rows. There is exactly one query here, and it
 * uses `client`.
 */
export interface SnapshotAccountsClient {
  spaceAccountLink: {
    findMany(args: {
      where:    Prisma.SpaceAccountLinkWhereInput;
      select:   { financialAccount: { select: { id: true; type: true; balance: true; currency: true } } };
      orderBy:  Prisma.SpaceAccountLinkOrderByWithRelationInput[];
    }): Promise<Array<{ financialAccount: { id: string; type: string; balance: number; currency: string } }>>;
  };
}

/**
 * Every account ACTIVE-linked to `spaceId`, as system authority — no viewer, no
 * session, no visibility redaction (see the identity argument above).
 *
 * Safe to call from any execution context: a Plaid webhook, a cron, a future
 * worker or queue processor, or an ordinary request. It reads only the Space's
 * own account links.
 */
export async function readSpaceAccountsForSnapshot(
  spaceId: string,
  client: SnapshotAccountsClient = db,
): Promise<SnapshotAccount[]> {
  const links = await client.spaceAccountLink.findMany({
    where: {
      spaceId,
      status:           ShareStatus.ACTIVE,
      financialAccount: { deletedAt: null },
    },
    select: {
      financialAccount: {
        select: { id: true, type: true, balance: true, currency: true },
      },
    },
    // Mirrors getAccountsWithVisibility so summation order — and therefore the
    // exact float result — is unchanged. See (3) above.
    orderBy: [
      { financialAccount: { type: "asc" } },
      { financialAccount: { name: "asc" } },
    ],
  });

  return links.map((l) => ({
    id:       l.financialAccount.id,
    type:     l.financialAccount.type as string,
    balance:  l.financialAccount.balance,
    currency: l.financialAccount.currency,
  }));
}
