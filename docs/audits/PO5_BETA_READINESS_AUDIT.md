# PO-5 — Beta Hardening & Operational Readiness Audit

**Status:** INVESTIGATION COMPLETE. Findings categorized (P0–P3). **No implementation performed** — this audit is the gated deliverable; implementation follows once priorities are chosen.
**Date:** 2026-07-19.
**Method:** four parallel read-only investigations (onboarding journey; Customer Success + Growth + Platform Ops observability; security + privacy; financial-trust + performance + mobile-code) plus firsthand mobile browser testing at 390×844.
**Guiding question:** *"If 100 strangers signed up tomorrow, what would fail?"*

---

## 0. Executive summary — the seven launch questions

| # | Question | Answer |
|---|---|---|
| 1 | Can a stranger onboard without help? | **Only with an invite AND production Plaid configured.** The invited path is good (auto Space, coherent verification, strong empty states). The risk is env/config: Plaid keys + coverage (§P0/P1). |
| 2 | Can a stranger connect accounts and understand progress? | **Yes, once connected** — CONN-1/2/3 make acquisition→intelligence→freshness honest. **But** the Connect action fails silently if Plaid isn't configured, and is US-only. |
| 3 | Can support diagnose problems without seeing private financial data? | **No per-user lookup exists in Customer Success** (P1). The privacy boundary is clean; the diagnostic data exists but is scattered across other grants and not user-searchable. |
| 4 | Can operators control beta safely? | Registration modes, invite flow, product-status, job/provider health are strong. **Gap: email-send health + error monitoring are invisible** (P1). |
| 5 | Can we detect when something breaks? | Jobs/cron death and bank/FX/price/crypto provider health: **yes, well-built**. Email delivery + API errors: **no** (P1). |
| 6 | Do financial numbers feel trustworthy? | **Largely yes** — freshness wired everywhere (CONN-3), double-count guards in place. One residual: net-worth vs Investments-tab investment basis can silently diverge (P2). |
| 7 | Anything embarrassing a beta user hits immediately? | The **Plaid config/coverage** cluster (silent Connect failure / US-only), the **Personal-Space "share accounts" dead-end**, and the **"Add Manual Asset" mislink**. |

**Overall:** the platform is unusually well-built and secure for a pre-beta product. The blockers are concentrated in **launch configuration (Plaid + registration mode)**, **operational visibility (email + errors + per-user support lookup)**, and **a few unbounded queries + onboarding dead-ends** — not in architecture. **No P0/P1 security vulnerabilities were found.**

---

## P0 — Cannot beta launch

- **Finding:** The "Connect institution" action crashes silently when Plaid isn't configured — the UI never checks `env.isPlaidEnabled`, and the link-token route imports `plaidClient` at module load (which throws on missing keys).
- **Severity:** **P0 if the beta env lacks production Plaid credentials; P1 (graceful-failure code fix) regardless.**
- **Beta impact:** With no/misconfigured keys, `GET /api/plaid/link-token` 500s at module load; the Connections empty state still shows "Connect institution," so the single most important onboarding action fails with only a small "Could not start Plaid Link." The core value moment is unreachable and unexplained.
- **Evidence:** `lib/plaid/client.ts:36,20-22` (validate+throw at load); `app/api/plaid/link-token/route.ts:27` (top-level import); `context/PlaidContext.tsx:275,281`; `components/connections/ConnectionsSpaceDashboard.tsx` empty state; `lib/env.ts:386` (`isPlaidEnabled` defined but referenced nowhere in `app/`/`components/`).
- **Recommendation:** (a) **Launch gate:** verify production Plaid keys + `PLAID_ENV=production` in the beta env. (b) **Code:** gate Connect actions on `env.isPlaidEnabled` and return a clean 503 (not a module crash) with a "Bank connections are being set up" state.
- **Now / defer:** **Now.**

---

## P1 — Beta blockers

### Onboarding / configuration

- **Finding:** Plaid Link is hardcoded US-only (`country_codes = [CountryCode.Us]`), contradicting the MENA/global landing framing.
- **Severity:** P1 · **Beta impact:** a non-US invitee opens Link and finds no connectable institutions — a hard expectation violation at the value moment. · **Evidence:** `app/api/plaid/link-token/route.ts:141`; hero `app/(public)/page.tsx:19` (`earth-mena.png`). · **Recommendation:** decide beta coverage — scope invites US-only OR add the intended country codes; set expectations in copy. · **Now / defer:** Now (decision before inviting non-US users).

