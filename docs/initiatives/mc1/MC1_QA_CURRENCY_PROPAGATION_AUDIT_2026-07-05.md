# MC1 Post-Closeout QA — Currency Propagation Audit & Cleanup Plan

**Status:** Investigation + cleanup plan only — no implementation, no schema change, no code change is made by this document.
**Date:** 2026-07-05, audited against the working tree at MC1 completion.
**Trigger:** live QA found propagation gaps after the MC1 closeout. This audit re-enumerated **every** money-formatting site (`formatCurrency` callers, `Intl.NumberFormat` uses, remaining `DEFAULT_DISPLAY_CURRENCY` value-uses, hardcoded `"USD"`, `useDisplayCurrency` coverage) and classified each. The residual ledger was context, **not** assumed complete — and indeed it missed two genuine mislabel bugs (§2, KpiRow and PerspectivesWidget).
**Doctrine (unchanged):** labels follow values · aggregates in `Space.reportingCurrency` unless explicitly deferred · itemized rows native — which means the row's **own** currency, not a hardcoded constant · no stored-fact mutation · surgical fixes only.

---

## 1. Classification key

**C1** converted + correctly labeled ✅ · **C2** native + correctly labeled ✅ · **C3** converted but MISLABELED 🐞 · **C4** not converted but should be 🐞 · **C5** correctly deferred/residual 📋 · **C6** needs refresh but should live-update 🔧

## 2. Surface-by-surface matrix

