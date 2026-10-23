# 09 — Spaces Scorecard

Pre-beta audit of Fourth Meridian · `v2.6` · HEAD `cde8fa0e25d2c744933109b41611d1dd65a1f9a8` · 2026-10-21 · read-only, from code. No running app, browser or database was available: every rendered-output, focus-order, screen-reader, touch-target and narrow-viewport statement is **UNVERIFIED** and scored from markup and the UI hardening report's own unverified list. Finding IDs `UI-nnn`. The Spaces were discovered from `lib/space-nav.ts`, `lib/perspectives.ts`, `lib/platform/workspaces.ts` (`PLATFORM_AREA_WORKSPACES`), the widget registry, every `app/**/page.tsx` and all 187 API routes, not assumed.

## 1. Verdict

Server-side gating is correctly placed everywhere it was read: every `app/api/platform/**` GET requires `READ`, every mutation `requireFreshPlatformAccess(WRITE|CONTROL)` with the operator envelope; admin mutations use `requireFreshSystemAdmin` plus an audit row; every `/api/spaces/[id]/*` re-runs the membership check. No P0 (no cross-customer exposure, no operator control unenforced server-side).

The weaknesses are product and operability, not authorisation: the customer Space turns outages into false empty states and has no `error.tsx` or `loading.tsx` anywhere under `app/`; member removal, role change and Space archive are single-click; five operator widgets ignore the access level they are given and show WRITE controls to READ holders; Customer Success fabricates an audit reason; every platform widget is a one-shot snapshot whose "N ago" labels freeze at mount; Markets is a reachable stub; Credit is an orphaned pre-redesign page. Aggregate scores: **customer-facing Spaces 6.1 / 10**, **operator-facing Spaces 6.4 / 10**.

## 2. Navigation model

| Axis | How reached | Gate | Evidence |
|---|---|---|---|
| Primary (customer) | `PRIMARY_NAV` = Brief · My Space · AI · Spaces · Connections; one list drives the desktop sidebar and `BottomNav` (`lg:hidden`) | `proxy.ts` JWT on `/dashboard/*`; `app/(shell)/dashboard/layout.tsx:31-32` revocation-aware re-check | `lib/space-nav.ts:98-116`; `components/ui/BottomNav.tsx:22-30` |
| Settings | `UserMenu` → `/dashboard/settings` (rail: Account, Security, Preferences, Notifications, Data & Privacy; archived assets off-rail) | same | `components/ui/UserMenu.tsx:102-111`; `lib/settings/workspaces.ts:52-56` |
| Credit | no nav entry; reachable only from `FicoCard` links inside Net Worth → Debt | page gate | `components/dashboard/FicoCard.tsx:49,84` |
| Space workspaces | sidebar `workspaceNav` (lg+): Net Worth {Total, Assets, Debt} · Cash Flow · Markets; rail: Overview · Activity · Accounts · Transactions · Members; `?workspace=` URL authority | membership via `getSpaceContext()`; every `/api/spaces/[id]/*` re-runs `requireSpaceRole` | `components/dashboard/SpaceDashboard.tsx:360-404`; `lib/space-nav.ts:45-51` |
| Platform context switch | header segment "Personal / Platform Spaces" shown only when `hasPlatformGrants` (server-counted, fail-closed) | `lib/platform/directory.server.ts:46-54` | `components/ui/PlatformContextSwitch.tsx:17-30` |
| Platform directory and Spaces | `/dashboard/platform` (HQ cards; zero grants ⇒ redirect) → `/dashboard/platform/[AREA]?workspace=` | session + ACTIVE grant with READ ⇒ else redirect, never 404 | `app/(shell)/dashboard/platform/[area]/page.tsx:97-137`; `lib/platform/workspaces.ts:107-164` |
| SYSTEM_ADMIN | `proxy.ts` sends any SYSTEM_ADMIN off `/dashboard/*` to `/admin`; the break-glass admin has no UI path to any Platform Space | role in JWT | `proxy.ts`; `app/admin/layout.tsx:11-14` |
| Admin area | `AdminNav`: Overview · Users · Spaces · Providers · Audit Log · Security · Platform Access | `requireSystemAdmin` / `requireFreshSystemAdmin` | `components/admin/AdminNav.tsx:8-14` |
| Merchant Ops | `/merchant-ops` page outside the shell, reached from `MerchantReviewWidget` | `requirePlatformAccess("MERCHANT_OPS","READ")`; WRITE on decide | `app/merchant-ops/page.tsx:11-16` |
| Prototype pages | gitignored, not deployed | — | `git ls-files app/prototype` = 0 |

Error and loading surfaces: `find app -name error.tsx -o -name loading.tsx -o -name not-found.tsx` → only `app/global-error.tsx`; route transitions use `<Suspense fallback={null}>`.

## 3. Space inventory

### 3.1 Customer Spaces

| Workspace / page | Panels / cards | Data routes & loaders | Mutations (method route) | Server gate (as enforced) | Audited | Confirm | Status |
|---|---|---|---|---|---|---|---|
| **My Space shell** (`/dashboard`) | `SpaceShell`, rail, lens row, `ShellTrustRow`, freshness line "Last checked N ago" | RSC `composeFinancialInitialWorkspace`; client `/api/money/view-context`, `/api/spaces/[id]/perspectives`, `/snapshots`, `/transactions` (5 000 cap), `/expense-baseline` (Assets) | Leave: `DELETE /api/spaces/[id]/members/{self}` | `requireSpaceRole(VIEWER)` + self | `SPACE_LEAVE` via `emitDomainEvent` | `ConfirmDialog` | IMPLEMENTED |
| Net Worth → Total / Assets / Debt | WealthHero, Composition, ChangeLedger, Explanation, TrendChart, RealAssets, CreditHealthInputs/FicoCard | `liquidity/space-data`, `investments/space-data`, `accounts/detail`, `accounts/manual/[id]/valuations`, `debt/space-data` | `PATCH/DELETE /api/accounts/manual/[id]`; `POST /api/spaces/[id]/wealth/amend` (503 `AMENDMENT_DISABLED` by F1 switch); `PATCH /api/credit/update-fico`; `PATCH /api/accounts/[id]/debt-profile` | manual: `requireUser`+owner; amend: `requireSpaceRole(OWNER)`; fico/debt-profile: `requireUser` | manual yes; debt-profile `DEBT_PROFILE_UPDATED`; **fico: none**; amend: none in route | archive asset: `ConfirmDialog` | IMPLEMENTED (amend action OFF) |
| Cash Flow | hero, category/cash-in/income ledgers, insights, `TransactionCoverageNote` when truncated | host `transactions` array only (client fold `buildCashFlowSpaceData`) | none | — | — | — | IMPLEMENTED |
| Markets | view chips + one empty paragraph per view; `dataNeeds: []`; self-described "THIS IS A SHELL" (`MarketsWorkspace.tsx:11`) | none | none | — | — | — | **STUBBED** (registry status `available`, bypasses `comingSoon`) |
| Activity | hero + date-banded feed, `aria-pressed` rows, Retry | `GET /api/spaces/[id]/activity` — `requireSpaceAction("activity:read")`, hard `.slice(0,60)` (`route.ts:582`) | none | | | | IMPLEMENTED (no pagination, cap undisclosed) |
| Accounts | grouped ledger, search, RightPanel detail | `GET /api/spaces/[id]/accounts/detail` (VIEWER) | rename `PATCH /api/accounts/[id]`; remove-from-Space `DELETE /api/spaces/[id]/accounts/share` | owner / `account:share` + adder-or-ADMIN | `ACCOUNT_RENAMED` only on displayName; creditLimit/interestRate/minimumPayment/debtSubtype **unaudited**; `ACCOUNT_REVOKED` | **none** on remove | IMPLEMENTED |
| Transactions | toolbar, filters overlay, keyset ledger, shell-level `TransactionDetailDrawer`, `TransactionCorrection` | `GET /api/spaces/[id]/transactions/query` (VIEWER); `GET /api/transactions/[id]` | `POST /api/transactions/[id]/correct` | `requireUser` + `requireSpaceAction(activeSpace,"transaction:correct")` MEMBER+; row scoped by `transactionDetailWhere(id, spaceId)` to the same active Space (verified `correct/route.ts:88-124`) | **none** | none | IMPLEMENTED; no delete route exists |
| Members | hero, roster → detail, invite form, pending queue | `GET /api/spaces/[id]`, `/invites` (ADMIN) | invite POST (ADMIN); rescind DELETE (ADMIN); role PATCH (OWNER); remove DELETE (self or ADMIN/OWNER) | as listed | invite/role/remove emit events; **rescind + decline unaudited** | **none** for remove / role change | IMPLEMENTED |
| Manage Space modal | General · Members · Add Accounts · Overview · Delete/Leave | `/api/spaces/[id]`, `/accounts`, `/sections` | `PATCH /api/spaces/[id]` (ADMIN; archive OWNER); `DELETE` (OWNER); share POST; `PATCH /sections/[sectionId]` (ADMIN) | as listed | SPACE_* yes; share yes; sections **none** | trash 2-step; **archive 1 click**; leave 1 click | IMPLEMENTED; "Saved layouts" = **PLANNED** ("Coming soon", `OverviewSectionsPanel.tsx:127-129`); Shown/Hidden toggles near-inert (`SpaceDashboard.tsx:574-581`) |
| **Brief** `/dashboard/brief` | hero, Live-now, attention/knowing, per-source data health | RSC `readBriefResponse`; `GET /api/brief?spaceId` | `POST /api/brief/generate` | `requireUser` + entitlement + `limitByUser` + kill switch + allowance reservation (`generate/route.ts:38-68`) | AiInvocation rows | n/a | IMPLEMENTED |
| **AI** `/dashboard/analyze` | conversation, composer, knowledge-gap cards, memory panel | RSC advice+memories; `GET /api/ai/memory` | `POST /api/ai/chat`; `PATCH/DELETE /api/ai/memory/[id]` | chat: `requireUser` + entitlement + 2 limiters + kill switch + reservation (`chat/route.ts:98-150`); memory: `requireUser` + 30/min + Space match | `AI_MEMORY_ERASED`; invocation rows | n/a | IMPLEMENTED |
| **Connections** `/dashboard/connections` | utility shell, cards with three freshness lines, progress (`role="progressbar"`), import wizard, empty state | RSC `loadConnectionsSpaceData` (15 s phase timeout); poll `GET /api/sync/status` 4 s × 120 | Plaid link/exchange/refresh/resume-sync, `connections/[id]/disconnect`, `build-intelligence`, `accounts/wallet`, `accounts/manual`, `accounts/[id]/sync`, import + rollback | all `requireUser`; refresh/sync/exchange/build rate-limited; import/rollback `requireFreshUser` | most yes; **exchange-token / resume-sync / accounts/[id]/sync: no audit row** | disconnect & import: `ConfirmDialog` | IMPLEMENTED; Plaid gated by `env.isPlaidEnabled` → "being set up — check back soon" |
| **Spaces** `/dashboard/spaces` | my cards (net worth, trend, freshness "≈"), public list, invite banner, `CreateSpaceModal` | RSC (three reads on bare `db`, documented: roster/inviter display); `POST /api/spaces/invites/seen` | switch `POST /api/space/switch`; accept/decline `PATCH …/invites/[inviteId]`; create `POST /api/spaces` | `requireUser` (+ invitee / membership) | switch, create, accept yes; decline no | none; failures silent (`SpacesClient.tsx:777-779, 972`) | IMPLEMENTED; public join = **PLANNED** (disabled "coming soon", `:708-713`) |
| **Credit** `/dashboard/credit` | FICO input, utilization tiles, card list with inline editors, client-paginated debt tx list | RSC | `PATCH /api/credit/update-fico`; `PATCH /api/accounts/[id]`; `PATCH …/debt-profile` | `requireUser` | fico + limit/subtype **unaudited** | none | IMPLEMENTED (orphaned, pre-Atlas) |
| **Settings** `/dashboard/settings/*` | Account, Security (TOTP, sessions), Preferences, Notifications, Data & Privacy (export, deactivate, delete, archive bin link), Archived assets | per-page server loaders | profile, password, email change, TOTP setup/verify/disable/recovery, sessions revoke, notification prefs, export, deactivate, delete, archive-bin restore/permanent | see §3.3 | profile/password/email/TOTP/sessions/export/deactivate/delete yes; **notification-preferences none**; recovery-codes none in route | TOTP disable `alertdialog`; delete/deactivate password; sessions self 2-click; **revoke-other no confirm** | IMPLEMENTED |

