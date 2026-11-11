# Platform Space — Phase 1: audit and redesign proposal

| | |
|---|---|
| **Status** | PROPOSAL for owner review, **revised 2026-10-30 (rev 2)** for the owner's Platform Operations direction (policy groups, capability entitlements, policy economics) — Part B (§11–§19). P1-1/P1-2/P1-3 remediation is implemented in PR #131 (develop, not yet merged). Phase 1 UX ships as its own behaviour-preserving PR; Phases 2–4 wait for review of §13–§16. |
| **Baseline** | `develop` `e66a538` (2026-10-30). Production `main` `4dda8dc` carries the v2.7 Platform state (`6a1ed44`) plus the marketing site only. |
| **Method** | Code audit (routes, guards, widgets, readers, tests) + two read-only inventories, spot-verified by hand (each finding below cites `file:line`). **No live Preview walk-through this pass:** the Chrome extension was disconnected and the Preview DB password is un-rotated (no Preview writes). Earlier Preview passes (2026-10-27/28, owner Chrome) cover the merged structure. |
| **Supersedes** | The 2026-10-27/28 discovery, owner-decision and visual-pass docs (local branch `docs/platform-space-redesign-discovery`, never on develop). Owner rulings P-1…P-10 recorded there are carried forward in §0. |
| **Coordination** | Claude 1 owns crypto history / financial integrity. Marked **[C1]** = coordinate before redesign (§7). |

---

## 0. Where Platform stands (already shipped, carried forward)

| Shipped | PR / commit |
|---|---|
| Authz/privacy/audit fixes (growth writes + merchant merges via `recordOperatorAction`, CS identity audit, Growth users counts-only) | #75 `29732dc`, #76 `8446513`, #77 `907522f` |
| Ops 8 → 6 workspaces (P-10) · CS Customers/Incidents · Security Posture/Audit/Operator actions | #79, #85, #86 |
| Overview pulses → analytics Overview V1/V2 (14-day trends per area) | #87, #89, #90 |
| Separate Platform navigation shell (P-1) · Growth rename (P-3, Preview DB only) | #88, #83 |
| Ops wallet history view · Resume history (per-wallet, CONTROL + reason) **[C1]** | #105, #116 |

