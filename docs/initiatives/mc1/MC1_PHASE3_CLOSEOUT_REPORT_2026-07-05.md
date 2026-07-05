# MC1 Phase 3 — Reporting Currency (The Flip) — Closeout Report

**Date:** 2026-07-05
**Status:** ✅ **COMPLETE** (Slices 1–7). MC1's single behavior-changing phase is delivered; for every all-USD Space the flip is a numerical no-op, pinned by equivalence gates at every slice.
**Plan of record:** `MC1_PHASE3_REPORTING_CURRENCY_PLAN.md` — implemented as approved (D-1…D-10; entry findings F-1…F-4 all closed).
**Commits:** `257f63f` (Slice 1 — ownership schema/copy-once/PATCH allowlist) + the Slices 2–6 implementation commit(s) and this closeout.

---

## 1. Final Phase 3 checklist

| Objective | Status | Evidence |
|---|---|---|
| Reporting-currency ownership | ✅ | `Space.reportingCurrency` + `User.reportingCurrency` (defaulted `USD`, migration `20260705221000`); copy-once at `POST /api/spaces`; `PATCH /api/spaces/[id]` allowlist (FX_BASE + SUPPORTED_QUOTES, 400 on invalid); 12 pure helper checks |
| Server context + serialization | ✅ | `buildSpaceConversionContext(ById)` + `serializeSpaceConversionContext` (server-only module); `serializeContext`/`rehydrateContext` (client-safe); 12 round-trip/determinism/frozen/empty-payload checks |
| Snapshot flip (F-2) | ✅ | `regenerate.ts` + `backfill.ts` on real space contexts; **stamp = context target from one Space read, atomic**; backfill converts each reconstructed day at its own date; history untouched (existing-date skip + skipDuplicates unchanged) |
| AI flip | ✅ | Both assemblers + chat per-liability rollup on real contexts (accounts at latest close; transactions/debt legs at per-row dates); "summed without conversion" notes retired (grep = 0); `totalsEstimated`/summary `estimated` data-only |
| Liquidity lens flip (F-3) | ✅ | Optional ctx (classifier pattern), injected-clock valuation, `LensResult.estimated` emitted only under a context; adapter uses the by-id helper (db-import tripwire intact); 10 gates |
| Client surfaces flip (F-1, D-6) | ✅ | Serialized context props from 3 server pages → `DashboardClient` (+`KpiRow` by inheritance), `SpaceTransactionsPanel`, `BankingClient`, `DebtClient`; all rehydrate the pure client module; optional props preserve context-less fallback |
| No stored-fact mutation | ✅ | `lib/money` write-grep = 0; snapshot writers unchanged in write shape; conversion exists only on read paths |
| Read-time only | ✅ | No normalized columns anywhere; the only stored converted values remain snapshot totals (frozen-by-construction, stamped) |
| No selector UI / no Phase 4 presentation | ✅ | `reportingCurrency` in `components/` = 0; the only rendered "estimated" is the pre-existing `LensMetric.estimated` heuristic marker (perspective-engine original ship, commit `32b5461`) — distinct from every MC1 flag, all of which are data-only |

## 2. Rollback posture (unchanged, verified)

Data-level: `UPDATE "Space" SET "reportingCurrency" = 'USD'` restores identity behavior for USD-stamped rows instantly, no deploy. Code-level: every seam degrades to `identityContext`/no-context (the Phase 2 kill-switch paths are intact underneath — pinned by the kill-switch gates in all four golden suites).

## 3. Validation summary (closeout re-run, sandbox)

`npx tsc --noEmit` clean · `npm run lint` 0 errors (4 pre-existing `<img>` warnings) · suite **38/39** — 8 MC1 suites (~110 checks) green, kd17 prints all assertions passed before the standing darwin-engine sandbox constraint; kd18/privacy/validator/perspective/backfill-core all green. Client bundle purity: zero `server-context`/`@/lib/db`/`fx/archive` references under `components/`; clients import only `lib/money/convert`.

## 4. Phase 4 entry findings (recorded, deliberately unsolved)

1. **Snapshot currency-estimation flag** (deferred by approved D-7): `isEstimated` kept its D2.x reconstruction meaning; whether currency estimation gets its own snapshot flag (or a widened meaning) is a product decision Phase 4 must make before rendering estimation on charts.
2. **Mixed-stamp chart display**: a Space that changes reporting currency accumulates snapshot rows with different stamps; charts still render stored totals unlabeled. Phase 4 owns the display rule (roadmap §6.4: convert old points at their own dates, flag estimated, label the axis).
3. **F-5 — holdings assembler still raw**: `lib/ai/assemblers/holdings.ts` sums raw `Holding.value` (never threaded in Phases 2–3; honestly noted in its `lib/ai/types.ts` doc). Thread it when Phase 4 touches AI presentation, or earlier if non-USD holdings appear.
4. **F-6 — SpaceDashboard panel context-less**: the `SpaceTransactionsPanel` instance inside `SpaceDashboard` receives client-fetched transactions, so no server page can hand it a serialized context; needs an API-payload decision (include a serialized context in the transactions endpoint response). The prop is optional by design, so behavior there is today's native sums.
5. **Estimated-flag rendering**: `AccountClassification.estimated`, summary/monthly `estimated`, `DebtPaymentRollupEntry.estimated`, `AccountsSectionData.totalsEstimated`, `LensResult.estimated` all flow and render nowhere — Phase 4 designs the presentation (UI badges + AI prompt disclosure).
6. **Reporting-currency selector UX**: the PATCH API is live and validated; Phase 4 builds the Space-settings selector, the User default selector, the ephemeral view override, and the forward-only explainer copy (roadmap §6.1–6.2).

## 5. What Phase 3 delivered

The dial is turned. Every aggregate the product computes — snapshots, AI context, lenses, dashboard/banking/credit/transaction totals — now denominates in `Space.reportingCurrency`, converting native facts at read time over the immutable archive: balances at the latest close, transaction rows at their own dates, reconstructed history at each day's own rate. For every existing Space nothing changed, provably. A user who sets a Space to EUR today gets correct converted totals everywhere the moment the next read happens — with no data migration, no rewritten history, and honest `estimated` taint waiting for Phase 4 to surface.

---

*Phase 3 closed. Next per the approved roadmap: MC1 Phase 4 (currency selector & UX — the final MC1 phase) begins with its own implementation checklist, entering through the six findings above. Not started by this closeout.*
