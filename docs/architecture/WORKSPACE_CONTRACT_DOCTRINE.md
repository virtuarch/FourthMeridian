# Workspace Contract Doctrine

**Status:** Doctrine (investigation-backed, 2026-07-18)
**Scope:** Every Space Workspace / Perspective surface
**Predecessors:** `PHASE_2_DOCTRINE.md`, `PHASE_2_ARCHITECTURE_FREEZE.md`, the SD-0…SD-8 SpaceDashboard decomposition, and the Trust Surface Convergence slice (752e366).

> This document is the outcome of a **read-only audit** across four contract dimensions
> (identity/renderer, data authority, temporal, trust). It does not introduce new
> architecture. Its purpose is to name the contract every Workspace already (mostly)
> satisfies, record where the guarantee is not yet met, and order the remaining
> convergence work. **No new providers, registries, context layers, or generic
> WorkspaceManager/Resolver/Factory are proposed.** The architecture is complete; the
> work is convergence onto it.

---

## 0. The one-sentence contract

> A Workspace is a **registry-identified**, **renderer-dispatched** view over a
> **single data authority**, that **consumes canonical Space time** and **emits one
> trust envelope**.

Everything below is the elaboration and the enforcement of that sentence.

---

## 1. The Workspace Contract Definition

Every Workspace answers six questions, each with exactly **one** owner:

```
                        WorkspaceDefinition
                   (lib/perspectives.ts — WORKSPACE_REGISTRY)
                                 |
        ┌───────────────┬────────┴────────┬───────────────┐
        │               │                 │               │
      Data            Time              Trust          Capability
        │               │                 │               │
  one authority   TemporalCapability  PerspectiveEnvelope   dataNeeds
   (*SpaceData /   {asOf,compareTo,  →resolvePerspective-   routing
    *Result)        period}            Envelope→             widgets[]
        │               │            TrustIndicator          │
        └───────────────┴────────┬────────┴───────────────┘
                                 │
                        WORKSPACE_RENDERERS
                 (components/space/workspaces/workspaceRenderers.tsx)
                                 │
                            Workspace UI
```

| # | Question | Contract owner | Authority |
|---|----------|----------------|-----------|
| 1 | **What am I?** (identity, routing, kind) | `WorkspaceDefinition` in `WORKSPACE_REGISTRY` | `lib/perspectives.ts:151-190, 529-533` |
| 2 | **What data powers me?** | Exactly one `*SpaceData` / `*Result` authority | per-workspace lib (see §2) |
| 3 | **How do I consume time?** | `temporalCapability: {asOf, compareTo, period}` | `lib/perspectives.ts:117-121` |
| 4 | **How do I communicate trust?** | `PerspectiveEnvelope` via `resolvePerspectiveEnvelope` → `TrustIndicator` | `lib/perspectives/envelope.ts:266` |
| 5 | **How am I rendered?** | `WORKSPACE_RENDERERS[id]` (perspectives) or shell-slot inline (standard) | `components/space/workspaces/workspaceRenderers.tsx:92` |
| 6 | **What do I need / expose?** | `dataNeeds[]`, `routing`, `widgets[]`, `envelope` source | `WorkspaceDefinition` fields |

### 1.1 The guarantees (what "contract-complete" means)

A Workspace is **contract-complete** when all of the following hold:

1. **Single identity.** It has exactly one entry in `WORKSPACE_REGISTRY`; no parallel
   host-side identity map. *(Enforced: the SD-2 registry replaced the former
   `PERSPECTIVE_TARGET_TAB` / `PERSPECTIVE_ROUTED_TABS` / `PERSPECTIVE_MODAL_META` host maps.)*
2. **Single data authority.** Every figure the UI shows is read from **one** authority
   result; widgets read *derived* fields and never recompute, re-sum, or re-value.
3. **Single time authority.** It owns no local period/`now` state; every window is
   derived from the shell's resolved `{asOf, compareTo}` fanned in through the one
   `WorkspaceRenderCtx`. Its `temporalCapability` truthfully declares which axes it honors.