**Owner rulings in force (10-27):** separate shell; `/admin` = break-glass; CS may resolve identity under authorization, Ops/Growth minimized; one AI spend metric = *estimated* (billed is separate, future); no Platform AI yet; security/privacy/audit before cosmetics. **Still open:** SEC-PLAT-1 operator MFA (#78 DRAFT, activation not authorized); Growth rename migration not applied to Production.

---

## 1. Current route and function inventory

### 1.1 Pages

| Route | What it is | Guard |
|---|---|---|
| `/dashboard/platform` | Overview: one analytics card per granted area (V1/V2) | session + any ACTIVE grant |
| `/dashboard/platform/[AREA]?workspace=` | Area workspaces (below) | area READ; unknown/ungranted → Overview |
| `/merchant-ops` | Merchant merge review — standalone, no app chrome, no back link | MERCHANT_OPS READ / WRITE to decide |
| `/admin`, `/admin/{users,spaces,providers,audit,security,platform-access}` | SYSTEM_ADMIN break-glass console. `/admin/workspaces` = redirect only | SYSTEM_ADMIN (+ kill switch) |

SYSTEM_ADMIN is redirected away from `/dashboard/*` (`proxy.ts:146`) — it can never see Platform UI, only call Platform APIs.

### 1.2 Areas → workspaces → widgets → APIs

Sources: areas `lib/platform/policy.ts:59-237`; workspaces `lib/platform/workspaces.ts:145-207`; widget map `components/platform/PlatformSpaceDashboard.tsx:128-185`. (`po` = `/api/platform/platform-ops`.)

| Area | Workspace | Contents (route families) |
|---|---|---|
| **Platform Ops** | Overview | StatusBoard, Attention (+resync/reauth), Connection health, Jobs matrix, Refresh activity, AI activity, Economics, Activity feed, Platform health (alerts/provider/freshness/rate-limits/env), Convergence, Timeline |
| | Jobs | Scheduler, Job health (+JobDetailPanel), Manual operations (Run Now/Dry run), History |
| | Pipeline | Refresh executions, Refresh summary, Connection health (+resync/reauth), Coverage |
| | Providers | Provider health, Provider operations, **Connection diagnostics + History recovery [C1]**, Provider cleanup, API usage, Resource freshness, Email delivery |
| | AI and costs | AI invocations, AI trend, AI budget, Plaid usage, Cost, Brief ops |
| | Controls | Policies (cadence, job cadence, AI cost controls, maintenance mode, Plaid webhook), Alerts |
| **Security** | Overview / Audit / Operator actions | posture + sessions + anomalies; audit feed; operator actions |
| **Growth** | Overview (7 sections) | sign-ups, product analytics, beta requests + invitations + registration mode + product status, users (counts), activity, growth funnel, policy groups |
| **Customer Success** | Customers / Incidents | customer list + detail (policy, cohort, refresh, access); sync issues |
| **Merchant Ops** | Overview | a link to `/merchant-ops` (no data) |

**API surface:** 72 `/api/platform/**` route files + 15 `/api/admin/**` + `/api/merchant-ops/decide`. Every route has a guard. Only two have no UI caller: `po/db-authority` (a deploy check — intentional) and `admin/plaid/retire-superseded-item` (likely superseded by the exchange step; verify).

### 1.3 Permission model (unchanged by this proposal)

Five grant areas × READ < WRITE < CONTROL, one grant per user-area, issued only by a fresh SYSTEM_ADMIN at `/admin/platform-access` (rate-limited, audited in-transaction). Reads = cached `requirePlatformAccess`; mutations = `requireFreshPlatformAccess`. CONTROL mutations require a reason and an optimistic-concurrency token. SYSTEM_ADMIN bypasses every area (break-glass).

### 1.4 Write actions (all audited via `recordOperatorAction` unless noted)

| Action | Gate | Reason | Rails |
|---|---|---|---|
| Run job / dry run (`po/operations`) — incl. fleet `sync-banks`, `sol-history-backfill` | WRITE | — | 30/60s, in-flight lock |
| Resync item · Request re-auth (notifies customer) | WRITE | — | 60-min cooldown · 20/h op, 3/day item |
| Repoint Plaid webhook | CONTROL | required | echo `expectedTarget` |
| Resume wallet history **[C1]** | CONTROL | required + note | 10/60s, admission, budget, lock |
| Provider cleanup (`itemRemove` retry) | WRITE | — | only when owed |
| Maintenance mode · AI cost controls (kill switch) · cadence policies | CONTROL | required | CAS, 20–30/window |
| CS: deactivate/reactivate, refresh-all, cohort, policy + **per-customer AI USD override** | WRITE | most required | no rate limit |
| Growth: invite / approve / resend / deny / revoke · registration mode · product status | WRITE | some | **no rate limit on email sends** |
| Merchant merge decide | WRITE | required | no rate limit |
| Admin: grants, 2FA reset, recovery codes, sessions, security settings, Plaid history expansion | fresh SA (one cached: `expand-history-token`) | — | confirmations, rate limits |

---

## 2. Problems, ranked

**P0** — none found (no unguarded route, no data leak path, no unaudited consequential write).

### P1 — security / correctness of operator authority

| # | Problem | Evidence | Fix type |
|---|---|---|---|
| P1-1 | **[FIXED in #131]** **DISABLE_SYSTEM_ADMIN kill switch does not cover Platform APIs.** It is enforced at login (`lib/auth.ts:257`) and on `/api/admin/**` (`lib/session.ts:344-352`), but the Platform break-glass bypass (`lib/platform/authorize.ts:93`) returns before any check. A SYSTEM_ADMIN session issued before the switch is flipped keeps full Platform API authority (incl. CONTROL) until it expires. | verified | backend, small |
| P1-2 | **[IMPLEMENTED in #131, dormant until `OPERATOR_TOTP_ENFORCEMENT=enforce`; Preview first]** **Operators are not required to use MFA.** `requiresTotpEnrollment` forces TOTP only for SYSTEM_ADMIN; grant holders are USER. `require_totp_admins` is enforced nowhere. Fix exists as #78 (DRAFT). | `lib/auth-totp-policy.ts`, `SECURITY_MODEL.md:51` | owner activation |
| P1-3 | **[FIXED in #131: fleet runs need CONTROL + reason]** **Privilege inversion on provider-cost work.** Resuming ONE wallet's history needs CONTROL + reason; running the FLEET `sol-history-backfill` or `sync-banks` from Manual operations needs only WRITE with no reason. The code marks it UNRESOLVED. | `lib/platform/operations/registry.ts:194,223`; `capability-classification.ts:288` | owner ruling → backend |
| P1-4 | **Platform-wide switches at area WRITE.** Registration mode (who can sign up) and product status are gated like a single invite. UNRESOLVED in the classification. | `capability-classification.ts:269` | owner ruling → backend |
| P1-5 | **Misleading control copy.** The job panel shows a disabled "Run now" and says "Nothing in Fourth Meridian can … manually trigger a scheduled job, and no operator decision about a job is recorded anywhere" — while the same workspace's Manual operations runs jobs (audited), and job cadence is an audited CONTROL. An operator reading it will act on a false model. | `widgets/jobs-view.ts:244`, `JobDetailPanel.tsx:34,312` | UI only |

### P2 — privacy, safety rails, operability

| # | Problem | Evidence | Fix type |
|---|---|---|---|
| P2-1 | CS **customer list** returns email, name, username for every row (search by email) with no audit; only the detail open is audited. Conflicts with the recorded P-4 note ("lists minimized, names only in audited detail") — **owner to confirm which is intended.** | `lib/platform/customer/customers.ts:49-59` | backend + UI |
| P2-2 | No rate limit on Growth email sends (invite/approve/resend) or merchant decisions; request-reauth (customer-visible) needs no reason. | §1.4 | backend |
| P2-3 | Per-customer AI USD override settable at CS WRITE, while fleet allowance needs Ops CONTROL. Asymmetric money authority. | `customers/[userId]/policy` | owner ruling |
| P2-4 | **Provider spend is only partly visible.** OpenAI and Plaid have estimates; Alchemy/Esplora/CoinGecko have call counts only (no $, no comparison to daily caps); current-balance RPC (`eth-rpc`, `sol-rpc`), FX (Frankfurter/OXR), Tiingo and Resend auth mail are **not metered at all**. Provider health covers only Plaid + OXR. | `lib/platform/provider-health.ts:195-210` | backend + UI |
| P2-5 | **No fleet view of historical backfill.** Per-wallet state exists (diagnostics `historyBackfill`), but no counts by state, no backlog, no budget-vs-cap; diagnostics cap at 50 rows per source with no paging. Completeness readers are not exposed to operators. **[C1]** | `connection-diagnostics.ts:91` | backend (read-only) + UI |
| P2-6 | `ingestion_paused` is read by admission but has **no writer** — an emergency lever that cannot be pulled. | `admission/facts.ts:49` | owner ruling |
| P2-7 | Mobile: the bottom bar holds Overview + 4 areas, so a 5-area operator loses **Merchant Ops** on phones; section links absent on mobile; Ops Overview stacks ~11 blocks. | `BottomNav.tsx:55` | UI |
| P2-8 | Merchant review lives outside the shell (no nav, no back link; no-grant → `/dashboard`). | `app/merchant-ops/page.tsx` | UI |
| P2-9 | Nothing refreshes: no widget polls; relative ages ("3m") go stale on an open tab. | no `setInterval` in platform | UI |

### P3 — duplication, density, polish

- **Duplication** (contradicting "renders once" notes at `workspaces.ts:128-129,177`): job health ×4, connection health ×2, refresh failures ×6, AI spend fetched by 3 widgets, Plaid usage ×2, AI budget ×2, alerts/provider/freshness ×4, convergence ×2 on one page, email health ×2 in one workspace, sign-ups ×4, operator actions ×3 (Ops feed, Security, `/admin/audit`), customers ×3.
- **Orphans:** `ExecutionStrip`, `RuntimeTrend` (built, test-only — need a per-job run route), `AgeWithUtc`, registered-but-unplaced `OpsRateLimitsWidget`/`OpsEnvStatusWidget`.
- **Placeholders:** sidebar "· soon" sections; `/admin/providers` Force Sync/Disconnect "Soon"; `/admin/security` "Force password reset (soon)"; empty Merchant card body; `callsToday ?? 0` prints 0 for unknown (`OpsProviderHealthWidget.tsx:172`).
- **Accessibility:** tables are div-grids (13) with headers hidden below md and no table roles; mobile tab icons missing for Incidents/Audit/Operator actions (`PlatformSpaceDashboard.tsx:239-241`); likely multiple `<h1>`; overview card `aria-label` hides its summary; unlabeled expand chevron in `/admin/audit`.
- **Stale text:** "four platform Spaces" (`[area]/page.tsx:43`); schema/route comments say CONTROL is not issuable (`schema.prisma:274-280`, `platform-grants/route.ts:16`); `ApiUsageCounter` comment lists only PLAID/OPENAI; Security hero "Is Fourth Meridian secure?" overclaims.
- No grant visibility inside Platform (operators can't see who holds what; only `/admin/platform-access`).

---

## 3. Design principles

1. **Domains are navigation, grants stay authority.** The four domains regroup screens; the five grant areas, their levels and every route guard are unchanged. A panel renders only if its own area grant allows it; a domain appears if the operator holds any grant it contains.
2. **Each fact renders once**, in its owner's domain; elsewhere it is a one-line status that links there.
3. **Status → trend → table → action.** Every screen leads with verdicts, then 14-day trends (persisted series only), then the worklist, then actions in a side panel.
4. **Honest states.** Unknown ≠ 0; "estimate" labelled; never "complete" for history **[C1]**; missing authority is absent, not a disabled lookalike.
5. **No new cross-area route, no Platform AI, no new identity exposure.**

---

## 4. Proposed information architecture (four domains)

> **rev 2:** the Platform Operations part of this IA is refined by §18 (Operations · Providers · AI & Costs · Policies). The cross-area grouping below still applies to Customer Success, Security and Growth.

| Domain | Screens | Built from (current) | Grant areas behind it |
|---|---|---|---|
| **1. Overview & health** | **Home** (status band: alerts · provider health · freshness · jobs — the four verdicts once; per-area trend cards V1/V2; one "Needs attention" list assembled from per-area feeds) · **Jobs** · **Pipeline** (refresh executions, coverage, incidents timeline = convergence) | Ops Overview + StatusBoard + PlatformHealth + Convergence/Timeline; Jobs; Pipeline; Growth adoption trends | PLATFORM_OPS, GROWTH (trend card), CS/SECURITY (their cards) |
| **2. Customers & connections** | **Customers** (list minimized per P2-1 ruling; audited detail) · **Connections** (one fleet table: health + diagnostics, paged; detail panel with resync / re-auth / webhook / **History recovery [C1]**) · **Incidents** · **Merchant data** (merge review moved into the shell) | CS Customers/Incidents; Ops connection-health + diagnostics + attention; `/merchant-ops` | CUSTOMER_SUCCESS, PLATFORM_OPS, MERCHANT_OPS |
| **3. Providers & costs** | **Providers** (one row per provider: health, calls today/30d, cap & headroom, metered? yes/no) · **AI** (one estimated-spend metric P-7, budget, invocations, Brief ops) · **Data providers** (Plaid item-months estimate, crypto RPC usage vs caps, backfill budget consumption **[C1]**) · **Email** (one deliverability view) | Providers, API usage, AI and costs, Plaid usage, Email | PLATFORM_OPS |
| **4. Security, maintenance & admin** | **Security** (posture, sessions, anomalies) · **Audit** (one feed with operator-action filter — replaces 3) · **Controls** (maintenance mode, AI kill switch, cadence policies, webhook; one "danger zone" layout, reason + confirm) · **Access** (beta requests, invitations, registration mode, product status, policy groups; read-only "who holds which grant") | Security area; Controls; Growth access sections; `/admin/platform-access` (read view only) | SECURITY_OPS, PLATFORM_OPS (CONTROL), GROWTH |

`/admin` stays the break-glass console (users, grants write, 2FA reset, sessions, settings). `/admin/providers` retires once Domain 2 Connections ships (P-5, already ruled). URLs: `/dashboard/platform/<domain>/<screen>`; every current `[AREA]?workspace=` id redirects to its new home (alias table, as P-10 did).

---

## 5. Desktop and mobile direction

**Desktop (≥ lg).** Left rail: Home + four domains, each expanding to its screens (only granted screens shown); a context band shows the domain and the operator's level for the panel in focus. Content max-width 1280, 12-column grid. Each screen: status strip (≤ 4 tiles, equal size) → trends (2-up `MiniBars`/`TrendChart`, 14 d) → worklist table (real `<table>`, sortable, paged, sticky header) → detail in the right panel (`RightPanel`, as Connections already uses). Actions live only in the detail panel footer, labelled by authority ("Requires Control · reason required"). Ages auto-refresh (60 s, paused when tab hidden).

**Mobile (< lg).** Bottom bar: **Home · Customers & connections · Providers & costs · Security & admin · More** — four domains always fit, so no area is ever dropped (fixes P2-7). Screen switcher = a segmented control under the title. Tables collapse to card lists below md (row = name/subject, verdict word + dot, one metric, chevron). Detail = full-height sheet with "‹ Back". Destructive/CONTROL actions are reachable on mobile but always via the sheet with reason + confirm. Verified at 375 / 390 / 430 / 768 / 1280 / 1440.

**Visual language.** Atlas tokens as Personal; Platform accent stays violet (P-1); status = word + dot, never colour alone; one provenance chip per surface ("estimate", "as of 14:02 UTC").

---

## 6. Consolidate / retire

| Consolidate | Into |
|---|---|
| StatusBoard + OpsPlatformHealthWidget + OpsAlertsWidget + freshness/provider tiles | Home status band (one fetch per verdict) |
| JobsMatrixBlock + OpsJobHealthWidget + OpsSchedulerWidget + Manual operations | **Jobs**: one table (status, last run, 7-day success, cadence) + detail panel with Run now / Dry run (the real one) — retire the disabled lookalike and its copy (P1-5) |
| ConnectionHealthBlock + OpsConnectionHealthWidget + OpsConnectionDiagnosticsWidget + Attention connection rows | **Connections** fleet table (paged; lifts the 50 cap) |
| OpsConvergenceWidget + OpsTimelineWidget | Pipeline › Incidents timeline |
| AiActivityBlock + EconomicsBlock + OpsAiTrendWidget + OpsAiBudgetWidget + AiCostControlsPanel (read part) | **AI**: one metric reader (P-7); controls stay in Controls |
| OpsPlaidUsageWidget + EconomicsBlock Plaid + API usage | **Data providers** |
| OpsProviderHealthWidget email part + OpsEmailDeliveryWidget | **Email** |
| Ops activity feed + Security operator actions + Security audit | **Audit** (filters: operator actions · security events · all) |
| Growth sign-ups ×4 | Home trend card + Access › Requests |
| `/merchant-ops` page | Customers & connections › Merchant data |
| Retire | `AgeWithUtc`, unplaced rate-limit/env widgets (fold into status band), "· soon" sidebar entries, empty Merchant card, `/admin/workspaces` redirect, `/admin/providers` (after Connections ships) |

---

## 7. Backend gaps vs UI-only work

**UI-only (no route or schema change):** IA + nav + URL aliases; mobile bar (P2-7); consolidations in §6 that reuse existing routes; P1-5 copy; tables/a11y; auto-refresh; merchant review into the shell; stale comments; unknown-not-zero fixes.

**Small backend (guards/rails, no schema):** P1-1 kill switch in `resolvePlatformAccess`; P1-3/P1-4 gate changes once ruled; P2-2 rate limits + reauth reason; `expand-history-token` → fresh SA; CS list minimization (P2-1, if ruled).

**New read routes (read-only, area-gated, `systemDb`, bounded):**
- N1 per-job run series (unlocks `ExecutionStrip`/`RuntimeTrend`).
- N2 provider usage vs caps (`providerCallsOn` + configured caps; crypto counters already exist).
- N3 fleet backfill rollup by state + budget consumption **[C1 — Claude 1 reviews; read-only over their tables, no worker change]**.
  Claude 1's contract for N3 (2026-10-30): read state through the canonical readers, never raw columns — SOL's checkpoint lives on `Connection.cursor` (test with `isSolBackfillCursor`); ETH, BTC and token state live in `Connection.historyCheckpoint`; budgets = `ApiUsageCounter` against the env caps. Never show COMPLETE from a raw status alone; include the PARTIAL / not-valued-yet token states (#120, more coming with #122). Claude 1 reviews before implementation.
- N4 paged connection diagnostics (cursor instead of the 50 cap).
- N5 grant roster read (who holds which area/level — names only for SECURITY READ, audited).

**Needs owner decision before any backend:** P1-2 MFA activation (#78), P1-3/P1-4 levels, P2-1 list identity, P2-3 CS AI override, P2-6 ingestion-hold writer, metering for unmetered providers (eth/sol RPC, FX, Tiingo, Resend) — wiring meters touches provider clients (**not** Claude 1's history workers, but `lib/crypto/*-rpc.ts` is adjacent: coordinate).

**[C1] coordinate-before-redesign (Claude 1, 2026-10-30):** the History recovery panel + Resume history action in Connection Diagnostics, including RECOVERY_REQUIRED/FAILED gating and the flag-off disabled state; the Ops wallet history view. Restyling is fine if behaviour, gating, route contract and copy honesty ("never claim COMPLETE") are preserved. Backfill flags (`SOL_/BTC_/ETH_BACKFILL_ENABLED`, `SPL_/ERC20_HISTORY_ENABLED`) stay env-only.

---

## 8. Phased implementation plan

Each phase = small PRs to develop, full Platform/UI test suite + project tsc under the shared lock, Preview pass at 6 widths, no Production without approval.

| Phase | Scope | Type | Size |
|---|---|---|---|
| **0 — Safety first** | P1-1 kill switch; P1-5 copy; `expand-history-token` fresh; stale comments; mobile tab icons; unknown-not-zero. Then, once ruled: P1-3/P1-4/P2-2/P2-1 | backend-small + UI | 2–3 PRs |
| **1 — Shell & IA** | Four-domain rail + mobile bar (fixes P2-7) + `/dashboard/platform/<domain>/<screen>` + alias redirects for every old id. Screens initially host today's widgets unchanged | UI | 2 PRs |
| **2 — Overview & health** | Home status band (dedupe ×4), Jobs consolidation (+N1 strips), Pipeline incidents timeline, auto-refresh | UI + N1 | 3 PRs |
| **3 — Customers & connections** | Connections fleet table (+N4), detail panel restyle **[C1 review]**, Customers list per P2-1, Merchant data into shell, retire `/admin/providers` | UI + N4 | 3–4 PRs |
| **4 — Providers & costs** | Providers table (+N2), AI one-metric screen (P-7), Data providers incl. backfill rollup (+N3 **[C1]**), Email | UI + N2/N3 | 3 PRs |
| **5 — Security, maintenance & admin** | Audit (one feed), Controls danger-zone layout, Access (+N5 roster), Security posture restyle | UI + N5 | 2–3 PRs |
| **6 — Accessibility & density pass** | real tables, headings, card labels, card lists < md, density/provenance cleanup across all screens | UI | 1–2 PRs |

Phases 0 and 1 are independent of each other; 2–5 depend on 1; 3 and 4 touch **[C1]** surfaces and get Claude 1's review before merge.

---

## 9. Security and regression risks

| Risk | Mitigation |
|---|---|
| A domain screen accidentally renders a panel the operator's area grant does not cover | Panels keep their own `requirePlatformAccess`/client gate; domain visibility derived from grants by one pure function with tests per grant combination; no new cross-area route |
| Deep links / bookmarks break with the new URL scheme | Alias table for every `[AREA]?workspace=` id (pattern proven in P-10), redirect tests |
| Consolidation drops a capability | Capability checklist per screen from §1.4 + `capability-classification.ts`; each retired widget's tests re-pointed, not deleted |
| Pinned tests (122 Platform test files; `platform-nav-shell`, `personal-nav-baseline`, workspace registry pins) | Re-rule in the same PR, justified per pin; Personal chrome byte-identical (`personal-nav-baseline.json`) |
| Identity exposure grows (customers list, grant roster) | Default minimized; any new identity read is audited; owner ruling P2-1 first |
| CONTROL actions become easier to trigger on mobile | Actions only in detail sheet, fresh authority, reason + confirm unchanged |
| Kill-switch fix locks out a legitimate break-glass session | Behind the same `env.isSystemAdminDisabled` read as `/api/admin`; documented; test both states |
| History recovery regressions **[C1]** | No behaviour change; Claude 1 reviews; copy-honesty pins kept |
| Shared 8 GB machine | One heavy job at a time under the shared lock; no Docker; Preview checks via owner Chrome / CDP |

---

## 10. Decisions requested from the owner

1. Approve the four-domain IA (§4) and URL scheme (`/dashboard/platform/<domain>/<screen>` with aliases).
2. P1-3: fleet backfill / `sync-banks` from Manual operations → CONTROL + reason (recommended), matching single-wallet resume.
3. P1-4: registration mode / product status → CONTROL + reason (recommended).
4. P2-1: CS customer list — minimized (opaque ref + institution/state; identity only in audited detail, **recommended**) or keep emails in the list and audit list reads.
5. P2-3: per-customer AI USD override — keep at CS WRITE or require Ops CONTROL.
6. P2-6: build the `ingestion_paused` writer (CONTROL, reason) or remove the dead read.
7. SEC-PLAT-1 (#78) operator MFA activation — still pending.
8. Which unmetered providers to meter first (recommended: Resend auth mail, then eth/sol RPC).
9. Start order: Phase 0 + Phase 1 in parallel (recommended).

---

# Part B — Platform Operations: policies, capability entitlements and economics (rev 2)

## 11. What exists today (verified)

**Customer entitlements already exist** — a small, sound engine to extend, not replace:

| Piece | Where | Facts |
|---|---|---|
| Capability catalogue | `lib/entitlements/catalogue.ts` | 9 typed dimensions with **platform ceilings**: `conversations`, `dailyBrief` (boolean); `aiTurnsPerMinute` ≤30, `aiTurnsPerHour` ≤60, `manualWalletRefreshPerHour` ≤6, `exportsPerDay` ≤10, `aiDailyUsdAllowance` ≤20, `maxConnections` ≤25 (count); `manualBankRefreshCooldownMinutes` ≥15 (floor) |
| Policy groups | same, **in code** | one group `BETA_FULL_ACCESS_V1` (default) + one overlay `FOUNDER_INTERNAL_V1`; cohorts `CLOSED_BETA_2026` |
| Assignment | `CustomerPolicyAssignment` (userId unique → `policyGroup`, `overlay?`, `aiDailyUsdAllowanceOverride?`), `CustomerCohort` | CS WRITE + reason, audited (`lib/platform/customer/assign.ts`) |
| Resolver | `lib/entitlements/resolve.ts` | per dimension: POLICY → OVERLAY → USER_OVERRIDE / PLATFORM_SETTING, **clamped to the ceiling**; every value carries its `source` and an explanation |
| Enforcement | server-side, per route | chat (`conversations`, turns, `aiDailyUsdAllowance`), brief, `accounts/[id]/sync` + `plaid/refresh` + `refresh-all` (cooldowns), `user/export`, `plaid/link-token` + `accounts/wallet` (`maxConnections`) |
| Read view | `GET /api/platform/growth-revenue/policy-groups` (GROWTH READ) + Growth widget | dimensions, groups, overlays, cohorts with customer counts |
| Platform policies (operator-side, not entitlements) | `lib/platform/policies/*`, `lib/platform/ai/cost-controls*` | BANK/WALLET refresh cadence (honourable = multiple of the 15-min wake), per-job cadence, maintenance mode, AI kill switch, fleet allowance, spend alerts — CONTROL + reason, CAS, audited |
| Feature flags | env only | `*_ENABLED` (investments, SPL/ERC20 history, backfills, prices…) — no runtime rollout or pause per capability |

**Gaps against the directive:** groups are code constants (not editable, not versioned in data); no exceptions with expiry (only the one AI override); **an unknown assigned group silently resolves to the default group** (`resolve.ts:77`) — not fail-closed; no global rollout/pause per capability; no cost per entitlement; policy views live under Growth.

## 12. The hard separation: customer entitlements ≠ operator permissions

| | Customer **entitlements** | Operator **permissions** |
|---|---|---|
| Answers | what a *customer* may use in the product, and how much | what an *operator* may see or do in Platform |
| Model | capability registry + policy groups + exceptions | `PlatformGrant` (area × READ/WRITE/CONTROL), `SYSTEM_ADMIN` |
| Code | `lib/entitlements/**` | `lib/platform/policy.ts`, `authorize.ts`, `lib/session.ts` |
| Edited from | Platform › Policies (definitions), Customers & Success (assignment, exceptions) | `/admin/platform-access` only |

Invariants (each becomes a test before Phase 2 merges): the capability registry can name no Platform area, grant level, role, admin route or DB permission; resolver output types share no field with `PlatformAuth`; no `lib/entitlements` import in `lib/platform/authorize.ts` or `lib/session.ts` and vice versa; a policy group can never be assigned to a `SYSTEM_ADMIN` and never changes `role`.

## 13. Capability registry design (Phase 2)

Extend `ENTITLEMENT_DIMENSIONS` into a typed `CAPABILITY_REGISTRY` (code, versioned with the repo — capabilities are code because enforcement is code):

```ts
interface CapabilityDef {
  id: string;                 // stable, e.g. "ai.conversations.turnsPerHour"
  name: string; description: string;
  category: "ai" | "connections" | "refresh" | "data" | "reports" | "experimental";
  valueType: "boolean" | "count" | "minutesFloor" | "usd";
  safeDefault: boolean | number;   // what an unknown / missing value resolves to: OFF / 0 / strictest floor
  constraints: { min?: number; max: number /* platform ceiling */; step?: number };
  enforcementOwner: string[];      // files that enforce it (pinned by a test: each must call the resolver)
  customerConfigurable: boolean;   // may appear in policy groups / exceptions
  experimental: boolean;           // only grantable when its rollout state allows
  costDrivers: { driver: CostDriverId; telemetry: "observed" | "partial" | "none" }[];
  introducedIn: string; deprecatedAt?: string; replacedBy?: string;
}
```

**Fail-closed rules:** unknown capability id → `safeDefault` (and a logged error), never "allow"; a group missing a capability → `safeDefault`, never unlimited; values outside `constraints` are rejected at save time and clamped at read time; enforcement stays server-side in the owning route (the registry adds a test that every `enforcementOwner` calls the resolver).

## 14. Policy data model and precedence (Phase 2 — additive schema only)

```
PolicyGroup         id, key (unique, immutable), name, description, kind (FREE | PAID | PRO | FOUNDER | BETA | CUSTOM),
                    status (ACTIVE | ARCHIVED), currentVersionId, createdAt, createdById
PolicyGroupVersion  id, groupId, version (1,2,…), values JSONB (validated against the registry), changeSummary,
                    reason {code,note}, createdAt, createdById            — append-only, never edited
CustomerPolicyAssignment  (existing) + policyGroupId (FK, nullable during migration); string key kept until cut-over
CustomerEntitlementException  id, userId, capabilityId, value, reason, startsAt, expiresAt (REQUIRED, ≤ 90 days),
                    createdById, revokedAt, revokedById                  — bounded by the capability ceiling
CapabilityRollout   capabilityId, state (ON | PAUSED | GROUPS_ONLY), groupIds[], reason, updatedAt  — global rollout/pause
```

Migration: seed `BETA_FULL_ACCESS_V1` → group "Beta" v1 and `FOUNDER_INTERNAL_V1` → group "Founder" v1 with identical values; backfill `policyGroupId`; resolver reads DB versions with the code constants as a shadow comparison until equal for every customer; then cut over. Rollback = resolver flag back to code constants (no data loss; versions stay).

**Precedence (highest wins, evaluated server-side per request):**

1. **Emergency controls** — maintenance mode, AI kill switch, provider pauses (Policies › Emergency controls).
2. **Platform ceilings / safety floors** (registry `constraints`, refresh floors, provider budgets).
3. **Global rollout state** (`CapabilityRollout`: PAUSED ⇒ off for everyone; GROUPS_ONLY ⇒ only listed groups).
4. **Active, unexpired customer exception** (clamped to 2).
5. **The customer's group, current version.**
6. **Capability `safeDefault`** (unknown group / missing value).

No inheritance between groups in the first cut (clone instead) — deterministic and auditable. Inheritance only if the owner asks later, as an explicit `extends` resolved at save time into a full value set.

**Lifecycle:** create · clone · rename (name only; key immutable) · edit (= new version, reason required, shows affected-customer count and a value diff before saving) · compare any two versions · restore (= new version copying an old one, audited) · archive (only with 0 assigned customers, or after a bulk reassignment the operator confirms) · delete (only if never assigned; otherwise archive). Deletion can never orphan a customer.

## 15. Enforcement migration plan

1. Registry introduced alongside the catalogue (same ids mapped), tests pin parity.
2. DB groups seeded, resolver shadow-reads DB vs code, mismatches logged (no behaviour change).
3. Cut-over flag per environment (Preview first); enforcement owners unchanged — they already call `loadEffectiveEntitlements`.
4. Exceptions + rollout states added; expiry evaluated at read time (no worker needed; an optional daily sweep only tidies rows).
5. Rollback at any step: flag to code constants; schema additive, nothing dropped.

## 16. Policy economics design (Phase 3)

**Cost sources, honestly classified:**

| Driver | Source today | Class |
|---|---|---|
| AI conversations, Daily Brief | `AiInvocation` tokens × `AI_RATES` (`lib/usage/pricing.ts`) | **observed estimate** (failed calls = unknown, never 0) |
| Bank connections | Plaid Item-months × `PLAID_RATES` (`lib/platform/plaid/item-months.ts`) | **observed estimate**; billed = unknown until invoices are entered |
| Crypto history / sync | `ApiUsageCounter` calls (ALCHEMY / ESPLORA / COINGECKO) × `ALCHEMY_PAYG` CU pricing where applicable | **partial** (counts observed; $ estimate for Alchemy only; Esplora/CoinGecko plan = shared fixed) |
| Current-balance RPC, FX, prices (Tiingo), email | not metered | **unknown** — shown as unknown, never 0 |
| Infrastructure (Vercel, Postgres, Resend, domains) | none | **operator-entered assumption** (monthly bill, allocation rule) |
| Billed cost | none recorded | **billed** column empty until the owner enters invoices |

**Per policy group, per customer per month:**
- **Typical** = P50 of observed monthly cost among the group's customers with ≥ 14 days of data; **Heavy** = P90; both carry *n customers* and *days observed* as coverage/confidence.
- **Maximum allowed exposure** = what the entitlements permit at their ceilings (e.g. `aiDailyUsdAllowance` × 30 + Item-months for `maxConnections` + wallet refresh budget). **Allowances are ceilings, not spending** — shown separately and never summed into "typical".
- **Breakdown by capability** via each capability's `costDrivers`.
- **Variable vs allocated fixed:** variable = per-use drivers; fixed = operator-entered shared plans (CoinGecko, base infra) allocated by an explicit rule (per active customer, or per connection) the operator chooses and the UI states.
- **Population projection** = Σ over customers in the group (or a hypothetical count).
- **Pricing model:** hypothetical monthly price → gross margin (typical / heavy / max-exposure), break-even price, and a sensitivity table (±20 % usage, ±rate-card change). Unknown costs are listed as excluded with their reason, so the margin is labelled "excluding unknown costs".

**Refresh cost & feasibility:** Plaid transactions are billed per Item-month (refresh frequency does not change that cost, but extra `/transactions/refresh` calls are separate and rate-limited); wallet refresh cost = provider calls per refresh × rate. The configurator **refuses a cadence the platform cannot honour**: below the 15-min scheduler wake, not a multiple of it, below a provider's floor or budget, or below the safety floor (`manualBankRefreshCooldownMinutes` ≥ 15). It never offers "10-minute refresh".

## 17. Known telemetry gaps (must stay visible as "unknown")

Billed costs (no invoices recorded) · current-balance RPC (`eth-rpc`, `sol-rpc`) · FX (Frankfurter/OXR) · Tiingo · Resend (auth mail unrecorded) · infra (Vercel/DB/domains) · Esplora/CoinGecko plan fees · AI ledger write failures (`readLedgerWriteFailures` unexposed) · per-customer attribution of shared jobs (fleet syncs, price fetches) · Plaid `/transactions/refresh` call costs.

## 18. Navigation model (Platform Operations)

| Workspace | Contents (from today's six) |
|---|---|
| **Operations** | Health status band (alerts · provider health · freshness · jobs, once), Jobs (one table + detail, Run now / Dry run — fleet runs CONTROL + reason), Pipeline & incidents, Connections fleet table + diagnostics **[C1]** |
| **Providers** | Provider health, usage vs caps (crypto counters, Plaid), email deliverability, provider cleanup |
| **AI & Costs** | One estimated-spend metric, invocations, Brief ops, Plaid Item-months, cost summary — later the policy Economics views |
| **Policies** | **Policy groups** (read-only in Phase 1: groups, overlays, cohorts, dimensions vs ceilings, affected customers) · **Platform defaults** (refresh cadence, job cadence, AI allowance & cost controls) · **Alerts** (rules + recent deliveries) · **Emergency controls** (maintenance mode, AI kill switch, Plaid webhook — danger-zone layout, reason + confirm) |

Old `?workspace=` ids alias to the new four. Customer Success keeps assignment and (Phase 4) exceptions; Growth keeps adoption and access.

## 19. Revised phases and genuinely necessary owner decisions

| Phase | Scope | Status |
|---|---|---|
| **0 — Security** | kill switch on Platform APIs · operator 2FA (dormant switch, Preview first) · fleet runs CONTROL + reason · regression tests | **PR #131** |
| **1 — Platform Ops UX** | Operations / Providers / AI & Costs / Policies; Policies sub-sections over existing data (adds one PLATFORM_OPS-READ twin of the policy-groups read); mobile layout; aliases; no behaviour change | next PR |
| **2 — Entitlement engine** | registry, DB groups + versions, exceptions, rollout states, precedence, fail-closed, separation tests; shadow then cut-over | after review of §13–§15 |
| **3 — Economics** | per-group Economics view, scenarios, pricing & margin, refresh feasibility | after Phase 2 |
| **4 — Customers & Success** | assign group, effective entitlements, usage & cost, bounded expiring exceptions, history, affected counts | after Phase 2 |

**Decisions that genuinely need the owner (everything else proceeds on the recommendation):**

1. **Who edits policy-group definitions** — recommended: PLATFORM_OPS **CONTROL** + reason (definitions change every assigned customer's limits and costs); CS **WRITE** assigns; CS **WRITE** grants exceptions only within ceilings, ≤ 90 days, with reason. *(security policy)*
2. **Unknown / missing group at read time** — today it silently becomes the default group. Recommended: resolve to capability `safeDefault`s (fail closed) **and** raise an operator alert — customers in that state lose cost-bearing features until fixed. *(material product trade-off)*
3. **Operator 2FA activation on Preview** — #131 ships it dormant. Preview's operator account has no TOTP (10-27 count); activation will send it to enrolment on its next Platform visit. Recommended: approve Preview activation once #131 merges; Production later with §1.1 count = 0.
4. Still open from §10: registration-mode / product-status level (P1-4), CS customer-list identity (P2-1), CS per-customer AI override authority (P2-3), ingestion-hold writer (P2-6), first unmetered providers to meter.

Free / Paid / Pro values and prices are **not** decisions for now: Phase 2 ships the editor; the owner fills the numbers in the Policies UI, with Phase 3's economics beside them.

## 20. Owner rulings (2026-10-30)

1. **Operator 2FA — APPROVED for Preview only.** Done: `OPERATOR_TOTP_ENFORCEMENT=enforce` on Preview (develop branch scope), develop redeployed. Production enforcement needs separate approval. Verification steps: enrolment, existing-session enforcement, privileged API denial, recovery-code sign-in, disable → re-enrolment.
2. **Policy-group definitions — APPROVED:** create / edit / clone / archive / any modification requires **PLATFORM_OPS CONTROL + operator reason + audit trail**. Customer Success may **assign existing groups** and issue **bounded, time-limited exceptions within centrally defined limits**; it may not modify definitions, exceed platform safety limits, or grant operator privileges. (Built in Phase 2/4.)
3. **Missing / invalid assignment — APPROVED WITH MODIFICATION: fail closed.** Never fall back to Beta or any paid-capability group. Deny unverified paid entitlements and **new** costly operations; **preserve** login, existing records and safe read-only access; never delete data, disconnect accounts or rewrite assignments. Raise an **actionable operator alert identifying the affected assignment**; correcting the assignment restores normal entitlements automatically (resolved per request — no repair job). Implemented as its own PR behind a Preview-first switch; not deployed to Production without separate approval.

Phase 1 UX continues behaviour-preserving and separate from the policy engine (PR #132).

