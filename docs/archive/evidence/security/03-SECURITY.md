# 03 — Security

Pre-beta audit of Fourth Meridian · `v2.6` · HEAD `cde8fa0e25d2c744933109b41611d1dd65a1f9a8` · 2026-10-21 · read-only. Reference frameworks: OWASP ASVS 4.0, OWASP API Security Top 10 (2023). Finding IDs `SEC-nnn` (application security) and `SEC-AI-nnn` (AI security). The local Postgres was unreachable during the audit (Docker daemon down), so RLS coverage is derived from migration SQL and the live catalog is UNVERIFIED. Exploitability is only claimed where a call path was traced.

## 1. Verdict

The authorisation core is good for a pre-beta product: all 187 API handlers run one of six guards that deny a TOTP-pending session; the 45 object-level checks read by hand (every IDOR candidate the brief named) are correct; sessions are proved against a database row on every request; cookies are `__Host-`, HttpOnly, SameSite=Lax; raw SQL is 100% parameterised; Plaid webhook verification is textbook; Plaid tokens, TOTP secrets and dates of birth are AES-256-GCM with HKDF sub-keys; Sentry scrubs PII. The AI runtime's spending controls are fail-closed at HEAD (the reservation fix `89a46ad` and its fail-closed follow-up `e67fa58` are ancestors of HEAD, contrary to the audit brief's premise).

Four things keep it from being clean before external users: a logic hole that lets a password-only session bypass the forced-TOTP gate on every server-rendered page including `/admin` (SEC-001); a framework and auth library carrying published advisories with no dependency gate in CI (SEC-002); an OpenAI client on SDK defaults (10-minute timeout, two invisible retries) that undermines the "bounded spend" claim (SEC-AI-003); and raw Plaid transaction descriptors sent to OpenAI unscrubbed on the conversation path while the Brief path scrubs them (SEC-AI-005). No P0 was confirmed: no cross-tenant read, no authentication bypass that yields a session, no unbounded spend path, no secret disclosure.

Weighted security score: **6.6 / 10** (application security 6.9, AI security 7.0, pulled down by supply chain 4 and the SEC-001 session-management hole).

## 2. Authentication (as implemented)

