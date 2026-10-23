# PLATFORM SPACES UX REFINEMENT P1 — FINAL REPORT

**Program:** Platform Spaces UX Refinement P1 · **Branch:** v2.6 · **Window:** 2026-10-14 (investigation, authorization, implementation, integration, first Preview verification) → 2026-10-15 (polish push, CI follow-through) · **Coordinator:** Claude 1 (this session) · **Agents:** five, in isolated worktrees · **Blueprint:** [investigation](PLATFORM-SPACES-UX-REFINEMENT-P1-INVESTIGATION-2026-10-14.md) · **Contract:** [coordination](PLATFORM-SPACES-UX-REFINEMENT-P1-COORDINATION.md) · **Current state of record:** [`/STATUS.md`](../../STATUS.md) §3, §6, §13, §14 (the per-agent protocol the owner set during the program).

**Production:** untouched. No deployment, migration, database or authorization change. Everything below is Dev-built and Preview-verified only.

---

## 1. Outcome in one paragraph

Platform Operations' Overview is now a dashboard: a status board of six verdict tiles and four posture chips over one request, an Attention Required table ranked by a declared severity table with evidence drawers and the existing resync/reauthorization actions, a connection table with institution, kind, state, last sync, stale-for, threshold and a username-only owner column that appears only under the Customer Success grant, a scheduled-jobs matrix, refresh activity strips and per-day bars, AI activity and labelled cost estimates, a narrow operator-activity feed, a compact Platform Health posture surface and one doorway row. Platform workspaces gained URL authority (deep links, Back/Forward, refresh persistence), the desktop sidebar became the workspace switcher with the rail kept below `lg`, the five Platform Spaces list in registry order and lead the Spaces page, and personal Spaces are byte-identical. Pipeline kept its table and drawer and gained a cursor control; Policies kept every control and gained grouping, a default/override/floor/max legend, provenance and a required reason on refresh-cadence changes. Zero migrations, zero seeds, zero new grants, zero new dependencies.

## 2. Commit series on v2.6 (oldest → newest; all pushed)

| SHA | What |
|---|---|
| `749bdf0` | UX-P1-BASE — five shared primitives (`ToneBadge`, `DistributionBar`, `StatusTile`, `MiniBars`, `PillGroup`) with census entries; `--success/--warning/--danger-400` aliases; `WidgetMessage` live regions; Overview composer under the existing `ops_overview` key + frozen block contract + stubs; investigation and coordination docs |
| `1bea4cc` | UX-P1-HERO — hero trimmed (D12) |
| `45bab55`, `4f88875` → `7cd289b` | Agent 1 merge — navigation parity (A: `?workspace=` via `useSpaceUrl`, SSR from `searchParams`; B: sidebar `workspaceNav` channel + icons, `railVisibility="belowLg"`; C2: HQ group first, registry order) |
| `01586f9` | UX-P1-DOORWAYS — Explore grid → one text row (D11) |
| `15cb433`, `32d97c6`, `06e5246`, `b124d37` → `8d1e2c7` | Agent 4 merge — `getRefreshDailySeries` + `/refresh/daily` (D8); `RefreshActivityBlock`, `JobsMatrixBlock`; Pipeline `PillGroup`, Load older, `md` collapse, summary/coverage grain |
| `74a7ed5`, `2f140fe`, `d3b0dc9` → `0667bb9` | Agent 3 merge — `ConnectionHealthRow` additive facts; `/customer-success/connection-owners` (D4); shared row renderer; connection + provider tables |
| `c78b269`, `a7530fd`, `9fd52ae`, `a0a0cdb` → `36506c2` | Agent 2 merge — "firing now" = latest evaluation; status board; `/platform-ops/attention` + identity-minimized incident projection (D5); compact Platform Health |
| `61bebfc`, `78c058e`, `37d5225`, `898efe3`, `8125e8d`, `5f59865` → `cedabf2` | Agent 5 merge — D7 reason on refresh-cadence PATCH/DELETE; `/platform-ops/activity` (D6); AI/Economics/Activity blocks; `OpsAiTrendWidget` bars; Policies regrouped |
| `69db6f4` | UX-P1-INTEGRATION-FIXTURES — merge-only typecheck errors (Agent 2 fixtures vs Agent 3 required fields); privacy scan +6 readers +3 routes |
| `c9ef14c` | UX-P1-INTEGRATION-PINS — two source-scan pins re-pinned (`health.test.ts` return shape; a comment containing "balance"); coordination contract gains the STATUS protocol and build/CI lessons |
| `837a57b` | UX-P1-STATUS — per-agent STATUS.md record; **first push** (dd39087..837a57b) |
| `d17a9e9` | UX-P1-PREVIEW-POLISH-1 — jobs matrix and refresh activity at full width; Economics duplicate sentence removed |
| `6f3162c` | UX-P1-STATUS-PREVIEW — §14 Preview verification of 837a57b; **second push** (837a57b..6f3162c) |

