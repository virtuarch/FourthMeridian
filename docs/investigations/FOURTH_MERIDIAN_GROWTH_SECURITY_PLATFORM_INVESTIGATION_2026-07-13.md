# Fourth Meridian — Growth & Security Platform Investigation + Implementation Plan

**Date:** 2026-07-13
**Type:** Investigation + implementation plan only — no code changes in this pass.
**Scope:** Landing page · registration toggle · beta-access request/approval/invite system · CAPTCHA · account lockout · Security Ops anomaly visibility · 2FA nudge · Platform Ops API cost/usage visibility.
**Purpose:** Divide this scope into precise, evidence-grounded slices that can be split across multiple parallel Claude Code sessions.

Every claim below was verified against the working tree on 2026-07-13, with file/line citations.

---

## 1. Executive summary

Seven of the eight requirements are buildable almost entirely on patterns that already exist and are already tested. The single-use hashed token pattern (`lib/password-reset-token.ts` + the `User.passwordResetToken/@unique` columns) is the invite-token precedent, verbatim. `PlatformSetting` is exactly the right home for the registration toggle. The email chokepoint (`sendEmail`, `lib/email/send.ts:49`) already accepts an **arbitrary recipient address** — so emailing `security@fourthmeridian.com` needs no notification-platform surgery, and a `beta-invite` sender identity (`beta@fourthmeridian.com`) is **already declared** in `lib/email/senders.ts:47`, waiting for a caller. The Growth & Revenue platform Space, its authorization seam, and its widget-hosting pattern all shipped in PO1.0–1.3 and extend by adding one registry entry each. There is **no existing CAPTCHA integration anywhere** (verified by grep across `lib/`, `app/`, `components/`, `package.json` — zero matches for captcha/turnstile/recaptcha/hcaptcha) — that piece is greenfield.

Two findings materially shape the plan:

1. **A separate hard-lockout mechanism is close to redundant — decided.** The login path already enforces a per-identifier fixed-window limit of 10 attempts / 15 min *before any user lookup* (`lib/auth.ts:76-77`), plus a per-IP limit of 20 / 15 min on the credentials callback (`app/api/auth/[...nextauth]/route.ts:32-35`) and 10 / min on pre-login (`app/api/auth/pre-login/route.ts:33`). This IS a self-resetting soft lockout. **Chris has chosen Option A** (§7.1): no durable lockout state — CAPTCHA-after-N-failures on top of these limits, plus a new owner-facing email at the same trip point (§6.5/§6.6) so the user actually learns something happened without any lockable state existing to weaponize against them.

2. **The platform-Space seed cannot add sections to existing Spaces.** `ensurePlatformSpaces` upserts with `update: {}` — deliberately, so a re-run never mutates a live platform Space (`lib/platform/seed.ts:37`). Three slices in this plan add new sections to already-materialized Spaces (Growth & Revenue, Security Ops, Platform Ops), so a small idempotent `ensurePlatformSections` extension (per-section upsert keyed on the existing `@@unique([spaceId, key])`, `prisma/schema.prisma:1260`) is a shared prerequisite — it is Slice 0 below.

On cost visibility (§6.8): true dollar reconciliation is **not** programmatically available. Plaid has no billing/usage API an app can poll; OpenAI usage reporting is dashboard/org-admin surface, not something to build a product feature on, and per-unit prices are contract-specific anyway. The honest, feasible build is local call-volume and token counting at the two chokepoints the codebase already enforces (`lib/plaid/client.ts` — the only PlaidApi construction; `lib/ai/provider.ts:6` — "THE ONLY FILE THAT MAY IMPORT THE OPENAI SDK"), surfaced as a Platform Ops widget, with optional admin-entered per-unit price constants if Chris wants approximate dollars.

---

## 2. Confirmed current state (citations, not assumptions)

### 2.1 `PlatformSetting` — settings/toggles pattern

- Model: `prisma/schema.prisma:2368-2373` — string key/value, `updatedById` provenance. Comment: "Managed exclusively by SYSTEM_ADMIN via /admin/security."
- Helpers: `lib/platform-settings.ts` — typed key constants (`PlatformSettingKey`, lines 10-16: `require_totp_system_admin`, `require_totp_admins`, `require_totp_all_users`, `recovery_codes_enabled`, `min_password_length`), `DEFAULTS` map (lines 21-27), `getSetting`/`setSetting` (lines 38-41, 60-70).
- Admin write surface: `app/api/admin/security/settings/route.ts` — `GET` behind `requireSystemAdmin` (line 16), `PATCH` behind `requireFreshSystemAdmin` (line 27), `ALLOWED_KEYS` allowlist from the key constants (line 13), per-key guard example (`require_totp_system_admin` cannot be disabled, lines 40-45), audit write `PLATFORM_SETTINGS_UPDATED` (lines 50-56).
- Consumers already read settings at runtime in the registration path (`getMinPasswordLength()` at `app/api/auth/register/route.ts:74`) and login path (`lib/auth.ts:214-217`).

**Verdict:** `PlatformSetting` is the right fit for the registration toggle — see §6.2.

### 2.2 Password-reset-token pattern — the single-use hashed token precedent

- Hashing: `lib/password-reset-token.ts:22-24` — SHA-256 hex over a server-generated `crypto.randomBytes(32)` token; the module header (lines 7-17) documents *why* a fast deterministic hash is correct for high-entropy server tokens (exact-match `@unique` lookup) versus bcrypt.
- Storage: token columns on the owning row, not a token table — `User.passwordResetToken String? @unique` + `passwordResetExpiry` (`prisma/schema.prisma:343-344`). The email-verification (`:354-356`) and email-change (`:364-366`) seams repeat the identical column-pair pattern ("hashed at rest, single outstanding token, 1h TTL" — schema comment at line 347-350).
- Issue: `app/api/auth/forgot-password/route.ts:65-71` — raw token generated, only the hash persisted, 1h TTL.
- Consume: `app/api/auth/reset-password/route.ts:40-46` (hashed exact-match lookup with `passwordResetExpiry: { gt: new Date() }`) and lines 57-64 (nulled on use — "invalidate — single use").
- Note: `lib/email/invite-url.ts` exists but is the **Space**-invitation URL builder and is explicitly token-less (lines 8-11) — it is *not* a precedent for beta invite tokens; the reset/verify token pattern is.

