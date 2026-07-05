> **INVESTIGATION ONLY — no code, schema, migration, or refactor was performed.** This document reconciles the P5 read-cutover plan (`P5_READ_CUTOVER_INVESTIGATION.md`) against the *actual code state on `feature/v2.5-spaces-completion`* as of the date below, and enumerates the remaining work to make FlowType fully end-to-end. Governing design: `FLOWTYPE_FOUNDATION_INVESTIGATION.md`. Stop-after-checklist per instruction.

# FlowType — End-to-End Read/Write Cutover: State & Remaining Work (Investigation)

**Date:** 2026-07-04
**Branch:** `feature/v2.5-spaces-completion`
**Question:** What remains to make FlowType fully end-to-end across imports, banking, spaces, AI, summaries, and reporting?
**Method:** Verified every write/read site named in the P5 plan against current source; cross-referenced git history and the P1–P5 checklists. No implementation.

---

## 1. Executive summary

The **write side is complete** and the **read side is ~40% cut over**. Every production writer now populates `flowType`; the two dashboard summary surfaces (Banking + Space panel) read it. The remaining gap is the **AI/analytical read path** — the assembler, the annotations gate, the chat serializer/guardrail, the Debt view's per-liability rollup, and the final legacy-set deletion. These are Slices 3–7 of the existing P5 plan; **none are started**.

Confirmed by code inspection:

- **Slice 0 (import write completion)** — **DONE** (`8399ae8`). Import route classifies on CREATE and re-classifies on update-on-match via `classifyFlow` + `buildFlowWriteFields`.
- **Slice 1 (additive read plumbing)** — **DONE** (`6811e58`). `lib/data/transactions.ts` returns `flowType`/`flowDirection` on the DTO.
- **Slice 2 (Banking/Space totals + income-bug fix)** — **DONE** (`43c1b44`). Both surfaces compute Spend/In from `flowType`.
- **Slices 3–7** — **NOT STARTED.** The assembler, annotations, chat route, and DebtClient still derive semantics from `category` + `amount` sign.

**The critical prerequisite (write completion) is satisfied**, so the remaining reader migrations are unblocked. The only slice needing a numbers sign-off remains **Slice 4 (assembler)**. Recommendation: **GO**, continue the existing sequence from Slice 3.

---

## 2. Current state — verified site by site

### 2.1 Write side (COMPLETE)

FlowType enum + nullable columns exist (`prisma/schema.prisma:1124`, migration `20260703130000_v255_flowtype_schema`). `FLOW_CLASSIFIER_VERSION = 1` (`lib/transactions/flow-classifier.ts:50`).

A full `transaction.create`/`createMany` sweep shows exactly **three** real writers, all accounted for:

| Writer | Populates `flowType`? | Evidence |
|---|---|---|
| `lib/plaid/syncTransactions.ts` (Plaid sync) | ✅ Yes (P3B, `b6278be`) | write path via `buildFlowWriteFields` |
| `app/api/accounts/[id]/import/route.ts` (CSV/Excel/QuickBooks + "manual") | ✅ Yes (Slice 0, `8399ae8`) | `:332` `computeFlowFields` on CREATE (`:356/:377`) and update-on-match (`:410/:422`) |
| `prisma/seed.ts` (dev-only) | ⚠️ Out of scope | dev seed; not a production economic writer |

`app/api/accounts/[id]/import/preview/route.ts` is **read-only** (its header states it never calls `db.transaction.create`) — not a writer.

**Result:** every production-created transaction carries a current-version FlowType. The "every row has non-null `flowType`" invariant the readers depend on holds (subject to the standing P4 backfill claim: 0 UNKNOWN, DB fully populated — re-confirm with the dry-run before Slice 4, see §5).

### 2.2 Read side (PARTIAL)