Interleaved by the status/documentation session on the same checkout (docs only): `ece2ff6`, `bcf23f0`, `c91e9a3`, `075851c`, `8413b41`, `12be97d`, `ce44ecb`.

## 3. Owner decisions applied

| # | Decision | Where it landed |
|---|---|---|
| D1 | Sidebar is the desktop switcher; rail kept below `lg` | `PlatformSpaceDashboard.tsx` publishes `workspaceNav`; `SpaceShell.railVisibility="belowLg"` (personal default `"always"`, byte-identical) |
| D2 | No Platform nav inside a personal Space; better visibility on the Spaces page | `PlatformNav` gating unchanged (pinned); HQ group above personal cards; both listings in `ALL_PLATFORM_AREAS` order |
| D3 | Reuse section keys, no seed | Overview blocks live under `ops_overview`; `ops_platform_health` stays "Platform Health" (compact posture) — no seed on any environment |
| D4 | Username-only owner via a separate CUSTOMER_SUCCESS READ endpoint; column absent on 403 | `lib/platform/customer/connection-owners.ts` + route; `operatorDisplayName` (username → name → opaque); verified on Preview (`karisb`, `bjj`) |
| D5 | PLATFORM_OPS READ-gated, identity-minimized incident projection | `lib/platform/incidents/platform-projection.ts` (keys pinned), consumed by `attention.ts` |
| D6 | Narrow Platform Ops activity feed | `lib/platform/activity/operator-feed-core.ts` (ten actions by target kind), `/platform-ops/activity`, last 20, depth stated |
| D7 | Reason on refresh-cadence changes | PATCH/DELETE `/platform-ops/policies` require `reason {code, note?}`; audit via the operator-action envelope; `PLATFORM_POLICY_CHANGED/RESET` in `REASON_REQUIRED_ACTIONS` |
| D8 | Refresh per-day projection | inside the pinned seam (`projections.ts`), `/refresh/daily` |
| D9 | Provider rows beyond Plaid/OXR as separate authorities | Resend from email-health; OpenAI rendered `Unavailable` with reason (no PLATFORM_OPS route over `AiFailureHealth`) |
| D10 | Per-job run route | deferred (recorded below) |
| D11 | Explore grid → doorway row | `01586f9` |
| D12 | Hero kept, trimmed | `1bea4cc` |
| D13 | Token aliases | `749bdf0` |
| D14 | No recharts | all charts are SVG/CSS primitives |

## 4. Gates and evidence

