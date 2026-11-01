# Pre-beta readiness audit, Session 2 sections (2026-11-01)

**Scope.** This document is Session 2's part of the final pre-beta readiness audit. Session 1 coordinates and writes the consolidated report. It covers:
- **P1** bot signups and CAPTCHA;
- **Area 1**, registration-policy half: registration gates and beta-request intake;
- **Area 2**, authentication, authorization, 2FA and RLS, including RLS as Production runs it;
- **Area 5**, provider usage limits, budgets, Cost Freeze and AI caps;
- **Area 7**, Customer Support / Customer Success operations;
- **Area 10**, privacy, legal and customer-facing claims;
- **(a)**, analytics and telemetry.

**Method.** The audit was read-only.
- Code was read with git at three refs:
  - `origin/main` **4dda8dc**, which is what Production runs;
  - `origin/develop` **0f59435**;
  - open PR **#160** at **6a222b2**.
- Live checks were anonymous GETs of the public site and the app, plus Production `/api/health`.
- Production env **names** come from Session 1 (Vercel API, names only).
- Nothing was changed anywhere: no Production data, settings, secrets, invitations or deploys.

**Classification.**
- **VERIFIED READY**: verified in the code Production runs (main), and observed live where that is possible.
- **READY WITH ACCEPTED LIMITATION**: works, with a named limitation the owner accepts.
- **BLOCKED**: a defect or missing control that must be fixed before the beta.
- **NOT YET VERIFIED**: the evidence needs a live read we don't have.

**Keep two questions separate.** Code completeness asks "is it on develop?". Production readiness asks "is it on main 4dda8dc and configured?". `main` is **418 commits and 9 migrations behind develop**, so none of the 10-31 to 11-01 work runs in Production. Merged is not the same as protected.

**Not verified live.** Auto-mode refused twice to run SQL through the owner's Supabase SQL editor ("Sensitive Remote Exec"). `fm_diag_ro` was retired on 10-31. So every Production DB fact below is **NOT YET VERIFIED (live)** and its last evidence is cited. §9 gives the exact read-only SQL for the owner to run.

---

## P1: bot signups and CAPTCHA

### What happened (the 13-request investigation, 2026-10-31)

Evidence comes from `docs/plans/BETA-REQUEST-PROD-INVESTIGATION-RESULTS-2026-10-31.md`, on branch `docs/beta-risk-and-parity` at 1dead91. It was produced by the temporary, owner-approved `fm_diag_ro` role, using column grants only, a read-only guard, and masked output. The role was retired afterwards.

- **Requests:** 20 in total, all `PENDING`.
- **Decisions:** 0 decided, 0 invited, 0 redeemed, 0 decision events. This is per-request in section D of the masked output (`decided f`, `redeemed f`, `decision_events 0`).
- **Cluster:** 13 requests are classed as high suspicion, all from one actor. They span **6 Sep – 22 Oct**, and every one of them has all of the following:
  - a **byte-identical desktop user-agent string**, agent group 4 (13 of 13 rows). A real population drifts across Chrome releases over seven weeks; these didn't;
  - **Gmail** local parts with two or more dots, most of them `letter.…`. None fold into one mailbox;
  - a long, unique note on every request;
  - a **different network per request** (20 networks across 20 audit rows), which fits rotating proxies;
  - an evenly spaced cadence of about one every 3–5 days, at varied hours;
  - no event-ledger row, no acquisition source and no plus-alias.
- **Plausibly genuine (7):**
  - 2 early desktop requests with no note;
  - 1 iCloud request on mobile;
  - 4 mobile requests in late October, with an acquisition source and event-ledger rows.

**What's proven:** a single automated or scripted actor, or one person replaying a fixed browser profile through rotating networks, produced 13 requests.

**What's not proven:**
- intent;
- whether a human sat behind it;
- whether the 2 early desktop requests are genuine (they lack event and source data);
- that the cluster contains no real person at all.

These are heuristic signals, not proof.

**What happened to the applications:** as of the 10-31 run (~07:20Z), **nothing**. None were approved, invited, activated or redeemed. **Current state: NOT YET VERIFIED (live).** Run query Q1 in §9.

### Is Turnstile enforced in Production?

**No.** The evidence agrees on all four layers.

