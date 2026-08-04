/**
 * lib/history/bucket-node.ts
 *
 * V27-C4 — attach a bucket's ACCOUNT children and reconcile them against it.
 *
 * ── The invariant this exists to state ───────────────────────────────────────
 *
 *   Σ(assertable accounts) + permitted unattributed remainder = bucket total
 *
 * The same rule Slice B applied one level up, applied one level down, through
 * the same `classifyReconciliation`. One vocabulary at every depth is the whole
 * point of the recursive contract: a reader who has learned what
 * PARTIALLY_ATTRIBUTED means on Net Worth already knows what it means on Cash.
 *
 * ── Why a bucket total may carry a remainder ─────────────────────────────────
 * A bucket's value is a STORED column on the snapshot row — it was recorded, not
 * computed here from the accounts. So an account we cannot explain leaves a
 * genuine remainder inside a total we still trust, and that is stateable.
 *
 * The one bucket where this is NOT true is real assets, which IS a subtraction
 * (`derivedRealAssets`) rather than a recorded column. It never reaches this
 * module: `buildNetWorthNode` marks it undrillable, and expansion honours that.
 *
 * ── Signs ────────────────────────────────────────────────────────────────────
 * Debt accounts carry the amount OWED, positive, exactly as `totalDebt` does.
 * The sign that turns debt into a subtraction lives at the BUCKET's level and
 * nowhere else, so children reconcile against their parent unsigned and the
 * lens above still gets it right.
 *
 * READ-ONLY. No persistence, per V27's rule 11: an account series is computed on
 * demand, never stored.
 */

import { classifyReconciliation, round2 } from "@/lib/perspective-engine/reconciliation.core";
import { bucketAccountNodes } from "./account-series";
import { accountHoldingNodes } from "./holding-series";
import type {
  HistoricalAccountNode, HistoricalBucketNode, HistoricalNode,
} from "./historical-node.core";
import type { Prisma, PrismaClient } from "@prisma/client";

export interface ExpandBucketArgs {
  spaceId: string;
  bucket:  HistoricalBucketNode;
  client?: PrismaClient | Prisma.TransactionClient;
}

/**
 * Return the bucket with its account children attached and its reconciliation
 * restated against them.
 *
 * A bucket the lens already refused is returned UNCHANGED. Expanding it would
 * mean computing a composition for a value nothing may assert — the refusal
 * would survive on the parent while an apparently valid breakdown rendered
 * beneath it, which is exactly the contradiction this arc removes.
 */
export async function expandBucketNode(args: ExpandBucketArgs): Promise<HistoricalBucketNode> {
  const { bucket } = args;
  if (!bucket.drilldown.available || !bucket.assertable || bucket.displayedValue == null) {
    return bucket;
  }

  const accounts = await bucketAccountNodes({
    spaceId: args.spaceId,
    bucketKind: bucket.bucketKind,
    dateISO: bucket.dateISO,
    fromISO: bucket.fromISO,
    toISO:   bucket.toISO,
    currency: bucket.currency,
    breadcrumb: bucket.breadcrumb,
    client: args.client,
  });

  // `null` = this bucket has no account level at all (real assets). It is not an
  // empty set of accounts, and saying so would be a different, false claim.
  if (accounts === null) {
    return { ...bucket, drilldown: { available: false, reason: "NO_ACCOUNT_LEVEL_FOR_THIS_BUCKET" } };
  }
  if (accounts.length === 0) {
    return {
      ...bucket,
      components: [],
      explainedValue: null,
      drilldown: { available: false, reason: "NO_ACCOUNTS_IN_BUCKET" },
    };
  }

  const explained = round2(
    accounts.filter((a) => a.assertable && a.displayedValue != null)
      .reduce((n, a) => n + (a.displayedValue ?? 0), 0),
  );

  const r = classifyReconciliation({
    total: bucket.displayedValue,
    explained,
    // A stored bucket column WAS recorded, whatever the snapshot's own basis
    // says about how the day was assembled. That is what licenses a remainder.
    totalIsObserved: true,
    componentCount: accounts.length,
  });

  const assertable = r.state === "EXACT" || r.state === "PARTIALLY_ATTRIBUTED";

  return {
    ...bucket,
    components: accounts as HistoricalNode[],
    explainedValue: explained,
    unattributedObservedAmount: r.remainder,
    reconciliation: r.state,
    // The bucket's VALUE is still the stored column and is still shown; what the
    // reconciliation governs is whether its COMPOSITION may be presented as
    // complete. Those are different claims and only the second one changes here.
    assertable: bucket.assertable,
    unavailableReason: assertable ? bucket.unavailableReason : "ACCOUNTS_CONTRADICT_BUCKET_TOTAL",
    historicalCount: accounts.length,
    valuedCount: accounts.filter((a) => a.displayedValue != null).length,
    drilldown: { available: true, reason: null },
  };
}

