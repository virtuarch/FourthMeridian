> **INVESTIGATION ONLY — no code, schema, migration, or behavior was changed.** This document is the FlowType P5 closeout audit, re-verified from the repository as it exists today (post-Slice-7, working tree clean). Prior investigation documents were NOT relied on; every claim below was re-derived by direct code inspection. Per instruction, STATUS.md and the superseded P5 documents were NOT updated — the required doc updates are listed as closeout prerequisites (§6).

# FlowType P5 — Closeout Investigation

**Date:** 2026-07-05
**Branch:** `feature/v2.5-spaces-completion` (clean; 4 commits ahead of origin)
**Verdict (§7): COMPLETE — high confidence.**

---

## 1. Semantic authority audit

Repo-wide sweep for every remaining derivation of financial semantics from category, amount sign, merchant description, or provider heuristics. Every hit classified:

### Intentional (approved design — not debt)

| Site | What | Why intentional |
|---|---|---|
| `lib/transactions/flow-classifier.ts` | consumes category + sign + account context | It IS the authority — these are its inputs by design. |
| `lib/transactions/plaid-category.ts` (+ `merchant-rules.ts`, `isLiabilityCardPaymentLeg`) | merchant-text + PFC + sign heuristics | The **categorization layer**, upstream of the classifier (provider → category → classifier). Outputs categories only; never writes flow. The Other→Payment card-payment rescue runs BEFORE `classifyFlow`. |
| `lib/transactions/plaid-flow-input.ts` legacy-bucket fold (`LEGACY_INCOME_CATEGORIES` etc.) | category+sign | Diagnostic capture contract (`legacyBucketAgreement`), part of FlowType infra itself. |
| `BANKING_CATEGORIES` ×2 (`lib/data/transactions.ts`; assembler `resolveCategory`) | category list | **List membership** (which rows appear in the Banking tab; phrase→category drilldown resolution) — approved class D. |
| `annotations.ts` discretionary/semi/fixed sub-classing | category sets | flowType does not encode discretionary-ness — approved class D. Gate itself is flow-routed (Slice 5). |
| Row tinting `isCredit = amount > 0` (`BankingClient:475`, `DebtClient:1140`, `SpaceTransactionsPanel:371`, `RecentTransactionsPanel:31`, `AccountModal:712-757`) | sign | Presentational color only — approved class D. |
| `InvestmentsClient` Buy/Sell/Dividend display | investment category | Security-activity view — approved class D (banking-income treatment of dividends lives in the assembler). |
| UI category-filter dropdowns (`BankingClient:151`, `DebtClient:418`, `AccountModal:227`, Space panel) | category equality | Taxonomy filters over the merchant taxonomy, not flow semantics. |
| Sign guards inside flow partitions (assembler DEBT_PAYMENT `<0` / INCOME `>0`; pending credit/debit split; drilldown `amount: { lt: 0 }`; `classifySpendingCategory` probe `amount: −1`) | sign | Direction *within* an already-flow-typed population (KD-17 debit-only convention), not semantic derivation. |

### Legacy (genuine FlowType residue — carried to §2)

| Site | Issue |
|---|---|
| `annotations.ts:1785` | `incomeTransactionCount` = `byCategory` **'Income' name** count — post-Slice-4, Dividend-INCOME rows count under 'Dividend', so income-confidence's txn count undercounts. Minor (payroll dominates the signal). |
| `prisma/seed.ts` | **0 `flowType` references** — dev-seeded rows carry null flow, so in dev they are invisible to the Slice-2 chips and excluded by the assembler's `BANKING_FLOWS` query. Production writers unaffected. Cure exists: run `backfill-flowtype.ts --apply` after seeding. |
| `lib/data/transactions.ts:86,123` | Comment says flow metadata "not consumed anywhere yet" — false since Slice 2. Comment-only. |

### Bug

**None found.**

### Unrelated

`SpaceCategory` logic (SpacesClient, SpaceDashboard, Create/ManageSpaceModal, admin pages), Brief card kinds (`BriefSinceLastVisit`), `csv.ts:620` category diffing for update-on-match, `app/api/accounts/[id]/transactions` raw field passthrough — different "category" domains or non-semantic data handling.

---

## 2. Remaining FlowType technical debt (complete list)