| Reader | Uses `flowType`? | State |
|---|---|---|
| `lib/data/transactions.ts` DTO (Slice 1) | ✅ exposes `flowType`/`flowDirection` (`:87-88`, `:124-125`) | **DONE** |
| `BankingClient.tsx` Spend/In chips | ✅ `FLOW_COST` set + `REFUND` netting + `INCOME` (`:170-177`) | **DONE (Slice 2)** |
| `SpaceTransactionsPanel.tsx` Spend/In chips | ✅ identical (`:149-156`) | **DONE (Slice 2)** |
| **AI assembler** `lib/ai/assemblers/transactions.ts` | ❌ **0 `flowType` refs.** Still `BANKING_CATEGORIES`/`INCOME_CATEGORIES`/`MERCHANT_EXCLUDED_CATEGORIES`/`SPENDING_CATEGORIES`; `incomeTotal`/`debtPaymentTotal`/`transferTotal` from category+sign (`:296-301`) | **NOT STARTED (Slice 4)** |
| **`annotations.ts`** expense-opportunity gate | ❌ `SPENDING_EXCLUDED = {Income,Interest,Transfer,Payment}` (`:755`, gate `:762`) | **NOT STARTED (Slice 5)** |
| **`app/api/ai/chat/route.ts`** serializer/drilldown | ❌ `NON_SPENDING_CATEGORY_SET` (`:415`) + local `NON_SPENDING` (`:686`) re-filter `byCategory` | **NOT STARTED (Slice 6)** |
| **`DebtClient.tsx`** `totalDebtPaid` | ❌ `t.category === "Payment"` → `Σ|amount|` (`:429-431`); no per-liability rollup | **NOT STARTED (Slice 3)** |
| `lib/data/transactions.ts` `BANKING_CATEGORIES` list-membership (L8) | ⚠️ category-based **by design** (`:48,:71,:108`) | **D — leave** (list membership, not flow totals) |
| Perspective Engine, Timeline, Overview/NetWorth/Cash, Investments tab | n/a (read balances/security activity) | **D — never migrate** |
| Daily Brief (`app/api/brief/route.ts`) | reads assembler output | **auto-benefits** once Slice 4 lands |

### 2.3 Banking totals (Slice 2 — done, verified)

`totalSpend = max(0, Σ|amount|[flowType∈{SPENDING,FEE,INTEREST}] − Σ|amount|[REFUND])`; `totalCredit/totalIn = Σ|amount|[flowType=INCOME]`. The pre-cutover income-inflation bug (`Σ` all positives) is fixed on both surfaces. Numbers already changed here.

### 2.4 Space transaction totals (Slice 2 — done, verified)

`SpaceTransactionsPanel` is byte-identical in logic to Banking, so Banking and the Space panel now agree for the same scope. No further Space-totals work is required for the summary chips.

### 2.5 AI assembler usage (NOT started)

The assembler is the semantic heart and remains fully category+sign:
- Query filter `category: { in: BANKING_CATEGORIES }` (`:231`) decides which rows the AI sees.
- Window partition (`:266-317`): `incomeTotal` from `INCOME_CATEGORIES` + positive sign; `debtPaymentTotal` from `category===Payment && amount<0`; `transferTotal` from `category===Transfer`; `expenseTotal` from debit rows.
- Merchant rollup excludes `MERCHANT_EXCLUDED_CATEGORIES` (`:459`); income rollup keyed on `INCOME_CATEGORIES` (`:537`).

This drives **all AI numbers and the Daily Brief**. Migrating it is the one behavior-changing slice (dividends→income, `Fee` reachable, refunds net) — needs the sign-off gate.

### 2.6 Remaining sign/category fallbacks (the deletable duplication)

Still live, all still referenced (cannot be deleted yet):
- `{Income, Interest, Transfer, Payment}` hand-written **4×**: `annotations.ts:755`, `chat/route.ts:415`, `chat/route.ts:686`, and the assembler's `MERCHANT_EXCLUDED_CATEGORIES`.
- `BANKING_CATEGORIES` **3×**: assembler `:83`, `lib/data/transactions.ts:48`, and the Space panel's own list.
- `category==='Payment'` debt heuristic **2×** remaining: `DebtClient.tsx:429`, assembler `:296` (`DebtClient` L11 + assembler L5/L6 Payment branch). *(The two Slice-2 dashboard copies were already removed.)*

### 2.7 Tests already written

