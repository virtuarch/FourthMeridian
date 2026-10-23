# BETA PRODUCT ANALYTICS — MINIMAL FIRST-PARTY DESIGN

**Status:** ASSESSMENT / AWAITING OWNER APPROVAL · **Date:** 2026-10-15 · **Baseline:** v2.6 @ 0f07a62 · **Scope:** first-party behavioral analytics for the first beta users, integrated with UX P2 and the cost-economics work. Nothing here is implemented.

**Evidence tiers:** VERIFIED (file:line) · PROPOSED · INFERRED.

---

## 0. What exists today (VERIFIED)

- **No analytics SDK.** Only Sentry error capture (`package.json:109-110`, `tracesSampleRate: 0`, `sendDefaultPii: false`). No client-side event helper.
- **Ledgers that already answer product questions:** `User` (createdAt, emailVerifiedAt, acceptedTermsAt, deactivatedAt, `lastBriefViewedAt` which has no writer), `UserSession` (createdAt, lastActiveAt touched at most once per 60 s on a live session check, `lib/auth.ts:666-668`, `lib/auth/session-activity.ts:58-89`), `AuditLog` (`REGISTER`, `EMAIL_VERIFIED`, `LOGIN`, `SPACE_SWITCH`, `SPACE_CREATE`, `ACCOUNT_ADD`, exports, Plaid/wallet/manual actions), `AiInvocation` (userId, spaceId, surface `chat|brief|harness`, outcome), `DailyBrief` (ownerUserId, generatedAt, lastFailedAt), `PlaidItem` / `Connection` / `FinancialAccount(syncStatus='manual')` (createdAt), `RefreshExecution` (trigger MANUAL/CRON/WEBHOOK/…).
- **Write path and contract:** `buildAuditData` → `auditInsert` (`lib/audit.ts:72-143`): `{userId?, action, ipAddress, userAgent, performedByAdminId?, metadata}`; metadata rule "counts/ids/kinds only — never financial values or user content" (`lib/audit.ts:23-24,79`). About 80 sites still call `db.auditLog.create` directly (`lib/audit.ts:40-52`).
- **Existing contract violations:** `REGISTER`, `EMAIL_VERIFIED`, `BETA_ACCESS_REQUESTED` store the raw email; `MANUAL_ASSET_ADD` stores name, balance, purchase price; `WALLET_ADD` stores the wallet address (`app/api/auth/register/route.ts:295`; `verify-email/route.ts:80`; `access-request/route.ts:123`; `accounts/manual/route.ts:254-260`; `accounts/wallet/route.ts:443`). `WALLET_ADD` and `MANUAL_ASSET_ADD` are raw strings absent from `AuditAction`.
- **RLS:** `AuditLog` fm_app SELECT own-or-visible-Space + INSERT; fm_system ALL; fm_auth INSERT only, no SELECT (`20261002000100_rls_roles_and_policies:591-598`; `20261002000200_rls_auth_surface:31-32`). `UserSession` fm_app CRUD scoped to self. No retention or purge for `AuditLog` or `UserSession`; on account deletion `AuditLog.userId` is set null (`lib/account-deletion/purge.ts:300-333`; `schema.prisma:3194`).
- **Current activity readers:** DAU/WAU/MAU = distinct `AuditLog LOGIN` users (credential sign-in only under a 30-day JWT; `lib/platform/activity/activity.ts:68-110`); `active7`/`returning7`/`activatedEver` over `UserSession` (`lib/platform/growth/growth.ts:106-115,178`; `signups/route.ts:29,46`); growth funnel = requested → approved → redeemed → activated (`growth.ts:58-84,167-182`); per-customer AI usage and cost (`lib/platform/customer/customer-detail.ts:120-124`, `customer-core.ts:262-291`); `firstConnectedAt` = min(PlaidItem, wallet).createdAt, manual excluded (`customer-core.ts:206-210`).
- **UI home today:** Growth & Revenue is one workspace of six card-grain widgets (`lib/platform/workspaces.ts:162-163`); Customer Success has per-customer lifecycle/activity/AI panels; Platform Ops has the UX P1 Attention Required and AI/Economics blocks.
- **Errors affecting users** are recorded in `RefreshExecution`, `SyncIssue`, `AiInvocation.outcome`, `DailyBrief.lastFailedAt`, `PLAID_ITEM_STATUS_CHANGED`, `NotificationDelivery`; all join to a user (directly or via Item/account) and surface on Platform Ops (identity-minimised) and Customer Success.

---

## 1. Canonical event taxonomy (PROPOSED)

Three strata, always kept apart on every surface:

