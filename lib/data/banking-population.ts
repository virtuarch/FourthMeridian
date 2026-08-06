/**
 * lib/data/banking-population.ts
 *
 * THE canonical banking-population WHERE fragment — extracted from
 * lib/data/transactions.ts, byte-identical, so it can be imported without that
 * module's import graph.
 *
 * ── Why it moved (v2.6-OWN-2) ───────────────────────────────────────────────
 *
 * `lib/data/transactions.ts` reaches `@/lib/space` → `@/lib/auth` → `server-only`,
 * which only Next resolves. Every read-only audit that wants to measure the
 * population the UI actually reads therefore could NOT import it, and
 * `audit-ui-truth-convergence.ts` had hand-written its own approximation:
 *
 *     spaceAccountLinks: { some: { spaceId, status: ACTIVE } }
 *
 * missing the KD-15 `visibilityLevel` gate AND the L8 event-projection filter.
 * Its population was WIDER than any surface it claimed to audit — a
 * BALANCE_ONLY / SUMMARY_ONLY shared account contributed rows to the probe and
 * to nothing in the product, and a superseded pending row counted twice. A probe
 * that does not measure the live path is not evidence about the live path.
 *
 * This module is a pure query SHAPE (enum values + a Prisma type import, no `db`,
 * no `server-only`), the same convention lib/transactions/detail-query.ts follows.
 * `lib/data/transactions.ts` re-exports both symbols, so no consumer moved.
 */

import { ShareStatus, FlowType, Prisma } from "@prisma/client";

import { TRANSACTION_DETAIL_VISIBILITY } from "@/lib/ai/visibility";
import { eventProjectionWhere } from "@/lib/transactions/event-projection";

/**
 * P2-2 — the canonical banking-population WHERE fragment. FlowType (not provider
 * category) decides eligibility for canonical financial analysis: every row EXCEPT
 * pure investment security-activity (FlowType.INVESTMENT) belongs to the banking
 * semantic population that reaches Cash Flow / DayFacts, the Transactions
 * Perspective, exports, and the liquidity axis.
 *
 * Why `not: INVESTMENT` and not a flow allow-list: the ONLY structural split among
 * banking reads is banking vs. investment security-activity. Expressing the rule as
 * a single exclusion (a) keeps unclassified rows visible — Prisma scalar `not`
 * returns null/UNKNOWN rows too, so a row awaiting classification still surfaces to
 * review / needs-classification paths, never dropped by a taxonomy allow-list; and
 * (b) admits every legitimate banking flow (SPENDING/INCOME/REFUND/FEE/INTEREST/
 * TRANSFER/DEBT_PAYMENT/ADJUSTMENT) regardless of its provider category label. The
 * DayFacts fold already handles each of these canonically (UNKNOWN → unresolved
 * transparency total; ADJUSTMENT → NON_CASH context reason; neither enters net), so
 * widening the population changes no Cash-Flow math — it only stops the old
 * `category ∈ BANKING_CATEGORIES` allow-list from silently omitting rows whose
 * category fell outside 11 hand-listed values (e.g. cash Dividend income, card Fees,
 * newer/merchant PFC categories). This mirrors the AI assembler's already-migrated
 * `flowType: { in: BANKING_FLOWS }` cutover (lib/ai/assemblers/transactions.ts).
 *
 * Row-level statement of the same rule: isBankingPopulation (flow-predicates.ts).
 * Structural filters (deletedAt, SpaceAccountLink visibility, date) are ANDed
 * separately.
 *
 * ── v2.6-POP-1: why this is an OR and not `{ not: INVESTMENT }` ─────────────
 *
 * It WAS `{ flowType: { not: FlowType.INVESTMENT } }`, and the comment above
 * claimed — correctly in intent, falsely in fact — that "Prisma scalar `not`
 * returns null/UNKNOWN rows too". It does not. `not` compiles to
 * `NOT (flowType = 'INVESTMENT')`, which is SQL UNKNOWN for a NULL column and
 * therefore NOT MATCHED. Every unclassified row was silently excluded from the
 * banking population: from Cash Flow, the transactions list, the explorer, the
 * count, exports and the AI.
 *
 * Measured before the fix: six seeded Spaces returned ZERO transactions each
 * (Jane's Space — 151 rows structurally visible, 0 returned), and all 352
 * unclassified rows in the corpus were unreachable.
 *
 * It also broke a contract the write path documents in its own words. On CREATE,
 * a classification failure persists all-null flow columns because
 * (lib/plaid/syncTransactions.ts):
 *
 *     "degrade-to-null is honest: a fresh row with null semantics lands in the
 *      never-classified backlog and needs-classification surfaces"
 *
 * It did not land anywhere. The row persisted, the sync reported success, and
 * the surface built to catch it could not see it — an honesty valve that was a
 * black hole. No provider row has ever hit that path (verified: 0 of 352
 * unclassified rows are Plaid- or import-sourced), so nothing was lost; the
 * defect was latent, and it is the kind that conceals its own occurrence.
 *
 * The explicit `flowType: null` arm is the same spelling the detail read already
 * uses for this exact hazard, and lib/data/transactions.population.test.ts
 * (§ null/UNKNOWN) has always asserted the predicate admits null. The query now
 * agrees, and scripts/audit-banking-population.ts EXECUTES the comparison
 * against a database rather than asserting it in prose — which is how the
 * disagreement survived a test that claimed to pin the two "in lockstep".
 *
 * ⚠️ This fragment now carries an `OR`, so it must never be object-SPREAD beside
 * another `OR` (e.g. eventProjectionWhere()) — the second key would silently
 * overwrite the first and drop that filter entirely. `bankingTransactionWhere`
 * composes with `AND` for exactly this reason. Pinned by
 * lib/transactions/event-identity.test.ts INV-18.
 */
