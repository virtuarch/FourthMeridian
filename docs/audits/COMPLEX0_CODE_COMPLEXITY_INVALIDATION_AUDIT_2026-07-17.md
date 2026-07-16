# COMPLEX-0 — Code Complexity Invalidation Audit

**Date:** 2026-07-17 · **HEAD:** `032dc1432ab776906407312c43dfdedb2779d509` · **Branch:** `feature/v2.5-spaces-completion`
**Type:** Repository-wide, **read-only** complexity audit. No code modified, no refactor, no commit, no push.

**Question asked.** Not *"is this code dead?"* (answered by CLEAN-0) but *"is this code unnecessarily difficult to understand, change, test, or extend?"* — find complexity **before** it becomes the next monolith.

**Method.** Direct census of all 1,077 non-test `.ts`/`.tsx` files (138,188 LOC), plus six parallel source investigations (frontend components, AI subsystem, backend/provider/historical, registries, abstraction/semantics/data-flow, API routes/change-amplification). Every claim is cited `file:line`. INVEST-1 (historical mechanisms) and TEST-0 (test architecture) were **consumed**, not re-derived. Where a finding drives a destructive recommendation it was spot-verified against source (see §4/§15 notes on the "dead adapter" nuance).

**Framing verdict up front.** This codebase is **not** structurally over-complex. It shows the signature of a system that has been *actively decomposed* (SpaceDashboard host −60%, Platform Ops → 221-LOC dashboard, six `*SpaceData` contracts, clean job/alert/notification registries). The residual complexity is **concentrated, not pervasive**, and falls into four named clusters. The most dangerous items are *not* the biggest files.

---

## 1. Repository complexity census

**Totals.** 138,188 LOC across 1,077 source files. **39 files exceed 500 LOC.** Largest `lib` subtree is `lib/ai/` (~12,081 LOC). Largest `components` subtree is `components/space/` (14,630) then `components/dashboard/` (13,536).

### 1a. Top candidates — measured metrics

| File | LOC | imp | exp | useState | useEffect | switch | fetch/DB | 200-commit churn |
|---|---|---|---|---|---|---|---|---|
| `app/api/ai/chat/route.ts` | 2199 | 30 | 4 | — | — | 2 | 3 DB / 1 LLM | — |
| `lib/ai/intelligence/annotations.ts` | 2184 | 3 | **47** | — | — | 1 | 0 | — |
| `components/dashboard/ManageSpaceModal.tsx` | 1742 | 12 | 5 | **58** | 9 | 1 | **22** | — |
| `components/space/sections/SpaceSections.tsx` | 1584 | 35 | 5 | 14 | 4 | 3 | 6 | — |
| `components/dashboard/SpaceDashboard.tsx` | 1481 | 46 | 1 | 31 | **18** | 4 | 14 | **35 (highest)** |
| `lib/ai/assemblers/transactions.ts` | 1434 | 16 | 10 | — | — | 0 | 3 DB | — |
| `components/dashboard/SpacesClient.tsx` | 1293 | 13 | 2 | 12 | 4 | 12 | 5 | — |
| `components/dashboard/DebtClient.tsx` | 1240 | 16 | 1 | 29 | 0 | 1 | 7 | — |
| `lib/widget-registry.ts` | 1107 | 1 | 8 | — | — | 1 | 0 | 3 |
| `lib/ai/types.ts` | 1019 | 1 | 30 | — | — | 0 | 0 | — |
| `lib/notifications/registry.ts` | 697 | 1 | 8 | — | — | 1 | 0 | — |
| `lib/plaid/refresh.ts` | 738 | 18 | 4 | — | — | 2 | 16 DB / 4 Plaid | — |
| `lib/plaid/exchangeToken.ts` | 645 | 17 | — | — | — | — | 19 DB / 6 Plaid | — |
| `lib/crypto/btc-sync.ts` | 656 | 8 | 6 | — | — | 0 | 12 DB / 19 API | — |
| `lib/snapshots/regenerate-history.ts` | 558 | 11 | 7 | — | — | 4 | 9 DB | 7 |
| `lib/investments/valuation.ts` | 520 | 14 | 10 | — | — | 0 | 6 DB (read) | 5 |

**Do not rank by LOC alone.** The two largest files (`chat/route.ts`, `annotations.ts`) are genuine monoliths, but the third-largest by *risk* is `ManageSpaceModal.tsx` (**58 useState**), and the single most-changed file in the repo is `SpaceDashboard.tsx` (**35 commits / last 200**) despite already being decomposed. Churn is the strongest "not-finished-decomposing" signal.

---

## 2. Monolith detection

Classification: **A** — architectural monolith · **B** — emerging monolith · **C** — large but cohesive · **D** — healthy.

