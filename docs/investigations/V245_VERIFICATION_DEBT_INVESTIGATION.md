# v2.4.5 Verification-Debt Investigation (investigation only)

**Branch:** `feature/v2.5-spaces-completion` · **Baseline:** `v2.4.5` (`6b517fa`)
**Scope guard:** work confined to `lib/ai/**`, `scripts/**`, tests, and docs. **No implementation in this pass.**
**Do not touch:** Liquid, Atlas, Brief, SpaceDashboard, `package.json`, visual components.

This document investigates the v2.4.5 carry-forward debt named in `STATUS.md` §5:
the missing test suites (merchant normalization, window/rollup math, follow-up/drilldown
heuristics) and the missing observability counters (fallback hits, sync stats, LLM token usage).
It maps where each belongs, what can be tested with the least risk, and a proposed commit order.
It recommends **one** first implementation slice and then stops.

---

## 0. Headline findings (read these first)

1. **Testing convention is fixed and cheap.** No jest/vitest. Tests are standalone
   `npx tsx *.test.ts` scripts that exit 0/1, colocated with the code under test
   (`lib/ai/output-validator.test.ts`, `transactions.kd17.test.ts`,
   `transactions.privacy.test.ts`). New suites must follow this pattern — no runner
   is added, so `package.json` stays untouched (respects scope).

2. **Merchant normalization is already a pure, exported function** —
   `normalizeMerchant` in `lib/transactions/merchant.ts`. It can be tested with
   **zero source changes**. Lowest-risk slice in the whole program.

3. **Window/rollup math is mostly pure and already exported** —
   `buildMonthlyBreakdown` + `checkSpendingCategoryInvariant`
   (`lib/ai/assemblers/transactions.ts`) and `reliableMonths` /
   `computeAverageMonthlySpending` / `computeSpendingTrends`
   (`lib/ai/intelligence/annotations.ts`). Testable with **zero source changes**.
   (The KD-17 suite already partially covers the category-rollup invariant; the new
   suite covers month bucketing, coverage/truncation flags, and trend math, without
   overlap.)

4. **Follow-up/drilldown heuristics are NOT testable as-is.** They live as
   **module-private functions inside `app/api/ai/chat/route.ts`**, which imports
   `next/server`. A standalone `tsx` test cannot import a Next route module cleanly.
   These functions must first be **extracted into a pure module** (the exact pattern
   KD-11 already used: route heuristics → `lib/ai/intent/gap-intent.ts`). This is the
   only slice that requires a (small, additive, behavior-preserving) refactor before a
   test can exist.

5. **Two of the three counters live OUTSIDE the permitted implementation scope.**
   - **LLM token usage** → `lib/ai/provider.ts` — **in scope** (`lib/ai/**`).
   - **Fallback hits** and **sync stats** → `lib/plaid/**` and `jobs/**` — **out of
     the stated `lib/ai`/`scripts` scope.** They can be *investigated* now, but
     implementing counters at those sites needs an explicit scope expansion. Only the
     LLM-token counter is implementable within the current guardrails. This is the key
     scoping decision to surface before any counter work.

---

## 1. Missing test suites — where each subject lives

### 1a. Merchant normalization
- **Code under test:** `lib/transactions/merchant.ts` → `normalizeMerchant(raw): { canonicalKey, canonicalName }` (exported, pure, no I/O).
- **Consumer (for realism):** the merchant rollup in `lib/ai/assemblers/transactions.ts` (~L442–L485) groups by `canonicalKey`.
- **State:** no test file exists (`find … -name '*merchant*.test.ts'` → none).
- **Testability:** direct import, **no source change**.

