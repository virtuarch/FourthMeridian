# Fourth Meridian — Debt Perspective Redesign: Investigation & Claude Code Implementation Plan

**Date:** 2026-07-12
**Branch of record:** `feature/v2.5-spaces-completion` (HEAD `33c927e` — Cash Flow redesign S1–S5 recorded). **Working-tree caveat (verified at plan time, §1.8):** the Liquidity redesign is MID-FLIGHT and UNCOMMITTED — `git status` shows `M components/dashboard/SpaceDashboard.tsx` (+14 lines: the `liquidity` branch at `:3221–3233`) and an untracked `components/space/widgets/liquidity/` (`LiquidityPerspective.tsx`, `LiquidityLadderTiers.tsx`, `LiquidityPerspective.test.ts`). SpaceDashboard line numbers below are the working tree (3,541 lines) including that diff. **This plan may not start until the Liquidity slices land** (stop condition 3).
**Scope:** Composition and presentation redesign of the Debt Perspective — relocation and restyling of the seven mounted, landed widgets, plus thin panels over landed pure math. No widget replacement, no engine changes, no backend changes, no new time model, no Space-navigation changes.
**Reference:** attached dashboard mockup — KPI tiles (Total Debt · Total Interest Cost (Est.) · Debt Utilization · Monthly Debt Payment) · Debt Balance Over Time (Line/Area/Bar, All Time) · Debt Mix by Type (donut) · Debt Accounts table · Payoff Planner (debt-free date, extra-payment scenarios, interest saved) · Upcoming Payments (30 days) · Interest Cost Projection (12 months) · Debt Health Score (300–850 gauge with reason checkmarks). Layout/hierarchy reference only, not a literal spec; several regions are historical/projective/fabricated and are explicitly deferred or reduced (§2).

