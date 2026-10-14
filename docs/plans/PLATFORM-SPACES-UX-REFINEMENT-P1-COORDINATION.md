# PLATFORM SPACES UX REFINEMENT P1 — COORDINATION

**Authority:** `docs/plans/PLATFORM-SPACES-UX-REFINEMENT-P1-INVESTIGATION-2026-10-14.md` (the blueprint) + the owner's authorization of 2026-10-14 (decisions D1–D6 below). This file is the coordinator's working contract for the five implementation agents: ownership, frozen interfaces, rules, and the hand-off protocol. It is a working document, not a report.

## Owner decisions in force

| # | Decision |
|---|---|
| D1 | Desktop sidebar is the primary workspace switcher inside a Platform Space; the horizontal rail is kept for smaller screens (`railVisibility="belowLg"` for platform; personal Spaces byte-identical). |
| D2 | Personal Spaces and Platform Spaces stay separate: no Platform group inside a personal Space's sidebar. Improve Platform visibility on the Spaces page (HQ group above personal cards; canonical order). |
| D3 | Reuse existing section keys. No new keys, no schema change. `ops_overview` becomes the composer of Overview blocks; `ops_platform_health` becomes the compact technical-posture surface. |
| D4 | Username-only owner resolution through a separate CUSTOMER_SUCCESS READ endpoint. PLATFORM_OPS projections never carry email or internal identifiers. Owner column absent (not blank) when unauthorized. |
| D5 | Identity-minimized, PLATFORM_OPS READ-gated incident projection for Attention Required (subjects as institution·account labels, never a customer). |
| D6 | Narrow PLATFORM_OPS activity feed (operator actions whose targets are JOB, PLAID_ITEM, platform-setting, OPERATOR_REFRESH_ALL, connection resync/reauth, provider cleanup). Broader security events stay in Security Operations. |
| D7–D14 | Investigation recommendations: reason on the refresh-cadence PATCH (yes); refresh per-day projection (yes, strips are the floor); provider rows beyond Plaid/OXR only as separately-labelled authorities; per-job run route deferred; Explore grid reduced to a one-line doorway row (composition keeps ≥1 doorway); hero kept, trimmed; token aliases (done on base); no recharts. |

## Base branch

`uxp1/base` = v2.6 + the coordinator's base commit (primitives, token aliases, WidgetMessage live regions, Overview composer + block stubs, this doc). Every agent branch is cut from it: `uxp1/agent-N`. Agents commit on their branch; the coordinator merges into v2.6 with `--no-ff`.

## Frozen shared interfaces (coordinator-owned; do not edit, ask)

`components/platform/platform-surface.tsx` — new exports, consumers named in the census test:
- `ToneBadge({ word, tone: StatusTone })` — dot + word for any status vocabulary.
- `DistributionBar({ label, segments: {word,count,tone?}[], caption?, floor?, emptyText? })` — word+count composition.
- `StatusTile({ label, word, tone, figure, qualifier?, hint?, onOpen?, openLabel? })` — status-board unit.
- `MiniBars({ label, points: {key,value|null,tone?,title?}[], format, caption?, height? })` — per-bucket bars, `null` = gap.
- `PillGroup({ label, value, options, onChange })` — filter pills (`role="group"`, `aria-pressed`).
- Existing: `SectionSurface`, `GroupLabel`, `BigStat`, `TwoLine`, `KeyRow`, `StatusWord`, `Unavailable`, `Provenance`, `VRule`, `TONE_COLOR`, `StatusBadge`, `ExecutionStrip`, `RuntimeTrend`, `PanelSection`.

`components/platform/widgets/overview/block-contract.ts` — `OverviewBlockProps { onOpenWorkspace?, access? }`, `StatusBoardProps { title }`. Block files are stubs returning `null`; the owning agent replaces the body, keeps the export name.