| Module | Class | Evidence |
|---|---|---|
| `app/api/ai/chat/route.ts` | **A** | 2199 LOC for ONE `POST` (`:1938`). Embeds two prompt serializers inline — `serializeContextBlock` (`:725`, **559 LOC**) + `serializeAssessmentBlock` (`:1416`, **371 LOC**) — plus its OWN debt DB query (`fetchPerLiabilityDebtPayments :671`) bypassing the assembler layer, intent/window/drilldown heuristics (`:226-582`), and duplicated master/single-space branches (`:2039` vs `:2104`). ~930 LOC of the file is prompt text assembly that belongs in a serializer module. |
| `lib/ai/intelligence/annotations.ts` | **A** | God-module: simultaneously the **type contract** (`FinancialAssessment`, 81 fields, `:578`) and the **computation engine** for the whole advisory layer — 11 `compute*` functions across debt/spending/goals/investment/capital domains (`:701–1833`), 110 ternaries. One file mutating requires understanding every advisory sub-domain. |
| `components/dashboard/ManageSpaceModal.tsx` | **A** | Six independent stateful feature tabs in one 1742-LOC file: General (`:314`), Members (`:533`), Goals (`:818`), Finances (`:1201`), Dashboard (`:1322`), DangerZone (`:1446`). **58 useState + 22 distinct fetch endpoints** sharing nothing but the modal frame. |
| `components/space/sections/SpaceSections.tsx` | **A/B** | Layer grab-bag: currency formatters (`:57,:67`) + a **48-entry dispatch registry** across 8 domains (`SectionRegistry :1011`) + async goals CRUD with 6 fetches (`GoalsCard :220–368`) + DnD card presentation (`:1322,:1552`) + a chart modal (`:976`). Formatting + routing + persistence + presentation fused. |
| `lib/plaid/exchangeToken.ts` | **A** | `performPlaidTokenExchange` (`:136`) is **~509 LOC** — the largest single function in the backend. Exchange → dedupe gate → encrypt → 3-way account resolution → holdings → events → snapshot inline (19 DB writes, 6 Plaid calls). A mid-body failure leaves partial durable state. |
| `lib/plaid/refresh.ts` | **A** | `refreshPlaidItem` (`:148`, ~368 LOC, 100 branch points) — near-duplicate of exchangeToken's spine (balances + reconcile + holdings + events + snapshot + inline self-heal `:599`). |
| `components/dashboard/SpaceDashboard.tsx` | **B** | The *render* layer was decomposed (delegates to 10 extracted `*Workspace` components, imports `:33-37`), but the *data/orchestration core* was not: 31 useState, **18 useEffect** (`:281-802`), 14 fetches to 8 endpoints, 5 per-domain envelope states. A decomposed view over an un-decomposed orchestrator = "fat orchestrator." |
| `lib/ai/assemblers/transactions.ts` | **B/C** | 1434 LOC, fetch + FX + 8 rollup derivations, plus a **duplicated category taxonomy** (`:94-106`). |
| `lib/ai/types.ts` | **C→D** | Mega-contract: 25 interfaces / 67 optional fields spanning every domain, **with logic in a types file** (`deriveUnidentifiedInflowShare :766`). |
| `lib/snapshots/regenerate-history.ts` | **B** | `regenerateWealthHistory` ~365 LOC driver, but honesty/walk-back/valuation math is delegated to pure cores — thick orchestrator, not a true monolith. |
| `components/dashboard/DebtClient.tsx` | **B** | 29 useState implementing 4 independent inline editors (FICO/credit-limit/subtype/debt-profile) + a full transaction browser. |
| `lib/crypto/btc-sync.ts` | **B** | Mixes fetch+persist but delegates heavy parse to pure `btc-explorer.ts`. |
| `components/dashboard/SpacesClient.tsx` | **C** | 1293 LOC but one cohesive surface (list/switch/invite/explore); 12 useState, mostly static presentation helpers. |
| `components/dashboard/widgets/SpaceTransactionsPanel.tsx` | **C** | 967 LOC / 20 useState but **zero fetch, zero effect** — pure props-driven; all state is one domain's view controls. High LOC, low risk. |
| `lib/widget-registry.ts` | **C (declarative)** | 1107 LOC but a flat data table — a 1,500-line declarative registry is *not* a monolith (see §7). |
| `lib/investments/valuation.ts` | **D** | Thin read-only entry points delegating to `valuation-core`; the clean counter-model. |
| `components/platform/PlatformSpaceDashboard.tsx` | **D** | 221 LOC, 2 useState, 0 effects — OPS-5 S6 decomposition already succeeded. |

**Verdict:** **7 A-class monoliths** (2 AI, 1 modal, 1 sections, 2 provider orchestrators; SpaceSections A/B), **~5 B-class emerging.** They are known, named, and mostly ex-CLEAN targets — not a sprawl.

---

## 3. Responsibility density

Files combining unrelated concerns (fetching / state / business semantics / formatting / rendering / auth / persistence). *A smaller file with five authorities is worse than a 1,500-line declarative registry.*

**Worst (all four+ concerns fused):**
- **`ManageSpaceModal.tsx`** — six feature domains + fetch + state + persistence, joined by nothing but the modal shell.
- **`SpaceSections.tsx`** — formatting + dispatch-routing + async persistence + DnD presentation.
- **`SpaceDashboard.tsx`** — fetching + cross-domain envelope state + FX conversion + layout-edit + modal orchestration across 6+ financial domains.
- **`lib/plaid/syncTransactions.ts`** — fetch (Plaid) + business (flow-classify, category-map, transfer-evidence, facts, merchant-enrich `:77-110`) + 11 DB writes + user-facing formatting. **All four.**
- **`lib/plaid/refresh.ts` / `exchangeToken.ts` / `lib/crypto/btc-sync.ts`** — same all-four fusion (fetch + reconcile semantics + persistence + user-facing error strings).

