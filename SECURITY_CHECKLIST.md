# Fourth Meridian — Official Security Checklist

**Status:** Living document · **Owner of record:** Platform / PO1
**Source of truth:** `SECURITY_AUDIT_2026-07-07.md` (initial population)
**Last reviewed:** 2026-07-07

> This is the canonical security checklist for Fourth Meridian. Walk it before **closed beta**, **public beta**, **production**, and **every major release**. It is documentation only — it does not change code, schema, or STATUS. Update the Status/Owner columns as work lands; keep the audit reference current.

**Legend**
- **Priority:** Critical · High · Medium · Low
- **Status:** ✅ Complete · ⚠️ Needs work · ⏳ Future
- **Owner:** OPS-1 (email foundation) · OPS-2 (account lifecycle/security) · OPS-3 (notifications & preferences) · OPS-4 · OPS-5 · PO1 (platform ops / deploy) · Future
- **Verify:** the exact steps an engineer performs to confirm the item.

---

## 1. Authentication

### □ Password storage
Priority: Critical · Status: ✅ Complete · Owner: OPS-2
Verify:
- Passwords hashed with `bcrypt` cost 12 (`register`, `reset-password`, `password` routes).
- No plaintext password in DB, logs, or audit metadata.
- Minimum length ≥ 8 enforced server-side.

### □ Password change
Priority: High · Status: ⚠️ Needs work · Owner: OPS-2
Verify:
- `PATCH /api/user/password` requires `currentPassword` and uses `requireFreshUser` (live revocation check).
- On success, all *other* sessions revoked; current session kept; security-alert email sent; `PASSWORD_CHANGED` audited.
- **Needs work:** add a per-user rate limit (e.g. 5/15min) to blunt current-password brute force from a foothold session.

### □ Password reset
Priority: Critical · Status: ✅ Complete · Owner: OPS-1 / OPS-2
Verify:
- Token = `crypto.randomBytes(32)`, stored SHA-256-hashed (`lib/password-reset-token.ts`), 1h TTL, single-use (cleared on use).
- Reset link built from `env.NEXT_PUBLIC_APP_URL`, never the request Host.
- All sessions revoked on completion; security-alert email sent.
- `forgot-password` is non-enumerating (always 200); dev-only URL exposure gated on `NODE_ENV !== "production"`.

