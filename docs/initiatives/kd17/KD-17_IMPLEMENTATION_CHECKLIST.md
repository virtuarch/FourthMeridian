# KD-17 — Category Rollup Sign Asymmetry: Implementation Checklist

**Status:** Checklist only — awaiting approval. No schema, migration, route, UI, or application code changes in this deliverable.
**Branch:** `feature/phase-2-architecture` (baseline v2.3.0)
**Milestone:** v2.4.5 exit criterion (approved roadmap revision).
**Evidence:** `docs/investigations/KD17_TRANSACTION_LEVEL_PROOF.md` + archived audit output (`kd17-audit-output.md`). January 2026: 4 credit-card payment credits (+$9,500) categorized `Other` net against $2,970.55 of debits → monthly line prints $6,529.45 while expenseTotal is $5,848.70 and drilldown says $2,970.55.

---

## 1. The defect in one sentence

Spending-category totals in the AI pipeline are `|Σ signed amounts|` over **all** rows, while `expenseTotal` and the drilldown aggregate **debit rows only** — so positive rows in spending categories produce mathematically impossible, mutually contradictory figures that the prompt asserts (prose-only) can never occur and the membership validator structurally cannot catch.

## 2. The fix in one sentence (smallest, architecture-preserving)

Make spending-category totals aggregate the **same population** as `expenseTotal` and the drilldown — debits only — and disclose per-category credits instead of netting them; then convert the prompt's "≤ spending total" prose invariant into a checked one.