**Clean counter-models (single concern despite size):** `valuation.ts`, `reconstruction-core.ts` (pure), `SpaceTransactionsPanel.tsx` (props-only), `SpacesClient.tsx`, `DebtPayoffSection.tsx`, all render adapters, `PlatformSpaceDashboard.tsx`.

---

## 4. Abstraction efficiency

Classification: **JUSTIFIED / PREMATURE / CEREMONIAL / DEAD / FUTURE-SEAM.** *One consumer does not automatically mean bad.*

| Abstraction | Consumers | Class | Note |
|---|---|---|---|
| The `*SpaceData` contract family (6 contracts, each = core + binding + display-conversion + hook) | 1 each | **FUTURE-SEAM (individually) / PREMATURE (as a uniform wave)** | Each split is intent-documented and load-bearing where a real server-FX boundary exists (Investments/Liquidity). But Debt (`debt-space-data.ts:26`) and Cash Flow (`cash-flow-space-data.ts:22`) explicitly compute **client-side, no DB** — the 4-file ceremony buys less there. |
| `use{Investments,Liquidity,Debt}SpaceData` hooks | 1 each | **JUSTIFIED** | NOT single-fn wrappers — own fetch lifecycle: abort via `alive`, stale-keep, error/retry, present-vs-historical branch (`useDebtSpaceData.ts:89-123`). |
| `render{WealthByAccount,DebtByAccount,DebtCost,CreditScore…}` | 1 each (live workspace) | **JUSTIFIED** | Real shaping (asset filter + FX + sort), not prop-forwarding. |
| `SPACE_TEMPLATES` registry (`lib/space-templates/registry.ts`) | **0** at runtime | **DEAD** | Header admits "nothing in the app reads this registry yet" (`:13`); pure wrapper over `getPresetsForCategory` + `CATEGORY_*`. |
| `renderWealthAllocationChart` + Treemap/Strip machinery (`wealth-adapters.tsx:305-490`) | 0 live-reachable | **PARKED-EXPERIMENT (investigate, not clean-dead)** | Self-labeled "TEMPORARY design experiment… Reversible" (`:24,:272`). Wired into `SectionRegistry` (`SpaceSections.tsx:1025`) but the 5 financial perspectives hit explicit `<XWorkspace>` branches and never fall through to `toVirtualSections`. Reachability-dependent — see §11 nuance. |
| `renderWealthAccountCards`/`renderAssetAllocation`/`renderDebtHistory` | 0 live-reachable | **PARKED / superseded** | Same pattern; a test even asserts the live DebtWorkspace does *not* call `renderDebtHistory` (`DebtWorkspace.test.ts:76`). |
| `WidgetMeta` fields (icon/description/tab/configSchema/collapsible/…) | ~2 fields read of ~12 | **CEREMONIAL (≈90% unread)** | Registry's own docstring admits only `.label` + `.requires[0].reason` are consumed (`widget-registry.ts:1098`). |
| `lib/providers/catalog.ts` adapters | disabled stubs (`:141-164`) | **FUTURE-SEAM (honest)** | Documented "no adapter yet" placeholders — a declared seam, not accidental. |

**Net.** ~285 LOC of parked/experiment adapter code + a fully-dead `SPACE_TEMPLATES` layer + ~90%-unread `WidgetMeta` fields. **None of this is a safe automatic delete** — the adapters are self-documented as reversible experiments and their reachability is dispatch-dependent. This is INVESTIGATE-grade, not CLEAN-0-grade.

---

## 5. God objects / mega-contracts

| Contract | Shape | Verdict | Cleanup |
|---|---|---|---|
| `FinancialAssessment` (`annotations.ts:578`) | 81 fields, ~15 sections | **God-object** | It IS the advisory engine's output; splitting requires splitting `computeAssessment`. |
| `SpaceContext_AI` (`ai/types.ts:997`) | root contract + untyped `domains: Record<string,…>` bag (`:1019`) | **God-object** | Untyped domain bag defeats the type system. |
| `CashFlowSpaceData` (`cash-flow-space-data.ts:73`) | 13 fields, 3 granularities of the same fold + full-history selector metadata computed over a *different* population (`:102`) | **Mild god-object** | Split window-projection from full-history selector/trust metadata. |
| `WealthResult` (`wealth-time-machine.ts:120`) | 12 fields incl. rendered prose `explanation` (`:145`) + `evidence` | **Mild god-object** | `explanation`/`evidence` are presentation leaking into a compute read-model — move out. |
| `InvestmentsSpaceData` / `LiquiditySpaceData` / `DebtSpaceData` | 4-6 fields, optionals co-populate | **Clean** | `DebtSpaceData` is exemplary — its doc explicitly *refuses* to become a KPI DTO to avoid dual-authority (`:24-29`). |

No pervasive `Pick`/`Omit`/partial-spread churn — consumers read whole slices. The two true god-objects (`FinancialAssessment`, `SpaceContext_AI`) both live in the AI layer.

---

## 6. Hook complexity (highest-risk first)