### □ Email verification
Priority: High · Status: ✅ Complete · Owner: OPS-1
Verify:
- Verification token hashed at rest, 1h TTL; consumption is **POST-only** (GET page can't burn a token via scanners/prefetch).
- Login is blocked for `emailVerifiedAt = null` in `authorize()` (including SYSTEM_ADMIN); password reset is deliberately NOT gated on verification.
- Identifier-based resend is non-enumerating; token-based resend may be precise.

### □ Email change
Priority: High · Status: ✅ Complete · Owner: OPS-2
Verify:
- `email/request` re-authenticates with current password, stores hashed 1h token, emails NEW address to confirm and WARNS the OLD address before any swap.
- `email/confirm` is token-authenticated, idempotent within TTL, re-checks uniqueness, re-stamps `emailVerifiedAt`, revokes all sessions on swap.
- Confirm link built from trusted env base.

### □ TOTP (2FA)
Priority: Critical · Status: ⚠️ Needs work · Owner: OPS-2 / OPS-3
Verify:
- Secret AES-256-GCM encrypted via `TOTP_SECRET` purpose key; native RFC 6238 impl (`lib/totp.ts`).
- Setup returns raw secret once only; `totpEnabled` stays false until verify.
- **Needs work (H1):** enforce one-time use — reject a code already consumed in its timestep (currently replayable within ±1 window in login and `totp/disable`).
- **Needs work (M3):** rate-limit `totp/setup` and `totp/disable` (both carry unmet TODO comments); `totp/disable` password fallback is brute-forceable unthrottled.
- **Needs work:** narrow verify window from ±1 toward 0/+1 where drift allows.

### □ Recovery codes
Priority: Medium · Status: ✅ Complete · Owner: OPS-2
Verify:
- 10 codes, 64-bit entropy each, stored bcrypt-hashed (cost 10), shown once, single-use (`usedAt`), `RECOVERY_CODE_USED` audited.
- Regeneration invalidates prior unused codes.
- Note: verify loops bcrypt over unused codes — ensure the login path that reaches it is rate-limited (see Login rate limiting).

### □ Login rate limiting
Priority: Critical · Status: ⚠️ Needs work · Owner: OPS-2
Verify:
- `RATE_LIMIT_ENABLED=true` in the target environment.
- **Needs work (C2):** `authorize()` in `lib/auth.ts` enforces a limit keyed on identifier + IP BEFORE password/TOTP checks (currently NO limiter on the NextAuth callback — only advisory `pre-login` is limited).
- Manual: scripted brute-force against `POST /api/auth/callback/credentials` returns 429 / lockout, not unlimited attempts.

### □ Account lockout
Priority: High · Status: ⚠️ Needs work · Owner: OPS-2
Verify:
- **Needs work:** after N failed attempts per identifier, temporary lockout or step-up (CAPTCHA) applied. LOGIN_FAILED audit rows already exist to seed the counter.
- Lockout does not itself become a DoS-by-lockout vector (scope per identifier+IP, time-boxed).

### □ Enumeration resistance
Priority: Medium · Status: ⚠️ Needs work · Owner: OPS-2
Verify:
- ✅ `forgot-password`, `pre-login`, identifier-resend are non-enumerating (dummy-hash timing; state revealed only post-password).
- **Needs work (M4):** `register` (409 email/username exists), `spaces/invite` (404 no user), `email/request` (409 in use) disclose existence — accept for closed beta, revisit for public beta.

---

## 2. Sessions

### □ Secure cookies
Priority: Critical · Status: ✅ Complete (verify in prod) · Owner: OPS-2 / PO1
Verify:
- No custom cookie override → NextAuth defaults: `HttpOnly`, `SameSite=Lax`, `Secure` + `__Secure-` prefix in production.
- Manual: inspect Set-Cookie on the live https domain; confirm flags present with `NEXTAUTH_URL` https.

### □ Session revocation
Priority: Critical · Status: ✅ Complete · Owner: OPS-2
Verify:
- JWT session callback re-checks the `UserSession` row (`revokedAt IS NULL`); revoked → expired session returned, middleware redirects to login.
- Revocation cache TTL = 30s for ordinary reads; sensitive actions use `requireFreshUser`/`requireFreshSystemAdmin` (live DB, no cache).

### □ Current session protection
Priority: Medium · Status: ✅ Complete · Owner: OPS-2
Verify:
- `DELETE /api/user/sessions/[sessionId]` verifies the session belongs to the caller; self-revoke requires explicit `confirmSelf=true`.
- Password change preserves the current session while revoking others.

### □ Revoke all / sign out everywhere
Priority: High · Status: ✅ Complete · Owner: OPS-2
Verify:
- `revokeAllUserSessions` / `revokeOtherUserSessions` (`lib/sessions.ts`) back reset, email-change, deactivate, delete, and sign-out-everywhere.
- Revocation cache cleared on bulk revoke (`clearAllSessions`).

### □ Device / user-agent tracking
Priority: Low · Status: ✅ Complete · Owner: OPS-2
Verify:
- `UserSession` stores `ipAddress`, `userAgent`, `lastActiveAt`; UA parsed for the Active Sessions UI (`lib/ua-parser.ts`).
- IP derived via Cloudflare > x-forwarded-for > x-real-ip (`lib/api.ts`).

### □ Session expiration
Priority: Medium · Status: ⚠️ Needs work · Owner: OPS-2 / Future
Verify:
- JWT `maxAge = 30 days`.
- **Needs work (H3):** consider shorter lifetime for `SYSTEM_ADMIN`; role changes only propagate on token expiry/revocation.

### □ Admin session handling
Priority: High · Status: ⚠️ Needs work · Owner: OPS-2 / OPS-5
Verify:
- Admin API routes use `requireSystemAdmin`/`requireFreshSystemAdmin`.
- **Needs work (H3):** de-privileging an admin requires explicit session revocation (JWT `role` is not re-read from DB). Document in incident playbook; long-term re-read role for admins.

---

## 3. Authorization

### □ Space permissions
Priority: Critical · Status: ✅ Complete · Owner: OPS-2
Verify:
- Centralized in `requireSpaceRole` / `requireSpaceAction` (`lib/session.ts`, `lib/spaces/authorize.ts`); pure policy in `lib/spaces/policy.ts` (unit-tested).
- ACTIVE membership + role-order enforced; non-member → 403 with no space-existence disclosure.

### □ Role enforcement
Priority: Critical · Status: ✅ Complete · Owner: OPS-2
Verify:
- Role order VIEWER < MEMBER < ADMIN < OWNER; `meetsMinRole` used consistently.
- REMOVED/LEFT rows never satisfy ACTIVE checks (invite/search/authz).

### □ IDOR review
Priority: Critical · Status: ✅ Complete (spot-checked) · Owner: OPS-2 / PO1
Verify:
- Resource routes scope by `spaceId + userId` membership or `ownerUserId`; `sessions/[sessionId]` verifies ownership; transaction reads funnel through the KD-15 visibility predicate (`lib/data/transactions.ts`).
- **Ongoing:** every new `[id]` route must prove ownership/membership before returning data — add to release review.

### □ Export permissions
Priority: High · Status: ✅ Complete · Owner: OPS-2
Verify:
- `user/export` uses `requireFreshUser` and composes the existing visibility-enforcing read layer (`lib/export/assemble.ts`) — no parallel permission logic, no SAL bypass.

### □ Invite permissions
Priority: High · Status: ✅ Complete · Owner: OPS-2
Verify:
- `spaces/[id]/invite` requires ACTIVE ADMIN+; can't invite self or existing ACTIVE member; invite emails carry NO token (acceptance stays identity-gated in-app → no forged acceptance).

### □ Admin permissions
Priority: Critical · Status: ⚠️ Needs work · Owner: OPS-5
Verify:
- All `/api/admin/*` routes call `requireSystemAdmin`; 2FA-reset blocks self-target and requires `confirmToken:"RESET"`.
- **Needs work:** re-enable the commented admin-TOTP guard once admin TOTP is enforced; formalize least-privilege / admin-overreach review under OPS-5.

---

## 4. Secrets

### □ Encryption (AES-256-GCM)
Priority: Critical · Status: ✅ Complete · Owner: OPS-2
Verify:
- `lib/plaid/encryption.ts`: AES-256-GCM, random IV per op, auth tag verified; dual-format v1/v2 reads.

### □ HKDF per-purpose keys
Priority: High · Status: ✅ Complete · Owner: OPS-2
Verify:
- One root `ENCRYPTION_KEY`; subkeys via HKDF-SHA-256 per purpose (`PLAID_ACCESS_TOKEN`, `TOTP_SECRET`, `DATE_OF_BIRTH`, `CONNECTION_CREDENTIAL`).

### □ Key rotation
Priority: Medium · Status: ⏳ Future · Owner: OPS-4
Verify:
- v1→v2 re-encryption path and `detectCiphertextVersion` audit exist.
- **Future:** documented rotation runbook (rotate root key, re-encrypt, retire v1 branch after 0 v1 rows + backup window). Confirm preview/prod do not share `ENCRYPTION_KEY`.

### □ Environment variables
Priority: Critical · Status: ⚠️ Needs work · Owner: PO1
Verify:
- `validateEnv()` covers `DATABASE_URL`, `NEXTAUTH_SECRET`, `ENCRYPTION_KEY` (64 hex).
- **Needs work:** add `RATE_LIMIT_ENABLED` and `CRON_SECRET` to `.env.example` with comments; consider adding to startup validation for prod.

### □ Secret logging hygiene
Priority: High · Status: ✅ Complete · Owner: OPS-2
Verify:
- TOTP manualKey, reset/verify URLs, decrypted tokens are never logged; errors return generic 500 via `withApiHandler` (no stack/message to client).
- Grep confirms no `console.log` of secrets/tokens in auth paths.

### □ Plaid access token
Priority: Critical · Status: ✅ Complete · Owner: OPS-2
Verify:
- Stored encrypted (`encryptedToken`, `PLAID_ACCESS_TOKEN` purpose); decrypted only in-memory at call time (exchange/sync/purge).

### □ TOTP secret
Priority: Critical · Status: ✅ Complete · Owner: OPS-2
Verify:
- Encrypted with `TOTP_SECRET` purpose; cleared on disable/reset.

### □ Date of birth
Priority: High · Status: ✅ Complete · Owner: OPS-2
Verify:
- `dateOfBirthEncrypted` via `DATE_OF_BIRTH` purpose at registration; never returned in plaintext to non-owner surfaces.

---

## 5. API Security

### □ Rate limiting
Priority: Critical · Status: ⚠️ Needs work · Owner: OPS-2 / PO1
Verify:
- `RATE_LIMIT_ENABLED=true` in prod/preview (**C1** — currently absent from all env files → all limits are no-ops).
- Prod uses DB-backed `RateLimit` table with `@@unique([key, windowStart])`.
- **Needs work:** login/TOTP call sites (C2), plus totp/setup, totp/disable, password, plaid, users/search.

### □ Origin validation
Priority: Medium · Status: ⚠️ Needs work · Owner: OPS-3
Verify:
- **Needs work (M2):** add Origin/Referer allowlist check on destructive routes (delete/deactivate/password/email/2FA).

### □ CSRF
Priority: Medium · Status: ⚠️ Needs work · Owner: OPS-3
Verify:
- `SameSite=Lax` default mitigates cross-site form POST (primary mitigation in place).
- **Needs work:** add defense-in-depth (Origin check or `SameSite=Strict` on the session cookie) for destructive routes.

### □ Input validation
Priority: High · Status: ✅ Complete (ongoing) · Owner: OPS-2
Verify:
- Email/username regex, length caps, credit-score bounds, type guards on JSON bodies across auth/user routes.
- **Ongoing:** each new route validates and normalizes inputs server-side.

### □ Output validation / field selection
Priority: Medium · Status: ✅ Complete · Owner: OPS-2
Verify:
- Prisma `select` limits returned fields (no passwordHash/totpSecret leakage); `users/search` returns only display fields.

### □ Error handling
Priority: Medium · Status: ✅ Complete · Owner: OPS-2
Verify:
- `withApiHandler` catches unhandled errors → generic 500; no stack traces to clients; parseable Plaid errors sanitized.

### □ Audit coverage
Priority: High · Status: ✅ Complete · Owner: OPS-2
Verify:
- LOGIN/LOGIN_FAILED/LOGOUT, password/email/2FA/recovery events, session revoke, account lifecycle, admin actions (`performedByAdminId`) all write `AuditLog`.
- **Ongoing:** new sensitive actions add an audit row.

---

## 6. Background Jobs

### □ Cron authentication
Priority: Critical · Status: ✅ Complete (verify secret set) · Owner: PO1
Verify:
- `sync-banks`, `fetch-fx-rates`, `process-deletions` require `Authorization: Bearer ${CRON_SECRET}`; missing/unset → 401.
- Confirm `CRON_SECRET` is set in prod (unset silently disables jobs).
- Low: switch string compare to `crypto.timingSafeEqual` (L1).

### □ Idempotency
Priority: High · Status: ✅ Complete · Owner: OPS-2
Verify:
- Purge re-checks `deletionScheduledAt` before acting; Plaid items marked REVOKED so resumed runs don't re-`itemRemove`; email-change/verify confirm are idempotent within TTL.

### □ Retries
Priority: Medium · Status: ✅ Complete (by design) · Owner: OPS-2
Verify:
- No retry framework by design — the daily cron IS the retry; a mid-purge failure leaves the User row intact to resume next run.

### □ Timeouts
Priority: Medium · Status: ✅ Complete · Owner: PO1
Verify:
- `maxDuration = 60` on job routes (Hobby-plan max); volume finishes well under budget; overflow finished by next cron.

### □ Failure recovery
Priority: High · Status: ✅ Complete · Owner: OPS-2
Verify:
- Per-user best-effort loop; provider failures counted, logged, non-fatal; external `itemRemove` runs OUTSIDE any DB transaction.

### □ Deletion pipeline
Priority: Critical · Status: ✅ Complete · Owner: OPS-2
Verify:
- Reversible grace window; cancel-vs-purge race guarded; audit-before-delete with SHA-256 email hash on anonymized row; sole-OWNER preflight prevents ownerless Spaces; USER-owned accounts deleted explicitly (SetNull ≠ cascade).

### □ Provider disconnect
Priority: High · Status: ✅ Complete · Owner: OPS-2
Verify:
- Plaid `itemRemove` per active item on purge; SALs REVOKED; canonical AccountConnection re-elected or account marked stale.

---

## 7. Infrastructure

### □ HTTPS
Priority: Critical · Status: ✅ Complete (verify prod) · Owner: PO1
Verify:
- Vercel serves https; `NEXTAUTH_URL` and `NEXT_PUBLIC_APP_URL` are https in prod; no mixed content.

### □ Security headers
Priority: High · Status: ⚠️ Needs work · Owner: OPS-3 / PO1
Verify:
- **Needs work (H2):** `next.config.ts` has NO `headers()` block. Add the full set below.

### □ Content-Security-Policy
Priority: High · Status: ⚠️ Needs work · Owner: OPS-3
Verify:
- **Needs work:** add CSP (start report-only), include `frame-ancestors 'none'`.

### □ HSTS
Priority: High · Status: ⚠️ Needs work · Owner: PO1
Verify:
- **Needs work:** `Strict-Transport-Security: max-age=15552000; includeSubDomains` (and `preload` once confident).

### □ Frame protection
Priority: High · Status: ⚠️ Needs work · Owner: OPS-3
Verify:
- **Needs work:** `X-Frame-Options: DENY` and/or CSP `frame-ancestors 'none'` (clickjacking of destructive actions).

### □ nosniff
Priority: Medium · Status: ⚠️ Needs work · Owner: OPS-3
Verify:
- **Needs work:** `X-Content-Type-Options: nosniff`.

### □ Referrer policy
Priority: Medium · Status: ⚠️ Needs work · Owner: OPS-3
Verify:
- **Needs work:** `Referrer-Policy: strict-origin-when-cross-origin` (avoid leaking token URLs).

### □ Cookies (prod flags)
Priority: Critical · Status: ✅ Complete (verify prod) · Owner: PO1
Verify:
- Inspect Set-Cookie on live domain: HttpOnly + Secure + SameSite present.

### □ Environment separation
Priority: High · Status: ⚠️ Needs work · Owner: PO1
Verify:
- Distinct DB, secrets, and `ENCRYPTION_KEY` per env (dev/preview/prod); Plaid env correct (`PLAID_ENV`).
- **Needs work:** confirm preview/prod don't share encryption key or DB.

### □ Database backups
Priority: Critical · Status: ⚠️ Needs work (verify) · Owner: PO1
Verify:
- Automated backups / PITR enabled at the Postgres provider — critical given irreversible purge.

### □ Restore testing
Priority: High · Status: ⏳ Future · Owner: PO1
Verify:
- **Future:** perform and document a test restore to a scratch DB; record RTO/RPO.

---

## 8. Abuse Protection

### □ Credential stuffing
Priority: Critical · Status: ⚠️ Needs work · Owner: OPS-2
Verify:
- Login rate limit + lockout active (C1+C2); replayed breach list against the callback is throttled/locked.

### □ Password spraying
Priority: Critical · Status: ⚠️ Needs work · Owner: OPS-2
Verify:
- Per-IP + per-identifier limits catch low-and-slow spraying across many accounts; monitor LOGIN_FAILED spikes.

### □ TOTP brute force
Priority: Critical · Status: ⚠️ Needs work · Owner: OPS-2
Verify:
- Dedicated tight limit on the TOTP branch (C2) + one-time-use (H1); 6-digit space not exhaustible.

### □ Email bombing
Priority: Medium · Status: ⚠️ Needs work · Owner: OPS-2
Verify:
- `forgot-password`, `verify-email/resend`, `email/request` limited per IP AND per target address (L4); requires C1 on.

### □ AI abuse / cost
Priority: Medium · Status: ✅ Complete (verify flag) · Owner: OPS-2
Verify:
- `ai/chat` calls `limitByUser` (SYSTEM_ADMIN exempt); effective only with `RATE_LIMIT_ENABLED=true`.

### □ Export abuse
Priority: Medium · Status: ⚠️ Needs work · Owner: OPS-2
Verify:
- `data-export` caps 3/day/user — inert until C1 on; confirm 4th request in a day returns 429.

### □ Plaid abuse / cost
Priority: Medium · Status: ⚠️ Needs work · Owner: OPS-3
Verify:
- **Needs work (M3):** add modest per-user limits to `plaid/exchange-token|link-token|sync|refresh` (external-cost endpoints); refresh already has a cooldown.

### □ DDoS
Priority: Medium · Status: ⚠️ Needs work · Owner: PO1
Verify:
- Cloudflare/Vercel edge protections enabled; no expensive unauthenticated work before auth/rate checks.

---

## 9. Privacy

### □ Data export
Priority: High · Status: ✅ Complete · Owner: OPS-2
Verify:
- Export composes visibility-enforcing readers only; ZIP served `Cache-Control: no-store`, attachment disposition; export event audited; user notified.

### □ Deletion
Priority: Critical · Status: ✅ Complete · Owner: OPS-2
Verify:
- Reversible request → grace → irreversible purge; cascade covers accounts/transactions/holdings/connections/SALs/personal Space; final notice email before User row removed.

### □ Audit retention
Priority: Medium · Status: ✅ Complete · Owner: OPS-2 / Future
Verify:
- AuditLog `userId` SetNull on user delete → row survives anonymized; **Future:** define a retention window / purge policy for aged audit rows.

### □ Anonymization
Priority: High · Status: ✅ Complete · Owner: OPS-2
Verify:
- Post-delete audit stores email only as SHA-256 hash; no raw PII persists on anonymized rows.

### □ Data minimization
Priority: Medium · Status: ⚠️ Needs work · Owner: OPS-3
Verify:
- Prisma `select` scopes reads.
- **Needs work (M1):** `users/search` exposes all members' real names to any authenticated user — restrict fields/query length.

### □ Shared-space privacy
Priority: High · Status: ✅ Complete · Owner: OPS-2
Verify:
- KD-15 predicate (`TRANSACTION_DETAIL_VISIBILITY`) — only FULL shares contribute rows; BALANCE_ONLY/SUMMARY_ONLY never leak transactions; scope note rendered in shared views.

---

## 10. Beta Readiness

| Category | Item | Priority | Owner |
|---|---|---|---|
| **Must fix before beta** | Login rate limiting on `authorize()` (C2) | Critical | OPS-2 |
| **Must fix before beta** | `RATE_LIMIT_ENABLED=true` + document in `.env.example` (C1) | Critical | OPS-2 / PO1 |
| **Must fix before beta** | TOTP one-time-use / replay protection (H1) | High | OPS-2 |
| **Must fix before beta** | Security headers: HSTS, frame-ancestors, nosniff, referrer-policy (H2) | High | OPS-3 / PO1 |
| **Strongly recommended** | Account lockout after N failed logins | High | OPS-2 |
| **Strongly recommended** | Rate-limit totp/setup, totp/disable, password (M3) | Medium | OPS-2 |
| **Strongly recommended** | CSP (report-only to start) | High | OPS-3 |
| **Strongly recommended** | Restrict `users/search` fields + query length (M1) | Medium | OPS-3 |
| **Strongly recommended** | Verify DB backups + `CRON_SECRET` set in prod | Critical | PO1 |
| **Nice to have** | Origin/Referer checks on destructive routes (M2) | Medium | OPS-3 |
| **Nice to have** | Plaid per-user rate limits (M3) | Medium | OPS-3 |
| **Nice to have** | Shorter admin session lifetime | Medium | OPS-2 |
| **Safe after beta** | Registration/invite enumeration hardening (M4) | Medium | OPS-3 |
| **Safe after beta** | Admin DB role re-read (H3) | High | OPS-5 |
| **Safe after beta** | timingSafeEqual for CRON_SECRET (L1) | Low | PO1 |
| **Safe after beta** | Key-rotation runbook | Medium | OPS-4 |
| **Safe after beta** | Audit-retention purge policy | Medium | Future |

---

## 11. Production Deployment Checklist

Walk this top-to-bottom before every production deploy. Nothing ships with an unchecked Critical.

**Secrets & environment**
- □ `RATE_LIMIT_ENABLED=true` set on the production project
- □ `CRON_SECRET` configured (and cron jobs firing — check logs)
- □ `NEXTAUTH_SECRET` configured, strong, unique per env
- □ `ENCRYPTION_KEY` verified (64 hex chars) and NOT shared with preview/dev
- □ `DATABASE_URL` / `DIRECT_URL` point at the production DB
- □ `NEXTAUTH_URL` and `NEXT_PUBLIC_APP_URL` = production https URL
- □ `PLAID_ENV` correct for production; Plaid prod credentials set
- □ `validateEnv()` passes at startup (no missing required vars)

**Email deliverability & security**
- □ Resend sending domain verified
- □ SPF record configured
- □ DKIM configured
- □ DMARC configured (policy at least `p=quarantine`)
- □ Test send of reset + security-alert lands in inbox (not spam)

**Data safety**
- □ Database backups / PITR verified enabled
- □ Restore test completed and documented (RTO/RPO recorded)

**HTTP security**
- □ Security headers enabled (HSTS, X-Frame-Options/frame-ancestors, nosniff, Referrer-Policy)
- □ CSP enabled (report-only or enforcing)
- □ HTTPS verified end-to-end; no mixed content
- □ Session cookie shows HttpOnly + Secure + SameSite on live domain
- □ Production URLs verified (no localhost/preview leakage in links)

**Operations**
- □ Monitoring / alerting enabled (error rate, auth failures, cron success)
- □ Logs reviewed for leaked secrets or PII
- □ Incident-response playbook available (revoke sessions, disable admin, rotate keys)

**Accounts & hygiene**
- □ No seed accounts in production (`SEED_ADMIN_PASSWORD`/`SEED_USER_PASSWORD` users absent)
- □ Default/placeholder passwords removed; `change_me_*` values replaced
- □ `DISABLE_SYSTEM_ADMIN` decision made and documented

**Dependencies & assurance**
- □ `npm audit` reviewed; no unresolved High/Critical
- □ Dependency updates reviewed (NextAuth, Prisma, bcrypt, Plaid SDK)
- □ Penetration test / security review completed for this release
- □ All "Must fix before beta" blockers resolved (Section 10)

---

## Roadmap — ownership of every incomplete item

Use this as the backlog. Each open item is assigned to the initiative that should carry it.

**OPS-2 (account/security — current)**
- Login rate limiting on `authorize()` (C2) · Critical
- Account lockout after N failures · High
- TOTP one-time-use / replay protection (H1) · High
- Rate-limit password change, totp/setup, totp/disable (M3) · Medium
- Export-abuse / email-bombing caps effective once C1 on · Medium

**OPS-3 (notifications & preferences — next)**
- Security headers, CSP, HSTS, frame protection, nosniff, referrer policy (H2) · High
- Origin/Referer + CSRF defense-in-depth (M2) · Medium
- Restrict `users/search` (M1, data minimization) · Medium
- Plaid per-user rate limits (M3) · Medium
- Registration/invite enumeration hardening (M4) · Medium

**OPS-4**
- Key-rotation runbook + preview/prod key separation · Medium

**OPS-5**
- Admin least-privilege review + re-enable admin-TOTP guard · High
- Admin DB role re-read / de-privileging propagation (H3) · High

**PO1 (platform / deploy ops)**
- `RATE_LIMIT_ENABLED` + `CRON_SECRET` documented and set (C1) · Critical
- Database backups + restore testing · Critical/High
- HTTPS / cookie flag / production URL verification · Critical
- Monitoring, log review, DDoS edge protection · Medium
- `npm audit` / dependency review cadence · Medium
- `crypto.timingSafeEqual` for CRON_SECRET (L1) · Low

**Future**
- Audit-retention purge policy · Medium
- Formal pen-test before public beta · High
- Longer-term session lifetime tuning · Medium

---

*Living document. Re-run the audit and refresh Status/Owner columns before each gate (closed beta → public beta → production → major releases). Documentation only — no code, schema, or STATUS changes.*
