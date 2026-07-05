# MC1 Phase 2 — Read-Time Conversion — Closeout Report

**Date:** 2026-07-05
**Status:** ✅ **COMPLETE** (Slices 1–5).
**Plan of record:** `MC1_PHASE2_READ_TIME_CONVERSION_PLAN.md` — implemented as approved (D-1…D-9 all honored; the §1.1 pre-resolved-sync-context design carried through unchanged).
**Commits:** `030dc07` (Slice 1 — pure money core), `581bf65` (Slice 2 — context builder), + the Slice 3–4 (threading + goldens) and Slice 5 (closeout) commits.

---

## 1. Closeout checklist

| Objective | Status | Evidence |
|---|---|---|
| Money core complete | ✅ | `lib/money/types.ts` + `convert.ts`: Money/ConvertedMoney/ConvertedTotal/ConversionContext, `convertMoney` (identity fast path, null-residue, walk-back⇒estimated, miss⇒native+estimated), `convertAndSum` (convert-then-sum, per-row dates, taint), `identityContext` — 35 pure checks |
| Context builder complete | ✅ | `lib/money/context.ts`: async prefetch over the injected `FxArchiveReader` → frozen sync table; byte-equal parity with the fx service across exact/walk-back/miss; D-3 extended to prefetch (unsupported data currency ⇒ miss) — 18 checks |
| Balance family threaded | ✅ | `ClassifiableAccount.currency?`; optional `ctx` through `classifyAccounts`/`sumBalances`/liability clamp; identity contexts at `regenerate.ts`, `backfill.ts`, `ai/assemblers/accounts.ts`; client callers (`DashboardClient`, `KpiRow`) context-less — 9 golden checks incl. 200 randomized fixtures |
| Transaction family threaded | ✅ | `lib/debt.ts` rollups (+`currency`/`dateISO` row fields), assembler accumulators (cash-flow loop, category map, pending, `buildMonthlyBreakdown`) with read-only `currency` select extension, chat-route per-liability rollup; client flow surfaces context-less — 13 golden checks |
| Target remains USD | ✅ | Grep: every product context is `identityContext(DEFAULT_DISPLAY_CURRENCY)` (6 sites); `buildConversionContext` has **zero** product callers; no other target string exists |
| Byte-identical behavior | ✅ | 22 golden checks across three suites: with-context vs without-context outputs `JSON.stringify`-equal on USD fixtures **and** on mixed EUR/SAR/null-residue fixtures (the D-3 continuity property); KD-7/KD-17/kd18/privacy/flow/perspective suites all green |
| No stored facts mutated | ✅ | Structural: `lib/money` contains zero `create`/`update`/`delete`/`@/lib/db` references (grep = 0); `convert.ts`/`types.ts` import only fx *types*; `context.ts` reads via the injected reader seam only |
| No UI / no flip / no Phase 3 | ✅ | The only `reportingCurrency` outside the Phase 0 snapshot writers is the `SpaceSnapshot` column itself (schema L1412); no `Space.reportingCurrency`, no `User.reportingCurrency`, no selector, no settings surface |

## 2. What Phase 2 is (and deliberately is not)

The conversion machine now exists end to end — pure engine, server-side rate bridge over the Phase 1 archive, and live threading through both aggregation families — while computing exactly what the product computed before, proven byte-identically. The one seam Phase 3 turns is visible in six greppable lines: replace `identityContext(DEFAULT_DISPLAY_CURRENCY)` with a real `buildConversionContext(...)` per Space. Nothing was flipped, no reader shows converted values, the AI's "summed without conversion" notes remain true, and no stored row anywhere changed.

## 3. Validation summary (closeout re-run, sandbox)

`npx tsc --noEmit` clean · `npm run lint` 0 errors (4 pre-existing `<img>` warnings) · test suite **35/36** — 5 MC1-P2 suites (75 checks) green; `transactions.kd17.test.ts` prints "All KD-17 rollup/invariant/tripwire cases passed" before the standing darwin-engine-on-linux-sandbox constraint (its fixture type was mirrored with `currency: 'USD'`; its calls remain context-less, exercising the untouched raw path).

## 4. Phase 3 entry findings (recorded, deliberately unsolved)

- **F-1 — Client-computed totals.** `DashboardClient`, `KpiRow`, `BankingClient`, `SpaceTransactionsPanel`, `DebtClient` aggregate in the browser and cannot call the rate service. The Phase 3 flip must deliver server-computed totals or a serialized rate table to these surfaces; identity behavior is correct until then.
- **F-2 — Snapshot target switch.** `regenerateSpaceSnapshot`/`backfill` stamp `DEFAULT_DISPLAY_CURRENCY` and convert through identity today; switching both the context target and the `reportingCurrency` stamp to the Space's currency is one coordinated Phase 3 change (they must move together).
- **F-3 — Liquidity lens raw sums.** `lib/perspective-engine/lenses/liquidity.core.ts` deliberately sums raw balances itself ("matching classifyAccounts() behavior — raw addition"); it does not inherit the classifier seam and must be threaded when the target flips.
- **F-4 — Merchant/recurring rollups stay native.** The assembler's merchant rollup and recurring-charge heuristic were intentionally not threaded: cadence detection should compare **native** amounts (an FX-driven wobble is not a price change — the roadmap's own §6 argument). Converting merchant *totals* joins the flip; converting cadence *inputs* needs an explicit design decision first.

## 5. Residual debt (named, non-blocking)

The four findings above, plus: `AccountClassification`/rollup outputs do not yet carry an `estimated` flag (deliberately — adding a field would have broken byte-identity; it is additive at Phase 3 when a consumer can render it); kd17 sandbox platform constraint (pre-existing).

---

*Phase 2 closed. Next per the approved roadmap: MC1 Phase 3 (Space/User reporting currency — the flip) begins with its own implementation checklist, entering through findings F-1…F-4. Not started by this closeout.*
