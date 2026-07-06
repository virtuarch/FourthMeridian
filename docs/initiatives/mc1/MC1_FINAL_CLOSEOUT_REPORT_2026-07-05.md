# MC1 — Multi-Currency Architecture — FINAL INITIATIVE CLOSEOUT

**Date:** 2026-07-05
**Status:** ✅ **MC1 COMPLETE.** All five phases delivered: 0 (provenance), 1 (FX archive), 2 (read-time conversion), 3 (the flip), 4 (selector & UX incl. the ephemeral override). Fourth Meridian is a first-class multi-currency platform, delivered without a single rewrite of a stored financial fact.
**Lineage:** investigation (`MULTI_CURRENCY_ARCHITECTURE_INVESTIGATION.md`, 2026-07-03) → charter → approved 5-phase roadmap (`MC1_MULTI_CURRENCY_ROADMAP.md`) → per-phase plans + closeouts (Phase 0/1/2/3 reports in this folder) → this document.
**Phase 4 commits:** Slice 1 display plumbing → Slice 8 override, closing with this report (post-`ce51382`).

---

## 1. Final MC1 checklist

| Capability | Status | Evidence |
|---|---|---|
| Currency provenance (P0) | ✅ | Row-level `currency` on Transaction/Holding, `reportingCurrency` on snapshots; all writers stamp; backfill idempotent |
| FX archive (P1) | ✅ | Immutable dated `FxRate`, OXR+Frankfurter failover, daily cron, live-validated (96 rows, verify 0 mismatches) |
| Read-time conversion (P2) | ✅ | `lib/money` pure engine + sync context seam; both aggregation families threaded; ~22 byte-identity gates |
| Reporting-currency flip (P3) | ✅ | Space (authoritative) + User (copy-once) ownership; snapshots/AI/lens/client surfaces on real contexts; all-USD provably no-op |
| Space selector | ✅ | ManageSpaceModal, allowlist, forward-only confirmation copy, audit from/to, `router.refresh()` on change |
| User default selector | ✅ | Settings→Profile, "new Spaces only" copy, allowlist-validated PATCH |
| Estimated presentation | ✅ | One shared "≈ / est." chip (PerspectivesWidget pattern) on hero/banking/debt/lens/investments/holdings aggregates; silent for USD; itemized rows never flagged |
| Mixed-stamp charts | ✅ | Stamp-aware readers, homogeneous fast path, per-snapshot-date conversion, existing badge covers both causes; stored rows never rewritten |
| Holdings (F-5) | ✅ | Assembler + investments/holdings surfaces converted with `totalsEstimated`; positions native |
| Space panel API (F-6) | ✅ | `moneyCtx` in the transactions payload; panel converts via its existing optional prop |
| AI presentation | ✅ | One currency label (always) + one estimation disclosure (flag-gated), single-insertion, pinned-wording tests; kd17/kd18/privacy/validator green |
| Ephemeral override | ✅ | In-memory only (reload resets by construction), read-only endpoint, writers never consult it, "Preview only — not saved" copy |

## 2. No-mutation proof (final grep pass)

`Transaction.amount` / `Holding.price/value` native forever — schema contains **zero** converted/normalized money columns (the single "denormalized" match is the pre-existing `SpaceGoal.currentAmount` comment, unrelated to currency); `lib/money` contains zero write verbs; snapshot writers stamp but the readers/rewriters grep confirms stored rows are never re-derived or updated; the override (`viewOverride`) appears nowhere in `lib/` or server code except its read-only endpoint; both selectors' PATCH paths write exactly `reportingCurrency` through one shared allowlist parser; itemized row renders keep native/constant formatting at every audited site.

## 3. Validation (closeout re-run)

`npx tsc --noEmit` clean · `npm run lint` 0 errors (4 pre-existing `<img>` warnings) · suite **40/41** — every MC1 suite green (~10 suites: money core/context/serialize, classifier + debt + assembler equivalence gates, liquidity gates, stamp-conversion gates, reporting-currency helpers, currency-presentation pinning), full AI net green (kd18, privacy ×2, output-validator; kd17 prints all assertions passed before its standing darwin-engine-on-linux sandbox constraint).

## 4. UI capability summary (what a user can now do)

Set a per-Space reporting currency (with an honest forward-only confirmation) and a personal default for new Spaces; see every aggregate — hero, banking, debt, investments, holdings, transactions panels, perspective cards, charts, AI summaries — denominated and labeled in the Space's currency, with per-account/per-transaction rows honestly native; see a quiet "≈ est." wherever a conversion was approximate; keep pre-change chart history truthful (stamped, converted-on-read at historical rates, badge-flagged); ask the AI and get totals labeled with the reporting currency and a single estimation disclosure only when warranted; and temporarily "View as" any approved currency on the dashboard without saving anything.

## 5. Residual / follow-on ledger (named, non-blocking)

1. **Space cards / cross-space display** — `SpacesClient` cards + `getSpaceNetWorthSummaries` sparklines remain stamp-blind with constant labels; each card should eventually render in *its own* Space's currency (deferred whole, by design).
2. **Override expansion** — the ephemeral override covers the personal dashboard's converting aggregates; banking/credit/investments pages and charts keep the persisted currency (extension is mechanical via the same view-context endpoint).
3. **Allocation precision** — `HoldingsDonutChart` proportions and the AI holdings concentration ratios compute over native position values; mixed-currency portfolios get approximate allocation percentages until per-position conversion is designed (F-9-class; zero impact all-USD).
4. **DebtClient credit-utilization sums** (F-7) — still native-summed with constant labels; thread when touched next.
5. **Chart/selector polish** — per-point dashed styling for currency-estimated segments (badge ships today), currency-change UX niceties (e.g. optimistic label swap before refresh).
6. **Transaction Intelligence** — future initiative; inherits per-row currency + conversion seams (FX-wobble vs price-change separation is now *possible* — the roadmap §6 cadence argument).
7. **Merchant Intelligence** — the next major initiative, deliberately sequenced after MC1 (per the original 2026-07-05 decision): its backfills now rewrite provenance-stamped rows, and its future rollups inherit the conversion seams for free.
8. **FX P&L (realized/unrealized)** — still gated on a cost-basis/lot model + investment-transaction ingestion (roadmap §8.2): arithmetic over what MC1 stores, addable without redesign.
9. **kd17 sandbox platform constraint** — pre-existing, unrelated.

## 6. The invariants that made it work (for the record)

Row-level self-describing money (P0) · immutable dated source-stamped rates (P1) · one pure conversion seam, never mutating stored facts (P2) · declared aggregate units with copy-once ownership and forward-only changes (P3) · labels follow values, itemized stays native, estimates say so quietly (P4). Every future money capability is arithmetic over these five — that was the promise of the roadmap's §8.3, and it held through nineteen implementation slices without one schema regret.

---

*MC1 closed. Next on the runway per STATUS.md: Merchant Intelligence, entering through its own recorded gates.*