| Stratum | Meaning | Source of truth |
|---|---|---|
| **Registration** | an account exists | `User.createdAt` (+ `emailVerifiedAt`, `acceptedTermsAt`), `AuditLog REGISTER`, beta request/approve/redeem rows |
| **Authenticated presence** | a person signed in or kept a live session | `UserSession.createdAt` (`LOGIN`), `lastActiveAt`, new `SESSION_ACTIVE_DAY` |
| **Meaningful product activity** | the person did something in the product | product events below + derived activity (AI chat turn, Brief view, connection added) |

Never engagement: `RefreshExecution` with trigger CRON/WEBHOOK/RESUME/OPERATOR, any `AiInvocation` with surface `harness`, scheduled jobs, operator actions, webhook deliveries.

**Events written (new, as `AuditAction` members; one row per user per UTC day where stated):**

| Event | When | userId | spaceId | metadata (ids, kinds, day only) |
|---|---|---|---|---|
| `SESSION_ACTIVE_DAY` | first live session check of a UTC day for that user | yes | — | `{ day }` |
| `SPACE_VIEWED` | the Space server page renders for a member (once per user, Space, day) | yes | yes | `{ day, spaceType }` |
| `BRIEF_VIEWED` | `GET /api/brief` returns ok (once per user, Space, briefDay) | yes | yes | `{ briefDay, cached: boolean }` |
| `TRANSACTIONS_VIEWED` | the transactions workspace loads (once per user, Space, day) | yes | yes | `{ day }` |
| `MANUAL_ASSET_VALUE_UPDATED` | `PATCH /api/accounts/manual/[id]` succeeds | yes | — | `{ accountId }` (no value) |
| `WALLET_ADD` → `AuditAction.WALLET_ADD` | existing writer, normalised | yes | — | `{ connectionId, chain }` (drop the address) |
| `MANUAL_ASSET_ADD` → `AuditAction.MANUAL_ASSET_ADD` | existing writer, normalised | yes | — | `{ accountId, currency }` (drop name, balance, purchase price) |

**Derived, not re-evented:** AI chat turn = `AiInvocation` surface `chat` (per turn: `correlationId#turnIndex`); Brief generation = surface `brief`; Plaid connection = `PlaidItem.createdAt` + `ACCOUNT_ADD`; scenario/goal-seek = `AiInvocation.subSurface` once the tool name is recorded there (today `chat:answer`); exports = `EXPORT_*` audit actions (exist).

Not collected: page views in general, clicks, scroll, client-side timing, prompt text, transaction descriptions, financial values, institution names on fleet surfaces, IP/UA beyond what `buildAuditData` already captures for security actions (product events pass `ipAddress: null, userAgent: null` — PROPOSED addition to the input type).

## 2. Server-side capture (PROPOSED)

All seven events are written **server-side** in route handlers and server components through `buildAuditData` + `auditInsert` (or `withTenantDb` where the request runs on the tenant principal), never from the client. Dedupe per user-day is done by the writer with an `INSERT … WHERE NOT EXISTS` on `(userId, action, metadata->>'day')` inside the same statement, so a reload never double-counts and no read-back is needed on fm_auth.

`SESSION_ACTIVE_DAY` writer: extend `touchSessionActivity` (`lib/auth/session-activity.ts:73-89`) so the same autocommit `UPDATE … RETURNING` yields the previous `lastActiveAt`; when its UTC date is earlier than today's, insert the day row (fm_auth holds INSERT on `AuditLog`, no RETURNING needed). The 60-second throttle means presence is recorded at least once per active minute, which is exact at day grain.

Client code: none. A `product-events.ts` helper exposes one typed function per event with the allowed metadata keys as its only parameters, so a caller cannot pass a name, amount or description by construction.

## 3. DAU / WAU / MAU (PROPOSED)

| Metric | Definition | Reader |
|---|---|---|
| Registered | `User` rows (`deactivatedAt null` shown separately) | existing |
| Present (D/W/M) | distinct users with a `SESSION_ACTIVE_DAY` on the day / any of the trailing 7 / 30 UTC days | new; replaces the `LOGIN` basis in `activity.ts:68-75` (keep "sign-ins" as its own stat) |
| Engaged (D/W/M) | distinct users with ≥1 product event, or an `AiInvocation` with surface `chat`/`brief` and a userId, or an `ACCOUNT_ADD`/`WALLET_ADD`/`MANUAL_ASSET_ADD`, on the day / trailing window | new |
| Sign-ins | distinct `LOGIN` users (credential events) | existing, relabelled |

Both present and engaged are always shown together; a healthy beta has engaged ≈ present. Harness, cron and operator rows are excluded by the filters above.

## 4. Returning users and D1 / D7 retention (PROPOSED)

- **First visit** = date of the user's first `UserSession.createdAt` (fallback `User.createdAt`).
- **Returning** = engaged on any UTC day strictly after the first-visit day.
- **D1 retention** of a registration cohort (users whose first visit falls in week W) = share engaged on first-visit day + 1.
- **D7 retention (window)** = share engaged at least once in days 1–7 after first visit — the primary figure at beta scale (n ≤ 10); **D7 (strict)** = engaged on day 7 (±0) reported beside it.
- Cohorts are weekly by first-visit week; a cohort younger than the horizon renders "not yet measurable", never 0 %.