- **Finding:** `registration_mode` defaults to `open`, contradicting the invite-only marketing copy; a visitor who guesses `/register` bypasses the invite story.
- **Severity:** P1 · **Beta impact:** backend allows self-registration while every marketing surface says invite-only and links only to the waitlist. · **Evidence:** `lib/platform-settings.ts:54-55` (default `"open"`); `content/marketing/copy.ts:151,162`. · **Recommendation:** set `registration_mode = invite_only` as a documented go-live step (align backend to copy), or add a "Create account" CTA if open self-serve is intended. · **Now / defer:** Now (launch-config checklist).

- **Finding:** Sandbox vs production Plaid key ambiguity (`PLAID_ENV` defaults to `sandbox`).
- **Severity:** P1 · **Beta impact:** with sandbox keys, real bank logins fail confusingly (only `user_good`/`pass_good` work). · **Evidence:** `lib/env.ts:303`. · **Recommendation:** verify `PLAID_ENV=production` + prod keys as a launch gate. · **Now / defer:** Now (env verification).

### Customer Success

- **Finding:** No per-user support lookup exists in Customer Success — only cross-user aggregate sync-issue counts, with no user identifier attached.
- **Severity:** P1 · **Beta impact:** a CS operator literally cannot look up who a complaining user is, when they joined, whether email is verified, how many accounts connected, or their sync state. The diagnostic building blocks exist but are split across GROWTH_REVENUE (`OpsUsersWidget`) and PLATFORM_OPS (`OpsConnectionDiagnosticsWidget`, capped at 50 recent, no owner filter) and are not user-searchable. · **Evidence:** `lib/platform/workspaces.ts:138-140` (CS = only `cs_sync_issues`); `app/api/platform/customer-success/sync-issues/route.ts:56-62` (no userId); `lib/platform/connection-diagnostics.ts:58,65` (cap 50, no owner filter). · **Recommendation:** add a `cs_user_lookup` section + search-by-email route composing the existing metadata-only readers (identity + `emailVerifiedAt` + last login + connection count + health + unresolved sync-issue count). No new financial authority. · **Now / defer:** Now (core CS job for beta).

### Growth analytics

- **Finding:** "Activation" is defined as ≥1 login session, not "connected first account" — the true product activation event isn't measured.
- **Severity:** P1 · **Beta impact:** Growth can't answer "what % of registered users connected a bank?" The funnel's "Activated" counts anyone who logged in — a user who bounced at an empty dashboard still counts. · **Evidence:** `lib/platform/growth/growth.ts:29-36,106-109`; `components/platform/widgets/OpsGrowthWidget.tsx:54`. · **Recommendation:** add `connectedFirstAccount()` = distinct users with a live `PlaidItem`/`Connection` (a `groupBy(userId)` over existing tables); rename the login proxy to "Signed in". · **Now / defer:** Now (activation is the beta north-star; current metric misleads).

### Platform Operations observability

- **Finding:** Email sending is completely invisible to operators — no email provider spec, `NotificationDelivery` ledger is unread by any surface, and `send.ts` silently falls back to a capture adapter when `RESEND_API_KEY` is unset.
- **Severity:** P1 · **Beta impact:** a misconfigured/failing email key means beta invites and verification links silently vanish with zero operator signal — directly breaking onboarding. · **Evidence:** `lib/platform/provider-health.ts:90,195-213` (ProviderKind has no EMAIL); `lib/email/send.ts:16-38` (silent capture fallback, no ledger); `prisma/schema.prisma:2563-2585` (`NotificationDelivery` indexed `// OPS-5 failure-rate queries` but no reader). · **Recommendation:** add an EMAIL provider spec / email-delivery-health widget over the existing `NotificationDelivery` index, and record auth (verification/reset/invite) sends to the same ledger so a capture-in-prod fallback is visible. · **Now / defer:** Now.

- **Finding:** No error monitoring (Sentry or equivalent) — production server errors are console-log-only.
- **Severity:** P1 · **Beta impact:** when an API throws in prod, operators have no aggregated error visibility (only raw Vercel logs); breakage is discovered via user reports. This is the documented OPS-1 floor gap. · **Evidence:** `instrumentation.ts` (explicit "Sentry NOT configured" non-goal); no `@sentry` in `package.json`. · **Recommendation:** adopt an error monitor, init in `register()` with PII/financial scrubbing. · **Now / defer:** Now.