| Rank | Component | Risk signal |
|---|---|---|
| 1 | `ManageSpaceModal.tsx` | **58 useState + 22 coupled async fetches** across 6 tabs — largest coupled-async surface in the repo. |
| 2 | `SpaceDashboard.tsx` | 31 useState + **18 useEffect** (`:281-802`) + 14 fetches + 5 derived envelope states — the scariest *effect* cluster for ordering/dependency bugs. |
| 3 | `DebtClient.tsx` | 29 useState + 9 useMemo — four editing state machines interleaved. |
| 4 | `SpaceTransactionsPanel.tsx` | 20 useState + 11 useMemo but **no async/effects** — derived-state heavy, lower risk. |
| 5 | `SpaceSections.tsx` | 14 useState + 6 fetches concentrated in `GoalsCard` (`:198-368`). |

Mutation + fetch + presentation fused in one hook body: **ManageSpaceModal** (6×) and **SpaceDashboard** (per-domain envelopes) are the two offenders. The `use*SpaceData` hooks are the *correct* model (fetch lifecycle isolated from presentation).

---

## 7. Registry complexity

~20 registries. The interesting complexity is concentrated in the **Space/widget/workspace cluster**.

**Best-in-codebase (copy these):**
- **`NOTIFICATION_REGISTRY`** (`notifications/registry.ts:116`, 36 entries) — single identity source, add = 1 entry + 1 producer, no switch, no migration.
- **`SCHEDULED_JOBS`** (`jobs/registry.ts:90`, 11) — string-name coupling, add = 1 entry + 1 body.
- **`ALERT_RULES`** (`alerts/rules.ts:85`) — tight, dormant `quota-low` proves the seam.
- **Platform workspaces** — clean identity (`PLATFORM_WORKSPACES`) vs composition (`PLATFORM_AREA_WORKSPACES`) split, documented (`workspaces.ts:27`).

**The debt cluster (headline registry finding):**
- **The same section key is declared across up to 5 registries.** `debt_payoff_calculator` appears in `WIDGET_REGISTRY` (`:639`), `SectionRegistry` (`SpaceSections.tsx:1068`), `PRESET_MAP` (`space-presets.ts:151`), and `PERSPECTIVE_LIBRARY.debt.widgets[]` (`perspectives.ts:259`). `debt_summary`/`investment_summary`/`investment_allocation`/`retirement_accounts` each appear in 3+.
- **Duplicate metadata that already disagrees.** `label`+`tab` live in BOTH `WidgetMeta` and `SectionPreset`; e.g. `investment_summary` = `"Investment Summary"` (`widget-registry.ts:678`) vs `"Portfolio Summary"` (`space-presets.ts:161`). Icons resolved 6 different ways.
- **`WIDGET_REGISTRY` ↔ `SectionRegistry` are two registries keyed by the identical section key** — one holds metadata, one the renderer. The file's own roadmap says merge them (`SpaceSections.tsx:692`).
- **`lib/perspectives.ts` is a dumping ground** — owns `PerspectiveDef`, `WorkspaceDefinition`, `STANDARD_WORKSPACES`, the universal `WORKSPACE_REGISTRY`, the Platform union, 6 routing helpers, and orchestration flags (5 responsibilities in one config file).
- **`WidgetMeta` is ~90% dead metadata** and **`SPACE_TEMPLATES` reads nothing at runtime.**

**Change amplification per registry:** notification 1 · job 2-3 · alert 2-3 · platform widget 3 registries + reseed · **customer widget 3-5 registries + adapter** · **workspace/perspective 2-6 files across lib+components.**

---

## 8. Semantic complexity

How many authorities must a reader traverse?

| Question | Chain | Verdict |
|---|---|---|
| **What counts as spending?** | `flow-classifier` (assigns `FlowType`) → `flow-predicates.ts` with **three coexisting "spend" sets**: `COST_FLOWS` (`:48`), `SERIALIZED_SPENDING_FLOWS` (`:57`), `isSpendLedgerFlow` (`:81`) → liquidity axis `classifyLiquidity` `CASH_OUT` → `cash-flow.ts` → projection → space-data | **Accidental-adjacent but disclosed.** Module warns "do not conflate the two 'spend' notions" (`:79`). Reader must hold 4 definitions. |
| **What is an internal transfer?** | classify `TRANSFER` → `isTransfer` predicate → `matchTransferCandidate` leg-pairing → `transfer-resolution` owner-scoping → evidence modules → liquidity NEUTRAL | **Legitimate, wide** (5+ authorities, each distinct). |
| **What is investment value as of D?** | `getInvestmentValueAsOf` (`:145`) → `resolvePositionAsOf` (qty) → prices archive (price) → conversion-context (FX) → `valuation-core` (math) | **Clean, textbook binding→core.** No accidental complexity. |
| **What is liquid?** | `computeLiquidity` (`liquidity.core.ts:111`) — cashNow/marketable/illiquid — **vs** `classifyAccounts.totalLiquid` (`account-classifier.ts`) used by `wealth-adapters.tsx:245` | **Mild accidental complexity** — two divergable liquid definitions. |
| **What counts toward net worth?** | `Snapshot.netWorth` written by `regenerate.ts`/`backfill.ts` → `wealth-time-machine.ts:160` reads verbatim + re-derives composition | **Legitimate** — single source, pure read. |

