# Platform Operations 2.0 — redesign plan (owner feedback on PR #132)

| | |
|---|---|
| **Status** | PLAN + implementation tracker. Preview only; owner visual acceptance per workspace and for the navigation. Production untouched. |
| **Baseline** | develop after #132 (`f118de9`). #132 is navigation/composition only and is **not visually accepted**. |
| **Scope** | (1) Platform-wide navigation: exactly **Overview · AI · Current Space**. (2) Presentation redesign of **all four** Platform Operations workspaces. (3) Reusable Platform presentation primitives for the later redesign of the other Spaces (not redesigned now). |
| **Non-goals** | No change to routes' authority, guards, readers, audit, operator 2FA, kill switch, fleet CONTROL + reason, fail-closed policy logic, crypto-history surfaces' behaviour ([C1]). No fabricated metrics. No policy editing (Phase 2). |

## 1. Audit of #132 on Preview (operator session, 1280 px wide, measured)

| View | Page height | What dominates | Verdict |
|---|---|---|---|
| Operations › Overview | **9,507 px**, 100 buttons | `ops_overview` alone **7,085 px** (11 stacked blocks), then health 783, convergence 500, timeline 524 | relocated, not redesigned |
| Operations › Jobs | 3,008 px, 50 buttons | job health table 1,034, manual operations 729 (every fleet command visible), scheduler 579 | relocated |
| Operations › Pipeline | long execution table + summary + health + coverage | raw rows by default | relocated |
| Providers › Health | 1,604 px | provider health 749 (full diagnostic per provider) | relocated |
| Providers › Connections | diagnostics table (50 rows) + cleanup | raw rows | relocated ([C1] panel inside) |
| AI & Costs › AI | 3,850 px | invocations 1,114, Brief ops 946, budget 780, trend 612 | relocated |
| Policies › Platform defaults | one long settings form (cadence, job cadence, AI controls) | a card per setting | relocated |
| Policies › Policy groups | read-only table | acceptable content, needs summary/detail shape | partially new |

Root cause: every widget renders its **entire dataset** by default, with its own header, footnotes and actions; workspaces stack them.

## 2. Navigation model

**Three global Platform destinations** (mobile bottom bar = exactly these; desktop rail top = the same three):

| Destination | Route | Content |
|---|---|---|
| **Overview** | `/dashboard/platform` | Platform-wide command center across every Space the operator holds (per-area cards stay grant-gated; no cross-area route) |
| **AI** | `/dashboard/platform/ai` (new page) | Honest "coming soon" shell in the Personal AI visual language: no conversation, no fake answers, no working input; states the planned read-only Platform intelligence and that actions will require explicit authorisation |
| **Current Space** | `/dashboard/platform/<AREA>` (the selected Space) | Label = the Space's real name (e.g. "Platform Operations"); inside it, the contextual workspaces (Operations · Providers · AI & Costs · Policies for Platform Operations) |

- **Current Space selection:** the last visited granted area, remembered in a first-party cookie `fm_platform_space` (an area enum, no identity) so SSR renders the right label; default = first granted area. A Space switcher (title dropdown on mobile, list in the desktop rail) changes it; the three destinations never change.
- Deep links (`/dashboard/platform/<AREA>?workspace=&view=`), Back/Forward and all aliases keep working. Every page stays behind the shared guard; ungranted areas never appear.
- Personal navigation untouched (`personal-nav-baseline.json` byte-identical).

## 3. Shared Platform presentation primitives (one set, reused everywhere)

`components/platform/ui/` — built on existing Atlas tokens/components (Surface, SegmentedControl, RightPanel, ConfirmDialog, MiniBars/TrendChart), not a second design system:

| Primitive | Purpose |
|---|---|
| `StatusHeader` | one line of verdict (Healthy / Degraded / Incident) + last checked + 3–4 compact facts |
| `KpiTile` | value · change vs prior period · tiny trend (only from a persisted series) · provenance chip |
| `AttentionQueue` | top 3–5 prioritised exceptions (severity dot + word, one-line why, one next action) + "View all (n)" |
| `EntityRow` / `EntityList` | compact row: name, status, 1–2 metrics, chevron → detail; becomes a card below md |
| `DetailDrawer` | RightPanel (desktop) / sheet (mobile) hosting full detail — where today's full widgets live |
| `ProvenanceChip` | MEASURED · ESTIMATED · ASSUMED · UNKNOWN, + freshness ("as of 14:02") |
| `ControlledActionSurface` | deliberate actions: listed, authority-labelled, opened into ConfirmDialog with reason; never casual buttons |
| `HistoryList` | compact audit/history rows with "View full history" |
| `WorkspaceNav` | the workspace + view switcher (desktop tabs / mobile segmented) |

