# Platform Spaces 2.0 — Visual Architecture Plan (2026-10-31)

Owner directives: *PLATFORM SPACES 2.0 — extend the design system to every remaining Space*, and the *Heatmaps* addendum.
Preview only. Production and `main` are not touched.
This plan is the contract for the per-Space PRs. Owner visual acceptance is required for each Space.

## 1. Inventory

Every Platform Space renders through `/dashboard/platform/[area]` and `PlatformSpaceDashboard`. Navigation is three destinations: Overview | AI | Current Space.

| Space | Workspaces today | Rendering today | 2.0 target |
|---|---|---|---|
| Platform Operations | Operations (Overview · Jobs · Pipeline), Providers, AI & Costs, Policies | **Ops 2.0 leads** | Unchanged. Gets heatmaps: job failures by day×job and provider reliability (§4). |
| Growth | Overview: 7 stacked legacy widgets | legacy `PlatformWidgetCard` / `SectionSurface` | **GrowthLead** (reference design, built first) |
| Security | Overview (posture) · Audit · Operator actions | legacy | **SecurityLead** + the existing feeds as drill-downs |
| Customer Success | Customers · Incidents | legacy | **CustomerSuccessLead** + the customer list kept first-class |
| Merchant Operations | One link card to `/merchant-ops` (outside the shell) | link only | **MerchantLead** inside the shell: coverage and review analytics. The review page stays. |
| Platform AI (`/dashboard/platform/ai`) | placeholder | — | Out of scope; it has no data. |
| `/admin/*` console | SYSTEM_ADMIN only | — | Out of scope. It is not a Platform Space. |

Nested surfaces carried into each redesign:
- Growth: the beta request drawer, the invitation drawer, mode/status confirms, and the cold-invite form.
- Customer Success: the audited profile drawer and its 4 write actions.
- Security: the audit feed and operator feed (detail views).
- Merchant: the review list and its decide action.

## 2. Shared skeleton

The grammar is the one owner-reviewed in Ops 2.0. Every Space uses:

1. **Hero.** `HealthHero`: a compact Personal hero card below lg, a bare hero plus 4 `Surface` tiles at lg and up, with a period control beside the title where one is meaningful.
2. **Analytics grid.** A 12-column grid at lg and up, single column below. Charts sit in Atlas `Block` + `Surface`, with a `Caption` line beneath for unit, window and gaps. A `ChartMessage` covers loading and unavailable states; it never draws a fake chart.
3. **Work queue.** A compact table at lg and up, a list below. Actions open `DetailDrawer` or ConfirmDialog, keeping the existing gating.
4. **Detail.** Legacy widgets stay reachable, unchanged, as **hosted drawers**. Progressive disclosure replaces walls of text.

Lead source rules are already ratcheted for Ops and are extended to every new lead:
- no `CONTROL` / `canControl` / `canWrite`;
- no `matchMedia`;
- no raw `fetch(` (use `useSharedWidgetFetch`);
- a pure `*-model.ts` beside every lead.

## 3. Chart and heatmap kit — `components/platform/charts/`

One kit, shared by every Space. Personal components are imported, never forked.

| Primitive | Source | Use |
|---|---|---|
| `TrendChart` | Personal | Money series only |
| `DayBars` / `Sparkline7` | ops-visual | Daily counts. A hatched gap means no data; it is never drawn as a zero. |
| `BreakdownWidget` | Personal | Donut, bar or list proportions |
| **`HeatGrid`** (new) | charts | Generic rows×cols grid (see the cell model below) |
| `CalendarHeatmap` | charts | Daily activity calendar (weekday × week) |
| `WeekHourHeatmap` | charts | Weekday × hour of day, UTC |
| `CohortHeatmap` | charts | Cohort × offset, or cohort × stage, with denominators |
| **`FunnelBars`** (new) | charts | Strict stage funnel: count, step conversion, drop-off |

