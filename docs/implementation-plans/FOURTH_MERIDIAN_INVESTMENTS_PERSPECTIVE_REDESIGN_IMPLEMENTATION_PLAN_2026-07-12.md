# Fourth Meridian — Investments Perspective Redesign: Investigation & Claude Code Implementation Plan

**Date:** 2026-07-12
**Branch of record:** `feature/v2.5-spaces-completion` (HEAD `33c927e` — Cash Flow redesign S1–S5 landed)
**Scope:** First real UI for the Investments Perspective — new widget design against the already-complete, already-tested A10 Investments Time Machine backend. NOT a relocation: today the perspective mounts exactly one widget (current holdings only). No backend changes, no schema, no new time model, no Space-navigation changes.
**Organizing idea (product direction, verified against the real DTO):** Wealth owns "how much am I worth." Investments answers **"what do I own, and what happened to it"** — in that order. No second hero number.

**Key inversion vs Liquidity:** A10's valuation is REAL historical pricing (A8 price foundation), not flat-held. Investments therefore SHOULD consume the shell's `asOf`/`compareTo` — that is the entire point of this backend. This plan makes Investments a real shell-driven time machine, not a current-state page.

---

## 1. Repository findings

### 1.1 Entry point and rendering path (current)

- Host: `components/dashboard/SpaceDashboard.tsx` (3,527 lines). Perspectives tabpanel at `:3133`; `PerspectiveShell` at `:3142–3165`. Bespoke branches exist for `wealth` (`:3177`) and `cashFlow` (`:3203`, the landed `CashFlowPerspective` composition); **Investments falls through to the generic `toVirtualSections(...)` → single-column `SectionCard` stack (`:3220–3243`).**
- Widget list: `lib/perspectives.ts:117–127` — `widgets: ["investment_accounts"]`, with a doctrine comment that is now stale: *"Deliberately NOT historical … (that is the future Investment Time Machine, out of scope)"*. A10 landed; the comment and `description` need updating.
- Renderer dispatch: `WIDGET_RENDERERS["investment_accounts"]` (`SpaceDashboard.tsx:1403`) → `<InvestmentAccountsWidget spaceId={p.spaceId} />` — the perspective's ONLY widget, and self-fetching (per the renderer comment at `:1399–1402`), so it ignores every prop the SectionCard path passes.
- Categories mounting Investments: PERSONAL, RETIREMENT, INVESTMENT (`lib/perspectives.ts:194–198`). The new branch serves all three identically.
- Note: the `INVESTMENTS` **rail-tab GlassModal** (`SpaceDashboard.tsx:3298`, `PERSPECTIVE_ROUTED_TABS`) renders DB-backed sections (`investment_summary`/`investment_allocation` per `lib/space-presets.ts:160–170`) — a different surface, out of scope, untouched.

### 1.2 Current widget inventory (exactly one)

| Key | Component | Responsibility | Data source |
|---|---|---|---|
| `investment_accounts` | `components/space/widgets/InvestmentAccountsWidget.tsx` (311 ln) | Current holdings grouped by account; honest per-account states: `holdings`, `zero_holdings`, `consent_required` (→ `EnableInvestmentsButton`), `needs_reauth` (→ Connections link), `error` (+ retry), `wallet`; per-account Refresh (`AccountRefreshButton`, module-private); `lastSyncedAt`; expand/collapse >5 positions | Self-fetch `GET /api/spaces/[id]/investments` → `getInvestmentAccountsView` (`lib/data/investment-accounts.ts`) → `lib/investments/current-holdings.ts` (documented "CURRENT-STATE read model only") |