**Two divergence risks worth documenting** (not collapsing): the three "spending" sets, and the two "liquid" definitions.

---

## 9. Historical complexity (consuming INVEST-1)

INVEST-1's diagnosis holds: **most "disagreement" is load-bearing and intentional; the genuinely accidental surface is small.**

| Mechanism | Class | Consolidatable? |
|---|---|---|
| M1 `regenerate.ts` / M2 `backfill.ts` / M3 `regenerate-history.ts` | **load-bearing** (M3 strict superset; M2 create-only safety) | Only as *modes* of a unified writer — INVESTIGATE, not now. |
| M4 `snapshot-amendment.ts` | **governance** (consent/audit, soft-ref no-FK) | **NEVER merge.** |
| M6 `reconstruction-core` / M8 `valuation` | **load-bearing** | KEEP DISTINCT (already shared, param per consumer). |
| `isReconstructableCard` (4 byte-identical copies) | **duplicate** | **SAFELY CONSOLIDATABLE now** → `backfill-core.ts` (already imported by all holders). |
| M3 `N×date` A8 loop | **performance** | **ALREADY FIXED** — `regenerate-history.ts:343` now calls batched `getInvestmentValueForWindow` (`valuation.ts:219`); only the per-day `readBtcUsdAsOf` (`:409`) leg remains. |

**Only one safe historical consolidation remains: the 4-copy `isReconstructableCard` predicate.** Everything else is load-bearing or governance.

---

## 10. Data-flow complexity

Traced examples — which layers enforce a **real** boundary vs ceremonial forwarding:

1. **Investments** — route (`loadInvestmentsSpaceData` = REAL: DB reads + composition) → hook (REAL: fetch/abort) → `convertInvestmentsSpaceData` (REAL: FX). **No ceremonial layer.**
2. **Debt** — thin single-value route (as-of lens only, by design) → hook injects host snapshots+FICO + `assembleDebtSpaceData` (REAL: history clip) → workspace → adapters. **Only ceremony:** `DebtSpaceData` wraps a lens the workspace already holds — thin but intent-documented.
3. **Wealth** — host snapshots → `convertWealthSnapshots` (REAL: FX) → `computeWealthTimeMachine` (REAL: read model) → `renderWealthByAccount` (REAL-ish shaping) → widget. **The genuinely ceremonial artifact is the parallel dead `SectionRegistry` path** (`SpaceSections.tsx:1020-1026`) that forwards the same `(accounts, ctx)` to unreachable experiment variants.

**Conclusion:** the `*SpaceData` pipelines are mostly real boundaries (FX conversion is the load-bearing transform). The ceremony is not in the pipelines — it's in the *second, superseded* registry path that the workspace dispatch replaced.

---

## 11. Frontend component complexity

Ranked by state-density × domain-count × fetch-ownership:

| Rank | File | State | Domains | Fetch | Modals | Decompose next? |
|---|---|---|---|---|---|---|
| 1 | `ManageSpaceModal.tsx` | 58 uS | 6 | 22 | is-a-modal | **YES — #1 target** |
| 2 | `SpaceDashboard.tsx` | 31 uS / 18 uE | 6+ | 14 | 4 | **YES — extract data hook** |
| 3 | `SpaceSections.tsx` | 14 uS | 8 | 6 | 2 | **YES — layer split** |
| 4 | `DebtClient.tsx` | 29 uS | 5 | 7 | 1 | Later — extract 4 editors |
| 5 | `SpaceTransactionsPanel.tsx` | 20 uS | 1 | 0 | 0 | NO — cohesive |

**`ManageSpaceModal.tsx` — YES, strongest target in the repo.** The seams are already drawn (6 named tab components + 2 exported reusable panels). Splitting each tab into its own file is low-risk mechanical extraction; it benefits *two* hosts (opened by both SpaceDashboard `:1057` and SpacesClient `:1273`).

**`SpaceSections.tsx` — YES, but a layer split (not tabs):** (a) formatters → util; (b) `SectionRegistry` → its own module (90% wiring already); (c) stateful `GoalsCard`/`TrashDrawer` → feature module. This currently forces formatting, routing, and async persistence to change in one file.

**Nuance on the dead `SectionRegistry` entries** (`:1020-1045`): they are wired and imported, but reachability depends on whether any perspective still falls through to `toVirtualSections`. The 5 financial perspectives do NOT (explicit `<XWorkspace>` branches). Before deleting, confirm no *standard/seeded* section path reaches them — this is why it's INVESTIGATE, not DELETE.

---

## 12. Backend complexity

Giant orchestration functions (a single failure spans 8-11 modules):

| Rank | Function | LOC | Why |
|---|---|---|---|
| 1 | `performPlaidTokenExchange` (`exchangeToken.ts:136`) | ~509 | Largest backend fn. Exchange→dedupe→encrypt→3-way account resolution→holdings→events→snapshot inline. Partial-failure durability risk. |
| 2 | `syncTransactionsForItem` (`syncTransactions.ts:137`) | ~401 | fetch + 6 business enrichers + persist in one body (18 imports). |
| 3 | `refreshPlaidItem` (`refresh.ts:148`) | ~368 | Manual-refresh superset; **near-duplicate of #1's spine** + inline self-heal (`:599`). 100 branch points. |
| 4 | `regenerateWealthHistory` (`regenerate-history.ts:140`) | ~365 | Worst regeneration path; per-day loop over walk-backs + A8 + BTC + honesty decision + upsert. |

