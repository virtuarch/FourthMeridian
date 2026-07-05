# FlowType P5 — Resumption Plan (Slices 3–7)

**Date:** 2026-07-05
**Branch:** `feature/v2.5-spaces-completion` at `fcadc2a` (30 unpushed commits ahead of origin)
**Governing docs:** `FLOWTYPE_FOUNDATION_INVESTIGATION.md`, `P5_READ_CUTOVER_INVESTIGATION.md`, `P5_END_TO_END_CUTOVER_STATE_INVESTIGATION.md`
**Scope:** Finish the existing P5 read cutover. No redesign, no reopened decisions, no Merchant Intelligence.

---

## 1. Re-verification of the 2026-07-04 investigation (against `fcadc2a`)

Every claim re-checked by direct code inspection today. **The prior investigation remains accurate.** Work landed since it (D-TEST, LC1, DB1, D2x closeout) changes validation tooling but not slice content or order.

| Claim | Verified today | Evidence |
|---|---|---|
| Write path complete | ✅ | Import route: `computeFlowFields` (`app/api/accounts/[id]/import/route.ts:322-333`) applied on CREATE (`:356`) and update-on-match (`:410`). Plaid sync: `buildFlowWriteFields` (`lib/plaid/syncTransactions.ts:260`). |
| Slice 1 DTO plumbing done | ✅ | `lib/data/transactions.ts:87,124` — both `getTransactions` and `getDebtTransactions` return `flowType`/`flowDirection`. |
| Slice 2 done | ✅ | `BankingClient.tsx:170-177`, `SpaceTransactionsPanel.tsx:149-156` — Spend/In from `flowType`, REFUND netting. |
| Slice 4 not started | ✅ | **0** `flowType` references in `lib/ai/assemblers/transactions.ts`. |
| Slice 5 not started | ✅ | `SPENDING_EXCLUDED` hand-written set at `annotations.ts:755`, gate at `:762`. |
| Slice 6 not started | ✅ | `NON_SPENDING_CATEGORY_SET` at `chat/route.ts:415`; local `NON_SPENDING` at `:686` (used `:719,:768`). |
| Slice 3 not started | ✅ | `DebtClient.tsx:429-430` — `totalDebtPaid` from `category === "Payment"`. No per-liability rollup. |
| Slice 3 dependency satisfied | ✅ | `getDebtTransactions` DTO carries `flowType` and coalesced `accountId` (`r.accountId ?? r.financialAccountId`) — grouping key available; no data-layer change needed for the client-side rollup. |
| Backfill script present | ✅ | `scripts/backfill-flowtype.ts`. |
| FlowType enum as designed | ✅ | 10 values incl. `DEBT_PAYMENT`, `REFUND`, `FEE` (`prisma/schema.prisma`). |

**Remaining dual-semantic seams (unchanged):**
- `{Income, Interest, Transfer, Payment}` hand-written **4×**: `annotations.ts:755`, `chat/route.ts:415`, `chat/route.ts:686`, assembler `MERCHANT_EXCLUDED_CATEGORIES`.
- `category === 'Payment'` debt heuristic **2×**: `DebtClient.tsx:429`, assembler window partition.
- `BANKING_CATEGORIES` **3×** — list membership, **stays by design** (class D).

**What changed since the last investigation (and its effect):**
1. **D-TEST (`fcadc2a`)** — `npm test` is now real (`scripts/run-tests.ts` auto-discovers `*.test.ts` under `lib/` and `app/`; CI workflow exists). Effect: `npm test` joins the per-slice validation list; all six FlowType suites are auto-discovered. **No order change.**
2. **LC1 / DB1 (Workspace→Space)** — none of the P5 target files were renamed; all paths in the prior investigation resolve today. **No order change.**
3. **V2.5 roadmap audit (2026-07-05)** — independently confirms FlowType Slices 3–7 as the top v2.5 priority, before Merchant Intelligence's persisted tier. **Confirms, does not change, this plan.**

**Blockers:** none technical. One human gate: **Slice 4 numbers sign-off** (dividends→income, `Fee` reachable, refund netting). Schedule it early or Slices 5–7 stall behind it.

**Housekeeping (not a blocker):** 30 local commits are unpushed; recommend `git push` before starting so each slice checkpoint diffs cleanly against origin.

---

## 2. Remaining slices — execution order

Order is unchanged from the approved plan: **3 → 4 (gated) → 5 → 6 → 7.** Each slice is one PR-sized checkpoint; stop after each.

### Slice 3 — Debt view + per-liability rollup (KD-18 capability)
- **Purpose:** Replace the `category==='Payment'` heuristic in `totalDebtPaid` with `flowType=DEBT_PAYMENT`; add the per-liability breakdown (destination-side `DEBT_PAYMENT` legs on debt accounts, grouped by account id) that KD-18's guardrail exists to compensate for.
- **Files:** `components/dashboard/DebtClient.tsx` only (DTO already carries `flowType` + grouping key; no data-helper change required unless a server-side GROUP BY is preferred — client-side grouping over the already-fetched rows is the smaller change).
- **Behavioral impact:** Credit/Debt surface only. `totalDebtPaid` value may shift where category and flowType disagree; new per-card breakdown appears.
- **Risk:** Low. **Rollback:** trivial — revert one file.
- **New test:** per-liability rollup unit test (grouping + sum), auto-discovered by `npm test`.