**Verdict:** the invite token reuses this exact pattern — hashed at rest, `@unique`, expiry column, nulled on redemption — as columns on the beta-request row (§5.1).

### 2.3 `AuditLog` — event history

- Model: `prisma/schema.prisma:2297-2313` — nullable `userId`, string `action`, Json `metadata`, `ipAddress`/`userAgent`, indexes on `[userId, createdAt]`, `[spaceId, createdAt]`, and crucially `[action, createdAt]` (line 2312) — which makes time-windowed scans of `LOGIN_FAILED` cheap for anomaly aggregation.
- `LOGIN_FAILED` rows are written with a `metadata.reason` discriminator at every failure branch of `authorize()`: `user_not_found` (`lib/auth.ts:97-103`), `system_admin_disabled` (:108-115), `invalid_password` (:121-128), `email_unverified` (:141-150), `pending_deletion` (:174-184), `account_deactivated` (:191-200), `totp_required` (:234-243), `totp_invalid` (:254-263), `recovery_code_invalid` (:269-277). IP comes from `cf-connecting-ip` first (not client-spoofable behind Cloudflare, :60-63).
- Action vocabulary lives in `lib/audit-actions.ts` (`AuditAction` const, line 9 onward).

**Verdict:** anomaly detection needs **no new event store** — it is aggregation over `AuditLog` plus threshold checks at the producer (§6.6).

### 2.4 Notification platform (`lib/notifications/`) — and the security@ question answered

- `createNotification` (`lib/notifications/create.ts:265`) is the single chokepoint; registry-validated types (`lib/notifications/registry.ts:116` onward), dedupe via `@@unique([userId, dedupeKey])`, non-throwing results.
- **Recipient targeting: a `User` row only.** The input carries `userId`; the EMAIL leg resolves the address by `client.user.findUnique({ where: { id: args.userId }, select: { email: true } })` (`create.ts:219-222`). There is no path to hand it an arbitrary mailbox.
- **But the email chokepoint underneath takes any address:** `sendEmail(name, to, data)` (`lib/email/send.ts:49-53`) — `to` is a plain string. The OPS-2 flows already call it directly with a user's address and the generic `security-alert` template (`lib/email/templates/security-alert.ts`, deliberately generic `{ title, message }` per its header comment, lines 7-10; sender `support@fourthmeridian.com` per `lib/email/senders.ts:42`).
- Registry doctrine matters here: the `SECURITY` category partial is IN_APP-only **by design** — "the EMAIL guarantee for security events lives in the OPS-2 security-alert flow (support@, unconditional, outside this system). Routing them through the notification EMAIL channel too would double-email every event" (`lib/notifications/registry.ts:64-70`).

