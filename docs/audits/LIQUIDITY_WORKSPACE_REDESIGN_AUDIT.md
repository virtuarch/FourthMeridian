# Liquidity Workspace — Presentation Redesign Audit

**Status:** Read-only investigation + implementation plan. Nothing implemented.
**Scope:** Presentation-only redesign of the Liquidity workspace onto the established
editorial workspace language (Wealth / Investments v2 / Debt). Authority, loaders, the
`LiquiditySpaceData` contract, the temporal model, the trust envelope, and every
calculation stay **untouched**.
**Date:** 2026-07-18
**Sibling references:** `docs/architecture/WORKSPACE_CONTRACT_DOCTRINE.md`,
`docs/audits/SPACE_DASHBOARD_REMAINING_OWNERSHIP_AUDIT.md`,
`docs/audits/INVESTMENTS_GAIN_DISCONNECT_AUDIT.md`, the Debt editorial redesign
(`components/space/widgets/debt/`).

---

## 0. TL;DR

Liquidity already carries a first-class, honest historical engine
(`loadLiquiditySpaceData`, LIQ-H1) — but the **presentation** only lets that history ride
**one** panel (the Ladder + lede). Four of the five surfaces (Accessible Cash, Emergency
Fund Readiness, Reachability, Concentration) are **live present-day figures** that silently
stay present-day in a historical view, with the mixed authority documented only in code
comments (`LiquidityWorkspace.tsx:18-42`), never surfaced to the user. Debt solved the
identical asymmetry by **saying so** ("Balances are current — the trend and verdict below
reflect {asOf}", `DebtHero.tsx:126-130`); Liquidity does not.

The single biggest **opportunity**: Liquidity can gain a real **Balance History**
`TrendChart` with **zero new calculation authority** — the `Snapshot` series already carries
`totalCash` + `totalSavings` (= the `cashNow` tier) and `totalInvestments` + `totalCrypto`
(= the `marketable` tier), and Debt already clips its `totalDebt` series from that same
snapshot array (`lib/debt-space-data.ts:92-108`). Threading the already-loaded
`snapshots`/`snapshotCurrency` props (present in the renderer ctx, wired to Debt today) is
all that stands between Liquidity and a shared-chart Balance History.

Proposed hierarchy: **Accessible Cash (Hero) → Balance History → Sources ladder
(LeftPanel/RightPanel) → Resilience & Risk → What Changed / Actions**.

---

## 1. Current architecture

### 1.1 Data flow (verified)

```
SpaceShell ──(asOf / compareTo / today / accounts / presentLens)──▶
  workspaceRenderers.tsx:120  LiquidityWorkspace
    │  owns useLiquiditySpaceData (client binding)
    ▼
  useLiquiditySpaceData.ts
    • present-day (asOf ≥ today, no compareTo): NO fetch — synthesizes the contract
      from the host's present-day lens (presentLens = lensResults["liquidity"]) via
      the PURE assembleLiquiditySpaceData (current only; atAsOf/atCompareTo/delta null)
    • historical / comparison: GET /api/spaces/[id]/liquidity/space-data → server loader
    ▼
  lib/liquidity/space-data.ts:167  loadLiquiditySpaceData  (THE authority)
    • current      → computePerspective("liquidity")  [live lens @ today]
    • atAsOf /     → evaluateHistorical: getAccountsAsOf (cash/card walked back, rest
      atCompareTo    held flat) + getInvestmentValueAsOf(scope 'all', A8 price×qty×FX)
                     → spliceLiquidityRows (REPLACE covered investment/crypto rows'
                       held-flat estimate with A8 value) → UNCHANGED computeLiquidity
                       → UNCHANGED buildLiquidityCompleteness
    • delta        → assembleLiquiditySpaceData (pure per-tier subtraction; credit excluded)
    • trust        → atAsOf.completeness re-surfaced (pointer, not recompute)
    ▼
  convertLiquiditySpaceData (lib/liquidity/display-conversion.ts)  [per-date display FX]
    ▼
  LiquidityWorkspace render
```

### 1.2 Authorities (each untouched by this redesign)

| Concern | Authority | File:line |
| --- | --- | --- |
| Ladder math (`cashNow` / `marketable` / `illiquid` / `availableCredit`) | `computeLiquidity` (pure) | `lib/perspective-engine/lenses/liquidity.core.ts:111` |
| Historical marketable splice (crypto counted once) | `spliceLiquidityRows` (pure) | `lib/liquidity/historical-splice.ts:118` |
| Composition contract (current/atAsOf/atCompareTo/delta/trust) | `assembleLiquiditySpaceData` (pure) | `lib/liquidity/space-data-core.ts:144` |
| Server binding / DB reads | `loadLiquiditySpaceData` | `lib/liquidity/space-data.ts:167` |
| Display-currency conversion | `convertLiquiditySpaceData` | `lib/liquidity/display-conversion.ts` |
| Live per-account classification | `classifyAccounts` | `lib/account-classifier.ts:206` |
| Trust envelope | `resolvePerspectiveEnvelope` → `TrustIndicator` | `LiquidityWorkspace.tsx:192` |

### 1.3 Current UI (the thing being redesigned)

`LiquidityWorkspace.tsx` renders a 12-col card grid of six surfaces, each wrapped in a
local `Panel` helper (a `GlassPanel`, `LiquidityWorkspace.tsx:83-92` — **not** the editorial
`Surface`/`Block` the Debt/Investments redesigns use):

| # | Surface | Renderer | Temporal posture |
| --- | --- | --- | --- |
| ⓪ | Lens lede (verdict sentence + freshness + `TrustIndicator`) | `renderLede` (`LiquidityWorkspace.tsx:202`) | **as-of aware** (reads `atAsOf` when historical) |
| ① | Accessible Cash | `renderAccessibleCash` (`liquidity-adapters.tsx:112`) | **present-day only** |
| ① | Emergency Fund Readiness | `renderEmergencyFundReadiness` (`liquidity-adapters.tsx:147`) | **present-day only** |
| ② | Liquidity Ladder | `LiquidityLadderTiers` (present) / reconstructed tiers (`renderLadder`) | **the ONE temporal panel** |
| ③ | Reachability by Type (donut) | `renderReachability` (`LiquidityWorkspace.tsx:229`) | **present-day only** |
| ④ | Liquidity Concentration | `renderLiquidityConcentration` (`liquidity-adapters.tsx:177`) | **present-day only** |
| ⑤ | What Changed | `LiquidityWhatChangedCard` | present-day (tx window relative to today) |

### 1.4 Historical capability (current limitation)

Doctrine marks Liquidity `temporalCapability: PARTIAL` and names the exact gap:

> "⚠️ parallel account panels (design) · ⚠️ **Partial** — Ladder+lede+trust only …
> **Temporal gap**" — `WORKSPACE_CONTRACT_DOCTRINE.md:198`
> "Accessible Cash, Emergency Fund Readiness, Reachability, and Liquidity Concentration
> recompute from the live `accounts` array … only the Ladder + lede + delta are as-of
> aware." — `WORKSPACE_CONTRACT_DOCTRINE.md:248-251`

The engine itself is **not** the limitation — `atAsOf`/`atCompareTo`/`delta`/`trust` are all
honest. The limitation is **presentational**: the historical truth the engine produces is
only wired into one of six surfaces, and the other five are present-day without saying so.

---

## 2. Temporal honesty map (the crux)

**Setup:** the user picks `asOf` = a past date (historical view). Classify each *value the
user sees* as: **Historical** (reconstructed for `asOf`), **Current** (live, present-day),
**Derived-from-historical** (a subtraction/ratio of historical endpoints), or **Unknown**.

| Value (as shown to the user) | Source | Classification @ historical asOf | Honest today? |
| --- | --- | --- | --- |
| Lens **verdict** sentence (lede) | `atAsOf.verdict` (`renderLede`, reads `ledeLens`) | **Historical** | ✅ tagged "as of {date}" |
| Ladder **Available now** (`cashNow`) | `atAsOf` metric `cashNow` (cash/card walked back by `getAccountsAsOf`) | **Derived-from-historical** (posted-basis walk-back) | ✅ trust tier = `derived` |
| Ladder **Available in days** (`marketable`) | `atAsOf` metric `marketable` (A8 splice where covered; else held-flat) | **Historical where A8-covered; Estimated (held-flat) otherwise** | ✅ tier `derived`/`incomplete` via splice stamps |
| Ladder **Illiquid** | `atAsOf` metric `illiquid` (held-flat real assets) | **Estimated (held-flat)** | ✅ tier `estimated` |
| Ladder **per-tier delta chips** | `delta.cashNow/marketable/illiquid` | **Derived-from-historical** (atAsOf − atCompareTo) | ✅ |
| Ladder **Net accessible change** | `delta.net` | **Derived-from-historical** | ✅ |
| Ladder **Unused credit** | `atAsOf` metric `availableCredit` | **Historical** (as-of, excluded from liquidity) | ✅ |
| Trust chip / `TrustIndicator` | `resolvePerspectiveEnvelope(atAsOf)` | **Historical** (as-of completeness) | ✅ |
| **Accessible Cash** headline + stats | `renderAccessibleCash(accounts)` | **Current** (live `accounts`, ignores `asOf`) | ❌ **not labelled** |
| **Emergency Fund Readiness** | `renderEmergencyFundReadiness(accounts)` | **Current** | ❌ **not labelled** |
| **Reachability by Type** donut | `classifyAccounts(accounts)` | **Current** | ❌ **not labelled** |
| **Liquidity Concentration** bars | `renderLiquidityConcentration(accounts)` | **Current** | ❌ **not labelled** |
| **What Changed** rows | tx window relative to **today** | **Current** (by design — it is a live driver window) | ✅ (period-labelled) |
| Coverage **months** | *not shown today* — no expense baseline is threaded | **Unknown** unless the Space's `emergency_fund_progress.monthlyExpenses` config is set | (see §4) |

### 2.1 The single biggest temporal-honesty finding

**Four present-day surfaces (Accessible Cash, Emergency Fund Readiness, Reachability,
Concentration) render live figures inside a historical view with no honesty note.** In a
past `asOf`, the Ladder correctly reconstructs the past — but directly beside it, "Accessible
Cash $X reachable right now" shows *today's* cash. A user reading the screen at `asOf =
2025-03-01` sees a reconstructed March ladder next to a present-day cash headline, and
nothing tells them the two are on different dates. Debt hit the exact same wall (present-day
KPIs beside an as-of chart) and resolved it honestly: it **drops the hero delta when
historical** and prints "Balances are current — the trend and verdict below reflect {asOf}"
(`DebtHero.tsx:99-130`). **The redesign's first obligation is to make this asymmetry visible,
not prettier.** (Actually *closing* the gap — per-account as-of reconstruction — is doctrine
roadmap item P3, `WORKSPACE_CONTRACT_DOCTRINE.md:329`; it is **not** presentation-only and is
**out of scope** here.)

### 2.2 The Balance-History honesty question (answered)

Liquidity has **no history series today** — only two point-endpoints (`atAsOf`,
`atCompareTo`). The Ladder shows a per-tier *delta between two points*, not a curve.

**But a continuous series is honestly derivable with no new authority.** The `Snapshot` type
(`types/index.ts:82-101`) carries `totalCash` (checking), `totalSavings`, `totalInvestments`,
`totalCrypto`, `isEstimated`, and `fxMiss`. Therefore:

- **cashNow series** = `totalCash + totalSavings` — this is *exactly* the Ladder's "Available
  now" tier, and matches the Accessible-Cash headline basis.
- **marketable series** = `totalInvestments + totalCrypto` — the "Available in days" tier.

Debt already clips `totalDebt` from this same snapshot array with a pure window filter that
drops `fxMiss` points and carries `isEstimated` (`clipDebtHistory`,
`lib/debt-space-data.ts:92-108`). A Liquidity equivalent (`clipCashHistory`) is a mechanical
mirror. **Verdict: yes, Balance History can honestly exist**, plotting the `cashNow` series
(the hero figure), with the same observed/reconstructed line treatment `TrendChart` already
gives every workspace. Caveat to verify (§7): confirm the snapshot cash walk-back basis
matches `getAccountsAsOf`'s posted-basis walk-back (per the HIST cash posted-basis fix) so
the series and the Ladder endpoint agree.

---

## 3. Proposed editorial hierarchy

Mapping the established pattern (Hero → Historical view → Primary entities → Insights/risk →
Actions) onto Liquidity's **different financial truth** (access & readiness, not wealth or
performance). Liquidity keeps its own semantics — the ladder stays a ladder, credit stays
*out* of liquidity, no runway is faked.

| # | Surface | Content | Honesty gate |
| --- | --- | --- | --- |
| ① | **Accessible Cash** (Hero) | Present-day `cashNow` headline (figure of record from `accounts` via `classifyAccounts`), window delta from the cash series, optional **Coverage X months**, `TrustIndicator` | Headline **present-day**; delta **dropped when historical** (Debt rule); "balances are current — trend below reflects {asOf}" note when `asOf < today`. Coverage months **only when** `monthlyExpenses` config exists, else "Set a monthly expense target" (existing honest state, `liquidity-adapters.tsx:166`) |
| ② | **Balance History** | Shared `TrendChart` over the `cashNow` snapshot series (`totalCash + totalSavings`), window-clipped + per-date FX-converted | The one honestly-continuous historical surface; observed/reconstructed handled by `TrendChart`; empty state when < window points |
| ③ | **Sources** (Liquidity ladder) | The **centerpiece**. Three access horizons (Available now / in days / illiquid) as a grouped weight-bar ledger; top-N inline + "View all N sources →" **LeftPanel**; per-account **RightPanel** detail. Absorbs Reachability + Concentration | Present-day per-account (live); **historical view keeps the reconstructed as-of tier totals + delta chips** (tier-level, not per-account — say so). Account **detail** is present-day |
| ④ | **Resilience & Risk** | Emergency coverage (conditional), cash concentration signal ("most of your cash is in one account"), reachability mix (share reachable now vs in days) | Coverage **conditional** on config; concentration/mix from live `accounts` → **Current**, labelled; **no runway/burn fabricated** (no reliable monthly-burn authority — §7) |
| ⑤ | **What Changed / Actions** | Top cash-in/out drivers for the shell period + "View all activity in Cash Flow →" doorway | Unchanged — current-anchor by design; period-labelled |

### 3.1 Panel opportunities (Atlas `LeftPanel` / `RightPanel`)

The Sources ledger is the natural home for the Atlas panel system, mirroring
`LiabilitiesLedger` exactly (`LiabilitiesLedger.tsx:122-160`):

- **LeftPanel** ("what am I operating in") — the full grouped list of *all* liquidity sources
  (checking / savings / brokerage / crypto / other), opened by "View all N sources →".
- **RightPanel** ("tell me more about what I selected"), stacked above the LeftPanel via the
  shared `PanelStack` — per-account detail: balance, type, institution, access horizon, share
  of liquid assets. **Present-day only** (per-account history is not carried by the contract —
  say so plainly, exactly as `DebtAccountDetail.tsx:101-105` does for debt).

Use `WorkspaceLayout / LeftPanel / RightPanel / PanelHeader / PanelContent` from
`@/components/atlas/panels` verbatim. **Do not** create a domain panel primitive.

---

## 4. Components to reuse

| Component | Path | Role in redesign |
| --- | --- | --- |
| `TrendChart` | `components/space/widgets/charts/TrendChart.tsx` | Balance History (② ) — the ONE chart, observed/reconstructed honesty free |
| `TrustIndicator` | `components/space/trust/TrustIndicator.tsx` | Hero chip (`compact`) + lede caveat (`inline`) over the same envelope |
| `DeltaBadge` | `components/space/widgets/wealth/wealth-ui.tsx` | Hero window delta (imported by `DebtHero.tsx:31`) |
| `Surface` / `Block` / `Figure` | `components/atlas/Surface.tsx` | Editorial section frame (replaces the local `GlassPanel` `Panel` helper) |
| `WorkspaceLayout` / `LeftPanel` / `RightPanel` / `PanelHeader` / `PanelContent` / `PanelStack` | `components/atlas/panels/` | Sources ledger drill (③ ) |
| `BreakdownWidget` | `components/space/widgets/BreakdownWidget.tsx` | Optional Reachability donut / mix, if kept as a Resilience sub-card |
| `classifyAccounts` | `lib/account-classifier.ts` | Live per-account partition (unchanged) — grouped arrays `liquid` / `investments` / `digitalAssets` / `realAssets` + totals |
| `useLiquiditySpaceData` + `LiquiditySpaceData` | `components/.../useLiquiditySpaceData.ts`, `lib/liquidity/space-data*.ts` | Contract + hook **unchanged** |
| `convertLiquiditySpaceData` | `lib/liquidity/display-conversion.ts` | Historical endpoint display FX **unchanged** |
| `useSpaceSectionsPublisher` | `lib/space/space-chrome-context` | Section anchors in the rail (as `DebtWorkspace.tsx:157-161`) |

New pure helper (mirrors an existing one, introduces **no** authority): `clipCashHistory`
(clone of `clipDebtHistory`, `lib/debt-space-data.ts:92`) projecting `totalCash + totalSavings`
to `TrendPoint`. Plus a small `convertCashHistory` mirroring `convertDebtHistory` for per-date
FX, or reuse the display-conversion seam.

---

## 5. Components to retire / redesign

| Component | Path | Verdict | Rationale |
| --- | --- | --- | --- |
| Local `Panel` helper (GlassPanel wrapper) | `LiquidityWorkspace.tsx:83-92` | **Retire** | Replaced by editorial `Surface`/`Block` (the Debt/Investments idiom) |
| `LiquidityLadderTiers` | `components/space/widgets/liquidity/LiquidityLadderTiers.tsx` | **Redesign** | Becomes the Sources ledger (grouped weight bars + LeftPanel/RightPanel); its per-tier/per-account math is preserved |
| `renderAccessibleCash` | `liquidity-adapters.tsx:112` | **Redesign → Hero** | The headline + share-of-assets fold into the Hero (present-day figure of record) |
| `renderEmergencyFundReadiness` | `liquidity-adapters.tsx:147` | **Redesign → Resilience** | Coverage/buffer fold into ④; keep the honest "set a target" state |
| `renderLiquidityConcentration` | `liquidity-adapters.tsx:177` | **Retire (fold into Sources)** | The weight bar *is* the concentration view, folded into the ledger where it's relevant (exactly Debt's LiabilitiesLedger reasoning, `LiabilitiesLedger.tsx:5-18`) |
| `renderReachability` (donut) | `LiquidityWorkspace.tsx:229` | **Keep as secondary** (Resilience mix) or retire | Optional small allocation card in ④; not a top-level surface |
| `renderLiquidityLadder` (adapter, generic path) | `liquidity-adapters.tsx:84` | **Keep** | Still the SectionRegistry generic-path renderer; not a workspace surface — leave it |
| `LiquidityWhatChangedCard` | `components/.../LiquidityWhatChangedCard.tsx` | **Keep** | ⑤ unchanged (current-anchor doorway to Cash Flow) |

---

## 6. Implementation slices (ordered, presentation-only, independently shippable)

Each slice is presentation-only in the Debt-redesign sense: it re-composes existing figures
and reuses already-loaded data; it changes **no** authority, contract, engine, or calculation.
Slices land behind the existing workspace and keep present-day byte-compatible where noted.

- **L0 — Wire the snapshot series (enabler).** In `workspaceRenderers.tsx:120`, thread the
  already-present `ctx.snapshots` + `ctx.snapshotCurrency` (Debt already consumes them,
  `:158-159`) into `LiquidityWorkspace`. Optionally thread the Space's `emergency_fund_progress.monthlyExpenses`
  config for Hero coverage. *This is a prop-wiring change, not new data* — flagged in §7 as
  the one line that is "more than pure presentation." Independently shippable (unused until L1/L2).

- **L1 — `LiquidityHero`.** New editorial lede (mirror `DebtHero.tsx`): present-day `cashNow`
  headline (figure of record from `accounts`), window delta from the cash series (dropped when
  historical), `TrustIndicator` chip, verdict sentence, and the load-bearing "balances are
  current — trend below reflects {asOf}" note. Optional Coverage-months stat (conditional).
  Independently shippable (delta/coverage degrade honestly without L0/L2).

- **L2 — `LiquidityBalanceHistory`.** New component (mirror `DebtBalanceHistory.tsx`): shared
  `TrendChart` over the `cashNow` snapshot series via a pure `clipCashHistory` +
  per-date FX. Depends on L0. Independently shippable.

- **L3 — Sources ledger.** Redesign `LiquidityLadderTiers` into the `LiabilitiesLedger` idiom:
  grouped weight-bar rows (share of liquid assets), top-N inline + "View all N sources →"
  LeftPanel + per-account RightPanel detail (`LiquidityAccountDetail`, mirror
  `DebtAccountDetail`). Historical branch keeps the reconstructed as-of tier totals + delta
  chips (tier-level) with an honest "reconstructed as of {date}" note (already present,
  `LiquidityWorkspace.tsx:279`). Absorbs Concentration. Independently shippable.

- **L4 — Resilience & Risk.** Fold Emergency Fund Readiness (conditional coverage), cash
  concentration signal, and reachability mix into one `Block`. Retire the standalone
  Concentration surface. Independently shippable.

- **L5 — Compose the workspace.** Re-shell `LiquidityWorkspace` into the stacked
  `Surface`/`Block` editorial layout with section anchors (`useSpaceSectionsPublisher`),
  ordering ①→⑤, retaining What Changed. Retire the local `Panel` helper. Ships last.

**Ordering rationale:** L0 unblocks L2; L1 is the highest-visibility honesty fix and can land
first behind the old grid; L3 is the biggest surface and the panel work; L5 is the final
composition. L1, L3, L4 each ship independently against the current grid.

---

## 7. Risks / unknowns

1. **Snapshot cash basis vs Ladder basis (verify before L2).** The Balance-History series uses
   `Snapshot.totalCash + totalSavings`; the Ladder's `atAsOf.cashNow` uses `getAccountsAsOf`'s
   walked-back balances. These must be the **same posted-basis** walk-back for the curve and
   the as-of endpoint to agree (MEMORY notes a HIST cash posted-basis fix — confirm the
   snapshot regeneration and `getAccountsAsOf` share it). If they diverge, plot the series but
   disclose it, or drop the last-point coincidence claim. **Do not assume — verify.**

2. **L0 is a wiring change, not pure presentation.** Threading `snapshots`/`snapshotCurrency`
   (and optional `monthlyExpenses`) is more than re-composing existing props inside the
   component — it passes an already-loaded authority *into* the component. It introduces **no
   new fetch, loader, or calculation** (Debt consumes the identical props), so it is low-risk
   and matches the Debt precedent, but it should be called out as such, not smuggled in as
   "presentation."

3. **Coverage months is conditional.** A "Coverage X months" hero stat is honest **only** when
   the Space's `emergency_fund_progress.monthlyExpenses` config is set (the same source
   SpaceDashboard uses for the EF hero, `SpaceDashboard.tsx:580-588`). Without it, the Hero
   must show the existing honest "Set a monthly expense target" state — **never** a fabricated
   number. There is no other reliable monthly-burn authority in the codebase (What Changed is a
   period *driver* window, not a smoothed burn), so **runway must not be invented** — the
   adapters already refuse to (`liquidity-adapters.tsx:110-111, 165-166`); keep that refusal.

4. **The four present-day panels stay present-day.** This redesign makes the mixed authority
   *visible* (labels + the "balances are current" note); it does **not** reconstruct Accessible
   Cash / Reachability / Concentration per-account for `asOf`. That is doctrine P3
   (`WORKSPACE_CONTRACT_DOCTRINE.md:329`), which extends the historical splice to per-account
   panels — **out of scope** (not presentation-only). Be explicit in the UI that account-level
   detail is present-day.

5. **Historical Sources granularity mismatch.** The present-day Sources ledger is per-account
   (LeftPanel/RightPanel work); the historical branch only has **tier-level** totals from
   `atAsOf` (the engine reconstructs tiers, not per-account rows). So the LeftPanel/RightPanel
   drill is a **present-day** affordance; in a historical view the ledger degrades to the
   reconstructed tier tiles + delta chips (as it does today). Surface this honestly rather than
   faking per-account historical rows.

6. **FX deferral (unchanged).** Historical foreign-currency cash is valued at *today's* rate in
   the engine (documented deferral, `lib/liquidity/space-data.ts:26-33`), surfaced as an honest
   `estimated` (≈) flag and a "shown in {target}" note (`LiquidityWorkspace.tsx:286-288`). The
   redesign inherits this; do not silently drop the caveat. (Doctrine §4.5 flags the one
   residual hand-authored FX string — routing it through `warnings[]` is a separate cleanup, not
   this redesign.)

7. **Verdict prose stays engine-owned.** The lede sentence is `computeLiquidity`'s deterministic
   template (`liquidity.core.ts:264-279`). The Hero reuses it verbatim as prose (never a figure
   of record); regenerating template prose is out of scope, exactly as Debt kept it.