| Component | Evidence | Status | Notes |
|---|---|---|---|
| Provider | `lib/auth.ts:143-543` Credentials only | IMPLEMENTED | identifier (email or username) + password + optional TOTP/recovery code |
| Login ordering | `lib/auth.ts:194-427` | IMPLEMENTED | per-identifier limiter (fail-closed on store outage) → CAPTCHA step-up after 3 attempts → `DISABLE_SYSTEM_ADMIN` → user lookup on `authDb` → bcrypt(12) → email-verified gate → pending-deletion/deactivation gates → forced-enrolment decision → second factor → session row + LOGIN audit in one transaction |
| Per-IP limiter | `app/api/auth/[...nextauth]/route.ts:31-34` | IMPLEMENTED | 20/15 min on `/callback/credentials`; keyed on `x-forwarded-for` (see ARCH-003) |
| Pre-login | `app/api/auth/pre-login/route.ts` | IMPLEMENTED | dummy-hash timing, 10/min/IP, reveals account state only after a correct password |
| CAPTCHA | `lib/captcha.ts` | IMPLEMENTED, env-gated | Turnstile; **no-op without `TURNSTILE_SECRET_KEY`** (absent on Production); fails open on Cloudflare outage |
| Password policy | `lib/platform-settings.ts:408-412` | IMPLEMENTED | min length ≥ 8; no breach-list check (ASVS 2.1.7 not met) |
| Session strategy | `lib/auth.ts:720-732`, `lib/auth/session-cookie.ts:36-81` | IMPLEMENTED | JWT, 30-day rolling; cookie `__Host-next-auth.session-token`, HttpOnly, Secure, Lax, no Domain; legacy cookies expired on sight |
| Session proof | `lib/auth.ts:569-688`, `lib/auth/session-proof.ts` | IMPLEMENTED | token must carry `id` + `sessionToken`; `UserSession` row must exist, be unrevoked and owned by that id; role and `requireTotpSetup` taken from the DB on the API path |
| Revocation cache | `lib/session-cache.ts:102-116` | IMPLEMENTED | 30 s fresh TTL + 120 s bounded-stale grace when the DB is down; indeterminate ⇒ 503 |
| Idle / absolute expiry | — | PARTIALLY IMPLEMENTED | no `expiresAt` on `UserSession`; only the rolling JWT (SEC-010) |
| Forced TOTP enrolment | `lib/session.ts:249-254` (API), `proxy.ts:171-189` (pages), `lib/settings/loaders.ts:60-67` | **PARTIALLY IMPLEMENTED** | API half sealed; page half trusts a client-updatable token flag (SEC-001) |
| TOTP | `lib/totp.ts`, `app/api/user/totp/*` | IMPLEMENTED | RFC 6238, ±1 window, encrypted secret, 5/15 min limits; no replay rejection (SEC-012) |
| Recovery codes | `lib/recovery-codes.ts` | IMPLEMENTED | 10 × 64-bit, bcrypt(10), single-use |
| Admin 2FA reset | `app/api/admin/security/users/[userId]/2fa-reset/route.ts` | IMPLEMENTED, weak | `adminTotpCode` accepted and never verified (SEC-006) |
| Registration | `app/api/auth/register/route.ts`, `lib/registration-policy.ts:122-136` | IMPLEMENTED | 5/15 min/IP; terms acceptance; modes open / invite_only / closed; **default `open`** (SEC-008) |
| Email verification, reset, email change | `lib/email/verification.ts`, `lib/password-reset-token.ts`, `app/api/user/email/*` | IMPLEMENTED | 256-bit random tokens, SHA-256 at rest, 1 h TTL, single-use, sessions revoked, non-enumerating |
| Open redirect | `lib/auth/return-to.ts`, `proxy.ts:140` | IMPLEMENTED | robust against `//`, `/\`, encoded variants; header always overwritten by the proxy |

## 3. Authorisation (as implemented)

Roles: `USER`, `SYSTEM_ADMIN`. Space roles OWNER > ADMIN > MEMBER > VIEWER with status ACTIVE/REMOVED/LEFT. Platform grants `PlatformGrant{userId, area, level}` with five areas and READ < WRITE < CONTROL (`lib/platform/policy.ts:261-265`, `@@unique([userId, area])`).

Guards (the only six used by routes): `requireUser` (`lib/session.ts:263-274`), `requireFreshUser` (`:289-317`), `requireSystemAdmin` (`:331-340`, no opt-out), `requireFreshSystemAdmin` (`:364-390`), `requireSpaceRole` (`:417-443`, membership inside `withTenantDb`), `requireSpaceAction` (`lib/spaces/authorize.ts:111-141`, closed `ACTION_POLICY` table), `requirePlatformAccess` / `requireFreshPlatformAccess` (`lib/platform/authorize.ts:116-138`, SYSTEM_ADMIN break-glass, grant lookup on the migration-principal `db`).

Escalation paths checked and closed: USER self-granting a platform grant (admin-only route, grants only target USER accounts); READ operator reaching CONTROL (every CONTROL mutation is `requireFreshPlatformAccess("PLATFORM_OPS","CONTROL")` with `validateSetting` on every write path); Space member → OWNER (no promotion to OWNER, no ownership transfer endpoint); admin PATCH of arbitrary `PlatformSetting` keys (closed: `ALLOWED_KEYS` + `validateSetting`, `app/api/admin/security/settings/route.ts:31,56-70`); impersonation (none exists). Note that WRITE-level operator powers are broad by design (deactivate users, revoke sessions, change entitlements, run any job); all are audited through `recordOperatorAction` with a parsed reason.

Server-rendered pages: `app/admin/*` and `app/(shell)/dashboard/*` layouts re-check `getServerSession` (so the middleware is not the only page gate) but not `session.requireTotpSetup` (SEC-001). `app/merchant-ops/page.tsx` is outside the proxy matcher and gates itself with `requirePlatformAccess` (correct). `app/prototype/*` is gitignored and untracked: never deployed.

The full 187-route authorisation matrix is in Appendix A.

## 4. Database security

- **Roles:** `fm_app`, `fm_auth`, `fm_system` are `LOGIN NOBYPASSRLS NOSUPERUSER`; `fm_backup` is `BYPASSRLS` and passwordless; the migration principal owns the tables and bypasses RLS (`lib/db/strict-mode.ts:124-127`).
- **Tenant identity:** `set_config('app.user_id', $1, true)` (transaction-local, bound parameter) inside `tenantDb.$transaction` with `idle_in_transaction_session_timeout=15s` (`lib/db/tenant-context.ts:133`). `current_fm_user_id()` is STABLE with a pinned `search_path`; the two `SECURITY DEFINER` helpers are minimal and revoked from PUBLIC.
- **Strict mode:** `FM_RLS_STRICT=true` (always on `VERCEL_ENV=production`) refuses boot when any role URL is missing or names the migration principal (`strict-mode.ts:207-259`). Without strict mode every role client silently falls back to `db` (`lib/db.ts:103-107`).
- **RLS coverage:** 62/70 models ENABLE + FORCE per migration SQL. The 8 without are reference data (`Instrument`, `InstrumentAlias`, `PriceObservation`, `CorporateActionTerms`, `FxRate`, `Merchant`, `MerchantAlias`) and `RateLimit`. Every `fm_system_all` policy is `USING (true)`: role-scoped, not row-scoped. fm_app predicates: `id = me` (User), `userId = me` (PlaidItem, Connection, CreditScore, Notification, NotificationPreference, RecoveryCode, UserSession, PlatformGrant), `spaceId IN fm_visible_space_ids()` (Space-scoped tables), `fm_account_visible(financialAccountId)` (account subtree). Live catalog: UNVERIFIED this pass.
- **Migration-principal residue (SEC-003):** 149 non-test files import the BYPASSRLS `db` client, including `lib/platform/authorize.ts:96`, `lib/space.ts`, `lib/rate-limit.ts`, `lib/platform-settings.ts`, `lib/sessions.ts`, all `app/api/admin/*`, most `app/api/platform/*`, all `lib/plaid/*`, `lib/crypto/*`, `jobs/*` and 18 customer-facing routes. On those paths application predicates are the only boundary.
- **Raw SQL:** every `$queryRaw`/`$executeRaw` is a tagged template or `Prisma.sql`; `$queryRawUnsafe` is used only on constant strings. No injection path found. No explicit isolation level anywhere (READ COMMITTED); concurrency-sensitive writes use optimistic `updatedAt` tokens, `updateMany` count assertions and one advisory lock (AI allowance).
- **At rest:** AES-256-GCM, 16-byte IV, 16-byte tag, HKDF-SHA256 sub-key per purpose, 32-byte root key validated at load (`lib/plaid/encryption.ts`); bcrypt(12) passwords, bcrypt(10) recovery codes, SHA-256 tokens. Single key, one Vercel record shared by Preview and Production, no rotation script (`docs/operations/key-rotation.md:54`).
- **In responses:** no route returns `passwordHash`, `totpSecret`, `encryptedToken`, `credential` or `sessionToken` (grep of every `select:` block plus the dynamic `admin-session-projection` test).

## 5. API and application security

| Control | Status | Evidence |
|---|---|---|
| Input validation | PARTIALLY IMPLEMENTED | hand-rolled `typeof` checks on every mutation read; no schema library; unbounded strings on Space name, section label/config; enum casts that 500 (`employmentStatus`); no file-size ceiling on import (SEC-007) |
| Mass assignment | not found | no handler spreads a request body into a Prisma write (route reads) |
| Rate limiting | IMPLEMENTED | Postgres-backed in production, in-memory otherwise (`lib/rate-limit.ts:80`); fixed calendar windows (2× burst at the boundary); fail-closed only on the auth path; `users/search` and most reads unthrottled |
| Error handling | PARTIALLY IMPLEMENTED | `withApiHandler` masks to "Internal server error"; raw `e.message` on `wealth/amend` and `merchant-ops/decide` (SEC-013) |
| Replay | N/A for sessions; webhook 5-minute `iat` window with idempotent resync | `lib/plaid/webhook-verify.ts` |
| Request size | PARTIALLY IMPLEMENTED | Vercel's 4.5 MB body cap only; XLSX inflation unbounded (SEC-007) |
| CORS | N/A | no `Access-Control-Allow-Origin` emitted; same-origin only |
| CSRF | IMPLEMENTED | `lib/security/write-origin.ts` exact Origin match incl. scheme and port, `Origin: null` refused, `Sec-Fetch-Site` fallback; no GET handler mutates state (scan of every GET body); NextAuth CSRF token on `/api/auth/*`; `__Host-` + Lax |
| SSRF | N/A | no server-side fetch of a user-controlled URL (grep of every `fetch(`) |
| Webhook verification | IMPLEMENTED | ES256 only, `kid` shape-checked, header ≤ 4 KB, 64-byte signature, `iat` ≤ 300 s, timing-safe body hash, per-kid positive/negative caches, key-fetch budget + DB-backed limiter (`ea48807` present); non-ACTIVE Items and deactivated owners refused; `PlaidItem.environment` not compared with the receiving environment (minor) |
| XSS | IMPLEMENTED | `components/ai/Markdown.tsx` closed component map: `img` ⇒ alt-text span (exfil sink closed, verified `:49`), `a` only for same-origin paths, no `rehype-raw`; `dangerouslySetInnerHTML` only on escaped seed text (`AdviceBanner.tsx:140-146`) and a constant script in `site/` |
| Deserialisation | IMPLEMENTED | `JSON.parse` of untrusted input only inside try/catch with shape checks; AI runtime-state cookie is AEAD-sealed and bound to user + Space + tail |
| Secrets in repo | IMPLEMENTED | no secret shapes in tracked files; `.gitignore` covers `.env*`, `backups/`, `tmp/`, `cloudflared/*.pem|json`, `app/prototype/`; one tracked local dev DB URL in `.claude/settings.local.json` (SEC-016) |
| Logging hygiene | IMPLEMENTED | Plaid errors through `redactedErrorForLog`; no console output of tokens/passwords; two audit paths write raw emails to metadata (PRIV-002) |
| Security headers | PARTIALLY IMPLEMENTED | HSTS (production, 180 d, no preload), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`; **CSP Report-Only** with `unsafe-inline`/`unsafe-eval` and no report endpoint; `site/` has no security headers (SEC-011) |
| Sentry | IMPLEMENTED | `sendDefaultPii: false`, `tracesSampleRate: 0`, `beforeSend` strips body/cookies/query and reduces `user` to `{id}`; breadcrumbs unscrubbed (PRIV-015) |
| Supply chain | PARTIALLY IMPLEMENTED | lockfile, `npm ci`, no install scripts, pinned Node; **no `npm audit` in CI**, no Dependabot; see SEC-002 |

## 6. AI security (conversation runtime, Daily Brief, cost controls)

Request path for `POST /api/ai/chat` (`app/api/ai/chat/route.ts`): `requireUser` → entitlement `refuseIfDisabled` → per-minute and per-hour `limitByUser` → kill switch `readPaidRequestsAdmission` (PlatformSetting `ai_paid_requests_paused`; absent ⇒ off, any value other than `"true"`/absent or a read error ⇒ **paused**; no cache) → allowance + reservation (`lib/platform/ai/allowance-reservation.ts:150`: one fm_system transaction taking `pg_advisory_xact_lock(hashtext('ai-allowance:'‖userId))` via `$executeRaw`, reading enforcement flag + today's spend + in-flight buckets, verdict `spent + inFlight × $0.315 ≥ allowance ⇒ refuse`; **transaction failure ⇒ 503 `RESERVATION_UNAVAILABLE` unless enforcement is the literal `"false"`**, `:191-211`) → body limits (≤ 80 turns, ≤ 8,000 chars per message, ≤ 160 KB transcript) → `resolveSpaceContext` with **403 on mismatch** → every tool call in its own tenant transaction bound to the session user → turn loop (≤ 6 model hops, ≤ 16 tool calls, 8,000 completion tokens) → guidance classifier (second structured call, 60 s abort) → `finally release()`.

Model-invoking entry points, all through the single SDK importer `lib/ai/provider.ts`:

| Entry point | Auth | Pacing | Kill switch | Allowance + reservation | Unpriced-model refusal | Fleet gate | Attribution |
|---|---|---|---|---|---|---|---|
| `POST /api/ai/chat` turn loop (≤ 6 calls) | ✔ | ✔ | ✔ route + per call | ✔ reserved, released in `finally` | ✔ | ✗ (alert only) | ✔ `chat` |
| guidance classifier (1 call per answered turn) | inherits | inherits | ✔ per call | counted next turn, **not reserved** | ✔ | ✗ | ✔ `chat:guidance` |
| `POST /api/brief/generate` (1 call) | ✔ | ✔ 20/min | ✔ | ✔ | ✔ pre-flight | ✗ | ✔ `brief` |
| `GET /api/brief` | ✔ | — | inspect-only, **no model call** (verified) | — | — | — | — |
| harness scripts (operator-run) | local env | ✗ | ✔ chokepoint | **✗ by design** | ✔ | ✗ | `harness` |
| cron / jobs | — | — | no job reaches the provider (grep) | — | — | — | — |

Tool authorisation: no tool schema accepts a `spaceId`, `userId` or `accountId`; scope is fixed server-side per call; transaction reads are filtered to FULL-visibility links (`lib/data/transactions.ts:79`); BALANCE_ONLY accounts get a generic name and no institution or mask (`lib/ai/assemblers/accounts.ts:779-804`); memory is `{spaceId, ownerUserId}`-scoped; the Brief is per-Space with 403 on mismatch (`lib/ai/brief/lifecycle.ts:194-196`) — the earlier "Brief aggregates all Spaces" defect is gone. The one write tool (`remember`) gates money/months/fraction/percent values to numbers the user typed (`lib/ai/conversation/memory-model.ts:748-860`); harness memory writes are off by default and clone-gated.

Output trust: `AiInvocation` stores only counts, codes and ids (no prompt, completion, tool args or results server-side); transcripts live in the browser (24 h) and an HttpOnly sealed cookie; Brief figures are licensed against the package (an unlicensed headline figure refuses the Brief).

## 7. Findings

Severity: P0 none confirmed · P1 should fix before beta · P2 schedule · P3 cleanup. "Blocker" = named as a GO condition in `12-BETA-RELEASE-PLAN.md`.

### Application security

| ID | Finding | Sev | Status | Preconditions | Evidence | Impact | Remediation | Blocker | Conf. |
|---|---|---|---|---|---|---|---|---|---|
| **SEC-001** | Forced-TOTP-enrolment gate bypass on every server-rendered page incl. `/admin`: NextAuth's `update` trigger lets the browser set `token.requireTotpSetup=false` (`lib/auth.ts:562-565`); `proxy.ts:175` trusts the flag; `app/admin/layout.tsx:22-35`, `app/admin/page.tsx:33-66`, `app/(shell)/dashboard/layout.tsx:31-32` never consult the DB-derived `session.requireTotpSetup` | P1 | PARTIALLY IMPLEMENTED | valid password for an account marked `requireTotpSetup` (a new or 2FA-reset SYSTEM_ADMIN; every USER if `require_totp_all_users` is enabled). Both Production admins are enrolled today ⇒ latent | traced: login → `useSession().update({requireTotpSetup:false})` → `jwt()` copies it → proxy passes → admin page renders `db.user.findMany` (all users' emails/roles/Spaces) and `/admin/providers` (Plaid Items) | password-only access to SSR'd admin inventory and the customer's own dashboard pages while policy says MFA is mandatory; API calls from those pages still 403 | drop the client-update branch (or re-derive from DB); add `if (session.requireTotpSetup) redirect(enrolmentPath)` to both layouts; test that a pending session cannot render `app/admin/page.tsx` | **Yes** | high |
| **SEC-002** | `next@16.2.7` (17 advisories, fixed ≤ 16.3.8, incl. 3 critical RCE) and `next-auth@4.24.14` (critical GHSA-7rqj-j65f-68wh) installed; no `npm audit` in CI; no Dependabot | P1 | — | per-advisory assessment: image-optimizer RCE/SSRF N/A as configured (no `images` block, static sources only); Server Actions N/A (none); rewrites N/A; `next/og` N/A; Windows N/A; next-auth email-normaliser and OAuth advisories N/A (Credentials only); `getToken` throw in `proxy.ts:120` fails closed (500); middleware-bypass advisory mitigated by layout-level `getServerSession` (residual: the write-origin CSRF boundary, still backed by `__Host-` + Lax) | coordinator `npm audit --omit=dev`: 14 (2 critical, 9 high, 3 moderate) | a beta on a framework with open RCE advisories is a policy exposure even where the configured surface is not reachable; the next `remotePatterns` or Server Action opens it | upgrade `next` ≥ 16.3.8 and `next-auth` to the fixed 4.24.x; add `npm audit --omit=dev --audit-level=high` to `ci.yml`; add Dependabot | **Yes** | medium (exploitability) / high (exposure) |
| **SEC-003** | RLS bypassed by design on ~149 runtime files importing the migration-principal `db` client (`lib/db.ts:30`) incl. the platform-grant authority lookup and the active-Space resolver | P2 | PARTIALLY IMPLEMENTED (ratcheted) | a missed application predicate on one of those paths | §4; `scripts/lib/db-authority-baseline.json` | single-layer isolation on those paths; a SQL-level compromise of the app has full data access regardless of RLS | continue the ratchet; make `db` throw in strict mode outside an allowlist | No (caps the tenant-isolation score) | high |
| **SEC-004** | CSV formula injection in export: `Papa.unparse(rows)` without `escapeFormulae` (`lib/export/csv.ts:28,85,112,132`); cells include Plaid descriptors and import-supplied names | P2 | vulnerable | a cell beginning with `=`, `+`, `-`, `@`; user opens the CSV in Excel/LibreOffice | CWE-1236 | client-side code execution prompts on the user's machine | `escapeFormulae: true` + a test | No | high |
| **SEC-005** | `GET /api/users/search` lets any authenticated user enumerate every registered user's real name/username by one-character substring, unthrottled, on the BYPASSRLS client (`app/api/users/search/route.ts:32-82`) | P2 | as designed | any beta account | 26 probes walk the directory | user-directory disclosure; account-existence oracle | exact `@username` or ≥ 3 chars of username only; per-user limit; restrict to shared-Space peers | No | high |
| **SEC-006** | Admin 2FA reset of another SYSTEM_ADMIN with no step-up: `adminTotpCode` accepted and never verified; target role unchecked (`app/api/admin/security/users/[userId]/2fa-reset/route.ts:40-53`) | P2 | PARTIALLY IMPLEMENTED | a second admin exists (Production has one) | combined with SEC-001 yields a password-only admin session | require the actor's live TOTP; refuse SYSTEM_ADMIN targets without a second approver; notify the target | No | high |
| **SEC-007** | No byte/row ceiling on CSV/XLSX import; exceljs zip-bomb exposure (`app/api/accounts/[id]/import/route.ts:184-194`; `lib/imports/excel.ts:44-47` defers it) | P2 | PLANNED | authenticated member with import rights | 4 MB XLSX can inflate to GBs | lambda OOM | reject `file.size > N MB`; cap rows; cap decompressed size | No | high |
| **SEC-008** | `registration_mode` defaults to `open` (`lib/platform-settings.ts:142`, fallback `:420-425`); CAPTCHA is a no-op on Production | P1 (config) | risky default | a fresh Production DB after cutover before the setting is written | public sign-up | default to `invite_only`; seed the setting in the cutover runbook; alert when absent | **Yes** (cutover act) | high |
| SEC-009 | `CRON_SECRET` compared with `!==` in six job routes | P3 | non-constant-time | — | CWE-208 | `crypto.timingSafeEqual` in one helper | No | high |
| SEC-010 | No idle or absolute session lifetime; 30-day rolling JWT; `UserSession` has no expiry column | P2 | PARTIALLY IMPLEMENTED | stolen cookie used at least every 30 days | ASVS 3.3.2 | enforce idle and absolute cut-offs inside `factsFromRow` | No | high |
| SEC-011 | CSP Report-Only with `unsafe-inline`/`unsafe-eval`, no report endpoint; HSTS without preload; `site/` has no security headers | P3 | staged rollout | — | `next.config.ts:44-67` | add reporting, nonce-based `script-src`, enforce; headers on `site/` | No | high |
| SEC-012 | TOTP code replay within the ±1 window; verify unthrottled for SYSTEM_ADMIN enrolment | P3 | — | sniffed code within 90 s | `lib/totp.ts:101-108` | store last-used step | No | high |
| SEC-013 | Raw `e.message` returned on `spaces/[id]/wealth/amend` (400) and `merchant-ops/decide` (409) | P3 | — | — | table/column names in Prisma errors | map known classes | No | high |
| SEC-014 | fm_app holds INSERT/UPDATE/DELETE on `PlatformGrant` (latent; no customer path writes it) | P3 | latent | a future tenant-transaction bug | migration `20261002000100…:326-343` | revoke writes, keep SELECT | No | high |
| SEC-015 | `RateLimit` readable fleet-wide by fm_app; keys embed IPs and user ids | P3 | info | — | — | — | No | high |
| SEC-016 | Local dev DB URL tracked in `.claude/settings.local.json` | P3 | info | — | — | untrack | No | high |
| SEC-017 | Space-existence oracle (403 vs 404) and public-Space roster on `GET /api/spaces/[id]` | P3 | by design | — | `app/api/spaces/[id]/route.ts:56-103` | note only | No | high |
| **SEC-018** | Repository is PUBLIC (`gh repo view` → `visibility: PUBLIC`; README: "published publicly for reference and portfolio purposes"); public docs carry the Production Supabase project ref, deployment ids, environment-variable inventory, user and Plaid Item counts, and the full cutover runbook (14 references in `docs/`) | P1 (owner decision) | deliberate | — | `docs/operations/production-cutover-plan.md` §1 | no secret is exposed, but the operational attack surface (project identifiers, env names, runbooks, defect registers incl. this audit) is public for a product about to hold consumer financial data | decide explicitly: make private, or scrub operational docs and move them out of the public tree before beta | **Yes** (decision) | high |

### AI security

| ID | Finding | Sev | Status | Evidence | Impact | Remediation | Blocker | Conf. |
|---|---|---|---|---|---|---|---|---|
| **SEC-AI-003** | OpenAI client built on SDK defaults: 10-minute timeout, 2 silent retries (`lib/ai/provider.ts:56-61`; `openai/client.js:163,173`) against route `maxDuration=300`; retried HTTP attempts write no `AiInvocation` row; the app's own 429 retry (≤ 5) multiplies on top | P1 | IMPLEMENTED (defaults) | only the structured path has a 60 s abort | billed attempts the allowance never sees; a hop can hold a lambda until Vercel kills it, so the reservation `finally` may not run (over-reserves ≤ 2 h); user gets a gateway error | `new OpenAI({ timeout: ~90_000, maxRetries: 0 })`; pass an `AbortSignal` per hop from the route budget | **Yes** | high |
| **SEC-AI-005** | Conversations send raw transaction `description` and merchant strings to OpenAI with no digit scrubbing (`lib/ai/conversation/tools.ts:829-831`); the Brief scrubs 4+-digit runs for exactly this reason (`lib/ai/brief/recent-activity.ts:70-77`) | P1 | PARTIALLY IMPLEMENTED | — | partial card numbers, cheque and reference ids go to a third-party processor with unverified retention; legal page lists only "merchant, amount, date and category" | apply the Brief's scrub to every tool row; drop `description` unless asked; align `content/marketing/legal-ai.md:27` | **Yes** | high |
| SEC-AI-001 | No fleet-wide spend gate; the "fleet ceiling" is an alert evaluated by a cron that never runs on Preview | P2 | alert only | `lib/platform/ai/spend-thresholds.ts`, `ai-budget.ts:111-162` | fleet spend = Σ per-user allowances (+ overshoot) per UTC day; only hard stop is the OpenAI project limit (owner-stated, not in repo) | fleet reservation counter + daily ceiling judged in the same transaction; confirm the OpenAI project spend limit per environment | No | high |
| SEC-AI-002 | Reservation overshoot ≈ 3× the $0.315 reserve on a worst-case 6-hop turn with a 160 KB history; the guidance call is unreserved | P2 | PARTIALLY IMPLEMENTED | `lib/ai/allowance-core.ts:140-165`; `request.ts`; `provider.ts:416` | a fresh $5 day can realise ~$15 before the ledger catches up (bounded) | size the reserve from transcript bytes × hops; reserve the guidance call | No | high |
| SEC-AI-004 | Pacing limiter fails open on store error while the allowance fails closed (`lib/rate-limit.ts:141-148`) | P3 | by design | — | asymmetry | fail-closed for `ai-chat-hour` | No | high |
| SEC-AI-006 | Indirect prompt injection can still steer text-only memory fields (`subject`, `statedAs`, labels, dates, `retire`/`amend`) and scenario state; money-like figures are gated | P2 | PARTIALLY IMPLEMENTED | `memory-tools.ts:299-423`, `memory-model.ts:837-860`; hardening harness exists but its results at HEAD are not in the repo | integrity of the user's own memory panel (visible, reversible) | require `statedAs`/subject to appear in the user's own turn; wrap free-text row fields as typed data leaves | No | medium |
| SEC-AI-007 | Client-authored `assistant` history is replayed to the model as prior answers (`engine.ts:217-224`) | P3 | by design | self-inflicted only; bounded by caps and allowance | bind the replayed tail to the sealed cookie digest | No | medium |
| SEC-AI-008 | Guidance classifier is a second paid call per turn, neither reserved nor paced separately | P3 | — | `engine.ts:352-380` | fold into SEC-AI-002 | No | high |
| SEC-AI-009 | Harness paths bypass the allowance by design and can hit the live key; mitigated by `OPENAI_EXPECTED_ENVIRONMENT` and clone-gated memory writes | P3 | — | operator discipline | — | No | high |
| SEC-AI-010 | Output sink sound (images dropped, external links dropped, no raw HTML); CSP report-only means the renderer is the only boundary | P3 (positive) | IMPLEMENTED | `components/ai/Markdown.tsx:49-71` | — | enforce CSP | No | high |
| SEC-AI-011 | STATUS.md does not record `89a46ad`/`e67fa58`/`cde8fa0` and still presents the 2026-10-15 "Preview-verified" allowance wording that the 2026-10-16 report says exercised the fallback path | P3 (process) | — | `STATUS.md` last changed `595886e` | the single authority is five integration commits behind HEAD | update STATUS per the owner's maintenance rule | No | high |

Verified clean (no finding): IDOR on every route the brief named (45 read in full); CSRF boundary complete; no SSRF; raw SQL parameterised; webhook verification; Markdown sink; deserialisation; secrets in repo; Sentry request scrubbing; prototype containment; kill switch fail-closed with no cache; cross-customer AI leakage (no traced path); admin PATCH of arbitrary settings (closed).

## 8. Scores

Scale: 1-2 critical · 3-4 major weaknesses · 5-6 functional with significant gaps · 7 generally sound · 8 strong · 9 very strong, verified · 10 exceptional.

| Sub-area | Score | Weight | Evidence | Strengths | Weaknesses | Conf. | Beta impact | Improvement |
|---|---|---|---|---|---|---|---|---|
| Session management | 6 | 5 | §2 | row-proved sessions, revoke-all on password/email change, 503 on infra failure | client-updatable `requireTotpSetup` (SEC-001); no idle/absolute cap; 150 s stale acceptance under DB outage | high | SEC-001 blocks | SEC-001, SEC-010 |
| Cookie security | 9 | 3 | `lib/auth/session-cookie.ts` | `__Host-`, HttpOnly, Secure, Lax, legacy expiry | active-Space cookie non-HttpOnly (non-authority) | high | none | — |
| Token handling | 8 | 3 | §2 | 256-bit random, hashed, TTL 1 h, single-use | reset URL echoed in non-prod when mail unsent | high | none | — |
| Account recovery | 8 | 3 | §2 | non-enumerating, rate-limited, alerts, revocation | no lockout; admin 2FA reset lacks step-up | high | low | SEC-006 |
| Login abuse protection | 6 | 4 | §2 | identifier limiter fails closed; dummy-hash timing | CAPTCHA no-op on Production; XFF keying (ARCH-003); fixed windows; no lockout | medium | config act | Turnstile keys; one IP extractor |
| RBAC | 8 | 4 | §3 | closed action tables, pure decision functions, no opt-out on the admin guard | WRITE operator powers broad; break-glass on all areas | high | none | document scope |
| Object-level authorisation | 8 | 5 | Appendix A | consistent owner/link/role checks; fresh re-auth on destructive paths | user enumeration (SEC-005); 106 routes verified at guard level only | high / medium | low | SEC-005; finish object-level read |
| Tenant isolation | 7 | 5 | §3-4 | two layers on tenant-transaction paths | single layer on ~149 `db` files | high | none | retire `db` |
| RLS | 7 | 4 | §4 | 62/70 ENABLE+FORCE, transaction-local identity, strict-mode boot refusal, acceptance suites in CI | `fm_system_all = USING(true)`; fm_app writes on PlatformGrant; Production has no roles yet; live catalog unverified | high (SQL) / UNVERIFIED (live) | cutover | SEC-014; catalog check post-cutover |
| Raw SQL / injection | 9 | 4 | §4 | 100% parameterised | — | high | none | — |
| Input validation | 6 | 3 | §5 | present on every mutation read | no schema library; unbounded strings; file size | high | low | validation helper; caps |
| Rate limiting | 6 | 3 | §5 | DB-backed in prod; fail-closed on auth; entitlement-driven AI limits | fail-open elsewhere; fixed windows; reads unthrottled | high | low | SEC-005; sliding window |
| CSRF | 8 | 3 | §5 | Origin/Sec-Fetch-Site boundary, no mutating GETs | depends on middleware executing (SEC-002) | high | none | upgrade next |
| SSRF | 9 | 1 | §5 | none | — | high | none | — |
| Webhook verification | 9 | 3 | §5 | see table | env not cross-checked | high | none | compare environment |
| XSS | 8 | 3 | §5 | closed component map; image sink removed | CSP not enforced | high | none | enforce CSP |
| Secrets handling | 7 | 3 | §4-5 | AES-GCM + HKDF; boot validation; no committed secrets | single shared key record; no rotation script; tracked dev URL | high | none | rotation script |
| Logging hygiene | 8 | 2 | §5 | redaction helpers; hashed emails in most audits | emails in two audit paths; verbose timing logs | high | none | hash consistently |
| Security headers / CSP | 5 | 2 | §5 | HSTS, XFO, nosniff, Referrer-Policy | CSP report-only with unsafe-*; site has none | high | none | SEC-011 |
| Supply chain | 4 | 4 | SEC-002 | lockfile, `npm ci`, no install scripts | 2 critical / 9 high advisories; no audit in CI; no Dependabot | medium | blocks | SEC-002 |
| AI: prompt injection | 7 | 3 | §6 | containment by scope, sinks and gated writes | raw descriptors; text-only memory fields injectable | high | low | SEC-AI-005/006 |
| AI: tool authorisation | 8 | 4 | §6 | scope fixed server-side; 403 on mismatch; visibility tiers honoured | ad-hoc per-tool arg validation | high | low | uniform schema validation |
| AI: cross-customer leakage | 8 | 5 | §6 | no traced path; Brief per-Space | transcript persists 24 h in localStorage without sign-out | high | low | — |
| AI: provider data exposure | 5 | 4 | §6, `11-PRIVACY-COMPLIANCE.md` | allowlisted ledger; no prompts stored; env-separated projects | raw descriptors, masks, institution, names; no ZDR; legal text understates | high | medium | SEC-AI-005 |
| AI: output trust boundary | 8 | 2 | §6 | images/external links dropped; Brief numbers licensed | CSP report-only; chat numbers rely on prompt + provenance | high | low | enforce CSP |
| AI: tool-call validation | 7 | 2 | §6 | unknown tool/budget refusals | `JSON.parse` + per-tool coercion | medium | low | central validator |
| AI: spending abuse | 7 | 4 | §6 | hop/tool/token caps; pacing; reservation; kill switch | overshoot ≈ 3×; guidance unreserved; no fleet gate | high | medium | SEC-AI-001/002 |
| AI: allowance bypass | 8 | 4 | §6 table | both product routes gated; no cron model path | harness bypass by design | high | low | — |
| AI: reservation races | 7 | 3 | §6 | advisory lock + in-flight counter; CI acceptance 15/15 | lost release over-reserves ≤ 2 h; lambda kill at 300 s | high | low | SEC-AI-003 |
| AI: fail-open vs fail-closed | 8 | 4 | §6 | reservation, kill switch, unpriced model all fail closed | enforcement `"false"` reverts to a stale-sum check; pacing fails open | high | low | SEC-AI-004 |
| AI: emergency pause | 9 | 3 | §6 | immediate, mid-turn, no cache, CONTROL-gated with reason | — | high | low | — |
| AI: provider timeout / retry | 4 | 3 | SEC-AI-003 | structured path aborts at 60 s; quota never retried | chat hops: 10-minute timeout, 2 hidden retries | high | medium | SEC-AI-003 |

Weighted mean: **6.6 / 10**. Confidence: high on the paths read; medium on the 106 routes verified only at guard level; UNVERIFIED on the live RLS catalog.

## 9. Contradictions with documentation

| Claim | Reality | Disposition |
|---|---|---|
| `lib/auth.ts:11-15`: "no password-only path to admin power" | true for `/api/*`, false for server-rendered `/admin` pages (SEC-001) | CONTRADICTION |
| `docs/operations/security-checklist.md`: TOTP setup/disable unthrottled; CSRF/Origin "Needs work" | both now limited (5/15 min); write-origin boundary implemented | STALE (behind code) |
| `docs/operations/security-checklist.md`: "IDOR review — Complete (spot-checked)" | 45 routes verified here; 106 guard-level only | partially corroborated |
| STATUS §12: migration-principal residue "enumerated and ratcheted" | accurate; the residue is ~149 files, i.e. most data access | corroborated, scale understated |
| Audit brief: `89a46ad` not in `v2.6` | it is an ancestor of HEAD | CONTRADICTION (brief stale) |
| `lib/db.ts` comment: fm_system reaches rows "through role-scoped policies, not BYPASSRLS" | literally true; every such policy is `USING(true)` | clarify |

Open questions for the owner: does Vercel overwrite or append `x-forwarded-for` (decides ARCH-003 exploitability)? Is `require_totp_all_users` planned on for beta (widens SEC-001 to every customer)? Which Next build mode runs on Vercel (Turbopack vs webpack, for GHSA-6gpp applicability)? Who owns the `next` upgrade and the CI audit gate before cutover?

## Appendix A — Route authorisation matrix (187 routes)

Columns: route · methods · guard · object-level check · input validation · rate limit · reachable with a pending (TOTP-incomplete) session · DB client · notes. "Verified" = handler read in full; "guard" = guard line verified by inspection only.



Generated by `scratchpad/ws2/matrix.py` (regex extraction of guards, DB clients and limiter calls per file) and hand-annotated for the 81 routes I read in full; the remaining 106 rows carry "(not individually read)" in the object-level column — their gate column is still exact. "DB authority" lists which Prisma client the file touches; `` `db` `` = migration principal (BYPASSRLS).

| Route | Methods | Auth gate (lib/session / lib/platform/authorize / lib/spaces/authorize) | DB authority | Object-level check | Input validation | Rate limit | Pending (TOTP-incomplete) session reaches handler? |
|---|---|---|---|---|---|---|---|
| `/api/access-request` | POST | PUBLIC | `db` (migration principal, BYPASSRLS) | public | email regex, note ≤1000 | Ip access-request 5/900s | n/a |
| `/api/accounts/[id]/debt-profile` | PATCH | user | tenant tx (fm_app) | `fa.ownerUserId === user.id` | numeric ranges, days 1-31, date parse | — | no (guard denies) |
| `/api/accounts/[id]/import/investments/preview` | POST | user (fresh) | tenant tx (fm_app) | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/accounts/[id]/import/investments` | POST | user (fresh) | tenant tx (fm_app) | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/accounts/[id]/import/preview` | POST | user | tenant tx (fm_app) | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/accounts/[id]/import` | POST | user | tenant tx (fm_app) | resolveImportableFinancialAccount (link ACTIVE in active Space + owner/creator or FULL+ADMIN) | multipart; columnMapping JSON shape; NO file size cap (see SEC-010) | — | no (guard denies) |
| `/api/accounts/[id]/restore` | POST | user | tenant tx (fm_app); systemDb | `fa.ownerUserId === user.id` (grep-verified) | — | — | no (guard denies) |
| `/api/accounts/[id]` | DELETE,PATCH | user | tenant tx (fm_app) | PATCH `fa.ownerUserId === user.id`; DELETE requires caller's own ACTIVE SpaceAccountLink (adder) | numeric ranges, displayName ≤120 | — | no (guard denies) |
| `/api/accounts/[id]/sync` | POST | user | tenant tx (fm_app) | `account.ownerUserId === user.id` | chain enum | User wallet-resync walletsPerHour/3600s | no (guard denies) |
| `/api/accounts/[id]/transactions` | GET | user | tenant tx (fm_app) | active Space (cookie) link ACTIVE + visibility FULL | parseTransactionQueryParams | — | no (guard denies) |
| `/api/accounts/manual/[id]/permanent` | DELETE | user (fresh); user | tenant tx (fm_app) | `fa.ownerUserId === userId`, archived first | — | — | no (guard denies) |
| `/api/accounts/manual/[id]/restore` | POST | user | tenant tx (fm_app) | `fa.ownerUserId === userId` (grep-verified) | — | — | no (guard denies) |
| `/api/accounts/manual/[id]` | DELETE,PATCH | user | tenant tx (fm_app) | `fa.ownerUserId === userId`, syncStatus manual, type other | balance ≥0 number; effectiveDate checked | — | no (guard denies) |
| `/api/accounts/manual/[id]/valuations` | GET | user | tenant tx (fm_app) | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/accounts/manual` | POST | user | tenant tx (fm_app) | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/accounts` | GET | user | tenant tx (fm_app) | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/accounts/wallet` | POST | user | tenant tx (fm_app) | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/admin/audit` | GET | SYSTEM_ADMIN | `db` (migration principal, BYPASSRLS) | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/admin/plaid/diagnostics` | POST | SYSTEM_ADMIN | `db` (migration principal, BYPASSRLS) | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/admin/plaid/exchange-expanded-history-token` | POST | SYSTEM_ADMIN (fresh) | `db` (migration principal, BYPASSRLS) | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/admin/plaid/expand-history-token` | POST | SYSTEM_ADMIN | `db` (migration principal, BYPASSRLS) | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/admin/plaid/retire-superseded-item` | POST | SYSTEM_ADMIN (fresh) | `db` (migration principal, BYPASSRLS) | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/admin/platform-grants/[grantId]` | PATCH | SYSTEM_ADMIN (fresh) | `db` (migration principal, BYPASSRLS) | any grant | action=revoke | User platform-grant 20/60s | no (guard denies) |
| `/api/admin/platform-grants` | GET,POST | SYSTEM_ADMIN (fresh); SYSTEM_ADMIN | `db` (migration principal, BYPASSRLS) | POST: target must be USER role; issuable level | area/level enums | User platform-grant 20/60s | no (guard denies) |
| `/api/admin/security/admin-status` | GET | SYSTEM_ADMIN | `db` (migration principal, BYPASSRLS); systemDb | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/admin/security/settings` | GET,PATCH | SYSTEM_ADMIN (fresh); SYSTEM_ADMIN | `db` (migration principal, BYPASSRLS) | ALLOWED_KEYS = ADMIN_SECURITY surface + validateSetting (arbitrary-key hole CLOSED — verified) | per-descriptor validation | — | no (guard denies) |
| `/api/admin/security/users/[userId]/2fa-reset` | POST | SYSTEM_ADMIN (fresh) | `db` (migration principal, BYPASSRLS) | any user incl. other SYSTEM_ADMINs; self refused; `adminTotpCode` in body type but NEVER verified (no step-up) | confirmToken === RESET | — | no (guard denies) |
| `/api/admin/security/users/[userId]/recovery-codes` | POST | SYSTEM_ADMIN (fresh) | `db` (migration principal, BYPASSRLS); systemDb | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/admin/security/users/[userId]/sessions` | DELETE,GET | SYSTEM_ADMIN (fresh); SYSTEM_ADMIN | `db` (migration principal, BYPASSRLS) | any user (admin) | — | — | no (guard denies) |
| `/api/admin/security/users` | GET | SYSTEM_ADMIN | `db` (migration principal, BYPASSRLS) | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/admin/spaces` | GET | SYSTEM_ADMIN | `db` (migration principal, BYPASSRLS) | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/admin/users` | GET | SYSTEM_ADMIN | `db` (migration principal, BYPASSRLS) | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/ai/chat` | POST | user | `db` (migration principal, BYPASSRLS) | resolveSpaceContext equality; entitlements + daily allowance | readChatRequest caps (80 turns, 8k chars, 160k transcript) | user ai-chat (entitlement) | no (guard denies) |
| `/api/ai/memory/[id]` | DELETE,PATCH | user (memoryApiDeps.requireUser, app/api/ai/memory/deps.ts:43) | none/lib | resolveSpaceContext(user, spaceId) must equal requested; scope ownerUserId=user | action=retire | user ai-memory 30/60s (deps.ts:45) | no (guard denies) |
| `/api/ai/memory` | GET | user (memoryApiDeps.requireUser, deps.ts:43) | none/lib | same | spaceId required | user ai-memory 30/60s (deps.ts:45) | no (guard denies) |
| `/api/auth/[...nextauth]` |  | NextAuth handler | none/lib | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | Ip login-callback 20/900s | n/a |
| `/api/auth/forgot-password` | POST | PUBLIC | `db` (migration principal, BYPASSRLS) | public; non-enumerating response | identifier required | Ip forgot-password 5/900s | n/a |
| `/api/auth/pre-login` | POST | PUBLIC | `db` (migration principal, BYPASSRLS) | public; dummy-hash timing; reveals account state only after correct password | — | Ip pre-login 10/60s | n/a |
| `/api/auth/register` | POST | PUBLIC | `db` (migration principal, BYPASSRLS) | public | email/username regex, min pw len, invite email-bound; employmentStatus/useCase cast unvalidated (enum error → 500); dateOfBirth unvalidated | Ip register 5/900s | n/a |
| `/api/auth/reset-password` | POST | PUBLIC | `db` (migration principal, BYPASSRLS) | token hash lookup + expiry; single-use; all sessions revoked | min pw len | Ip reset-password 10/900s | n/a |
| `/api/auth/verify-email/resend` | POST | PUBLIC | `db` (migration principal, BYPASSRLS) | identifier or token; non-enumerating | — | Ip verify-email-resend 5/900s | n/a |
| `/api/auth/verify-email` | POST | PUBLIC | `db` (migration principal, BYPASSRLS) | token hash lookup + expiry | token string | Ip verify-email 10/900s | n/a |
| `/api/brief/generate` | POST | user | none/lib | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | user ai-brief-generate 20/60s | no (guard denies) |
| `/api/brief` | GET | user | tenant tx (fm_app) | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/connections/[id]/disconnect` | POST | user | tenant tx (fm_app) | links via plaidItem.userId / connection.userId = user.id | — | — | no (guard denies) |
| `/api/connections/[id]/import-accounts` | GET | user (fresh) | tenant tx (fm_app) | getImportableAccountsForConnection(userId) | — | — | no (guard denies) |
| `/api/connections/[id]/import-history` | GET | user (fresh) | tenant tx (fm_app) | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/connections/build-intelligence` | POST | user | tenant tx (fm_app) | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | User connection-rebuild 10/3600s | no (guard denies) |
| `/api/credit/update-fico` | PATCH | user | tenant tx (fm_app) | userId from getSpaceContext (session) | score 300-850; `source` unvalidated string | — | no (guard denies) |
| `/api/health` | GET | PUBLIC | `db` (migration principal, BYPASSRLS) | public; `db.$queryRaw SELECT 1`; exposes commit SHA; rate-limited | — | Ip health 30/60s | n/a |
| `/api/imports/[id]/rollback` | POST | user (fresh) | tenant tx (fm_app) | batch via tenant tx; resolveImportableFinancialAccount; creator or canManage | — | — | no (guard denies) |
| `/api/investments/opening-position` | POST | user (fresh) | tenant tx (fm_app) | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/jobs/dispatch` | GET | CRON_SECRET bearer | none/lib | CRON_SECRET bearer; `!==` comparison (not constant-time) | — | — | n/a |
| `/api/jobs/fetch-fx-rates` | GET | CRON_SECRET bearer | none/lib | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | n/a |
| `/api/jobs/fetch-security-prices` | GET | CRON_SECRET bearer | none/lib | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | n/a |
| `/api/jobs/process-deletions` | GET | CRON_SECRET bearer | none/lib | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | n/a |
| `/api/jobs/resume-stale-imports` | GET | CRON_SECRET bearer | none/lib | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | n/a |
| `/api/jobs/sync-banks` | GET | CRON_SECRET bearer | none/lib | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | n/a |
| `/api/merchant-ops/decide` | POST | platform MERCHANT_OPS:WRITE (fresh) | systemDb | MERCHANT_OPS WRITE; systemDb | verdict enum; keys strings; raw e.message returned (409) | — | no (guard denies) |
| `/api/money/view-context` | GET | user | tenant tx (fm_app) | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/notifications/[id]/read` | POST | user | none/lib | updateMany scoped userId | — | — | no (guard denies) |
| `/api/notifications/read-all` | POST | user | none/lib | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/notifications` | GET | user | none/lib | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/notifications/unread-count` | GET | user | none/lib | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/plaid/exchange-token` | POST | user | none/lib | userId/spaceId from session + cookie | required fields presence only | User plaid-exchange-token 10/900s | no (guard denies) |
| `/api/plaid/investments/enable` | POST | user | tenant tx (fm_app) | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | User plaid-investments-enable 10/900s | no (guard denies) |
| `/api/plaid/link-token` | GET | user | tenant tx (fm_app) | plaidItem/connection scoped userId | query params | User plaid-link-token 10/900s | no (guard denies) |
| `/api/plaid/refresh` | POST | user | tenant tx (fm_app) | plaidItem {id, userId} | — | User plaid-refresh 20/3600s | no (guard denies) |
| `/api/plaid/resume-sync` | POST | user | tenant tx (fm_app) | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | User plaid-resume-sync 60/3600s | no (guard denies) |
| `/api/plaid/sync` | POST | user | tenant tx (fm_app) | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | User plaid-sync 20/3600s | no (guard denies) |
| `/api/plaid/webhook` | POST | Plaid JWT signature | `db` (migration principal, BYPASSRLS) | ES256 JWT, kid cache, body sha256 (timing-safe), iat ≤300s; item looked up via `db` | body fields truncated | — | n/a |
| `/api/platform/customer-success/connection-owners` | GET | platform CUSTOMER_SUCCESS:READ | none/lib | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/platform/customer-success/customers/[userId]/cohort` | POST | platform CUSTOMER_SUCCESS:WRITE (fresh) | none/lib | any userId (operator scope by design) | cohort string; reason parsed | — | no (guard denies) |
| `/api/platform/customer-success/customers/[userId]/policy` | POST | platform CUSTOMER_SUCCESS:WRITE (fresh) | none/lib | any userId (operator); changes entitlements/AI allowance at WRITE level | typed; reason parsed | — | no (guard denies) |
| `/api/platform/customer-success/customers/[userId]/refresh` | POST | platform CUSTOMER_SUCCESS:WRITE (fresh) | systemDb | any userId; refuses deactivated | — | — | no (guard denies) |
| `/api/platform/customer-success/customers/[userId]` | GET | platform CUSTOMER_SUCCESS:READ | none/lib | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/platform/customer-success/customers` | GET | platform CUSTOMER_SUCCESS:READ | none/lib | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/platform/customer-success/sync-issues` | GET | platform CUSTOMER_SUCCESS:READ | none/lib | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/platform/growth-revenue/activity` | GET | platform GROWTH_REVENUE:READ | none/lib | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/platform/growth-revenue/beta-status` | GET | platform GROWTH_REVENUE:READ | none/lib | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/platform/growth-revenue/growth` | GET | platform GROWTH_REVENUE:READ | none/lib | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/platform/growth-revenue/invitations` | POST | platform GROWTH_REVENUE:WRITE (fresh) | `db` (migration principal, BYPASSRLS) | — | email regex; expiresDays clamped | — | no (guard denies) |
| `/api/platform/growth-revenue/policy-groups` | GET | platform GROWTH_REVENUE:READ | systemDb | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/platform/growth-revenue/product-analytics` | GET | platform GROWTH_REVENUE:READ | none/lib | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/platform/growth-revenue/product-status` | PUT | platform GROWTH_REVENUE:WRITE (fresh) | `db` (migration principal, BYPASSRLS) | — | status enum | — | no (guard denies) |
| `/api/platform/growth-revenue/registration-mode` | PUT | platform GROWTH_REVENUE:WRITE (fresh) | `db` (migration principal, BYPASSRLS) | — | mode enum via validateSetting | — | no (guard denies) |
| `/api/platform/growth-revenue/requests/[id]/approve` | POST | platform GROWTH_REVENUE:WRITE (fresh) | `db` (migration principal, BYPASSRLS) | any request id | — | — | no (guard denies) |
| `/api/platform/growth-revenue/requests/[id]/deny` | POST | platform GROWTH_REVENUE:WRITE (fresh) | `db` (migration principal, BYPASSRLS) | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/platform/growth-revenue/requests/[id]/resend` | POST | platform GROWTH_REVENUE:WRITE (fresh) | `db` (migration principal, BYPASSRLS) | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/platform/growth-revenue/requests/[id]/revoke` | POST | platform GROWTH_REVENUE:WRITE (fresh) | `db` (migration principal, BYPASSRLS) | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/platform/growth-revenue/requests` | GET | platform GROWTH_REVENUE:READ | `db` (migration principal, BYPASSRLS) | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/platform/growth-revenue/signups` | GET | platform GROWTH_REVENUE:READ | `db` (migration principal, BYPASSRLS) | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/platform/growth-revenue/users/[userId]` | POST | platform GROWTH_REVENUE:WRITE (fresh) | `db` (migration principal, BYPASSRLS) | any USER; not SYSTEM_ADMIN; not self; deactivate + revoke all sessions at GROWTH WRITE | action enum; reason parsed | — | no (guard denies) |
| `/api/platform/growth-revenue/users` | GET | platform GROWTH_REVENUE:READ | `db` (migration principal, BYPASSRLS) | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/platform/platform-ops/activity` | GET | platform PLATFORM_OPS:READ | none/lib | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/platform/platform-ops/ai-budget` | GET | platform PLATFORM_OPS:READ | none/lib | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/platform/platform-ops/ai-cost-controls` | GET,PATCH | platform PLATFORM_OPS:READ; platform PLATFORM_OPS:CONTROL (fresh) | none/lib | CONTROL | changes array validated in lib | User platform-policy 30/60s | no (guard denies) |
| `/api/platform/platform-ops/ai-invocations` | GET | platform PLATFORM_OPS:READ | none/lib | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/platform/platform-ops/ai-spend` | GET | platform PLATFORM_OPS:READ | none/lib | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/platform/platform-ops/ai-usage-trend` | GET | platform PLATFORM_OPS:READ | none/lib | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/platform/platform-ops/alerts` | GET | platform PLATFORM_OPS:READ | none/lib | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/platform/platform-ops/api-usage` | GET | platform PLATFORM_OPS:READ | `db` (migration principal, BYPASSRLS) | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/platform/platform-ops/attention` | GET | platform PLATFORM_OPS:READ | none/lib | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/platform/platform-ops/brief-ops` | GET | platform PLATFORM_OPS:READ | none/lib | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/platform/platform-ops/connection-diagnostics` | GET | platform PLATFORM_OPS:READ | none/lib | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/platform/platform-ops/connection-health` | GET | platform PLATFORM_OPS:READ | none/lib | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/platform/platform-ops/connections/[id]/request-reauth` | POST | platform PLATFORM_OPS:WRITE (fresh) | `db` (migration principal, BYPASSRLS) | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/platform/platform-ops/connections/[id]/resync` | POST | platform PLATFORM_OPS:WRITE (fresh) | `db` (migration principal, BYPASSRLS) | any PlaidItem id (operator) | — | — | no (guard denies) |
| `/api/platform/platform-ops/convergence` | GET | platform PLATFORM_OPS:READ | none/lib | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/platform/platform-ops/cost` | GET | platform PLATFORM_OPS:READ | none/lib | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/platform/platform-ops/db-authority` | GET | platform PLATFORM_OPS:READ (fresh) | none/lib | — | — | — | no (guard denies) |
| `/api/platform/platform-ops/email-health` | GET | platform PLATFORM_OPS:READ | none/lib | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/platform/platform-ops/env-status` | GET | platform PLATFORM_OPS:READ | none/lib | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/platform/platform-ops/history` | GET | platform PLATFORM_OPS:READ | none/lib | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/platform/platform-ops/job-cadence` | DELETE,GET,PATCH | platform PLATFORM_OPS:READ; platform PLATFORM_OPS:CONTROL (fresh) | none/lib | CONTROL; optimistic version | job/hours validated in lib | User platform-policy 30/60s; User platform-policy 30/60s | no (guard denies) |
| `/api/platform/platform-ops/job-health` | GET | platform PLATFORM_OPS:READ | none/lib | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/platform/platform-ops/operations` | GET,POST | platform PLATFORM_OPS:READ; platform PLATFORM_OPS:WRITE (fresh) | `db` (migration principal, BYPASSRLS) | WRITE runs registered job commands | commandId registry lookup | User platform-operation 30/60,s | no (guard denies) |
| `/api/platform/platform-ops/overview` | GET | platform PLATFORM_OPS:READ | none/lib | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/platform/platform-ops/plaid-usage` | GET | platform PLATFORM_OPS:READ | none/lib | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/platform/platform-ops/policies` | DELETE,GET,PATCH | platform PLATFORM_OPS:READ; platform PLATFORM_OPS:CONTROL (fresh) | none/lib | CONTROL for PATCH/DELETE; optimistic expectedUpdatedAt | sourceKind/cadence validated in mutate; reason required | User platform-policy 30/60s; User platform-policy 30/60s | no (guard denies) |
| `/api/platform/platform-ops/provider-cleanup` | GET,POST | platform PLATFORM_OPS:READ; platform PLATFORM_OPS:WRITE (fresh) | systemDb | any plaidItemId (operator) | string | — | no (guard denies) |
| `/api/platform/platform-ops/provider-health` | GET | platform PLATFORM_OPS:READ | none/lib | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/platform/platform-ops/rate-limits` | GET | platform PLATFORM_OPS:READ | `db` (migration principal, BYPASSRLS) | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/platform/platform-ops/refresh/coverage` | GET | platform PLATFORM_OPS:READ | none/lib | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/platform/platform-ops/refresh/daily` | GET | platform PLATFORM_OPS:READ | none/lib | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/platform/platform-ops/refresh/executions/[id]` | GET | platform PLATFORM_OPS:READ | none/lib | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/platform/platform-ops/refresh/executions/[id]/timeline` | GET | platform PLATFORM_OPS:READ | none/lib | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/platform/platform-ops/refresh/executions` | GET | platform PLATFORM_OPS:READ | none/lib | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/platform/platform-ops/refresh/provider-operations` | GET | platform PLATFORM_OPS:READ | none/lib | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/platform/platform-ops/refresh/summary` | GET | platform PLATFORM_OPS:READ | none/lib | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/platform/platform-ops/resource-freshness` | GET | platform PLATFORM_OPS:READ | none/lib | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/platform/platform-ops/scheduler` | GET | platform PLATFORM_OPS:READ | none/lib | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/platform/security-ops/anomalies` | GET | platform SECURITY_OPS:READ | `db` (migration principal, BYPASSRLS) | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/platform/security-ops/audit` | GET | platform SECURITY_OPS:READ | `db` (migration principal, BYPASSRLS) | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/platform/security-ops/auth-posture` | GET | platform SECURITY_OPS:READ | `db` (migration principal, BYPASSRLS) | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/platform/security-ops/operator-actions` | GET | platform SECURITY_OPS:READ | `db` (migration principal, BYPASSRLS) | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/platform/security-ops/sessions` | GET | platform SECURITY_OPS:READ | `db` (migration principal, BYPASSRLS) | fleet-wide session rows (ids, UA only) | — | — | no (guard denies) |
| `/api/refresh/all` | POST | user | tenant tx (fm_app) | own userId | — | User refresh-all 6/3600s | no (guard denies) |
| `/api/registration-policy` | POST | PUBLIC | none/lib | public; invite token → bound email (possession = authorisation) | — | Ip registration-policy 30/300s | n/a |
| `/api/space/switch` | POST | user | tenant tx (fm_app) | membership ACTIVE re-checked; cookie non-HttpOnly (non-authority) | spaceId string | — | no (guard denies) |
| `/api/spaces/[id]/accounts/detail` | GET | spaceRole≥VIEWER | tenant tx (fm_app); `db` (migration principal, BYPASSRLS); systemDb | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/spaces/[id]/accounts` | GET | spaceRole≥VIEWER | tenant tx (fm_app) | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/spaces/[id]/accounts/share` | DELETE,POST | spaceAction account:share | tenant tx (fm_app) | account:share + `fa.ownerUserId === userId`; DELETE adder or account:revoke | visibilityLevel enum | — | no (guard denies) |
| `/api/spaces/[id]/activity` | GET | spaceAction activity:read | tenant tx (fm_app); `db` (migration principal, BYPASSRLS) | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/spaces/[id]/debt/space-data` | GET | spaceAction perspective:read | tenant tx (fm_app) | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/spaces/[id]/expense-baseline` | GET | spaceRole≥VIEWER | tenant tx (fm_app) | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/spaces/[id]/history/node` | GET | spaceRole≥VIEWER | tenant tx (fm_app) | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/spaces/[id]/investments` | GET | spaceRole≥VIEWER | tenant tx (fm_app) | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/spaces/[id]/investments/space-data` | GET | spaceRole≥VIEWER | tenant tx (fm_app) | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/spaces/[id]/invite` | POST | spaceRole≥ADMIN | tenant tx (fm_app); `db` (migration principal, BYPASSRLS) | ADMIN; PERSONAL refused; target by username (`db.user.findUnique`) | role via parseInviteRoleInput (never OWNER) | — | no (guard denies) |
| `/api/spaces/[id]/invites/[inviteId]` | DELETE,PATCH | spaceRole≥ADMIN; user | tenant tx (fm_app); `db` (migration principal, BYPASSRLS) | PATCH invite.invitedUserId === user.id, status PENDING; accept via `db` (BYPASSRLS) after checks. DELETE ADMIN scoped by {id,spaceId} | action enum | — | no (guard denies) |
| `/api/spaces/[id]/invites` | GET | spaceRole≥ADMIN | tenant tx (fm_app); `db` (migration principal, BYPASSRLS) | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/spaces/[id]/liquidity/space-data` | GET | spaceAction perspective:read | tenant tx (fm_app) | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/spaces/[id]/members/[userId]` | DELETE,PATCH | spaceRole≥OWNER; spaceRole≥VIEWER | tenant tx (fm_app); `db` (migration principal, BYPASSRLS); systemDb | PATCH OWNER; target must be ACTIVE; OWNER role not promotable. DELETE self or OWNER/ADMIN; owner never removed | role ∈ PROMOTABLE_ROLES | — | no (guard denies) |
| `/api/spaces/[id]/permanent` | DELETE | spaceRole≥OWNER | tenant tx (fm_app); `db` (migration principal, BYPASSRLS); systemDb | OWNER; must be trashed; `db.space.delete` (BYPASSRLS) after checks | — | — | no (guard denies) |
| `/api/spaces/[id]/perspectives` | GET | spaceAction perspective:read | tenant tx (fm_app) | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/spaces/[id]/restore` | POST | spaceRole≥OWNER | tenant tx (fm_app) | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/spaces/[id]` | DELETE,GET,PATCH | spaceRole≥ADMIN; spaceRole≥OWNER; user | tenant tx (fm_app); `db` (migration principal, BYPASSRLS) | GET: `db.space.findUnique` (BYPASSRLS) then membership; 404 before 403 (existence oracle); public Spaces readable by any user. PATCH ADMIN, archive OWNER-only; DELETE OWNER | explicit field destructure; category enum; currency parsed; name length unbounded | — | no (guard denies) |
| `/api/spaces/[id]/sections/[sectionId]` | PATCH | spaceAction section:edit | tenant tx (fm_app) | section:edit; section.spaceId === spaceId | label/order/config untyped (config arbitrary JSON; no length cap) | — | no (guard denies) |
| `/api/spaces/[id]/sections` | GET | spaceAction section:read | tenant tx (fm_app) | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/spaces/[id]/snapshots` | GET | spaceRole≥VIEWER | tenant tx (fm_app); `db` (migration principal, BYPASSRLS); systemDb | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/spaces/[id]/transactions/query` | GET | spaceRole≥VIEWER | tenant tx (fm_app) | VIEWER; query scoped to spaceId inside tenant tx | parseTransactionQueryParams | — | no (guard denies) |
| `/api/spaces/[id]/transactions` | GET | spaceRole≥VIEWER | tenant tx (fm_app) | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/spaces/[id]/wealth/amend` | POST | spaceRole≥OWNER | tenant tx (fm_app) | requireSpaceRole OWNER; accountId checked inside amendment lib (UNVERIFIED); route 503 (feature off) | kind enum, ISO dates | — | no (guard denies) |
| `/api/spaces/invites/pending` | GET | user | tenant tx (fm_app) | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/spaces/invites/seen` | POST | user | tenant tx (fm_app) | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/spaces` | GET,POST | user | tenant tx (fm_app) | POST creates Space with caller OWNER | name required (no length cap); template validated | — | no (guard denies) |
| `/api/sync/status` | GET | user | tenant tx (fm_app) | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/transactions/[id]/correct` | POST | spaceAction transaction:correct; user | tenant tx (fm_app) | transaction:correct (MEMBER) on active Space + transactionDetailWhere | correction/category enums | — | no (guard denies) |
| `/api/transactions/[id]` | GET | user | tenant tx (fm_app) | transactionDetailWhere(id, activeSpace) — account linked to active Space with detail visibility | — | — | no (guard denies) |
| `/api/user/deactivate` | POST | user (fresh) | tenant tx (fm_app) | own; password | — | Ip account-deactivate 5/900s | no (guard denies) |
| `/api/user/delete` | POST | user (fresh) | tenant tx (fm_app) | own; password | — | User account-delete 5/900s | no (guard denies) |
| `/api/user/email/confirm` | POST | PUBLIC | tenant tx (fm_app); authDb | token hash + expiry; uniqueness re-checked; all sessions revoked | token string | Ip email-change-confirm 10/900s | n/a |
| `/api/user/email/request` | POST | user (fresh) | tenant tx (fm_app) | own; password re-verified | email regex | Ip email-change-request 5/900s; User email-change-request 5/900s | no (guard denies) |
| `/api/user/export` | POST | user (fresh) | tenant tx (fm_app) | own; requireFreshUser | — | — | no (guard denies) |
| `/api/user/notification-preferences` | GET,PATCH | user | tenant tx (fm_app) | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/user/password` | PATCH | user (fresh) | tenant tx (fm_app) | own; current pw re-verified; other sessions revoked | min len; differs | User password-change 5/900s | no (guard denies) |
| `/api/user/profile` | GET,PATCH | user | tenant tx (fm_app) | own; preferredSpaceId membership-checked | username regex, timezone, currency; employmentStatus/useCase cast | — | no (guard denies) |
| `/api/user/security-history` | GET | user | tenant tx (fm_app) | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | — | no (guard denies) |
| `/api/user/sessions/[sessionId]` | DELETE | user (fresh) | tenant tx (fm_app) | findFirst {id, userId}; confirmSelf for current | — | — | no (guard denies) |
| `/api/user/sessions` | DELETE,GET | user (fresh); user | tenant tx (fm_app) | own | — | — | no (guard denies) |
| `/api/user/totp/disable` | POST | user (fresh) | tenant tx (fm_app) | own; TOTP or password re-verified | — | User totp-disable 5/900s | no (guard denies) |
| `/api/user/totp/recovery-codes` | POST | user (fresh) | tenant tx (fm_app); systemDb | (not individually read — guard + tenant tx; UNVERIFIED) | (not individually read) | User totp-recovery-codes 3/900s | no (guard denies) |
| `/api/user/totp/setup` | POST | user [allowTotpSetupPending] | tenant tx (fm_app) | own; pending allowed | — | User totp-setup 5/900s | YES (by design) |
| `/api/user/totp/status` | GET | user [allowTotpSetupPending] | tenant tx (fm_app); authDb | own; pending allowed | — | — | YES (by design) |
| `/api/user/totp/verify` | POST | user [allowTotpSetupPending] | tenant tx (fm_app) | own; pending allowed by design | 6 digits | User totp-verify 5/900s | YES (by design) |
| `/api/users/search` | GET | spaceAction member:invite; user | `db` (migration principal, BYPASSRLS) | none — searches ALL users by name/username substring (`db`, BYPASSRLS); `exclude` space needs member:invite | q ≥1 char; take 8; NO rate limit | — | no (guard denies) |

---