1. **Merchant-backfill flow-desync seam (the one real finding).** `scripts/backfill-merchant-categories.ts` rewrites `category` (Other → rule category) while deliberately leaving `flowType` and `classifierVersion` untouched (its header, line 31). Category is a classifier INPUT — a post-hoc rewrite without re-classification desynchronizes input from output, and the version gate cannot detect it. Concrete instance: the one Fee-family rule (Amex annual-fee tokens, Other→Fee) leaves rewritten rows at `flowType=SPENDING` where the classifier would now say `FEE`. Blast radius: `expenseTotal` unchanged (both flows are in `EXPENSE_FLOWS`), but such rows are eligible for the top-spending-merchant rollup and the annotations opportunity gate. Verify with one count: rows where `category='Fee' AND "flowType"='SPENDING'`. Remediation (one-time, out of this investigation): re-run the flow backfill over category-rewritten rows, or have any category-rewriting tool clear `classifierVersion`. This seam also defines the MI contract (§5).
2. **Seed path unwired** (§1 legacy) — dev-only.
3. **`FLOW_COST` duplicated** in `BankingClient.tsx:58` and `SpaceTransactionsPanel.tsx:41`, with the assembler's `EXPENSE_FLOWS` as a third expression of the same concept — no shared constant. Small drift-risk echo of the very problem P5 removed; candidate one-line consolidation, not a blocker.
4. **`incomeTransactionCount` name-lookup** (§1 legacy) — minor.
5. **Stored-but-unconsumed classifier outputs:** `classificationConfidence`/`classificationReason` reach the DTO and raw account-transactions API but no consumer logic reads them; `counterpartyAccountId` is written null everywhere (deliberate — the pairing slice was explicitly deferred by the foundation doc). Forward-looking storage, documented; not dead code.
6. **Stale documentation:** `P5_END_TO_END_CUTOVER_STATE_INVESTIGATION.md` still says Slices 3–7 "NOT STARTED"; `P5_RESUMPTION_PLAN_2026-07-05.md` is superseded; STATUS.md's KD-18 entry still says the per-liability capability is "ratified into v2.5.5" (it shipped in Slice 6). Not updated per instruction — closeout prerequisite.
7. **Recorded intentional divergences (not debt, for the record):** Banking tab membership is category-list while AI membership is flow-set (Fee/Dividend rows reach the AI but not the Banking list) — approved class D. Dashboard chips net refunds inside Spend while the assembler discloses gross + `refundTotal` — accepted at the Slice 4 sign-off.

---

## 3. Consumer audit

| Consumer | Verdict | Evidence |
|---|---|---|
| Banking (chips) | **uses FlowType** | `BankingClient.tsx:170-177` — FLOW_COST + REFUND netting + INCOME |
| Dashboard Space panel | **uses FlowType** | `SpaceTransactionsPanel.tsx:149-156` — identical logic |
| Debt | **uses FlowType** | `DebtClient.tsx` → `lib/debt.ts` `totalDebtPaid` + per-card rollup (Slice 3) |
| AI assembler | **uses FlowType** | `BANKING_FLOWS` query filter, flow partition, monthly, merchant/income/recurring rollups, drilldown default (Slice 4); 0 semantic category/sign derivations remain |
| Daily Brief | **uses FlowType (transitively)** | `app/api/brief/route.ts` — zero category/sign hits; pure assembler consumer |
| Chat serializer | **uses FlowType** | flow-derived `NON_SPENDING_CATEGORY_NAMES`, per-liability block, `refundTotal` surfacing (Slice 6) |
| Annotation engine | **uses FlowType** (gate) | `classifySpendingCategory` routes through `isExcludedFromSpending(classifyFlow(...))` (Slice 5); sub-classing intentionally category-based; `incomeTransactionCount` = *should but currently doesn't* (minor, §2.4) |
| Imports (CSV/manual) | **writes FlowType** | `import/route.ts:322-333` on CREATE (`:356`) and update-on-match (`:410`) |
| Plaid sync | **writes FlowType** | `syncTransactions.ts:253-260`; category rescue applied before classification |
| Backfill | **uses FlowType** | `backfill-flowtype.ts` — idempotent, `classifierVersion`-gated, dry-run default |
| Seed path | **should but currently doesn't** | `prisma/seed.ts` — 0 refs; dev-only (§2.2) |
| Perspective Engine / Timeline / Investments / Overview | **intentionally do not** | balances / security activity — verified zero transaction-flow derivations |