**Dependency audit of the legacy path (verified by grep):** `GET /api/spaces/[id]/investments` has exactly one consumer — this widget. The widget is mounted exactly once — the Investments virtual-sections path. `virtual-sections.test.ts` does NOT lock the investments widgets[] list (only Cash Flow's and Goals doctrine). `EnableInvestmentsButton` is a standalone component (also used by ConnectionCard/import UI — unaffected). **Conclusion (§1.6): the legacy read model is superseded for VALUATION but is the sole carrier of connection-health OPERATIONS (consent/reauth/error/refresh/lastSyncedAt), which the A10 DTO deliberately does not model.**

### 1.3 The A10 backend (verified against current code — complete and tested)

- **Route:** `app/api/spaces/[id]/investments/time-machine/route.ts` — `GET ?asOf=YYYY-MM-DD[&compareTo=YYYY-MM-DD]`, membership-gated (VIEWER+). Validates ISO dates; **400s when `compareTo >= asOf`** (`:43–45`) — the client must guard. Header comment: *"The Perspective Shell owns preset/asOf/compareTo and passes RESOLVED dates here."*
- **Binding:** `lib/investments/investments-time-machine.ts` — composes `getInvestmentValueAsOf` at each endpoint (single valuation path), canonical `InvestmentEvent` reads with the A7-1 provenance filter, per-event FX at event date, then pure assembly. No persistence.
- **DTO:** `InvestmentsTimeMachineResult` (`lib/investments/investments-time-machine-core.ts:80–94`):
  - `holdings: ValuedHoldingRow[]` — ranked (value desc, unvalued last, `:100–108`), each an `InstrumentValuation` (`valuation-core.ts:71–93`: `quantity`, `nativePrice`, `nativeValue`, `reportingValue`, native `currency`, separate `quantityTier`/`priceTier`/`fxTier`/`overallTier`, `basisUsed` (institution-value / institution-price / cash / market bases), `priceDate`, `staleDays`, plain-English `reason`, `conflicted`) + `symbol`/`name`/`share` (0..1 of valued subtotal; null when unvalued).
  - `portfolio: InvestmentsPortfolio` — `valuedSubtotal` (explicitly a SUBTOTAL), `valuedCount`, `unvaluedCount`, `unvalued[]` (quantity + tier + reason — never dropped/zeroed), completeness `{tier, conflict, reason, byInstrument}`.
  - `flows: PeriodFlows | null` (`investment-flows-core.ts:124–159`) — per-category signed subtotals (contribution/withdrawal/transfer in/out/buy/sell/income/reinvestment/fee/corporate_action/opening/unclassified), `netExternalFlows` = the four boundary categories ONLY (`:60–65` — fees/buys/sells/income are INTERNAL by doctrine), caveat counters (`inKindTransferCount`, `unclassifiedCount`, `externalAmountMissingCount`, `fxEstimated`), tier + reason.
  - `reconciliation: InvestmentsReconciliation | null` — `openingValue + netExternalFlows + residualChange = closingValue`; residual honestly labeled (`RESIDUAL_REASON`, never "gains"); `endpointIncomplete` when either endpoint has unvalued positions.
  - `completeness: Completeness` — overall envelope (worst-of asOf/compareTo/flows, `buildEnvelope :185–207`).
- **Confirmed:** holdings are computed from the asOf view only (`core :123–129`); `buildReconciliation` compares portfolio-level subtotals only. **Per-holding deltas across a comparison do not exist in the DTO — and are OUT OF SCOPE (decision made; see §5 future slice).**
- **Tests already green:** `investments-time-machine-core.test.ts` (156 ln), `investments-time-machine.test.ts`, `investment-flows-core.test.ts`, `valuation-core.test.ts`. This plan adds zero backend work.

### 1.4 Data and time ownership

- `usePerspectiveShellState` (`components/space/shell/usePerspectiveShellState.ts`) is the ONE owner of `{preset, asOf, compareTo}` with URL sync; host reads `shell.state` at `SpaceDashboard.tsx:2530–2531`. Default is MTD: `asOf = today`, `compareTo = first of month` — **so flows + reconciliation are populated by default.** `compareTo` is nullable (CUSTOM after `clearCompareTo`).
- Precedent for shell-driven read models: Wealth — host-memoized `computeWealthTimeMachine({snapshots, asOf, compareTo, …})` (`:2556–2564`) feeding both the workspace and the envelope (`:3149–3155`). Investments differs only in that its read model is server-side, so the host needs a **fetch** keyed on `(spaceId, asOf, compareTo)` instead of a memo — the same shape as the existing `spaceGoals` effect-fetch pattern (`:2626–2634`).
- Today **nothing threads shell dates to Investments**: `InvestmentAccountsWidget` self-fetches current state and ignores `asOf`/`compareTo` entirely. That is the gap this plan closes.
- Swap/manual edge: the reducer can transiently produce `compareTo ≥ asOf` orderings the route 400s on; the fetch hook must send `compareTo` only when `compareTo < asOf` (otherwise omit it — honest "no comparison", never an error state).

### 1.5 Envelope integration — stale text to fix

`lib/perspectives/envelope.ts:161–169`: the `investments` case is a static `incomplete` / "Current holdings only" / *"historical valuation arrives with the price foundation"* — **stale; A8/A10 landed.** `envelope.test.ts:46–47` locks the stale text and must be updated in the same slice. The DTO's `completeness` + `portfolio` counts are the ready-made dynamic replacement (same pattern as S4's `cashFlowStamp` threading).