Rules: default sections show 3–5 items; one provenance chip per surface; no explanatory paragraphs on the primary surface (move to an info tooltip/disclosure); no card per setting.

## 4. Screen-by-screen

### 4.1 Overview (global)
Desktop (2-column): left = `StatusHeader` + `AttentionQueue` (merged per-area top items, each fetched from its own area route); right = per-Space KPI tiles with 14-day trends (existing V1/V2 series). Mobile: header → attention (3) → horizontally swipeable KPI tiles. ≤ 1 screen on desktop.

### 4.2 Platform Operations › Operations
Default (≤ ~1.5 screens desktop):
- **StatusHeader:** overall verdict from `po/overview` (pipeline, sources, jobs, Brief, AI, Plaid), last checked, open incidents (convergence count), job success 24 h.
- **AttentionQueue** (`po/attention`): top 5 + "View all" drawer (full Attention list with its resync/reauth actions).
- **Jobs & activity:** KPI row (runs 24 h, failed, overdue, pending) + 5 most recent executions as `EntityRow`s → drawer with full job table, scheduler, history series, execution timeline panel.
- **Manual operations:** `ControlledActionSurface` — collapsed entry "Run an operation…" → drawer listing commands; fleet commands keep CONTROL + reason + confirm + pre-run audit (#131). Nothing runs from the dashboard.
- Moves to drawers/detail: full JobsMatrix, OpsJobHealth table, scheduler notes, history, convergence + timeline (→ "Incidents" drawer), refresh executions/coverage (→ "Pipeline" detail view, kept as a view but redesigned to KPI + top failures + paginated table).

### 4.3 Platform Operations › Providers
Default: one `EntityRow` per provider (Plaid, OpenAI, Alchemy, Esplora, CoinGecko, OXR/FX, Resend, …) — status word+dot, usage today vs **known** allowance (or "allowance unknown"), recent errors/rate-limits, spend with provenance (estimated / unknown), chevron. Desktop: list left, selected provider detail right (master–detail); mobile: list → full-screen detail.
Provider detail: usage over time (only persisted series), remaining budget (only where a cap is configured), errors, pricing/cost with provenance, related connection health, technical diagnostics (provider operations, freshness, cleanup, email delivery for Resend), history. **Connection diagnostics + History recovery [C1]** live in Plaid/wallet providers' detail as-is (restyled host only).

### 4.4 Platform Operations › AI & Costs
Default: KPI row — AI spend 30 d (ESTIMATED from tokens × rate card; never "billed"), budget remaining (allowance controls), calls & error rate 24 h/7 d, Plaid Item-months (ESTIMATED); usage trend chart (existing `ai-usage-trend`); "Top drivers" list (by surface/model, top 5). Secondary views (segmented): Consumption (model/feature), Customers & policy groups (where telemetry supports; CS rollup aiEstimatedUsd30d), Allowances & limits, Provider costs. Placeholder slot "Economics (Phase 3)" stated honestly, no numbers. Brief ops → detail drawer from the Brief driver row.

### 4.5 Platform Operations › Policies
Default: **policy-group summaries** as compact cards (one per defined group/overlay: name, customers assigned, key limits vs ceiling, "read-only" chip) + unassigned/unknown banner (fail-closed exposure). Selecting a group → focused detail (Capabilities · Limits & refresh · AI allowance · Assignments (counts) · Version history placeholder "arrives with the policy engine") — read-only. Secondary destinations (segmented): **Platform defaults** (grouped controls: Refresh cadence · Job cadence · AI allowance & cost controls — each group a compact summary row; editing opens the existing editor in a drawer with its CONTROL gating, reason and confirmation), **Alerts** (rules as rows + recent deliveries), **Emergency controls** (maintenance mode, AI kill switch summary, Plaid webhook — danger-zone styling, each behind its existing confirm + reason). Economics questions (cost per customer, typical/heavy, price → margin, 2× usage) get a reserved "Economics" tab in the group detail, labelled Phase 3.

## 5. Responsive rules
375–430: no horizontal overflow; header + attention fit the first screen; lists are cards; drawers are full-height sheets; actions in sheet footers. 768: two-column where the content pairs (KPI grid 2×). 1280/1440: master–detail and 12-column grids, max content width 1280.

## 6. Delivery (Preview only)

| PR | Content |
|---|---|
| **R1** | primitives + three-destination nav (mobile bar, desktop rail, Space switcher, cookie) + Platform AI placeholder + Overview command center |
| **R2** | Operations + Providers redesign |
| **R3** | AI & Costs + Policies redesign |

Each: full typecheck, Platform/UI/Space/auth suites, required audits, CI, independent review, Preview screenshots at 375/390/430/768/1280/1440, owner visual acceptance requested per workspace and for navigation.