### 1b. Window / rollup math
- **Monthly bucketing + rollup:** `buildMonthlyBreakdown` (exported, `transactions.ts:714`); category invariant `checkSpendingCategoryInvariant` (exported, `transactions.ts:689`); `SpendingInvariantViolation` type.
- **Window reliability + averages + trends:** `reliableMonths` (`annotations.ts:923`), `computeAverageMonthlySpending` (`:935`), `computeSpendingTrends` (`:954`), `computeMetricTrend` (internal, exercised via `computeSpendingTrends`).
- **Fetch-cap / coverage flags:** `truncated`, `coverageStartDate`, `fetchLimit` on the summary contract (`lib/ai/types.ts`), and per-month `truncated` (KD-7). These are the "silent truncation" edge the math must respect.
- **State:** partially covered — `transactions.kd17.test.ts` pins the debit-only category `total` and the ≤`expenseTotal` invariant. **Not** covered: month-boundary bucketing, complete-vs-partial-vs-truncated month classification, average-over-reliable-months, and MoM/rolling trend direction.
- **Testability:** all target functions exported and pure. **No source change.**

### 1c. Follow-up / drilldown heuristics  ⚠ requires extraction first
- **Code under test (all private, `app/api/ai/chat/route.ts`):**
  `looksLikeFollowUp` (:278), `resolveTransactionWindow` carry-forward (:295),
  `isAmbiguousBreakdownFollowUp` (:346), `namesFinancialSubject` (:332),
  `hasPriorFinancialContext` (:357), `buildBreakdownClarification` (:373),
  `detectDrilldownCategory` (:425), `detectDrilldownMerchant` (:433),
  `detectDrilldownLimit` (:468), `resolveDrilldown` (:482), plus
  `windowOptionFromRoute` (:228) / `routeForMessages` (:216).
- **State:** untested. The route imports `next/server` (:44) and is a Next handler, so it
  cannot be imported by a house `tsx` test as-is.
- **Testability:** **blocked until extracted.** Recommended target module(s), mirroring
  KD-11's `gap-intent.ts` precedent:
  - `lib/ai/intent/follow-up.ts` — `looksLikeFollowUp`, `windowOptionFromRoute`,
    `resolveTransactionWindow`, ambiguity guards (`isAmbiguousBreakdownFollowUp`,
    `namesFinancialSubject`, `hasPriorFinancialContext`, `buildBreakdownClarification`).
  - `lib/ai/intent/drilldown.ts` — `detectDrilldownCategory/Merchant/Limit`, `resolveDrilldown`.
  The route then imports these back through the intent barrel (`lib/ai/intent/index.ts`),
  exactly as it now imports `gap-intent`. Behavior must be **provably identical**
  (token/branch parity), the same guarantee KD-11 made.

---

## 2. Missing observability counters — where each belongs

| Counter | Signal today | Home | In scope? |
|---|---|---|---|
| **LLM token usage** | `completion.usage` (prompt/completion/total) is **discarded** in `generateChatReply` (`lib/ai/provider.ts`). | `lib/ai/provider.ts` (single sanctioned OpenAI boundary; one caller: `route.ts:1968`). | ✅ `lib/ai/**` |
| **Fallback hits** | `console.warn` lines only: `[plaid][D2-3C/3E/3F] ProviderAccountIdentity miss, legacy plaidAccountId hit` in `lib/plaid/{exchangeToken,refresh}.ts`; fingerprint fallback already counted as `matchedByFingerprint` in `SyncTransactionsResult`. | `lib/plaid/**` (emit site). | ⚠ **out of scope** |
| **Sync stats** | `SyncTransactionsResult` already carries `added/modified/removed/inserted/matchedByPlaidId/matchedByFingerprint/skippedMissingAccount`; `jobs/sync-banks.ts` logs per-item. | `lib/plaid/syncTransactions.ts` + `jobs/sync-banks.ts` (aggregation). | ⚠ **out of scope** |

**There is no metrics/telemetry module yet** (`find lib -iname '*metric*|*observ*|*counter*'` → none). Whatever "counter" means operationally (structured log line vs. a persisted table vs. an in-memory aggregate) is an undecided design point. Recommendation: a minimal **structured-log counter** helper (e.g. `lib/ai/observability.ts` emitting one parseable `[metric] …` line) — no schema, no new deps, revertible — and start it with LLM tokens only, since that is the sole in-scope emit site.