Present and green (standalone `tsx`, no React/jest runner in repo):
- `lib/transactions/flow-classifier.test.ts` — classifier unit.
- `lib/transactions/plaid-flow-input.test.ts`, `flow-row-input.test.ts` — row/PFC input adapter.
- `lib/transactions/plaid-flow-write.test.ts` — write-field builder.
- `lib/ai/assemblers/transactions.kd17.test.ts` — KD-17 category-rollup sign invariant (**must stay green through Slice 4**; re-express population as `flowType=SPENDING`, equal by construction).
- `app/api/ai/chat/attribution-guardrail.kd18.test.ts` — KD-18 disclosure/rule (expectations change in Slice 6 when the per-liability carve-out is relaxed).

**Test gaps:** no integration test asserts imported rows carry `flowType` (Slice 0 fixture named in its checklist, not yet added); no fixture test for the Slice 2 formula; no assembler before/after snapshot for Slice 4; no per-liability rollup test for Slice 3.

---

## 3. Remaining gaps (what "fully end-to-end" still needs)

1. **Debt view + per-liability rollup (Slice 3).** `DebtClient.totalDebtPaid` still string-matches `Payment`; the KD-18 destination-side per-card breakdown (group `flowType=DEBT_PAYMENT` legs on `type=debt` accounts by `financialAccountId`, using the `[financialAccountId, flowType, date]` index) does not exist yet.
2. **AI assembler cutover (Slice 4).** The whole window/monthly partition, merchant rollup, and income rollup still run on category+sign. This is the gap that keeps AI answers, the Daily Brief, and every downstream serializer on legacy semantics. **Behavior sign-off required** (dividends→income, `Fee` reachable, refund netting).
3. **Annotations gate (Slice 5).** `SPENDING_EXCLUDED` → `flowType ∉ {SPENDING,REFUND}`; keep the discretionary/fixed sub-classing category-based (D).
4. **Serializer/guardrail alignment (Slice 6).** `NON_SPENDING` re-filters in `chat/route.ts` must align to the post-cutover `byCategory` shape; relax the KD-18 per-liability carve-out (now backed by Slice 3), keep the generalized disclosure for still-unbacked dimensions.
5. **Legacy cleanup (Slice 7).** Delete the now-dead `INCOME_CATEGORIES`/`MERCHANT_EXCLUDED_CATEGORIES`/`SPENDING_CATEGORIES`/`SPENDING_EXCLUDED`/`NON_SPENDING` — only after a zero-reference grep. `BANKING_CATEGORIES` (list membership) stays.
6. **Reporting/Exports/Search.** None exist today (confirmed: no `report`/`export` route dirs). Any future rollup should be built on `flowType` directly — no new legacy logic. **No work owed now.**
7. **Test debt.** Add the Slice 0 import-flow integration assert, the Slice 2 fixture, the Slice 4 before/after snapshot, and the Slice 3 rollup test as each slice lands.

---

## 4. Smallest implementation slices (remaining, ordered low→high risk)

Continues the existing P5 sequence; Slices 0–2 are done. Each is independently shippable and reversible.

**Slice 3 — Debt view + per-liability rollup (KD-18 capability).**
- *Files:* `components/dashboard/DebtClient.tsx` (+ a data helper for the grouped query).
- *Change:* `totalDebtPaid` → `Σ|amount| WHERE flowType=DEBT_PAYMENT AND amount<0`; add per-liability rollup (destination-side legs grouped by `financialAccountId`).
- *Blast:* Credit/Debt surface; new per-card breakdown appears.
- *Depends on:* Slice 1 DTO (done) exposing `flowType` on the debt rows the client reads (confirm the debt data path carries it; add to the select if not).

**Slice 4 — AI assembler cutover (the one behavior slice).**
- *Files:* `lib/ai/assemblers/transactions.ts` (`:83-124` sets, `:266-317` window partition, `:459` merchant rollup, `:537` income rollup), `transactions.kd17.test.ts` population.
- *Change:* partition by `flowType`/`flowDirection`; `expenseTotal := Σ|amount|[SPENDING]`, income/transfer/debt likewise; refunds net.
- *Gate:* **behavior sign-off** (dividends→income, `Fee` reachable, refund netting) before merge.