**Verdict (answering the prompt's §6 question precisely):** the notification system targets only `User` rows, and the *right* extension is **not** to teach it arbitrary mailboxes. For `security@fourthmeridian.com`, call `sendEmail("security-alert", "security@fourthmeridian.com", …)` directly at the anomaly producer — one line, consistent with the registry's own doctrine that security email lives outside the notification EMAIL channel. For in-app real-time notifications, the producer loops over the small set of users who should see them (ACTIVE `SECURITY_OPS` grant holders + SYSTEM_ADMINs — one indexed query on `PlatformGrant`). No schema or platform extension required. Add the mailbox as an env-driven constant (`SECURITY_ALERTS_EMAIL`, default `security@fourthmeridian.com`) so dev/test capture stays clean. (If Chris prefers a first-class "system mailbox channel" abstraction it would be a new `channels/` adapter + registry channel value — real work, ~2 files + types — but it buys nothing today; stated for completeness, recommended against.)

### 2.5 Activity feed producer pattern (`lib/activity/`)

- `lib/activity/` contains normalizers only (`normalize-import-batch.ts`, `normalize-sync-issue.ts`) feeding the customer Space activity feed. Nothing in this initiative's scope is Space-member-facing activity, so this pattern is **not** used by any slice below (stated per the efficiency constraint — checked, not assumed).

### 2.6 Platform widget hosting + authorization (PO1.0–1.4)

- Authorization: `requirePlatformAccess(area, needed)` / `requireFreshPlatformAccess` (`lib/platform/authorize.ts:116-138`) — 401/403, never 404; SYSTEM_ADMIN break-glass bypass (:92-94). Fresh variant exists precisely for WRITE mutations (:126-130 comment) — the beta approve/deny actions must use it.
- Widget hosting: `PLATFORM_WIDGET_REGISTRY` (`components/platform/PlatformSpaceDashboard.tsx:43-56`) — "add one entry, no switch/case"; unknown keys fall back to `PlaceholderCard`. Widget shape precedent: `components/platform/widgets/GrowthSignupsWidget.tsx` (uses `PlatformWidgetCard`/`WidgetStat`/`useWidgetFetch` from `../widget-kit`, fetches its own PO1.x route).
- Data routes: one folder per area under `app/api/platform/` (`growth-revenue/signups`, `security-ops/{audit,auth-posture,sessions}`, `platform-ops/{env-status,job-health,rate-limits}`), each opening with the `requirePlatformAccess` tuple check (e.g. `app/api/platform/growth-revenue/signups/route.ts:33-34`).
- Section definitions: `PLATFORM_AREAS` metadata (`lib/platform/policy.ts:57` onward) — GROWTH_REVENUE currently has one section (`growth_signups`), SECURITY_OPS three, PLATFORM_OPS three.
- **Seed gap (finding):** `ensurePlatformSpaces` (`lib/platform/seed.ts`) creates sections only inside the Space-create branch; `update: {}` (line 37) never touches an existing Space. Adding `growth_beta_requests`, `sec_anomalies`, or `ops_api_usage` to `PLATFORM_AREAS` will do nothing for the four already-seeded Spaces. `SpaceDashboardSection` has `@@unique([spaceId, key])` (`prisma/schema.prisma:1260`), so an idempotent per-section upsert is trivial to add. This is Slice 0.

### 2.7 Registration & login surface

- Registration: `POST /api/auth/register` (`app/api/auth/register/route.ts`) — fully open today; per-IP limit 5 / 15 min (:46); reads `getMinPasswordLength()` from PlatformSetting (:74); creates user + Personal Space + AiAgent atomically (:109-204); sends verification email post-commit (:211-215). **This route is the file three slices touch — the sequencing pivot (§8).**
- Login: NextAuth credentials `authorize()` in `lib/auth.ts:53-392` (limits and failure audits as in §2.3); per-IP wrapper on the credentials callback only (`app/api/auth/[...nextauth]/route.ts:27-36`); advisory two-step `pre-login` route with timing-safe dummy-hash compare and post-password-only state disclosure (`app/api/auth/pre-login/route.ts:27-29, 51-66`).
- Public surface: the proxy gate matches **only** `/dashboard/:path*` and `/admin/:path*` (`proxy.ts:78-83`) — public routes are outside the auth gate by construction. `/` is a one-line redirect to `/dashboard/brief` (`app/page.tsx:11`). Security headers apply to all routes including future public ones (`next.config.ts:59-63`, `source: "/(.*)"`).
- 2FA state surface: `GET /api/user/totp/status` already returns `{ totpEnabled, totpConfigured, recoveryCodesRemaining }` behind `requireUser` (`app/api/user/totp/status/route.ts`). The session JWT carries `requireTotpSetup` (forced-enrollment flag) but **not** `totpEnabled` — the nudge banner should read the status route, not the session (§6.7).

### 2.8 Email substrate (OPS-1)

- `sendEmail(name, to, data)` non-throwing chokepoint; test→capture, `RESEND_API_KEY`→Resend, else capture (`lib/email/send.ts:33-39`).
- Template registry: typed union `EmailTemplateName` (`lib/email/types.ts:75-83`) — currently `smoke | password-reset | email-verification | space-invite | security-alert | email-change | notification`. Adding `beta-invite` = one template file + one `EMAIL_TEMPLATES` entry (`lib/email/templates/index.ts:25`) + one union member.
- Sender identity **already exists**: `"beta-invite": { from: "Fourth Meridian Beta <beta@fourthmeridian.com>" }` (`lib/email/senders.ts:47`) and the `SenderPurpose` union already includes it (`lib/email/types.ts:108`). SPF/DKIM/DMARC noted as already authenticated on the domain (senders.ts:8-10).
- **Approve-and-email-in-one-step: confirmed clean.** The approve route mints the token, then calls `sendEmail("beta-invite", …)` exactly the way `forgot-password` does (`app/api/auth/forgot-password/route.ts:74-82`) — non-throwing, status recorded in the audit metadata. No notification-platform involvement needed (the recipient has no User row yet, which is also why `createNotification` *cannot* be used here — same reasoning as the registry's named bypass for `ACCOUNT_DELETED`, `lib/notifications/registry.ts:120-121`).

### 2.9 Rate limiting (KD-3 / OPS-1 S4)

- `lib/rate-limit.ts` — fixed-window; DB-backed in production via `RateLimit` table (`prisma/schema.prisma:2384-2399`, `@@unique([key, windowStart])`), in-memory in dev/test; production default-ON (:71-76). Helpers `limitByIp` / `limitByUser` / `limitByKey`.
- Login-relevant limits already in force: identifier 10/15min (`lib/auth.ts:76`), credentials-callback IP 20/15min, pre-login IP 10/min, register IP 5/15min, forgot-password IP 5/15min, reset-password IP 10/15min.
- There is no "peek without increment" helper — CAPTCHA-after-N-failures needs one (§6.4). The store shape supports it directly (read the current bucket count).

### 2.10 CAPTCHA — greenfield confirmed

`grep -ri "captcha|turnstile|recaptcha|hcaptcha"` across `lib/`, `app/`, `components/`, `package.json`: **zero matches**. No partial integration exists.

### 2.11 API usage/cost — current state

- OpenAI: single import site `lib/ai/provider.ts` (header: "THE ONLY FILE IN THIS CODEBASE THAT MAY IMPORT THE OPENAI SDK", line 6); one call shape (`generateChatReply`, :66-87); model `gpt-4o-mini` (:45). The SDK response's `completion.usage` (prompt/completion tokens) is available at line 72's call result but **currently discarded**.
- Plaid: single client construction `lib/plaid/client.ts` (`plaidClient`, :48). Call sites across the repo (grep, excluding tests): `itemRemove`×6, `linkTokenCreate`×2, `investmentsHoldingsGet`×2, `accountsGet`×2, `webhookVerificationKeyGet`×1, `transactionsSync`×1, `itemPublicTokenExchange`×1, `investmentsTransactionsGet`×1 — ~16 call sites, 8 distinct methods.
- No usage counter, no cost table, nothing in `JobRun` (job bookkeeping only, `prisma/schema.prisma:2595-2611`) covers per-provider API volume.
- **Billing APIs (do-not-assume check, per the prompt):** Plaid exposes no programmatic billing/usage endpoint an app can poll (usage lives in the Plaid Dashboard; pricing is per-contract). OpenAI's usage reporting is org-admin dashboard surface, not a stable per-app product API, and dollar mapping again depends on the negotiated plan. **Plan accordingly: count locally; dollars only via manually-configured per-unit constants if desired** (§6.8).

### 2.12 Prior art that constrains this plan

- `PUBLIC_SITE_ARCHITECTURE_INVESTIGATION_2026-07-08.md` — the approved landing-site direction: in-repo `app/(public)/*`, server-only `components/marketing/*`, `content/marketing/*`, `lib/marketing/*`, grep-enforced import boundary; the *only* app seam is one `fetch` to a public `POST /api/access-request`. §3/§4 of that doc list the folder structure and Tier-1 pages (home, security, about, request-access, terms, privacy, legal/ai).
- `PRELAUNCH_AUDIT_2026-07-06.md` Parts 6-7 — beta mechanics: request → approve → invite; single-use expiring email-bound token; "the invite email IS the verification"; the register endpoint keeps "one boolean seam: is an approved invite required?"; management belongs on existing admin patterns. (The Part 7 "new tab in the admin panel" placement is superseded by Chris's confirmed call: management lives in the **Growth & Revenue platform Space** — which is a *better* fit now than when the audit was written, since PO1.3 shipped the widget + authz hosting it needs.)

---

## 3. Landing-page / shared-DB split architecture

**Constraint restated:** the landing page ships inside this repo now, but Chris intends to eventually split it into its own repo/deploy while continuing to share the same database for beta-access data.

**Recommendation: the landing page never touches the database — it talks to one tiny public HTTP API hosted by this app, and that API is the permanent seam.**

Concretely:

- The landing page's only dynamic behavior is the "Request beta access" form. It submits `{ email }` (plus optional context fields, §5.1) to `POST /api/access-request` — a public, rate-limited, CAPTCHA-protected endpoint hosted by **this** app. This is exactly the seam the 07-08 investigation already identified ("one fetch … which is the entire beta-gate seam").
- When the split happens, the landing repo carries static pages + that one `fetch` URL as config. It imports **no** Prisma client, no schema, no business logic, no auth. "Sharing the same database" is achieved by sharing the *API*, which is the clean way to share a database — one writer, one schema owner, no cross-repo migration coordination, no second Prisma client drifting out of sync, no DB credentials in the marketing deploy (a real security win: a compromised marketing site can spam a rate-limited endpoint, not read `User` rows).
- The alternative — the landing repo connecting to Postgres directly with its own minimal Prisma schema for one table — is strictly worse on every axis Chris cares about: two schema definitions for one table (drift risk on every migration), DB credentials in a public-site deploy, connection-pool pressure from a second app, and no reuse of the rate-limit/CAPTCHA/audit stack that already lives here. The only scenario where direct-DB wins is if the app itself were down and requests still needed to land — a non-goal for a beta queue (and solvable later with a queue if it ever matters).
- **Tradeoffs stated plainly:** the API approach couples landing-form availability to app availability (acceptable: same infra today, and a beta form 502ing during an app outage is a footnote); it requires CORS allowances for the future marketing origin (one header, add when the split happens); and it means the endpoint must stay genuinely public and unauthenticated forever (it already must be — that's its job).

In-repo boundary discipline (from the 07-08 investigation, unchanged): `app/(public)/*` on its own layout; server-only marketing primitives consuming the CSS variables from `app/globals.css` (never the `"use client"` component library); copy in `content/marketing/*` with legal pages as Markdown rendered by the already-installed `react-markdown` (`package.json:45`); a source-scan boundary test in the house grep-enforced idiom. Replacing `app/page.tsx`'s redirect with the public Home is the one shared-file touch (§8).

---

## 4. Efficiency audit — what is reused vs. what is new (justification per the constraint)

| Need | Existing pattern | Fit? | New schema/mechanism? |
|---|---|---|---|
| Registration on/off | `PlatformSetting` + `lib/platform-settings.ts` + admin PATCH route | **Yes — exact fit** (§6.2) | New *keys* only; zero schema |
| Invite tokens | Password-reset token pattern (SHA-256 hashed, `@unique`, expiry, null-on-use) | **Yes — verbatim reuse** of the pattern | Columns live on the new request row (below), not on `User` and not a separate token table |
| Beta request queue | Nothing stores non-user emails today (`User` requires password/space ceremony; `SpaceInvite` targets existing `invitedUserId`, `prisma/schema.prisma:600`) | **No existing fit** | **One new table `BetaAccessRequest`** — justified §5.1 |
| Approve/deny UI | `PLATFORM_WIDGET_REGISTRY` + `requirePlatformAccess("GROWTH_REVENUE", …)` + widget-kit | **Yes** | One widget, one route folder, one registry entry, one section |
| Invite email | `sendEmail` + declared-but-unwired `beta-invite` sender | **Yes** | One new template (registry entry + union member) |
| Anomaly event history | `AuditLog` (`@@index([action, createdAt])`) | **Yes** | Zero schema |
| Anomaly in-app notify | OPS-3 `createNotification` + registry | **Yes** | New registry *entries* only (code, not schema) |
| Anomaly email to fixed mailbox | `sendEmail("security-alert", to, …)` direct call | **Yes** (§2.4 verdict) | Zero — env constant for the address |
| 2FA nudge | `/api/user/totp/status` + a client banner | **Yes** | Zero schema (dismissal in `localStorage`; a `User` column would be speculative — rejected) |
| CAPTCHA | None (greenfield) | — | Env vars + one client component + one server verify helper; zero schema |
| Lockout counters | Rate-limit store already counts per-identifier failures; owner email reuses §6.6's `sendEmail` fan-out | **Yes — decided, Option A + owner email** (§7.1) | Zero schema |
| API usage counting | Nothing fits: `AuditLog` is user-event history (usage is system-level, high-frequency, aggregate-read); `RateLimit` buckets are short-window and swept; `JobRun` is per-job bookkeeping | **No existing fit** | **One new table `ApiUsageCounter`** — justified §5.2 |

Nothing in the requirement list turned out redundant enough to drop outright; the one near-redundancy (hard lockout vs. existing limits + CAPTCHA) is flagged as an open decision rather than silently built (§7.1).

---

## 5. Schema proposal (complete — nothing else changes)

### 5.1 `BetaAccessRequest` (new table)

```prisma
enum BetaAccessRequestStatus {
  PENDING
  APPROVED   // invite minted + emailed
  DENIED
  REDEEMED   // invite consumed by a successful registration
}

model BetaAccessRequest {
  id              String                  @id @default(cuid())
  email           String                  @unique   // one live request per address
  // Optional context from the public form (kept to what the form actually asks)
  note            String?                            // applicant's "why" answer, if the form asks one
  status          BetaAccessRequestStatus @default(PENDING)
  createdAt       DateTime                @default(now())
  decidedAt       DateTime?
  decidedById     String?                            // soft ref (no FK), mirrors MerchantRule.ownerUserId / MerchantMergeDecision.decidedByUserId
  // Invite token — the password-reset pattern verbatim (hashed at rest, single
  // outstanding token, expiring, nulled on redemption). Lives HERE because the
  // recipient has no User row yet.
  inviteTokenHash String?                 @unique
  inviteExpiresAt DateTime?
  invitedAt       DateTime?                          // when the invite email was (last) sent — resend updates this
  redeemedAt      DateTime?
  redeemedUserId  String?                            // soft ref to the User created from this invite

  @@index([status, createdAt])   // the queue view
}
```

**Justifications (per the efficiency constraint):**
- *Why a new table at all:* pre-registration emails have no home. `User` can't hold them (registration ceremony creates Space/agent/audit atomically, §2.7); `SpaceInvite` requires an existing `invitedUserId` FK (`prisma/schema.prisma:600-601`).
- *Why the token is columns here, not a second `InviteToken` table:* the prelaunch audit sketched two tables, but every shipped token in this codebase is a column pair on its owning row (reset :343-344, verify :354-356, email-change :364-366). One outstanding invite per request is the product rule (resend = rotate token in place, updating `invitedAt`); a token table would add a join and a second lifecycle for zero capability.
- *Columns NOT included (speculative, rejected):* cohort tags (prelaunch audit item — add when waves actually start; it's one nullable string later), form answers beyond one `note`, IP/user-agent capture (the public endpoint writes an `AuditLog` row with those instead, keeping PII on the request row minimal), `remindedAt`, counters.
- *Redemption invariant:* enforced in the register route inside the existing `$transaction` (§6.3), setting `status: REDEEMED`, `redeemedAt`, `redeemedUserId`, and nulling `inviteTokenHash` — single-use exactly like `reset-password/route.ts:57-64`.

### 5.2 `ApiUsageCounter` (new table)

```prisma
model ApiUsageCounter {
  id       String   @id @default(cuid())
  provider String   // "PLAID" | "OPENAI"  (string, not enum — house style for extensible vocabularies, cf. JobRun.status)
  metric   String   // Plaid: method name ("transactionsSync"); OpenAI: "chat.completions:<model>"
  unit     String   // "calls" | "prompt_tokens" | "completion_tokens"
  day      DateTime // UTC date bucket (00:00:00)
  count    BigInt   @default(0)

  @@unique([provider, metric, unit, day])
  @@index([provider, day])
}
```

**Justifications:**
- *Why not `AuditLog`:* usage events are system-level and high-frequency; `AuditLog` is user-scoped security/action history with Json metadata — aggregating token counts out of Json rows is the wrong read shape and pollutes the security feed.
- *Why not `RateLimit`:* buckets are short-window, keyed for enforcement, and expected to be swept (`jobs/sweep-rate-limits.ts`); usage needs durable daily aggregates.
- *Why aggregate counters, not row-per-call:* the widget reads daily/monthly sums; row-per-call is volume with no consumer. The atomic upsert-increment idiom is already proven in `lib/rate-limit.ts:98-109`.
- *Price constants are NOT schema:* if approximate dollars are wanted, per-unit prices are a code/env constant map (`lib/usage/pricing.ts`), because they're contract-specific and change — putting them in `PlatformSetting` is possible later if Chris wants runtime editing, but starting there is speculative.

### 5.3 `PlatformSetting` — new keys (no schema change)

- `registration_mode`: `"open" | "invite_only" | "closed"` (default `"open"` in `DEFAULTS` to match current behavior until Chris flips it; see §6.2 for why one three-valued key beats two booleans).
- Lockout (§7.1, decided Option A + owner email): no new `PlatformSetting` keys needed — the CAPTCHA threshold is a code constant (§6.4), not policy, and the owner-email fan-out has no tunable beyond that same threshold.

### 5.4 Hard-lockout columns — not shipping

`User.failedLoginCount`/`User.lockedUntil` (Option B) are **not** being built (§7.1 decided Option A). Left here only as a pointer for the future if real abuse ever forces a revisit: no unlock-token columns would be needed even then, since self-service unlock is already the existing forgot-password flow (§6.5).

---

## 6. Per-requirement findings & design

### 6.1 Landing page

As §3. New files only: `app/(public)/{layout,page}.tsx`, `security|about|request-access|terms|privacy|legal/ai` pages, `components/marketing/*` (server-only), `content/marketing/*`, `lib/marketing/*`, plus the boundary source-scan test. Shared-file touches: replace `app/page.tsx` (delete the redirect — route groups don't affect URLs, so `(public)/page.tsx` serves `/`), slim the stale OG metadata in `app/layout.tsx` (documented stale in the 07-08 investigation §2). Login button links to the existing `/login`. The request-access form posts to the Slice-3 endpoint; until that ships, the page renders the static shell (the 07-08 plan's own sequencing).

### 6.2 Registration toggle

`PlatformSetting` **is** the right fit: admin-controlled platform-wide policy read at request time by an auth route — exactly the shape of `min_password_length`, already read inside this very route (`register/route.ts:74`). A new mechanism would duplicate `getSetting`/`setSetting`, the admin PATCH surface, and the audit trail for zero gain.

One key, three values (`registration_mode`), rather than two booleans (`registration_open` + `invite_required`): two booleans create a contradictory fourth state (closed-but-invite-required) that every reader must interpret; the prelaunch audit's own evolution path ("Request-access (manual) → … → open registration") is a one-dimensional dial. Register route behavior: `closed` → 403 with a clear message before any validation; `invite_only` → require a valid invite token (§6.3); `open` → current behavior. Admin UI: one select in the existing `/admin/security` settings page + `ALLOWED_KEYS` addition — plus (optional, later) a read-only echo of the mode in a Growth widget.

### 6.3 Beta-access request → approval → invite

- **Public intake:** `POST /api/access-request` — no auth; `limitByIp` (5/15min, mirroring register); CAPTCHA verification (§6.4); upsert-by-email into `BetaAccessRequest` (re-submission of the same email is a silent 200 — non-enumerating: the response never discloses whether the email was already requested/approved/denied); `AuditLog` row (`BETA_ACCESS_REQUESTED`, no `userId`) carrying ip/user-agent.
- **Queue widget:** `growth_beta_requests` section in `PLATFORM_AREAS.GROWTH_REVENUE.sections` + `GrowthBetaRequestsWidget` in `PLATFORM_WIDGET_REGISTRY` + routes under `app/api/platform/growth-revenue/requests/` — `GET` (list, `requirePlatformAccess("GROWTH_REVENUE","READ")`), `POST …/[id]/approve` and `…/[id]/deny` (both `requireFreshPlatformAccess("GROWTH_REVENUE","WRITE")` — the fresh variant exists for exactly this, `lib/platform/authorize.ts:126-130`).
- **Approve = mint + email in one step (confirmed feasible, §2.8):** generate `crypto.randomBytes(32)`, store SHA-256 hash + 14-day expiry (prelaunch audit's suggested TTL; open decision §7.3), set `APPROVED`, `sendEmail("beta-invite", email, { inviteUrl })` with the URL built from `env.NEXT_PUBLIC_APP_URL` (the trusted-base rule every URL builder follows, e.g. `lib/email/reset-url.ts` usage at `forgot-password/route.ts:74`), audit with `emailStatus` like `forgot-password/route.ts:84-90`. Resend = same route rotates the token. Deny = status flip + audit; **no email** by default (silent denial is the norm for beta queues; open decision §7.4).
- **Redemption gate in the register route:** when `registration_mode === "invite_only"`, require `inviteToken` in the body; look up `BetaAccessRequest` by `inviteTokenHash: hashResetToken(token)` (the helper is generic SHA-256 — reuse it; optionally re-export under a neutral name from the same module) with `inviteExpiresAt > now` and `status: APPROVED`; **bind the registration email to the request email** (the audit's "the invite email IS the verification" principle — and since the invite proves inbox ownership, mark the new user `emailVerifiedAt` immediately and skip the verification-email leg for invited signups); consume inside the existing `$transaction`.
- **Email-bound vs shareable:** email-bound, per the prelaunch audit ("shareable codes … just bypass your approval" — Part 6). Not re-opened.

### 6.4 CAPTCHA

- **Provider: Cloudflare Turnstile — confirmed as the recommendation.** Free, no visual challenge for most users, privacy-respecting, and the stack is already Cloudflare-fronted (`cf-connecting-ip` prioritized at `lib/auth.ts:57-63`), so operational familiarity exists. Integration is a script tag + widget div client-side and one `POST https://challenges.cloudflare.com/turnstile/v0/siteverify` server-side — no SDK dependency needed (aligns with the single-import-site house rules by simply having no import). Greenfield confirmed (§2.10).
- **Where:** (a) **registration** — always, when a CAPTCHA is configured; (b) **the public access-request endpoint** — always (it's the most spam-exposed surface the moment the landing page exists); (c) **login** — *after N failures*, see §7.2 for the decision framing. Server helper `lib/captcha.ts`: `verifyCaptchaToken(token, ip): Promise<boolean>` — env-gated (`TURNSTILE_SECRET_KEY` absent → verification skipped in dev/test, mirroring how `RESEND_API_KEY` gates real email, `lib/email/send.ts:36-38`), non-throwing, fail-open-with-log on Cloudflare outage (matching the rate-limiter's documented fail-open posture) — fail-closed here would let a Cloudflare API blip take down all registration.
- **Login-flow placement if adopted:** the failure count lives in the rate-limit store already keyed as `login-id:<identifier>` (`lib/auth.ts:76`); add a non-incrementing `peekKey(identifier, "login-id")` to `lib/rate-limit.ts`; `pre-login` returns `captchaRequired: true` past the threshold (e.g. 3), the login page renders the widget, and `authorize()` re-verifies the token server-side past the same threshold (client hints are advisory only). This touches `lib/auth.ts` — sequencing consequence in §8.

### 6.5 Account lockout — DECIDED: Option A + owner-facing email

Design constraints from Chris, honored: self-service recovery via emailed link, never admin-only; must not be a DoS vector.

- **Key finding:** the identifier-keyed limiter (10 fails / 15 min, checked before user lookup) already provides a self-resetting soft lockout, and it is *already* an attacker-lockable surface (anyone can burn a stranger's 10 attempts) — mitigated by the short window. Any *durable* lockout keyed on identifier alone makes that DoS strictly worse: an attacker with no credentials could keep a victim locked out indefinitely. That is precisely Chris's stated worry.
- **Shipped shape (Option A, decided):** no new durable lockout. CAPTCHA-after-N-failures (§6.4) + the existing windows. An attacker can't grind passwords (limits + CAPTCHA); a legitimate user who trips the window waits ≤15 min *or* self-serves instantly via **forgot-password** — which is the emailed unlock link, already built, already non-enumerating, already sending a `security-alert` on completion, and it revokes all sessions (`reset-password/route.ts:66-70`), which is the correct response if the failures weren't the owner's.
- **The hybrid — decided addition:** at the same threshold trip that gates CAPTCHA (§6.4's `peekKey(identifier, "login-id")` past N=3), fire a direct, non-blocking email to the account owner using the existing `sendEmail("security-alert", …)` chokepoint and generic `{title, message}` template — no new template needed. This is not a new mechanism: it's the identical trigger point and fan-out shape already being built for §6.6's anomaly detector, just addressed to the affected user's own inbox instead of (or in addition to) `SECURITY_ALERTS_EMAIL`. No enumeration risk (only the real owner's inbox ever receives it — an attacker probing identifiers sees nothing different), and it reuses the same suppress-while-open dedupe as the anomaly notifications so a sustained attack sends one email, not one per failed attempt. This gets Chris the visibility Option B would have provided (the user learns something happened) without Option B's cost or residual DoS surface (no durable state exists for an attacker to trigger against a stranger).
- **Option B (durable lockout) — considered, not chosen.** Recorded for completeness only: `failedLoginCount`/`lockedUntil` on `User` (reset on success), threshold from `PlatformSetting`, unlock still just a password-reset link. Revisit only if the anomaly-visibility counters (§6.6) ever show real abuse that A + CAPTCHA + the owner email doesn't stop — not before.

### 6.6 Security Ops anomaly visibility

- **Detector:** `lib/security/anomalies.ts` — pure threshold functions over `AuditLog` (`@@index([action, createdAt])` makes the scans cheap): failed-login bursts per identifier and per IP (`metadata.reason` distinguishes password vs TOTP failures), `recovery_code_invalid` streaks, `system_admin_disabled` hits, lock/CAPTCHA-trip events if built. Invoked **inline at the producer** (after the `LOGIN_FAILED` audit writes in `authorize()` — cheap count query only when a failure just happened), not a polling job — no `JobRun`/scheduler dependency, real-time by construction. (A sweep job can be added later for slow-burn patterns; not needed for v1 and stated as dropped.)
- **Fan-out on trip:** (1) `createNotification` to each ACTIVE `SECURITY_OPS` grant holder + SYSTEM_ADMINs — new registry entries (e.g. `SECURITY_ANOMALY_DETECTED`) under a new `SECURITY_OPS`-style platform grouping or the existing `PLATFORM` category (registry decision at build time; `dedupe: "suppress"` with a `{identifier-or-ip}:open`-style template prevents bell-spam during a burst — the mechanism is F3, `create.ts:36-43`); (2) `sendEmail("security-alert", SECURITY_ALERTS_EMAIL, { title, message })` directly for serious events — the §2.4 verdict: **no notification-platform extension is needed, and building one would violate the registry's own no-double-email doctrine.**; (3) **decided addition (§6.5 hybrid):** when the trip is a failed-login burst tied to a resolvable identifier/email, also `sendEmail("security-alert", <that user's own address>, { title, message })` directly — this is the lockout-hybrid mechanism, same call shape as (2), just a different recipient, sharing the same suppress-while-open dedupe so a burst produces one email to the owner, not one per attempt.
- **Widget:** `sec_anomalies` section (4th in SECURITY_OPS) + `SecAnomaliesWidget` + `GET /api/platform/security-ops/anomalies` (aggregates over the same windows the detector uses, plus recent trip history from `AuditLog` rows the detector writes, action `SECURITY_ANOMALY_DETECTED`).

### 6.7 2FA nudge

**Confirmed: zero dependency on anything else in this list.** A client banner component mounted in `DashboardChrome` (`components/ui/DashboardChrome.tsx:54` renders `{children}` at :145 — banner sits above it), reading `GET /api/user/totp/status` (§2.7; already `requireUser`-gated and cheap), rendering nothing when `totpEnabled` or while loading, linking to the existing settings 2FA section (`components/dashboard/TotpSection.tsx` surface), dismissible with `localStorage` (per-browser, re-appears on new devices — acceptable and arguably desirable for a nudge; a `User` column for dismissal is speculative schema, rejected per the constraint). Session-JWT `requireTotpSetup` is the *forced*-enrollment flag and is not touched. Skip rendering for `SYSTEM_ADMIN` (they live under forced TOTP policy, `require_totp_system_admin` locked true at `settings/route.ts:40-45`).

### 6.8 Platform Ops: API/Plaid cost & usage visibility

Stated plainly, per §2.11: **true dollar-cost reconciliation is not programmatically available** from either provider without manually-configured per-unit prices tied to Chris's actual plan — so the plan is call-volume/token counting as the leading indicator:

- `lib/usage/record.ts` — `recordApiUsage(provider, metric, unit, n)`: atomic upsert-increment on `ApiUsageCounter` (the `rate-limit.ts:98-109` idiom), **fire-and-forget and non-throwing** (a metrics failure must never fail a sync or a chat — the `EmailResult` posture).
- OpenAI hook: one call site — in `generateChatReply` after :72, record `calls`, `prompt_tokens`, `completion_tokens` from `completion.usage` per model. The provider file stays the single SDK import site; it just gains one internal call.
- Plaid hook: wrap at the chokepoint rather than editing ~16 call sites — export from `lib/plaid/client.ts` a thin recording proxy over `plaidClient` (method-name = metric, `calls` unit). Mechanical, additive; call sites keep their names. (Alternative — annotate each call site — rejected: 16 edits, drift-prone for future call sites.)
- Widget: `ops_api_usage` section (4th in PLATFORM_OPS) + `OpsApiUsageWidget` + `GET /api/platform/platform-ops/api-usage` (`requirePlatformAccess("PLATFORM_OPS","READ")`): calls today/7d/30d per provider, tokens per model, and — only if the optional `lib/usage/pricing.ts` constants are populated — an *estimated* spend figure explicitly labeled as estimate, the `GrowthSignupsWidget` honesty-footnote idiom.

---

## 7. Open product decisions (options + recommendation — not silently picked)

**7.1 Lockout: CAPTCHA-only vs durable lockout — DECIDED.**
**Chris has chosen Option A, plus a hybrid addition:** existing rate limits + CAPTCHA-after-N-failures; forgot-password is the self-service unlock; zero new state; no new DoS surface — **plus a direct owner-facing email at the same CAPTCHA-trip threshold** (§6.5/§6.6), reusing the anomaly detector's `sendEmail("security-alert", …)` call with the user's own address as the recipient. This is the practical hybrid: it gets the visibility Option B offered (the user learns something happened) without Option B's schema or its residual lockable-by-stranger surface. Option B (durable `lockedUntil`) is parked, not built — revisit only if real abuse outruns A + CAPTCHA + the owner email (the counters to detect that are exactly what §6.6 ships).

**7.2 CAPTCHA scope.**
Registration + access-request always (recommended, uncontroversial). Login: A (recommended) — after N=3 failed attempts per identifier, via the pre-login `captchaRequired` signal; B — always-on at login (simpler, but taxes every legitimate login and adds a hard Cloudflare dependency to the hot path); C — registration-only (leaves credential-stuffing mitigated solely by rate limits). Recommendation: **A**.

**7.3 Invite expiry & redemption rules.**
TTL: 14 days (prelaunch audit) vs 7 (tighter) — recommendation: **14**, beta queues move slowly. Redemption: single-use, email-bound, registration email must equal request email, invited signups skip email verification (the invite proved the inbox) — recommendation: all four as stated; the last one is the elegant win flagged by the audit. Resend policy: rotate token, same row, no cap (admin-initiated only).

**7.4 Denial UX.**
A (recommended): silent deny — status flip only, no email; the public form's response never discloses status anyway. B: courtesy denial email — needs a template + copy and creates a reply-to burden. Recommendation: **A** for now; revisit at open-registration.

**7.5 Registration-mode default at ship time.**
The toggle ships defaulting `open` (no behavior change) and Chris flips to `invite_only` when the landing page + queue are live — or the flip is part of Slice 3's ship checklist. Recommendation: **flip manually after verifying the invite path end-to-end in prod**, not in code.

---

## 8. Implementation slices — ordering & parallelization

Shared-file conflict map (verified against the tree, refining the Chris/Claude pre-identification):

- `app/api/auth/register/route.ts`: touched by **S2 (toggle) + S3 (invite gate) + S4 (CAPTCHA)** — the pre-identified beta-gate/CAPTCHA collision is **confirmed**, and S2 joins it (same gate block).
- `lib/auth.ts`: touched by **S4-login (CAPTCHA-on-login) + S6 (inline anomaly hook, which now also carries the decided lockout-hybrid owner-email fan-out)** — S5 is dropped (§7.1 decided Option A, nothing to build beyond S4+S6), so this collision is just the two-way S4/S6 sequencing.
- `lib/platform/policy.ts` + `lib/platform/seed.ts` + `components/platform/PlatformSpaceDashboard.tsx`: touched by **S3 + S6 + S7** (each adds one section + one registry line) — small, mechanical, but real merge conflicts if run truly concurrently.
- `prisma/schema.prisma` + migrations: **S3 + S7** (+S5 option B) — parallel sessions each running `prisma migrate dev` in one repo WILL collide on migration ordering; schema slices must land sequentially even when their code is disjoint.
- `app/page.tsx`: **S1 only**. `lib/rate-limit.ts` (peek helper): **S4 only**. `pre-login/route.ts`: **S4 (+S5 B)**.

**Slice 0 — Platform-section seed extension (tiny, unblocking).**
`ensurePlatformSections()` in `lib/platform/seed.ts`: for each area, upsert each `PLATFORM_AREAS` section against `@@unique([spaceId, key])` (create-only; never overwrite `enabled`/`order` of existing rows). Wire into the same entry points as `ensurePlatformSpaces`. ~1 file + test. **Prerequisite for S3/S6/S7's sections to appear.**

**Slice 1 — Landing page (large, fully parallel).**
§6.1. Files: `app/(public)/*`, `components/marketing/*`, `content/marketing/*`, `lib/marketing/*`, boundary test; replaces `app/page.tsx`, edits `app/layout.tsx` metadata. Request-access form wired to S3's endpoint URL but degrades to static shell until S3 ships. **Disjoint from everything else** (no schema, no auth files, no platform files).

**Slice 2 — Registration mode toggle (small).**
`registration_mode` key + default; register-route gate (top of handler, before validation); `ALLOWED_KEYS` + admin security page select; tests. Touches `register/route.ts`.

**Slice 3 — Beta-access system (the big one).**
Schema §5.1 + migration; `POST /api/access-request` (rate-limited; CAPTCHA verify call included but env-gated off until S4 configures keys — no file conflict, S3 calls `lib/captcha.ts` which S4 creates… **no: to keep S3/S4 file-disjoint, S3 ships `lib/captcha.ts` with the verify helper**, S4 consumes it); `beta-invite` template + union entry; Growth queue widget + routes + section + registry entry; register-route invite gate. Touches `register/route.ts`, platform section files, schema.
**Sequencing: S2 → S3 on the register route (S2's mode gate is the seam S3's invite branch lives in). Run S2 and S3 as one session, or strictly serial.**

**Slice 4 — CAPTCHA (medium).**
Turnstile client component in the register page + access-request form + login page; server verification on register + access-request; `peekKey` in `lib/rate-limit.ts`; pre-login `captchaRequired`; `authorize()` threshold check. Touches `register/route.ts` (after S3) and `lib/auth.ts` + `pre-login`. Env: `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` (+ `lib/env.ts` awareness).

**Slice 5 — Lockout: DROPPED.** §7.1 decided Option A — nothing to build beyond S4 (CAPTCHA) and the owner-email fan-out folded into S6 below. This slice number is retired, not reassigned, so citations elsewhere in this doc stay stable.

**Slice 6 — Security Ops anomalies + lockout-hybrid owner email (medium).**
Detector + inline hook in `authorize()`; registry entries; fan-out (grant-holder notifications + direct `sendEmail` to `SECURITY_ALERTS_EMAIL` **+ direct `sendEmail` to the affected user's own address when the trip is a resolvable identifier** — the decided §6.5 hybrid, same call shape, no new template); `sec_anomalies` widget + route + section. Touches `lib/auth.ts` (after S4) and platform section files (after/with S3, S7).

**Slice 7 — Platform Ops API usage (medium).**
Schema §5.2 + migration (serialize with S3's migration); `recordApiUsage`; provider hook; Plaid client proxy; `ops_api_usage` widget + route + section.

**Slice 8 — 2FA nudge (small, fully parallel).**
§6.7. New banner component + one-line mount in `DashboardChrome.tsx`. **Zero dependency on S0-S7, confirmed.**

### Parallel execution plan (what can actually run concurrently)

- **Wave 1 (3 parallel sessions):** ① S1 landing page · ② S0 + S2 + S3 (the growth/gate train — one session because of the register route + schema) · ③ S8 2FA nudge.
- **Wave 2 (2 parallel sessions):** ④ S4 CAPTCHA (register route free after Wave 1; owns `lib/auth.ts` first) · ⑤ S7 API usage (schema migration serialized after ②'s — rebase before `migrate dev`; platform-section files shared with ② — mechanical one-line merges, or hold its section/registry lines to land last).
- **Wave 3 (1 session):** ⑥ S6 anomalies (now carrying the lockout-hybrid owner email) — queues behind S4 on `lib/auth.ts` so its inline hook sees the final shape of the failure branches. S5 no longer exists as a queued item.

The two pre-identified conflicts (register route: beta-gate+CAPTCHA; `lib/auth.ts`: CAPTCHA-login+lockout) are confirmed in spirit; the corrections from evidence and decision are that **S2 also lives in the register route** (fold into the S3 session), **S6 also lives in `lib/auth.ts`** (queue it in Wave 3), **S5 is dropped entirely** (Option A decided, no durable-lockout code to sequence), and **schema migrations serialize S3/S7 regardless of code disjointness** (no S5-B migration to add to that queue anymore).

---

## 9. What was checked and dropped

- **Notification-platform "arbitrary email" extension** — dropped; direct `sendEmail` is the doctrinally-correct path (§2.4).
- **Separate `InviteToken` table** — dropped for token columns on the request row (§5.1).
- **New unlock-token scheme for lockout** — dropped; forgot-password already is the emailed unlock (§6.5).
- **Anomaly sweep job / scheduler wiring** — dropped for v1; inline producer checks are real-time and need no OPS-4 dependency (§6.6).
- **`User` column for nudge dismissal** — dropped as speculative (§6.7).
- **Real-time billing API integration** — confirmed not to exist in usable form; replaced by local counting + optional price constants (§6.8).
- **`lib/activity/` reuse** — checked; nothing here is Space-member activity, so it is correctly unused (§2.5).

---

*Stop point: plan only. No code, schema, or STATUS/ROADMAP changes were made in this pass.*