| Surface / site | Values | Label | Class | Expected behavior |
|---|---|---|---|---|
| **DashboardClient** section totals (`fmtAggAbs`) | converted | effective display cur | **C1** ✅ | as-is |
| **KpiRow** hero tiles (`formatCurrency` from lib/format) | **converted** (classification) | **hardcoded USD default** | **C3 🐞** | format in display currency (hook is already available via the Slice 8 provider wrapper) — this is QA's "converts but still shows $" |
| **NetWorthCard** | converted | display cur (hook) | **C1** ✅ | as-is |
| **CashOnHandCard / DebtCard** (Banking tab cards) | **raw sums** of account balances | USD default | **C4 🐞** | aggregate cards → convert (context available in host) + label; per-account line items inside them stay native |
| **BankingClient** totals/instTotal/flow (`fmtAgg*`) | converted | display cur | **C1** ✅ | as-is |
| BankingClient per-account row (`fmtAbs` L382) + tx-row subcomponent (L529) | native | **constant USD** | **C3b 🐞** (itemized mislabel) | itemized = row's own `currency` — pass `a.currency`/`tx.currency`; visually identical for USD data |
| **DebtClient** Total Debt Paid + per-card rollup | converted | display cur + est. | **C1** ✅ | as-is |
| DebtClient credit-utilization block (totalUsed/Limit/Available) | raw sums | constant USD | **C4 🐞** (was F-7) | QA names "debt breakdown" — promote from residual to fix: convert + label + taint |
| DebtClient per-card rows / modal tx rows | native | constant USD | **C3b 🐞** | row currency |
| **Credit page payoff planner** — `SpaceDashboard` planner math (hardcoded USD ×3: L1108/1142/1226) + `DebtPayoffSection` + `debt-adapters` | raw | hardcoded/constant USD | **C4 🐞** | QA-named: planner projections are aggregates → convert + label via the Space's currency (SpaceDashboard already fetches `moneyCtx` since F-6 — extend its use) |
| **InvestmentsClient** stock/crypto/combined totals | converted | display cur + est. | **C1** ✅ | as-is |
| InvestmentsClient itemized (`fmt`: account balance, price, position value, crypto rows) | native | constant USD | **C3b 🐞** | row currency |
| **Holdings page** headline | converted | space cur + est. | **C1** ✅ | as-is |
| Holdings page position rows | native | hardcoded USD param default | **C3b 🐞** | row currency |
| **HoldingsDonutChart** center/total labels | native sums | display-cur-capable (param) but callers pass nothing → USD | **C5→C4 edge** | keep as residual only if donut stays native-summed; if C4 slice converts feeding totals, labels follow (allocation precision stays the recorded residual) |
| **SpaceDashboard** widgets (`ProgressWidget`, `AssetValueWidget`, `BreakdownWidget`, `SpaceTrendHero` hardcoded USD) | raw | constant/hardcoded USD | **C4 🐞** | space-scoped aggregates → convert via the Space's context + label |
| **SpaceTransactionsPanel** totals (both hosts) | converted | display cur (provider-wrapped on personal; **SpaceDashboard host lacks a provider wrapper** → labels fall back USD there) | **C1 / C3 🐞 split** | wrap the SpaceDashboard instance (or mount a provider in SpaceDashboard) so labels follow its converted values — QA's "some charts/panels don't inherit" |
| STP transaction rows | native | constant USD | **C3b 🐞** | row currency |
| **SpacesClient / Space cards** (+ `getSpaceNetWorthSummaries`) | each space's own stamped values | constant USD | **C5→C4 promote** | QA-named: each card should label in **that** space's `reportingCurrency` (values are already that space's own stamps — a per-card label + reader select, no conversion) |
| **PerspectivesWidget** `formatMetricValue` | **converted** lens metrics (liquidity) | **`formatCurrency` USD default** | **C3 🐞** | format in display currency (hook) |
| Lens **verdict strings** (`liquidity.core`) | converted | `formatCurrency` USD default inside server-built text | **C3 🐞** | verdicts must format with `ctx.target` (the core already receives the context) |
| **debt.core lens** (perspective debt) | **raw sums** — never threaded | USD default | **C4 🐞** | thread like liquidity (same classifier pattern); QA's "Perspectives do not fully inherit" |
| **Charts** (Cash/NetWorth/Banking/Investments/PortfolioHistory/Modal) | converted (stamp-aware readers) | display cur (hook) | **C1** ✅ | as-is |
| **AllocationChart** | check feed | hardcoded USD | **C4/C3b — resolve in slice** | align with its feed |
| **History page** (`app/(shell)/dashboard/history/page.tsx`) | **converted** (stamp-aware reader) | **hardcoded USD** (server fmt) | **C3 🐞** | server component → format with `ctx.space.reportingCurrency` |
| **AI serializer** label + disclosure | converted | dynamic `{CUR}` | **C1** ✅ | as-is |
| **Selectors** (ManageSpaceModal, Settings, override) | n/a | correct + copy | **C1** ✅ | as-is |
| **AddManualAssetModal / ManageSpaceModal constants** | form defaults, not money display | n/a | **C2** ✅ | as-is |
| **AccountCard / AccountModal / AccountGroupCard / AssetDrawer / RemoveAccountModal** | native row values | constant USD | **C3b 🐞** | itemized → row's own currency (identical for USD rows) |
| **Currency-change live update** | — | — | **C6 🔧** | modal `router.refresh()` re-renders server props, but: SpaceDashboard's client-fetched data doesn't refetch, and the layout-level provider refresh timing makes the update feel non-atomic. Fix: broadcast a `SPACE_CURRENCY_CHANGED` event (house `SPACE_LIST_CHANGED` pattern) → client hosts refetch/re-render; verify refresh ordering with the modal open |

## 3. Root-cause summary

Three systematic gaps, not many random ones: **(a)** two Slice-1 swap omissions on surfaces whose *values* were already converted (KpiRow via `lib/format`'s default, PerspectivesWidget's shared metric formatter) plus the history page's hardcoded server formatter — the exact "converted but $" class; **(b)** the itemized rule was implemented as "keep the constant" when doctrine says "row's own currency" — invisible in the USD era, wrong for any non-USD row; **(c)** the SpaceDashboard/space-widgets family and the debt lens were deferred wholesale, but QA (payoff planner, debt breakdown, perspectives) now demands them.

## 4. Cleanup slices (minimal, ordered by priority)

| Slice | Scope | Class fixed |
|---|---|---|
| **Q1 — Mislabeled conversions (highest)** | KpiRow → display-currency formatting; PerspectivesWidget `formatMetricValue` → hook; liquidity verdict strings → `ctx.target`; history page → space currency. Zero value changes — labels only. | C3 |
| **Q2 — Un-threaded aggregates** | debt.core lens threaded (classifier pattern + verdict target); DebtClient utilization block (F-7); CashOnHandCard/DebtCard converted via host context; AllocationChart aligned. | C4 |
| **Q3 — Itemized rows to row currency** | One tiny shared helper (`formatNative(amount, rowCurrency)`); apply across AccountCard/Modal/GroupCard, AssetDrawer, RemoveAccountModal, Banking/Debt/STP/Investments/Holdings rows. All-USD pixel-identical. | C3b |
| **Q4 — SpaceDashboard family** | Provider mount (or wrapper) in SpaceDashboard using its Space's currency; payoff planner + Progress/AssetValue/Breakdown/TrendHero/debt-adapters convert via the F-6 context (extend accounts payload with `moneyCtx` if needed); STP host labels fixed by the same mount. | C4 + C3 split |
| **Q5 — Space cards** | `getSpaceNetWorthSummaries` selects each space's `reportingCurrency`; cards label per-space (values already per-space stamps — no conversion). | C5 promote |
| **Q6 — Live-update smoothing** | `SPACE_CURRENCY_CHANGED` event from the modal save → SpaceDashboard refetch + any client host re-render; verify `router.refresh()` ordering. | C6 |

Every slice: no schema, no writes, no architecture change; kill switches inherited (missing context/currency ⇒ today's behavior).

## 5. Validation gates (every slice)

1. **USD invariance:** all-USD Space renders pixel-identical after each slice (labels only ever change where a non-USD value/currency is present).
2. **Label-follows-value:** for a fixture EUR Space, every audited surface shows € exactly where values are converted, native symbols on itemized rows, and no $ anywhere a converted value renders.
3. Existing suites + `tsc` + lint green per slice; Q2 adds equivalence gates for the debt lens (mirror the liquidity gates).
4. Q6: manual QA script — change currency in the modal, observe every open surface update without a hard reload.

## 6. First implementation prompt

> Implement QA cleanup Slice Q1 per `docs/initiatives/mc1/MC1_QA_CURRENCY_PROPAGATION_AUDIT_2026-07-05.md` §4 exactly — mislabeled conversions only, zero value changes. (1) `KpiRow`: format the three classification tiles and cash-flow tile via the display currency (the component already renders inside a `DisplayCurrencyProvider` wrapper — use `useDisplayCurrency()` instead of lib/format's USD-default `formatCurrency`). (2) `PerspectivesWidget.formatMetricValue`: currency metrics format in `useDisplayCurrency()`. (3) `lib/perspective-engine/lenses/liquidity.core.ts`: verdict strings format with the conversion context's target when a context is supplied (`formatCurrency(x, ctx?.target)`) — pure change, update the lens gates accordingly. (4) `app/(shell)/dashboard/history/page.tsx`: server formatter takes `ctx.space.reportingCurrency`. No itemized-row changes, no new conversions, no SpaceDashboard work (Q2–Q6). Validate: `npx tsc --noEmit`, `npm run lint`, `npm test`, plus the USD-invariance and label-follows-value gates from §5. Stop after Q1 and report.

---

*End of audit. Investigation only — no code changed. Cleanup begins on approval, one slice at a time.*