Requires `SESSION_ACTIVE_DAY` (presence) and the engaged filter above; without the day row only "returning ever" is computable from `lastActiveAt`.

## 5. Feature adoption and usage (PROPOSED)

| Feature | Adoption (distinct users, 30 d) | Frequency (events per engaged user per week) | Source |
|---|---|---|---|
| AI Chat | users with ≥1 `AiInvocation` surface `chat` | turns per user per week; conversations per user (distinct `conversationId`) | `AiInvocation` |
| Daily Brief | users with ≥1 `BRIEF_VIEWED` | views per user per week; open rate = views ÷ Briefs generated for that owner | `BRIEF_VIEWED`, `DailyBrief` |
| Personal Spaces | users with ≥1 `SPACE_VIEWED`; Spaces per user | Space-days per user per week; shared-Space share | `SPACE_VIEWED`, `SpaceMember` |
| Transactions | users with ≥1 `TRANSACTIONS_VIEWED` | views per user per week | `TRANSACTIONS_VIEWED` |
| Connections | users with ≥1 ACTIVE Plaid Item / wallet / manual asset | connections per user; manual value updates per month | `PlaidItem`, `Connection`, `FinancialAccount`, `MANUAL_ASSET_VALUE_UPDATED` |
| Exports | users with ≥1 export | per month | existing `EXPORT_*` |

Adoption = adopted ÷ registered (not ÷ engaged); frequency = events ÷ engaged users in the window. Both are fleet counts (Growth & Revenue); the per-user table lives in Customer Success.

## 6. Onboarding conversion funnel (PROPOSED; every step derivable today except the two marked)

| Step | Evidence | Abandonment flag (no next step within 7 days) |
|---|---|---|
| Requested → approved → redeemed | `BetaAccessRequest` statuses (existing funnel) | existing |
| Registered | `User.createdAt` | — |
| Verified | `emailVerifiedAt` (set at birth for invited sign-ups) | not verified in 7 d |
| First session | first `UserSession` | registered, never signed in |
| First connection | min(`PlaidItem`, wallet `Connection`, manual `FinancialAccount`).createdAt — **manual to be included** (`customer-core.ts:206-210` excludes it today) | signed in, nothing connected |
| First AI turn | first `AiInvocation` surface `chat` | connected, never asked |
| First Brief viewed | first `BRIEF_VIEWED` (**new event**) | never read a Brief |
| Returned | engaged after first-visit day (**needs `SESSION_ACTIVE_DAY`** for presence-only returns) | did not return |

Each stage shows count and three-state rate (number / no denominator / not measured), reusing `growth-funnel-view.ts`. The personal Space is created at registration, so "first Space" is not a step; "second Space" is a feature-adoption signal.

## 7. AI / Plaid cost attribution (PROPOSED; ties to the cost assessment C6–C8, A8)

- Per user (Customer Success): AI = `AiInvocation` surfaces `chat`+`brief` for that userId, priced per (model, day) by `priceAiUsage`; Plaid = that user's Item-months × configured rates (the Item facts gain a `userId` for the CS area only). Both labelled ESTIMATED.
- Fleet (Growth & Revenue / Platform Ops): AI = ledger grouped by surface (harness excluded); Plaid = fleet Item-months. **Cost per active user** = (AI customer-surface 30 d + Plaid current cycle) ÷ engaged MAU; null when either side is unpriced.
- Operational overhead shown separately: harness/eval AI (surface `harness`), Preview/sandbox Items (after C1).

## 8. Platform Ops dashboard presentation (PROPOSED; reuses the UX P1 grammar)

| Area | Surface | Content |
|---|---|---|
| Growth & Revenue (new section key `growth_product_analytics`) | one `SectionSurface` "Product analytics" | registrations (total, 7 d, 30 d); present vs engaged D/W/M as paired `StatusTile`s; weekly cohorts × D1/D7 as a compact table; onboarding funnel (reuse `FunnelStages`); feature adoption table (feature · adopters · adoption % · frequency); cost per engaged user (ESTIMATED) with a doorway to Economics; no usernames, no Space names |
| Customer Success | existing customer list + detail | per-user usage/cost roll-up (AI turns, tokens, est. USD; Items; est. Plaid), first/last activity, funnel stage; drill from the Growth counts by username |
| Platform Ops | Attention Required (UX P1) | "failed operations affecting users" rows: refresh FAILED/PARTIAL, AI FAILED/TIMEOUT/QUOTA, Brief failures, NEEDS_REAUTH — opaque `user …last6`, doorway to Customer Success |