/** Expand every drillable bucket of a lens node, concurrently. */
export async function expandBuckets(
  spaceId: string,
  buckets: readonly HistoricalNode[],
  client?: PrismaClient | Prisma.TransactionClient,
): Promise<HistoricalNode[]> {
  return Promise.all(
    buckets.map(async (b) =>
      b.nodeType === "bucket" ? expandBucketNode({ spaceId, bucket: b, client }) : b),
  );
}

export type { HistoricalAccountNode };

/**
 * V27-D6 — attach an account's HOLDING children and reconcile them against it.
 *
 * The same invariant, one level deeper again:
 *
 *   Σ(assertable holdings) + permitted remainder = account total
 *
 * An account is a RECORDED total (a provider balance, or a valued subtotal the
 * engine stated), so a holding it cannot value leaves a genuine remainder rather
 * than invalidating the account. Holdings that EXCEED it are a contradiction —
 * the same asymmetry buckets have, for the same reason.
 */
export async function expandAccountNode(args: {
  spaceId: string;
  account: HistoricalAccountNode;
  client?: PrismaClient | Prisma.TransactionClient;
}): Promise<HistoricalAccountNode> {
  const { account } = args;
  if (!account.drilldown.available || !account.assertable || account.displayedValue == null) {
    return account;
  }

  const holdings = await accountHoldingNodes({
    spaceId: args.spaceId, account, client: args.client,
  });

  // `null` = this account type has no holding level. A checking account is not
  // an empty portfolio; it is not a portfolio.
  if (holdings === null) {
    return { ...account, drilldown: { available: false, reason: "NO_HOLDING_LEVEL_FOR_THIS_ACCOUNT_TYPE" } };
  }
  if (holdings.length === 0) {
    return { ...account, components: [], explainedValue: null,
      drilldown: { available: false, reason: "NO_HOLDINGS_IN_ACCOUNT" } };
  }

  const explained = round2(
    holdings.filter((h) => h.assertable && h.displayedValue != null)
      .reduce((n, h) => n + (h.displayedValue ?? 0), 0),
  );

  const r = classifyReconciliation({
    total: account.displayedValue,
    explained,
    totalIsObserved: true,
    componentCount: holdings.length,
  });
  const composed = r.state === "EXACT" || r.state === "PARTIALLY_ATTRIBUTED";

  return {
    ...account,
    components: holdings as HistoricalNode[],
    explainedValue: explained,
    unattributedObservedAmount: r.remainder,
    reconciliation: r.state,
    // As with buckets: the account's VALUE stays assertable; only the claim that
    // its composition is COMPLETE is governed by this reconciliation.
    assertable: account.assertable,
    unavailableReason: composed ? account.unavailableReason : "HOLDINGS_CONTRADICT_ACCOUNT_TOTAL",
    historicalCount: holdings.length,
    valuedCount: holdings.filter((h) => h.displayedValue != null).length,
    drilldown: { available: true, reason: null },
  };
}