4. **Single trust authority.** It emits one `PerspectiveEnvelope` (via its data
   authority) using the canonical `CompletenessTier` vocabulary, and renders trust only
   through the shared `TrustIndicator` / `ShellContextRow`. No hand-authored confidence strings.
5. **Single renderer.** A financial Perspective is dispatched through
   `WORKSPACE_RENDERERS[id]`; a standard destination renders in the SpaceShell workspace slot.
6. **No bypass.** No workspace component or hook reads Prisma/`db` directly; every
   server read is routed through the authority's endpoint. *(Verified clean across all
   workspaces — grep for `prisma.`/`@/lib/db` in `components/space/widgets` + hooks returns nothing.)*

### 1.2 Kinds

`WorkspaceKind` (`lib/perspectives.ts:143`) partitions all Workspaces:

- **`perspective`** — a financial *lens* over the canonical financial knowledge that
  participates in canonical time (Wealth, Cash Flow, Investments, Debt, Liquidity). Renderer-dispatched.
- **`standard`** — a structural primary destination (Overview, Transactions, Accounts,
  Activity, Members; and — by doctrine — Goals). Renders in the shell slot, consumes shared data.

> Every Perspective is a Workspace; not every Workspace is a Perspective. `PerspectiveDef`
> **extends** `WorkspaceDefinition` (`lib/perspectives.ts:226`). There is one registry over both.

### 1.3 The temporal-capability vocabulary

`temporalCapability` (`lib/perspectives.ts:117-121`) is the single source of truth for
temporal participation — it replaced the coarse `consumesShellTime` boolean, which is now
*derived* (`workspaceConsumesShellTime`, `:197`). Per axis:

- **`full`** — the whole workspace reflects this axis.
- **`partial`** — the workspace *participates* but only part of the current
  implementation reflects it. **This is a capability GAP to close, not permanent
  non-participation.** (Debt's lede/chart are temporal while its KPIs are not; Liquidity's
  Ladder is temporal while its per-account panels are not.)
- **`none`** — the axis is not part of this workspace's temporal model.

This distinction is the doctrine's honest-debt mechanism: the registry itself already
records where the contract is incomplete.

---

## 2. The Authority Map (where truth comes from)

Each Workspace has exactly one data authority — a pure function or loader producing one
result type that every widget in that Workspace reads. FX is applied **once**, at the
workspace boundary, never inside a widget.

| Workspace | Data authority (symbol) | File | Result type | Convergence |
|-----------|------------------------|------|-------------|-------------|
| **Wealth** | `computeWealthTimeMachine` | `lib/wealth/wealth-time-machine.ts:235` | `WealthResult` | **Fully converged** — `WealthResult` *is* the durable boundary (no wrapper by design). FX once upstream (`WealthWorkspace.tsx:108`). |
| **Investments** | `loadInvestmentsSpaceData` | `lib/investments/space-data.ts:175` | `InvestmentsSpaceData` | **Fully converged** — one orchestrator; `current`=`getCurrentPositions`, `historical`=A10 verbatim, never cross-derived. FX once (`InvestmentsWorkspace.tsx:71`). |
| **Cash Flow** | `buildCashFlowSpaceData` | `lib/transactions/cash-flow-space-data.ts:132` | `CashFlowSpaceData` | **One fold, wiring incomplete** — child widgets still accept raw `transactions` alongside the contract slices; stamp computed twice (see §4). |
| **Debt** | `assembleDebtSpaceData` | `lib/debt-space-data.ts:116` | `DebtSpaceData` (narrow: lens+history+fico) | **Dual authority by design** — the SpaceData contract is a *time-composition + prose* boundary; every KPI figure is recomputed from the live `accounts` array via `computeDebtKpis`/`computePayoffAggregate`. |
| **Liquidity** | `loadLiquiditySpaceData` | `lib/liquidity/space-data.ts:167` | `LiquiditySpaceData` | **Converged for the temporal layer; parallel for account panels** — Ladder/lede read the lens; the four per-account tiles recompute from `accounts`. |
| Connections | `loadConnectionsSpaceData` | `lib/connections/space-data.ts:186` | `ConnectionsSpaceData` | Converged (deliberately not a money view). |
| Accounts (detail) | `/accounts/detail` route → `AccountDetailRow` | `app/.../accounts/detail/route.ts` | `AccountDetailRow[]` | Converged (separate bounded context; route-level `db` reads are correct). |
| Overview / Transactions / Accounts / Activity / Members | *none* — shared `useSpaceData` | `lib/space/use-space-data.ts:68` | props (`accounts`, `snapshots`, `transactions`) | Composition only — one host fetch lifecycle, no parallel authority. |