### 3.2 Platform Spaces (registry → widgets → routes → mutations → grant)

Gate key: R = `requirePlatformAccess(area,"READ")`; FW = `requireFreshPlatformAccess(area,"WRITE")`; FC = `…"CONTROL"`. "Client gate" = whether the widget reads `access` before rendering a control. Audit: rOA = `recordOperatorAction` envelope; raw = legacy `auditLog.create`.

**PLATFORM_OPS** (`lib/platform/workspaces.ts:107-141`): Overview · Jobs · Policies · Pipeline · Providers · History · AI · Economics.

| Workspace → section key | Widget | Reads | Mutations | Route gate | Client gate | Confirm / reason / token | Audit | Status |
|---|---|---|---|---|---|---|---|---|
| Overview → `ops_overview` | `OpsOverviewWidget` (composer of 8 blocks) | `/overview`, `/attention`, `/connection-health` (+`customer-success/connection-owners`), `/job-health`, `/refresh/summary`, `/refresh/daily`, `/ai-usage-trend`, `/ai-invocations?window=30d`, `/ai-spend`, `/plaid-usage`, `/activity` | `POST /connections/[id]/resync` · `/request-reauth` (AttentionBlock) | FW | yes (`access.canWrite`, `AttentionBlock.tsx:152,508`) | ConfirmDialog; no reason (exempt); no token | rOA `CONNECTION_RESYNC_TRIGGERED` / `CONNECTION_REAUTH_REQUESTED` | IMPLEMENTED |
| Overview → `ops_platform_health` | `OpsPlatformHealthWidget` | `/alerts`, `/provider-health`, `/resource-freshness`, `/rate-limits`, `/env-status` (5 unshared GETs, duplicating what `/overview` already folded) | none | R | n/a | | | IMPLEMENTED |
| Jobs → `ops_scheduler` | `OpsSchedulerWidget` | `/scheduler` | none ("no scheduler-health authority" by doctrine) | R | | | | IMPLEMENTED |
| Jobs → `ops_job_health` | `OpsJobHealthWidget` + `JobDetailPanel` | `/job-health` | none; "Commands" and "Maintenance mode" rendered `disabled` with explanatory `aria-label` (`:263-271, :393-407`) | R | | | | IMPLEMENTED (controls PLANNED) |
| Jobs → `ops_manual_operations` | `OpsManualOperationsWidget` | `/operations` | `POST /operations {commandId}` (Run Now / Dry Run) | FW; `limitByUser("platform-operation",30/min)` | **none** (`:49` takes only `section`) | ConfirmDialog only when `command.mutates`; Dry Run immediate; no reason | rOA `PLATFORM_OPERATION_EXECUTED|DRY_RUN` | PARTIAL |
| Policies → `ops_policies` | `OpsPoliciesWidget` + `AiCostControlsPanel` | `/policies`, `/job-cadence`, `/ai-cost-controls` (shared session) | `PATCH|DELETE /policies`, `PATCH|DELETE /job-cadence`, `PATCH /ai-cost-controls {changes[],reason}` | **FC** on all three; shared `limitByUser("platform-policy",30/min)` | yes (`access.canControl`; READ/WRITE see no control; pinned by `policies.test.ts:123-126`, `ai-cost-controls.test.ts`) | reason select with no default + ≤280 note; `expectedUpdatedAt` version token; 409 returns canonical model; pause/resume + disable-enforcement two-step armed confirm | rOA `PLATFORM_POLICY_CHANGED|RESET`, `JOB_CADENCE_CHANGED|RESET`, in-transaction | IMPLEMENTED |
| Policies → `ops_alerts` | `OpsAlertsWidget` ("Alert rules (read-only)") | `/alerts` | none | R | | | | PARTIAL (stale copy; `latest` firing-now not rendered) |
| Pipeline → `ops_refresh_executions` | `OpsRefreshExecutionsWidget` + `ExecutionTimelinePanel` | `/refresh/executions?limit=30[&filters][&cursor]`, `/refresh/executions/[id]`, `/[id]/timeline` | none | R | | | | IMPLEMENTED |
| Pipeline → `ops_refresh_summary` / `ops_refresh_coverage` | `OpsRefreshSummaryWidget`, `OpsRefreshCoverageWidget` | `/refresh/summary`, `/refresh/coverage` | none | R | | | | IMPLEMENTED |
| Pipeline & Providers → `ops_connection_health` | `OpsConnectionHealthWidget` (+ `connection-health-table`) | `/connection-health` (+ CS owners; 403 ⇒ column absent) | resync / request-reauth | FW | yes (`:122`; READ gets "Running them needs WRITE access…") | ConfirmDialog | rOA | IMPLEMENTED |
| Providers → `ops_provider_health` | `OpsProviderHealthWidget` | `/provider-health`, `/email-health` | none | R | | | | IMPLEMENTED (OpenAI row permanent `Unavailable`) |
| Providers → `ops_provider_operations` | `OpsProviderOperationsWidget` | `/refresh/provider-operations` | none | R | | | | IMPLEMENTED |
| Providers → `ops_connection_diagnostics` | `OpsConnectionDiagnosticsWidget` | `/connection-diagnostics` | none | R | | | | IMPLEMENTED |
| Providers → `ops_provider_cleanup` | `OpsProviderCleanupWidget` | `/provider-cleanup` | `POST /provider-cleanup {plaidItemId}` (Retry cleanup) | FW | **none** (`:45`) | no confirm, no reason | rOA `PLAID_ITEM_REVOCATION_RETRY_REQUESTED` | PARTIAL |
| Providers → `ops_api_usage` | `OpsApiUsageWidget` | `/api-usage` | none | R | | | | PARTIAL (label bug `:43`) |
| Providers → `ops_resource_freshness` | `OpsResourceFreshnessWidget` | `/resource-freshness` | none | R | | | | IMPLEMENTED |
| Providers → `ops_email_delivery` | `OpsEmailDeliveryWidget` | `/email-health` | none | R | | | | PARTIAL ("All emails delivered" overclaim `:40`) |
| History → `ops_history` / `ops_convergence` / `ops_timeline` | `OpsHistoryWidget`, `OpsConvergenceWidget`, `OpsTimelineWidget` | `/history`, `/convergence` | none | R | | | | IMPLEMENTED / IMPLEMENTED / PARTIAL (colour-only outcome dot `:44`) |
| AI → `ops_ai_invocations` / `ops_brief_ops` / `ops_ai_trend` | `OpsAiInvocationsWidget`, `OpsBriefOpsWidget`, `OpsAiTrendWidget` | `/ai-invocations?window=…`, `/brief-ops?window=…`, `/ai-usage-trend`, `/ai-spend` | none | R | | | | PARTIAL (stale caveat `:31`; "Spend (exact…)" `:80`) / IMPLEMENTED |
| Economics → `ops_ai_budget` / `ops_plaid_usage` / `ops_cost` / `ops_ai_trend` | `OpsAiBudgetWidget`, `OpsPlaidUsageWidget`, `OpsCostWidget` | `/ai-budget`, `/plaid-usage`, `/cost` | none (budget says "changed there, never here") | R | | | | IMPLEMENTED (`ops_ai_budget` DB row must be seeded per env — create-only seed `lib/platform/seed.ts:35-37,117-165`); plaid-usage unguarded `cycles[0]` (`:57,64`); cost `spend-usd` always unknown (`lib/platform/cost/cost.ts:103-106`) |
| (absorbed) `ops_rate_limits`, `ops_env_status` | `OpsRateLimitsWidget`, `OpsEnvStatusWidget` | `/rate-limits`, `/env-status` | | R | | | | registered, composed nowhere (represented by Platform Health) |
| (no widget) | — | `/db-authority` (FR, 503 when not isolated) | | | | | | route with **no reader** |