| Gate | Result | Evidence |
|---|---|---|
| Per-agent tests, agent worktrees | green (agent-reported) | hand-offs; re-run by the coordinator at merge |
| Coordinator re-runs on the merged tree | green | 17 test files across the five workstreams after `cedabf2`; 4 after the fixture fix; 4 after the pin fix |
| `npx tsc --noEmit` | 0 errors outside gitignored `prototype/`/`tmp/` after `69db6f4` | ten merge-only fixture errors found and fixed |
| Clean-worktree `next build` (Turbopack, own `npm ci`) | **passed** at `69db6f4` | compiled, type-checked, 147 static pages; later commits touch a comment, tests, docs, two JSX layout lines |
| `npm run ci` (clean copy, Node 24, throwaway Postgres) | `69db6f4` **red** (unit: two source-scan pins) → `c9ef14c` **PASSED** | 704/704 unit files, typecheck, lint, 25/25 audits, RLS 34/34 · 98/98 · 72/72 · 20/20 · 67/67, site verify |
| GitHub CI on `837a57b` | run 38636373842: `test` **failure**, Architecture audits and Public site **success** | the one red file is `app/api/health/route.test.ts` ("call 31 within a minute is 429 — got 503"): the limiter's calendar-minute window was straddled while each call waited on the test's deliberately unreachable DB. No commit in dd39087..837a57b touches `app/api/health/**`, `lib/rate-limit.ts` or the runner; the same test passed in run 37701282029 and in the local clean copy. The failed job was re-run on the same SHA (`gh run rerun --failed`): **`test` success**, all three jobs success — the first attempt was a timing flake, not a regression |
| GitHub CI on `6f3162c` | run 38637267684 — **success** (test, Architecture audits, Public site) | the pushed HEAD's run is green on its first attempt |
| Preview (`preview-app.fourthmeridian.com`) | **verified on `837a57b`** (deployment `fintracker1-up42lbypg`, `/api/health` → `commit: 837a57b`); `6f3162c` **verified** afterwards (`/api/health` → `commit: 6f3162c`; jobs matrix and refresh activity render at full width; activity feed, Platform Health and the Explore row unchanged) | browser pass below |
| STATUS drift guard (first push run) | 38636373773 **success**, no annotation | the push touched STATUS.md |

**Browser pass on 837a57b (Preview, desktop width, operator with PLATFORM_OPS CONTROL + CUSTOMER_SUCCESS):**
- Sidebar lists Overview · Jobs · Policies · Pipeline · Providers · History · AI · Economics as the switcher; the rail is hidden at desktop width; Sections list beneath; Platform group of five beneath that.
- Overview: hero (eyebrow, question, lede); status board "Operations" — Failed · "Something has failed" · checked · policy strip with Policies doorway; six tiles (Refresh pipeline Healthy "0 of 1 failed", Sources Stale "2 stale", Scheduled jobs Failed "1 failing", Daily Brief Healthy "1 generated", AI, Plaid) each with a doorway; posture row Alerts "Firing 2 of 5", Providers "Stale data 0 of 2 operational", Freshness "Stale 2 of 2 not fresh", Configuration "Set 14 of 14 · preview"; "Technical details" disclosure; one-sentence footnote.
- Attention required (9): severity pills All/Critical 1/Error 0/Warning 8/Info 0; rows for the dead `evaluate-alerts` job, two stale connections (Resync + Request reauthorization buttons), Plaid and OXR providers, FX Rates and Security Prices resources, two alert rules "firing in the latest evaluation"; evidence doorways; "Recent alert firings (historical, last 1 evaluation)" listed separately; footnote states rows restate verdicts.
- Connection health: fleet composition bar (Healthy 1 · Stale 2 · …), "3 live connections judged at … · not counted: 9 revoked", table Connection | State | Last sync | Stale for | Threshold (30 h policy) | Owner (`karisb`, `bjj`) | Action.
- Scheduled jobs (11): 1 dead · 10 never ran · 0 healthy (Preview has no crons — truthful); Refresh activity: by-status and by-trigger strips, executions and failures per UTC day, envelope caption.
- AI activity: calls per day, provider-call outcomes, estimated spend "estimate, not a bill"; Economics: Plaid cycle estimate with invoice readings, AI spend per day, "no actual-charge ledger" once in the footnote (after `d17a9e9`).
- Recent operator activity (7): when · operator · action · target (opaque) · result · evidence; depth line.
- Platform Health: four groups as badge + headline + ≤2 rows with Details disclosures; Alerts "Caution · 2 rules firing now".
- Explore: one row of seven text doorways.
- Deep link `?workspace=platform-policies` lands on Policies with the sidebar item active; Policies shows the two refresh columns with Default/Override/Floor/Max chips and Provenance, the grouped execution cadences, Edit / Reset controls.
- Pipeline via the sidebar: table, deployment boundaries, drawer and filters intact; Connection Health table beneath with the same renderer.