### Slice 4 — AI assembler cutover ⚠️ GATED
- **Purpose:** Move the semantic heart — window/monthly partition, merchant rollup, income rollup — from category+sign to `flowType`/`flowDirection`. Eliminates the dashboard-vs-AI disagreement; Daily Brief auto-benefits.
- **Files:** `lib/ai/assemblers/transactions.ts` (sets `:83-124`, window partition `:266-317`, merchant rollup `:459`, income rollup `:537`, monthly partition `:749-767`); `lib/ai/assemblers/transactions.kd17.test.ts` (re-express invariant population as `flowType=SPENDING` — equal by construction).
- **Behavioral impact:** **All AI numbers + Daily Brief.** Intentional changes: the 9 dividends move into income; `Fee` becomes reachable; refunds net structurally.
- **Risk:** Medium-high (widest blast radius; single file). **Rollback:** revert one file — restores every downstream number in one step.
- **Gate:** explicit numbers sign-off **before merge**. Pre-slice invariant re-proof: `npx tsx scripts/backfill-flowtype.ts` dry-run reports 0 to classify.
- **New test:** before/after context snapshot diff on a known Space.

### Slice 5 — Annotations gate
- **Purpose:** Expense-opportunity gate from `SPENDING_EXCLUDED` category set → `flowType ∉ {SPENDING, REFUND}`. Discretionary/fixed sub-classing stays category-based (approved class D).
- **Files:** `lib/ai/intelligence/annotations.ts` (`:755` set, `:762` gate — one predicate).
- **Behavioral impact:** None expected (P1 harness proved parity over banking categories).
- **Risk:** Low. **Rollback:** revert one predicate.

### Slice 6 — Chat serializer / guardrail alignment
- **Purpose:** Align `NON_SPENDING` re-filters to post-cutover `byCategory`; relax the KD-18 per-liability carve-out (now backed by Slice 3's rollup); keep generalized disclosure for still-unbacked dimensions (per-card interest, source-side transfer attribution).
- **Files:** `app/api/ai/chat/route.ts` (`:415`, `:686` and uses at `:529,:719,:768`); `app/api/ai/chat/attribution-guardrail.kd18.test.ts` (update expectations).
- **Behavioral impact:** Prompt text + serialization; per-card debt questions get real breakdowns instead of a disclosure.
- **Risk:** Low-medium. **Rollback:** revert serializer/prompt hunks; restores carve-out.
- **Depends on:** Slice 3 (rollup exists) and Slice 4 (`byCategory` shape).

### Slice 7 — Legacy cleanup (final, gated, no logic change)
- **Purpose:** Delete now-dead `INCOME_CATEGORIES`, `MERCHANT_EXCLUDED_CATEGORIES`, `SPENDING_CATEGORIES`, `SPENDING_EXCLUDED`, both `NON_SPENDING` sets. **Keep `BANKING_CATEGORIES`** (list membership, class D).
- **Files:** assembler, `annotations.ts`, `chat/route.ts` (deletions only).
- **Behavioral impact:** None (dead code removal).
- **Risk:** Low. **Gate:** zero-reference grep for each symbol before deletion. **Rollback:** revert re-adds dead constants.

---

## 3. Recommended stopping points

Every slice is an independent stopping point; none may be combined. The natural review checkpoints:

1. **After Slice 3** — smallest slice, delivers a user-visible capability (per-card breakdown), zero AI impact. Ideal first PR of the resumption.
2. **After Slice 4** — the behavior slice, merged only with sign-off. Pause here to observe AI/Brief numbers before continuing.
3. **After Slice 6** — the system is single-authority; only dead code remains.
4. **After Slice 7** — initiative closed; Merchant Intelligence persisted tier unblocked.

Do not proceed from one slice to the next without explicit approval.

---

## 4. Validation (per slice, on the developer machine)

> Note: the shared-sandbox Prisma engine binary mismatches this repo's `node_modules` platform; run validation locally.

**Every slice (all code-only — no schema, no migration):**
1. `npm test` — all discovered suites green (includes `flow-classifier`, `plaid-flow-input`, `flow-row-input`, `plaid-flow-write`, `transactions.kd17`, `attribution-guardrail.kd18`).
2. `npx tsc --noEmit` — clean.
3. `npm run lint` — clean.
4. `npx prisma generate` / `npx prisma migrate dev` — confirm **no-op** (guard against accidental schema drift).

**Slice-specific:**
- **Slice 3:** per-card sums reconcile to `debtPaymentTotal` within timing tolerance; historical 100%/0% fabrication case now deterministic; manual UI check of the debt breakdown (no React runner).
- **Slice 4:** *pre:* backfill dry-run → 0 remaining. *Post:* before/after context diff on a snapshot Space (expected delta = the 9 dividends + Fee reachability + refund netting); KD-17 invariant green; output-validator suite green; numbers sign-off recorded.
- **Slice 5:** opportunity output unchanged on fixtures.
- **Slice 6:** prompt snapshot; per-card debt question returns real breakdown; KD-18 test expectations updated and green.
- **Slice 7:** zero-reference grep per deleted symbol; full build green.

---

## 5. Rollback summary

All slices are code-only. No write path is touched, so `flowType` keeps populating regardless of reader state — no data rollback exists at any point. Each slice reverts as a single localized `git revert`: Slice 3 → Debt surface; Slice 4 → all AI + Brief in one file; Slice 5 → one predicate; Slice 6 → serializer hunks; Slice 7 → dead constants reappear.