**SECURITY_OPS**: Overview → `sec_auth_posture` → `SecAuthPostureWidget` → `SecurityPostureWidget` (Detections · Coverage · Notes) over `security-ops/anomalies`, `auth-posture`, `audit`, `operator-actions`, `sessions` (all R). **No mutation on the entire Space**; Notes column states "session revocation is a SYSTEM_ADMIN capability elsewhere" (`security-posture-view.ts:191-203`). The four card widgets (`sec_anomalies`, `sec_audit_feed`, `sec_operator_actions`, `sec_sessions`) export `null` renderers and are declared absorbed (`workspaces.ts:191-194`). IMPLEMENTED (observation only).

**GROWTH_REVENUE**: Overview → 7 sections.

| Section | Widget | Reads | Mutations | Route gate | Client gate | Confirm / reason | Audit | Status |
|---|---|---|---|---|---|---|---|---|
| `growth_signups` | `GrowthSignupsWidget` | `/signups` | — | R | | | | IMPLEMENTED ("no revenue data source until v3.0") |
| `growth_product_analytics` | `GrowthProductAnalyticsWidget` | `/product-analytics` (no-store) | — | R | | | | IMPLEMENTED |
| `growth_beta_requests` | `GrowthBetaRequestsWidget` | `/requests`, `/beta-status` (failure swallowed `:113`) | `PUT /registration-mode`, `PUT /product-status`, `POST /invitations`, `POST /requests/[id]/{approve,deny,resend,revoke}` | FW | **none** (`:87`) | confirm only for mode / product-status / revoke; approve/deny/resend/invite one click; no reason (exempt) | raw `BETA_*` with **customer email in metadata** | PARTIAL |
| `growth_users` | `OpsUsersWidget` | `/users?search=` | `POST /users/[userId] {action, reason}` (deactivate/reactivate) | FW; guards not-self, not-SYSTEM_ADMIN | **none** (`:39`) | inline reason panel, **preselected `SUPPORT_REQUEST`** (`:47`); no dialog | rOA `ACCOUNT_DEACTIVATED|REACTIVATED` in tx | PARTIAL |
| `growth_activity` | `OpsActivityWidget` | `/activity` (renders Space names) | — | R | | | | IMPLEMENTED |
| `growth_funnel` | `OpsGrowthWidget` + `FunnelStages` + `GrowthStagePanel` | `/growth` | — | R | | | | IMPLEMENTED |
| `growth_policy_groups` | `GrowthPolicyGroupsWidget` (only semantic `<table>`) | `/policy-groups` | — | R | | | | IMPLEMENTED |

**CUSTOMER_SUCCESS**: `cs_customers` → `CsCustomersWidget`: reads `/customers?search=&limit=100`, `/customers/[id]`; mutations `POST …/[id]/policy` (group / overlay / `aiDailyUsdAllowanceOverride` + reason), `POST …/[id]/cohort` (+ reason), `POST …/[id]/refresh` (**no reason, no confirm**, `maxDuration=300`), deactivate via the GROWTH route with `reason ?? {code:"SUPPORT_REQUEST"}` (`:171-172`). Route gate FW on all; client gate **none** (`:68`); audit rOA (`CUSTOMER_POLICY_ASSIGNED|OVERLAY_CHANGED|AI_ALLOWANCE_OVERRIDE_CHANGED|COHORT_ASSIGNED`, `OPERATOR_REFRESH_ALL`). Identity (email/name/username) shown by owner ruling. PARTIAL. `cs_sync_issues` → `CsSyncIssuesWidget`/`IncidentPreview` over `/sync-issues` (R, 6 shown / 200 scanned, `truncated` floor). IMPLEMENTED.

**MERCHANT_OPS**: `merchant_review` → `MerchantReviewWidget` = a link to `/merchant-ops`; that page lists `getPendingMergeCandidates` and `MergeReviewList` posts to `POST /api/merchant-ops/decide` (FW; `applyMergeReviewDecision` writes `MERCHANT_MERGE_APPLIED|DISMISSED` audit rows in-transaction, `lib/transactions/merchant-merge-review.ts:181,217`). `canDecide` is computed server-side and passed down (`app/merchant-ops/page.tsx:14`). IMPLEMENTED (doorway + plain page).

### 3.3 Admin area (`/admin/*`, SYSTEM_ADMIN only)

| Page | Reads | Mutations | Gate | Audit | Confirm |
|---|---|---|---|---|---|
| Overview | RSC: all users, all spaces with members, counts | — | layout `role === SYSTEM_ADMIN` + `isSystemAdminDisabled` | — | — |
| Users / Spaces | `GET /api/admin/users`, `/spaces` (unbounded lists, client filter) | — | `requireSystemAdmin` | — | — |
| Providers | RSC `db.plaidItem.findMany` (status, errorCode) + `ProviderActionsButton`/`AdminExpandHistoryFlow` | `POST /api/admin/plaid/diagnostics`, `/expand-history-token`, `/exchange-expanded-history-token`, `/retire-superseded-item` | `requireSystemAdmin` (diagnostics) / `requireFreshSystemAdmin` (token + retire) | raw `ADMIN_PLAID_HISTORY_TOKEN_EXCHANGED`, `ADMIN_PLAID_ITEM_RETIRED` | flow-based |
| Audit Log | `GET /api/admin/audit?limit≤200&offset` with filters | — | `requireSystemAdmin` | — | — |
| Security | `AdminSecurityConsole`: `/api/admin/security/users`, `/admin-status`, `/settings`; per-user sessions | `PATCH /settings` (validated descriptors); `POST users/[id]/2fa-reset`; `POST …/recovery-codes`; `DELETE …/sessions` | `requireFreshSystemAdmin` on all four | raw `PLATFORM_SETTINGS_UPDATED`, `TWO_FACTOR_RESET`, `ADMIN_SESSION_REVOKED`; recovery-codes: none in route | typed "RESET"/"REGENERATE", `role="alertdialog"`, discard guards (`AdminSecurityConsole.tsx:123,146,197,218`) |
| Platform Access | `/api/admin/platform-grants`, `/users` | `POST /platform-grants` (create/reinstate/level), `PATCH /platform-grants/[id]` (revoke) | `requireFreshSystemAdmin` | raw `PLATFORM_GRANT_CREATED|REINSTATED|LEVEL_CHANGED|REVOKED` | **none** (matrix cell click) |


## 4. Per-Space scorecards (18 categories, 1-10)

Weights for each overall (beta lens): data accuracy ×2, permission enforcement ×2, error handling ×1.5, read/write behaviour ×1.5, observability ×1.5, auditability ×1.5, freshness ×1, all others ×1 (sum 21.5). Evidence is file:line read in the audit; UNVERIFIED marks what needs a running app.

### 4.1 My Space (financial Space shell: Overview / Net Worth / Cash Flow / Activity / Accounts / Transactions / Members / Markets)