Tokens: `--success-400`, `--warning-400`, `--danger-400` now exist as aliases; prefer `TONE_COLOR` / `--emerald-400` / `--accent-warning` / `--coral-400` in new code.

Tone vocabulary: `StatusTone = ok | info | warn | bad | muted`. Map your authority's words to tones in a pure `*-view.ts`; never merge vocabularies.

## File ownership (exclusive)

| Agent | Owns | Must not touch |
|---|---|---|
| **Coordinator** | `platform-surface.tsx` (+test), `widget-kit.tsx`, `globals.css`, `lib/platform/workspaces.ts`, `lib/platform/policy.ts`, `lib/platform/seed.ts`, `PlatformSpaceDashboard.tsx` **registry + doorway blocks**, `OpsOverviewWidget.tsx`, `overview/block-contract.ts`, this doc | — |
| **Agent 1 · Navigation** | `PlatformSpaceDashboard.tsx` **navigation/state block only** (rail state, publishers, `SpaceShell` props), `app/(shell)/dashboard/platform/[area]/page.tsx`, `lib/space/space-url.ts`, `components/ui/ContextualNavbar.tsx`, `components/space/shell/SpaceShell.tsx`, `components/dashboard/SpacesClient.tsx`, `app/api/spaces/route.ts`, `app/(shell)/dashboard/spaces/page.tsx`, nav tests (`space-markets-nav.test.ts`, `space-workspace-nav.test.ts`, `platform-shell.test.ts`, `space-url-authority.test.ts`, `mount-context.test.ts`) | widget files, registry block |
| **Agent 2 · Status board + Attention + Posture** | `overview/StatusBoard.tsx`, `overview/AttentionBlock.tsx`, `widgets/ops-overview-view.ts`, `widgets/OpsPlatformHealthWidget.tsx`, `widgets/platform-health-view.ts`, `widgets/platform-health.test.ts`, `lib/platform/ops/overview.ts`, `lib/platform/ops/overview-core.ts`, new `lib/platform/ops/attention*.ts`, new `app/api/platform/platform-ops/attention/route.ts`, `app/api/platform/platform-ops/alerts/route.ts`, `lib/alerts/run.ts` (expose latest-run `firing`), new `lib/platform/incidents/platform-projection.ts` (D5) | `lib/connections/health.ts` (read only), job-health reader |
| **Agent 3 · Connections + Providers** | `overview/ConnectionHealthBlock.tsx`, `widgets/OpsConnectionHealthWidget.tsx`, `widgets/OpsProviderHealthWidget.tsx`, new `widgets/connection-health-view.ts`, `lib/connections/health.ts` (additive fields only), new `lib/platform/customer/connection-owners.ts`, new `app/api/platform/customer-success/connection-owners/route.ts`, `lib/platform/observability-privacy.test.ts` (add the new reader to the scan), `widgets/OpsConnectionDiagnosticsWidget.tsx` (optional grain) | attention reader (Agent 2 consumes `ConnectionHealthRow` — keep every existing field and name) |
| **Agent 4 · Refresh + Jobs + Pipeline** | `overview/JobsMatrixBlock.tsx`, `overview/RefreshActivityBlock.tsx`, `lib/platform/refresh/projections.ts` (add the per-day series; the seam set is pinned), `lib/platform/refresh/types.ts`, new `app/api/platform/platform-ops/refresh/daily/route.ts`, `widgets/OpsRefreshSummaryWidget.tsx`, `widgets/OpsRefreshExecutionsWidget.tsx`, `widgets/OpsRefreshCoverageWidget.tsx`, `widgets/refresh-widgets.test.ts`, `widgets/jobs-view.ts` (if a compact projection helper is needed) | `OpsJobHealthWidget.tsx` (read only, reuse its grammar) |
| **Agent 5 · AI + Economics + Activity + Policies** | `overview/AiActivityBlock.tsx`, `overview/EconomicsBlock.tsx`, `overview/ActivityFeedBlock.tsx`, `widgets/OpsAiTrendWidget.tsx`, `widgets/OpsCostWidget.tsx`, `widgets/OpsPlaidUsageWidget.tsx`, new `lib/platform/activity/operator-feed.ts` + `app/api/platform/platform-ops/activity/route.ts` (D6), `widgets/OpsPoliciesWidget.tsx`, `widgets/policies-view.ts`, `widgets/policies.test.ts`, `widgets/OpsAlertsWidget.tsx`, `lib/platform/policies/mutate.ts`, `app/api/platform/platform-ops/policies/route.ts`, `lib/audit.ts` (`REASON_REQUIRED_ACTIONS` only) | `lib/platform/security/*` (read only; reuse `projectOperatorActionEvent`) |