Section-key addition requires the registry edit plus `npm run platform:seed-spaces` on Dev, Preview and Production (create-only seed; invisible surface if forgotten).

## 9. Data retention and privacy safeguards (PROPOSED)

- Metadata whitelist per event enforced by the typed helper and by a source-scan test (§10); no email, name, address, description, amount, balance, prompt, token or key may appear.
- Product events are excluded from `USER_SECURITY_HISTORY_ACTIONS`, the member Space feed `ALLOWED_ACTIONS`, `OPERATOR_ACTION_FEED_ACTIONS`, `PLATFORM_OPS_FEED_ACTIONS` and the admin dropdown groups (each list is explicit; a new `PRODUCT_EVENT_ACTIONS` set is pinned disjoint from all of them).
- Identity: fleet readers under Growth & Revenue / Platform Ops select ids and counts only and pass the observability privacy scan; usernames appear only in Customer Success.
- Tenant isolation: readers run on `systemDb` under `requirePlatformAccess(area, "READ")`; tenant principals can read only their own rows (existing `fm_app_sel`).
- Retention (owner decision A6): product events deleted after 13 rolling months by a daily job (`AuditLog` rows whose action ∈ `PRODUCT_EVENT_ACTIONS`); security actions untouched; on account deletion `userId` is already set null, and the derived readers treat null-user rows as non-attributable.
- Existing violations (A7) fixed before beta: email hashed or omitted in `REGISTER`/`EMAIL_VERIFIED`/`BETA_ACCESS_REQUESTED`; name/balance/purchase price dropped from `MANUAL_ASSET_ADD`; address dropped from `WALLET_ADD`.
- No client SDK, no third party, no cookies beyond the session.

## 10. Tests for event integrity and tenant isolation (PROPOSED)

1. **Vocabulary pin:** `PRODUCT_EVENT_ACTIONS` membership exact; each member is an `AuditAction`; writers use the enum, never strings (extends `lib/security-surface.test.ts:107-122`).
2. **Feed disjointness:** no product event in Security History, the member Space feed, the operator feeds or the admin groups.
3. **Metadata scan:** every call site of the product-event helper and every `MANUAL_ASSET_ADD`/`WALLET_ADD` writer carries only allow-listed keys; a regex scan for `email|name|balance|amount|address|description|prompt` in those metadata literals fails the build.
4. **Idempotence:** writing the same (user, action, day) twice yields one row (unit test over the pure dedupe predicate and an RLS-acceptance check with the fm_auth principal).
5. **Tenant isolation (RLS acceptance, pattern `scripts/rls-app-acceptance.ts:1879,2020`):** Alice's product events readable by Alice, not by Bob; fm_auth cannot read them back; platform readers on `systemDb` see both.
6. **Engagement exclusions:** fixture test proving cron/webhook executions, harness invocations and operator actions never count toward present/engaged/adoption.
7. **Retention definitions:** fixture test over three users (D1 yes/no, D7 window vs strict, "not yet measurable" for young cohorts).
8. **Privacy scan:** new readers and routes added to `lib/platform/observability-privacy.test.ts` lists.
9. **Seed/composition:** the new section key registered in `policy.ts`, the widget map and `workspaces.ts` (extends `refresh-widgets.test.ts` pattern).

## 11. Owner decisions, dependencies, migrations, complexity

| # | Decision | Default | Migration | Complexity |
|---|---|---|---|---|
| A1 | Store: `AuditLog` actions now; `ProductEvent` table post-beta | AuditLog | none now (`AuditLog.action` is a free string; enum is TypeScript) | low |
| A2 | Event set (§1) | the seven listed | none | medium (7 writers, 1 helper, tests) |
| A3 | Present vs engaged shown together; LOGIN relabelled "sign-ins" | yes | none | low |
| A4 | D7 window as primary, strict beside it | yes | none | low |
| A5 | Dashboard homes (§8); new Growth section key | yes | **seed on every environment** (not a schema migration) | medium |
| A6 | 13-month retention job for product events | yes | none (job registry entry) | low |
| A7 | PII cleanup of existing audit metadata | yes, before beta registrations | none; later backfill-scrub optional | low |
| A8 | Cost-per-active-user denominator = engaged MAU | yes | none | low (depends on C6) |

Dependencies: A2 before A3/A4/A5 readers; C6 before A8; `SESSION_ACTIVE_DAY` writer touches the session callback (fm_auth path; review with the RLS pins `rls-foreground-acceptance.ts:852-912`); the Growth section needs the seed on Dev, Preview and Production. Estimated total: 25–35 agent-hours (writers 8–10, readers 8–10, section + CS table 6–8, tests 5–7); one agent plus coordinator, or two agents (writers+tests, readers+UI) over two days.

*Assessment only. No event, reader, section or job was implemented.*