| # | Category | Score | Evidence |
|---|---|---|---|
| 1 | Functional completeness | 7 | Six real workspaces + Manage modal; Markets is a shell (`MarketsWorkspace.tsx:11,34-40`); amendment OFF by ruling; "Saved layouts" PLANNED; Shown/Hidden toggles near-inert (`SpaceDashboard.tsx:574-581`) |
| 2 | UI/UX quality | 7 | Atlas primitives, editorial stack, page-turn with reduced-motion (`SpaceDashboard.tsx:1011-1013`); dead `publishSections` effects on six workspaces (`WealthWorkspace:272-281` etc. vs `ContextualNavbar.tsx:783-788`); UNVERIFIED visual |
| 3 | Navigation clarity | 8 | One `PRIMARY_NAV`; `?workspace=` URL authority; sidebar is the lg+ switcher; Credit orphaned (`FicoCard.tsx:49,84`) |
| 4 | Data accuracy | 8 | Server-authoritative transactions (`transactions-redesign.test.ts`), canonical ledger balances; client-side folds exist but are deterministic and pinned (`wealth-time-machine.test.ts`, Cash Flow fold over a 5 000-row capped population with `TransactionCoverageNote`) |
| 5 | Data freshness | 8 | Oldest-observation anchor, "Last checked N ago" + qualifier (`SpaceDashboard.tsx:333-347, 589-601`); two-clock basis (`lib/freshness/observation.ts:10-26`); `≈` estimate marker on cards |
| 6 | Error handling | 3 | No `error.tsx`; `use-space-data.ts:277-283, 229, 255` fold failures into `[]` ⇒ false "No wealth history yet"; no retry in host; `global-error.tsx` drops chrome |
| 7 | Loading states | 5 | Single spinner (`SpaceDashboard.tsx:664-668`), no skeletons, no `loading.tsx`; `Suspense fallback={null}` |
| 8 | Empty states | 6 | Present per workspace (`WealthUnavailable`, Activity filtered-empty, Cash Flow cards) but indistinguishable from outage (see 6) |
| 9 | Permission enforcement | 8 | Every `/api/spaces/[id]/*` re-runs `requireSpaceRole`/`requireSpaceAction`; OWNER-only role change; invite never OWNER; RLS beneath. Deduction: permanent delete not fresh-gated (`permanent/route.ts:96`); `DELETE /api/accounts/[id]` keyed on link adder |
| 10 | Read/write behaviour | 4 | Member remove / role change / archive / account-revoke / invite accept are single-click; zero rate limiting on `/api/spaces/*` mutations; invite POST sends email per call |
| 11 | Auditability | 6 | Domain events for member/space lifecycle; gaps: invite revoke, decline, `transactions/[id]/correct`, `sections` PATCH, fico, account limit fields |
| 12 | Accessibility | 7 | `role="region"`, `tablist`/`tab` rail, `radiogroup` lens row, RightPanel `aria-modal` focus trap; gaps: `type="button"` missing (`SpaceControls.tsx:41`), MemberDetail shows no error; UNVERIFIED AT behaviour |
| 13 | Mobile responsiveness | 7 | Identity/controls relocate `<lg`, BottomNav covers primary; rail below lg; UNVERIFIED (hardening report: narrow viewport unverified) |
| 14 | Performance | 5 | 6 requests on mount, up to 10 in Assets mode plus a 5 000-row transactions array for Cash Flow; Activity 60-row cap without pagination; each call re-runs session+membership |
| 15 | Observability (self) | 6 | Freshness line + trust row + coverage note; no indication that a data route failed |
| 16 | User-facing explanations | 8 | `ShellTrustRow`, `TransactionCoverageNote`, estimate markers, APR basis labels |
| 17 | Test coverage | 7 | ~15 component/lib tests pin shell/url/history/lenses/transactions/cash-flow/wealth; none for `AccountsLedger`, `SpacesClient`, settings components |
| 18 | Beta readiness | 6 | Functional for five invited users; silent-failure UX and unconfirmed destructive actions are the risk |

**Overall: 6.4** (weighted).

### 4.2 Brief

| # | Category | Score | Evidence |
|---|---|---|---|
| 1 | Completeness | 8 | Full state machine LOADING/SHOWING/NO_DATA/COULD_NOT_UPDATE/FAILED_EMPTY/LOAD_ERROR (`brief-flow.ts:10-15,135-183`) |
| 2 | UI/UX | 7 | hero + sections; UNVERIFIED |
| 3 | Navigation | 8 | PRIMARY_NAV |
| 4 | Data accuracy | 8 | reads canonical snapshot, no client arithmetic; `BRIEF_GENERATION_VERSION` gates cached reuse |
| 5 | Freshness | 9 | `generatedAt`, `fromPriorDay`, `metrics.asOf`, per-source OUT_OF_DATE via shared `deriveSourceHealth` (`space-data-health.core.ts:204-234`) |
| 6 | Error handling | 8 | retry-after, COULD_NOT_UPDATE on quota (db1950b), `role="alert"`; no `error.tsx` for page throw |
| 7 | Loading | 7 | explicit LOADING state with `role="status"`; no `loading.tsx` |
| 8 | Empty | 8 | NO_DATA + FAILED_EMPTY distinguished |
| 9 | Permissions | 8 | `requireUser` + `dailyBrief` entitlement + `limitByUser` + kill switch + reservation (`generate/route.ts:38-68`) |
| 10 | Read/write | 8 | one POST, idempotent per (space, owner, day) |
| 11 | Auditability | 7 | AiInvocation rows (correlationId ⇒ brief-ops); no AuditLog row for generate (by design) |
| 12 | Accessibility | 7 | live regions `:100,124,344`; UNVERIFIED |
| 13 | Mobile | 7 | UNVERIFIED |
| 14 | Performance | 7 | one GET + one POST; 3-min failure cooldown |
| 15 | Observability | 8 | data-health section names stale sources |
| 16 | Explanations | 8 | per-source copy |
| 17 | Tests | 8 | `brief-flow.test.ts`, `brief-provenance.test.ts`, `brief-authority.test.ts` |
| 18 | Beta readiness | 8 | |

**Overall: 7.8**.

### 4.3 AI (Analyze)

| # | Category | Score | Evidence |
|---|---|---|---|
| 1 | Completeness | 8 | conversation, memory panel, knowledge-gap cards, abort |
| 2 | UI/UX | 7 | hardening: stationary header, anchored composer (`57fa404`); UNVERIFIED device |
| 3 | Navigation | 8 | PRIMARY_NAV; route special-cased padding (`DashboardChrome.tsx:68,84-94`) |
| 4 | Data accuracy | 8 | tool-calling engine; figures from spine (doctrine); client shows model prose |
| 5 | Freshness | 6 | transcript cache 24 h; no asOf on answers beyond tool evidence |
| 6 | Error handling | 6 | refusals shown inline but not remembered (`AnalyzeClient.tsx:272-282`); network message `:284-290`; 503 AI_PAUSED / 429 ALLOWANCE_EXHAUSTED surfaced by code |
| 7 | Loading | 7 | streaming/stop |
| 8 | Empty | 7 | |
| 9 | Permissions | 9 | `requireUser` + entitlement + two limiters + kill switch + advisory-locked reservation (`chat/route.ts:121-148`; `allowance-reservation.ts:136-212`); memory 403 on Space mismatch |
| 10 | Read/write | 8 | memory erase audited; chat writes invocation rows |
| 11 | Auditability | 7 | `AI_MEMORY_ERASED`; AiInvocation attribution; KD-12 write amplification open |
| 12 | Accessibility | 6 | UNVERIFIED; hardening report lists screen-reader unverified |
| 13 | Mobile | 7 | composer/viewport work in `57fa404`; UNVERIFIED on device |
| 14 | Performance | 7 | bounded prompt (turn/message/transcript ceilings) |
| 15 | Observability | 7 | provenance carrier, evidence; no per-turn cost shown to the user |
| 16 | Explanations | 8 | guidance notes, disclosure panel |
| 17 | Tests | 8 | `ai.test.ts`, `transcript-cache.test.ts`, `memory-panel.test.ts`, `app/api/ai/chat/route.test.ts` |
| 18 | Beta readiness | 8 | cost controls + fail-closed reservation landed (`e67fa58`) |

**Overall: 7.5**.

### 4.4 Connections