### Performance / scale

- **Finding:** The primary transaction reads run `findMany` ordered by date with **no `take` cap**, and `/api/money/view-context` loads **all** transactions on every dashboard mount to build the FX context.
- **Severity:** P1 · **Beta impact:** a user with years of history loads every transaction into memory + payload on the dashboard data path; cost grows unbounded with account age — worst for the most engaged beta users. `view-context` fires on every dashboard mount even for single-currency users. · **Evidence:** `lib/data/transactions.ts:132,220,269` (no `take`); `app/api/money/view-context/route.ts:39,52-64` (uncapped + maps every tx). · **Recommendation:** bound the transaction reads (most-recent N or a default date range) with server-side pagination (the list already paginates 25/page client-side); derive currency/date coverage for `view-context` from a cheap `groupBy`/`distinct`, short-circuiting single-currency Spaces. · **Now / defer:** Now (degrades continuously with real usage).

---

## P2 — Quality improvements

- **Terms/Privacy consent not captured at registration** — no checkbox, no `acceptedTermsAt`. A fintech collecting bank data/DOB/credit-score launches beta with zero recorded consent. *Evidence:* `app/(auth)/register/page.tsx` (no consent), `prisma/schema.prisma:335` (no field). *Rec:* required "I agree to Terms & Privacy" checkbox + persist `acceptedTermsAt`+version. **Now** (cheap, legally material — borderline P1 for a financial product).
- **Per-IP rate limits key on spoofable `x-forwarded-for[0]`** — register/forgot/reset abuse (spam, email-bombing) bypassable; login is unaffected (uses `cf-connecting-ip`). *Evidence:* `lib/rate-limit.ts:169-176` vs `lib/auth.ts:119-122`. *Rec:* reuse the `cf-connecting-ip`→`x-real-ip`→`x-forwarded-for` precedence in `getClientIp`. **Now** (small).
- **Personal-Space "share accounts" dead-end** — the zero-account Personal Space Overview shows sharing language + an "Add accounts" CTA that opens a share-only modal with no connect path. *Evidence:* `components/space/workspaces/OverviewWorkspace.tsx:48-52`; `components/space/manage/FinancesPanel.tsx:96-138`. *Rec:* point the day-zero CTA at `/dashboard/connections`; drop "shared" wording for the personal context. **Now** (copy/link).
- **"Add Manual Asset" button links to Connections** — doesn't open the manual-asset flow (which exists). *Evidence:* `components/brief/BriefNewUser.tsx:38-44`; `components/dashboard/AddManualAssetModal.tsx`. *Rec:* wire to the modal or relabel. **Now.**
- **Net-worth vs Investments-tab investment basis divergence** — net worth uses institution `account.balance`; Investments values the position spine ("N of M valued"). Two different investment numbers, no cross-explanation. *Evidence:* `lib/snapshots/regenerate.ts:123-125` vs `lib/investments/space-data.ts:183-184`. *Rec:* add a one-line reconciliation note (or reconcile to one basis). **Defer** (disclose now if cheap — confusion risk, not a wrong number).
- **Account-modal transaction route unbounded** (`app/api/accounts/[id]/transactions/route.ts:49`). *Rec:* cap + paginate. **Now** (same pattern as P1 perf).
- **No external dispatcher heartbeat** — all job-health detection runs inside the same cron it monitors; if the Vercel dispatcher dies, the alerter dies too. *Evidence:* `vercel.json` (single cron); `lib/jobs/registry.ts:183-188`. *Rec:* external uptime ping / Vercel cron-failure notifications. **Defer** (acceptable if an operator checks the dashboard daily).
- **Onboarding-stage / profile-ready not modeled** — support/growth can infer verified + connected from raw fields, but there's no "profile-ready" concept. *Rec:* derive as a pure projection once the CS lookup exists; drop the funnel stage if undefined. **Defer.**
- **Registration front-loads heavy optional PII** (DOB/employment/use-case/credit-score). *Rec:* collapse behind "Add details later". **Defer.**

---

## P3 — Future

