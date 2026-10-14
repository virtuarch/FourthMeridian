# PLATFORM SPACES UX REFINEMENT — PHASE 1
## Repository investigation, design plan and implementation estimate

**Date:** 2026-10-14 · **Branch:** v2.6 · **HEAD:** dd39087 (docs-only on top of the P1 candidate 83bb03e) · **Mode:** investigation only — no file in the repository was modified, nothing was committed, deployed, migrated or granted.

**Working tree at start:** clean apart from seven untracked docs (`docs/audits/status-drift/*.md`, `docs/operations/production-cutover-plan.md`). One worktree, no peer `fm-ci-*` / dev-server / test processes, one stale stash from another branch (`feature/phase-2-architecture`, untouched). 48 commits have touched `components/platform`, `lib/platform` or `app/api/platform` since the July visualization investigation, so every finding below was re-verified against HEAD rather than inherited.

**Evidence tiers used:** **VERIFIED** = read in source at dd39087 or observed on Preview (preview-app.fourthmeridian.com, logged-in session, Platform Operations / Customer Success / Spaces / My Space screenshots taken 2026-10-14) · **PROPOSED** = design recommendation · **INFERRED** = plausible, not confirmed by code or runtime · **DECISION** = requires the owner.

---

## 1. Executive assessment

1. **Navigation parity is already roughly 80 % built, and the remaining 20 % is small (VERIFIED).** Platform workspaces are universal `WorkspaceDefinition`s in the one `WORKSPACE_REGISTRY`, rendered through the shared `SpaceShell` with the same Atlas `SegmentedControl` rail personal Spaces use, and the five Platform Spaces are already listed in two places: the sidebar's `PlatformNav` block ("Platform" eyebrow, grant-filtered, one `/api/spaces` fetch) and the Spaces page's "Fourth Meridian HQ" card group. What is missing is (a) URL authority for the active platform workspace — it is plain `useState`, so there is no deep link, no Back/Forward and a refresh returns to Overview (observed on Preview: the URL never changed while switching Overview → Pipeline → Policies); (b) the platform workspaces are never published to the sidebar's workspace channel, so inside a Platform Space the sidebar shows section anchors while a personal Space shows its workspace tree; (c) the five Spaces are listed in DB order, not registry order; (d) the Platform group is absent from the sidebar while inside a personal Space and on mobile — by a recorded design decision, not by accident. The smallest maintainable change is two existing seams reused (`useSpaceUrl` and `useSpaceWorkspaceNavPublisher`), plus one `orderBy`. No second navigation framework is needed.

2. **The Overview's problem is confirmed and measurable (VERIFIED).** The Overview workspace is two surfaces (`ops_overview`, `ops_platform_health`) plus a seven-card "Explore" grid. Before the first entity row an operator reads 6 headline sentences, 33 label/value pairs, 12 authority "basis" strings each shown twice, a policy strip, two clocks, two multi-sentence footnotes, and provenance chips that are literal implementation paths (`lib/alerts`, `lib/platform/provider-health`, `lib/platform/resource-freshness`, `lib/env`, `RateLimit table`). The Overview uses no `Figure`/`BigStat`/`WidgetStat` at all — every number is `text-xs`. Three overlapping navigation affordances (six "Open" buttons, four group doorways, seven Explore cards) point at seven rail targets. The same question is answered twice in different vocabularies (Overview "Sources" vs Health "Providers"; pipeline last-success vs Freshness). The only tabular element is an unlabelled failure list — the opposite of the Pipeline table the owner likes.

3. **Most of what the owner wants to see already has an authority; little new truth is required (VERIFIED, §6).** Of the nine proposed visualizations, four are EXISTS (status verdicts, jobs matrix, AI activity, economics), four are PARTIAL with narrow, additive work (attention table, connection drill-down, refresh activity series, provider table), and one needs an area ruling rather than code (recent operator activity, which is SECURITY_OPS-gated today). Zero schema migrations are required. Genuine absences to state on-surface, never paper over: there is no alert open/resolved ledger (alerts are fire-and-forget records inside `evaluate-alerts` job summaries); customer-facing cooldown refusals write no row; provider health has authorities for Plaid and Open Exchange Rates only; dispatcher ticks are unobservable; there is no actual-charges ledger, only estimates with provenance.

4. **Pipeline is the right reference, and it is the house pattern, not a component (VERIFIED).** The Pipeline table is the "CSS-grid row idiom" also used by Jobs: one `SectionSurface`, a header row and rows sharing one `gridTemplateColumns`, `TwoLine` cells (fact over qualifier), a dedicated status column of dot+word in one of five tones, tabular numerals, pill filters that change the server query, click-to-inspect in a `RightPanel` drawer, one footnote. The July design study for this workspace shipped almost verbatim, which is why it reads well. The doctrine recorded in the repository is to reuse the shape and discipline, not to extract a generic `<DataTable>`; this investigation follows that.

5. **Recommended first iteration:** one coordinator plus four implementation agents (three is workable, five adds little), landing a redesigned Overview (status board, Attention Required, connection table with authorized owner resolution, compact jobs matrix, refresh/AI activity strips, recent activity), navigation parity, a reorganized Policies workspace, light Pipeline polish, and three shared primitives. Calibrated against P1 (five workstreams landed in roughly two working days plus Preview proof), the realistic window is **3–4 working days to a Preview-verified candidate**, with two owner visual-review rounds inside that, and about 1.5 days best case / 6 days conservative. Thirteen owner decisions are listed in §15; six of them block coding.

---

## 2. Existing navigation architecture (VERIFIED)

### 2.1 Shared chrome
- `components/ui/DashboardChrome.tsx:67-106` — one frame for every `/dashboard/*` route: `SpaceChromeProvider > GlobalHeader > [ContextualNavbar | main] > BottomNav`. Header centre is deliberately empty (`GlobalHeader.tsx:14-17`); no nav lives there.
- `components/ui/ContextualNavbar.tsx:236-251` — `<aside class="hidden w-[212px] lg:block">`, mode switch `space ? SpaceMode : GlobalMode`.
  - `PrimaryNav` (`:317-372`) renders `PRIMARY_NAV` in both modes. `PRIMARY_NAV` (`lib/space-nav.ts:105-111`) = Brief · My Space · AI · Spaces · Connections; pinned to exactly five entries by four tests. **No Platform entry, by pin.**
  - `GlobalMode` (`:376-386`) = PrimaryNav + `PlatformNav` (when granted).
  - `SpaceMode` (`:574-688`) = PrimaryNav → Space block (SpaceControls, identity, `SpaceWorkspaceNav`) → `SectionsNav` **only on the platform axis** → `PlatformNav` **only on the platform axis** → Leave Space.
  - `PlatformNav` (`:178-226`) — `<nav aria-label="Platform">`, eyebrow "Platform", `Link` per granted area to `/dashboard/platform/<area>`, `aria-current` on exact pathname. Fed by `usePlatformDestinations` (`:126-170`) = one fetch of `/api/spaces` → `data.platform`.
  - `SpaceWorkspaceNav` (`:416-499`) — `<nav aria-label="Space">`, real `<a href>` per workspace, nested children; icons keyed by finance lens ids (`:93-97`).
- `components/ui/BottomNav.tsx:39-104` — `PRIMARY_NAV` only, `lg:hidden`. No Platform, no workspaces.
- `lib/space/space-chrome-context.tsx:117-133` — four publish channels: `space`, `currencyControl`, `workspaceNav`, `sections`.

### 2.2 Personal (finance) Space
- Host `components/dashboard/SpaceDashboard.tsx`: rail (`:212-213`) = Overview · Activity · Accounts · Transactions · Members; lenses Net Worth / Cash Flow / Markets published to the sidebar (`:393-426`) via `useSpaceWorkspaceNavPublisher`; `<PerspectiveShell tabsVisibility="belowLg">` (`:839-866`) makes the in-content lens row a `<lg`-only switcher. Observed on Preview: tablist "Space section" (5 tabs) above the title, radiogroup "Perspectives" in the sidebar with nested Total/Assets/Debt.
- URL authority: `components/space/shell/useSpaceUrl.ts:58-95` is the ONE history writer and popstate dispatcher; `lib/space/use-space-navigation.ts:285-303` declares intent (workspace/rail = PUSH, view = REPLACE); `lib/space/space-url.ts:20-30` lists the params (tab, perspective, metric, view, asof, compareto, preset, account, transaction). There is no `?workspace=` param today.
- Switching between personal Spaces: Spaces page → `POST /api/space/switch` → `router.push("/dashboard")` (`SpacesClient.tsx:1040-1055`). No Space-switcher primitive exists anywhere.