| # | Category | Score | Evidence |
|---|---|---|---|
| 1 | Completeness | 8 | Plaid link, wallets, manual, import wizard, rollback, disconnect, refresh |
| 2 | UI/UX | 7 | cards with three freshness lines (`ConnectionCard.tsx:557-671`) |
| 3 | Navigation | 8 | PRIMARY_NAV; utility shell |
| 4 | Data accuracy | 8 | canonical `deriveSourceHealth` shared with Brief |
| 5 | Freshness | 9 | three explicit lines; two-clock basis |
| 6 | Error handling | 5 | `ConnectionMenu.tsx:64` swallows action errors; 15 s phase timeout on RSC; no `error.tsx` |
| 7 | Loading | 7 | progress `role="progressbar"`, 4 s poll × 120, `slow` fallback |
| 8 | Empty | 8 | explicit empty state; Plaid-disabled copy |
| 9 | Permissions | 8 | all `requireUser`; import/rollback `requireFreshUser`; rate limits on refresh/sync/exchange/build; connection cap `maxConnections` |
| 10 | Read/write | 7 | disconnect + import confirmed; auto `resume-sync` fire-and-forget |
| 11 | Auditability | 6 | most actions audited; exchange-token / resume-sync / `accounts/[id]/sync` write no row |
| 12 | Accessibility | 7 | progressbar; UNVERIFIED |
| 13 | Mobile | 7 | UNVERIFIED |
| 14 | Performance | 6 | ~8-minute poll loop per open page |
| 15 | Observability | 8 | per-connection state/last-sync/stale-for visible to the user |
| 16 | Explanations | 8 | "being set up — check back soon", import consent |
| 17 | Tests | 7 | `import-ui.test.ts` + 8 lib tests |
| 18 | Beta readiness | 7 | Plaid Sandbox lane proven on Preview; Production Plaid paths never exercised on v2.6 (STATUS §8 #2) |

**Overall: 7.3**.

### 4.5 Spaces management (launcher, invites, create)

| # | Category | Score | Evidence |
|---|---|---|---|
| 1 | Completeness | 7 | cards, public list (join PLANNED), invites banner, create modal |
| 2 | UI/UX | 7 | |
| 3 | Navigation | 8 | |
| 4 | Data accuracy | 7 | net-worth summaries from snapshots; `≈` marker; three roster reads on bare `db` (`spaces/page.tsx:214,243,247`, documented) |
| 5 | Freshness | 8 | `getSpaceCardFreshness` |
| 6 | Error handling | 3 | accept/decline/switch failures silent (`SpacesClient.tsx:777-779, 972-989`); no `error.tsx` |
| 7 | Loading | 5 | RSC; no `loading.tsx` |
| 8 | Empty | 7 | |
| 9 | Permissions | 8 | `requireUser` + invitee/membership; public Spaces filtered `platformArea: null` |
| 10 | Read/write | 5 | one-click accept/decline; create = POST + invite + switch chain; no rate limit |
| 11 | Auditability | 6 | create/switch/accept audited; decline not |
| 12 | Accessibility | 6 | UNVERIFIED; 1 100-line client component without tests |
| 13 | Mobile | 7 | UNVERIFIED |
| 14 | Performance | 6 | `take: 50` public spaces; roster query per page |
| 15 | Observability | 6 | card freshness |
| 16 | Explanations | 7 | marketplace copy, "coming soon" |
| 17 | Tests | 3 | no `SpacesClient` test |
| 18 | Beta readiness | 6 | |

**Overall: 6.2**.

### 4.6 Credit

| # | Category | Score | Evidence |
|---|---|---|---|
| 1 | Completeness | 6 | FICO, utilization, card editors, debt tx list — duplicates Debt mode |
| 2 | UI/UX | 4 | pre-Atlas inline styles (`DebtClient.tsx`) |
| 3 | Navigation | 2 | orphaned: no nav entry (`FicoCard.tsx:49,84` only) |
| 4 | Data accuracy | 6 | client `reduce` over converted amounts with `estimated` taint (`:419-436`) |
| 5 | Freshness | 5 | no asOf shown |
| 6 | Error handling | 4 | generic 500 on `getSpaceContext` throw (`update-fico/route.ts:36`) |
| 7 | Loading | 5 | RSC |
| 8 | Empty | 6 | |
| 9 | Permissions | 7 | `requireUser` + ownership on accounts routes |
| 10 | Read/write | 5 | inline editors, no confirm, no rate limit |
| 11 | Auditability | 3 | fico + creditLimit/interestRate/minimumPayment/debtSubtype **unaudited** (`accounts/[id]/route.ts:103-125` audits displayName only) |
| 12 | Accessibility | 4 | UNVERIFIED; legacy markup |
| 13 | Mobile | 5 | client offset pagination (`:472`) |
| 14 | Performance | 6 | |
| 15 | Observability | 4 | |
| 16 | Explanations | 6 | utilization copy |
| 17 | Tests | 1 | none |
| 18 | Beta readiness | 4 | recommend hide or fold into Debt mode |

**Overall: 4.6**.

### 4.7 Settings (Account / Security / Preferences / Notifications / Data & Privacy / Archived assets)

| # | Category | Score | Evidence |
|---|---|---|---|
| 1 | Completeness | 8 | profile, password, email change, TOTP, sessions, prefs, export, deactivate, delete, archive bin |
| 2 | UI/UX | 7 | utility shell rail, Toast/InlineBanner |
| 3 | Navigation | 6 | UserMenu only; archived-assets off-rail (cross-link from Data & Privacy) |
| 4 | Data accuracy | 8 | server loaders |
| 5 | Freshness | 6 | sessions show `lastActiveAt`; 30 s revocation cache (`lib/session-cache.ts:102`) |
| 6 | Error handling | 5 | `ActiveSessions.tsx:133-143` swallows failures; no `error.tsx` |
| 7 | Loading | 6 | |
| 8 | Empty | 7 | |
| 9 | Permissions | 9 | `requireFreshUser` + bcrypt/TOTP on every sensitive route; sole-OWNER preflight on delete; limiters 5/15 m |
| 10 | Read/write | 7 | TOTP disable `alertdialog`; revoke-other no confirm; prefs PATCH unaudited |
| 11 | Auditability | 8 | ACCOUNT_*, PASSWORD_*, EMAIL_CHANGE_*, TWO_FACTOR_*, SESSION_REVOKED, DATA_EXPORTED; gaps: notification-preferences, recovery-codes route |
| 12 | Accessibility | 7 | checkbox `aria-label` (`NotificationSettings.tsx:117`); UNVERIFIED |
| 13 | Mobile | 7 | UNVERIFIED |
| 14 | Performance | 8 | |
| 15 | Observability | 7 | security history endpoint `GET /api/user/security-history` |
| 16 | Explanations | 8 | deactivate/delete copy, export prompt |
| 17 | Tests | 3 | `lib/settings/workspaces.test.ts` only |
| 18 | Beta readiness | 7 | |

**Overall: 7.1**.

### 4.8 Platform Operations

| # | Category | Score | Evidence |
|---|---|---|---|
| 1 | Completeness | 8 | 8 workspaces, 29 composed sections, cockpit + attention + pipeline + policies + AI cost controls; inert Commands/Maintenance controls declared PLANNED (`OpsJobHealthWidget.tsx:263-271,393-407`); `/db-authority` has no reader |
| 2 | UI/UX | 7 | editorial stack, StatusBoard, `<details>` disclosures; duplicated posture reads; stale copy in Alerts/Invocations/BriefOps/ApiUsage |
| 3 | Navigation | 8 | sidebar switcher + rail below lg + Sections anchors + `?workspace=`; Explore row |
| 4 | Data accuracy | 7 | all readers server-side over ledgers; estimates labelled ("estimate, not a bill"); but `OpsBriefOpsWidget.tsx:80` "Spend (exact…)"; `OpsCostWidget` permanently unknown spend; two AI-cost readers over two ledgers (invocation vs counter) can disagree |
| 5 | Data freshness | 5 | one-shot fetch, no refresh, `nowMs` captured at mount (`OpsSchedulerWidget.tsx:326`); `checkedAt` present in payloads but not rendered on Scheduler/Policies/CostControls/ResourceFreshness/PolicyGroups; StatusBoard "checked Ns ago" never ticks |
| 6 | Error handling | 7 | `WidgetMessage` `role="alert"`; per-source gates name the failed authority ("absent, not empty"); 403 ⇒ "Not authorized"; but `AiCostControlsPanel` hidden when the *policies* read fails (`OpsPoliciesWidget.tsx:509`); `OpsPlaidUsageWidget.tsx:57,64` unguarded |
| 7 | Loading | 7 | `role="status"` loading per widget; no skeletons; no `loading.tsx` |
| 8 | Empty states | 8 | honest empties ("Nothing needs attention — N authorities checked", "No live connections to judge", floors stated) |
| 9 | Permission enforcement | 9 | every route R/FW/FC as listed; CONTROL rank above WRITE (`policy.ts:LEVEL_RANK`); page re-checks grant; privacy ratchet tests. Deduction: client ignores access on 2 widgets here (manual ops, provider cleanup) |
| 10 | Read/write behaviour | 6 | policies/cost-controls exemplary (reason, token, confirm, 409 canonical); but manual ops Dry Run unconfirmed, provider-cleanup retry unconfirmed, three CONTROL routes share one 30/min bucket |
| 11 | Auditability | 8 | rOA envelope on every mutation; `JobRun.summary.destination` stores the alert email (`lib/alerts/run.ts:214`) |
| 12 | Accessibility | 6 | words travel with colour except `OpsTimelineWidget.tsx:44`; div-grid "tables" without table semantics; `ActivityFeedBlock.tsx:93` header `aria-hidden`; icons without `aria-hidden` and feedback without live region in ManualOperations/ProviderCleanup; `title`-truncated caveats (`OpsResourceFreshnessWidget.tsx:97`) |
| 13 | Mobile | 6 | `overflow-x-auto` + `md:` collapse on main tables; fixed `grid-cols-3/4` stat rows in ≥7 widgets; `toLocaleDateString()` drift (`OpsConnectionDiagnosticsWidget.tsx:113,126`); UNVERIFIED (hardening report: narrow viewport simulated only) |
| 14 | Performance | 5 | Overview mounts ~16 GETs (eight blocks + five Platform Health re-fetches of data `/overview` already folded); `OwnerResolution` issues a predictable 403 to the CS route for every non-CS operator; `history` route unbounded `findMany` over JobRun window |
| 15 | Observability (self) | 7 | cockpit verdicts, attention table, job matrix; but no "view is N minutes old" and no detection of a dead evaluator from the chip |
| 16 | Explanations | 8 | footnotes everywhere ("not a verdict on whether the scheduler is alive", "estimate, not a bill", floors, "absent, not empty") |
| 17 | Tests | 7 | 29 widget/view tests (render via `renderToStaticMarkup`), 66 `lib/platform` tests, privacy/control ratchets; zero route tests under `app/api/platform/**`; ManualOperations, ProviderCleanup, ApiUsage, EmailDelivery, Alerts, Invocations, BriefOps, RateLimits, Timeline, Convergence, History untested at render |
| 18 | Beta readiness | 7 | usable by the owner-operator; not a 24/7 console |

**Overall: 7.0**.

### 4.9 Security Operations

| # | Category | Score | Evidence |
|---|---|---|---|
| 1 | Completeness | 5 | one posture surface (Detections · Coverage · Notes); **no action at all**; session revocation / 2FA reset live in `/admin` which operators cannot reach |
| 2 | UI/UX | 7 | `SourceGate` per group |
| 3 | Navigation | 7 | single Overview workspace |
| 4 | Data accuracy | 6 | login-failure pulse = platform-wide count 24 h; auth-posture denominator = every User incl. deactivated (`auth-posture/route.ts`) |
| 5 | Freshness | 4 | relative times from mount `nowMs` (`SecurityPostureWidget.tsx:153`); no checkedAt |
| 6 | Error handling | 8 | per-group "absent, not empty" (`SecurityPostureParts.tsx:29-33`) |
| 7 | Loading | 7 | per-group `role="status"` |
| 8 | Empty | 7 | |
| 9 | Permissions | 9 | all five routes R SECURITY_OPS; never `requireSystemAdmin` |
| 10 | Read/write | n/a→7 | read-only by design; no mutation to mis-handle |
| 11 | Auditability | 7 | reads AuditLog; operator feed never shows note/email (`operator-actions-core.ts:45-52`) |
| 12 | Accessibility | 6 | `overflow-x-auto` trips table; UNVERIFIED |
| 13 | Mobile | 6 | `md:flex-row`; UNVERIFIED |
| 14 | Performance | 7 | five small GETs (take 8–20) |
| 15 | Observability | 6 | shows anomalies/sessions; cannot show authorization failures (not collected) |
| 16 | Explanations | 8 | Notes column states absent authorities |
| 17 | Tests | 7 | `security-posture.test.ts` (render + pure) |
| 18 | Beta readiness | 6 | observation only; incident response requires the SYSTEM_ADMIN account, whose Production state is UNKNOWN (STATUS §8 #7) |

**Overall: 6.6**.

### 4.10 Growth & Revenue

| # | Category | Score | Evidence |
|---|---|---|---|
| 1 | Completeness | 7 | signups, product analytics, beta queue, users, activity, funnel, policy groups; revenue honestly absent |
| 2 | UI/UX | 6 | legacy-styled beta/users widgets with hardcoded colours |
| 3 | Navigation | 7 | |
| 4 | Data accuracy | 7 | product events are AuditLog subsets (ids/kinds/days); `requests` returns emails + notes by design |
| 5 | Freshness | 5 | product analytics shows `checkedAtText`; others none |
| 6 | Error handling | 5 | `GrowthBetaRequestsWidget.tsx:113` swallows `beta-status` failure ⇒ mode/product controls vanish silently; 403 ⇒ "Action failed (403)" after click |
| 7 | Loading | 6 | |
| 8 | Empty | 7 | |
| 9 | Permissions | 8 | all mutations FW; users route guards self/SYSTEM_ADMIN. Deduction: client renders controls for READ holders (`:87`, `OpsUsersWidget.tsx:39`) |
| 10 | Read/write | 4 | approve/deny/resend/invite one click; registration-mode / product-status PUT without version token; reason preselected `SUPPORT_REQUEST` (`OpsUsersWidget.tsx:47`) |
| 11 | Auditability | 5 | BETA_* rows are legacy `auditLog.create` with **customer email in metadata** (approve `:85`, deny `:57`, resend `:74`, revoke `:63`, invitations `:97`); users route uses rOA correctly |
| 12 | Accessibility | 5 | unlabeled email input (`GrowthBetaRequestsWidget.tsx:268-282`), unlabeled search (`OpsUsersWidget.tsx:97`), icons without `aria-hidden`, buttons without `type` |
| 13 | Mobile | 5 | fixed `grid-cols-4` (`:242,249`) |
| 14 | Performance | 6 | requests take 100+100, invite audits take 500 |
| 15 | Observability | 6 | |
| 16 | Explanations | 7 | honest invite copy (`inviteEmailLabel`), "no revenue data source until billing (v3.0)" |
| 17 | Tests | 5 | `growth-funnel.test.ts`, `product-analytics.test.ts`; beta/users widgets source-scan only |
| 18 | Beta readiness | 6 | this is the Space the owner will use most during intake; the one-click approve is tolerable for five users, not beyond |

**Overall: 5.9**.

### 4.11 Customer Success

| # | Category | Score | Evidence |
|---|---|---|---|
| 1 | Completeness | 8 | customer spine, entitlement resolution, policy/overlay/override/cohort edits, refresh-all, deactivate, sync incidents |
| 2 | UI/UX | 7 | RightPanel with dirty guard (`CsCustomersWidget.tsx:220`) |
| 3 | Navigation | 7 | |
| 4 | Data accuracy | 8 | `systemDb` joins over 13 grouped reads; 30-day rollup; `truncated` floor on incidents |
| 5 | Freshness | 4 | no asOf on the detail |
| 6 | Error handling | 6 | `role="alert"` on errors; 403 ⇒ "Not authorized for this action" after click |
| 7 | Loading | 6 | |
| 8 | Empty | 8 | incident preview "not a report of zero incidents" |
| 9 | Permissions | 8 | all FW; override clamped to ceiling server-side (`assign.ts:35-40`); client ignores access (`:68`) |
| 10 | Read/write | 4 | **fabricated reason** `SUPPORT_REQUEST` on deactivate when none chosen (`:171-172`); Refresh all no confirm/no reason (`maxDuration=300`); no version token; one action per call with first-changed-field audit label (`assign.ts:105-108`) |
| 11 | Auditability | 7 | rOA on policy/cohort/refresh; but see fabricated reason; `ALREADY_MEMBER` no-op writes nothing |
| 12 | Accessibility | 5 | unlabeled inputs (`:177,303,426`) |
| 13 | Mobile | 6 | hardening pass wrapped facts; UNVERIFIED |
| 14 | Performance | 6 | `limit=100` list + 13 grouped reads per search |
| 15 | Observability | 7 | per-customer errors, incidents, AI usage joined |
| 16 | Explanations | 7 | |
| 17 | Tests | 6 | `cs-rollup.test.ts`, `incident-preview.test.ts`, `operator-identity.test.ts` (source scan) |
| 18 | Beta readiness | 7 | |

**Overall: 6.6**.

### 4.12 Merchant Operations

| # | Category | Score | Evidence |
|---|---|---|---|
| 1 | Completeness | 6 | doorway widget + plain `/merchant-ops` page outside the shell |
| 2 | UI/UX | 4 | unstyled `<main>` with Tailwind greys (`app/merchant-ops/page.tsx:18-35`) |
| 3 | Navigation | 5 | two hops; page has no shell/back nav |
| 4 | Data accuracy | 8 | `getPendingMergeCandidates(systemDb)` |
| 5 | Freshness | 5 | `force-dynamic`; no asOf |
| 6 | Error handling | 5 | UNVERIFIED (`MergeReviewList` not read in depth) |
| 7 | Loading | 5 | RSC |
| 8 | Empty | 8 | "No pending merge candidates." |
| 9 | Permissions | 9 | page R; decide FW; `canDecide` server-computed and explained for READ (`:21-25`) |
| 10 | Read/write | 7 | irreversible merge; 422 ineligible/409; confirm UNVERIFIED |
| 11 | Auditability | 8 | `MERCHANT_MERGE_APPLIED|DISMISSED` in-transaction (`merchant-merge-review.ts:181,217`) |
| 12 | Accessibility | 5 | UNVERIFIED |
| 13 | Mobile | 6 | `max-w-3xl p-6` |
| 14 | Performance | 7 | |
| 15 | Observability | 5 | |
| 16 | Explanations | 8 | "every merge is a human decision", hero lede |
| 17 | Tests | 5 | registry reachability only |
| 18 | Beta readiness | 6 | |

**Overall: 6.4**.

### 4.13 Admin area (legacy, SYSTEM_ADMIN)

| # | Category | Score | Evidence |
|---|---|---|---|
| 1 | Completeness | 7 | users/spaces/providers/audit/security/grants |
| 2 | UI/UX | 5 | own dark chrome, pre-Atlas |
| 3 | Navigation | 7 | `AdminNav` + mobile bar |
| 4 | Data accuracy | 7 | RSC + admin routes |
| 5 | Freshness | 4 | none |
| 6 | Error handling | 5 | inline `error` strings; console shows `role="alert"` |
| 7 | Loading | 6 | "Loading…" rows |
| 8 | Empty | 7 | |
| 9 | Permissions | 9 | layout + `requireSystemAdmin`/`requireFreshSystemAdmin`; `isSystemAdminDisabled` redirect |
| 10 | Read/write | 7 | typed-confirm dialogs for 2FA/recovery; grant matrix single-click |
| 11 | Auditability | 8 | every mutation `auditLog.create` (grants, settings, 2FA, sessions, Plaid) |
| 12 | Accessibility | 6 | `alertdialog`, `aria-describedby`, `aria-pressed` in security console; tables `overflow-x-auto` |
| 13 | Mobile | 6 | `hidden sm:table-cell` columns |
| 14 | Performance | 4 | Overview + Users + Spaces load **every** user/space unbounded (`app/admin/page.tsx:24-45`) |
| 15 | Observability | 5 | audit log with filters/pagination (`limit≤200`) |
| 16 | Explanations | 6 | |
| 17 | Tests | 4 | enrollment-surface tests only |
| 18 | Beta readiness | 6 | Production state of the admin account UNKNOWN (STATUS §8 #7) |

**Overall: 6.3**.

### 4.14 Per-feature grade table

| Feature | Grade | Status | Evidence |
|---|---|---|---|
| Dashboard / Net Worth (Total, Assets, Debt) | 7 | IMPLEMENTED | §4.1 |
| Cash Flow | 7 | IMPLEMENTED | client fold over capped population, disclosed |
| Markets | 2 | STUBBED | `MarketsWorkspace.tsx:11` |
| Activity feed | 6 | IMPLEMENTED | 60-row cap undisclosed |
| Accounts ledger | 7 | IMPLEMENTED | no confirm on revoke |
| Transactions explorer + detail drawer | 8 | IMPLEMENTED | server-authoritative, keyset |
| Transaction correction | 6 | IMPLEMENTED | unaudited, unlimited |
| Members / invites | 6 | IMPLEMENTED | unconfirmed remove/role; unaudited rescind/decline; no rate limit |
| Manage Space (general/accounts/overview/danger) | 6 | PARTIAL | "Saved layouts" PLANNED; Shown/Hidden near-inert; archive 1-click |
| Historical amendment | — | DISABLED (F1) | 503 `AMENDMENT_DISABLED` |
| Real assets (RWA-1/2A/2B) | 7 | IMPLEMENTED | PATCH/DELETE audited; estimate horizon |
| Daily Brief | 8 | IMPLEMENTED | |
| AI chat + memory | 8 | IMPLEMENTED | |
| Connections (Plaid/wallet/manual/import) | 7 | IMPLEMENTED | Plaid gated by env |
| Refresh All | 7 | IMPLEMENTED | `requireUser` + entitlements + 6/h; audit write failure swallowed |
| Spaces launcher / public join | 6 / 1 | IMPLEMENTED / PLANNED | |
| Credit page | 4 | IMPLEMENTED (orphan) | |
| Settings: account / security / prefs / notifications / data | 7 | IMPLEMENTED | prefs unaudited |
| Archived assets / archive bin | 7 | IMPLEMENTED | 2-step permanent deletes; Space permanent not fresh-gated |
| Platform Ops cockpit (StatusBoard + Attention) | 8 | IMPLEMENTED | posture chip has no age check |
| Jobs (scheduler + health + manual ops) | 6 | PARTIAL | controls inert/ungated |
| Policies (refresh cadence, job cadence) | 9 | IMPLEMENTED | reason + token + confirm + audit |
| AI Cost Controls (allowance, thresholds, kill switch) | 8 | IMPLEMENTED | hidden when policies read fails; unused view fields |
| Alert rules surface | 4 | PARTIAL | read-only, stale copy, firing-now omitted |
| Pipeline (executions, timeline, summary, coverage) | 8 | IMPLEMENTED | |
| Providers (health, operations, diagnostics, cleanup, usage, freshness, email) | 6 | PARTIAL | cleanup ungated; email overclaim; OpenAI `Unavailable` |
| History / Convergence / Timeline | 6 | IMPLEMENTED | colour-only timeline; cost spend unknown |
| AI ops (invocations, brief-ops, trend) | 6 | PARTIAL | stale caveats |
| Economics (AI budget, Plaid usage, cost) | 7 | IMPLEMENTED | estimates labelled; plaid-usage guard gap |
| Security posture | 6 | IMPLEMENTED | observation only |
| Growth: signups / analytics / funnel / policy groups | 7 | IMPLEMENTED | |
| Growth: beta requests + registration mode + product status | 5 | PARTIAL | one-click, ungated, email in audit metadata |
| Growth: users deactivate/reactivate | 6 | PARTIAL | preselected reason |
| Customer Success spine + edits | 6 | PARTIAL | fabricated reason, no confirm on refresh |
| Sync incidents preview | 8 | IMPLEMENTED | |
| Merchant merge review | 6 | IMPLEMENTED | unstyled page |
| Admin: users/spaces/providers/audit | 6 | IMPLEMENTED | unbounded lists |
| Admin: security console (2FA reset, recovery codes, sessions) | 8 | IMPLEMENTED | typed confirms + audit |
| Admin: platform grants matrix | 7 | IMPLEMENTED | single-click, audited |
| `/db-authority` route | 3 | IMPLEMENTED (no reader) | |
| Prototype pages | — | OUT OF REPO | gitignored |


## 5. Findings

Severity: P0 none · P1 should fix before beta · P2 schedule · P3 cleanup. UI visibility is never treated as security; every "client gate" remark below is paired with the server gate, which was verified.

| ID | Finding | Sev | Status | Evidence | Impact | Remediation | Blocker | Conf. |
|---|---|---|---|---|---|---|---|---|
| **UI-006** | Customer Space fails silently under outage: a 401/403/500 on sections/accounts/snapshots renders "No wealth history yet"; failed invite accept/switch/refresh show nothing | P1 | OPEN | `lib/space/use-space-data.ts:277-283,229,255`; `WealthWorkspace.tsx:439`; `SpacesClient.tsx:777-779,972-989`; `ConnectionMenu.tsx:64`; `ActiveSessions.tsx:133-143` | false empty states; false support tickets; an outage looks like a new account | surface a `WidgetMessage`-style error with retry in the host; never coerce a failed read to `[]` | Yes (customer trust) | high |
| **UI-003** | Unconfirmed destructive customer actions: member removal (also revokes every account that member shared), role change, Space archive, account revoke are one click | P1 | OPEN | `components/space/widgets/members/MemberDetail.tsx:103-125`; `MembersRoster.tsx:124`; `components/space/manage/DangerZonePanel.tsx:150-152`; `AccountDetail.tsx:170-184` | irreversible shared-data loss by mis-click | `ConfirmDialog` (already used for Leave and Disconnect) | Yes (cheap) | high |
| **UI-002** | Customer Success fabricates an audit reason (`reason ?? {code:"SUPPORT_REQUEST"}`); Growth users widget preselects the same code | P1 | OPEN | `components/platform/widgets/CsCustomersWidget.tsx:171-172`; `OpsUsersWidget.tsx:47`; route requires a parsed reason (`users/[userId]/route.ts:47-53`) | the audit ledger records a reason the operator did not give, for account deactivation | require an explicit selection; refuse the click without one | No (single operator) but before any second operator | high |
| UI-001 | Five mutating widgets ignore `access` and render Run Now / Dry Run / Retry cleanup / Approve / Deny / Deactivate / Refresh-all / policy editors for READ holders; rely on a post-click 403 (routes enforce correctly) | P2 | OPEN | `OpsManualOperationsWidget.tsx:49`; `OpsProviderCleanupWidget.tsx:45`; `GrowthBetaRequestsWidget.tsx:87`; `OpsUsersWidget.tsx:39`; `CsCustomersWidget.tsx:68`; host contract `PlatformSpaceDashboard.tsx:309-312` | contradicts the Policies doctrine ("never a button that 403s") | accept `access`; hide or disable with the explanatory line | No | high |
| UI-004 | Permanent Space deletion gated by the cached-revocation role check only, while the smaller manual-asset permanent delete uses `requireFreshUser` | P2 | OPEN | `app/api/spaces/[id]/permanent/route.ts:96` vs `accounts/manual/[id]/permanent/route.ts:59` | a revoked session can permanently delete a Space within the cache window | `requireFreshUser` then role | No | high |
| UI-005 | Zero rate limiting on `/api/spaces/*` mutations and on correction, FICO, account PATCH, disconnect; invite POST sends an email per call | P2 | OPEN | grep `limitBy` across those routes → none; `invite/route.ts:192+` | invite spam vector; durable rules minted without limit | `limitByUser` on invite (20/h) and correct (60/h) | No | high |
| UI-007 | No `error.tsx` / `loading.tsx` / `not-found.tsx` anywhere under `app/`; `global-error.tsx` replaces the root layout with an unstyled page | P2 | OPEN | `find app …`; `app/global-error.tsx:33-54` | any RSC throw drops the user out of the shell; no skeletons | segment `error.tsx` under `(shell)/dashboard` and `platform/[area]`; `loading.tsx` with the shell frame | No | high (rendering path UNVERIFIED) |
| UI-008 | Unaudited customer mutations: invite revoke/decline, `transactions/[id]/correct`, `credit/update-fico`, account PATCH for creditLimit/interestRate/minimumPayment/debtSubtype, `sections/[sectionId]`, notification preferences, `plaid/exchange-token`, `plaid/resume-sync`, `accounts/[id]/sync`, admin recovery-codes route | P2 | OPEN | `accounts/[id]/route.ts:103-125` audits displayName only; others by grep | financial-input edits and durable merchant rules leave no trail | `emitDomainEvent`/`auditInsert` per route | No | high |
| UI-009 | Platform widgets never refetch; relative ages frozen at mount; `checkedAt` present in payloads but not rendered on several surfaces | P2 | OPEN | `components/platform/widget-kit.tsx:42-70`; `OpsSchedulerWidget.tsx:326`; `SecurityPostureWidget.tsx:153`; `StatusBoard.tsx:65` | an open tab shows stale verdicts with "checked 12s ago" forever | absolute UTC `checkedAt` on every surface; manual Refresh; refetch on `visibilitychange` | No | high |
| UI-010 | AI Cost Controls panel (incl. the kill switch) is hidden when the *policies* read fails | P2 | OPEN | `OpsPoliciesWidget.tsx:509` | the one control needed in an incident disappears on a 500/403/slow `/policies` | render the panel from its own fetch state | No (incident-time hazard) | high |
| UI-012 | Accessibility gaps on Platform Spaces: colour-only timeline outcome, div-grid "tables" without table semantics, unlabeled inputs, icons without `aria-hidden`, feedback without live regions, fixed `grid-cols-3/4` stat rows in ≥ 7 widgets | P2 | OPEN | `OpsTimelineWidget.tsx:44`; `ActivityFeedBlock.tsx:93`; `OpsUsersWidget.tsx:97`; `CsCustomersWidget.tsx:177,303,426`; `GrowthBetaRequestsWidget.tsx:268-282`; `OpsManualOperationsWidget.tsx:160-191`; `OpsProviderCleanupWidget.tsx:149,153` | UNVERIFIED with assistive technology | ToneBadge words; `role="table"` semantics; labels; live regions | No | high (code) / medium (impact) |
| UI-013 | Growth beta mutations write the customer email into `AuditLog.metadata` via legacy `auditLog.create` and bypass the operator envelope (= PRIV-002 family) | P2 | OPEN | `requests/[id]/{approve:85,deny:57,resend:74,revoke:63}`, `invitations:97` | PII in a ledger with no retention; no reason/before-after; excluded from operator feeds | `recordOperatorAction` with an opaque target ref | No | high |
| UI-020 | Security Operations has no action; incident response (session revoke, 2FA reset) lives in `/admin`, which operators cannot reach, and the Production state of the admin account is UNKNOWN | P2 | OPEN (owner decision) | `security-ops/*` all GET; `security-posture-view.ts:191-203`; `proxy.ts` role split; STATUS §8 #7 | during an auth anomaly the operator can see but not act without switching accounts | a SECURITY_OPS WRITE "revoke user sessions" route on the operator envelope | No | high |
| UI-011 | Stale or overclaiming operator copy: Alerts "no write lever yet" (false since cost controls), Invocations "a timeout writes no row" (false), BriefOps "Spend (exact…)" for an estimate, Email "All emails delivered" (= handed to the provider; skipped hidden), ApiUsage mislabel, Cost widget permanently "unknown" | P3 | OPEN | `OpsAlertsWidget.tsx:27`; `OpsAiInvocationsWidget.tsx:31`; `OpsBriefOpsWidget.tsx:80`; `OpsEmailDeliveryWidget.tsx:40`; `OpsApiUsageWidget.tsx:43`; `cost.ts:103-106` | operators trust wrong words | text fixes; render `latest` firing-now in Alerts; source or remove the cost metric | No | high |
| UI-014 | Markets is a reachable stub ("THIS IS A SHELL") whose registry status `available` bypasses the `comingSoon` mechanism | P3 | STUBBED | `components/space/workspaces/MarketsWorkspace.tsx:11,34-40` | an empty workspace in production navigation | mark `comingSoon` or hide for beta | No | high |
| UI-015 | Credit page orphaned, pre-redesign, duplicative of Net Worth → Debt, with unaudited edits | P3 | OPEN | `FicoCard.tsx:49,84`; `DebtClient.tsx:472` | confusion; untested surface | fold into Debt and retire the route | No | high |
| UI-016 | Manage → Overview section toggles are near-inert; "Saved layouts" is a "Coming soon" placeholder; sections PATCH unaudited | P3 | PLANNED | `OverviewSectionsPanel.tsx:120-131`; `SpaceDashboard.tsx:574-581` | — | remove the tab or wire it | No | high |
| UI-017 | Activity feed hard cap of 60 with no pagination or disclosure | P3 | OPEN | `app/api/spaces/[id]/activity/route.ts:582` | — | cursor pagination or "showing latest 60" | No | high |
| UI-018 | `OpsPlaidUsageWidget` dereferences `cycles[0]` unguarded (the Economics block guards the same payload) | P3 | OPEN | `OpsPlaidUsageWidget.tsx:57,64` | possible render crash | guard | No | medium |
| UI-019 | Duplicate fan-out on the Platform Ops Overview (~16 GETs; Platform Health re-fetches five routes the overview already folded; a predictable 403 to the CS route for non-CS operators) | P3 | OPEN | `lib/platform/ops/overview.ts:101-117`; `OpsPlatformHealthWidget.tsx:326-330`; `connection-health-table.tsx:302-312` | latency; noise | feed Platform Health from the overview payload; gate the owner fetch | No | high |
| UI-021 | Three CONTROL routes share one 30/min rate-limit bucket; a burst of cadence edits can lock the kill switch for a minute | P3 | OPEN | `policies:90`, `job-cadence:67`, `ai-cost-controls:62` | — | separate key for cost controls | No | high |
| UI-022 | Admin Overview/Users/Spaces load every row unbounded | P3 | OPEN | `app/admin/page.tsx:24-45`; `/api/admin/{users,spaces}` | fine at 2 users; not at 500 | `take` + search | No | high |
| UI-023 | Non-finding, recorded to prevent re-raising: transaction correction authorises against the active Space and scopes the row to the same Space (`correct/route.ts:88-124`) — correct | — | — | — | — | — | — | high |

Cross-references: SEC-005 (user directory), SEC-006 (admin 2FA reset), OBS-001..015, PRIV-002/013.

## 6. Aggregate scores

| Group | Members (overall) | Weighted aggregate | Weight rationale | Confidence | Evidence coverage |
|---|---|---|---|---|---|
| **Customer-facing Spaces** | My Space 6.4 (×3) · Brief 7.8 (×1) · AI 7.5 (×1.5) · Connections 7.3 (×1.5) · Spaces management 6.2 (×1) · Credit 4.6 (×0.5) · Settings 7.1 (×1) | 6.7 raw → **6.1** after three cross-cutting P1 deductions (UI-006 silent failure, UI-003 unconfirmed destructive actions, UI-007 no error boundaries; −0.2 each) | My Space carries the product; AI and Connections carry cost and provider risk; Credit is an orphan | high on gating/audit (routes read); medium on UX/a11y (no runtime) | ~85% of customer routes and all workspace components read at least by grep |
| **Operator-facing Spaces** | Platform Ops 7.0 (×3) · Security 6.6 (×1) · Growth 5.9 (×1.5) · Customer Success 6.6 (×1.5) · Merchant 6.4 (×0.5) · Admin 6.3 (×1) | 6.6 raw → **6.4** after UI-001/UI-002 deductions | Platform Ops is the console; Growth and CS carry the mutations the owner will use during intake | high on gating (every platform route read) and widget behaviour (all 55 widget files read); medium on rendering | 100% of `app/api/platform/**` + merchant-ops routes; 100% of widgets; 29 widget tests + 66 lib tests |

Does each Space expose enough to understand its own health? Customer Spaces: yes for data freshness (freshness line, trust row, coverage note, Brief data-health, Connections lines) and no for request failures (silent). Operator Spaces: the cockpit, attention table and job matrix are real, but no surface says how old its own view is, and the alerts chip cannot tell a quiet system from a dead evaluator (see `10-OBSERVABILITY-SCORECARD.md`).

## 7. Contradictions with documentation

| Claim | Where | Code / git | Severity |
|---|---|---|---|
| STATUS "Last updated 2026-10-15"; latest commits end at `a01bbbb`/`1c04752` | `STATUS.md` header, §3 | STATUS last touched at `595886e`; HEAD merges 20 later commits (UI hardening 154 files, AI fail-closed reservation, CI volumes, AI policy simplification) that STATUS does not record; no gate record for the merged SHA `cde8fa0` | P2 process (= SEC-AI-011) |
| UX P1 "NOT YET PREVIEW-VERIFIED … Remaining: push, CI, Preview" | `STATUS.md` §6 | §3 and §14 of the same file record the push, green CI and Preview verification | P3 |
| Preview "123 migrations" | `STATUS.md` §14 | §11 says 126 | P3 |
| UI-hardening branch "left for owner review", "not merged" | `UI-HARDENING-REPORT-2026-10-16.md` §J-K | merged at `cde8fa0` | P2 (STATUS never updated) |
| "never a button that 403s on click" doctrine | UX P1 report; Policies widget comments | true for Policies/Cost Controls; false for five widgets (UI-001) | P2 |
| Alerts widget "no write lever on this surface yet" | `OpsAlertsWidget.tsx:24-28` | `ai-spend-*` thresholds editable in the same workspace since cost controls | P3 |
| `UI-PLATFORM-COVERAGE.md` "all 29 platform test scripts passed" | coverage doc | agent-reported for the hardening branch, not re-run here; zero route tests under `app/api/platform/**` | note |

Items UNVERIFIED because they need a running app: all rendered output, focus order, screen-reader behaviour, touch targets, narrow viewports; actual Next behaviour on an RSC throw without a segment `error.tsx`; presence of `SpaceDashboardSection` rows per composed key per environment (esp. `ops_ai_budget`); whether any CONTROL grant exists on Preview/Production; whether `evaluate-alerts` has ever run on Preview/Production; env presence of `PLATFORM_ALERTS_EMAIL`, `RESEND_API_KEY`, `NEXT_PUBLIC_SENTRY_DSN`; Sentry rules; row counts; the Production state of `DISABLE_SYSTEM_ADMIN` and the admin account.
