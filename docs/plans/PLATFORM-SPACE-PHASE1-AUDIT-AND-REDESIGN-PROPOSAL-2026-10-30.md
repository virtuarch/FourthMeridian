# Platform Space — Phase 1: audit and redesign proposal

| | |
|---|---|
| **Status** | PROPOSAL for owner review. No code changed. Implementation waits for approval of §4 (IA) and §8 (phases). |
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
| P1-1 | **DISABLE_SYSTEM_ADMIN kill switch does not cover Platform APIs.** It is enforced at login (`lib/auth.ts:257`) and on `/api/admin/**` (`lib/session.ts:344-352`), but the Platform break-glass bypass (`lib/platform/authorize.ts:93`) returns before any check. A SYSTEM_ADMIN session issued before the switch is flipped keeps full Platform API authority (incl. CONTROL) until it expires. | verified | backend, small |
| P1-2 | **Operators are not required to use MFA.** `requiresTotpEnrollment` forces TOTP only for SYSTEM_ADMIN; grant holders are USER. `require_totp_admins` is enforced nowhere. Fix exists as #78 (DRAFT). | `lib/auth-totp-policy.ts`, `SECURITY_MODEL.md:51` | owner activation |
| P1-3 | **Privilege inversion on provider-cost work.** Resuming ONE wallet's history needs CONTROL + reason; running the FLEET `sol-history-backfill` or `sync-banks` from Manual operations needs only WRITE with no reason. The code marks it UNRESOLVED. | `lib/platform/operations/registry.ts:194,223`; `capability-classification.ts:288` | owner ruling → backend |
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