### 2.3 Platform Space
- Only route `app/(shell)/dashboard/platform/[area]/page.tsx:100-152`, grant-gated, builds `platformMountContext(...)` **without `selectedKey`** (`:157-164`) so the mount always selects `platform-overview` (`mount-context.server.ts:52,147`; the resolver already accepts a requested key at `:130-132`).
- Host `components/platform/PlatformSpaceDashboard.tsx`: `activeTab` is `useState` (`:348-350`); rail from `mountContext.workspaces.available` (`:362-365`); publishes identity (`:373-381`) and sections (`:388-396`) but **never** `useSpaceWorkspaceNavPublisher`; doorways call the same setter (`:246-268`). `mobileOptimized` is not passed to `SpaceShell` (`:399-409`).
- Composition `lib/platform/workspaces.ts:118-171`: PLATFORM_OPS = Overview · Jobs · Policies · Pipeline · Providers · History · AI · Economics; the other four areas expose one `platform-overview`. Identity ids are `platform-*` namespaced and unioned into `WORKSPACE_REGISTRY` (`lib/perspectives.ts:515-521`).
- The five areas: `lib/platform/policy.ts:57-212` `PLATFORM_AREAS` + `ALL_PLATFORM_AREAS :215`. Listed by the Spaces page (`spaces/page.tsx:435-456` → `SpacesClient.tsx:874-920`, "Fourth Meridian HQ", below personal cards) and by `PlatformNav`. Both listings come from `space.findMany` **with no `orderBy`** (`app/api/spaces/route.ts:83-86`, `spaces/page.tsx:443-446`).