| Layer | Finding | Evidence |
|---|---|---|
| Env presence | **Absent.** No `TURNSTILE_*`, `CAPTCHA*` or Cloudflare keys in Production, Preview or any branch scope. The only related names are `RATE_LIMIT_ENABLED` (production and preview) and `EMAIL_NONPROD_ALLOWLIST` (preview). | Session 1, Vercel API, names only, 2026-11-01 |
| Widget on the live page | **Absent.** No `turnstile`, `challenges.cloudflare` or `data-sitekey` on fourthmeridian.com/request-access, or on app.fourthmeridian.com/request-access, /register or /login. | Anonymous GETs, 2026-11-01 00:09Z. The widget renders only when `NEXT_PUBLIC_TURNSTILE_SITE_KEY` is set (main `components/marketing/RequestAccessForm.tsx:49,208`; `app/(auth)/register/page.tsx:13,392`) |
| Server verification, main | **Present but fails open.** With no `TURNSTILE_SECRET_KEY`, `verifyCaptchaToken` returns **true** (`lib/captcha.ts:55`). | main `lib/captcha.ts:52-55` |
| Missing config fails closed? | **No, on main, develop or #160.** #160 still returns `passed` when the secret is missing; it only logs one warning (`lib/captcha.ts:111`). Unpaired keys only log at boot. | pr160 `lib/captcha.ts:111`, `lib/env.ts` validateEnv |

### Controls

Values are given for main (Production) / develop / #160.