**Non-negotiable invariant (same as Liquidity's, same reason, decided):** this is a **CURRENT-STATE-ONLY** redesign — no `asOf`/`compareTo`/historical balance reads are wired into Debt. Verified in-repo: `lib/perspective-engine/lenses/debt.ts` carries full as-of logic (A5-P3, kill-switched — the `options.asOf` branch at `:49–58`, completeness stamping at `:102–108`, tested in `lib/perspective-engine/debt.asof.test.ts`), and the batch route `app/api/spaces/[id]/perspectives/route.ts` passes **no `asOf`** (`:61` — the kill switch stays closed). The recorded reason is the audit's C4 finding (`FOURTH_MERIDIAN_REPOSITORY_AUDIT_2026-07-12.md:203`): `lib/data/accounts-asof.core.ts` walks back only cash and **revolving credit cards** (`isReconstructableCard`, `:69–74` — explicit `credit_card` subtype, or null subtype + a creditLimit); **installment loans, mortgages, and every explicit non-card debt are held flat at TODAY'S balance for any historical date** (the `held-flat` branch, `:151–153`, `tier: "estimated"`). Wiring `asOf` into Debt now would silently misstate loan history. That activation is a separate, later initiative (audit §9 step 5, `:269`). One nuance the Liquidity plan didn't have: **the Debt workspace already renders history** — `debt_history` reads SpaceSnapshot rows, which is a snapshot read, not an as-of account read; see §1.5 for why that is a pre-existing condition to relocate, not a violation to fix or a blocker.

---

## 1. Repository findings

### 1.1 Entry point and rendering path (current)

- Host: `components/dashboard/SpaceDashboard.tsx` (3,541 lines in the working tree). Perspectives tabpanel at `:3134`; `PerspectiveShell` at `:3143–3166`. Bespoke composition branches now exist for `wealth` (`:3178`), `cashFlow` (`:3204`, landed `4265033`/`85a7539`), and `liquidity` (`:3221`, **uncommitted**). **Debt still renders through the generic fallback** (`:3234`): `toVirtualSections(activePerspective.id, activePerspective.widgets)` → a vertical `SectionCard` stack (`space-y-3`, single column), with `snapshots`, `ficoScore`, `ficoUpdatedAt` threaded at `:3244`/`:3253–3254`.
- The Debt widget list is `lib/perspectives.ts:136–139`:
  `widgets: ["debt_by_account", "debt_cost", "credit_utilization", "debt_history", "debt_payoff_calculator", "credit_score", "debt_complete_info"]`
  Doctrine (`:132–135`): Debt answers **"What do I owe?"** — LIABILITIES ONLY; shape, cost, and risk of debt; no assets/net worth/allocation/spending/goals. The entry also carries `lensId: "debt"` (`:131`) — Debt and Liquidity are the only two lens-backed perspectives.
- All seven keys (plus the unmounted `debt_payoff_snapshot`) are in `SOLID_LEDE_KEYS` (`SpaceDashboard.tsx:1651–1652`), so each renders as `GlassPanel depth="thin" elevation="e2" radius="lg" p-4` with a `text-sm font-semibold` header (`:1788–1800`). Labels come from `lib/widget-registry.ts:387–473` and `:692–694`.
- Renderer dispatch: `WIDGET_RENDERERS` (`SpaceDashboard.tsx:1369–1375`, payoff at `:1397`) → `components/space/widgets/debt-perspective-adapters.tsx` (434 ln) and `debt-adapters.tsx` (178 ln).
- Categories mounting Debt: PERSONAL, HOUSEHOLD, FAMILY (`lib/perspectives.ts:194–196`) and DEBT_PAYOFF (`:202`). The new branch serves all identically.
- **Two other debt surfaces exist and are out of scope, untouched:** (a) the DEBT rail-tab **GlassModal** (`PERSPECTIVE_ROUTED_TABS`, `SpaceDashboard.tsx:310`, modal at `:3312–3349`; DB-backed `debt_summary` sections per `lib/space-presets.ts:131–137`; the Overview doorway card routes there via `PERSPECTIVE_TARGET_TAB.debt = "DEBT"`, `:300–302`, `:2423–2431`); (b) the personal **Credit tab** `components/dashboard/DebtClient.tsx` (1,240 ln, `/dashboard/credit`), which shares `renderDebtPayoffCalculator` (`DebtClient.tsx:19`, `:696`) and the DebtProfile editor. Shared files are therefore **relocate-around, never rewrite** (§1.6).

### 1.2 Widget inventory (all seven currently mounted, in this order)

| # | Key | Renderer (file:line) | Responsibility | Data source |
|---|-----|----------------------|----------------|-------------|
| 1 | `debt_by_account` | `renderDebtByAccount` (`debt-perspective-adapters.tsx:88`) | Every liability as ranked `BreakdownWidget` bars — APR-desc when any rate exists, else balance-desc; per-row institution, `% APR`, `/mo min` metas; `debtColor` red ramp | `accounts.filter(type==="debt")`, display-converted via `ctx` |
| 2 | `debt_cost` | `renderDebtCost` (`:131`) | Estimated monthly interest per debt (balance × APR ÷ 12), most expensive first; footer totals `…/mo` and discloses "N debts without an APR not shown"; no APR anywhere ⇒ honest empty state ("we never invent a rate") | same |
| 3 | `credit_utilization` | `CreditUtilizationWidget` (component, `:190`) | balance/creditLimit bars for revolving lines, colored by LEVEL (`lib/accounts/credit-utilization.ts:37–42`: <30 low / 30–70 moderate / 70–100 high / >100 over — low is never red); true % may exceed 100; inline "Add limit" affordance (PATCH `/api/accounts/[id]`) for debts missing a limit | `creditUtilization(accounts)` (pure, tested `credit-utilization.test.ts`) |
| 4 | `debt_history` | `renderDebtHistory` (`:339`) | Total debt over time from SpaceSnapshot history: last 24 points of the `totalDebt` series (`:349`), current figure + signed delta "over N snapshots", 64px opacity-ramped bar sparkline (`:377–385`); <2 points ⇒ honest "Not enough history yet" | host `snapshots` (fetch triggered by `debtWorkspaceActive`, `SpaceDashboard.tsx:2619`, `:2755–2764`) |
| 5 | `debt_payoff_calculator` | `renderDebtPayoffCalculator` (`debt-adapters.tsx:163`) → `DebtPayoffSection` (`components/space/sections/DebtPayoffSection.tsx`, 707 ln) | Interactive payoff planner: account include/exclude chips, payment slider + input, weekly/monthly toggle, **"Debt-free in" + payoff date** (`:226–228`), principal/interest/total-paid breakdown, disclaimers; aggregate simulation over the balance-weighted APR via exported pure `simulatePayoff` (`:80–108`) | accounts + `ctx` |
| 6 | `credit_score` | `renderCreditScore` (`debt-perspective-adapters.tsx:396`) → `FicoCard` | **Manual** FICO (300–850 bands at `FicoCard.tsx:22–27`: ≥740 Excellent / ≥670 Good / ≥580 Fair / Poor); "Add score" affordance → `/dashboard/credit`; registry doctrine: "never drives debt calculations" (`widget-registry.ts:454`) | host `ficoScore`/`ficoUpdatedAt` props (Personal host only — `app/(shell)/dashboard/page.tsx:125`; shared Spaces render the add-score state) |
| 7 | `debt_complete_info` | `renderDebtCompleteInfo` (`:409`) → `KnowledgeAcquisitionCard` | Inline editor for missing APR / minimum payment (PATCH `/api/accounts/[id]/debt-profile`); broadcasts `SPACE_ACCOUNTS_CHANGED_EVENT` on save; nothing missing ⇒ quiet "All set" | accounts |

**Landed and ORPHANED (the debt analog of `cash-flow-compare.ts`):** `renderDebtPayoffSnapshot` (`debt-perspective-adapters.tsx:286–332`) — total owed, minimum payments/mo, highest-APR target, honest payoff estimate at minimums (incl. "Minimums may not cover interest"). Registered in `widget-registry.ts:426` and `SOLID_LEDE_KEYS` (`:1651`) but **in no `widgets[]` list and absent from `WIDGET_RENDERERS`** (grep-verified: only its own file, the registry, and the lede set reference it). Its math is exactly the mockup's KPI row — this redesign is its sanctioned consumer (as math to reuse in `debt-kpis.ts`, §3.4; the renderer itself stays untouched).

**Stale registry description (do not build to it):** `debt_payoff_calculator`'s description claims "avalanche and snowball strategies" with a `strategy` configSchema (`widget-registry.ts:694`, `:706–717`) — **the component implements neither**; it simulates one aggregate balance at a blended APR, and the renderer ignores `config` entirely (`SpaceDashboard.tsx:1397`). Avalanche/snowball exist only as AI-context *candidates* (`lib/ai/intelligence/annotations.ts:251–254`), not as a per-account payoff sequencer. Building one is a new simulation engine — refused here (§2, §6), matching the lens's own amortization refusal ("no amortization engine exists and none is built here", `lenses/debt.ts:26–28`).

### 1.3 Data and time ownership — current-state plus one pre-existing snapshot read

- **Data:** the host owns everything the stack consumes: `accounts` (SpaceAccount, `SpaceDashboard.tsx:148–159`), `widgetCtx` (`:2345–2348`), `snapshots` (`:2323`, fetched when `debtWorkspaceActive`, `:2755–2764`), `ficoScore`/`ficoUpdatedAt` (host props, `:225–226`). All renderers are pure over props; only `CreditUtilizationWidget` and `KnowledgeAcquisitionCard` mutate (their own PATCH + refresh event — preserved as-is).
- **Time:** Debt receives **no time input**. No debt renderer reads `period`/`onSelectPeriod`; `asOf`/`compareTo` never leave the shell toward any widget. Moving As Of / Compare To has zero effect on this workspace today. **Preserved exactly.**
- **Lens engine (current-state):** the host batch-fetches `GET /api/spaces/[id]/perspectives` (`:2713–2735`, no `asOf` — route `:61`) into `lensResults`; the debt lens is registered (route imports at `:38–39`). Today that result reaches (a) the Overview doorway card and (b) the shell envelope (`:3153`). The Debt **workspace** never shows the engine's answer — landed logic, unsurfaced presentation, the exact shape Liquidity's lede consumed.
- **Lens content** (`lenses/debt.core.ts`): verdict sentence ("You carry $X across N accounts, accruing an estimated $Y/month…", `:316–325`), headline `totalDebt`, metrics `monthlyInterest`/`blendedApr`/`minPayments`/`promoEnds` (`:250–281`), assumptions, and privacy-shaped provenance (FULL + BALANCE_ONLY balances count; summary-only redacted; name-free rows by construction, `:75–98`).

### 1.4 A verified client/lens data discrepancy (pre-existing; shapes the design)

The **server** read path (`lib/data/accounts.ts:170–183`) resolves *effective* debt terms — `DebtProfile.apr/minimumPayment` take precedence over the flat `FinancialAccount` columns, and a minimum payment is *estimated* when APR is known but no minimum exists (`:180–183`). The lens computes from these. The **client** workspace path (`GET /api/spaces/[id]/accounts` → select at `route.ts:55–67` → `normalizeSharedAccounts`, `lib/account-privacy.ts:240–253`) returns the **raw flat columns only — DebtProfile is never read**. Consequences, verified: (a) lens figures and widget figures can legitimately disagree when a user entered terms via DebtProfile; (b) `debt_complete_info` saves to DebtProfile (`KnowledgeAcquisitionCard.tsx:185`) and then refreshes a route that cannot see the save — in the Space workspace the "missing APR" gap can persist after a successful save (the personal Credit tab is unaffected — `DebtClient` maintains its own DebtProfile state, `:383`, and the Personal server page reads the merged `getAccounts` path). **Disposition:** pre-existing wiring gap, NOT introduced or fixed by this redesign (fixing it is an additive, KD-19-sensitive backend change — named as a follow-up in §6, kept out of scope). Design consequences here: the lens lede renders the verdict **sentence** only, never a competing figure of record; the KPI strip computes from the **same client accounts array the panels use**, so the workspace always agrees with itself (§3.4, §5).

### 1.5 `debt_history` and the flat-hold — pre-existing condition, documented, not a blocker

`debt_history` reads `Snapshot.totalDebt` (`types/index.ts:86`). Snapshot rows come from two writers: live daily rows (real observations of that day's balances) and the D2.x **backfill** (`lib/snapshots/backfill.ts`), which reconstructs history by walking back cash and **revolving cards only** — "Non-card debt (loans, mortgages, HELOC/LOC with an explicit subtype) stays flat" (`:194–199`; same `isReconstructableCard` parity copy as the as-of core, `:68–70`) — and stamps those rows `isEstimated: true` (`:277`). So the existing, in-production chart already holds installment/mortgage balances flat across its *backfilled* segment, exactly the C4 shape. This predates this redesign (the widget shipped with UX-PER-3), is bounded (organic rows are real), and is **carried, not created, by relocating the widget**. The S3 presenter upgrade makes it *more* honest by dimming `isEstimated` points (the same affordance the hero chart has) — it must never add an as-of read (stop condition 1).

### 1.6 Envelope — already correct, explicitly untouched

`lib/perspectives/envelope.ts:170–172`: the `debt` case (shared with `liquidity`) already maps the fetched `LensResult` through `lensEnvelope` (`:126–141`) — Observed/Estimated from `lens.estimated`, "Live account balances… as of <dataAsOf>", evidence "N accounts". The Debt shell chips are **already dynamic**. Zero diff in `envelope.ts`; `envelope.test.ts` untouched and green. (Contrast: Investments' plan had to fix stale text; Debt does not.)

### 1.7 Layout primitives, precedent

Three composition precedents now exist, all `grid grid-cols-1 lg:grid-cols-12 gap-4 min-w-0` with a **local, non-exported `Panel` helper** reproducing the SectionCard solid-lede treatment: `WealthPerspective.tsx:65` (`items-start`), `cashflow/CashFlowPerspective.tsx` (`items-stretch`, adapter reuse), and the in-flight `liquidity/LiquidityPerspective.tsx:48–57, :136` (`items-stretch`, Panel + conditional lens-lede strip at `:81–102`). **Debt's content shape — KPI tiles + ranked breakdowns + one interactive planner + a lede — is the Liquidity shape; this plan mirrors the Liquidity file mechanically** (fourth local Panel copy; extraction remains a non-goal until a consumer complains — same ruling as Investments §1.7). `BreakdownWidget` (380 ln; donut/bar/list at `:53`, `:372–374`) and `SummaryWidget` (252 ln) are the reused presenters.

### 1.8 Concurrent-modification constraints — verified now, WORSE than at Liquidity plan time

`FOURTH_MERIDIAN_A6_A7_A8_P5_PARALLELIZATION_INVESTIGATION_2026-07-12.md`: `SpaceDashboard.tsx` = "FILE — single owner: primary, always" (`:236`), "never a worktree, HIGH merge risk" (`:309`), all A6/A7/A8/P5 streams forbidden from `components/**` (`:552`). Verified at plan time: **(a)** `git status` shows `M components/dashboard/SpaceDashboard.tsx` — the Liquidity branch insertion is uncommitted in the primary working tree; **(b)** untracked `components/space/widgets/liquidity/` (3 files — roughly Liquidity S1–S3, no What Changed card yet); **(c)** `git worktree list` shows a second checkout `/Users/chrstn/dev/fm-investments` on branch `feature/investments-perspective` at `33c927e` (no commits yet, marked prunable) — the Investments redesign is staged to run in a worktree despite the matrix's "never a worktree" rule for `SpaceDashboard.tsx`, which **will** collide with this file if both proceed concurrently. Consequence: this Debt work must (1) start only after the Liquidity edits are committed, (2) run on the primary checkout, (3) insert its branch immediately after Liquidity's (`:3233`), and (4) re-verify `git status` + worktree freshness immediately before S1 (stop condition 3).

### 1.9 Tests and conventions

House pattern: standalone `tsx` scripts (`*.test.ts`) via `npm test` → `scripts/run-tests.ts`; colocated source-scan tests for compositions (`cashflow/CashFlowPerspective.test.ts` and the in-flight `liquidity/LiquidityPerspective.test.ts` are the templates). Must stay green and untouched: `lib/perspectives/virtual-sections.test.ts:81–92` (locks the exact Debt widgets[] list AND its liabilities-only doctrine), `lib/perspective-engine/debt.test.ts` / `debt.asof.test.ts` / `debt.mc1.test.ts`, `lib/accounts/credit-utilization.test.ts`, `lib/perspectives/envelope.test.ts`, `lib/debt.test.ts`/`lib/debt.golden.test.ts`. STATUS.md maintenance rule (`STATUS.md:10`) applies at close.

### 1.10 Requirement classification

| Requirement | Status |
|---|---|
| Shared shell owns preset/asOf/compareTo/evidence/completeness/tabs | **already landed** (Debt envelope already lens-driven, §1.6) |
| All seven Debt widgets | **already landed** — relocation + wrapper only |
| Multi-panel grid composition | **missing** — mirror the Liquidity/Cash Flow composition (new component, no new abstraction) |
| KPI strip (Total Debt / Est. Interest / Utilization / Min Payments) | **missing presentation; math landed** — the orphaned `renderDebtPayoffSnapshot` sums + `renderDebtCost` interest math + `creditUtilization` rows, restated in one pure helper |
| Lens verdict lede in the workspace | **missing presentation; logic landed & fetched** (`lensResults["debt"]` — the Liquidity lede pattern verbatim) |
| Payoff extra-payment scenarios + interest saved | **missing presentation; math landed** (exported `simulatePayoff`, `DebtPayoffSection.tsx:80`) — thin strip, planner internals untouched |
| Balance-over-time chart as dominant panel | **landed widget, thin presenter upgrade** (same snapshot series; adapter untouched; flat-hold documented §1.5) |
| Debt Health "reasons" checkmarks | **honest reduction only** — deterministic signals from landed classifications (§2); composite 300–850 *computed* score **not honestly buildable** (no scoring model exists anywhere; FICO is manual by doctrine) |
| Per-account "Change vs Jan 1" deltas | **deferred** — no per-account history reaches the client; server as-of is kill-switched + C4 flat-hold |
| Upcoming Payments (next 30 days) | **deferred** — `DebtProfile.dueDay` exists (`schema.prisma:891`) but is not in the Space accounts read path (§1.4); no recurring-payment model exists in the repo |
| Interest Cost Projection (next 12 months) | **deferred** — forward simulation; A11 Timeline is explicitly paused (audit `:255`, `:271`); `simulatePayoff` returns aggregate endpoints, not a monthly series |
| Avalanche/snowball strategy engine | **not built** — registry description is stale (§1.2); refused like the lens's amortization refusal |

---

## 2. Reference-to-repository mapping

| Mockup region | Fourth Meridian source | Fit / disposition |
|---|---|---|
| **Total Debt** KPI | Σ display-converted debt balances — the exact sum `renderDebtPayoffSnapshot:290–291` and the planner already compute | **Direct** (S2 KPI strip; same accounts array as every panel, §3.4). |
| **Total Interest Cost (Est.)** KPI | `renderDebtCost:139–151` math (Σ balance × APR ÷ 12 over rated debts) | **Adjusted honestly:** labeled "Est. interest **/ month**" (the only landed estimate); a lifetime/annual figure would require the deferred projection. Tile discloses "N debts without an APR excluded" (the widget's own footer rule). |
| **Debt Utilization** KPI | `creditUtilization` rows (`lib/accounts/credit-utilization.ts:51`) | **Adjusted honestly:** aggregate = Σ converted revolving balances ÷ Σ converted limits (conversion via `ctx`, mixed-currency ratios are dishonest otherwise); level-colored by the landed thresholds (`:37–42`). No limits on file ⇒ "—" + reason (never a fake 0%). |
| **Monthly Debt Payment** KPI | Σ minimum payments — `renderDebtPayoffSnapshot:294` / planner `:205–206` | **Direct**, labeled "Minimum payments / mo"; missing minimums disclosed. (The mockup's tile likely means actual payments — actual paid lives in Cash Flow's `debt_payments` widget by doctrine; the KPI links there in copy, not data.) |
| **Debt Balance Over Time** (dominant; Line/Area/Bar; All Time) | `debt_history` (SpaceSnapshot `totalDebt` series) | **Direct relocation (S1), presenter upgrade (S3):** full snapshot depth (lift the 24-point cap), larger chart, delta since series start, `isEstimated` points dimmed + one-line "estimated segment" note, `fxMiss` points dropped (the hero-chart guard, `types/index.ts:95–100`). The Line/Area/Bar toggle is cosmetic sugar — **not built** (one honest bar/area rendering; no chart library). Flat-hold on backfilled loan history is pre-existing and documented (§1.5). |
| **Debt Mix by Type** (donut) | none honest | **Omitted with reason:** `debtSubtype` is null for every Plaid-imported debt (`lib/snapshots/backfill.ts:50–52` documents this) and isn't even in the client `SpaceAccount`/`DebtPerspectiveAccount` types — a "type" donut would be one big "Unknown". A by-*account* donut would duplicate Debt by Account's bars (overengineering check §6 rejects a second chart over identical items). The mix read lives in Debt by Account's ranked shares. |
| **Debt Accounts** table (account/type/balance/change vs Jan 1/APR/payment) | `debt_by_account` | **Near-exact minus the historical column.** Bars already carry name, institution, balance, share, `% APR`, `/mo min` (`:102–112`). "Change vs Jan 1" is a per-account historical delta — **deferred** (no per-account history client-side; server as-of kill-switched + C4). |
| **Payoff Planner** (est. debt-free date; extra-payment scenario bars; total interest saved) | `debt_payoff_calculator` | **Direct relocation** — debt-free date, payoff month, and total interest at the chosen payment already exist (`DebtPayoffSection.tsx:226–228`, `:330–358`); the slider IS the extra-payment control. **S4 adds the scenario strip** — 2–3 preset scenarios (min-only / +$100 / +$250, computed via the exported `simulatePayoff`) with "interest saved vs minimums" = `simulatePayoff(total, rate, min).totalInterest − simulatePayoff(total, rate, min+extra).totalInterest`. Pure reuse; `DebtPayoffSection` internals untouched (shared with `DebtClient.tsx:696`). No avalanche/snowball (§1.2). |
| **Upcoming Payments** (next 30 days) | none reachable | **Deferred region — not built.** `DebtProfile.dueDay` exists in the DB (`schema.prisma:891`) but the Space accounts route never selects DebtProfile (`route.ts:55–67`; §1.4), and no recurring-payment/scheduling model exists anywhere in `lib/` (grep-verified). Exposing dueDay = backend + privacy-tier change; inferring payment schedules = A11 Timeline territory (paused, audit `:271`). Never fabricated. |
| **Interest Cost Projection** (next 12 months, bars) | none | **Deferred region — not built.** The only landed forward math is `simulatePayoff`'s aggregate endpoints (`{months, totalPaid, totalInterest}`); a per-month interest series requires new amortization-schedule simulation — exactly the projection work the audit assigns to the paused A11 Timeline (`:255`, `:271`). Multiplying today's monthly estimate ×12 would fabricate a declining-balance reality. `debt_cost` (present-state, per-debt) keeps the interest read. |
| **Debt Health Score** (300–850 gauge; reason checkmarks) | `credit_score` + landed classifications | **Split honestly.** The gauge slot is the REAL, manual FICO (`FicoCard`, genuine 300–850 bands) — clearly what it is, never computed. A composite *computed* debt score is **not honestly buildable**: no scoring/health model exists anywhere (checked `lib/perspective-engine/**`, `lib/ai/intelligence/annotations.ts` — candidates and urgency lines, no score), and inventing weights violates the "unknown is preferable to incorrect" doctrine — same treatment as Liquidity's coverage multiple. The checkmark *reasons* survive as **S4 Debt Signals**: deterministic rows from landed classifications ONLY — utilization level per `utilizationLevel` thresholds, "N debts missing APR/minimum" (the `debt_complete_info` gap logic), "promo rate ends <date>" (`lensResult.metrics promoEnds`), "minimums may not cover interest" (`simulatePayoff` returning null — the orphaned snapshot renderer's own copy, `:313`). No thresholds are invented; every signal cites landed math. |
| — (not in mockup) | `debt_complete_info` | **No mockup region — must remain mounted** (it is the workspace's data-quality affordance and the source of half the honesty disclosures). Placement: quiet, subdued panel at the grid's end (the EFR precedent). §1.4's save-visibility gap documented, unchanged. |
| — (not in mockup; Liquidity-proven) | `lensResults["debt"]` verdict | **New slim lede strip** (§3.5) — verdict sentence, `≈` when estimated, "as of" freshness, redaction count. Absent/empty/error ⇒ strip absent. No new fetch. |

Preservation proof: all seven mounted widgets appear exactly once in the target grid; `lib/perspectives.ts` widgets[] unchanged, so `virtual-sections.test.ts:81–92` keeps locking the inventory; `debt-perspective-adapters.tsx` / `debt-adapters.tsx` / `DebtPayoffSection.tsx` / `FicoCard` / `KnowledgeAcquisitionCard` / `BreakdownWidget` / `SummaryWidget` untouched; the DEBT GlassModal and `/dashboard/credit` untouched.

---

## 3. Exact implementation design

### 3.1 Approach — smallest honest implementation

One new composition mirroring the Liquidity mechanics (fourth local `Panel` helper, adapter renderers reused, 12-col grid, conditional lens lede); the seven widgets relocated unchanged; one KPI strip + one scenario strip + one signals list + one history presenter, all strictly over landed pure math; one bounded branch insertion in `SpaceDashboard.tsx`. **No registry/schema/grid engine, no chart library, no backend or `lib/**` changes of any kind, no engine/lens/envelope diffs, no time model.** The composition must contain **zero occurrences of `asOf`** — enforced by test (§7).

### 3.2 Files

**Add (all under `components/space/widgets/debt/`):**
- `DebtPerspective.tsx` — the composition: grid + local `Panel` helper (copied in mechanic from `liquidity/LiquidityPerspective.tsx:48–57`), the lens lede renderer (`:81–102` mechanic), and panel mounts. Owns only the planner's pass-through state if needed (§3.6); otherwise stateless.
- `debt-kpis.ts` + `debt-kpis.test.ts` — S2, pure: `computeDebtKpis(accounts, ctx)` → `{ totalDebt, estMonthlyInterest, ratedCount, unratedCount, utilizationPct|null, utilizationLevel|null, minPayments, missingMinCount, estimated }`. Math verbatim from `renderDebtPayoffSnapshot`/`renderDebtCost`/`creditUtilization` + the adapters' `inDisp` conversion-and-taint pattern (`debt-perspective-adapters.tsx:55–58`); aggregate utilization sums converted balances/limits.
- `DebtKpiStrip.tsx` — S2: four tiles (2-col on mobile, 4-col ≥sm), each with the honest dash-plus-reason state; `≈` prefix when `estimated`.
- `DebtHistoryPanel.tsx` — S3: presenter over the same host `Snapshot[]` — full series, `isEstimated` dimming, `fxMiss` drop, headline + delta. The registry's `renderDebtHistory` stays untouched as the generic-path renderer (LiquidityLadderTiers precedent).
- `payoff-scenarios.ts` + `payoff-scenarios.test.ts` + `PayoffScenarioStrip.tsx` — S4: pure `buildPayoffScenarios({total, monthlyRate, minPayment})` → rows of `{label, months|null, payoffDate, totalInterest|null, interestSavedVsMin|null}` via `simulatePayoff` (imported from `DebtPayoffSection`); strip renders beneath the planner inside the same panel. No minimums / no rates ⇒ strip absent (the planner's own disclaimers already cover it).
- `debt-signals.ts` + `debt-signals.test.ts` — S4: pure `buildDebtSignals({accounts, ctx, lensResult})` → typed rows (`ok`/`warn` tone + sentence) from the four landed sources named in §2. Rendered as a short list inside the Credit Health panel under `FicoCard`. Nothing derivable ⇒ empty list, no filler.
- `DebtPerspective.test.ts` — colocated source-scan test (§7).

**Modify:**
- `components/dashboard/SpaceDashboard.tsx` — ONE bounded change: insert an `activePerspectiveId === "debt"` branch between the `liquidity` branch (`:3221–3233`) and the generic fallback (`:3234`), rendering `<DebtPerspective accounts={accounts} ctx={widgetCtx} snapshots={snapshots} ficoScore={ficoScore} ficoUpdatedAt={ficoUpdatedAt} lensResult={lensResults?.["debt"] ?? null} />` (+ one import). **No fetch/guard changes** — `debtWorkspaceActive` already triggers the snapshot fetch (`:2619`, `:2755–2764`) and the lens batch is already fetched (`:2713–2735`). Nothing else in this file changes.

**Explicitly untouched:** `debt-perspective-adapters.tsx`, `debt-adapters.tsx`, `DebtPayoffSection.tsx` (beyond the already-`export`ed `simulatePayoff` — no new exports needed), `DebtClient.tsx`, `FicoCard.tsx`, `KnowledgeAcquisitionCard.tsx`, `BreakdownWidget.tsx`, `SummaryWidget.tsx`, `lib/accounts/credit-utilization.ts`, `lib/perspectives.ts` (widgets[] stays for inventory parity), `lib/perspectives/envelope.ts` (§1.6), `lib/perspective-engine/**`, `lib/data/**` (incl. `accounts-asof*`), `lib/snapshots/**`, `app/api/**` (incl. the §1.4 route gap — follow-up, not here), `usePerspectiveShellState.ts`, `PerspectiveShell.tsx`, all Wealth/Cash Flow/Liquidity/Investments/Goals files, the DEBT GlassModal path, Space navigation.

### 3.3 Grid structure

`DebtPerspective.tsx` root (mirrors `liquidity/LiquidityPerspective.tsx:136`):

```tsx
<div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch min-w-0">
  {/* ⓪ Lens lede — slim strip, rendered ONLY on lensResult?.status === "ok" */}
  {renderLede()}                                          {/* lg:col-span-12 */}
  {/* ① KPI strip (S2; S1 renders nothing here — grid stays valid) */}
  <div className="min-w-0 lg:col-span-12"><DebtKpiStrip …/></div>
  {/* ② Debt Balance Over Time — the visually dominant panel */}
  <div className="min-w-0 lg:col-span-7 xl:col-span-8">
    <Panel title="Debt Balance Over Time">…S1: renderDebtHistory / S3: <DebtHistoryPanel/>…</Panel>
  </div>
  {/* ③ Cost & risk column: Credit Utilization over Interest Cost */}
  <div className="min-w-0 lg:col-span-5 xl:col-span-4 flex flex-col gap-4">
    <Panel title="Credit Utilization"><CreditUtilizationWidget …/></Panel>
    <Panel title="Interest Cost">…renderDebtCost…</Panel>
  </div>
  {/* ④ Debt by Account */}
  <div className="min-w-0 lg:col-span-6 xl:col-span-7">
    <Panel title="Debt by Account">…renderDebtByAccount…</Panel>
  </div>
  {/* ⑤ Payoff Planner (+ S4 scenario strip inside the panel) */}
  <div className="min-w-0 lg:col-span-6 xl:col-span-5">
    <Panel title="Payoff Planner">…renderDebtPayoffCalculator… {/* S4: <PayoffScenarioStrip/> */}</Panel>
  </div>
  {/* ⑥ Credit Health: FicoCard + S4 Debt Signals rows */}
  <div className="min-w-0 lg:col-span-5 xl:col-span-4">
    <Panel title="Credit Health">…renderCreditScore… {/* S4: signals list */}</Panel>
  </div>
  {/* ⑦ Complete Debt Details — quiet data-quality affordance */}
  <div className="min-w-0 lg:col-span-7 xl:col-span-8">
    <Panel title="Complete Debt Details" subdued>…renderDebtCompleteInfo…</Panel>
  </div>
</div>
```

**Specs:**
- Desktop (`xl` ≥1280): lede 12 · KPI 12 · History 8 / cost-risk column 4 · By Account 7 / Payoff 5 · Credit Health 4 / Complete Details 8.
- Tablet (`lg` 1024–1279): lede 12 · KPI 12 · History 7 / column 5 · By Account 6 / Payoff 6 · Credit Health 5 / Details 7.
- Mobile (<1024): single column, source order = **Lede → KPI strip → Balance Over Time → Credit Utilization → Interest Cost → Debt by Account → Payoff Planner → Credit Health → Complete Details.** (Mockup hierarchy leads with the headline answer and the trend; the two mutating/editing panels close the stack.)
- KPI strip internal grid: `grid grid-cols-2 sm:grid-cols-4 gap-3` inside one Panel-less `GlassPanel` (tiles are not four separate section cards — one strip, mirroring the mockup's band).
- Heights/overflow: `items-stretch` + `h-full` panels, no fixed heights, no internal scroll, every child `min-w-0`, `gap-4` throughout — the Cash Flow/Liquidity contract verbatim.
- Empty Space (no debt accounts): the widgets' own empty states render ("No debt — Nothing owed in this Space — nice.", `debt-perspective-adapters.tsx:70–71`); the KPI strip shows the no-debt headline once instead of four dashes; lede absent unless the lens returns its real "No debt accounts in this Space" verdict (`debt.core.ts:201–211`) — which is an `ok` result and may render.

### 3.4 KPI strip content rules (honesty machinery)

- Figures come from `computeDebtKpis` over the **host `accounts` array** — the same rows every panel renders — never from the lens (§1.4: the lens may see DebtProfile-merged terms the client payload lacks; a strip sourced from the lens could contradict the bars directly beneath it).
- Total Debt: `Σ inDisp(balance)` over `type === "debt"`, bal > 0 (the adapters' own filter). Tone red; `≈` on conversion taint.
- Est. Interest: `Σ bal × APR/100/12` over rated rows; sub-caption `/ month`; meta "N without an APR excluded" when `unratedCount > 0`; all rows unrated ⇒ "—" + "Add APRs to estimate interest".
- Utilization: Σ converted balances ÷ Σ converted limits over rows with a positive limit; colored by `utilizationLevel` (landed thresholds); no limits ⇒ "—" + "No credit limits on file".
- Min Payments: `Σ inDisp(minimumPayment ?? 0)`; missing entries disclosed ("N without a minimum"); zero ⇒ "—" + "Add minimum payments".
- The strip renders **no payoff estimate** — that is the Payoff Planner's answer; one figure of record per fact (the Cash Flow "duplicate totals" rule).

### 3.5 Lens lede (presentation-only, landed data)

Mechanic copied from `liquidity/LiquidityPerspective.tsx:81–102`: renders ONLY on `lensResult?.status === "ok"` with a verdict; one slim GlassPanel row — `≈` prefix when `estimated`, verdict sentence, muted "as of <dataAsOf>" and "<N> account details withheld" (redactions). It does **not** render `headline`/`metrics` as tiles — the verdict prose already contains the total-debt figure, and §1.4 makes a second numeric authority actively dangerous here. If QA shows the lede's prose figure visibly disagreeing with the KPI strip on a DebtProfile-using Space, the lede is **dropped for that release** (absent, never "fixed" by recomputing the verdict client-side) — recorded as risk §5.

### 3.6 Payoff Planner mounting parity

In today's virtual-section path the planner renders through the solid-lede branch (`SpaceDashboard.tsx:1788–1800`), which exposes **no Expand/fullscreen affordance and no collapse** (those exist only on the non-lede path, `:1835–1842`, used by the legacy DEBT_PAYOFF sections). Parity therefore = embedded view only: the composition calls `renderDebtPayoffCalculator(accounts, false, undefined, ctx)`. The fullscreen mode stays reachable where it always was (DEBT_PAYOFF category sections, DebtClient). Do not add a new fullscreen trigger in this redesign.

### 3.7 Temporal-model statement (the constraint, restated as design)

Nothing changes. All panels are point-in-time except Balance Over Time, which reads the SAME host `snapshots` array it reads today (a snapshot read, not an account as-of read — §1.5). The shell's As Of / Compare To continue to have zero effect on this workspace; the envelope stays lens-provenance-driven with zero diff; the as-of machinery (`lenses/debt.ts` A5-P3 branch, `getAccountsAsOf`) remains landed, tested, kill-switched, and unconsumed by this UI until the C4 reconciliation initiative (audit §9 step 5). Any step that imports `getAccountsAsOf`, passes `asOf`, or computes a per-account historical delta is out of scope by definition (stop condition 1).

---

## 4. Slice plan (each independently compilable and shippable)

- **S1 — Layout shell + relocation.** `DebtPerspective.tsx` (Panel helper + lede + the seven widgets in the §3.3 grid; KPI row renders nothing yet), the `SpaceDashboard.tsx` branch. Functional parity checkpoint: every widget renders identically to the old stack — including the utilization add-limit flow, the complete-info save + refresh event, planner interactions, and all empty states.
- **S2 — KPI strip + lede polish.** `debt-kpis.ts` (+ test), `DebtKpiStrip.tsx`, mounted at row ①; lede copy/spacing finalized.
- **S3 — Balance Over Time presenter.** `DebtHistoryPanel.tsx`: full snapshot series, `isEstimated` dimming + note, `fxMiss` drop, headline/delta. Registry adapter untouched; flat-hold note in the panel's estimated-segment disclosure, not a wall of caveats.
- **S4 — Deterministic extras (two independent halves; cut either freely).** (a) `payoff-scenarios.ts` (+ test) + `PayoffScenarioStrip` inside the Payoff panel; (b) `debt-signals.ts` (+ test) + signal rows inside Credit Health.
- **S5 — Responsive audit + tests + STATUS.md.** lg/xl spans, 375px order, no horizontal overflow, long account names truncate; §7 suite green; lint/type clean; STATUS.md entry per the maintenance rule.

If S2–S4 prove contentious mid-flight, S1+S5 ship alone as a complete relocation slice (the grid is valid with seven panels and no KPI row); S3/S4 must never block S1.

---

## 5. Risks

- **`SpaceDashboard.tsx` merge risk (HIGH, currently ELEVATED):** single-owner file with an uncommitted Liquidity diff in the tree AND a live Investments worktree/branch staged against the same file (§1.8). Mitigation: hard-gate S1 on the Liquidity edits being committed; primary checkout only; one ~15-line additive branch; land S1 promptly; re-verify `git status`/worktrees/STATUS.md immediately before starting (stop condition 3).
- **asOf scope creep:** "Change vs Jan 1", 12-month projection, and upcoming payments all invite "just a small read/heuristic". Every one is deferred by decision with a recorded reason (§2). The source-scan test makes it mechanical (no `asOf`, no `accounts-asof`, no `getAccountsAsOf` strings).
- **Duplicate/contradicting figures (the defining Debt risk, §1.4):** lens (server, DebtProfile-merged, estimated-minimum synthesis) vs client widgets (flat columns). Mitigations: KPI strip computes from the client array only; lede is prose-only; drop-the-lede fallback (§3.5); never recompute the verdict client-side; never "fix" by fetching DebtProfile from the composition.
- **`debt_complete_info` save-visibility gap (pre-existing):** an APR saved in the Space workspace lands in DebtProfile and may not clear the widget's own gap list (§1.4). Documented, unchanged; the named follow-up (§6) is a one-route additive merge, out of scope here. Do not paper over it with client-side optimistic state.
- **Snapshot flat-hold on backfilled loan history (pre-existing, §1.5):** carried with the widget; S3's estimated-segment dimming is the honest treatment. Never labeled as reconstructed *loan* truth.
- **Scenario-strip math drift:** the strip must call the SAME `simulatePayoff` with the SAME blended-rate inputs the planner derives, or the two will disagree inside one panel. The pure helper takes `{total, monthlyRate, minPayment}` as inputs (computed once, passed to both) rather than re-deriving.
- **KPI strip on mixed currencies:** aggregate utilization and sums must convert before ratio/summation; taint propagates to `≈` (the planner's `est` pattern, `DebtPayoffSection.tsx:208–211`).
- **Empty/sparse states:** no-debt Spaces, all-unrated debts, no-limit debts, <2 snapshots — each tile/panel has a designed honest state (§3.3/§3.4); verify explicitly in S5.
- **Signals overreach:** `debt-signals.ts` may only emit the four landed-source rows (§2). Any "score", weighting, or new threshold is out (stop condition 4).

## 6. Overengineering check

Confirmed feasible as: **one new composition + one KPI strip + one history presenter + two pure helpers with thin renders + one host branch.** Rejected: widget registry/schema extension, shared Panel/grid abstraction (fourth local copy is fine; extraction still unearned), any chart library, an avalanche/snowball sequencing engine, a computed debt-health score, per-account history/delta machinery, forward interest projection, upcoming-payments scheduling, envelope/lens/engine diffs, client DebtProfile fetches, a second donut over Debt by Account's items. **Named follow-ups (explicitly NOT built now):** (a) additive DebtProfile merge in `GET /api/spaces/[id]/accounts` (fixes §1.4 for FULL rows; needs its own KD-19 privacy review); (b) Debt historical activation = audit §9 step 5 (thread `asOf`, reconcile C4, envelope from lens completeness); (c) registry description fix for `debt_payoff_calculator` (stale avalanche/snowball copy) — one-line docs change, bundled with (a) or any registry-owning slice, not with this UI diff.

## 7. Testing expectations (house pattern: standalone tsx `*.test.ts` via `scripts/run-tests.ts`)

`components/space/widgets/debt/DebtPerspective.test.ts` (source-scan; template: `liquidity/LiquidityPerspective.test.ts`):
1. All seven renderers/components mounted exactly once: `renderDebtByAccount(`, `renderDebtCost(`, `CreditUtilizationWidget`, history (adapter or `DebtHistoryPanel`), `renderDebtPayoffCalculator(`, `renderCreditScore(`, `renderDebtCompleteInfo(`; no duplicate mounts.
2. Grid contract: `lg:grid-cols-12`, `items-stretch`, the §3.3 span pairs, `min-w-0` on every child, no `h-[`/`max-h-[`.
3. Source order = mobile stacking order (lede → KPI → history → utilization → cost → by-account → payoff → credit health → details).
4. **Current-state lock:** source contains no `asOf`, no `accounts-asof`, no `getAccountsAsOf`, no `usePerspectiveShellState`, no import from `wealth/`, `cashflow/`, or `liquidity/` component folders.
5. Planner parity: the composition passes `false`/`undefined` for fullscreen (no new fullscreen trigger — §3.6).
6. `SpaceDashboard` scan: the `debt` branch exists once, precedes the generic virtual-sections branch, and passes `accounts`, `ctx`, `snapshots`, `ficoScore`, `ficoUpdatedAt`, `lensResult`.

Pure-model tests: `debt-kpis.test.ts` (sums/utilization/level mapping vs fixtures incl. mixed-currency taint ⇒ `estimated`, all-unrated ⇒ null interest, no-limit ⇒ null utilization); `payoff-scenarios.test.ts` (rows agree with direct `simulatePayoff` calls; interest-saved arithmetic; payment ≤ interest ⇒ null months honest row; no-minimum ⇒ empty); `debt-signals.test.ts` (each of the four sources emits/withholds correctly; empty in, empty out). Untouched and green: `lib/perspectives/virtual-sections.test.ts:81–92`, all `lib/perspective-engine/debt*.test.ts`, `lib/accounts/credit-utilization.test.ts`, `lib/perspectives/envelope.test.ts`, `lib/debt*.test.ts`, all wealth/cashflow/liquidity tests. No diffs outside §3.2's list (assert via `git diff --name-only` in the gate).

## 8. Validation gate (run in order; all must pass)

```bash
npx tsc --noEmit
npx eslint
npm test                       # scripts/run-tests.ts — all *.test.ts under lib/ app/ components/
git diff --name-only           # must contain ONLY the files listed in §3.2
npm run dev                    # manual pass: desktop xl, ~1100px lg, 375px mobile;
                               # parity of all seven widgets vs the old stack (incl. empty states);
                               # add-limit inline save + refresh; complete-info save (gap-persistence
                               #   behavior documented §1.4 — verify it is UNCHANGED, not regressed);
                               # planner: chips/slider/freq/date/breakdown identical; NO Expand button;
                               # KPI strip agrees with the panels beneath it on the same Space;
                               # lede present only on ok lensResult (kill the fetch to verify absence);
                               # As Of / Compare To changes have ZERO effect on this workspace;
                               # history panel dims estimated segment; no horizontal overflow anywhere
```

## 9. Stop conditions — halt and report instead of proceeding if:

1. Any panel turns out to require `asOf`/`compareTo`/historical **account** reads, `getAccountsAsOf`, per-account deltas, or forward projection — all deferred by decision (§2); do not build a "small" exception. (The snapshot-series read in Balance Over Time is the one sanctioned history source, unchanged.)
2. Implementation would require touching `lib/perspective-engine/**`, `lib/perspectives/envelope.ts`, `lib/data/**`, `lib/snapshots/**`, any `app/api/**` route, `DebtPayoffSection.tsx`/`debt-*adapters.tsx` internals, or replacing/deleting any of the seven mounted widgets.
3. `SpaceDashboard.tsx` is dirty with someone else's edits, the Liquidity redesign is still uncommitted, or the `feature/investments-perspective` worktree has advanced onto this file — check `git status`, `git worktree list`, and STATUS.md immediately before S1 (all three hazards were live at plan time, §1.8).
4. A mockup region cannot be mapped without fabricating data — a computed 300–850 debt score, a type-mix donut over null subtypes, a 12-month interest series, upcoming-payment dates, or "change vs Jan 1" are ALREADY declared omitted/deferred; do not attempt them.
5. Scope drifts beyond Debt presentation (any diff in Wealth/Cash Flow/Liquidity/Investments/Goals widgets, the DEBT GlassModal, `/dashboard/credit`, Space navigation, the shell time model, or the lens fetch contract).

---

**Final instruction to the implementation session:** the attached mockup is a layout and hierarchy reference, not a data spec — its projective regions (upcoming payments, 12-month interest, per-account deltas) and its invented score are explicitly deferred or reduced above. Relocate the seven landed widgets; build the KPI strip, scenarios, and signals ONLY from the landed pure math cited (`renderDebtPayoffSnapshot` sums, `renderDebtCost` interest, `creditUtilization`, `simulatePayoff`, the fetched lens verdict); keep the workspace current-state-only (the as-of machinery stays kill-switched and unconsumed); keep the `SpaceDashboard.tsx` footprint to the single documented branch; and when the client and the lens disagree on a number, trust the panels, shrink the lede, and never invent a reconciliation. When in doubt, prefer the smaller change and the Liquidity precedent.