### 2.4 Tests that pin this behaviour
`components/ui/chrome.test.ts`, `site-nav-in-space.test.ts`, `space-workspace-nav.test.ts` (section F: "platform axis + mobile unchanged"), `space-markets-nav.test.ts` (#36: "Platform HQ: Sections still render, no workspace nav"; #37 PRIMARY_NAV exact five), `components/platform/platform-shell.test.ts` (Sections ↔ body anchors, PlatformNav 0/1/n, ONE `/api/spaces` fetch, Space-mode gate on `isPlatformSpaceRoute`, platform group absent inside a personal Space `:276-279`), `components/space/shell/space-shell.test.ts`, `space-url-authority.test.ts`, `space-history.test.ts`, `lib/space-nav.test.ts`, `lib/platform/workspaces.test.ts`, `lib/space/mount-context.test.ts` (platform default `platform-overview`; host reads `available.map(`), `lib/platform-surface.test.ts` (no customer-axis tokens under platform paths).

### 2.5 Gaps versus the target hierarchy
| # | Gap | Tier |
|---|---|---|
| G1 | Five Platform Spaces have no consistent prominent position across modes/widths: absent from the sidebar inside a personal Space (recorded decision `ContextualNavbar.tsx:595-603`) and absent on mobile everywhere except the Spaces page | VERIFIED |
| G2 | Five listed in DB order, not registry order | VERIFIED |
| G3 | Platform workspaces are rail pills only; never sidebar destinations | VERIFIED |
| G4 | Platform workspace selection has no URL authority (no deep link, no history, refresh resets) | VERIFIED |
| G5 | `PlatformNav` can only link to an area root (consequence of G4) | VERIFIED |
| G6 | Platform rail not touch-optimized below `lg` (eight pills, horizontal scroll) | VERIFIED |
| G7 | Sections anchor list is a model personal Spaces retired; whether it survives beside a workspace list is a product call | INFERRED |
| G8 | HQ card group sits below personal cards on the Spaces page | VERIFIED |

---

## 3. Proposed Platform Space navigation model (PROPOSED)

**Principle:** Platform Spaces adopt the personal Space's two existing seams — URL authority through `useSpaceUrl`, and sidebar workspaces through the `workspaceNav` channel — and change nothing in the shell's architecture.

**Change A — URL authority + canonical order (closes G2, G4, G5).**
- `PlatformSpaceDashboard.tsx`: replace the `useState` rail with `useSpaceUrl()`: hydrate from `?workspace=` after mount, `commit({workspace}, {history: "push"})` on rail/doorway change (default workspace writes null), `subscribe` for popstate. This mirrors `use-space-navigation.ts:285-303, 342-369, 402-423` exactly.
- `[area]/page.tsx:157-164`: read `searchParams.workspace`, pass `{ selectedKey }` to `platformMountContext` so SSR first paint matches the URL.
- `lib/space/space-url.ts:20-30`: add `"workspace"` to the documented params (core is param-agnostic).
- `app/api/spaces/route.ts:92-94` and `spaces/page.tsx:448`: sort by `ALL_PLATFORM_AREAS.indexOf(area)`.
- Tests: extend `space-url-authority.test.ts` to scan the platform host; nothing existing breaks.

**Change B — publish platform workspaces to the shared sidebar channel (closes G3, G6; depends on A for hrefs).**
- `PlatformSpaceDashboard.tsx`: call `useSpaceWorkspaceNavPublisher` with `items = available.map(w => ({ id, label, href: "/dashboard/platform/<area>?workspace=<id>" }))`, `activeId`, `onSelect` = the same setter, clear on unmount (exactly `SpaceDashboard.tsx:393-426`). Pass `mobileOptimized`.
- `SpaceShell.tsx`: add `railVisibility?: "always" | "belowLg"` (one class, mirrors `PerspectiveShell.tsx:78-80,181-190`). Personal keeps `"always"` — byte-identical.
- `ContextualNavbar.tsx:93-97`: extend `WORKSPACE_ICONS` with the platform icon names, or add optional `icon?: string` to `SpaceChromeWorkspaceItem` (sidebar must stay free of finance imports — `space-workspace-nav.test.ts:267-269`).
- Sections list (G7): keep `SectionsNav` below the workspace list, or drop it — a one-line change at `ContextualNavbar.tsx:667-673`. **DECISION D1.**
- Tests to rewrite: `space-markets-nav.test.ts` #36 and `space-workspace-nav.test.ts` section F (both pin the old contract). Must still pass: `platform-shell.test.ts` A–E, `workspaces.test.ts:281-297`, `mount-context.test.ts:300-345`.

**Change C — prominence of the five (closes G1, G8). DECISION D2.**
- C2 (no doctrine conflict, no test pin): move `PlatformSpaceGroup` above the personal cards on the Spaces page (`SpacesClient.tsx:1139`).
- C1 (two lines, contradicts recorded axis doctrine and `platform-shell.test.ts:276-279`): render `PlatformNav` in Space mode unconditionally.
- C3 (new surface): a `lg:hidden` Platform switcher row in `SpaceShell`'s mobile relocation row fed by the same `/api/spaces` projection; the "exactly ONE fetch" pin means the fetch must be hoisted to a shared hook.
- Not recommended: adding Platform to `PRIMARY_NAV` (four tests pin it at five).

**Recommendation:** A + B + C2 in this iteration. Whether the rail hides at `lg+` (true personal parity: sidebar is the single desktop switcher, pills below `lg`) or stays visible alongside the sidebar list is the owner's call (D1); the code path is one prop either way. C1/C3 only on an explicit ruling about the axis boundary (D2).

---

## 4. Current Overview component inventory (VERIFIED)

| Component | File | Fetches | Renders | Interactions | States |
|---|---|---|---|---|---|
| `PlatformAreaHero` | `components/platform/PlatformAreaHero.tsx:59-86` | none | eyebrow, h1 "What is the health of Fourth Meridian?", lede, "You're operating … · CONTROL access" | none | n/a |
| `OpsOverviewWidget` (`ops_overview`) | `widgets/OpsOverviewWidget.tsx:30-145` | `GET /platform-ops/overview` → `lib/platform/ops/overview.ts:54-124` composing six authorities + policies | `SectionSurface`; header = `StatusWord(worst)` + sentence + policy strip + "checked Xs ago"; grid of six domain blocks (`GroupLabel` + Open + `StatusWord` + headline `<p>` + 5–7 `KeyRow` + "from {basis}" line); "Latest failed executions" list | Open → rail switch; failure row → `ExecutionTimelinePanel` | loading/error via `WidgetMessage`; no empty state; no WRITE |
| `OpsPlatformHealthWidget` (`ops_platform_health`) | `widgets/OpsPlatformHealthWidget.tsx:318-355` | five independent fetches: `/alerts`, `/provider-health`, `/resource-freshness`, `/rate-limits`, `/env-status` | `SectionSurface`; four `HealthGroup`s (Alerts, Providers, Freshness, Configuration = Environment + Rate limits) each `StatusWord` + headline + `TwoLine` rows + `Provenance` chip + note + `GroupDoorway` | doorway → rail switch; no per-row targets by design (`:51-54`) | per source loading / failed / empty / populated |
| Explore grid | `PlatformSpaceDashboard.tsx:328-337` | — | seven `WorkspaceDoorway` cards | rail switch | — |

**Response shape** (`overview-core.ts:263-267, 34-45`): `{ domains[6]{key,title,state HEALTHY|DEGRADED|FAILED|STALE|UNKNOWN, headline, facts[], basis, workspace}, policies, worst, checkedAt, windows, latestFailures: ExecutionRowDTO[], nextSlotAt }`. Domains: pipeline, sources, jobs, brief, ai, plaid. `worst` ranks FAILED < DEGRADED < STALE < UNKNOWN < HEALTHY (UNKNOWN never outranks a failure).

**Verified pain points**
1. Text density as counted in §1.2; basis strings appear twice per domain (tooltip `:66` and footer `:88`).
2. Implementation paths visible: provenance chips at `OpsPlatformHealthWidget.tsx:271,280,289,301,308`; "for the keys lib/env.ts checks" (`platform-health-view.ts:432`); basis strings naming tables and joins (`overview-core.ts:166,221,242,260`).
3. Visually flat: no `Figure`/`BigStat`; status words not column-aligned; `nominal` deliberately uncoloured so a healthy page has almost no colour.
4. Duplication: Sources vs Providers; last-success vs Freshness; policy strip vs Policies; two clocks; two footnotes.
5. Three navigation mechanisms to seven targets.
6. No entity rows; the failure list has no header or columns.
7. No polling or manual refresh anywhere in the platform widgets; "checked Xs ago" drifts until the workspace is re-entered.
8. Alerts group ranks the whole retained firing history (last ~10 evaluation runs, roughly 2.5 days): a critical firing days ago keeps "Action needed" until it ages out (`platform-health-view.ts:233,251-257`) — exactly the "historical alert shown as open" hazard the brief names. INFERRED consequence of VERIFIED code.
9. Stale copy: `GROUP_DOORWAY` comment (`platform-health-view.ts:165-168`), `POLICIES_FOOTNOTE` (`policies-view.ts:91-93`), "eleven keys" (`descriptor.core.ts:9`).
10. Two widgets (`OpsRateLimitsWidget`, `OpsEnvStatusWidget`) exist but are composed nowhere (absorbed into Health).

Overview request budget at mount: six (`/overview` plus five Health routes); `/overview` server-side re-runs `getConnectionHealth` that Health/Providers also serve.

---

## 5. Proposed first-iteration layout (PROPOSED)

Overview = summarize and direct. Each block answers one of the six owner questions, projects an existing authority, and links to the workspace that holds the evidence and the controls. No block repeats a workspace.

```
PlatformAreaHero (kept, trimmed to eyebrow + h1 + one line)

┌ STATUS BOARD ──────────────────────────────────────────── one SectionSurface ┐
│ Six domain tiles (Pipeline · Sources · Jobs · Brief · AI · Plaid)             │
│   each: StatusWord + ONE Figure-size number + one qualifier + "→ workspace"  │
│ Four posture chips (Alerts · Providers · Freshness · Config)                  │
│   word + count only; the four Health groups fold in here                      │
│ Right: "checked 12 s ago" · policy strip (Banks 24h · Wallets 6h → Policies)  │
│ Footer: ▸ Technical details (disclosure: basis strings, provenance, notes)    │
└───────────────────────────────────────────────────────────────────────────────┘

┌ ATTENTION REQUIRED ──────────────── Pipeline-grammar table, severity-ranked ─┐
│ Severity | Entity | Problem | Since | Evidence | Action                        │
│ rows: unhealthy connections · failing/dead/overdue jobs · provider FAILING    │
│       · stale resources · currently-firing alert rules · active incidents*    │
│ Evidence → RightPanel (execution timeline / job detail / incident facts)      │
│ Action → the existing WRITE control, or "open <workspace>"                    │
│ footer: "Recent alert firings (historical, last N evaluations): …" separate   │
└───────────────────────────────────────────────────────────────────────────────┘

┌ CONNECTION HEALTH ───────────────────── table, identity-minimized by default ┐
│ Connection | Provider | Kind | State | Last sync | Stale for | Threshold | Owner† | Action │
│ † Owner column renders only when the CUSTOMER_SUCCESS resolution succeeds     │
└───────────────────────────────────────────────────────────────────────────────┘

┌ SCHEDULED JOBS ─── compact matrix ──┐ ┌ REFRESH ACTIVITY ── 14-day strips ──┐
│ 11 rows: job · state · last · next  │ │ by status / by trigger / by kind     │
│ (never-ran / overdue / failing)     │ │ (day series when D8 approved)        │
│ → Jobs                              │ │ → Pipeline                           │
└─────────────────────────────────────┘ └──────────────────────────────────────┘

┌ AI ACTIVITY ── 30-day bars ─┐ ┌ ECONOMICS ── two estimate stats ─┐ ┌ RECENT ACTIVITY ─ feed ─┐
│ calls/day, failures, est. $ │ │ Plaid cycle est · AI 30d est    │ │ operator actions + manual │
│ → AI                        │ │ "estimate, not a bill" → Econ.  │ │ runs, evidence links → Hist│
└─────────────────────────────┘ └──────────────────────────────────┘ └───────────────────────────┘
```

**Rules carried into the design**
- No composite score. The status board shows six domain verdicts plus four posture chips; `worst` may be shown as a headline word only because it is already an authority (`overview-core.ts:280-282`), never as a number.
- Colour never alone (word + dot); urgency by coral saturation; `--coral-500/600/700` banned (pinned).
- Frame rule: one `SectionSurface` per concern, groups separated by whitespace and `VRule`, never nested cards (pinned by `platform-surface.test.ts`).
- Honesty states: loading ≠ error ≠ not observed ≠ zero ≠ unavailable; floors captioned; no total count where the seam refuses COUNT.
- Technical evidence stays, moved into a `<details>` disclosure per surface and into the drawers.
- One navigation mechanism per block (the block's own "→ workspace"); the separate Explore grid is retired. Doorways still render nothing when unwired.
- Mobile: tiles stack verdict-first; tables collapse below `md` to identity + status with dropped columns reappearing in the row expansion (the Jobs rule); never horizontal page scroll.

**Section-key strategy (DECISION D3).** Option 1: keep `ops_overview` and `ops_platform_health` as the two composed keys and rebuild their widgets (status board under `ops_overview`, the new tables under `ops_platform_health` renamed by DB label) — zero seeding. Option 2: add new keys (`ops_attention`, `ops_connection_table`, `ops_recent_activity`) — three registry edits each plus `npm run platform:seed-spaces` on Dev, Preview and Production, with the R-5 invisible-surface hazard if forgotten. Recommended: Option 1 for the status board and Attention (same questions), one new key `ops_recent_activity` only if D6 is approved.

---

## 6. Data availability matrix (VERIFIED unless marked)

Legend: EXISTS / PARTIAL (named additive work) / MISSING. Auth = PlatformGrant area and level; pattern `requirePlatformAccess("PLATFORM_OPS","READ")` (`lib/platform/authorize.ts:116-121`), fresh re-auth for mutations (`:131-136`).

| # | Visualization | Authoritative source + reader | Route | Granularity / retention | Auth | Status | Missing-data behaviour | Query cost |
|---|---|---|---|---|---|---|---|---|
| 1 | Status board | six domain verdicts `buildOverview` (`lib/platform/ops/overview-core.ts:271-291`); posture from `/alerts`, `/provider-health`, `/resource-freshness`, `/env-status`, `/rate-limits` | `platform-ops/overview` + four Health routes | point-in-time; pipeline window yesterday..today UTC; AI/Brief 24 h; **no stored verdict history** | PLATFORM_OPS READ | **EXISTS**. No authoritative overall-health rule beyond `worst`; alerts/incidents/providers/freshness are not overview domains | UNKNOWN rendered as "Unknown", never green; each source keeps its own four fetch states | 6 reads; `getConnectionHealth` full-scans PlaidItem + Connection + 1000 AuditLog rows (beta-scale fine) |
| 2 | Attention Required | **connections** `getConnectionHealth` (`lib/connections/health.ts:167-249`); **jobs** `checkScheduledJobHealth` (`lib/jobs/health.ts`); **providers** `getProviderHealth`; **resources** `checkResourceFreshness`; **alerts** `AlertRuleOutcome.firing` from the latest `evaluate-alerts` run (`lib/alerts/evaluate.ts:291-302`) vs `fired` history; **incidents** open `SyncIssue` (`schema.prisma:3501-3550`), `getActiveIncidents` (`incidents/projections.ts:168`), states `active|recovered|evidence|superseded|orphaned`, severity `critical|error|warning|info` | all PLATFORM_OPS except incidents (`customer-success/sync-issues`, CS READ, 6-row preview) | connections/jobs/providers live; alerts = last 10 evaluation runs (~2.5 days); incidents unbounded, indexed on `resolvedAt`, `incidentKey` | PLATFORM_OPS READ (+ CS for incidents) | **PARTIAL**: (a) no alert open/resolved state — "active" can only mean "firing in the latest run"; (b) incidents need a PLATFORM_OPS-gated projection or ruling (D5); (c) actions exist as routes, not linked from items; (d) evidence links exist (`resolvingExecutionId`, occurrence `refreshExecutionId`, `parentJobRunId`) but are null for producers without envelope | empty = "Nothing needs attention — N authorities checked at <time>", never "healthy" | indexed; a new composition reader in `lib/platform/ops/` (allowed seam) with a declared severity rank |
| 3 | Connection drill-down | `PlaidItem` (`status ACTIVE|NEEDS_REAUTH|ERROR|REVOKED`, `errorCode`, `lastSyncedAt`, `institutionName`, `userId`) + wallet `Connection` (`provider`, `status`, `errorCode`, `lastSyncedAt`, `userId`); `ConnectionHealthRow{source,id,label,status,errorCode,healthState,lastSyncedAt,since}` (`health.ts:85-94`), precedence `:113-123`, threshold = `RefreshPolicy.overdueAfterHours`; transitions from AuditLog `*_STATUS_CHANGED`; richer `getConnectionDiagnostics` (`ownerRef` opaque, acquisition state, cap 50) | `platform-ops/connection-health` (unhealthy cap 20), `connection-diagnostics`; actions `connections/[id]/resync`, `request-reauth` (WRITE fresh) | live state; "since" from last 1000 transition rows; no staleness history | PLATFORM_OPS READ; owner requires CUSTOMER_SUCCESS READ | **PARTIAL**: present — provider, institution, kind, status, errorCode, lastSyncedAt, healthState, since. Missing on the row — threshold value (policy applied, not emitted), stale-for (derivable), **never-synced** (reader folds `null` into STALE; derivable from `lastSyncedAt == null`), "temporarily unavailable" (≈ DEGRADED, wallets only), **owner** (deliberately absent), action | revoked rows "not counted"; null owner → column absent (403), never an id | full scans, no `status`/`lastSyncedAt` index on either table (fine at beta scale) |
| 4 | Refresh activity | `RefreshExecution` (`overallStatus RUNNING|SUCCEEDED|PARTIAL|FAILED|SKIPPED`, `trigger`, `sourceKind`, `network`, `admissionReason`, `failureCategory`, `outcome`, `parentJobRunId`, `deploymentSha`); `getRefreshSummary` (window 14 d default, `MAX_FACT_ROWS=20_000`, `ProjectionEnvelope`); `queryRefreshExecutions` (keyset, filters, no COUNT) | `refresh/summary?from&to`, `refresh/executions?…`, `/[id]`, `/[id]/timeline`, `refresh/coverage`, `refresh/provider-operations` | row-level, unbounded, indexed `[overallStatus,startedAt]`, `[sourceKind,startedAt]`; **no day-grain bucket exists** | PLATFORM_OPS READ | **PARTIAL**: byStatus/byTrigger/byProfile per window EXIST (strips ready now); a time series needs one new per-day projection in `projections.ts` (D8). **Refused requests**: admission denials are ledgered SKIPPED executions (EXISTS); operator Refresh All outcomes and resync refusals are AuditLog rows (`OPERATOR_REFRESH_ALL`, `result:"REFUSED"`); **customer 429 cooldown refusals write no row** (`app/api/plaid/refresh/route.ts:103-107`) — state this on-surface | "not observed" ≠ zero; `deterministic:false` renders its reason | 14 d within cap; 90 d would hit the cap |
| 5 | Scheduled jobs | `JobRun` (`jobName`, `trigger`, `status running|succeeded|failed`, `startedAt`, `completedAt`, `durationMs`, `summary`, `deploymentSha`; **no `scheduledFor`**); registry of 11 jobs (`lib/jobs/registry.core.ts:113-150`); health states `never-ran|running|dead|overdue|failing|healthy`, 50 runs per job, `nextExpectedAt` derived from cadence policy (not vercel.json); scheduler observation | `platform-ops/job-health`, `scheduler`, `job-cadence` | per-run, unbounded | PLATFORM_OPS READ | **EXISTS** for matrix / last / next / overdue / never-ran. **PARTIAL** for a timeline: no planned-slot ledger; ticks unobservable (refused by doctrine). Preview has no crons: surfaces as `never-ran` + `scheduler-silent` alert (observed: "Never ran 10" on Preview) | never-ran rendered as its own word; no fabricated slots | 11 × 50 indexed rows |
| 6 | Provider health | `getProviderHealth` (`lib/platform/provider-health.ts:548`): trust `OPERATIONAL|DEGRADED|STALE|FAILING|UNKNOWN`, availability, last success/failure, latency, quota (null today), coverage, freshness (consumed, never recomputed), calls today/30 d from `ApiUsageCounter` | `platform-ops/provider-health`, `resource-freshness`, `api-usage`, `email-health` | 7-day JobRun window; `ApiUsageCounter` day buckets | PLATFORM_OPS READ | **PARTIAL**: `PROVIDER_SPECS` = **Plaid and Open Exchange Rates only** (`:195-215`). OpenAI failures via `ai/failures.ts`; Resend via `email-health`; crypto explorers (Alchemy, Esplora, CoinGecko) have no provider authority — their failures are WALLET execution `failureCategory` rows. "Affected connections" = degraded counts, not a list | UNKNOWN before soft verdicts (false-green guard) | cheap |
| 7 | AI activity | `AiInvocation` (`outcome RETURNED|FAILED|TIMEOUT|RATE_LIMITED|QUOTA`, tokens, latency, surface, model, `userId` soft); `getAiOperations` grouped at UTC day; `getAiUsageTrend` (`ApiUsageCounter`, 30 daily buckets, est. USD); `getBriefOps` | `ai-invocations?window&surface&model&environment`, `ai-usage-trend`, `brief-ops` | day grain in both ledgers | PLATFORM_OPS READ (fleet, no user dimension) | **EXISTS**. Two cost paths (per-call rate card vs counter estimate) — label which one a chart uses | missing days as gaps | indexed grouped SQL |
| 8 | Economics | `getPlaidUsage` (Item × product × billing cycle, invoice-derived `PLAID_RATES`, labelled ESTIMATED, both invoice readings + `agree`); `getCostIntelligence` (`CostMetric{value,unit,tier,provenance}`, 30 d) | `plaid-usage`, `cost?asOf&compareTo`, `ai-usage-trend` | Plaid monthly cycles (no daily allocation by doctrine); AI per day; **no actual-charge ledger** | PLATFORM_OPS READ | **PARTIAL**: trend = Plaid per cycle + AI per day only; dev-vs-prod split unknown for historical Items (`PlaidItem.environment` never backfilled) | "estimate, not a bill" on every figure; null when cycle predates rate evidence | cheap |
| 9 | Recent activity | `AuditLog` via `recordOperatorAction` envelope (`lib/audit.ts:202-215, 291`: actor, target, reason, before/after, **execution{jobRunId,refreshExecutionId,commandId}**, result); `projectOperatorActionEvent` (`security/operator-actions-core.ts:54`) → username, opaque target, reason code, execution refs; manual runs via `platform-ops/operations` GET | `security-ops/operator-actions` (**SECURITY_OPS READ**, last 20), `platform-ops/operations`, `platform-ops/history` | row-level, unbounded, `[action,createdAt]` | SECURITY_OPS for the feed | **PARTIAL**: evidence links exist; a PLATFORM_OPS-scoped subset (targets JOB, PLAID_ITEM, platform-setting, OPERATOR_REFRESH_ALL) needs a ruling (D6); fixed 20, no pagination | depth stated ("last 20") | cheap |

**Cross-cutting (VERIFIED):** zero migrations needed; no operational ledger is pruned (only `RateLimit`); 13 ledger tables are revoked from `fm_app` and read through `systemDb` or the ratcheted migration principal (`scripts/audit-db-authority.ts`, `lib/platform/` and `app/api/platform/` already allowlisted); the refresh-ledger read seams are pinned as a named set (`read-boundary.test.ts:49-72`) so a new day-series projection must live in `projections.ts`, not a new file.

---

## 7. Connection / customer drill-down architecture (PROPOSED on VERIFIED seams)

**Join path:** `PlaidItem.userId` / `Connection.userId` → `User{id, username, name}` (both FKs indexed). Display through `operatorDisplayName` (`lib/platform/customer/identity-label.ts:20-24`): username → name → `user …<last6>`, never email. Do not route through `AccountConnection`/`SpaceAccountLink` (answers "which Space", not "which customer").

**Today:** this join exists only in CUSTOMER_SUCCESS (`customer-detail.ts:67-88`, `customers.ts:56-60`, both `systemDb`). PLATFORM_OPS readers emit at most an opaque `ownerRef` (`connection-diagnostics.ts:33-37`), pinned by `observability-privacy.test.ts:56-65` (source scan forbids `email: true` in listed readers). Authorization is per-route; there is no per-field or per-widget primitive.

**Minimal non-weakening shape (two routes):**
1. Fleet row stays `platform-ops/connection-health`, PLATFORM_OPS READ, extended **additively** with `overdueAfterHours` (the threshold already applied at `health.ts:99-103`), `neverSynced: boolean`, and `availableActions: ("resync"|"request-reauth")[]` derived from `source` + `status` (no new verdict).
2. New thin route `app/api/platform/customer-success/connection-owners` (POST or GET with ids), gated `requirePlatformAccess("CUSTOMER_SUCCESS","READ")`, reader `lib/platform/customer/connection-owners.ts` on `systemDb` selecting `{connectionId, userId, username, name}` only — the pattern the connection-health route header already anticipates (`connection-health/route.ts:13-14`). Add the reader to the privacy source-scan list.
3. UI merges owner labels when the CS call returns 200; on 403 the column is absent (not "—", not an id). Username-first per the P1 ruling; email stays in the Customer Success detail panel.
4. Drill: row → `RightPanel` with facts, transition history (`since`), last execution (via `plaidItemId` filter on the execution seam, EXISTS), and the two WRITE buttons behind `ConfirmDialog` (shipped). "Open in Customer Success" doorway only when the owner resolved.

**DECISION D4:** the existing ruling lets CUSTOMER_SUCCESS resolve identity; it does not address co-rendering an owner column on a Platform Operations surface for an operator who holds both grants. The two-route design keeps tenant isolation and RLS untouched either way.

---

## 8. Existing reusable UI components and libraries (VERIFIED)

**Tokens** (`app/globals.css`, Tailwind v4, no config file, tokens as CSS variables): Ink neutrals, brass, meridian (interactive/info), emerald (positive), coral (negative + warning family, saturation = urgency), violet; `--accent-warning` amber; radii, spacing scale, durations/easings, glass material filters, dark default with a reserved light theme, reduced-motion and reduced-transparency media rules. **Defect to fix in passing:** `--danger-400`, `--success-400`, `--warning-400` are referenced in 22 places in `components/platform` but defined nowhere (fallback hex carries them); canonical substitutions are documented at `platform-surface.tsx:70-76`.

**Atlas base** (`components/atlas/*`): `Surface`, `Block`, `Figure`, `Delta`, `GlassPanel`, `DataCard` (unused), `SegmentedControl`, `Chips`, `InlineFilter`, `InlineBanner`, `GlassButton`, `Dialog`/`ConfirmDialog`, `Panel`/`RightPanel` (+ header/content/footer/stack; mobile bottom sheet), `Toast`, `Dropdown`, fields. **Absent:** Table/DataTable, Tooltip, EmptyState, Skeleton.

**Platform surface grammar** (`components/platform/platform-surface.tsx`, the PM-1 page grain): `SectionSurface`, `BigStat`, `TwoLine`, `GroupLabel`, `StatusBadge` (jobs-shaped tone union), `StatusWord`, `Unavailable`, `Provenance`/`NO_AUTHORITY`, `KeyRow`, `PanelSection`, `VRule`, `PolicyChip` (orphaned), `ExecutionStrip` and `RuntimeTrend` (built, tested, **zero consumers** — blocked on a per-job run route), the one tone map `TONE_COLOR {ok, info, warn, bad, muted}`.

**Card grain** (`widget-kit.tsx`): `PlatformWidgetCard`, `WidgetStat`, `WidgetMessage` (no live-region role — a11y gap), `useWidgetFetch` (static URL, pinned), `useKeyedFetch`, `useSharedWidgetFetch` (per-workspace dedupe). Nine widgets are on the page grain, 35 still on the card grain — the largest visual inconsistency.

**Charts:** `recharts ^3.8.1` is installed and **imported nowhere**; every chart in the repo is hand-rolled SVG/CSS (`TrendChart`, `CalendarHeatmapGrid`, `Sparkline`, `FunnelStages`, `ExecutionStrip`, `RuntimeTrend`). Chart doctrine in the July investigation §11: series only over persisted event-time points with ≥5 observations; distribution bars with word+count segments; ranked tables for stable entities; heatmaps/matrices rejected at this population; never chart a snapshot as a trend.

**Tables:** the house CSS-grid row idiom (Jobs `OpsJobHealthWidget.tsx:84-403`, Pipeline `OpsRefreshExecutionsWidget.tsx:96-159`): shared `gridTemplateColumns`, `hidden md:grid` header, `TwoLine` cells, status dot+word, row = `<button>` → drawer or inline expansion, pill toolbar with counts, `overflow-x-auto`, below `md` rows collapse. Only one real `<table>` exists (`GrowthPolicyGroupsWidget.tsx:42`). Doctrine: reuse the shape, do not extract a generic DataTable.

**Drawers:** `RightPanel` (portal, Escape, focus trap, return focus, reduced motion; mobile bottom sheet). Doctrine: panel = inspect, modal = decide (`docs/architecture/UI_INTERACTION_MODEL.md:75`).

**Primitives to promote in this iteration (PROPOSED, all in `platform-surface.tsx`):** `DistributionBar` (labelled word+count segments, tone only where a status vocabulary owns colour, floor caption slot — consumers: refresh byStatus, connection counts, attention severity); `StatusTile` (`StatusWord` + `Figure` + qualifier + doorway — the status board's unit); `MiniBars` (UTC-day bucket bars with text equivalents — AI trend, refresh day series). Consolidate the four hand-rolled health dots into `StatusBadge` with a widened tone union (vocabularies stay domain-owned). Add `role="status"`/`role="alert"` to `WidgetMessage`.

**Recharts (DECISION D14):** recommended **not** to adopt in this iteration. The needed forms (strips, mini bars, matrix rows) are trivial in SVG/CSS, the house has an SVG idiom with accessible summaries, and adopting a 400 kB charting runtime for two bar charts would be a new dependency in practice even though it is listed.

---

## 9. Required frontend / backend changes (PROPOSED)

### Backend (all additive, no migrations, no grant changes)
| # | Change | Files | Gate |
|---|---|---|---|
| B1 | Attention composition reader with a declared severity rank over existing authorities (no new verdicts) + route | new `lib/platform/ops/attention.ts`, `app/api/platform/platform-ops/attention/route.ts` | PLATFORM_OPS READ |
| B2 | `ConnectionHealthRow` additive fields: `overdueAfterHours`, `neverSynced`, `availableActions` | `lib/connections/health.ts` | — (privacy test list unchanged) |
| B3 | CS-gated owner resolution route + reader (username/name only) | new `lib/platform/customer/connection-owners.ts`, `app/api/platform/customer-success/connection-owners/route.ts`; add to `observability-privacy.test.ts` scan list | CUSTOMER_SUCCESS READ (D4) |
| B4 | Refresh per-day series projection (UTC day × status × sourceKind, ≤30 d, under `MAX_FACT_ROWS`) + route | `lib/platform/refresh/projections.ts` (pinned seam), `refresh/daily/route.ts` | PLATFORM_OPS READ (D8) |
| B5 | Alerts route exposes the latest run's `outcomes[].firing` beside history | `app/api/platform/platform-ops/alerts/route.ts`, `lib/alerts/run.ts` | PLATFORM_OPS READ |
| B6 | PLATFORM_OPS-scoped operator activity feed (subset of `OPERATOR_ACTION_FEED_ACTIONS` by target kind) | new route under `platform-ops/activity`, reuse `projectOperatorActionEvent` | PLATFORM_OPS READ (D6) |
| B7 | Reason on the refresh-cadence PATCH (P1 report §N P2 item) | `lib/platform/policies/mutate.ts`, `policies/route.ts`, `lib/audit.ts` REASON_REQUIRED | CONTROL fresh (D7) |
| B8 | Policy audit history read (last 10 `PLATFORM_POLICY_CHANGED`/`JOB_CADENCE_CHANGED` per key) | `lib/platform/policies/history.ts` + route, or fold into `/policies` GET | PLATFORM_OPS READ (optional) |
| B9 | Canonical ordering of the five areas | `app/api/spaces/route.ts`, `spaces/page.tsx` | — |
| Deferred | Per-job run page route (lights `ExecutionStrip`/`RuntimeTrend`); provider specs for OpenAI/Resend; alert lifecycle entity | — | iteration 2 |

### Frontend
| # | Change | Files |
|---|---|---|
| F1 | Navigation A + B (+ C2) per §3 | `PlatformSpaceDashboard.tsx`, `[area]/page.tsx`, `space-url.ts`, `ContextualNavbar.tsx`, `SpaceShell.tsx`, `SpacesClient.tsx`, two nav tests rewritten |
| F2 | Shared primitives + token migration + `WidgetMessage` live regions | `platform-surface.tsx`, `widget-kit.tsx`, 22 call sites |
| F3 | Status board replacing `OpsOverviewWidget` + `OpsPlatformHealthWidget` content; technical-details disclosure; Explore grid retired | `OpsOverviewWidget.tsx`, `OpsPlatformHealthWidget.tsx`, `ops-overview-view.ts`, `platform-health-view.ts`, `PlatformSpaceDashboard.tsx` (doorways), `platform-health.test.ts` |
| F4 | Attention Required table + drawers | new `OpsAttentionWidget.tsx` + view-model + test |
| F5 | Connection health table (page grain, owner column, drawer with actions) + Provider health table | `OpsConnectionHealthWidget.tsx` (own fetch → `useWidgetFetch`/keyed), `OpsProviderHealthWidget.tsx` |
| F6 | Jobs compact matrix (Overview) ; Refresh strips + day series ; "Load older" cursor control ; Pipeline card→surface grain | new `OpsJobsMatrixWidget.tsx` or Overview sub-block; `OpsRefreshSummaryWidget.tsx`, `OpsRefreshExecutionsWidget.tsx`, `OpsRefreshCoverageWidget.tsx` |
| F7 | AI daily bars, economics stats, recent activity feed | `OpsAiTrendWidget.tsx`, `OpsCostWidget.tsx`/`OpsPlaidUsageWidget.tsx`, new `OpsActivityFeedWidget.tsx` |
| F8 | Policies reorganization (§4A) | `OpsPoliciesWidget.tsx`, `policies-view.ts`, `policies.test.ts`, `OpsAlertsWidget.tsx` |
| F9 | Composition + seed (if new keys) | `lib/platform/workspaces.ts`, `lib/platform/policy.ts`, registry map, `platform:seed-spaces` on every env |

---

## 4A. Policies and Pipeline — preserve and refine

### 4A.1 Existing Policies component inventory (VERIFIED)
`OpsPoliciesWidget.tsx` (578 lines): `OpsPoliciesWidget` (`:570-578`) reads `/policies` and `/job-cadence` through the shared workspace session and publishes mutation results back; `PoliciesSurface` (`:519-568`) = one `SectionSurface` (grace sentence in the `actions` slot, `POLICIES_FOOTNOTE`) → two `PolicyColumn`s (Bank refresh · Wallet refresh, `:240-367`) separated by `VRule` → `JobCadencePanel` (`:497-516`) listing every registered job as a `JobCadenceRow` (`:452-495`). `PolicyColumn` = `GroupLabel` → `BigStat` "Effective cadence" → six `KeyRow`s (overdue-after, scheduler support, available cadences, attempt schedule, latest sweep, last changed) → Edit / Reset (CONTROL only) → "Not available today" list. `PolicyEditor` (`:115-176`) = one button per menu cadence `4h 6h 8h 12h 24h` + consequence lines + Save/Cancel, **no reason field**; `ResetConfirm` two-step. `JobCadenceEditor` (`:402-449`) = numeric hours (min–max) + mandatory reason `<select>` over `OPERATOR_REASON_CODES` + note ≤280 + Save / Reset / Cancel. `OpsAlertsWidget` (`ops_alerts`) = read-only card: Enabled / Dormant / Recent fires stats, six rule rows, destination, last five fires. Observed on Preview exactly as described.

### 4A.2 Policy controls and authority boundaries (VERIFIED)
| Control | Editable | Bounds / origin | Reason | Audit | Reset | Concurrency |
|---|---|---|---|---|---|---|
| `refresh_cadence_bank` | CONTROL | enum 4/6/8/12/24 h; default 24 h; **floor 6 h** (`refresh-policy.core.ts:54-68`); honourable = at/above floor | **no** (`PLATFORM_POLICY_CHANGED` not in `REASON_REQUIRED_ACTIONS`) | `AuditLog` `PLATFORM_POLICY_CHANGED|RESET` with `{previous,next}` in one tx (`mutate.ts:168-181`) | DELETE = remove override | `expectedUpdatedAt` ms-exact → 409 |
| `refresh_cadence_wallet` | CONTROL | same menu; default 6 h; **floor 4 h** | no | yes | yes | yes |
| `job_cadence_hours_fetch-fx-rates`, `…fetch-security-prices` | CONTROL | integer **6–168** | **yes** (`parseOperatorReason`) | `recordOperatorAction` `JOB_CADENCE_CHANGED|RESET`, before/after | DELETE | yes |
| `job_cadence_hours_evaluate-alerts` | CONTROL | **1–168** | yes | yes | yes | yes |
| sync-banks / sync-crypto | no — `REFRESH_POLICY` origin (one knob, above) | | | | | |
| sync-crypto-continuation | no — `FOLLOWS_PRIMARY` | | | | | |
| process-deletions, notification-cleanup, notification-retry, purge-trash, rate-limit-sweep | no — `FIXED` | | | | | |
| Grace (`max(2h, 25 %·cadence)`), floors, wake cadence 15 min, `MAX_CADENCE_HOURS=168` | read-only code constants | | | | | |
| "Latest sweep" Current/Pending/Unknown | observation from `JobRun.summary.policy.version` | | | | | |

Authorization: GET READ; PATCH/DELETE `requireFreshPlatformAccess("PLATFORM_OPS","CONTROL")` + 30/60 s per-user limit; `canControl` gates rendering only; the server decides. Descriptor model (`descriptor.core.ts:57-84`): class, valueType, allowedValues/min/max, default, missingRow semantics, writeSurfaces, writeCapability, operatorConfigurable, resettable, constraint; registry holds 14 keys.

**Listed in the brief but NOT present (VERIFIED):** configurable rate limits (read-only aggregation of the `RateLimit` table; limiter constants are code); operational thresholds (stale-after, provider trust, alert thresholds — all code); alert rule enable/disable (route comment: "a WRITE lever is a later slice"); `maintenance_mode` / `ingestion_paused` toggles (descriptors say CONTROL-configurable, no Platform Ops route or widget writes them); grace/floor/wake editing; audit history in the UI (only "Last changed <date> by <name>" from the setting row); the retired "honourable multiple of the slot" rule (replaced by the floor in P1).

### 4A.3 Recommended Policies UX improvements (PROPOSED)
1. **Group the flat job list into three declared groups:** Editable (fx-rates, security-prices, evaluate-alerts) · Governed by the refresh policy (sync-banks, sync-crypto, continuation) · Fixed (five maintenance jobs, collapsed by default). Rows keep their identity; the group heading carries the one explanatory sentence that currently repeats on every row.
2. **One effective-value grammar per row:** `Effective 24 h` as `BigStat`/`Figure`, then a four-chip legend `Default 24 h · Override — · Floor 6 h · Max 168 h` (defaults, overrides, hard safety ceilings, read-only limits made distinct by chip, not prose). Origin becomes a `Provenance` chip (`Platform default` / `Override set 7 Oct by <username>` / `Refresh policy` / `Fixed`).
3. **Separate declared policy from observation:** "Latest sweep" and "Last run / Next due" move into a quiet observation line under the row, with a doorway to Jobs; the editable value stays above.
4. **Unify the two edit idioms:** both editors become one `PanelSection`-style inline form (value control, reason select, optional note, Save / Reset); this requires B7 (reason on the refresh-cadence PATCH — D7). Until D7, the refresh editor keeps no reason but adopts the same layout.
5. **Connect warnings to policies:** every "overdue against policy" / "considered overdue after 30 h" statement on the Overview and Providers surfaces links to the governing row (`?workspace=platform-policies#platform-section-ops_policies` once Change A lands) — navigation only, never a second editor.
6. **Overview summarizes, never edits:** the status board's policy strip shows the two effective cadences and the count of overrides, linking to Policies.
7. **Copy fixes:** retire "Nothing here … changes a policy" (`policies-view.ts:91-93`); move the grace sentence out of the toolbar slot into the footnote; relabel the composed `ops_alerts` section "Alert rules (read-only)" and make Health's Configuration doorway land on an actual configuration surface (today it lands on Policies, which holds neither environment nor rate limits).
8. **Audit history (optional, B8):** a "History" disclosure per editable row listing the last changes with reason codes.

### 4A.4 Existing Pipeline component inventory (VERIFIED)
`OpsRefreshExecutionsWidget.tsx` (`:213-287`): static `GET /refresh/executions?limit=30` plus filtered pages via `<FilteredExecutions key={query}>` + `useKeyedFetch`; `SectionSurface` + footnote; two rows of `Segmented` pill groups (source: All/Banks/Wallets; network; status: Any/Failed/Partial/Succeeded/Running/Skipped; trigger: Any/Manual/Scheduled/Operator/Webhook/Reconnect); `ExecutionRows` (`:96-159`) — `<ul>` of `<li><button>` rows on `md:grid` with `gridTemplateColumns "minmax(0,1.8fr) 6rem 6.5rem 7rem 5.5rem minmax(0,1.6fr)"`, header `hidden md:grid`, columns **Source | Trigger | Status | Started | Duration | Verdict**, cells `TwoLine(label, "{kind} · {profile}")`, trigger word, status dot+word (`SUCCEEDED ok · PARTIAL warn · FAILED bad · SKIPPED muted · RUNNING info`), `TwoLine("3m ago", "UTC")`, tabular duration, `TwoLine(verdict, errorSummary)`; deployment boundary as inline hairline "deployment changed · <sha7>"; row click → `ExecutionTimelinePanel` (`RightPanel` lg; execution facts, failure/outcome, context, stages, timeline `<ol>`); `nextCursor` surfaced only as the sentence "Older executions exist beyond this page." Then `OpsRefreshSummaryWidget`, `OpsConnectionHealthWidget` (own `useState`/`fetch`, WRITE buttons behind `ConfirmDialog`), `OpsRefreshCoverageWidget` — all still `PlatformWidgetCard` card grain. Filters are server-side; no sorting (keyset newest-first); below `md` rows wrap in source order without column alignment. Tests: `refresh-widgets.test.ts`, `execution-panel.test.ts`, `refresh-format.test.ts`, `widget-fetch-static-url.test.ts`.

### 4A.5 Pipeline table and layout strengths (VERIFIED assessment)
One row per entity in a fixed column grammar; a dedicated status column of dot+word in five tones; `TwoLine` cells carry fact-then-qualifier so hierarchy lives inside the cell rather than in prose; tabular numerals on time/duration; compact pills that change the query rather than text that explains it; click-to-inspect keeps the list in place; deployment boundaries annotate without grouping; exactly one footnote, with the "why" in a `title`; ledger values humanized ("failed at BALANCES · provider needs re-authentication") rather than narrated. Against the Overview's ≈6 sentences + 33 pairs + 12 basis strings, the table shows 30 executions in the same vertical space.

### 4A.6 Reusable Pipeline patterns
Grid row idiom + `TwoLine` + status dot/word; `Segmented` pill groups (currently local, `:184-209`, to export); keyed-remount filtered fetch; `RightPanel` drawer per row; deployment-boundary rule; the no-count footer; policy-denial rows (SKIPPED + admission reason) as first-class citizens; envelope-as-scope chip (window · determinism · checkedAt).

### 4A.7 Applying those patterns to the Overview
- **Attention Required:** the grid idiom verbatim, columns Severity | Entity | Problem | Since | Evidence | Action; severity dot+word; evidence cell opens the same drawers (execution timeline, job detail); the sort is the authority's rank.
- **Connection health:** grid idiom with `TwoLine(institution, "Bank · Plaid")`, state dot+word, `TwoLine("21 min ago", "UTC")`, stale-for tabular, threshold, owner (authorized), action buttons in the drawer.
- **Provider health:** grid idiom, one row per provider authority (Plaid, OXR; OpenAI and Resend as separately-labelled authorities if D9), columns Provider | Status | Freshness | Last success | Threshold | Affected | Action.
- **Jobs matrix:** the Jobs table's row grammar compacted to job · state · last · next, no toolbar; full table remains in Jobs.
- **Recent activity:** the convergence/timeline grammar (banded events, tone dots aria-hidden, absence sentences), not a table.
- Status composition strips (`DistributionBar`) debut on Pipeline's summary and are reused by the status board — the second-consumer evidence the July doctrine asked for before promotion.

### 4A.8 Estimated effort for Policies and Pipeline refinements
Policies: 6–10 agent-hours UI (regrouping, legend chips, provenance, copy, tests) + 2–3 hours for B7 (reason on refresh-cadence PATCH) if approved. Pipeline: 3–5 agent-hours (Load older control, mobile row alignment, card→surface grain for summary/coverage/connection-health, `Segmented` export, `DistributionBar` strips).

### 4A.9 Does either need substantial modification in the first iteration?
**No.** Policies keeps every control, authority, reason requirement, audit write and reset path; the change is organization, legend and copy, plus one optional backend P2 item. Pipeline keeps its table, filters, drawer and coverage unchanged; it gains a cursor control, mobile alignment and strips. Elements that stay unique to Pipeline: the execution browser rows and filters, the execution timeline drawer, refresh summary endpoint rollups, account coverage. The Overview shows only attention rows and strips that link into it; it never duplicates the execution table.

### 4A.10 Workspace coherence
Overview summarizes and directs (status board, attention, tables of what needs action, strips, feed, one doorway per block). Jobs = full job table + scheduler + manual operations. Policies = the only editing authority for cadence. Pipeline = execution rows, outcomes, coverage. Providers = provider authorities, per-connection diagnostics, cleanup, API usage, freshness, email. History = as-of/compare-to intelligence and convergence. AI = invocations, Brief ops, trend. Economics = Plaid cycles, cost intelligence, AI spend. Shared across all: `SectionSurface` frame, grid row idiom, `TONE_COLOR` vocabulary, `RightPanel` inspection, `gap-8 md:gap-10` rhythm, the new `?workspace=` URL contract — without forcing identical layouts.

---

## 10. Multi-agent workstream plan (PROPOSED)

Coordinator owns contracts and shared files; agents own disjoint file sets. Division follows file ownership, not the brief's suggested letters.

| Agent | Scope | Owns (exclusive) | Reads only |
|---|---|---|---|
| **Coordinator** | registry/composition/seed, shared primitives, tokens, integration, CI, Preview | `lib/platform/workspaces.ts`, `lib/platform/policy.ts` (sections), `PlatformSpaceDashboard.tsx` registry block, `lib/platform/seed.ts`, `platform-surface.tsx`, `widget-kit.tsx`, `globals.css` | everything |
| **Agent 1 — Navigation** (Change A+B+C2) | rail URL authority, sidebar workspace channel, ordering | `PlatformSpaceDashboard.tsx` navigation block (lands **first**, day 1, before the coordinator touches the registry block), `[area]/page.tsx`, `lib/space/space-url.ts`, `ContextualNavbar.tsx`, `SpaceShell.tsx`, `SpacesClient.tsx`, `app/api/spaces/route.ts`, `spaces/page.tsx`, nav tests | mount-context |
| **Agent 2 — Status board + Attention** (B1, B5, F3, F4) | Overview surfaces | `OpsOverviewWidget.tsx`, `OpsPlatformHealthWidget.tsx`, `ops-overview-view.ts`, `platform-health-view.ts`, `platform-health.test.ts`, new `lib/platform/ops/attention.ts` + route + `OpsAttentionWidget.tsx`, `alerts/route.ts`, `lib/alerts/run.ts` | connections/jobs/provider readers |
| **Agent 3 — Connections + Providers** (B2, B3, F5) | connection table, owner resolution, provider table | `lib/connections/health.ts`, new `lib/platform/customer/connection-owners.ts` + CS route, `OpsConnectionHealthWidget.tsx`, `OpsProviderHealthWidget.tsx`, `observability-privacy.test.ts` list | identity-label |
| **Agent 4 — Refresh/Jobs/AI/Economics/Activity + Policies/Pipeline** (B4, B6, B7, F6, F7, F8) | the remaining visualizations and the §4A refinements | `lib/platform/refresh/projections.ts` (+ daily route), `OpsRefreshSummaryWidget.tsx`, `OpsRefreshExecutionsWidget.tsx`, `OpsRefreshCoverageWidget.tsx`, new jobs-matrix widget, `OpsAiTrendWidget.tsx`, `OpsCostWidget.tsx`, `OpsPlaidUsageWidget.tsx`, new activity route + widget, `OpsPoliciesWidget.tsx`, `policies-view.ts`, `policies.test.ts`, `lib/platform/policies/mutate.ts`, `policies/route.ts` | job-health |

**Five-agent variant:** split Agent 4 into 4a (refresh/jobs + Pipeline) and 4b (AI/economics/activity + Policies). Gains about half a day on the critical path; adds one more consumer of the primitives and one more integration merge.
**Three-agent variant:** Agent 1 absorbs Policies/Pipeline polish (both are "preserve and refine"); Agent 2 absorbs the connection table; Agent 3 takes all visualizations. Costs about a day on the critical path.

**Integration seams (coordinator):** `PLATFORM_WIDGET_REGISTRY` entries; composition changes; `DistributionBar`/`StatusTile`/`MiniBars` API frozen on day 0 with a stub each agent can import; `TONE_COLOR` widening; new section keys + seed; `npm run build` (Turbopack client boundary — the local CI contract has no build step, lesson c20c741); `npm run ci` (clean copy, Node 24, throwaway Postgres); push explicit SHA; Preview seed; Preview verification.

**Likely merge conflicts:** `PlatformSpaceDashboard.tsx` (Agent 1 nav block vs coordinator registry block — sequenced); `platform-surface.tsx` (coordinator only); `workspaces.ts`/`policy.ts`/`seed.ts` (coordinator only); `platform-health-view.ts` (Agent 2 only); `alerts/route.ts` (Agent 2 only). Everything else is disjoint.

**Testing ownership:** each agent owns the tests of its files and must keep the tripwires green (`platform-surface.test.ts`, `platform-shell.test.ts`, `widget-fetch-static-url.test.ts`, `workspace-session.test.ts`, `refresh-widgets.test.ts`, `observability-privacy.test.ts`, `read-boundary.test.ts`, `capability-control.test.ts`, `palette-ratchet.test.ts`, `audit-db-authority`). Coordinator owns the composition and seed tests and the full `npm run ci`.

**Concurrency rules in force:** no destructive git; each agent in its own worktree with `.env.local` pointing `DATABASE_URL` **and** `DIRECT_URL` at a clone (an exported `DATABASE_URL` beats `--env-file`; five of seven prior agent worktrees wrote to LIVE), `FM_DB_GUARD=clone-only`; UI work needs no DB; never unscoped-kill `fm-ci-*`; prototype trees are UI reference only, never imported.

---

## 11. File ownership and integration dependencies

Critical path: **Day 0** coordinator freezes primitive APIs + token fixes + Agent 1 nav block → **Day 1–2** Agents 2/3/4 in parallel (Agent 2 needs B5 before the attention alerts row; Agent 3 needs D4 before the owner route; Agent 4 needs D7/D8 before B7/B4) → **Day 2–3** coordinator integrates registry/composition/seed, build, ci, push, Preview seed → **Day 3** Preview verification + owner review round 1 → polish → round 2.

Sequential dependencies: A before B (nav); primitives before any widget restyle; B5 before attention alerts; B3 before owner column; B4 before day-series bars; registry+seed before any new key renders; `next build` before push.

---

## 12. Engineering effort and wall-clock estimates

Calibration (VERIFIED): the P1 program (five workstreams, entitlements + CS spine + cadence + Refresh All + audit, with Preview proofs) landed as six commits whose GitHub CI runs span 2026-10-07 19:12Z to 23:20Z, each run 3–4 minutes, after an investigation day. The local `npm run ci` is a clean-copy gate (minutes, not measured here). This UX refinement has more UI surface than P1 and far less backend.

| Workstream | Agent-hours | Dependencies | Complexity | Risk | Owner | Elapsed |
|---|---|---|---|---|---|---|
| Investigation / design (this document + layout spec) | ~6 done + 2 | — | — | — | coordinator | done |
| Navigation refactor (A+B+C2) | 8–12 | D1, D2 | medium | medium (two nav tests rewritten, `platform-shell` pins) | Agent 1 | 1 day |
| Shared primitives + tokens + live regions | 5–8 | — | low | low (palette ratchet, frame-rule test) | coordinator | 0.5 day |
| Status board + Health fold | 8–12 | primitives | medium | medium (`platform-health.test.ts` 617 lines) | Agent 2 | 1 day |
| Attention Required (B1, B5, F4) | 8–12 | D5 | medium-high | high (ranking must be declared; alerts "active" semantics) | Agent 2 | 1 day |
| Connection table + owner route + provider table (B2, B3, F5) | 10–14 | D4, D9 | medium-high | high (privacy pins, systemDb allowlist, RLS acceptance names seams) | Agent 3 | 1–1.5 days |
| Refresh strips + day series + jobs matrix + Pipeline polish (B4, F6) | 8–12 | D8 | medium | medium (`read-boundary` seam pin, `MAX_FACT_ROWS`) | Agent 4 | 1 day |
| AI / economics / recent activity (B6, F7) | 6–9 | D6 | low-medium | medium (area gate ruling) | Agent 4 | 0.5–1 day |
| Policies reorganization (+ B7) | 6–10 (+2–3) | D7 | medium | medium (`policies.test.ts`, `capability-control` §5) | Agent 4 | 1 day |
| Integration (registry, seed, build, ci, push) | 6–10 | all | medium | medium (Turbopack boundary, seed on every env) | coordinator | 0.5–1 day |
| Testing (new pins + rewrites) | 8–12 | per agent | — | — | all | inside above |
| Preview verification + owner visual review (2 rounds) | 5–8 agent + owner time | deploy | — | — | coordinator + owner | 1–2 days |

**A. Sequential engineering effort:** 85–125 agent-hours of active work (≈ 11–16 agent-days at 8 h), excluding owner time.

**B. Wall-clock with three agents (+ coordinator):** parallel efficiency ≈ 0.6 (shared files, integration, review). Coding 2.5–3.5 days + integration/verification 1 day ≈ **3.5–4.5 working days** to a Preview-verified candidate.

**C. Wall-clock with five agents (+ coordinator):** efficiency ≈ 0.45; coding 2–2.5 days + integration 1–1.5 days ≈ **3–4 working days**. The gain over three agents is under a day because the coordinator's shared files, the owner's visual review and the CI/Preview loop are the bottleneck, not coding.

**D. Completion windows (four agents, recommended):** best case 2 days (decisions pre-made, one review round); realistic **3–4 days**; conservative 6 days (two decisions deferred mid-flight, three review rounds, one privacy or seam pin requiring redesign).

**E. Bottlenecks:** coordinator-owned shared files; owner visual review latency (each round ≈ half a day of agent polish); the nav test rewrites (Agent 1 on the critical path day 1); the CUSTOMER_SUCCESS co-rendering ruling (D4) and the incidents/activity area rulings (D5, D6); Preview seeding for any new section key; `next build` not in the local CI contract.

**F. Deferrable without compromising the first iteration:** refresh day series (strips suffice); recent-activity feed (History already holds manual runs); per-job run series (`ExecutionStrip`/`RuntimeTrend`); OpenAI/Resend provider rows; policy audit history disclosure; C1/C3 prominence changes; Pipeline mobile alignment; `WidgetMessage` live regions (worth doing, cheap).

**Coding versus review:** of the realistic 3–4 days, roughly 2–2.5 are coding/integration and 1–1.5 are owner review and visual refinement rounds.

---

## 13. Risks and scope exclusions

**Risks**
1. **Historical alerts rendered as open.** The Health group ranks all retained firings; the status board and Attention table must split "firing in the latest evaluation" (B5) from "recent firings" explicitly, and say that no open/resolved authority exists.
2. **Identity leakage through composition.** The owner column must come from the CS-gated route only; the fleet reader never selects `email`/`userId`; both pinned by `observability-privacy.test.ts` and `lib/platform-surface.test.ts`.
3. **Second authority by accident.** Attention ranking, "stale for" durations, "never synced" and "available actions" must be declared derivations over existing verdicts, with `basis`, never new verdicts (`overview-core.ts:1-19` doctrine).
4. **Invisible surface.** Any new section key not seeded on Preview/Production renders nothing silently (R-5).
5. **Client boundary.** A `"use client"` widget importing a server-only chain fails the Turbopack build, which local CI does not run (c20c741).
6. **Nav pins.** Rewriting `space-markets-nav` #36 and `space-workspace-nav` F must preserve every other pin (ONE `/api/spaces` fetch, Sections ↔ anchors).
7. **Seam pins.** The day-series projection must live in `projections.ts` (`read-boundary.test.ts` names the set); `MAX_FACT_ROWS` caps the window.
8. **Preview semantics.** Crons never run on Preview, so the status board will show Jobs "Failed / never ran" there by truth, not defect; verification must read it that way.
9. **Scope creep into other Spaces.** `SpaceShell.railVisibility` and the sidebar icon change touch shared chrome; personal Spaces must stay byte-identical (`"always"` default).

**Exclusions (unchanged from the brief):** no redesign of the other four Platform Spaces (they inherit navigation parity only); no new framework, warehouse, authorization system, billing, design system or migration; no alert lifecycle entity; no provider-state history; no composite health score; no recharts adoption (D14); no pruning/retention changes.

---

## 14. Recommended implementation sequence

0. Owner decisions D1–D8 (blocking) recorded; D9–D14 defaulted as recommended.
1. Coordinator: branch, worktrees, primitive stubs (`DistributionBar`, `StatusTile`, `MiniBars`), token migration, `WidgetMessage` roles, frozen API notes.
2. Agent 1: navigation A → B → C2; nav tests; lands first.
3. Agents 2, 3, 4 in parallel on their exclusive files; each runs its own test files and `npx tsc` filtered only as a hint, never as the gate.
4. Coordinator: registry/composition (+ seed if new keys), `npm run build`, `npm run ci`, commit, push explicit SHA, GitHub CI green, Preview seed if needed.
5. Preview verification: Platform Operations Overview/Policies/Pipeline on desktop and the 500 px floor; Customer Success untouched; a personal Space byte-identical.
6. Owner visual review round 1 → polish → round 2 → candidate.

---

## 15. Explicit owner decisions needed before coding

| # | Decision | Recommendation | Blocks |
|---|---|---|---|
| D1 | Inside a Platform Space at `lg+`: sidebar workspace list with the rail hidden (true personal parity) **or** rail always visible plus sidebar list | sidebar-only at `lg+`, pills below `lg` (parity); keep `SectionsNav` beneath | Agent 1 |
| D2 | Platform group visible inside a personal Space's sidebar (C1, overrides recorded axis doctrine) and/or a mobile Platform switcher (C3) | C2 only now; C1/C3 later | Agent 1 |
| D3 | Section keys: rebuild under `ops_overview`/`ops_platform_health` (no seed) **or** new keys (seed every env) | Option 1 + at most one new key | coordinator |
| D4 | Owner (username) column on Platform Ops connection rows via the CS-gated second route when the operator holds both grants | yes, two-route design | Agent 3 |
| D5 | Active incidents (`SyncIssue`) readable through a PLATFORM_OPS-gated, identity-minimized projection for Attention Required | yes (subjects as institution·account labels, no customer) | Agent 2 |
| D6 | PLATFORM_OPS-scoped operator activity feed (subset by target kind) | yes, or defer the Recent Activity block | Agent 4 |
| D7 | Reason required on the refresh-cadence PATCH now (P1 §N P2 item) | yes, small | Agent 4 |
| D8 | Refresh per-day series projection in this iteration | yes if Agent 4 has slack; strips are the floor | Agent 4 |
| D9 | Provider table rows beyond Plaid/OXR (OpenAI via AI failures, Resend via email health, as separately-labelled authorities) | include, labelled | Agent 3 |
| D10 | Per-job run route to light `ExecutionStrip`/`RuntimeTrend` | defer to iteration 2 | — |
| D11 | Retire the Explore grid in favour of per-block doorways | yes | Agent 2 |
| D12 | `PlatformAreaHero` kept (trimmed) or removed on Overview | keep, trimmed | Agent 2 |
| D13 | Token defect migration (`--danger-400` etc.) in scope | yes | coordinator |
| D14 | Adopt recharts | no; SVG/CSS house idiom | all |

---

*Investigation complete. No implementation was started. Awaiting owner authorization.*
