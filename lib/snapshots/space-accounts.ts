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
 * W6 — WHY THIS READ *DOES* SOURCE A WALLET FROM THE SPINE
 * ---------------------------------------------------------
 * `getAccounts` re-sources the current value of a wallet whose chain writes no
 * balance column (SOL/ETH/BNB/AVAX) from the position spine, because the column
 * is `NOT NULL DEFAULT 0` and was publishing "withheld" as $0.00.
 *
 * W-M3a left this read on the column, on the stated grounds that it feeds
 * per-day historical computation. That was WRONG about this function, and the
 * note is corrected rather than quietly deleted: `readSpaceAccountsForSnapshot`
 * has exactly ONE caller — lib/snapshots/regenerate.ts, which writes TODAY's row
 * from TODAY's live balances. The historical writers (regenerate-history.ts,
 * backfill.ts) never call it; they carry their own dated reads.
 *
 * So the doctrine applies cleanly rather than being in tension: a current
 * observation licenses a POINT, and the point it licenses is exactly the row
 * this read serves. Leaving it on the column meant today's stored snapshot
 * omitted a wallet the account surfaces valued correctly — the same false zero,
 * persisted, on a row marked `isEstimated=false` and therefore trusted
 * unconditionally by every consumer.
 *
 * The field-level identity with `getAccounts` above is thereby PRESERVED, not
 * excepted. What must never happen is this substitution reaching a HISTORICAL
 * day, which is why it lives behind a single-caller read rather than in a
 * shared loader.
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

import { ShareStatus, type Prisma } from "@prisma/client";
import { grantsBalanceDisclosure } from "@/lib/account-privacy";

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
  /**
   * W6b — this row's balance is a wallet reading older than the freshness
   * horizon: the LAST KNOWN position rather than a confirmation of now.
   *
   * Additive and optional, so `classifyAccounts` (whose input contract declares
   * only { type, balance, currency, syncStatus }) is untouched and every total
   * is computed exactly as before. It exists so the WRITER can stamp the row's
   * provenance instead of publishing a stale reading as today's observed wealth.
   */
  cryptoStale?: boolean;
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
      select:   { visibilityLevel: true; financialAccount: { select: { id: true; type: true; balance: true; currency: true; walletChain: true; lastUpdated: true } } };
      orderBy:  Prisma.SpaceAccountLinkOrderByWithRelationInput[];
    }): Promise<Array<{ visibilityLevel: string; financialAccount: { id: string; type: string; balance: number; currency: string; walletChain: string | null; lastUpdated: Date } }>>;
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
  client?: SnapshotAccountsClient,
): Promise<SnapshotAccount[]> {
  // Default client resolved LAZILY (dynamic import at call time, not a static
  // module import): callers that inject a client — every test, and the
  // regenerate path — never touch the real Prisma client, so this module can
  // be exercised in environments with no database engine at all. Uninjected
  // callers get the shared client exactly as before.
  const prisma = client ?? (await import("@/lib/db")).db;
  const { loadWalletCurrentValues, hasKnownValue, isFreshCurrentValue } =
    await import("@/lib/crypto/wallet-current-value");

  const links = await prisma.spaceAccountLink.findMany({
    where: {
      spaceId,
      status:           ShareStatus.ACTIVE,
      financialAccount: { deletedAt: null },
    },
    select: {
      visibilityLevel: true, // read for the W1-D3 disclosure tripwire below
      financialAccount: {
        select: { id: true, type: true, balance: true, currency: true, walletChain: true, lastUpdated: true },
      },
    },
    // Mirrors getAccountsWithVisibility so summation order — and therefore the
    // exact float result — is unchanged. See (3) above.
    orderBy: [
      { financialAccount: { type: "asc" } },
      { financialAccount: { name: "asc" } },
    ],
  });

  // ── W1-D3 — snapshot-population disclosure tripwire ─────────────────────────
  // A link's balance may enter a Space snapshot ONLY if its visibility tier
  // grants balance disclosure to that Space (grantsBalanceDisclosure — the same
  // fail-closed predicate the presentation layer enforces via
  // normalizeSharedAccounts). Today every production link is FULL, so this is
  // a strict no-op; it exists so that if a non-disclosing tier (SUMMARY_ONLY /
  // PRIVATE / legacy SHARED / unknown) is ever enabled, the snapshot writer
  // FAILS LOUDLY instead of structurally leaking the masked amount into
  // shared-space aggregates. Throwing (not silently dropping) is deliberate:
  // silently excluding a link would change net worth without disclosure —
  // resolving that is the tier-enablement wave's job, not this guard's.
  for (const l of links) {
    if (!grantsBalanceDisclosure(l.visibilityLevel)) {
      throw new Error(
        `snapshot-population disclosure violation: SpaceAccountLink for account ` +
        `${l.financialAccount.id} in space ${spaceId} has visibility tier ` +
        `"${l.visibilityLevel}", which grants no balance disclosure — refusing to ` +
        `include its balance in the snapshot population.`,
      );
    }
  }

  // W6 — a spine-backed wallet's balance for TODAY comes from the spine, valued
  // through the canonical path, exactly as the account surfaces resolve it. Only
  // a VALUED result displaces the column; UNKNOWN and NO_PRICE fall through
  // rather than have a number invented, and BTC is absent from the map entirely.
  const walletValueByAccount = await loadWalletCurrentValues(
    links.map((l) => ({
      id: l.financialAccount.id,
      walletChain: l.financialAccount.walletChain,
      lastUpdated: l.financialAccount.lastUpdated,
    })),
    { client: prisma as never, contextSpaceId: spaceId },
  );

  return links.map((l) => {
    const v = walletValueByAccount.get(l.financialAccount.id);
    return {
      id:       l.financialAccount.id,
      type:     l.financialAccount.type as string,
      // W6b — VALUED or STALE alike. A stale reading is the LAST KNOWN position
      // and is still the best number there is; falling back to the column would
      // swap it for an unwritten zero. Staleness is DISCLOSED (below), not
      // expressed by discarding the figure.
      balance:  hasKnownValue(v) ? v!.value! : l.financialAccount.balance,
      currency: l.financialAccount.currency,
      /**
       * W6b — present ONLY when this row's balance came from a wallet
       * observation older than the freshness horizon: the LAST KNOWN position
       * rather than a confirmation of now. The writer stamps the snapshot from
       * it, so a week-old reading is never published as today's confirmed
       * wealth.
       *
       * OMITTED rather than `false` for everything else, so a non-wallet row is
       * byte-identical to what this read has always returned — the field-level
       * identity argued in the header stays a fact, not an aspiration.
       */
      ...(hasKnownValue(v) && !isFreshCurrentValue(v) ? { cryptoStale: true } : {}),
    };
  });
}