**Slice 5 — annotations gate.**
- *File:* `lib/ai/intelligence/annotations.ts` (`:755/:762` gate only; keep sub-classing).

**Slice 6 — serializer/guardrail alignment.**
- *File:* `app/api/ai/chat/route.ts` (`:415`, `:686` `NON_SPENDING` alignment; relax KD-18 per-liability carve-out — update `attribution-guardrail.kd18.test.ts`).

**Slice 7 — legacy cleanup (final, gated, no logic change).**
- *Files:* remove now-unreferenced `INCOME_CATEGORIES`/`MERCHANT_EXCLUDED_CATEGORIES`/`SPENDING_CATEGORIES`/`SPENDING_EXCLUDED`/`NON_SPENDING`. Keep `BANKING_CATEGORIES`.
- *Gate:* zero-reference grep before deletion.

---

## 5. Validation plan

Per slice, in order:
1. `npx prisma generate` — no schema change expected; confirm client unchanged (Slices 3–7 are code-only).
2. `npx prisma migrate dev` — expect **no-op**; confirm no new migration.
3. `npx tsc --noEmit` — clean.
4. `npm run lint` — clean.
5. **Pure suites green:** `flow-classifier`, `plaid-flow-input`, `flow-row-input`, `plaid-flow-write`, `transactions.kd17`, `attribution-guardrail.kd18`.
6. **Invariant re-proof (before Slice 4):** `npx tsx scripts/backfill-flowtype.ts` reports **0** to classify; import a fresh CSV → re-run → still 0. Confirms every reader can trust non-null `flowType`.
7. **Slice-specific:**
   - *Slice 3:* per-card sums reconcile to `debtPaymentTotal` within timing tolerance; the historical 100%/0% fabrication case is now deterministic.
   - *Slice 4:* before/after context diff on a snapshot Space — the 9 dividends are the expected income delta; **KD-17 invariant still green** (equal by construction); output-validator suite green.
   - *Slice 5:* opportunity output unchanged on fixtures.
   - *Slice 6:* prompt snapshot; a per-card question returns the real breakdown, not a disclosure; KD-18 expectations updated.
   - *Slice 7:* `grep` proves zero references before deletion; full build green.
8. **Manual/UI (no React runner):** Slice 3 debt card breakdown; Banking vs Space parity already verified in Slice 2.

---

## 6. Rollback plan

All remaining slices are **code-only** (no schema, no migration, no data change) — every one is a localized `git revert` of a single surface.

- **Slice 3:** revert `DebtClient.tsx` + the data helper; `totalDebtPaid` returns to the `Payment` heuristic; per-card breakdown disappears. Blast radius: Credit/Debt surface.
- **Slice 4:** revert the single assembler file; reverts **every downstream AI number and the Daily Brief** in one step (the reason it is isolated to one file). Blast radius: all AI + Brief.
- **Slice 5:** revert one predicate in `annotations.ts`.
- **Slice 6:** revert the `chat/route.ts` serializer/prompt hunks; re-restores KD-18 carve-out.
- **Slice 7:** revert re-adds the deleted constants (dead code); no behavior change either direction.
- **Global safety net:** because writes populate `flowType` and the backfill is idempotent, reverting any reader never corrupts data — the column keeps filling regardless of who reads it. No `flowType` write path is touched by Slices 3–7, so there is no data rollback to perform at any point.

---

## 7. Recommendation

**GO — continue the existing P5 sequence from Slice 3.** Write completion (Slice 0) and additive plumbing (Slice 1) are merged, so the non-null `flowType` invariant holds and every remaining reader migration is unblocked and reversible. Land Slice 3 (debt rollup, low risk, delivers the KD-18 capability), then Slice 4 **behind an explicit numbers sign-off** (the only behavior-changing surface), then Slices 5–6 (mechanical), and finally Slice 7 (deletion) **gated on a zero-reference grep**, honoring "no opportunistic cleanup." No schema, migration, or refactor is required beyond what already shipped.