Anything not listed: ask the coordinator before editing. New files under your directories are yours.

## Rules every agent follows

1. **Read-only everywhere else.** Reuse existing readers, routes, view-models and primitives. No new dependency. No schema change. No new grant. No seed run.
2. **Data integrity.** Never fabricate a metric; never render a historical alert as open; keep unknown / unavailable / unobserved / zero / healthy distinct (`Unavailable`, "not observed"); label every dollar an estimate; floors say "floor".
3. **Authority.** Presentation derives no verdict; words + tones come from the authority through a pure view-model. New readers that compose authorities declare their rank and their `basis`. Every route: `requirePlatformAccess(<area>, "READ")` first; mutations `requireFreshPlatformAccess`.
4. **Privacy.** PLATFORM_OPS projections carry no email, no userId, no address, no token. Owner labels only from the CS route via `operatorDisplayName` (username → name → opaque). Keep `observability-privacy.test.ts`, `read-boundary.test.ts`, `capability-control.test.ts` green (extend the lists, never loosen).
5. **Client boundary.** `"use client"` files import only client-safe modules (view-models, `identity-label.ts`, types via `import type`). Never import `customer-core.ts`, a reader, or anything reaching `server-only` (c20c741).
6. **Grammar.** `SectionSurface` once per surface; tokens only (no hex, no `text-gray-*`); collapse with `md:` classes, never `matchMedia`; colour never alone; nothing truncated or hover-only; `scroll-mt-20` on anchors; `gap-8 md:gap-10` rhythm; `tabular-nums` on numbers; UTC-stable formatting (`lib/format`, `nowMs` as a prop in pure helpers).
7. **Fetching.** `useWidgetFetch("<static literal>")` or `useSharedWidgetFetch` (same workspace dedupe) or `useKeyedFetch` + `key` remount for parameterised reads. No polling.
8. **Tests.** Add/adjust the tests of your files (tsx scripts, `renderToStaticMarkup`, no DOM). Run them: `npx tsx --require ./scripts/lib/server-only-preload.cjs <file>`. Run `npx tsc --noEmit -p tsconfig.json` once before hand-off (slow; filtered output is only a hint). Run `npx eslint <your files>`.
9. **Database.** Your worktree has no `DATABASE_URL`; `FM_DB_GUARD=clone-only` is set in its `.env.local`. Do not add a URL. Do not run migrations, seeds, scripts or tests that need a database — report them as integration requirements.
10. **Git.** Work only in your worktree on `uxp1/agent-N`. Commit logically with descriptive messages (house style: a slice name, what was wrong, what is true now). Never rebase, reset, force-push, stash-pop or touch another branch. Do not push.
11. **Hand-off.** Final message to the coordinator: commits (SHA + title), files changed, tests run with results, integration requirements (registry entries, composition, seed/label, env), open questions, and anything you deliberately left out.

## Integration (coordinator)

Merge order: Agent 1 → 2 → 3 → 4 → 5 (nav first because it touches the dashboard host). Then: registry/composition/doorway row/`ops_platform_health` label converge, `npm run build`, `npm run ci`, push explicit SHA, GitHub CI, Preview seed (label converge only), Preview verification, final report.