**Key structural finding: the monoliths are in the PROVIDER layer, not the history layer.** INVEST-1 found history "PARTIAL but sound." The provider orchestrators are the real debt: `exchangeToken` and `refresh` are near-duplicate ~400-500 LOC account-resolution+holdings+events+snapshot spines written twice, and there is **no provider polymorphism** (`lib/providers/catalog.ts` adapters are disabled stubs).

---

## 13. Change amplification

To add one new… (files that must change; **localized** = explicit boundary, **scattered** = no dispatch authority):

| New X | Files | Localized? |
|---|---|---|
| **Background job** | `jobs/registry.ts` + `jobs/<name>.ts` (+`vercel.json` slot) | ✅ **2-3** — registry header literally says "adding a job = adding an entry here." |
| **Alert rule** | `alerts/rules.ts` + `alerts/evaluate.ts` branch (+authority) | ✅ **2-3** |
| **Notification** | `notifications/registry.ts` + 1 producer | ✅ **best-in-codebase, ~2** |
| **Provider** | `catalog.ts` + `ProviderType` enum + ~12-15 files (clone a ~1500-LOC exchange/sync/refresh stack — no polymorphism) | ⚠️❌ **~12-15** |
| **Currency** | `fx/config.ts SUPPORTED_QUOTES` + ~11 references + provider coverage | ⚠️ **~6-11** |
| **Financial semantic (flow type)** | `FlowType` union + enum + **29 files** enumerate members (no dispatch table) | ❌ **~10-29 scattered** |
| **Workspace/perspective** | 3 parallel registries (presets/templates/perspectives) + `SpaceCategory` in 12 files + host maps | ❌ **~8-12 scattered** |
| **Historical metric** | `SpaceSnapshot` column + **~7 snapshot builders** must write it byte-identically + read paths | ❌ **~12-15 scattered** |

**The seam quality is bimodal:** jobs/alerts/notifications are textbook single-entry registries; flow-types/workspaces/historical-metrics/providers have **no dispatch authority**, so one addition edits 10-29 files across `lib`+`components`.

**Systemic inconsistency tax (all 132 routes):** 6+ auth helpers (2 rival space-auth patterns: `requireSpaceRole` vs `requireSpaceAction`), `withApiHandler` on only **42/132** routes, **0** schema-validation adoption (43 routes hand-roll `typeof` checks). Every route re-establishes its own auth+validation+error contract.

---

## 14. Cognitive-load grade (A best – F worst)

| Domain | Discoverability | Ownership | Change safety | Local reasoning | Extension cost | Overall |
|---|---|---|---|---|---|---|
| **Spaces** | C | C | C | C (18-effect orchestrator) | C (3 registries) | **C** |
| **Transactions** | B | B | B | C (3 "spend" defs) | C (29-file flow-type) | **B/C** |
| **Financial semantics** | B | A | B | C (spend/liquid divergence) | C | **B/C** |
| **Investments/history** | A | A | A | A (clean binding→core) | B | **A/B** |
| **Platform Ops** | A | A | A | A | A | **A** |
| **Providers** | C | B | C (partial durability) | D (509-LOC fns) | D (no polymorphism) | **C/D** |
| **AI** | C | C | D (two D-monoliths) | D (930 LOC inline serialize) | D (7-10 files/semantic) | **D** |
| **Testing** | B | B | B | B | B | **B** (per TEST-0) |

**AI and Providers are the two lowest-graded domains.** Investments/history and Platform Ops are the exemplars (the decomposition discipline visibly paid off there).

---

## 15. Complexity invalidation ledger (ranked)