---

## 4. Architecture audit

Intended: Provider → Raw Transaction → Flow Classifier → FlowType → Financial Facts → AI.

**The pipeline holds.** Both providers (Plaid sync, import route) produce raw rows; the categorization layer (`plaid-category.ts` + merchant rules + the card-payment-leg rescue) settles category BEFORE classification; `classifyFlow` is the single classification entry point (all three call sites use `buildFlowWriteFields`); flow columns are the persisted facts; the data layer exposes them additively; dashboards and the assembler read facts; annotations and the serializer consume assembler output; the AI reads only serialized facts.

Remaining inconsistencies, all named:

1. **The merchant-backfill bypass** (§2.1) — the only place a classifier *input* can change without the *output* being invalidated.
2. **Route-side per-liability fetch** — Slice 6 deliberately fetched the debt rollup in the chat route (via the KD-15-guarded data layer + the pure Slice 3 helper) rather than the assembler, to keep the closed Slice 4 file untouched. Sound and guarded; if a second consumer (e.g. AiAdvice) ever needs per-liability data, promote it into the assembler rather than duplicating the route fetch.
3. **Two membership definitions** (category-list for the Banking tab, flow-set for the AI) — an approved product decision, not an architectural defect; revisit only if "what shows in Banking" is deliberately reopened.

---

## 5. Merchant Intelligence readiness

**MI can be built on FlowType without reopening it**, verified from code:

- `flow-classifier.ts` takes merchant/description as *available* inputs and uses them nowhere — merchant identity cannot leak into flow semantics.
- Merchant rules output **categories only** (audit: 15 rules → Subscriptions/Shopping/Travel/Dining/Fee; zero flow-value categories); rules run upstream of `classifyFlow` on the forward path.
- `merchantEntityId` forward-seed is captured by `buildFlowWriteFields`, enabling a future Merchant table backfill without Plaid re-fetch.
- The `classifierVersion` mechanism provides versioned reclassification.

**One contract is missing, and it belongs to MI's entry gate:** *any category rewrite must invalidate flow classification* (clear/bump `classifierVersion`, or reclassify synchronously). The existing merchant backfill violates it (§2.1); user/Space category overrides — MI's persisted tier — would violate it at scale. This is a design rule for MI Slice 1a, not a FlowType reopening: `classifyFlow`'s API and semantics need no change.

---

## 6. Roadmap readiness

**Yes — Merchant Intelligence (persisted tier) is the correct next initiative**, consistent with the v2.5 ordering audit's reasoning, which this investigation independently re-confirms: the dual-semantic seam that audit ranked above MI is now closed.

Prerequisites before starting MI (small, ordered):

1. **Push and tag the P5 closeout** (4 local commits ahead of origin).
2. **Documentation closeout pass** (the "not yet" updates): STATUS.md FlowType/KD-18 entries, mark the P5 docs superseded/complete.
3. **One-time flow-desync remediation** for merchant-backfill-rewritten rows (§2.1) — a re-run of the flow backfill over the affected predicate; verify with the one-line count first.
4. **Adopt the category-rewrite invalidation contract** in the MI Slice 1a design (§5).
5. Optional dev nicety: wire seed → flow backfill (§2.2).

MI's own entry gates (category-enum expansion decision, `categorySource` provenance) and the parallel v2.5 items (MC1 Phase 0, etc.) are outside FlowType scope and unchanged.

---

## 7. Success criteria — verdict

**FlowType P5 can be marked COMPLETE with high confidence.**

Justification: all seven approved slices are implemented, committed, and locally validated (27/27, clean tsc, baseline lint, zero schema drift). The semantic-authority sweep found **zero unclassified derivations**: everything remaining is either the classifier's own input contract, the upstream categorization layer, approved class-D list-membership/presentational uses, or four small named debt items — none of which is a live dual-semantic authority. The `{Income, Interest, Transfer, Payment}` set exists in zero production copies (only test fixtures pinning the equivalence proof). Every production writer classifies; the backfill is idempotent and version-gated; every approved consumer reads flow. The remaining items (§2) are explicitly scoped: three are cosmetic/dev-only, one (the merchant-backfill seam) is a cross-initiative contract that MI must adopt anyway and does not affect any figure the AI or dashboards currently present beyond the enumerated fee-rule edge.

No blockers to closure.