---

## 3. Impact map

| Change | Files touched | Kind | Blast radius |
|---|---|---|---|
| Merchant-normalization suite | **new** `lib/transactions/merchant.test.ts` | additive test | none (test-only) |
| Window/rollup-math suite | **new** `lib/ai/assemblers/transactions.window.test.ts` and/or `lib/ai/intelligence/annotations.test.ts` | additive test | none (test-only) |
| Extract follow-up/drilldown | **new** `lib/ai/intent/follow-up.ts`, `lib/ai/intent/drilldown.ts`; edit `lib/ai/intent/index.ts`; edit `app/api/ai/chat/route.ts` (imports replace local defs) | refactor (behavior-preserving) | route imports change; runtime behavior must be identical |
| Follow-up/drilldown suites | **new** `lib/ai/intent/follow-up.test.ts`, `lib/ai/intent/drilldown.test.ts` | additive test | none (test-only) |
| LLM-token counter | edit `lib/ai/provider.ts` (read `completion.usage`, emit); optional **new** `lib/ai/observability.ts` | additive instrumentation | provider internal; caller signature can stay unchanged if emitted internally |
| Fallback/sync counters | `lib/plaid/**`, `jobs/**` | instrumentation | **out of current scope — defer/escalate** |

**Explicitly out of scope / untouched:** `package.json` (no runner added), Brief, Atlas, Liquid, SpaceDashboard, any visual component, `prisma/schema.prisma` (no counter persists to DB in this plan).

---

## 4. Test plan (house convention: standalone `tsx`, exit 0/1)

Each suite is a self-contained script with a `check(name, ok)` harness identical to
`output-validator.test.ts`, run individually and (optionally) added to a `scripts/`
aggregate runner later.

**S1 — `lib/transactions/merchant.test.ts`** (no source change)
- Leading-prefix stripping: `SQ *COFFEE BAR` → `COFFEE BAR`; `TST* …`, `PAYPAL *…`, `POS DEBIT …`, `ACH …`, `CHECKCARD …`, `PURCHASE AUTHORIZED ON 03/14 …`.
- Noise tokens dropped: `#1234`, `>=4`-digit runs, `*1234`/`xxxx1234` tails; short numbers (`76`, `7`) **preserved**.
- Conservatism: two genuinely different merchants never collapse to one key; city/state **not** stripped.
- Display casing: ALL-CAPS → title-case; already-mixed (`Netflix`) untouched.
- Never-empty guarantee: pathological input falls back to collapsed original.

**S2 — window/rollup math** (no source change)
- `buildMonthlyBreakdown`: correct month bucketing across boundaries/timezones; income/expense/net per month; empty-window → empty.
- Month classification: complete vs calendar-partial vs `truncated` (KD-7 fetch-cap) — `reliableMonths` returns only complete∧non-truncated.
- `computeAverageMonthlySpending`: average over reliable months only; `null` when none (no fabricated figure).
- `computeSpendingTrends`/`computeMetricTrend`: RISING/FALLING/FLAT/INSUFFICIENT_DATA on crafted series; rolling window; single-month → INSUFFICIENT_DATA.
- `checkSpendingCategoryInvariant`: passes at boundary, trips past tolerance (complements, does not duplicate, `transactions.kd17.test.ts`).

**S3 — follow-up/drilldown** (after extraction, S-refactor below)
- `looksLikeFollowUp`: positives (`break it down`, `what about January`, `month by month`) vs negatives (`how am I doing right now`) → no stale-window inheritance.
- `resolveTransactionWindow` carry-forward: latest names own window → use it; follow-up with no window → inherit most-recent explicit; neither → `undefined` (assembler default).
- Ambiguity guard: contentless breakdown with no prior subject → clarification; with prior subject/window → proceed.
- `detectDrilldownCategory/Merchant/Limit` + `resolveDrilldown`: category/merchant/limit parsing; bare month treated as window, not merchant; window reuse from carry-forward.
- **Parity assertion:** a table of inputs whose expected outputs are pinned to the pre-extraction behavior (guards the refactor).