| # | Candidate | Location | LOC | Responsibilities | Consumers | Why complex | Justified? | Risk | Rec | Pri |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `chat/route.ts` | `app/api/ai/chat` | 2199 | route+intent+serialize×2+debt-query+validate | 1 route | ~930 LOC inline prompt serialization + own DB query bypassing assemblers | NO | High | **SPLIT** (extract `serializeContextBlock`/`serializeAssessmentBlock`; route debt via assembler) | **P0** |
| 2 | `annotations.ts` | `lib/ai/intelligence` | 2184 | type-contract + 11 compute engines | AI layer | god-module: contract AND engine in one file | NO | High | **SPLIT** (types → `assessment-types.ts`; compute → per-domain modules) | **P0** |
| 3 | `ManageSpaceModal.tsx` | `components/dashboard` | 1742 | 6 feature tabs | 2 hosts | 58 uS + 22 fetches; seams already drawn | NO | Med | **SPLIT** (one file per tab — mechanical) | **P0** |
| 4 | Widget/section/preset/perspective registry cluster | `lib/widget-registry`, `SpaceSections`, `space-presets`, `perspectives` | ~3400 | identity×5 + composition + renderer | Space UI | same key in ≤5 registries; label disagreements; 90% dead `WidgetMeta` | NO | Med | **MERGE** (`WIDGET_REGISTRY`+`SectionRegistry`; drop unread fields) + **DELETE** `SPACE_TEMPLATES` | **P1** |
| 5 | `exchangeToken.ts` + `refresh.ts` provider spine | `lib/plaid` | 1383 | exchange/refresh + reconcile + holdings + events + snapshot | onboarding/refresh | two near-duplicate ~400-509 LOC orchestrators; no polymorphism | Partial | High (durability) | **SIMPLIFY** (extract shared account-resolution+holdings+events+snapshot spine) | **P1** |
| 6 | `SpaceDashboard.tsx` data core | `components/dashboard` | 1481 | 18 effects + 14 fetches + envelopes | 1 host | view decomposed, orchestrator not | Partial | Med | **SPLIT** (extract `useSpaceDashboardData`) | **P1** |
| 7 | `SpaceSections.tsx` | `components/space/sections` | 1584 | format + registry + goals CRUD + DnD | Space UI | 4 layer-types fused | NO | Med | **SPLIT** (format util / registry module / goals feature) | **P1** |
| 8 | `ai/types.ts` + `SpaceContext_AI` | `lib/ai` | 1019 | 25 DTOs + logic + untyped domain bag | AI layer | mega-contract, logic in types file, `Record<string,…>` bag | NO | Med | **SIMPLIFY** (extract helpers; type the domain bag) | **P1** |
| 9 | Category taxonomy (duplicated ×3) | `assemblers/transactions.ts:94`, `annotations.ts:786`, `lib/data/transactions.ts` | — | spending classification | AI + data | same taxonomy redefined 3× | NO | Med | **MERGE** to one authority | **P1** |
| 10 | Route auth/validation inconsistency | `app/api/**` (132) | — | auth+validate+error | all routes | 6+ auth helpers, `withApiHandler` 42/132, 0 zod | NO | Med | **SIMPLIFY** (converge on `withApiHandler` + one space-auth + schema validation) | **P1** |
| 11 | `CashFlowSpaceData` / `WealthResult` | `cash-flow-space-data.ts:73`, `wealth-time-machine.ts:120` | — | window+full-history / compute+prose | 1 each | god-object; presentation in read-model | Partial | Low | **SIMPLIFY** (split window/selector; move `explanation` out) | **P2** |
| 12 | `DebtClient.tsx` | `components/dashboard` | 1240 | 4 editors + tx browser | 1 | 29 uS interleaved | Partial | Low | **SPLIT** (extract editors) | **P2** |
| 13 | Parked wealth/debt experiment adapters + dead `SectionRegistry` entries | `wealth-adapters.tsx:131-490`, `debt-perspective-adapters.tsx:272`, `SpaceSections.tsx:1020-1045` | ~285 | render experiments | 0 live-reachable | reversible experiments, superseded by workspace dispatch | N/A | Low | **INVESTIGATE** (confirm no seeded path reaches them, then DELETE) | **P2** |
| 14 | Two "liquid" + three "spend" definitions | `liquidity.core.ts:111` vs `account-classifier`; `flow-predicates.ts:48/57/81` | — | semantic authority | many | divergable parallel definitions | Partial | Low | **INVESTIGATE** (document owner-per-surface; reconcile) | **P2** |
| 15 | `isReconstructableCard` (4 copies) | `backfill.ts:69`, `regenerate-history.ts:67`, `accounts-asof.core.ts:69`, `accounts-asof.ts:121` | — | predicate | 4 | byte-identical duplicate | NO | Low | **INLINE** to `backfill-core.ts` (already imported) | **P2** |
| 16 | `lib/perspectives.ts` dumping ground | `lib/perspectives.ts` | 493 | 5 responsibilities | many | config file owns registry+routing+vocab+flags | Partial | Low | **SPLIT** (registry / routing / vocab) | **P3** |
| 17 | `syncTransactions.ts` / `btc-sync.ts` density | `lib/plaid`, `lib/crypto` | 1194 | fetch+business+persist+format | jobs | all-four responsibility fusion | Partial | Med | **INVESTIGATE** (extract enricher pipeline) | **P3** |

---

## 16. Future-monolith watchlist

Healthy now, trending toward monolith — early warning signs:

| Module | LOC now | Warning sign |
|---|---|---|
| `lib/perspectives.ts` | 493 | Already owns 5 responsibilities; every new workspace/lens adds here. **Will become the registry's SpaceDashboard.** |
| `lib/widget-registry.ts` | 1107 | Accreting config schemas nothing reads; inventory-doc masquerading as live registry. Each new widget grows it. |
| `PlatformSpaceDashboard.tsx` | 221 | Healthy today, but `PLATFORM_WIDGET_REGISTRY` + `PLATFORM_AREA_WORKSPACES` + `PLATFORM_AREAS.sections` describe the same keys in 3 files — dumping-ground risk as Ops adds widgets. |
| `annotations.ts` | 2184 | Already an A-monolith; every new advisory semantic adds a `compute*` + `FinancialAssessment` field. Actively worsening. |
| `SpaceDashboard.tsx` data core | 1481 | 35 commits/200 = highest churn. Every new workspace adds an effect + envelope. |
| Workspace `*SpaceData` contract wave | 6 contracts | The uniform 4-file split is a FUTURE-SEAM; if applied to domains with no server boundary (Debt/CashFlow) it accretes ceremony. Watch for a 7th client-only contract. |