- `users/search` returns real first/last names to any authenticated user via substring match (enumeration/PII). Restrict to username/email exact match. **Defer.** (`app/api/users/search/route.ts:39-58`)
- Rate limiter fails open silently on store errors — add a monitored alert. **Defer.** (`lib/rate-limit.ts:140-149`)
- "Sync Now" route (`/api/plaid/sync`) imports transactions without the CONN-3 balance refresh — latent stale path, **not UI-wired**. Flag on the ticket that ever wires a button to it. **Defer.**
- CONN-3 adds one `accountsGet` per item per webhook/cron — Plaid call-volume cost at scale, not correctness. Monitor. **Defer.**
- `SummaryWidget` fixed `grid-cols-3` can crowd on the narrowest phones. Use `grid-cols-2 sm:grid-cols-3`. **Defer.** (`components/space/widgets/SummaryWidget.tsx:152`)
- `request-access` reports success even on a 404 (degraded mode) — dormant (route exists); add volume monitoring. **Defer.**

---

## What is beta-ready (verified strong — do not re-investigate)

- **Security/authorization:** ~18 sampled customer `[id]` routes + all 30+ `app/api/platform/*` routes are correctly gated (ownership / `requireSpaceRole` / `requirePlatformAccess`). **No IDOR, no missing ownership checks, no platform/space leakage.** Auth core is robust (rate limit → CAPTCHA step-up → bcrypt → verification gate → mandatory admin TOTP → session revocation; `requireFreshUser` for sensitive actions).
- **Onboarding fundamentals:** email-verification flow coherent ("check your inbox" + login gate + resend); **MFA not forced on normal users** (admin-only unless the operator opts in); PERSONAL Space auto-created atomically at registration; `BriefNewUser` and CONN-2H Connections empty states are clear and route to Connect.
- **Privacy:** data export (rate-limited, visibility-enforcing), reversible-grace-window account deletion + complete purge, AI data handling funneled through one provider with disclosure and no PII-to-logs. CS surfaces are metadata/counts-only — **no financial leakage.**
- **Operational visibility (partial):** job/cron **dead-job detection** over a `JobRun` ledger with operator widget + alert email; provider health for bank/FX/price/crypto.
- **Financial trust:** CONN-3 balance freshness wired into **all three** paths (webhook/cron/manual); double-count guard (`excludeDigitalAssetAccounts`) applied; "N of M positions valued" trust arithmetic consolidated; net worth reads the cached snapshot (no live recompute on load); growing-table reads (activity/audit/snapshots) are bounded; investment valuation batched (no N+1).
- **Mobile:** login/register/reset, Connections, and Space/Dashboard **reflow to usable single-column layouts** at 390×844 (firsthand-verified). No fixed-width/off-screen/non-reflowing core flow.

---

## Launch-configuration checklist (operator actions — not code)

These gate a safe beta and are **environment/config**, not code:
1. **Plaid:** production keys present, `PLAID_ENV=production`, country coverage decided (US-only invites or added country codes).
2. **`registration_mode = invite_only`** (align backend to the invite-only copy).
3. **`RESEND_API_KEY`** set (verify a real verification/invite email lands — currently no operator signal if it doesn't).
4. **Error monitoring** provider configured.
5. Turnstile/CAPTCHA keys live (if abuse protection desired).

---

## Recommended "do-now" implementation shortlist (post-audit, on approval)

Small, safe, high-value code fixes (no new product surface):
1. **Gate Connect UI on `isPlaidEnabled`** + link-token returns 503 not a crash (P0 graceful failure).
2. **Cap/paginate the unbounded transaction reads** + `view-context` (P1 scale) — `lib/data/transactions.ts`, `app/api/money/view-context`, `app/api/accounts/[id]/transactions`.
3. **CS per-user lookup** (compose existing metadata readers) (P1).
4. **Activation metric = connected-first-account** (P1 growth).
5. **Email-delivery-health surface** over `NotificationDelivery` + persist auth sends (P1 ops).
6. **Registration consent capture** (`acceptedTermsAt`) (P2/compliance).
7. **`getClientIp` non-spoofable precedence** (P2 abuse).
8. **Personal-Space CTA → Connections** + fix "Add Manual Asset" link (P2 onboarding).

**Deferred to launch config / future:** Plaid keys + mode + Resend + error-monitor (operator config); Sentry adoption; external heartbeat; investment-basis reconciliation note; `users/search` narrowing; `SummaryWidget` mobile polish; "Sync Now" stale path (on its wiring ticket).

**Constraints honored:** no redesign of Spaces / Platform HQ; no new AI features / providers; no PO-4B; no deletion-architecture expansion. Every recommendation is stabilization/hardening.