**S4 — LLM-token counter** (in scope)
- Pure formatter test for the emit helper (given a usage object → exact `[metric]` line); no network. Provider call itself stays untested (LLM boundary), matching current convention.

---

## 5. Least-risk ordering (why this order)

Risk rises with source-code contact. Test-only suites over already-exported pure
functions are effectively zero-risk; the refactor is the only correctness-sensitive step;
the counters are gated on a scope decision.

1. **S1 merchant** — test-only, pure, exported. Zero risk. *(recommended first slice)*
2. **S2 window/rollup math** — test-only, pure, exported. Zero risk.
3. **S-refactor** — extract follow-up/drilldown to `lib/ai/intent/{follow-up,drilldown}.ts` with token/branch parity; route imports swap. Behavior-preserving; validated by `tsc`/`lint` + parity table.
4. **S3 follow-up/drilldown suites** — land immediately after (or in) the refactor commit to lock behavior.
5. **S4 LLM-token counter** — smallest in-scope instrumentation; emit internally in `provider.ts` so no caller signature changes.
6. **Fallback + sync counters** — **escalate scope first** (touches `lib/plaid/**`, `jobs/**`). Do not implement under the current guardrails.

---

## 6. Proposed commit order

```
c1  test(merchant): add lib/transactions/merchant.test.ts (S1)                 [test-only]
c2  test(ai): add window/rollup math suite (S2)                                [test-only]
c3  refactor(ai/intent): extract follow-up + drilldown heuristics from chat    [behavior-preserving]
    route into lib/ai/intent/{follow-up,drilldown}.ts (no behavior change)
c4  test(ai/intent): add follow-up + drilldown suites (S3)                     [test-only]
c5  feat(ai/provider): surface + emit LLM token usage counter (S4)             [in-scope instrument]
--- gate: scope decision required before proceeding ---
c6  feat(obs): fallback-hit + sync-stats counters (lib/plaid, jobs)            [OUT OF SCOPE — hold]
```

Each of c1–c5 is independently shippable and revertible. c3 is the only commit that
edits application code (`route.ts` imports); its validation is `npx prisma generate` (no
schema change → no migrate), `npx tsc --noEmit`, `npm run lint`, and the S3 parity table.

---

## 7. Recommended first implementation slice

**Slice = c1 only: the merchant-normalization suite (S1).**

- **Why:** pure, already-exported target; no application code touched; no runner/deps/schema
  change; cannot regress runtime behavior; establishes the exact `tsx` test scaffold the
  later suites reuse.
- **File:** `lib/transactions/merchant.test.ts` (new).
- **Validation:** `npx tsx lib/transactions/merchant.test.ts` exits 0; `npx tsc --noEmit`
  clean; `npm run lint` clean. (No `prisma migrate` — no schema change.)
- **Rollback:** delete the one new file.
- **Explicitly not in this slice:** any route edit, the extraction refactor, and any counter.

---

## 8. Open decisions to confirm before implementing

1. **Counter scope.** Fallback-hit and sync-stats counters require `lib/plaid/**` /
   `jobs/**` edits, outside the stated `lib/ai`/`scripts` scope. Approve a scope
   expansion, or defer those two counters and ship only the LLM-token counter now?
2. **Counter mechanism.** Structured log line (recommended, zero-schema) vs. persisted
   table vs. in-memory aggregate. Affects whether `lib/ai/observability.ts` is introduced.
3. **Extraction vs. export-in-place.** Extract heuristics to new intent modules
   (recommended — matches KD-11 precedent, keeps the route lean) vs. merely `export` the
   private functions from the route (smaller diff but tests then import a Next route module,
   which the `tsx` convention discourages).

*Investigation only — stopping here per instruction. No schema, migration, route, UI, or
application code was modified.*
