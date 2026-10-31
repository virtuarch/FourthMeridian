/**
 * app/merchant-ops/review-model.ts  (Merchant merge review — presentation model)
 *
 * Pure, domain-free-of-I/O copy and arithmetic for the review page. Every
 * sentence here restates behaviour that lives elsewhere; nothing is invented:
 *
 *   • tier meanings + survivor rationale — lib/transactions/merchant-merge-suggest.ts
 *     (T1 PLAID_ENTITY: the merchant that OWNS the provider entity id survives;
 *      T2 CANONICAL_CONTAINMENT: the longer, least-truncated key survives;
 *      T3 is a declared tier the detector does not emit yet)
 *   • what a merge does — lib/transactions/merchant-merge.ts (re-point aliases and
 *     transactions, move-or-fold rules, transfer the provider id only when the
 *     survivor has none, delete the absorbed merchant; never category/flow/raw
 *     description; one atomic transaction) + merchant-merge-review.ts (decision row
 *     and operator audit record with the reason and a recovery snapshot, written
 *     inside that transaction; there is no automated undo — restore is by hand)
 *   • what a dismissal does — merchant-merge-review.ts (decision + audit record,
 *     no merchant touched) and merchant-merge-decisions.ts (a decided pair, any
 *     verdict, is filtered out of every later suggestion)
 */

import type { PendingMergeCandidate } from "@/lib/transactions/merchant-merge-review";
import type { MergeEvidenceTier } from "@/lib/transactions/merchant-merge-suggest";

/** Where "Back" goes: the Merchant Operations platform area (its workspace links here). */
export const BACK_HREF = "/dashboard/platform/MERCHANT_OPS";
export const BACK_LABEL = "Back to Merchant Operations";

export const TIER_META: Record<MergeEvidenceTier, { label: string; meaning: string }> = {
  T1: {
    label: "T1 · Provider evidence",
    meaning: "A transaction on one merchant carries the bank's entity id that belongs to the other. The provider itself says these are one business.",
  },
  T2: {
    label: "T2 · Name truncation",
    meaning: "One merchant's name is a truncated prefix of the other's, sharing at least two leading words.",
  },
  T3: {
    label: "T3 · Weaker name match",
    meaning: "A weaker name-based signal. The detector does not produce this tier today.",
  },
};

export const TIER_ORDER: readonly MergeEvidenceTier[] = ["T1", "T2", "T3"];

/** Why the pre-selected survivor is the one kept — as the detector chose it. */
export function survivorRationale(tier: MergeEvidenceTier): string | null {
  if (tier === "T1") return "Kept because it owns the bank's entity id.";
  if (tier === "T2") return "Kept because it has the longer, less-truncated name.";
  return null;
}

export interface ReviewSummary {
  pending: number;
  /** Only tiers with at least one candidate, in tier order. */
  byTier: { tier: MergeEvidenceTier; label: string; count: number }[];
}

export function summarize(candidates: readonly Pick<PendingMergeCandidate, "tier">[]): ReviewSummary {
  const byTier = TIER_ORDER
    .map((tier) => ({ tier, label: TIER_META[tier].label, count: candidates.filter((c) => c.tier === tier).length }))
    .filter((t) => t.count > 0);
  return { pending: candidates.length, byTier };
}

export const PURPOSE = {
  candidate: "Each candidate is two merchant identities that may be the same business, proposed automatically from bank evidence or name truncation. Nothing is merged until an operator decides.",
  merge: "Merge moves the absorbed merchant's aliases, transactions and rules onto the kept merchant and deletes the absorbed one, for every tenant, in one atomic step. Categories, flow types and the original bank descriptions are not changed. It is recorded in the operator audit log with your reason and a snapshot of the absorbed merchant. There is no undo button: restoring it is done by hand from that audit record.",
  dismiss: "Not the same records your decision and its reason in the audit log and changes no merchant. The pair is not suggested again.",
} as const;

export const READ_ONLY_LINE =
  "Read-only access. You can review the evidence, but merging or dismissing requires a Merchant Operations WRITE grant.";

export const EMPTY = {
  title: "No pending merge candidates",
  body: "The detector found no undecided pairs. Pairs already merged or dismissed are not shown again, and new candidates appear here as merchant data changes.",
} as const;

export type Verdict = "MERGED" | "DISMISSED";

export function dialogCopy(verdict: Verdict, c: Pick<PendingMergeCandidate, "survivor" | "absorbed">): { title: string; outcome: string; confirmLabel: string } {
  const keep = c.survivor.displayName;
  const absorb = c.absorbed.displayName;
  return verdict === "MERGED"
    ? {
        title: `Merge "${absorb}" into "${keep}"?`,
        outcome: `"${absorb}" will be deleted. Its ${c.absorbed.aliasCount} ${plural(c.absorbed.aliasCount, "alias", "aliases")}, ${c.absorbed.transactionCount} ${plural(c.absorbed.transactionCount, "transaction", "transactions")} and ${c.absorbed.ruleCount} ${plural(c.absorbed.ruleCount, "rule", "rules")} move to (or, where the kept merchant already has the same rule, fold into) "${keep}" for every tenant. Recorded in the audit log with a recovery snapshot; there is no undo button.`,
        confirmLabel: "Merge",
      }
    : {
        title: `Mark "${absorb}" and "${keep}" as not the same?`,
        outcome: "No merchant is changed. The decision is recorded in the audit log and this pair will not be suggested again.",
        confirmLabel: "Not the same",
      };
}

export function outcomeLine(verdict: Verdict, c: Pick<PendingMergeCandidate, "survivor" | "absorbed">): string {
  return verdict === "MERGED"
    ? `Merged "${c.absorbed.displayName}" into "${c.survivor.displayName}".`
    : `Dismissed "${c.absorbed.displayName}" / "${c.survivor.displayName}" as not the same.`;
}

export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}