**Not verified in the browser:** narrow viewport (the managed Chrome window did not resize below ~1180 px; the `md:` collapse is pinned by render tests only); wallet rows (Preview holds no wallet connection); the owner column's absence for a single-grant operator (no such operator on Preview — the 403 path is pinned by tests).

## 5. What each workstream delivered (file-level summary)

See STATUS.md §6's per-agent table for the test lists. New routes: `platform-ops/attention`, `platform-ops/activity`, `platform-ops/refresh/daily` (PLATFORM_OPS READ), `customer-success/connection-owners` (CUSTOMER_SUCCESS READ); `platform-ops/alerts` gained `latest`/`historyRuns`; `platform-ops/policies` PATCH/DELETE gained `reason`. New readers: `lib/platform/ops/attention*.ts`, `lib/platform/incidents/platform-projection.ts`, `lib/alerts/latest-evaluation.ts`, `lib/platform/activity/operator-feed*.ts`, `lib/platform/customer/connection-owners.ts`, `getRefreshDailySeries` in `projections.ts`; `lib/connections/health.ts` and `overview-core.ts` extended additively. New UI: `components/platform/widgets/overview/*` (eight blocks + view-models + tests), `connection-health-table.tsx`, `connection-health-view.ts`, `provider-view.ts`, `refresh-activity-view.ts`, `jobs-matrix-view.ts`, `ai-economics-view.ts`, `activity-feed-view.ts`, `block-doorway.tsx`; `lib/space/use-platform-workspace-navigation.ts`. Primitives in `platform-surface.tsx`; `SpaceShell.railVisibility`; `SpaceChromeWorkspaceItem.icon`.

## 6. Deferred and follow-ups (owner to authorize)

1. `app/api/health/route.test.ts` depends on the wall-clock minute (flaked once on GitHub during this program; unrelated to the series) — freeze the window or make the burst independent of the calendar minute.
2. Provider table `Threshold` and `Affected connections` render `Unavailable`: additive fields on `lib/platform/provider-health.ts` would fill them honestly.
3. OpenAI provider row needs a PLATFORM_OPS route over `AiFailureHealth` (today only `lib/alerts/run.ts` reads it).
4. Per-job run page route to light the orphaned `ExecutionStrip`/`RuntimeTrend` (D10).
5. B8 policy audit history disclosure; a writer name on job-cadence override provenance (`JobCadenceView` carries none).
6. Narrow-viewport verification in a real phone-width browser.
7. Second-consumer promotion of `block-doorway.tsx` into `platform-surface.tsx` if other Spaces adopt the block pattern.
8. The other four Platform Spaces inherit navigation parity only; their content redesigns are separate owner-directed sessions.
9. `OpsRateLimitsWidget` / `OpsEnvStatusWidget` remain composed nowhere (absorbed into Platform Health) — candidates for deletion in a cleanup slice.

## 7. Process record

- Investigation (read-only, four reconnaissance agents + live Preview screenshots) → owner authorization with D1–D6 → base commit with frozen interfaces → five agents in worktrees with no database URL and `FM_DB_GUARD=clone-only` → merges 1, 4, 3, 2, 5 (`--no-ff`) → typecheck/test/build/CI gates → push → Preview verification → polish → push.
- Lessons recorded in the coordination contract and memory: typecheck after every merge (tsx never typechecks fixtures; two additive type changes collided only at merge); a clean build worktree needs its own `npm ci` (Turbopack refuses a node_modules symlink; the main checkout's gitignored `prototype/` trees fail its build); `npm run ci` refuses Node 26 — use the Homebrew Node 24; source-scan pins (comment words, literal return shapes) only show in the clean-copy gate.
- STATUS.md protocol (owner-set via the status session during the program): per integrated agent, verified results, IMPLEMENTED / TESTED / CI VERIFIED / DEPLOYED distinct; now part of the coordination contract for future programs.
- Worktrees removed after merge; branches `uxp1/base`, `uxp1/agent-1…5` kept (all merged into v2.6).

*Report written 2026-10-15 by the coordinator session. The 837a57b rerun (success), the 6f3162c run (success) and the 6f3162c Preview check (verified) concluded before this report was committed; STATUS.md §3/§13 carry the run rows as recorded by the status session.*