---

## 17. Final answer

**Where is the next SpaceDashboard hiding?**
Two places. (1) **`app/api/ai/chat/route.ts`** — a 2199-LOC route that is 930 LOC of inline prompt serialization; it is *already* a monolith the way SpaceDashboard was pre-decomposition. (2) **The Plaid provider spine** (`exchangeToken.ts` + `refresh.ts`) — two near-duplicate ~400-509 LOC orchestrators with no polymorphism; the next provider clones the whole stack.

**Top 5 highest-cognitive-load files:**
1. `app/api/ai/chat/route.ts` (2199, inline serialize×2 + own DB query)
2. `lib/ai/intelligence/annotations.ts` (2184, type-contract + engine god-module)
3. `components/dashboard/ManageSpaceModal.tsx` (1742, 58 useState / 6 tabs)
4. `lib/plaid/exchangeToken.ts` (509-LOC single function)
5. `components/dashboard/SpaceDashboard.tsx` (18 effects / 14 fetches / highest churn)

**Top 5 premature abstractions:**
1. `SPACE_TEMPLATES` registry — DEAD, zero runtime consumers.
2. `WidgetMeta`'s ~10 unread fields per entry (config schemas, flags) — ~90% ceremonial.
3. `WIDGET_REGISTRY` + `SectionRegistry` as two registries for one key.
4. The uniform 4-file `*SpaceData` split applied to client-only domains (Debt/CashFlow) where no server boundary exists.
5. Parked wealth-allocation experiment machinery (Treemap/Strip, ~185 LOC) wired but unreachable.

**Top 5 justified large modules (KEEP despite size):**
1. `lib/widget-registry.ts` — declarative data table (its *fields* are the problem, not its size).
2. `lib/investments/valuation.ts` — thin read-only binding→core; the clean model.
3. `components/dashboard/widgets/SpaceTransactionsPanel.tsx` — 967 LOC, one domain, zero async.
4. `lib/snapshots/regenerate-history.ts` — thick orchestrator over pure cores (INVEST-1: load-bearing).
5. `lib/notifications/registry.ts` — 697 LOC single-source registry, the extension model.

**What should be decomposed next?** In order: (1) `ManageSpaceModal` (mechanical, seams drawn, 2 hosts) → (2) `chat/route.ts` serializer extraction → (3) `annotations.ts` type/engine split → (4) `SpaceDashboard` data-hook extraction → (5) merge `WIDGET_REGISTRY`+`SectionRegistry`.

**What should NOT be decomposed despite being large?** `valuation.ts`, `SpaceTransactionsPanel.tsx`, `widget-registry.ts` (fix fields, not size), `regenerate-history.ts` (load-bearing per INVEST-1), `SpacesClient.tsx` (cohesive), and the M1-M8 historical mechanisms (governance/load-bearing). **Do not merge M4 amendment or collapse legitimate semantic layers.**

---

## Verdict

**Codebase structurally over-complex?** **PARTIAL** — complexity is concentrated in 4 named clusters (AI, Plaid provider spine, the widget/section/perspective registry cluster, the SpaceDashboard/ManageSpaceModal frontend orchestrators), not pervasive. The rest shows successful decomposition discipline.

**New monoliths exist?** **YES** — 7 A-class: `chat/route.ts`, `annotations.ts`, `ManageSpaceModal.tsx`, `SpaceSections.tsx` (A/B), `exchangeToken.ts`, `refresh.ts` spine.

**Emerging monoliths exist?** **YES** — `SpaceDashboard.tsx` (fat orchestrator), `ai/types.ts`, `DebtClient.tsx`, `lib/perspectives.ts` (dumping ground).

**Over-abstraction meaningful?** **YES** — but narrow: `SPACE_TEMPLATES` (dead), `WidgetMeta` fields (~90% unread), duplicate `WIDGET_REGISTRY`/`SectionRegistry` layer. Not systemic.

**Ceremonial layers meaningful?** **PARTIAL** — the `*SpaceData` pipelines are mostly real (FX boundaries); the genuine ceremony is the *superseded* SectionRegistry path and the uniform contract-split applied to client-only domains.

**Top next decomposition target:** **`components/dashboard/ManageSpaceModal.tsx`** (highest-density, lowest-risk, seams already drawn, benefits two hosts). *(Highest-severity is `chat/route.ts`, but ManageSpaceModal is the highest value-to-risk first move.)*

**Major complexity cleanup justified?** **YES** — P0/P1 items (AI serializer extraction, ManageSpaceModal split, registry merge, provider-spine dedup) are well-evidenced and high-leverage.

**Safe to act on P0 findings immediately?** **PARTIAL** — the three P0 splits (`chat/route.ts` serializers, `annotations.ts` type/engine, `ManageSpaceModal` tabs) are behavior-preserving mechanical extractions and safe with the existing test gate. But (a) they touch shared, high-churn files on a concurrent branch — serialize the commits (per project commit-discipline memory), and (b) the "dead adapter" deletions are **NOT** P0 — they are reachability-dependent, self-documented reversible experiments (INVESTIGATE first). No history-mechanism consolidation beyond the `isReconstructableCard` predicate is safe now.

---

*No code modified. No refactor. No commit. No push. Read-only audit.*