// Typed rather than `as const`: an `as const` OR is a readonly tuple, which
// Prisma's WhereInput does not accept. The explicit annotation also makes a
// malformed fragment a compile error at the definition instead of at every
// call site.
export const BANKING_POPULATION: Prisma.TransactionWhereInput = {
  OR: [
    { flowType: { not: FlowType.INVESTMENT } },
    // Unclassified. Visible for review / needs-classification, never dropped by
    // a comparison that cannot see NULL.
    { flowType: null },
  ],
};

/** The ONE canonical banking-population `where` (KD-15 visibility + deletedAt +
 *  FlowType population). Shared by the list loaders AND cheap aggregate readers
 *  (e.g. view-context) so they can never disagree on the population. */
export function bankingTransactionWhere(spaceId: string, opts?: { debtOnly?: boolean }): Prisma.TransactionWhereInput {
  return {
    // v2.6-POP-1 — ANDed, never object-spread. Both fragments below carry an
    // `OR`, and spreading two objects that share a key keeps only the last one:
    // the previous `{ ...eventProjectionWhere(), ...BANKING_POPULATION }` shape
    // would have silently DROPPED the event-projection filter the moment the
    // population gained its null arm, and every total could double-count a
    // pending row and its posting. `AND` composes; spread overwrites.
    AND: [
      // L8-B1 — one row per LOGICAL EVENT. A pending charge and the posting that
      // supersedes it are one economic event observed twice; this keeps only the
      // row the event currently projects to. Rows outside the banking event domain
      // (self-custody crypto) carry no event and are kept, so no total moves.
      eventProjectionWhere(),
      // P2-2 — the FlowType population, including unclassified rows.
      BANKING_POPULATION,
    ],
    // deletedAt: null guards an archived account's rows; visibilityLevel (KD-15)
    // admits only transaction-detail (FULL) links. debtOnly narrows to debt accounts.
    financialAccount: {
      ...(opts?.debtOnly ? { type: "debt" } : {}),
      deletedAt: null,
      spaceAccountLinks: { some: { spaceId, status: ShareStatus.ACTIVE, visibilityLevel: { in: TRANSACTION_DETAIL_VISIBILITY } } },
    },
    deletedAt: null,
  };
}