**The Debt/Liquidity asymmetry is real and documented.** Both carry a first-class SpaceData
authority, but that authority deliberately owns only the *reconstructable* temporal surface
(lens verdict, historical chart/ladder, trust). Per-account figures that "cannot be
reconstructed per-account historically" (`LiquidityWorkspace.tsx:18-42`, `lib/debt-space-data.ts:22-29`)
are computed live from the `accounts` array. This is a load-bearing doctrine choice, not an
accident — but it is also the source of the temporal gap in §4.

---

## 3. The Capability Matrix (workspace completeness)

Consolidated from all four audits. `Full` / `Partial` / `—` describe *the current
implementation against the contract*, not the intended end-state (the intended end-state is
`Full` everywhere the axis is not structurally `none`).

| Workspace | Data | Time | Trust | Renderer | Overall |
|-----------|------|------|-------|----------|---------|
| **Wealth** | ✅ `WealthResult` (single) | ✅ Full (asOf + raw compareTo) | ✅ Envelope + Evidence rows | ✅ `WORKSPACE_RENDERERS.wealth` | **Complete** |
| **Investments** | ✅ `InvestmentsSpaceData` (single) | ✅ Full (asOf + historicalCompareTo) | ✅ Envelope (label-only evidence) | ✅ `.investments` | **Complete** |
| **Cash Flow** | ⚠️ one fold, dual-path widgets | ✅ Full (asOf anchor, compareTo, period) | ✅ Envelope (no evidence — by nature) | ✅ `.cashFlow` | **Complete¹** |
| **Debt** | ⚠️ dual authority (design) | ⚠️ **Partial** — lede+chart+trust only | ✅ Envelope + `TrustIndicator` | ✅ `.debt` | **Temporal gap** |
| **Liquidity** | ⚠️ parallel account panels (design) | ⚠️ **Partial** — Ladder+lede+trust only | ✅ Envelope + `TrustIndicator` (¹ FX string) | ✅ `.liquidity` | **Temporal gap** |
| Overview | ✅ shared data | n/a (current-state; default lens = Wealth) | — (inert `—`) | shell-slot inline | Complete (standard) |
| Transactions | ✅ shared data | n/a | — | shell-slot inline | Complete (standard) |
| Accounts | ✅ shared / detail route | n/a | — | shell-slot inline | Complete (standard) |
| Activity | ✅ self-fetch (Timeline) | n/a | — | shell-slot inline | Complete (standard) |
| Members | ✅ self-fetch | n/a | — | shell-slot inline | Complete (standard) |
| Goals | ✅ shared | none (`kind: standard`) | — | **routed modal** (inert `widgets[]`) | Mis-shelved (§4) |
| Retirement | — (not implemented) | — | — | **routed modal** (legacy tab) | Placeholder |
| Tax / Property / Business Health | — | — | — | comingSoon | Placeholder |
| Platform (×9) | self-fetch | domain-specific | — (no finance envelope) | `PlatformSpaceDashboard` | Separate domain |

¹ *Cash Flow* is temporally and trust-complete; its only debt is data-wiring convergence
(§4.3). *Liquidity* trust has one residual hand-authored FX string (§4.5).