Heatmap rules from the owner addendum:
- **Cell model:** `value` (with an optional numerator/denominator), `zero`, `noData` (outside source coverage: hatched), and `immature` (the period has not finished: dashed outline).
- **Colour:** a single-hue Meridian luminance ramp in 5 bins, with a legend showing Less→More, "None" and "No data".
- **Interaction:** hover, focus or tap shows the exact value, the denominator and the period. Each grid also has a screen-reader summary.
- **Coverage:** a heatmap renders only when its source covers at least 2 periods. Otherwise the card shows an honest "not enough history yet".

## 4. Data authority by Space (audited)

### Growth (built first)

| Chart | Source | Coverage |
|---|---|---|
| Beta requests per day + calendar | `BetaAccessRequestEvent.receivedAt`, distinct email per day | ~2026-10-07 onward; kept 180 days |
| Registrations per day | `User.createdAt` | complete; deleted users drop out |
| Waitlist status | `BetaAccessRequest.status`, invite expiry | current state only |
| Acquisition sources | first submission `source` (utm/referrer, allowlisted) | from 2026-10-07 |
| Onboarding funnel | existing strict `buildFunnel` | complete, first-ever instants |
| Onboarding by cohort × stage | weekly registration cohorts × `furthestStage` | complete |
| Active users (present / engaged) | existing `activitySets` | ~2026-10-06/15 onward |
| Feature adoption | existing `buildFeatures` | 30 days |
| Retention cohort heatmap | registration week × week k engaged ÷ cohort | engagement data from ~10-06/15. Earlier cells are `noData`. |
| Sign-ins by weekday × hour | AuditLog `LOGIN` | window |
| AI chat turns by weekday × hour | `AiInvocation` chat, distinct turn | 90 days |

Not available, so not drawn: revenue, waitlist→registration conversion for open-mode registrants (only the invited path links via `redeemedUserId`), and a first-financial-snapshot stage (snapshots are per Space; deferred).

Beta signup list:
- Position 3 in the page order: header → acquisition overview → **list** → charts.
- Desktop table and mobile list.
- Client-side search, status filter and sort over the ≤100+100 rows the route returns.
- Every existing action, confirmation, reason and `canWrite` region is preserved (`write-access-gating.test.ts`).

### Security
- **Available:** `LOGIN` / `LOGIN_FAILED` over time, with reasons split into credential vs blocked; platform access denials (a lower bound, throttled); `PLATFORM_CONTROL_REFUSED`; operator actions by action and result; current 2FA posture; enforcement settings; sessions.
- **Heatmap:** failed sign-ins by weekday × hour.
- **Not available, shown as such:** lockouts, verified incidents, stored severity, rate-limit blocks.
- **Wording:** routine denials are never called attacks. Anomaly trips are labelled detector windows, not incidents.

### Customer Success
- **Available:** onboarding stage per customer, connection health, `SyncIssue` episodes (opened/resolved daily), policy-assignment health, and the customer list with its audited profile.
- **Heatmap:** onboarding friction by registration cohort × stage (the Growth `CohortHeatmap`).
- **Not available:** support tickets and health scores.

### Merchant Operations
- **What it is:** a transaction-merchant identity review. It does **not** process payments, so it gets no payment, settlement or processing charts.
- **Available:**
  - merchant coverage (transactions with vs without `merchantId`);
  - `categorySource` mix;
  - alias growth by source;
  - USER rule creation;
  - merge decisions over time (merged vs dismissed);
  - pending candidates by tier. This is costly, so it is computed on demand, never on page load.

### Platform Operations
- Job execution heatmap (job × day, failure share) from `JobRun`.
- Provider reliability (provider × day) from `RefreshExecution`.
- Added after the four Spaces, inside the existing leads.

## 5. Order of work

Each Space is its own PR. Every PR gets independent review, CI, a merge to `develop`, Preview verification, and screenshots at 390 and 1280 px (plus 375/430/768/1440 before acceptance is requested).

1. **Growth.** Chart and heatmap kit + acquisition reader + GrowthLead + beta list redesign.
2. **Security**
3. **Customer Success**
4. **Merchant Operations**
5. **Ops heatmaps**

Session 1 owns crypto/history files. This work stays inside `components/platform/**`, `lib/platform/{growth,security,customer,merchant}/**`, `app/api/platform/**` and `lib/platform/workspaces.ts`.
