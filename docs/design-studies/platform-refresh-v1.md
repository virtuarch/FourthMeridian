# Design Study — Platform Operations · Refresh Workspace v1

**Program:** PLATFORM-DESIGN-STUDIES-1
**Space:** PLATFORM_OPS · workspace `platform-refresh` (rail: Overview · Jobs · **Refresh** · Providers · Operations · Alerts · History · AI · Costs)
**Status:** Production design study. No production code. Grounded in the investigation (§5.1 P1/P2/P4, §6, §12, Briefs 4–5).
**Imagery:** `images/platform-refresh-desktop.png` · `images/platform-refresh-mobile.png`

---

## 1. Design goals

Make Refresh the reference implementation of **Browser** in Preview → Browser → Detail. The refresh ledger is the deepest underexploited data in the platform: the execution query seam (keyset cursor, status/trigger/time filters, audience redaction) shipped with no UI beyond a 20-row list, and `/refresh/failures` shipped with no widget at all. This study upgrades the workspace to: summary with composition strips → execution browser (dominant) → failure composition (new surface over the widget-less route), with the shipped `ExecutionTimelinePanel` as the drill.

## 2. Operator questions served

- How did the window's executions distribute? (by status / trigger — composition, not decoration)
- Which executions failed, and what exactly happened inside one? (browser + timeline)
- What is failing — at execution, endpoint, or provider-call level, with which provider errors? (failure composition)
- Was work held by policy? (`SKIPPED · Not admitted · INGESTION_PAUSED — a policy decision, not an error`)
- What did a failure do to coverage? (panel's coverage-consequence note: absence of coverage is never freshness)

## 3. Composition

```
Rail                    9 workspaces, Refresh active
Refresh summary         SectionSurface · executions BigStat + ProjectionEnvelope caption + byStatus/byTrigger strips
Executions              SectionSurface · dominant table + filter toolbar + keyset "Load older"        ← dominant
Failure composition     SectionSurface · non-success split | endpoint failures | provider-call table   ← supporting
ExecutionTimelinePanel  RightPanel drill (shipped)
(Account coverage remains its own shipped section, unchanged)
```

- **Summary:** the envelope rendered as a scope chip (*Window 07-12 → 07-26 · deterministic · checked 09:12 UTC*); `deterministic:false` renders its `indeterminacyReason` instead. Status strip wears tone (status vocabulary owns colour); trigger strip is neutral ink steps with the caption *"a trigger is not a verdict."*
- **Browser:** columns Started · Trigger/Profile (TwoLine) · Status (word+dot) · Duration · Endpoints · Error (`hasError` boolean; free text lives in the drill). Toolbar: Attention (FAILED+PARTIAL) / All / Running pills, search, **scope indicator** ("Platform-wide" vs "Scoped to <institution>"). Footer: `Load older ↓` + *"no total count — the seam never counts, so the surface never fakes one."* Admission denials render as first-class rows.
- **Failure composition:** three groupings kept separate (executions by non-success status with FAILED ≠ PARTIAL; endpoint failures ranked; provider-call failures grouped by provider·operation·status·errorCode·errorCategory with `paginationConfounded` rendered as text). Footnote: free-text error summaries are never grouped.

## 4. Interaction model

The expanded state in the desktop image is the **shipped interaction**: selected FAILED row → `ExecutionTimelinePanel` (RightPanel lg, keyed-remount reader). Panel: execution facts (runId, duration, parent job, deploymentSha, truncated error) → complete timeline (started → stage → provider calls with attempts → coverage → completed; tone dots + words) → coverage-consequence note. Incomplete timelines say so; a 404 execution renders the route's honest 404, never an empty fabricated timeline. Failure-composition rows conceptually doorway into the browser pre-filtered (same `onOpen` doorway mechanics — no bespoke navigation).

## 5. Authority map

| Surface element | Category |
|---|---|
| Summary counts, byStatus/byTrigger/byProfile, envelope | **SHIPPED AUTHORITY** (`/refresh/summary`); the strips are **PRESENTATION WORK** |
| Execution browser rows, keyset paging | **SHIPPED AUTHORITY** (`/refresh/executions` — `ExecutionPageDTO`, cursor, `limit≤200`) |
| Status/trigger/since/until filters | **SHIPPED AUTHORITY** (params accepted today; widget just never sends them) → **PRESENTATION WORK** (param-carrying fetch via keyed remount) |
| Scope indicator + `plaidItemId` scoping | **SHIPPED AUTHORITY** (params) + **PRESENTATION WORK**; institution-labeled scope picker needs a small label source → **NARROW PROJECTION REQUIRED** if labels are wanted beyond raw scope |
| Timeline drill | **SHIPPED AUTHORITY** (`/refresh/executions/[id]/timeline` + `ExecutionTimelinePanel`) |
| Failure composition (all three groupings) | **SHIPPED AUTHORITY** (`/refresh/failures` — route has zero consumers today); widget is **PRESENTATION WORK** |
| Admission-denial rows (`admissionReason`) | **SHIPPED AUTHORITY** (ledgered SKIPPED executions) |
| Control-plane read surface (is a hold active *now*) | **NARROW PROJECTION REQUIRED** — not drawn here (Operations workspace concern) |
| Per-endpoint staleness verdicts, retry rates | **INTENTIONALLY UNAVAILABLE** (no cadence authority; retries/pages indistinguishable) — the confounded flag renders as text instead |
| Total execution count | **INTENTIONALLY UNAVAILABLE** (the seam refuses COUNT) — the UI states it rather than faking a number |

## 6. Mobile

True composition: rail as horizontally scrollable pills; summary as stat + status strip; browser rows collapse to started + status (the Jobs rule — *a phone loses layout, never a fact*), with the selected row's dropped columns (trigger, duration, endpoints, error, deployment) re-presented in an inline expansion plus an "Open timeline →" affordance to the bottom sheet; failure composition as stacked key-row groups. `Load older` and the no-count caption survive at 390px.

## 7. Implementation guidance

- **Reusable primitives:** Jobs table grammar (COLS grid, TwoLine, row expansion, toolbar pills), `StatusBadge` tones mapped from `RefreshOverallStatus`, `SectionSurface`, scope chip, `DistributionBar` (second consumer after CS — this is the promotion evidence), `ExecutionTimelinePanel` as-is, keyed-remount fetch for filtered pages.
- **View-models:** `refresh-browser-view.ts` (row shaping, filter → query-param mapping, cursor state) and `refresh-failures-view.ts` (grouping order pinned to the DTO's — no client re-grouping). Neither derives a status or a rate.
- **Complexity:** medium. Zero schema changes, zero new routes. The real work is the param-carrying fetch (the static-URL contract requires the sanctioned keyed-remount escape or a widened, test-pinned contract) and cursor UX.
- **Risks:** (1) filter params are shape-validated, membership-unvalidated server-side — the UI must offer only vocabulary values; (2) `PARTIAL` must never collapse into `FAILED` anywhere (kept separate in strip, pills, and composition); (3) empty filtered pages need state copy distinguishing "no rows match" from "seam denied scope" (`scopeDenied`); (4) the browser must not display a computed total row-count anywhere, including result summaries.
- **Backend work:** none for v1. Optional later: institution labels for scope display.

## 8. Reusable patterns discovered

- **The no-count footer** — pagination honesty as visible copy — belongs to any keyset surface.
- **Policy-denial rows as first-class table citizens** (SKIPPED + reason, quiet tone) generalize the declared-axis rule to tabular surfaces.
- **Envelope-as-scope-chip** (window · determinism · checkedAt in the surface header) is the standard header treatment for any projection-backed surface and pairs with the period-comparison header planned for History.
