# Platform Operations — visual specification (after owner rejection of R1/R2)

| | |
|---|---|
| **Status** | SPEC + data audit. One representative workspace (**Operations, incl. unified Jobs**) is built first, screenshotted at 390 and 1280, compared against Personal Space and iterated; only then are Providers, AI & Costs and Policies rebuilt with the accepted patterns. Preview only. |
| **Supersedes** | the presentation parts of `PLATFORM-OPS-2.0-REDESIGN-PLAN-2026-10-30.md` (navigation model and primitives stay). R1 (#134) and R2 (#135) are on develop but **not visually accepted**; R3 was stopped (WIP, unpushed). |
| **Owner standard** | Personal Space quality: symmetry, hierarchy, compactness, real charts; analytics first, text last; current + actionable first; history/diagnostics/raw metadata in focused detail. |

## 1. Visual system = Personal Space's, reused (no new language)

| Need | Personal Space component (reuse) |
|---|---|
| Hero number + change | `CompactHeroCard` (fixed five-row hero) / `Figure` + `Delta` (`components/atlas/Surface.tsx`) |
| KPI row | `CompactKpiStrip` |
| Trend over time (line/area, tooltip, measured width) | `TrendChart` (`components/space/widgets/charts/TrendChart.tsx`) |
| Composition (donut / bar / list) | `BreakdownWidget` (donut with hover/tap + list) |
| Day grid | `CalendarHeatmapGrid` |
| Surfaces / section labels | `Surface`, `Block` (Atlas) |
| Bars for daily volume | `MiniBars` (Platform) restyled to the TrendChart palette |

Layout grammar (as Personal Space): 12-column grid at `lg`, cards in symmetric pairs (6/6 or 7/5), one section label per card (10–11 px uppercase), one figure, one chart, ≤ 1 line of caption. Mobile: hero card → 2-up KPI strip → one chart card per row → compact list (3 rows) → "See all". **One** navigation row at the top of Current Space (workspace tabs; the view switcher folds into it as a second-level segmented control only where a workspace has views).

## 2. Data audit (Preview, 2026-10-30, operator session — evidence, not guesses)

| Finding | Evidence | Treatment |
|---|---|---|
| **Scheduler not active on Preview** | scheduler: `externalCrons: []`, 1 recorded execution in window; 12/14 jobs "never-ran", 2 "dead" (`evaluate-alerts` last start 10-07, `sol-history-backfill` last start 10-28 = manual) | Vercel crons fire only on Production. State per job = **"No scheduled execution observed"** + deployment note "no scheduler wake on this deployment"; never "dead" or "never ran" without evidence of a wake. A real failure (failed run) still shows as **Failed**. |
| "never-ran" wording | job-health status | Show **"No execution recorded in window"**; "Never ran" only if `totalRuns === 0` over full history. |
| Duplicate incident across Ops attention + CS | R1 review | Fixed in R1 (CS row wins). |
| 22 attention items, many from the inactive scheduler | attention counts | Group by cause: one "Scheduler not active on this deployment" item instead of N job items when the cause is shared. |
| Historical events as current | convergence/timeline | Default screens show **current** state; history only in detail. |
| Technical metadata by default | registry paths, idempotency/lock notes, authority names | Moved to job detail "Technical" disclosure or docs. |

**Issue lifecycle.** States: **active · acknowledged · resolved · superseded · historical · unknown.** Derivable today without schema: active (current evidence), resolved (recovery recorded), superseded (a newer state of the same subject), historical (older than window, no current evidence), unknown (no observation). **Acknowledged needs a minimal extension** (proposed, not built here): `IncidentAcknowledgement { subjectKey, acknowledgedById, reason, at, expiresAt }` — additive, audited, CONTROL-free (WRITE).

## 3. Job registry ↔ manual operations (mapping)

| Scheduled job (14) | Manual handler | Run Now / Dry Run | Authority |
|---|---|---|---|
| fetch-fx-rates, fetch-security-prices, evaluate-alerts | yes (`runJob`, same body) | both | WRITE |
| sync-banks, sync-crypto, sol-history-backfill | yes (fleet) | both | Run: **CONTROL + reason + pre-run audit**; Dry: WRITE |
| process-deletions | excluded — destructive, automatic-only | none | — |
| purge-trash, notification-cleanup, notification-retry, rate-limit-sweep | excluded (reason recorded) | none | — |
| plaid-removal-retry, product-event-retention, sync-crypto-continuation | **not mapped, no recorded reason** (genuine gap) | none — UI says "Not available for manual run" | — |

One canonical row per job; no second list. No new endpoint is invented for unmapped jobs.

## 4. Operations workspace (representative) — screen spec

**Desktop 1280 (12-col):**
1. Row A (12): **Health hero** — verdict word + dot, "checked 05:31", 4 KPIs: Jobs healthy x/14 · Needs attention n · Executions 24 h · Success rate 7 d (from job-health) — each with prior-period delta where the data has it.
2. Row B: **Execution trend** (7/12) — TrendChart/bars: executions per day, stacked succeeded/failed (from history series, real points only; gaps where none) | **Outcome composition** (5/12) — donut: succeeded / failed / manual / no execution (from job-health counts).
3. Row C: **Needs attention** (6/12) — top 3 grouped exceptions, severity dot + one line + one action | **Refresh activity** (6/12) — 14-day bars from refresh/daily with failure overlay.
4. Row D: **Jobs** (12) — the unified list, 5 rows visible (worst first), searchable "See all 14": name (human label) · status word+dot · cadence · last run · next expected (labelled *expected*) · 7-day sparkline · Run ▸ (if supported). Row click → **Job detail** (RightPanel): status, schedule, execution history chart + table, failures, technical disclosure, and controls (Dry run · Run now — fleet: CONTROL + reason + confirm via the existing operations endpoint).
5. Recent activity: 3 condensed rows → "Activity" detail.

**Mobile 390:** hero card (verdict + 2×2 KPIs) → execution trend card → needs attention (3) → jobs (3 rows + See all) → Run operation entry. No paragraph on the first screen; one tab row.

## 5. Other workspaces (after Operations is accepted)

- **Providers:** health distribution donut; provider tiles grid (status, usage today vs known cap or "cap unknown", failures 7 d sparkline, spend chip ESTIMATED/UNKNOWN); sync success/failure trend; provider detail page with usage chart, errors, cost provenance, diagnostics (hosted).
- **AI & Costs:** spend hero (ESTIMATED vs billed UNKNOWN), daily/weekly/monthly spend trend, tokens + invocations trend, cost by feature (donut), cost by provider (bars), budget utilisation meter, customer/policy-group cost (where telemetry supports), Economics (Phase 3) slot.
- **Policies:** group overview cards, customer distribution donut, entitlement comparison matrix (groups × categories, plain English), editor (Phase 2: toggles, numeric steppers with ceilings, effective preview, change review, audit, versions), cost-model slot.

## 6. Acceptance loop
Build Operations → Preview → screenshots (desktop from the operator session; 390 via a deterministic render of the same components with the live response shapes, plus DOM checks of the real page at 390) → compare against Personal Space (hero, KPI strip, chart cards) → iterate → owner review → roll out.