### 3.1 Renderer contract — enforced

The registry↔renderer parity is a **hard guard**, not a convention.
`lib/perspectives/virtual-sections.test.ts:77-88` computes
`registryRenderIds = PERSPECTIVE_LIBRARY where kind==="perspective" && status==="available" && !routing?.targetTab`
→ exactly `{wealth, cashFlow, investments, debt, liquidity}`, source-parses the top-level keys
of `WORKSPACE_RENDERERS`, and asserts **set equality**: no available Perspective without a
renderer, no orphan renderer. Retirement is correctly excluded (it has `routing.targetTab`).

The financial-perspective slot is fully registry-driven
(`SpaceDashboard.tsx:871-905`: `WORKSPACE_RENDERERS[activePerspectiveId](renderCtx)`). Standard
destinations are **not** — they render via hand-written `activeTab === "…"` branches in the host
(`SpaceDashboard.tsx:926, 939, 989, 1014, 1025`). This asymmetry is deliberate (SD-7) but is
itself a contract gap (§4.1).

---

## 4. Known Gaps

Ordered by severity. Each is a *convergence* task onto the existing architecture — none
requires new abstractions.

### 4.1 Debt temporal incompleteness `[Partial → Full]`
At a past `asOf`, Debt's lede verdict, Balance-Over-Time chart, and trust chip reflect the
historical date, **but the entire KPI grid still shows today's balances** — Total Debt, Est.
Interest, Utilization, Min. Payments, Payoff, and Credit Utilization are all sourced from the
live `accounts` array via `computeDebtKpis` (`lib/debt-kpis.ts:65`, which states "No
historical/as-of read of any kind", `:13`) and `computePayoffAggregate` (`:159`). Result:
a visible internal inconsistency at past dates.
- **Root cause:** `DebtSpaceData` is a narrow prose/time contract; the figure authority is a
  parallel client path over `accounts`.
- **Doctrine tension:** §1.4/§3.5 hold that the lens is never the numeric authority — legitimate,
  because the lens may see `DebtProfile` terms the client array lacks. The fix is **not** to make
  the lens the numeric authority, but to give Debt an as-of *figure* source (historical
  account balances at `asOf`) that the KPI grid reads instead of live `accounts`.

### 4.2 Liquidity current-anchor account panels `[Partial → Full]`
Accessible Cash, Emergency Fund Readiness, Reachability, and Liquidity Concentration recompute
from the live `accounts` array (`LiquidityWorkspace.tsx:230, 351, 354, 379`), bypassing both
the lens and `LiquiditySpaceData`; only the Ladder + lede + delta are as-of aware. Explicitly
documented as the intended "LIVE CURRENT ANCHOR" (`:18-42`) because per-account historical
reconstruction is currently refused. Closing this requires the same as-of per-account basis
the Debt fix needs.

### 4.3 Cash Flow data-wiring convergence `[one fold, not yet sole source]`
The fold authority (`buildCashFlowSpaceData`) is correct and temporally sound, but:
- **Stamp double-computed** — `buildCashFlowSpaceData` already returns `data.stamp`
  (`cash-flow-space-data.ts:172`), yet `CashFlowWorkspace.tsx:138` calls `cashFlowStamp(...)` a
  second time and ignores `data.stamp`.
- **Dual-path child widgets** — `CashFlowSummaryWidget` / `CashFlowHistoryWidget` /
  `DebtPaymentsWidget` receive **both** raw `transactions`+`period` **and** the contract slices
  (`CashFlowWorkspace.tsx:218-267`), retaining a self-fold fallback. The contract is not yet the
  *sole* source.
- **Separate comparison window** — `CashFlowInsightsCard` runs its own `compareCashFlow` over raw
  transactions (`:283-292`).

These are latent-dead in practice (the slices are always supplied), so it is low-risk
tidy-up, not a correctness bug.

### 4.4 Wealth basis disclosure — orphaned evidence `[emitted, never rendered]`
`WealthResult.basis` (the HIST-2E `WealthBasisDisclosure`, `lib/wealth/basis-disclosure.ts`,
computed `wealth-time-machine.ts:324-336`) is fully computed but **rendered nowhere** — no
consumer reads `result.basis` (`WealthWorkspace.tsx:184` intentionally leaves the slot empty).
Either wire it into the Evidence/inline trust path or drop it. Currently emitted-but-invisible.

### 4.5 Liquidity hand-authored FX string `[one residual local trust string]`
`LiquidityWorkspace.tsx:286-287` hand-derives `atAsOf?.estimated ? " (some rates estimated)" : ""`
— a local FX caveat reading `lens.estimated` directly, parallel to the canonical FX `warnings[]`
the same signal already produces via `fxWarnings` (`lib/perspectives/envelope.ts:104-115`). The
single surviving workspace-authored FX trust text after the 752e366 convergence.

### 4.6 Investments trust-label fallback `[duplicated constant]`
`InvestmentsWorkspace.tsx:93` re-derives the trust figure label via an inline ternary that
duplicates the canonical `FIGURE_LABEL_*` constants (`lib/investments/investments-trust.ts:61-62`) —
a second copy that can drift. Use `data.trust.figureLabel` unconditionally.

### 4.7 Evidence-drawer contract exercised only by Wealth `[uneven, not broken]`
Only Wealth exposes clickable Evidence **rows**; Investments/Debt/Liquidity provide label-only
evidence (no drawer) and Cash Flow provides none. Consistent with the "no fabricated rows"
rule, but the Evidence half of the trust contract is only fully exercised in one place.

### 4.8 No renderer map for standard workspaces `[asymmetry]`
Overview/Transactions/Accounts/Activity/Members are wired by five hand-written `activeTab ===`
branches with **no** parity test binding them to `STANDARD_WORKSPACES`. Adding a standard
workspace requires editing the host — unlike perspectives, which are guarded. Whether standard
tabs *should* migrate to a `STANDARD_RENDERERS` map is an open doctrine question (§5, Phase 5);
they are structurally different (they render in the shell slot, consume shared data), so this is
not obviously worth the indirection.

### 4.9 Goals mis-shelved `[identity hygiene]`
Goals is `kind: "standard"` (`lib/perspectives.ts:398`, correctly) yet physically lives in
`PERSPECTIVE_LIBRARY`, so it surfaces on the Perspectives sub-nav while actually routing to a
GlassModal, and carries an inert `widgets[]` that never renders (the renderer/routing wins).
Relocation to `STANDARD_WORKSPACES` is a functionality-affecting move, explicitly deferred.

### 4.10 Retirement is a registry placeholder `[not implemented]`
Registry entry only; no `RetirementWorkspace` component. Routes to the legacy `RETIREMENT`
GlassModal. Not a gap in the contract — a not-yet-built Workspace.

### 4.11 Inert `widgets[]` on renderer-backed perspectives `[latent drift]`
Wealth/Cash Flow/Debt/Liquidity carry both a `widgets[]` array and a renderer; the renderer
always wins, so the arrays are never rendered — they survive only to feed the
`isWorkspaceBacked` proxy and the parity tests. They *look* authoritative but are inert at
render time (the `toVirtualSections` branch, `SpaceDashboard.tsx:877`, is dead in normal
navigation). Low-risk, but worth a comment or consolidation so the arrays don't read as live.

---

## 5. Future Roadmap (ordered by leverage)

Each phase is a bounded implementation slice derived from a gap above. Phases 2–3 are the only
ones that change user-visible numbers; the rest are hygiene.

| Phase | Slice | Closes | Leverage | Risk |
|-------|-------|--------|----------|------|
| **1** | **Contract freeze** — adopt this doctrine; add a lightweight test asserting every `kind:"perspective"` `status:"available"` workspace has a `temporalCapability` and an `envelope` source. Codifies the contract so future workspaces inherit the guarantees. | — | High (prevents regressions) | None (test-only) |
| **2** | **Debt temporal completion** — introduce an as-of Debt *figure* basis (historical account balances at `asOf`) that the KPI grid reads instead of live `accounts`; flip `temporalCapability.asOf` `partial → full`. | §4.1 | Highest (removes a visible past-date inconsistency) | Medium (new historical read path) |
| **3** | **Liquidity temporal completion** — extend the historical splice to per-account panels (Accessible Cash / Emergency Fund / Reachability / Concentration); flip `partial → full`. Shares the §4.1 as-of per-account basis. | §4.2 | High | Medium |
| **4** | **Cash Flow wiring convergence** — consume `data.stamp`; make the contract slices the sole widget source; fold the comparison window into the authority. Pure tidy-up. | §4.3 | Medium (removes dual-path drift risk) | Low |
| **5** | **Trust residue cleanup** — render or retire `WealthResult.basis`; route the Liquidity FX caveat through `warnings[]`; drop the Investments label fallback. | §4.4–4.6 | Medium | Low |
| **6** | **Identity hygiene** — relocate Goals to `STANDARD_WORKSPACES`; comment/consolidate the inert `widgets[]`; decide whether standard tabs migrate to a guarded `STANDARD_RENDERERS` map. | §4.8–4.11 | Low | Low |
| **7** | **Ambient Intelligence consumers** — once every Perspective is a frozen primitive with one data authority + one temporal capability + one envelope, AI/insight surfaces can read the *same* authorities (fact→interpretation→action→drill) without a parallel data path. | (enabled by 1–6) | Strategic | — |

**Ordering rationale:** freeze first (Phase 1) so nothing regresses while the gaps close;
then the two user-visible temporal gaps (2, 3) which share a common as-of per-account basis;
then the low-risk hygiene (4–6); then the strategic payoff (7), which depends on every
workspace being a uniform primitive.

---

## 6. The Workspace Runtime Contract (SD-9 — landed)

The six-question contract (§1) describes what a Workspace *is*. SD-9 completes the
*runtime* around it: `SpaceDashboard` is now a **composition root**, not an application
controller. The full contract, stated as a sum:

> **A Workspace is:**
> **Registry identity** (`WorkspaceDefinition`) **+ Renderer binding** (`WORKSPACE_RENDERERS`)
> **+ Data authority** (one `*SpaceData` / `*Result`) **+ Canonical temporal capability**
> (`{asOf, compareTo, period}`) **+ Trust envelope publication** (`PerspectiveEnvelope` via
> `resolvePerspectiveEnvelope` → `TrustIndicator`) **+ Shell chrome contract**
> (registry-owned workspace identity; host-owned Space identity).

### 6.1 The host is a composition root

`SpaceDashboard` reads as `resolve navigation → resolve time → mount runtime → render shell`.
It no longer *knows* how lenses load, how trust is created, or how the trust source is
selected — each is a hook it mounts, the same shape as `useSpaceData` / `useSpaceNavigation`:

| Runtime concern | Owner (SD-9) | File |
|-----------------|--------------|------|
| Perspective-engine lens loading (fetch, `?target=` currency, `SPACE_CURRENCY_CHANGED` refresh) | `useSpaceLensResults` | `lib/space/use-space-lens-results.ts` |
| Trust **publication** (active-envelope state + workspace-backed-vs-lens-only selection) | `useActiveEnvelope` | `lib/space/use-active-envelope.ts` |
| Trust **authority** (unchanged — the hook consumes it, never duplicates it) | `resolvePerspectiveEnvelope` / `CompletenessTier` / `TrustIndicator` | `lib/perspectives/envelope.ts` |
| Space chrome (subtitle derived **once**, shared by desktop nav + mobile relocation) | host (`chromeSubtitle`/`chromeUpdated`) | `components/dashboard/SpaceDashboard.tsx` |

**Enforced:** `lib/space/space-runtime-ownership.test.ts` asserts the host neither fetches
perspectives, owns lens state, subscribes to the lens refresh signal, calculates envelopes,
nor contains trust-selection logic — and that each seam owns exactly what left the host.

### 6.2 Deliberate boundary — tab identity ≠ workspace identity

SD-9C converged the *duplicate Space subtitle*, but did **not** move the rail-tab labels onto
the registry. That is not a leak: `SPACE_TAB_LABELS` (`lib/space-nav.ts`) owns **tab-rail
ORDER + COPY** for `SpaceTabId`, which `lib/perspectives.ts:127` deliberately keeps **separate**
from workspace id ("a Space TAB may host one or more workspaces"). The two identity spaces even
disagree by design (registry `overview.label = "Atlas"` vs rail copy "Overview"). Workspace
identity that the registry *should* own — the lens-selector labels and the active-workspace
title — already reads from `WorkspaceDefinition.label`; only the structural tab rail stays on
`SPACE_TAB_LABELS`, correctly.

---

## 7. Non-goals (the anti-framework clause)

This doctrine explicitly **does not** call for, and future slices should **not** introduce:

- a generic `WorkspaceManager`, `WorkspaceResolver`, or `DataProviderFactory`
- a new provider, registry, or context layer
- a base/PersonalFinance type split of `WorkspaceDefinition` (SD-3 forbids it: `dataNeeds`
  is universal orchestration metadata by design)
- a `WorkspaceData` supertype forcing Wealth's `WealthResult` and the others into one shape

The architecture already has its authorities: **one registry** (`WORKSPACE_REGISTRY`), **one
renderer map** (`WORKSPACE_RENDERERS`), **one time authority** (shell `{asOf, compareTo}` via
`WorkspaceRenderCtx`), **one trust resolver** (`resolvePerspectiveEnvelope`), and **per-workspace
data authorities**. The goal is to finish converging every Workspace onto them — not to build a
seventh authority to manage the six.

---

## Appendix — Contract reference (file:symbol)

| Concern | Symbol | Location |
|---------|--------|----------|
| Universal identity type | `WorkspaceDefinition` / `PerspectiveDef` | `lib/perspectives.ts:151, 226` |
| The one registry | `WORKSPACE_REGISTRY` | `lib/perspectives.ts:529` |
| Standard destinations | `STANDARD_WORKSPACES` | `lib/perspectives.ts:498` |
| Perspective library | `PERSPECTIVE_LIBRARY` | `lib/perspectives.ts:253` |
| Temporal capability | `TemporalCapability` + `workspaceConsumesShellTime` / `temporalControlVisibility` | `lib/perspectives.ts:117, 197, 212` |
| Data-needs orchestration | `workspaceDataNeeds` / `openPerspectiveDataNeeds` | `lib/space/workspace-resources.ts:41, 72` |
| Renderer map + ctx | `WORKSPACE_RENDERERS` / `WorkspaceRenderCtx` | `components/space/workspaces/workspaceRenderers.tsx:92, 41` |
| Registry↔renderer guard | parity test | `lib/perspectives/virtual-sections.test.ts:77-88` |
| Canonical time model | `resolveTimeRange` / shell state | `lib/perspectives/time-range.ts`, `components/space/shell/usePerspectiveShellState.ts` |
| Trust envelope + resolver | `PerspectiveEnvelope` / `resolvePerspectiveEnvelope` | `lib/perspectives/envelope.ts:78, 266` |
| Trust vocabulary | `CompletenessTier` / `COMPLETENESS_PRESENTATION` | `lib/perspective-engine/types.ts:86`, `lib/perspectives/envelope.ts:91` |
| Trust primitive + shell row | `TrustIndicator` / `ShellContextRow` | `components/space/trust/TrustIndicator.tsx`, `components/space/shell/ShellContextRow.tsx` |
| Shared data lifecycle | `useSpaceData` | `lib/space/use-space-data.ts:68` |