### 1.6 Legacy widget disposition — unify valuation, keep operations

Can the new perspective just always call the A10 route at the shell's resolved `asOf` (one read path for current + historical)? **For valuation: yes.** `asOf = today` returns today's holdings through the same canonical pricing path — no reason to keep a second valuation read model on this page. **For operations: no.** The A10 DTO (correctly) knows nothing about `consent_required` / `needs_reauth` / `error` / `zero_holdings` / `plaidItemId` / `lastSyncedAt` — affordances only `current-holdings.ts` carries, and the ownership matrix marks that lib "never rewrite" (§1.8). Disposition:

- The new composition sources ALL holdings/values/flows/reconciliation from A10 at the shell's dates — including "today".
- A small **Connections card** keeps the legacy route as its source, rendering ONLY accounts needing attention (consent/reauth/error/zero_holdings) with the existing `EnableInvestmentsButton`/`AccountRefreshButton` actions. Healthy accounts render nothing there — no duplicate holdings list.
- `InvestmentAccountsWidget.tsx` stays on disk and in `WIDGET_RENDERERS` (unmounted from this perspective once the branch preempts the generic path; one additive `export` on `AccountRefreshButton` so the Connections card reuses it instead of forking 40 lines). Never deleted in this plan.
- `lib/perspectives.ts` `widgets: ["investment_accounts"]` stays — `hasWorkspace` (shell tab affordance, `SpaceDashboard.tsx:3161`) requires a non-empty list, exactly like Cash Flow kept its list for inventory parity.

### 1.7 Layout primitives and precedent