| Control | main | develop | #160 | Notes |
|---|---|---|---|---|
| Server-side siteverify | IMPLEMENTED, TESTED | same | TESTED | `lib/captcha.ts:70`, 5 s timeout. A direct POST cannot skip it **when a secret is set** (it is checked in the route handler) |
| Cloudflare down / timeout / non-2xx | **lets the request through** (`:80-91`; test locks this in, `captcha.test.ts:55,59`) | same | **refuses: 503 with Retry-After 60**, TESTED (`captcha.ts:137-158`, `route.ts:174-176`) | |
| Token expiry / replay | relies on Cloudflare single-use tokens; only `success` is read | same | same | `hostname`, `action` and `challenge_ts` are **never checked** on any ref; the widget sets no `action` |
| Per-IP limit | 5 per 15 min; **lets traffic through if the store errors** | same | same, plus tests | `app/api/access-request/route.ts:63`, `lib/rate-limit.ts:138-148` |
| Per-email limit | ABSENT | ABSENT | 3 per 24 h; silent drop with the same 200 | |
| Global limit | ABSENT | ABSENT | 60/h from a PlatformSetting (10–1000); lets traffic through if the store errors | |
| Operator-email throttle | ABSENT | ABSENT | 1 per canonical address per 24 h; 20/h | Each submission emails the operator if `BETA_REQUESTS_EMAIL` is set |
| Alias normalisation | lowercase and trim only | dedupe the same; `canonicalEmailKey` (dots, +tags) feeds the advisory signal only | used for the operator throttle only | Per-address keys deliberately use the stored form so aliases can't block the real address |
| Risk signals | ABSENT | 9 codes, advisory, TESTED (#161, `beta-risk-core.ts:61-63`). **The badge isn't rendered** in the queue (placeholder `GrowthBetaRequestsWidget.tsx:474,496,534`) | ABSENT (#160 predates #161) | |
| Bulk approve guard | ABSENT (single approve only, no risk cue) | client-side acknowledgement of flagged rows (#163). The server ignores risk by design | ABSENT | |
| Intake route test | **none** | **none** | `app/api/access-request/route.test.ts`, 8 sections | |

### Exposure, if Production stays as it is

- **Waitlist spam is uncapped.** With no captcha, a script that rotates IPs can create intake rows without limit. The per-IP limit doesn't stop rotation, and there's no per-email or global cap.
- **Operator email can be flooded.** Each submission can email the operator, with no throttle.
- **No account can be created.** Registration resolves to `invite_only` (see Area 1), and login is credentials-only with no OAuth signup. So the exposure is spam rows and noise, **not** accounts, provided no one approves a bot request.
- **The real risk is human approval.** An operator who approves a cluster request issues a real invitation to a bot-controlled mailbox. Production (main) shows **no risk cue** on approval.

### P1 classification: **BLOCKED for opening the public intake. READY WITH ACCEPTED LIMITATION for an invite-only cohort chosen by the owner.**

**Code prerequisites before any intake batch** (recorded by Session 1 in the batch plan):
1. Rebase #160 on develop; it lacks #161 and #163.
2. Make a missing `TURNSTILE_SECRET_KEY` **fail closed** in Production (refuse, 503) rather than pass.
3. Check siteverify `hostname` against the allowed hosts, and `action`; set `action` on the widget.
4. Render the risk badge in the queue and on single-row approve.
5. Add the route test for `/api/access-request` (already in #160).

**Config prerequisites (owner action):** create the Cloudflare Turnstile site and secret keys and set both in Production. Validate on Preview first.

---

## Area 1 (registration-policy half): registration gates and beta-request intake

| Item | Status | Evidence |
|---|---|---|
| Registration needs an invitation | **VERIFIED READY in code.** **NOT YET VERIFIED (live)** for the setting row. | Mode comes from PlatformSetting `registration_mode` (open / invite_only / closed). A missing or unrecognised value resolves to **invite_only** (main `lib/platform-settings.ts:132,437-441`). If the DB read throws, the route returns 500. invite_only requires a valid, approved, unexpired invitation that matches the email, consumed in the same transaction (main `app/api/auth/register/route.ts:153-179`). Tests: `register/route.test.ts` §1, §2, §7, §9; `lib/registration-policy.test.ts`; `platform-settings.test.ts:83-84`. **The live row must not be `open`: run Q2.** |
| Other ways to create an account | **VERIFIED READY** | The only `user.create` is the register route (main `:198`). CredentialsProvider only (`lib/auth.ts:179`), so no OAuth signup. Operator direct-invite needs an operator login. |
| Terms consent at signup | **VERIFIED READY** | `register/route.ts:78` rejects unless `acceptedTerms === true` |
| Intake validation | READY WITH ACCEPTED LIMITATION | Loose email regex, `consent === true`, note ≤ 1000 chars, `createMany skipDuplicates`, uniform 200. No CAPTCHA or caps in Production (see P1) |
| Approval safety | **READY WITH ACCEPTED LIMITATION** | main has no risk cue. develop's #161 and #163 add advisory signals and a bulk acknowledgement, but the badge isn't rendered. Limitation: the owner must not approve the 13-request cluster without manual verification |

Area 1 also involves Session 1's invitation lifecycle (#158/#163): issuance, expiry, resend and revoke are on develop only.

---

## Area 2: authentication, authorization, 2FA, RLS

| Control | main (Production) | develop | Classification for Production |
|---|---|---|---|
| Auth stack and sessions | NextAuth v4, credentials, JWT plus a stored session-row check per request. 30-day idle and 90-day absolute limits, TESTED | same | **VERIFIED READY** |
| Live role re-check / revocation | Role re-read with a 30 s cache. Fresh guards bypass the cache and return 503 when the DB is down. Password reset revokes all sessions | same | **READY WITH ACCEPTED LIMITATION**: up to 150 s of stale acceptance during a DB outage (`lib/session-cache.ts:116`) |
| 2FA for SYSTEM_ADMIN | Mandatory, re-derived from the DB every login | same | **VERIFIED READY** (`lib/auth.ts:367-430`) |
| SEC-001 2FA page bypass | FIXED, TESTED (`lib/auth/page-gate.test.ts`) | same | **VERIFIED READY** |
| SEC-006 admin 2FA reset | FIXED, TESTED | same | **VERIFIED READY** |
| 2FA for platform operators | **ABSENT** | implemented; **off unless** `OPERATOR_TOTP_ENFORCEMENT=enforce` (Preview only, per STATUS) | **BLOCKED for any operator other than the owner.** Accepted if the owner is the only operator |
| Platform checks (READ/WRITE/CONTROL, fresh on every mutation) | 47 of 47 WRITE/CONTROL calls use the fresh guard | 95 of 95 | **VERIFIED READY** |
| System Admin bypass obeys `DISABLE_SYSTEM_ADMIN` | **NO.** The bypass returns before the switch (`lib/platform/authorize.ts:93-95`), so an admin session issued before the switch flipped keeps CONTROL | FIXED (#131, `decideBreakGlass`, `platform-sec-1.test.ts`) | **READY WITH ACCEPTED LIMITATION** until promoted. The kill switch is incomplete in Production |
| RLS strict mode | Production refuses to boot without `FM_RLS_STRICT=true` and valid role URLs (`lib/db/strict-mode.ts:86-105`) | same | **VERIFIED READY in code.** Live Production booting means the guard passed (health ok at 00:09Z) |
| RLS as Production actually runs it (roles, BYPASSRLS, policies, grants, schema ACL) | last live evidence 10-31: schema public `=U` after REVOKE CREATE A+B; only postgres and supabase_admin hold CREATE | — | **NOT YET VERIFIED (live)** for policies and grants. Run Q3 |
| Routes that skip RLS | 12 customer-facing API routes use the migration-principal `db` and are protected only by app-level checks (spaces accounts, members, invites, snapshots, activity, permanent; users/search; access-request). Ratchet holds 162 files | same | **READY WITH ACCEPTED LIMITATION** (SEC-003 ratchet). P2 |
| Login brute force | 10 per identifier per 15 min, fails closed. Per-IP pre-login fails closed. CAPTCHA after 3 failures, but **the CAPTCHA does nothing** without keys | same | **VERIFIED READY**. The CAPTCHA step-up is inert |
| Password reset | 256-bit token stored hashed, 1 h, single use, 5 per 15 min per IP, uniform 200 | same | **VERIFIED READY**. The per-IP limit lets traffic through if its store errors |
| Account enumeration | login and reset don't reveal accounts. `/api/users/search` substring search, 60/h, 8 results | same | **READY WITH ACCEPTED LIMITATION** (SEC-005 partly mitigated) |
| Impersonation | none exists | none | **VERIFIED READY** |

**Area 2 summary for Production: READY WITH ACCEPTED LIMITATIONS, provided the owner is the only platform operator.** Two items are P1 to promote: the System Admin kill-switch fix (#131) and operator 2FA.

---

## Area 5: provider usage limits, budgets, Cost Freeze, AI caps

| Control | main (Production) | develop | Classification for Production |
|---|---|---|---|
| Global Cost Freeze | **ABSENT** | covers Plaid, wallets, prices, AI/Brief, FX/crypto/bank jobs and webhook sync. Fails closed (INVALID/UNAVAILABLE count as frozen). TESTED. Needs migration `20261031130000` | **BLOCKED as a control: there is no single stop switch in Production.** See P1 below |
| AI kill switch | missing setting = off; unreadable or invalid = paused; checked at the route and at the provider call | same | **VERIFIED READY** |
| AI per-user allowance and reservation | on by default; fails closed if the ledger or reservation can't be trusted | same, and the freeze overrides overrides | **VERIFIED READY** |
| AI pacing | per-minute and per-hour, fail closed | same | **VERIFIED READY** |
| Plaid new-Item cap | `maxConnections` checked before the link token (plan 10, ceiling 25), TESTED. **Investments enable has no plan or freeze check** | cap plus freeze plus lifecycle | **READY WITH ACCEPTED LIMITATION** |
| Email caps | per-route only; none at the shared send point | 5 per recipient per 60 min (security and sign-up emails exempt); non-production allowlist | **READY WITH ACCEPTED LIMITATION** for 10–25 users |
| CoinGecko / Alchemy budgets | **ABSENT** (estimate only) | daily caps, spend nothing if the counter is unreadable | **READY WITH ACCEPTED LIMITATION** (bounded by job design at a small cohort) |
| Places that fail open | ordinary `limitByIp`/`limitByUser` let traffic through when the store errors (Plaid link and exchange, reset, search); the CAPTCHA does nothing without keys | same, except the new caps | P2 |

**Area 5 summary for Production: READY WITH ACCEPTED LIMITATION for a 10–25 user invite-only cohort.** AI spend is fail-closed and capped per user. Plaid spend is capped per user by the Item limit. There is **no global freeze**, so stopping Plaid, crypto or price spend in an incident means the AI kill switch plus plan entitlements, or a deploy. Promoting the Cost Freeze is P1.

---

## Area 7: Customer Support / Customer Success operations

| Item | main / live | develop | Classification |
|---|---|---|---|
| Operator customer lookup, sync-issue episodes, policy/refresh actions | present | present | **VERIFIED READY** |
| Operator action audit (`recordOperatorAction`) | 25 call files | 34 | **VERIFIED READY** |
| Impersonation | absent | absent | **VERIFIED READY** (as intended) |
| Self-serve data export | present (3 per day) | present | **VERIFIED READY** |
| Account deletion (7-day schedule) | `jobs/process-deletions.ts` daily via `/api/jobs/dispatch` | same | **READY WITH ACCEPTED LIMITATION** (reconciled with Session 1, area 8). The code exists and is census-tested, and the dispatcher runs in Production: `/api/health` at 00:09Z shows `lastDispatchAt` 2026-10-31T21:45Z, `lastBackstopCronAt` 2026-11-01T00:05Z and `overdueJobs 0`. **A Production purge that completed end to end is NOT YET VERIFIED**: scheduler liveness does not prove `process-deletions` succeeded on a real account. Run Q4 |
| Published support email | live footer, Terms and Privacy: support@fourthmeridian.com | same | **VERIFIED READY** |
| Support route inside the app | **absent.** No Help or Support link on signed-in pages. Plaid errors say "Contact support." with no address (`lib/plaid/errors.ts:39,91,95`) | absent | **BLOCKED** (P1, small copy and nav fix) |
| Support page / SLA | absent (`/support` and `/contact` return 404) | absent | READY WITH ACCEPTED LIMITATION for 10–25 users |
| Inbound triage | support@ is both the sender of every system email and the inbound mailbox; no tooling | same | READY WITH ACCEPTED LIMITATION (P2) |
| Comms Center, incidents, CS overview | absent | present (Preview-verified; automations Preview-only) | not needed for beta day one |

---

## Area 10: privacy, legal disclosures, customer-facing claims

| Item | main / live | develop | Classification |
|---|---|---|---|
| Privacy policy | live, "Effective October 7, 2026". Names **Plaid** (§3) and **OpenAI** (§4). Retention and deletion (§6), "closed, invite-only beta" | same | **VERIFIED READY** |
| Terms | live: 18+, as-is beta terms, limitation of liability, "not financial, investment, tax, or legal advice" (§4) | same | **VERIFIED READY**. No governing law, dispute or indemnity clauses (lawyer, P2) |
| Advice disclaimers in-app and in the AI | `components/ai/GuidanceNote.tsx:33`; `lib/ai/conversation/product.ts:128` | same | **VERIFIED READY** |
| **AI system prompt says "wealth management platform"** | `lib/ai/conversation/turn.ts:134`, `product.ts:34`; test locks it in (`hardening.test.ts:169-170,249`) | **same** | **BLOCKED (P1).** It contradicts the site's positioning ("the decisions stay yours") and implies a regulated service. Owner-ruled copy; the prompt and the locked test change together |
| `app/(public)` and root metadata say "wealth management" | main `app/layout.tsx:8,31,38`, `app/(public)/layout.tsx:22,24`, `page.tsx:35,48`, `about/page.tsx:16` (inference: renders on app.fourthmeridian.com) | page copy fixed; root `app/layout.tsx` unverified | **P1**, ships with the next batch |
| Live marketing site claims | no "bank-level", "SOC 2" or "FDIC". Specific security claims (bcrypt, AES-256-GCM) | — | **VERIFIED READY** |
| "We never sell your data" | absolute claim | same | READY WITH ACCEPTED LIMITATION (it must stay true) |
| Cookies / trackers | no third-party trackers; no cookies on the public site; session cookies only | same | **VERIFIED READY**. No banner needed for strictly-necessary cookies (inference) |
| Privacy gaps | no cookies section, no state privacy rights (CCPA etc.), Sentry and service providers not named, product-usage telemetry not disclosed (see (a)) | same | P2 (lawyer plus the (a) disclosure) |
| Email footer and opt-out | main: plain text "enabled in Settings → Notifications"; no link, no postal address | link plus support contact | READY WITH ACCEPTED LIMITATION (transactional only). A postal address is required before any marketing email |

---

## (a) Analytics and telemetry

**What exists, on main and develop:**
- **A first-party product-analytics layer.** `lib/analytics/product-events.ts` writes typed events into `AuditLog`. The five events are SESSION_ACTIVE_DAY, SPACE_VIEWED, BRIEF_VIEWED, TRANSACTIONS_VIEWED and MANUAL_ASSET_VALUE_UPDATED. IP and user agent are forced to null, metadata keys are allowlisted, writes are deduped per user, action and day, and rows are purged after 13 months.
- **The Growth dashboard** reads it (`lib/platform/growth/product-analytics-core.ts`): a 7-stage funnel, active / present / engaged users, feature adoption, W1 retention, and AI cost per engaged user. develop adds W1–W8 acquisition cohorts.
- **Other telemetry:**
  - AiInvocation: tokens, latency and outcome; **no prompt or completion text**; 90 days;
  - JobRun / RefreshExecution: no money values, chain symbol only; 90 and 60 days;
  - UserSession;
  - Comms delivery: develop only; no addresses or bodies; opens and clicks never stored.
- **Sentry:** tracing off, `sendDefaultPii: false`, body, cookie and query scrubbing, user reduced to `{id}`, no Replay. Active only if a DSN is set.
- **No third-party analytics:** no Vercel Analytics, PostHog, GA, Segment or pixels. The CSP allows scripts only from Plaid and TradingView.

**Gaps:**
- Plaid Link starts and exits are console-only.
- "First successful sync" isn't a funnel stage, and RefreshExecution only reaches back 60 days.
- Chat-level AI failures and refusals aren't persisted.
- There's no session count.
- **Hygiene:** `LOGIN_FAILED` stores the raw typed identifier, which can be an email (`lib/auth.ts` ~101).

**Proposed minimal taxonomy (16 events, existing infrastructure, no new table, no migration).** Properties are ids, enums, counts and durations only. There are never financial values, credentials, emails or raw AI text.

**Derived from existing rows, with no new writes:**
1. `invite_redeemed`
2. `account_registered`
3. `email_verified`
4. `space_created`
5. `connection_added` {provider}
6. `sync_completed` {sourceKind, trigger, profile, status, durationMs}
7. `session_active_day`
8. `space_viewed`, `brief_viewed` and `transactions_viewed`
9. `ai_invocation` {surface, outcome, finishReason, tokens, latencyMs}
10. `onboarding_presented` and `onboarding_dismissed`

**New server-side writers, added to the product-event layer with an extended key allowlist:**

11. `connection_link_started` {provider}
12. `connection_link_exited` {provider, stage, errorCode enum}. Needs one tiny POST from `onExit`; never the institution name, `error_message` or the link session id.
13. `first_sync_succeeded` {sourceKind}, written once per user.
14. `ai_turn_failed` {surface, reason enum}.

**Reused or skipped:**

15. `data_exported`: reuses the existing audit action.
16. client errors: skipped; Sentry covers them.

**Cost and requirements:**
- **Effort:** about 1–1.5 days of SQL and reader work, about 1.5–2 days of writer code plus tests, and half a day of docs.
- **Disclosure:** add a "Product usage" bullet to the privacy policy (13 months, first-party, server-side, no financial values or conversation content). Name the acquisition source fields and Sentry.
- **Consent:** none needed while it stays first-party and server-side (inference, not legal advice). Adding any third-party or client SDK would change that.
- **Fix with it:** hash the LOGIN_FAILED identifier.

**Classification: READY WITH ACCEPTED LIMITATION.** The beta can launch on today's first-party layer. The connection-funnel and AI-failure events are a fast-follow.

---

## (b) Area 2 as Production actually runs it

- **RLS strict boot guard:** **VERIFIED.** Production is up and serving `db: ok`, and on main a Production process cannot start without strict mode and valid role URLs.
- **Schema ACL:** **VERIFIED 10-31 (live, owner-approved):** public `=U`, and CREATE is held only by postgres and supabase_admin.
- **Roles, BYPASSRLS, RLS-enabled and forced tables, policy count, anon/authenticated grants, and the latest applied migration:** **NOT YET VERIFIED (live).** The SQL is Q3 in §9. Session 1's area 9 owns the migration diff.

---

## P0 / P1 / P2 (Session 2 areas, Production = main 4dda8dc)

**P0: none in Session 2 areas**, provided the owner verifies the conditions in Q1/Q2 below. If Q2 shows `registration_mode = open`, that becomes **P0**: anyone could create an account, and there is no CAPTCHA.

**Reconciled P0 gating condition (with Session 1, areas 3/4):** no crypto-wallet users with ERC-20/SPL token holdings until B3 is promoted; otherwise the owner discloses "tokens not included". Main leaves token holdings out of wallet values silently, against the 10-30 valuation ruling. The owner choosing the cohort personally makes this a gating condition, not an unconditional P0.

**P1**
1. **Turnstile is not configured and fails open** on every ref, including #160 when the secret is missing. Code fix: fail closed, plus hostname/action checks, plus rebase #160. Config: set the keys (owner).
2. **The 13-request cluster must not be approved** without manual verification. Production gives the operator no risk cue.
3. **No global Cost Freeze in Production** (promote develop's L2 freeze plus migration `20261031130000`).
4. **The System Admin platform bypass ignores `DISABLE_SYSTEM_ADMIN`** (promote #131).
5. **No platform-operator 2FA in Production.** Accepted only while the owner is the sole operator.
6. **The AI calls itself a "wealth management platform"** (main and develop), and the `app/(public)` metadata on main says the same.
7. **No in-app support route.** Plaid errors say "Contact support." with no address.

**P2**
- Ordinary rate limits let traffic through when the store errors (Plaid link and exchange, reset, search, intake per-IP).
- No CoinGecko or Alchemy daily caps and no per-recipient email cap on main.
- 12 customer-facing routes on the RLS-bypassing client (SEC-003 ratchet).
- `/api/users/search` substring search (SEC-005).
- 150 s stale-session grace during a DB outage.
- Investments enable on main has no plan or lifecycle check.
- Privacy and terms legal gaps (cookies, state rights, governing law, named providers, product-usage disclosure).
- LOGIN_FAILED stores a raw identifier.
- support@ is both the sender and the inbound inbox.
- The risk badge isn't rendered on develop.

## Owner decisions

1. **Run the read-only SQL in §9** (Q1–Q4) in the Supabase SQL editor, or approve a fresh time-boxed read-only role. Until then, live Production DB facts are NOT YET VERIFIED.
2. **What to do with the 13-request cluster:** hold, deny, or verify manually. Recommendation: deny or hold. No invitations.
3. **Turnstile:** create the keys, and approve the fail-closed #160 follow-up and its Preview validation before setting the keys in Production.
4. **AI product description:** approve the replacement for "wealth management platform" (suggested: "a personal finance workspace; the decisions stay yours").
5. **Operators:** confirm the owner is the only platform operator for the beta. Otherwise operator 2FA must ship first.
6. **Analytics:** approve the 16-event taxonomy and the privacy-policy "Product usage" disclosure.
7. **Legal review** of the privacy and terms gaps (P2, can run in parallel).

## Recommended cohort and GO verdict (Session 2 areas)

**Verdict: CONDITIONAL GO for an invite-only cohort of 10 users the owner selects personally, scaling to 25.**

**GO for the first 10 users only if all of these hold:**
- Q2 shows `registration_mode` is `invite_only` or missing (which resolves to invite_only), not `open`;
- Q1 confirms no cluster request has been approved, invited or redeemed;
- invitations go only to people the owner knows or has verified, never from the public queue without manual review;
- the owner is the sole platform operator;
- the AI-description copy fix ships in the first release batch, or the owner explicitly accepts it for the first week.

**Scale to 25 after both:**
1. a release batch carrying the global Cost Freeze and the #131 kill-switch fix reaches main;
2. the in-app support link has shipped.

**Opening the public intake** (any non-curated approvals) is **NO-GO** until the fail-closed Turnstile follow-up of #160 is merged and promoted, and the keys are set and validated in Production.

---

## §9. Read-only SQL for the owner (Supabase SQL editor, Production)

Each query is a **single SELECT**. They return counts and catalog metadata only: no emails, notes, IPs or other customer content. Nothing is written. Run each one separately and paste the result into the report.

```sql
-- Q1: beta-request state (counts only). Compare with 10-31: 20 PENDING, 0 decided, 0 invited, 0 redeemed.
SELECT 'status:' || status::text AS item, count(*)::text AS value FROM "BetaAccessRequest" GROUP BY status
UNION ALL SELECT 'total', count(*)::text FROM "BetaAccessRequest"
UNION ALL SELECT 'decided', count(*)::text FROM "BetaAccessRequest" WHERE "decidedAt" IS NOT NULL
UNION ALL SELECT 'invited', count(*)::text FROM "BetaAccessRequest" WHERE "invitedAt" IS NOT NULL OR "inviteTokenHash" IS NOT NULL
UNION ALL SELECT 'redeemed', count(*)::text FROM "BetaAccessRequest" WHERE "redeemedAt" IS NOT NULL
UNION ALL SELECT 'created_since_2026-10-31T08Z', count(*)::text FROM "BetaAccessRequest" WHERE "createdAt" >= '2026-10-31T08:00:00Z'
UNION ALL SELECT 'decided_or_invited_among_created_2026-09-06..10-22', count(*)::text FROM "BetaAccessRequest"
  WHERE "createdAt" >= '2026-09-06' AND "createdAt" < '2026-10-23' AND ("decidedAt" IS NOT NULL OR "invitedAt" IS NOT NULL OR "redeemedAt" IS NOT NULL);
```

```sql
-- Q2: registration and security settings (keys and values are configuration, not customer data).
SELECT key, value, "updatedAt"::text FROM "PlatformSetting"
WHERE key IN ('registration_mode', 'require_totp_system_admin') OR key ILIKE '%ai%paused%' OR key ILIKE '%kill%'
ORDER BY key;
```

```sql
-- Q3: RLS, roles and grants as Production runs them (catalog only). Grants are read from pg_class.relacl,
-- NOT information_schema: information_schema.role_table_grants only shows grants the current role takes part in,
-- so under a restricted diagnostic role it would falsely return 0.
SELECT 'public_tables' AS item, count(*)::text AS value FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'
UNION ALL SELECT 'rls_enabled', count(*)::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
UNION ALL SELECT 'rls_forced', count(*)::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relforcerowsecurity
UNION ALL SELECT 'tables_without_rls', coalesce(string_agg(c.relname, ', ' ORDER BY c.relname), '(none)') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
UNION ALL SELECT 'policies', count(*)::text FROM pg_policies WHERE schemaname = 'public'
UNION ALL SELECT 'anon_authenticated_table_grants', count(*)::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v', 'm', 'p') AND a.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN ('anon', 'authenticated'))
UNION ALL SELECT 'schema_public_acl', nspacl::text FROM pg_namespace WHERE nspname = 'public'
UNION ALL SELECT 'role:' || rolname, concat_ws(' ', CASE WHEN rolsuper THEN 'SUPERUSER' END, CASE WHEN rolbypassrls THEN 'BYPASSRLS' END, CASE WHEN rolcanlogin THEN 'LOGIN' END)
  FROM pg_roles WHERE rolname !~ '^pg_' AND rolname NOT IN ('supabase_admin', 'supabase_auth_admin', 'supabase_storage_admin', 'supabase_realtime_admin', 'supabase_replication_admin', 'supabase_read_only_user', 'dashboard_user', 'pgbouncer', 'pgsodium_keyholder', 'pgsodium_keyiduser', 'pgsodium_keymaker')
UNION ALL SELECT 'migrations_applied', count(*)::text FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
UNION ALL SELECT 'latest_migration', max(migration_name) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL;
```

```sql
-- Q4 (Session 1, area 8): deletion and job liveness (counts and timestamps only).
SELECT 'overdue_purges' AS item, count(*)::text AS value FROM "User" WHERE "deletionScheduledAt" IS NOT NULL AND "deletionScheduledAt" < now()
UNION ALL SELECT 'scheduled_purges_total', count(*)::text FROM "User" WHERE "deletionScheduledAt" IS NOT NULL
UNION ALL SELECT 'job:' || "jobName" || ':last_succeeded', max("startedAt")::text FROM "JobRun"
  WHERE status = 'succeeded' AND "jobName" IN ('process-deletions', 'purge-trash', 'product-event-retention', 'sync-banks', 'sync-crypto', 'evaluate-alerts') GROUP BY "jobName"
UNION ALL SELECT 'job:' || "jobName" || ':failed_7d', count(*)::text FROM "JobRun"
  WHERE status = 'failed' AND "startedAt" > now() - interval '7 days' GROUP BY "jobName";
```

**Expected (healthy) answers:**
- Q1: no decided, invited or redeemed rows in the cluster window.
- Q2: `registration_mode` is `invite_only` or absent.
- Q3:
  - every `fm_*` app and auth role is non-superuser without BYPASSRLS (only the system and migration roles may hold BYPASSRLS, by design);
  - `tables_without_rls` matches the documented allow-list;
  - anon/authenticated grants are 0, or match the PostgREST lock-down;
  - the schema ACL contains `=U`;
  - the latest migration matches main's newest migration, with 135 applied (this closes Session 1's area 9 item 1c).
- Q4: `overdue_purges` is 0, and `process-deletions` and `purge-trash` each succeeded within the last ~25 h.