Explicitly rejected larger alternatives: recategorizing data (doesn't fix future refunds — 79 positive spending-category rows exist across 4 categories), persisting raw PFC (schema change), changing sign conventions at ingest (touches every consumer), fixing the validator to be provenance-based (KD-2 scope).

## 3. Impact map

```
lib/ai/assemblers/transactions.ts   ← ALL code changes live here (+ 1 type field)
  ├─ window-level byCategory   (~:274-281, :332-338)  signed→debit population  [CHANGE]
  ├─ buildMonthlyBreakdown     (:689-692, :721-728)   signed→debit population  [CHANGE]
  └─ assembleDrilldown         (:854-911)             already debits-only      [UNCHANGED — becomes consistent]
        │
        ▼
lib/ai/types.ts — CategorySpend                        additive optional field [CHANGE]
        │
        ▼
app/api/ai/chat/route.ts — prompt serialization
  ├─ window categories line (~:665) + monthly line (:729-735)  reads .total (unchanged shape)
  └─ NEW: checked invariant Σ spending cats ≤ expenseTotal     [CHANGE — small]
        │
        ▼
lib/ai/output-validator.ts                             UNCHANGED (membership set unaffected;
                                                       corrected figures enter the prompt)
UI paths (lib/data/transactions.ts, BankingClient.tsx) UNCHANGED — verified clean 2026-07-02
                                                       (UI already computes spend debit-only)
```

**Blast radius of the fix:** AI answers only. Monthly/window category figures shrink to their debit-only truth wherever credits were netted in (Jan 2026 `Other`: $6,529.45 → $2,970.55) and grow slightly where credits *understated* debits (Jan `Shopping`: $1,095.06 → $1,119.01). Drilldown and expenseTotal values do not move. No stored data changes.

## 4. Affected files

| # | File | Change |
|---|------|--------|
| 1 | `lib/ai/assemblers/transactions.ts` | Two aggregation sites: track `debitTotal`/`creditTotal` per category; output `total` = debits-only for spending categories |
| 2 | `lib/ai/types.ts` | `CategorySpend`: add optional `creditTotal?: number` (additive) |
| 3 | `app/api/ai/chat/route.ts` | Append credit disclosure to category lines when `creditTotal > 0`; add checked invariant at serialization |
| 4 | `lib/ai/assemblers/transactions.kd17.test.ts` (new) | Regression tests (§6) |

**Explicitly NOT changed:** schema, migrations, `mapPlaidCategory` / `lib/plaid/syncTransactions.ts`, `lib/ai/output-validator.ts`, `lib/data/transactions.ts`, any UI component, stored transaction rows, `WorkspaceAccountShare`, no new tables. Side findings (Fee invisibility, Groceries unreachable, Interest-in-expenseTotal disclosure) stay with v2.5.5 — not bundled here.

## 5. Implementation steps (for approval — do not code yet)

**Step A — aggregation population (`transactions.ts`, one commit):**

1. In both `categoryAgg` accumulators (window ~:274, monthly :689): replace `signed` with `debitTotal += |amount|` when `amount < 0`, `creditTotal += amount` when `amount > 0`. Keep `count` as-is (all rows), preserving `transactionCount` reconciliation.
2. Output mapping (both sites): `total = round(debitTotal)`; attach `creditTotal` (rounded) when > 0; keep the `total > 0` filter and sort. Categories that are pure credit (e.g. a refund-only month) now drop off the spending line instead of appearing as phantom spending — with credits still disclosed via §Step B.
   - **Semantics note for non-spending categories:** `byCategory` is only ever *serialized* for spending categories (both prompt sites filter `NON_SPENDING` by name), but to keep the struct honest for any future consumer, emit `total` as debits-only universally and let `creditTotal` carry the inflow side (Income becomes `total: 0, creditTotal: 17,902.60` — the prompt's income figures come from `incomeTotal`, not `byCategory`, verified in route.ts).
   - **Decision point for approval:** universal debits-only `total` (recommended, one rule) vs. spending-categories-only special case (preserves Income's current byCategory shape but keeps two semantics).
3. `assembleDrilldown`: no change. Its `matchedTotal` now equals the monthly line by construction.

**Step B — prompt disclosure + checked invariant (`route.ts`, same commit):**

1. Category line rendering: when `creditTotal > 0`, append e.g. `Other $2,970.55 (excludes $9,500.00 in credits/refunds)` — the model can then answer "why does Other look small" truthfully instead of hallucinating.
2. Replace the two prose assertions (:713-716, :752-757 region) with a **checked** invariant immediately before serialization: `Σ spending-category totals ≤ expenseTotal + $0.01` (rounding tolerance). On violation: `throw` in dev/test; in prod, log at error level with month + figures and append an explicit `[DATA INCONSISTENCY — figures under review]` annotation to that month's line rather than emitting a false assertion.
3. Note in the invariant comment: equality is NOT expected — `Interest` debits are inside expenseTotal but name-filtered from the line (documented side finding).

**Step C — regression tests (same PR):**

See §6.

## 6. Validation checklist

Code-level:

- [ ] `npx prisma generate` (no schema change — confirm no diff)
- [ ] `npx tsc --noEmit`
- [ ] `npm run lint`
- [ ] New tests pass:
  - [ ] net-positive category month (credits > debits) → `total` = debits, no phantom spending, invariant holds
  - [ ] mixed month (Jan 2026 shape: D=$2,970.55, C=$9,500) → monthly `Other` = $2,970.55 = drilldown `matchedTotal`
  - [ ] credit-understatement case (Shopping shape: D=$1,119.01, C=$23.95) → $1,119.01, not $1,095.06
  - [ ] invariant trips on a hand-built violating payload (dev throw path)
  - [ ] pure-credit category month → dropped from spending line, credits disclosed

Data-level (dev DB):

- [ ] Re-run `npx tsx scripts/kd17-audit-jan-other.ts` — script's "Σ debits" column is the expected post-fix `total` for every category; verify monthly Other = drilldown = $2,970.55
- [ ] Targeted AI chat query "January 2026 spending by category" → Other reported as $2,970.55 with credit disclosure; no category exceeds $5,848.70

## 7. Rollback plan

Single revert of one commit (or the PR). No migrations, no data writes, no stored state — the pipeline recomputes from raw rows on every request, so rollback restores prior behavior instantly and completely. The audit script is independent of the fix and remains valid before/after.

## 8. Risks / notes

- **Perceived regression:** users/AI transcripts that previously saw $6,529.45 will now see $2,970.55; the disclosure suffix explains the delta. Release note should mention it.
- **`Travel`/`Shopping` figures shift slightly** wherever historical credits netted in (12 and 7 positive rows respectively) — correct, but visible.
- The categorization amplifier (payment credits in `Other`) remains as a *data* oddity — harmless post-fix (credits disclosed, never summed as spending). Recategorization, Fee visibility, Groceries reachability, and the Interest disclosure belong to v2.5.5 Financial Intelligence.