- Both landed compositions use `grid grid-cols-1 lg:grid-cols-12 gap-4 min-w-0` with every column `min-w-0`: `WealthPerspective.tsx:65` (`items-start`) and `cashflow/CashFlowPerspective.tsx:125` (`items-stretch`). Each declares a LOCAL, non-exported `Panel` helper reproducing the SectionCard solid-lede card language (`GlassPanel depth="thin" elevation="e2" radius="lg" p-4` + `text-sm font-semibold` header) — deliberately NOT a shared abstraction. This plan copies that pattern verbatim (third local copy; extraction remains a non-goal until a fourth consumer complains).
- **Investments picks `items-start` (Wealth's):** Holdings will be much taller than the side panels; stretching the side column would produce lonely stretched cards.
- Host `accounts: SpaceAccount[]` (`SpaceDashboard.tsx:147–158`, `{id, name, institution, …}`) provides the `accountId → name` mapping for the holding trust detail — `ValuedHoldingRow.accountId` is the FinancialAccount id. No backend change needed for account attribution.

### 1.8 Concurrent-modification constraints — verified now

`FOURTH_MERIDIAN_A6_A7_A8_P5_PARALLELIZATION_INVESTIGATION_2026-07-12.md` §9: `components/dashboard/SpaceDashboard.tsx` = **single owner, "primary, always", HIGH merge risk, never a worktree**; `InvestmentAccountsWidget.tsx` + "new investment TM widgets" = **P (post-S4), worktrees never, serialized on primary**; `lib/data/investment-accounts.ts` / `current-holdings.ts` = additive only. Verified in the working tree: single local branch `feature/v2.5-spaces-completion`, `git worktree list` shows only the primary checkout, `git status` shows untracked docs only — **no other session (and no Liquidity redesign work) holds `SpaceDashboard.tsx` or shell files.** Re-verify immediately before S1 lands (stop condition §9.3).

### 1.9 Tests and conventions

House pattern: standalone `tsx` scripts (`*.test.ts`) discovered by `npm test` → `scripts/run-tests.ts`; colocated source-scan tests for compositions (`CashFlowPerspective.test.ts`, wealth tests). Must stay green: all `lib/investments/*.test.ts` (untouched), `lib/perspectives/virtual-sections.test.ts`, `time-range.test.ts`; `envelope.test.ts` is extended/amended (the investments case changes deliberately). STATUS.md maintenance rule applies at close.

### 1.10 Requirement classification

| Requirement | Status |
|---|---|
| A10 read path (route, binding, cores, tests) | **already landed** — consume only, zero backend diffs |
| Shell owns preset/asOf/compareTo; URL sync | **already landed** |
| Shell dates reaching Investments | **missing** — the core of this plan (host fetch keyed on resolved dates) |
| Portfolio Header / Holdings / Activity / Bridge panels | **missing** — new components over the DTO |
| Dynamic Investments envelope | **missing consumer; data landed** (`result.completeness` + portfolio counts); stale text at `envelope.ts:161` fixed here |
| Connection-health affordances (consent/reauth/refresh) | **already landed in legacy widget** — preserved via the Connections card (§1.6) |
| Per-holding value/weight deltas across comparison | **out of scope** (decision made) — named future slice §5, never designed around |
| Per-holding gain/loss & cost basis | **forbidden** — not in the data; fabricating violates the codebase-wide "unknown is preferable to incorrect" doctrine |

---

## 2. Product-vision-to-DTO mapping

| Vision region | DTO source | Fit / adjustment |
|---|---|---|
| Portfolio Header — small, not a hero: total valued amount, as-of date, one trust chip | `portfolio.valuedSubtotal` + `reportingCurrency`; `asOf`; `valuedCount`/`unvaluedCount` + `completeness.reason` | **Direct.** Pixel rule: when `unvaluedCount > 0` the figure is labeled as a partial ("Valued holdings"), never "portfolio total". |
| Holdings (dominant): weight bar per row = composition view; trust marks only when something's off; unvalued as dimmed real rows | `holdings[]`: `share` drives the bar; marks from `overallTier ≠ observed`, `staleDays > 0`, `basisUsed` institution-\*, `conflicted`; unvalued rows have `quantity` + `reason`, value "—" | **Direct.** Clean rows (observed, fresh, market/cash basis, no conflict) show zero marks. Trust detail is tap-in (expandable row), not inline prose. No donut chart. |
| Period Activity: flows grouped by intent, deterministic template sentences | `flows` per-category subtotals + counts + caveat counters | **One adjustment:** vision grouped fees under "money out" — but `investment-flows-core.ts` doctrine makes fees INTERNAL (`EXTERNAL_BOUNDARY_CATEGORIES` is exactly the four). Grouping fees as money-out would make Activity's "money out" disagree with the Bridge. Final grouping: **money in** = contribution + transfer_in; **money out** = withdrawal + transfer_out; **inside the portfolio** = buy/sell/income/reinvestment/fee/corporate_action; caveat line from unclassified/in-kind/missing-amount/FX-estimated counters. |
| The Bridge: opening → +money in → −money out → "Portfolio change" waterfall; residual framed as "what's inside this number" | `reconciliation` (+ `flows.contributions/transfersIn/withdrawals/transfersOut` for the in/out split — these four sum to `netExternalFlows` exactly, so the identity holds row-by-row) | **Direct.** Residual copy: "Your portfolio changed {±X} beyond what you moved in or out"; `residualReason` + `endpointIncomplete` caveat one tap deep. NO per-holding gain/loss column. |
| Time machine control: shell-owned | `shell.state.asOf/compareTo` → fetch params | **Direct** — no page-local date picker; presets/compare/swap all already work in the shell. `compareTo = null` ⇒ Activity/Bridge render an honest "no comparison period selected" state, never fabricate a window. |

---

## 3. Exact implementation design

### 3.1 Approach — smallest honest implementation

One host-level fetch hook + one new composition component (Wealth/Cash Flow grid pattern) + four panel components + two pure presentation-model helpers + one bounded `SpaceDashboard.tsx` branch + the envelope case swap. **No registry, no schema-driven layout, no chart library (waterfall = CSS bars), no client cache layer beyond keeping the last result, no shared Panel abstraction, no backend or `lib/investments/**` changes.**

### 3.2 Files

**Add (all under `components/space/widgets/investments/`):**
- `useInvestmentsTimeMachine.ts` — client hook: fetches `/api/spaces/${spaceId}/investments/time-machine?asOf=…[&compareTo=…]` when `active`; sends `compareTo` only when non-null AND `< asOf`; keeps the last result while refetching (no flash), `active`-flag cancellation (goals-fetch pattern), `{result, loading, error, reload}`. Types via `import type { InvestmentsTimeMachineResult } from "@/lib/investments/investments-time-machine-core"` (type-only — erased, client-safe).
- `InvestmentsPerspective.tsx` — the composition (grid + local `Panel` helper + Portfolio Header). Owns NO time state; props in, render out.
- `InvestmentsHoldings.tsx` — the dominant table: rank, symbol/name, quantity, native price+currency, reporting value, share weight bar, conditional trust marks; unvalued rows dimmed with quantity and reason; expandable per-row trust detail (S2): quantity/price/FX/overall tiers, `basisUsed`, `priceDate`, `staleDays`, `reason`, account name via the host `accounts` map.
- `InvestmentsActivityCard.tsx` + `investments-activity.ts` (+ `.test.ts`) — pure `buildActivityGroups(flows)` → typed groups/sentences per §2 grouping (exported for the colocated test); the card renders them + the no-comparison and no-events states (from `flows.reason`).
- `InvestmentsBridgeCard.tsx` + `investments-bridge.ts` (+ `.test.ts`) — pure `buildBridgeRows(reconciliation, flows)` → opening / money in / money out / portfolio change (residual) / closing rows with the row-sum identity guaranteed; the card renders CSS-bar waterfall + tap-in residual/endpoint disclosure.
- `InvestmentConnectionsCard.tsx` — fetches the legacy `GET /api/spaces/[id]/investments`; renders ONLY attention states (consent_required / needs_reauth / error / zero_holdings) as compact action rows reusing `EnableInvestmentsButton` + `AccountRefreshButton`; renders null when all healthy (its Panel is conditionally omitted).
- `InvestmentsPerspective.test.ts` — colocated source-scan test (§7).

**Modify:**
- `components/dashboard/SpaceDashboard.tsx` — bounded changes only: (a) `investmentsActive` flag (mirrors `wealthWorkspaceActive`); (b) one `useInvestmentsTimeMachine(spaceId, asOf, compareToForFetch, investmentsActive)` call beside the wealth memo; (c) thread `investmentsResult` into the existing `resolvePerspectiveEnvelope` call at `:3149`; (d) one `activePerspectiveId === "investments"` branch between the `cashFlow` branch and the generic path, rendering `<InvestmentsPerspective result={…} loading={…} error={…} onRetry={…} accounts={accounts} spaceId={spaceId} compareTo={…} />`. Nothing else in this file changes.
- `lib/perspectives/envelope.ts` — `investments` case takes optional `investmentsResult`; absent ⇒ `{}` (inert "—" chips, honest while loading — the stale static text is REMOVED); present ⇒ completeness from `result.completeness` (tier map `unknown→incomplete`; labels from a fixed vocabulary: observed "Fully valued" / derived "Reconstructed" / estimated "Estimated" / incomplete "Partially valued"; conflict ⇒ warning tone; `detail` = `result.completeness.reason`) and evidence `{ label: "X of Y positions valued" }` (real counts, no fabricated rows).
- `lib/perspectives/envelope.test.ts` — investments case rewritten: absent-result ⇒ empty envelope; result-driven mapping (tiers, conflict tone, counts label). The `:46–47` stale-text assertions are deliberately replaced.
- `lib/perspectives.ts` — `investments` entry: refresh `description` + the stale "Deliberately NOT historical" doctrine comment to name the A10 time machine. `widgets: ["investment_accounts"]` UNCHANGED (§1.6).
- `components/space/widgets/InvestmentAccountsWidget.tsx` — ONE additive change: `export` `AccountRefreshButton`. No behavior change.

**Explicitly untouched:** the A10 route and everything in `lib/investments/**`, `lib/data/investment-accounts.ts`, `usePerspectiveShellState.ts`, `PerspectiveShell.tsx` + shell components, `lib/perspectives/time-range.ts`, `virtual-sections.ts`, all Wealth/CashFlow/Liquidity/Debt files, the INVESTMENTS GlassModal path, Space navigation.

### 3.3 Grid structure

`InvestmentsPerspective.tsx` root (mirrors `WealthPerspective.tsx:65`):

```tsx
<div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start min-w-0">
  {/* ① Portfolio Header — compact strip, NOT a hero */}
  <div className="min-w-0 lg:col-span-12"> <Panel>…header…</Panel> </div>
  {/* ② Holdings — the dominant panel */}
  <div className="min-w-0 lg:col-span-7 xl:col-span-8"> <Panel title="Holdings">…table…</Panel> </div>
  {/* ③ Right column: Period Activity → The Bridge → Connections (conditional) */}
  <div className="min-w-0 lg:col-span-5 xl:col-span-4 flex flex-col gap-4">
    <Panel title="Period Activity">…</Panel>
    <Panel title="Change Bridge">…</Panel>
    {needsAttention && <Panel title="Connections" subdued>…</Panel>}
  </div>
</div>
```

- Desktop (`xl` ≥1280): Header 12 / Holdings 8 / side column 4. Tablet (`lg`): Holdings 7 / side 5. Mobile (<1024): single column, source order = **Header → Holdings → Activity → Bridge → Connections.**
- Heights: none fixed, no internal scroll, no clipping; side column is a flex stack (content-defined heights). Gap `gap-4`. Every child `min-w-0`.
- Loading (no result yet): centered spinner in place of the grid; error: honest retry card (legacy widget's pattern). Empty (`holdings.length === 0 && portfolio.unvaluedCount === 0`): the connect-CTA empty state (mirrors the legacy widget's), plus the Connections card if anything needs attention.

### 3.4 Panel content rules (honesty machinery, from the DTO verbatim)

- **Header:** figure = `formatCurrency(valuedSubtotal, reportingCurrency)`; sublabel "as of {asOf}" (+ "vs {compareTo}" when comparing); chip "{valuedCount} of {valuedCount+unvaluedCount} positions valued" — warning-toned when `unvaluedCount > 0`, tap → `portfolio.completeness.reason`. Label the figure "Valued holdings" whenever `unvaluedCount > 0`.
- **Holdings trust marks (render ONLY when off):** tier dot when `overallTier !== "observed"`; "· {n}d" staleness when `staleDays > 0`; "inst." mark when `basisUsed` is `institution-value`/`institution-price`; conflict warning when `conflicted`. All detail lives in the tap-in expansion — one glyph row max inline, no caveat prose in rows.
- **Activity:** deterministic template sentences (same register as Cash Flow Key Insights, no LLM), e.g. "You added {$} ({n} contributions, {m} transfers in)" / "Inside the portfolio: {n} buys, {m} sells, {$} income, {$} fees"; one caveat sentence built from the four counters + `fxEstimated`; `flows.reason` covers the zero-event case.
- **Bridge:** rows opening → +money in (contributions+transfersIn) → −money out (withdrawals+transfersOut) → "Portfolio change" (residual) → closing. Copy frames the residual as what's inside the number ("changed {±X} beyond what you moved in or out"); `residualReason` and the `endpointIncomplete`/`conflict` reasons one tap deep. Signs must satisfy the identity exactly — the pure helper asserts it.
- Neither Activity nor Bridge references the Wealth hero or restates the Header figure as a second KPI.

### 3.5 Temporal model

- Host fetch key: `(spaceId, asOf, compareToForFetch)` where `compareToForFetch = compareTo && compareTo < asOf ? compareTo : null`; fetch only while `investmentsActive`. Preset selection, As-Of edits, Compare-To edits, and swap all flow through the shell exactly as today — zero new time UI, zero investments-specific handling in the shell.
- `compareTo = null` ⇒ `flows`/`reconciliation` are null ⇒ Activity + Bridge render "Pick a comparison date to see what happened" — honest, never fabricated.
- The legacy `cashFlowPeriod` bridge is irrelevant here (Investments consumes resolved dates natively — the model Cash Flow's plan deferred to a future cutover, achieved here because the backend already speaks it).

---

## 4. Slice plan (each independently compilable and shippable)

- **S1 — Shell-driven read + Holdings core + envelope.** `useInvestmentsTimeMachine`, `InvestmentsPerspective` (Header + Holdings with weight bars, inline trust marks, dimmed unvalued rows; side column holds only Connections for now), `InvestmentConnectionsCard` (+ the one-line `AccountRefreshButton` export), the `SpaceDashboard.tsx` branch + envelope threading, `envelope.ts` case + test rewrite, `perspectives.ts` comment refresh. Parity checkpoint: every capability the legacy stack offered (see holdings incl. today's, Enable Investments, reconnect, refresh, per-state honesty) still reachable; PLUS as-of now works.
- **S2 — Trust detail tap-in.** Expandable holding rows: four tiers, basis, price date, staleness, reason, account attribution. No new data.
- **S3 — Period Activity.** `investments-activity.ts` (+ test), `InvestmentsActivityCard`, mounted at the top of the side column.
- **S4 — The Bridge.** `investments-bridge.ts` (+ test), `InvestmentsBridgeCard` beneath Activity.
- **S5 — Responsive audit + tests + STATUS.md.** lg/xl spans, 375px order, long instrument names truncate (`min-w-0`), no horizontal overflow; §7 suite green; STATUS.md entry per the maintenance rule.

S3 and S4 are independent of each other; if either proves contentious, S1+S2(+S5) ship as a complete slice (side column = Connections only; grid stays valid).

---

## 5. Risks

- **`SpaceDashboard.tsx` merge risk (HIGH):** single-owner file (§1.8). Mitigation: primary branch only, one additive branch + ~4 host lines, land S1 promptly, STATUS.md coordination, re-verify no concurrent session before starting.
- **Fetch churn:** every As-Of/Compare-To/preset change refetches. Acceptable (discrete user actions, one bounded query); mitigate flash by holding the last result during refetch and cancelling stale responses. Do NOT build a cache layer in this plan.
- **`compareTo ≥ asOf` transient orderings** (swap/manual edits) would 400 — the hook's guard (§3.5) makes them honest no-comparison states instead.
- **Partial-subtotal mislabeling (the pixel rule):** never present `valuedSubtotal` as "portfolio value" when `unvaluedCount > 0`; the Header labeling rule and source-scan test enforce it.
- **Bridge double-counting:** fees/buys/sells/income must NEVER be added to the bridge's in/out rows (they're inside the residual by construction). The pure helper's identity assertion + tests lock this.
- **Losing operational affordances:** Enable/reconnect/refresh exist only in the legacy path — the Connections card is a hard S1 requirement, not polish.
- **Second hero temptation:** the Header must stay a compact strip; Wealth owns the big number. Review in S5.
- **Large portfolios:** the table renders all rows (legacy widget previewed 5/account). Keep a simple "show all N" expander past ~15 rows — presentation only, all rows in DOM state, nothing hidden from the honesty model.

## 6. Overengineering check

Confirmed feasible as: **one hook + one composition + four panels + two pure helpers + one host branch + one envelope case.** Rejected: widget registry/schema extension, shared Panel/grid abstraction, chart library for the waterfall, client cache/SWR layer, per-holding delta engine, drawer primitive (expandable rows suffice), any `lib/investments/**` change. **Named future slice (explicitly NOT built now):** per-holding value/weight deltas via a second fetch at `compareTo` diffed client-side by `instrumentId` — no backend change needed; nothing in this plan blocks or pre-builds it.

## 7. Testing expectations (house pattern: standalone tsx `*.test.ts` via `scripts/run-tests.ts`)

`InvestmentsPerspective.test.ts` (source-scan, like the wealth/cashflow colocated tests):
1. Grid classes `lg:grid-cols-12`, the specified spans, `min-w-0` on every child; no fixed `h-[`/`max-h-` on panels; `items-start`.
2. Source order (= mobile order): Header, Holdings, Activity, Bridge, Connections.
3. No import of `usePerspectiveShellState` (time stays host-owned); no import from `wealth/` or `cashflow/`; DTO types imported `import type` only.
4. Unvalued handling present: renders `portfolio.unvalued` rows and never filters them; the partial-subtotal label branch exists.
5. Hook scan: `compareTo < asOf` guard present; `active` cancellation present.
6. `SpaceDashboard` scan: the `investments` branch exists once, passes `result`/`accounts`/`spaceId`, and `investmentsResult` reaches `resolvePerspectiveEnvelope`.

Pure-model tests: `investments-activity.test.ts` (grouping exactly per §2 — fees inside, external = the four; caveat sentence from each counter; zero-event and null-flows cases) and `investments-bridge.test.ts` (row identity `opening + in + out + residual = closing` across sign fixtures; endpointIncomplete/conflict caveats; null reconciliation). Amended `envelope.test.ts` (absent ⇒ `{}`; tier/conflict/count mapping). Untouched and green: all `lib/investments/*.test.ts`, `virtual-sections.test.ts`, `time-range.test.ts`, all wealth/cashflow tests.

## 8. Validation gate (run in order; all must pass)

```bash
npx tsc --noEmit
npx eslint
npm test                       # scripts/run-tests.ts
git diff --name-only           # must contain ONLY the files listed in §3.2
npm run dev                    # manual pass — desktop xl, ~1100px lg, 375px mobile:
                               #  · default MTD load (flows+bridge populated), asOf=today parity vs old widget
                               #  · historical asOf; compareTo on/off; swap; CUSTOM; every preset
                               #  · unvalued rows visible + reasons; trust marks only on off rows; tap-in detail
                               #  · consent_required / needs_reauth / error accounts → Connections card actions work
                               #  · shell Completeness chip dynamic; Evidence label = real counts
                               #  · no horizontal overflow; no second hero
```

## 9. Stop conditions — halt and report instead of proceeding if:

1. Any panel turns out to require a change to `lib/investments/**`, the A10 route, or any backend file (the DTO is the contract; if it can't express a panel, cut the panel, don't extend the backend here).
2. A panel cannot be built without fabricating data the DTO doesn't carry — especially per-holding gain/loss, cost basis, or per-holding comparison deltas.
3. `SpaceDashboard.tsx` or `components/space/shell/*` are actively owned by another session/stream at implementation time (check `git status`/worktrees/STATUS.md first — clean as of this writing, §1.8).
4. Preserving the Enable-Investments / reconnect / refresh affordances would require rewriting `current-holdings.ts` or the legacy route (both are additive-only per the ownership matrix).
5. Scope drifts beyond Investments presentation + the named envelope/perspectives.ts touches (any diff in Wealth/CashFlow/Liquidity/Debt widgets, shell time model, or Space navigation).

---

**Final instruction to the implementation session:** the product vision above is direction, not gospel — every panel is bounded by what `InvestmentsTimeMachineResult` actually carries, and two adjustments are already baked in (fees are internal, not money-out; per-holding deltas are out of scope). Consume the shell's resolved dates; keep the `SpaceDashboard.tsx` footprint to the single documented branch; render the honesty machinery as quiet marks and tap-ins, never walls of caveats; and when in doubt, prefer the smaller change and the Wealth/Cash Flow precedent.
