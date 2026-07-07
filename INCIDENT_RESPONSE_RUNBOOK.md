# Fourth Meridian — Incident Response Runbook

**Status:** Living document · **Owner of record:** Platform / PO1
**Companions:** `SECURITY_CHECKLIST.md` (is it secure?), `RELEASE_CHECKLIST.md` (is it ready to ship?)
**Last reviewed:** 2026-07-07

> This document answers **"What do we do when production is broken?"** It is the operational playbook engineers follow during an **active incident**. It is *not* disaster recovery, and *not* a security checklist — it is what you open at 3am when something is on fire. Written to be usable during a real incident without modification.

**Stack context (assume this everywhere below).** Next.js on Vercel (region `sin1`), Postgres via Prisma, NextAuth v4 JWT sessions with DB-backed `UserSession` revocation, Cloudflare in front, Plaid (bank data), Resend (transactional email). Three Vercel crons: `sync-banks` (06:00 UTC), `fetch-fx-rates` (06:30), `process-deletions` (07:00), each authed by `Authorization: Bearer ${CRON_SECRET}`. Rate limiting is gated on `RATE_LIMIT_ENABLED`. Secrets: `NEXTAUTH_SECRET`, `ENCRYPTION_KEY` (root; HKDF per-purpose subkeys), `CRON_SECRET`, `RESEND_API_KEY`, Plaid creds.

**How to read each section:** Purpose · Owner · Priority · Verification (how you confirm the problem/fix) · Recovery Criteria (when you can call it resolved).

---

## 1. Incident Severity

**Purpose:** Classify fast so response is proportional. When in doubt, over-classify — you can always downgrade.
**Owner:** Incident Commander (first responder until handed off) · **Priority:** Critical
**Verification:** Severity is written in the incident channel within the first 5 minutes.
**Recovery Criteria:** Severity is agreed and recorded; downgrade only when the defining condition no longer holds.

### SEV-1 — Critical, immediate response (all-hands, page)
User-facing outage, data integrity risk, or security breach.
- Authentication outage (nobody can log in / everybody logged out).
- Data corruption or wrong-data being written.
- Production database unavailable.
- Deletion pipeline deleting the wrong records or purging early.
- Authorization failure (users seeing other users'/Spaces' data — cross-tenant leak).
- Leaked secrets (`ENCRYPTION_KEY`, `NEXTAUTH_SECRET`, DB URL, Plaid/Resend keys).
**Expected response:** Immediate. Stop deploys, page the on-call, open an incident channel now.

### SEV-2 — Major, same-day response
Degraded but not down; core auth and data integrity intact.
- Plaid outage (bank sync/link failing).
- Notifications/email delivery failing (OPS-1/OPS-3 surfaces).
- Degraded performance / elevated latency.
- Cron failures (sync, FX, deletion job not running).
- Data export failing.
**Expected response:** Respond during working hours; mitigate today; page only if trending toward SEV-1.

### SEV-3 — Minor, scheduled response
No integrity, security, or availability impact.
- Cosmetic bugs, copy errors, documentation.
- Isolated non-critical feature failures.
- UI/visual regressions.
**Expected response:** Ticket it; fix in the normal release cycle.

**Escalation rule:** any SEV-2 touching auth, authorization, secrets, or the deletion pipeline is re-evaluated as a potential SEV-1.

---

## 2. First Five Minutes

**Purpose:** Stabilize and gather facts before changing anything.
**Owner:** First responder / Incident Commander · **Priority:** Critical
**Verification:** Each box is checked in the incident channel with a timestamp.
**Recovery Criteria:** Severity set, blast radius known, deploys frozen, logs preserved.

```
□ Confirm the issue is real (reproduce it or see it in monitoring — not a single user report)
□ Determine severity (SEV-1 / 2 / 3) and post it
□ Stop deployments (freeze Vercel; announce "deploy freeze" in channel)
□ Preserve logs NOW (screenshot/export Vercel logs + relevant AuditLog rows before they roll off)
□ Identify the latest deployment (Vercel dashboard → Deployments → note commit SHA + time)
□ Check monitoring (error rate, latency, auth-failure surge)
□ Check the database (reachable? connection count? locks? recent migration?)
□ Check Vercel status (functions erroring? build failing? region sin1 healthy?)
□ Check provider status pages (Plaid, Resend, Vercel, Cloudflare, GitHub, DB host)
□ Determine blast radius (all users? one Space? one endpoint? one provider?)
□ Assign roles (Commander, Comms, Scribe) if SEV-1
```

**Golden rule:** Do NOT run a migration, rotate a key, or deploy a "quick fix" during the first five minutes. Diagnose first. The one exception is containment of an active breach or an actively-wrong deletion (see §7, §5).

---

## 3. Authentication Incidents

**Purpose:** Restore the ability to log in and hold sessions correctly. Auth incidents are SEV-1 by default.
**Owner:** OPS-2 · **Priority:** Critical
**General verification:** reproduce against production login; inspect `AuditLog` (`LOGIN`, `LOGIN_FAILED`, `LOGOUT`, `SESSION_REVOKED`) and Vercel logs for the `[auth]` / `[session]` lines.
**General recovery criteria:** a known-good test account can log in (with TOTP where enabled), hold a session across navigation, and sensitive actions still enforce fresh revocation checks.

### 3.1 Cannot log in (all users)
- **Diagnosis:** Check `NEXTAUTH_SECRET` present/unchanged (a rotated secret invalidates all JWTs → mass logout). Check DB reachable (login writes `UserSession` + `AuditLog` in a transaction; a DB outage blocks login). Check latest deploy for auth changes. Look for `[auth]` errors.
- **Immediate mitigation:** If a bad deploy → roll back (§8). If `NEXTAUTH_SECRET` was changed accidentally → restore the previous value (users re-login once). If DB down → §4.
- **Permanent fix:** Post-incident, add secret-change protection to the deploy checklist; never rotate `NEXTAUTH_SECRET` without a planned mass-logout window.
- **Verification:** Test account logs in; new `LOGIN` audit row appears.

### 3.2 Sessions revoked incorrectly (users logged out unexpectedly)
- **Diagnosis:** Was `NEXTAUTH_SECRET` changed? Did a bulk revoke run (`clearAllSessions`/`revokeAllUserSessions`)? Check `UserSession.revokedAt` timestamps clustering. Note the 30s revocation cache (`lib/session-cache.ts`) — stale "valid" can persist up to 30s per warm instance; that's expected, not an incident.
- **Immediate mitigation:** If caused by an errant script/admin action, stop it. Sessions can't be "un-revoked" — affected users simply log in again; communicate if widespread.
- **Permanent fix:** Gate bulk-revoke tooling behind confirmation; audit who triggered it.
- **Verification:** No new spurious `SESSION_REVOKED` rows; users can re-establish sessions.

### 3.3 Rate limiting broken
- **Two failure modes:** (a) **off when it should be on** — brute-force exposure; (b) **on too aggressively** — legitimate users 429'd.
- **Diagnosis:** Check `RATE_LIMIT_ENABLED`. Grep logs for `[rate-limit] BLOCK` (enforcing) vs `SHADOW` (log-only) vs absence (disabled/fail-open). Note the limiter fails **open** on store errors by design, and the DB-backed `RateLimit` table backs production.
- **Immediate mitigation:** If under active brute force with limits off → set `RATE_LIMIT_ENABLED=true` (redeploy/env update) and treat as §7 API abuse. If false-positive 429s → flip `RATE_LIMIT_SHADOW=true` to log-only while tuning windows, or temporarily raise limits.
- **Permanent fix:** See `SECURITY_CHECKLIST.md` C1/C2 (login/TOTP call-site coverage). Do not leave shadow mode on indefinitely.
- **Verification:** Scripted over-limit request returns 429 (enforcing) or logs SHADOW; legit users unaffected.

### 3.4 Password reset failing
- **Diagnosis:** Reset depends on email delivery (Resend) + token write. Check Resend status (§6). Check `forgot-password`/`reset-password` logs. Token is `randomBytes(32)`, SHA-256-hashed, 1h TTL, single-use — an "expired/invalid" spike may mean clock skew or a reused link.
- **Immediate mitigation:** If Resend is down → communicate delay; resets queue on the user side (they re-request). If token logic regressed in a deploy → roll back.
- **Permanent fix:** Address root email/token cause.
- **Verification:** End-to-end reset on a test account completes; all sessions revoked on success; `PASSWORD_RESET_COMPLETE` audited.

### 3.5 Email verification broken
- **Diagnosis:** New signups blocked at login by the verification gate (`emailVerifiedAt` null). Check verification email delivery (Resend) and that consumption is POST-only (scanners hitting the GET page shouldn't burn tokens). Check `[register]`/`[verify-email]` logs.
- **Immediate mitigation:** If email delivery is the cause → §6 Resend. If the gate is over-blocking due to a regression → roll back. Do NOT disable the verification gate as a "fix" (security regression).
- **Permanent fix:** Fix delivery/token path.
- **Verification:** New account verifies and logs in; `EMAIL_VERIFIED` audited.

### 3.6 TOTP failures
- **Diagnosis:** Server clock skew breaks TOTP (±1 step window). Confirm Vercel function time is correct. Check `decryptWithPurpose(..., TOTP_SECRET)` isn't throwing (would indicate `ENCRYPTION_KEY` problem → §7 secret exposure/rotation). Distinguish "user's authenticator drifted" (single user) from systemic.
- **Immediate mitigation:** Systemic clock issue → platform-level, usually resolves; if a user is locked out, they use a **recovery code**, or an admin performs a 2FA reset (`/api/admin/security/users/[userId]/2fa-reset`, requires `confirmToken:"RESET"`). If `ENCRYPTION_KEY` is wrong → do NOT guess; restore the correct key (§7).
- **Permanent fix:** If key-related, follow rotation runbook; never change `ENCRYPTION_KEY` without the re-encryption plan.
- **Verification:** Test account with TOTP logs in; recovery-code path works; `TWO_FACTOR_*` audit rows correct.

---

## 4. Database Incidents

**Purpose:** Restore a healthy, consistent Postgres. Data-integrity incidents are SEV-1.
**Owner:** OPS-owner + PO1 · **Priority:** Critical
**Verification:** app can read+write; `npx prisma migrate status` clean; connection count normal.
**Recovery Criteria:** no drift, no corruption, no elevated errors, and a backup exists that predates the incident.

### 4.1 Migration failure
- **Diagnosis:** Vercel build/deploy log shows a failed migration, or `migrate status` shows a partially-applied/failed migration. Identify whether it half-applied (some DDL committed).
- **Immediate mitigation:** **Stop deploys.** If the migration is additive and reversible, apply the documented down-path or a forward-fix migration. If destructive, restore from the pre-migration backup (§4.6). Never hand-edit the migrations table without recording it.
- **Permanent fix:** Add "tested on prod-like clone" gate (RELEASE_CHECKLIST §3).
- **Verification:** `migrate status` clean; app boots; targeted reads/writes on affected tables succeed.

### 4.2 Corruption / wrong data
- **Diagnosis:** Compare against a backup; identify the writing code path and blast radius (which rows, since when). Check recent deploys and the deletion pipeline (§5.4) as a source.
- **Immediate mitigation:** **Freeze the offending write path** (disable the feature/flag or roll back). Preserve current state (snapshot) before any correction. Correct from backup for the affected rows only where possible.
- **Permanent fix:** Add validation/constraint; regression test.
- **Verification:** Row counts and spot-checks match expected; no further bad writes.

### 4.3 Connection failures
- **Diagnosis:** `[db]`/Prisma connection errors; check DB host status, connection-pool exhaustion (serverless can spike connections), and `DATABASE_URL`/`DIRECT_URL` correctness.
- **Immediate mitigation:** If pool exhausted → reduce concurrency / confirm pooled connection string in use; restart functions via redeploy if a leak is suspected. If host down → provider incident (§6-style), communicate SEV.
- **Permanent fix:** Connection pooling / limits review.
- **Verification:** Connections return to baseline; errors clear.

### 4.4 Lock contention
- **Diagnosis:** Slow queries + timeouts; long-running transaction or a migration holding a lock. Identify the blocking query.
- **Immediate mitigation:** Terminate the offending long transaction if safe; pause the job/migration causing it. Recall the KD-4 rule — external calls (Plaid `itemRemove`) run **outside** DB transactions, so a stuck provider call should not hold a DB lock; if it appears to, investigate.
- **Permanent fix:** Shorten transaction scope; add indexes if a scan is the cause.
- **Verification:** Locks clear; query latency normalizes.

### 4.5 Prisma issues
- **Diagnosis:** Client/schema mismatch (`prisma generate` not run), or a validation error post-deploy.
- **Immediate mitigation:** If generated client is stale relative to schema → roll back to the matching build. Do not push a schema change to fix a client mismatch mid-incident.
- **Verification:** App queries succeed; types match schema.

### 4.6 Rollback / backup / restore guidance
- **Rollback:** Application rollback (§8) does NOT undo a migration. If a migration must be reversed, use its down-path or restore.
- **Backup:** Confirm automated backups / PITR exist at the DB provider (a RELEASE/ SECURITY prerequisite). **Take an immediate manual backup before any corrective DDL or restore.**
- **Restore verification:** Restore to a **scratch** DB first; verify row counts, run smoke reads, confirm the app boots against it; only then cut over. Record RTO/RPO. Never restore over production without a fresh backup of the current (broken) state first — you may need it for the postmortem.

---

## 5. Background Jobs

**Purpose:** Keep the three crons correct and idempotent; a stuck deletion job is SEV-1, others typically SEV-2.
**Owner:** OPS-2 (deletion/lifecycle), OPS-owner (sync/FX), OPS-3 (notifications, future) · **Priority:** High (Critical for deletion)
**Verification:** cron invocation returns 200 with `{ ok: true, ... }`; check Vercel cron logs at the scheduled UTC times.
**Recovery Criteria:** job completes for all due items with no double side effects; next scheduled run is clean.

### 5.1 Cron failures (any job)
- **Diagnosis:** Check Vercel → Crons for last run status. A `401` means `CRON_SECRET` is missing/mismatched (routes require `Authorization: Bearer ${CRON_SECRET}`; unset silently 401s the job). A timeout means the run exceeded `maxDuration=60`.
- **Immediate mitigation:** Restore/set `CRON_SECRET` if missing. Crons are **self-healing** — a missed run is retried on the next daily schedule; you can also trigger manually with the correct bearer header if urgent.
- **Idempotency verification:** All three jobs are safe to re-run (see below). Re-running is the normal recovery.
- **Verification:** Manual invocation returns `{ ok: true }`; next scheduled run green.

### 5.2 FX sync (`fetch-fx-rates`, 06:30 UTC)
- **Diagnosis:** Missing/stale FX rates → conversions fall back to native sums. Check the rate source/API and the job log.
- **Immediate mitigation:** Re-run the job; it upserts rates idempotently. Degradation is graceful (stale rates, not wrong data).
- **Verification:** Latest FX rows updated; multi-currency Space totals convert correctly.

### 5.3 Plaid sync (`sync-banks`, 06:00 UTC)
- **Diagnosis:** Balances/transactions not updating. Distinguish Plaid outage (§6) from our error. Job runs one attempt per item, per-item error isolation. Deactivated users' items are skipped by design.
- **Immediate mitigation:** If Plaid is down → wait/communicate; re-run after recovery (idempotent per item; manual Refresh cooldown is independent). If our regression → roll back.
- **Idempotency verification:** Re-running does not duplicate transactions (matched by Plaid IDs / reconcile logic).
- **Verification:** Item `lastSync` advances; balances current; no duplicate rows.

### 5.4 Deletion pipeline (`process-deletions`, 07:00 UTC) — handle as SEV-1 if misbehaving
- **Diagnosis:** Check the run log for purge counts. The pipeline re-checks `deletionScheduledAt > now` inside `purgeUser` before deleting (guards the cancel-vs-purge race). A user who cancelled is skipped (`not-due`). Confirm it is only purging genuinely-due accounts.
- **Immediate mitigation:** If it is deleting incorrectly (early, or cancelled accounts) → **stop the cron immediately** (disable in `vercel.json` via a deploy, or pull `CRON_SECRET`) and open SEV-1. Preserve `AuditLog` (`ACCOUNT_DELETED` rows carry the SHA-256 email hash + counts). Assess whether restore from backup is needed for wrongly-purged users.
- **Idempotency / resumability verification:** A mid-purge failure leaves the `User` row intact so the next run resumes; Plaid `itemRemove` runs outside transactions and items are marked REVOKED so a resumed run won't re-remove. The cron IS the retry — do not build ad-hoc retries.
- **Verification:** Only due accounts purged; cancelled accounts untouched; audit trail complete.

### 5.5 Notification delivery (OPS-3, future)
- **Diagnosis:** Once OPS-3 ships, notification/queue failures land here. Until then, "notifications" = transactional email via Resend (§6).
- **Owner:** OPS-3 · **Mitigation/Verification:** to be defined when the notification system exists (see Incident Maturity → Future).

---

## 6. Third-Party Providers

**Purpose:** Decide fast whether an outage is ours or theirs, degrade safely, and verify recovery.
**Owner:** PO1 (coordination) + relevant OPS owner · **Priority:** High
**General "ours vs theirs" test:** reproduce with a minimal direct call / check the provider's status page; if their status page is red or a direct call fails identically outside our app, it's theirs. If only our app fails, it's ours — check the latest deploy and our integration code.
**General recovery criteria:** provider status green AND our dependent flow verified end-to-end.

### 6.1 Plaid
- **Ours or theirs:** Check Plaid status page; check `PLAID_ENV` and creds are correct; a `parsePlaidError` code in `[plaid]` logs distinguishes auth/config errors (ours) from provider 5xx (theirs).
- **Safe degradation:** Bank sync/link fails but the rest of the app works; balances go stale, not wrong. Manual accounts unaffected. Never block login or core reads on Plaid.
- **Recovery verification:** Link a sandbox item / run `sync-banks`; balances update; no duplicate transactions.

### 6.2 Resend (email)
- **Ours or theirs:** Check Resend status + `RESEND_API_KEY` validity + domain verification. `sendEmail` is non-throwing and returns a status; logs show `email...failed to send`. If the transport is capture (no key), no real mail sends — confirm the key is set in prod.
- **Safe degradation:** Email is best-effort — password change/deactivate/delete still succeed even if the alert email fails. Reset/verify are the exception: those flows depend on delivery, so a Resend outage degrades reset/verification (communicate).
- **Recovery verification:** Test reset + security-alert land in inbox (not spam); SPF/DKIM/DMARC intact.

### 6.3 Vercel
- **Ours or theirs:** Check Vercel status + the specific deployment's function logs. Build failing = ours (code/env). Platform 5xx / region `sin1` degraded = theirs.
- **Safe degradation:** Limited — Vercel is the host. If a deploy is bad, roll back (§8). If the platform is down, communicate and wait; there is no failover today (see Incident Maturity).
- **Recovery verification:** Smoke test the site; error rate normal.

### 6.4 GitHub
- **Ours or theirs:** Check GitHub status. Affects CI/deploys, not runtime.
- **Safe degradation:** Running production is unaffected by a GitHub outage; only shipping is blocked. Do not force a workaround deploy path mid-incident.
- **Recovery verification:** CI/deploy pipeline green again.

---

## 7. Security Incidents

**Purpose:** Contain, preserve evidence, and recover from compromise. Default SEV-1.
**Owner:** OPS-2 + PO1 (+ OPS-5 for admin/privilege) · **Priority:** Critical
**Reference:** Use `SECURITY_CHECKLIST.md` for control details and post-incident hardening; this section is the *response*, not the control list.
**General recovery criteria:** attacker access cut, secrets rotated where exposed, audit trail preserved, affected users notified, and the exploited gap closed or ticketed.

### 7.1 Credential compromise (account takeover)
- **Immediate containment:** Revoke the user's sessions (`revokeAllUserSessions`); force a password reset (which itself revokes all sessions on completion). If 2FA was disabled by the attacker, re-require enrollment.
- **Session revocation:** targeted per-user; confirm `UserSession.revokedAt` set and revocation cache cleared.
- **Key rotation:** not required unless a platform secret was involved.
- **User communication:** notify the affected user (see §9 template); security-alert emails already fire on password/email/session changes.
- **Audit preservation:** export `AuditLog` for the account (`LOGIN`, `LOGIN_FAILED`, `SESSION_REVOKED`, IP/UA) before it rolls off.
- **Recovery verification:** attacker sessions dead; user regains control with new credentials + 2FA.

### 7.2 Suspicious login activity (spray / stuffing)
- **Immediate containment:** Ensure `RATE_LIMIT_ENABLED=true`; identify source IPs from `LOGIN_FAILED` audit rows; block at Cloudflare if concentrated.
- **Note the current gap:** login/TOTP brute-force protection depends on `SECURITY_CHECKLIST.md` C2 (call-site coverage) — if not yet shipped, Cloudflare rate/WAF rules are the interim containment.
- **Recovery verification:** failed-login rate returns to baseline; no successful takeover in the window.

### 7.3 API abuse
- **Immediate containment:** Identify the endpoint + key (IP/user) from logs; enable/tighten the relevant `limitBy*` limit or add a Cloudflare rule; revoke the abusing session/user if authenticated.
- **Recovery verification:** abusive traffic dropped; legitimate traffic unaffected.

### 7.4 Rate-limit bypass
- **Immediate containment:** Confirm whether limits are actually enforcing (`RATE_LIMIT_ENABLED`, not `SHADOW`, not failing open on store errors). Check the endpoint even has a `limitBy*` call site (login callback historically did not — C2). Add Cloudflare enforcement as a backstop.
- **Recovery verification:** over-limit requests blocked; add the missing call site as a follow-up (OPS-2).

### 7.5 Privilege escalation
- **Immediate containment:** If a user gained admin or cross-Space access, revoke their sessions immediately. Remember JWT `role` is baked in for up to 30 days — **session revocation, not a DB role change, is what cuts admin access now** (H3). Set `DISABLE_SYSTEM_ADMIN=true` to lock all admin logins if an admin account is suspect.
- **Owner:** OPS-5 for follow-up least-privilege review.
- **Audit preservation:** capture admin `AuditLog` rows (`performedByAdminId`).
- **Recovery verification:** escalated access gone; authz path fixed or ticketed; no cross-tenant data reachable.

### 7.6 Secret exposure
- **Immediate containment:** Rotate the exposed secret immediately, understanding the blast radius:
  - `NEXTAUTH_SECRET` → rotating logs everyone out (mass re-login; communicate).
  - `ENCRYPTION_KEY` → **do NOT casually rotate**; it decrypts Plaid tokens, TOTP secrets, DOB. Rotation requires the re-encryption runbook (OPS-4). If truly exposed, follow that process; interim, restrict access and assess exposure.
  - `CRON_SECRET` → rotate; update Vercel env; crons resume next run.
  - `RESEND_API_KEY` / Plaid keys → rotate at the provider + update env.
  - `DATABASE_URL` credentials → rotate DB password + update env.
- **Audit preservation:** capture logs; determine what the secret could access and for how long.
- **User communication:** if user data was reachable, notify per §9 and any legal obligation.
- **Recovery verification:** old secret invalid; app healthy on the new secret; exposure vector closed (e.g., secret removed from logs/repo).

---

## 8. Rollback Procedure

**Purpose:** Return production to the last known-good deployment safely.
**Owner:** PO1 + OPS-owner · **Priority:** Critical
**Verification:** each box checked with the target commit SHA recorded.
**Recovery Criteria:** previous version serving, all subsystems verified, incident closed or downgraded.

```
□ Stop deployment (freeze; no new deploys until rollback verified)
□ Redeploy previous version (Vercel → Deployments → promote last known-good build; record SHA)
□ Verify database compatibility (does the old code match the current schema? if a migration shipped with the bad release, see §4.6 — app rollback does NOT revert migrations)
□ Verify migrations (migrate status clean; no half-applied migration left behind)
□ Verify authentication (test account logs in; session holds; TOTP works)
□ Verify cron jobs (CRON_SECRET intact; trigger one job manually → { ok: true })
□ Verify notifications/email (test reset or security-alert delivers)
□ Verify logging (logs flowing; no secret leakage)
□ Smoke test (register→login→space read→Plaid status→export; core paths green)
□ Close incident (or downgrade severity; start postmortem)
```

**Critical caveat:** if the bad release included a **destructive migration**, rolling back the app can leave old code against a new schema. Prefer a forward-fix or a coordinated restore (§4.6) in that case. Decide explicitly and record the decision.

---

## 9. Communication

**Purpose:** Keep stakeholders and users accurately informed without over- or under-stating.
**Owner:** Comms lead (Incident Commander if solo) · **Priority:** High
**Verification:** updates posted on cadence; templates filled, not skipped.
**Recovery Criteria:** final "resolved" message sent internally and (if user-facing) externally.

**SEV-1 cadence:** internal update every **15 minutes** until stabilized, then every 30–60 min until resolved. SEV-2: at least at detection, mitigation, and resolution.

### Internal update template
```
[INCIDENT][SEV-_] <short title>
Time: <UTC>
Status: investigating | identified | mitigating | monitoring | resolved
Impact: <who/what is affected, blast radius>
Current theory: <root cause hypothesis>
Actions in progress: <what we're doing now>
Next update: <time>
Commander: <name> · Scribe: <name>
```

### User-facing status update template
```
We're aware of an issue affecting <feature, in plain language> starting around <time>.
Your data is safe. <If true: no action needed. / If needed: what to do.>
We're actively working on it and will post an update by <time>.
```
*(Only state "your data is safe" if verified. Never speculate on cause publicly during an active incident.)*

### Post-incident notification template
```
Between <start> and <end> (UTC), <feature> was <impact>. The cause was <plain-language root cause>.
It is now resolved. <What we did.> <What, if anything, users should do.>
We're taking the following steps to prevent recurrence: <1–3 items>.
Questions: <contact>.
```

---

## 10. Postmortem

**Purpose:** Learn from the incident and prevent recurrence. **Blameless — focus on systems, not people.**
**Owner:** Incident Commander (drafts within 48h of resolution) · **Priority:** High
**Verification:** document completed; preventive actions ticketed with owners + due dates.
**Recovery Criteria:** action items tracked to closure in the roadmap.

### Template
```
# Postmortem — <title>  (SEV-_)
Date of incident: <UTC range>   Authors: <names>   Status: draft | final

## Summary
<2–3 sentences: what happened and the user impact.>

## Timeline (UTC)
- <time> — <event: detection, action, escalation, resolution>
- ...

## Root cause
<The systemic cause. Trace to the mechanism, not "someone forgot".>

## Detection
<How we found out. How long until detection. Could monitoring have caught it sooner?>

## Impact
<Users/Spaces affected, duration, data integrity, any data loss, financial/trust impact.>

## Resolution
<What actually fixed it.>

## What went well / what went poorly
<Honest, blameless.>

## Preventive actions
| Action | Owner | Initiative | Due | Status |
|---|---|---|---|---|
| <e.g. add login rate-limit call site> | OPS-2 | OPS-2 | <date> | open |

## Lessons learned
<Durable takeaways for the runbook / checklists.>
```

**Rule:** every SEV-1 gets a written postmortem. SEV-2 gets one if it recurred or had notable impact. Feed lessons back into this runbook, `SECURITY_CHECKLIST.md`, and `RELEASE_CHECKLIST.md`.

---

## 11. Operational Runbooks

One-page procedural checklists for the most common recurring issues. Each is self-contained.

### RB-1 · User cannot log in
```
□ Scope: one user or many? (many → §3.1, likely SEV-1)
□ Confirm account state: emailVerifiedAt set? deactivatedAt / deletionScheduledAt set?
   (unverified/deactivated/pending-deletion are BY DESIGN blocks — see login gates)
□ Check LOGIN_FAILED AuditLog reason (user_not_found | invalid_password | email_unverified |
   account_deactivated | pending_deletion | totp_required | totp_invalid | recovery_code_invalid)
□ If password: guide to reset (RB-2). If TOTP: RB via recovery code or admin 2FA reset.
□ If rate-limited (429): confirm limits not misconfigured (§3.3)
□ Verify: test login for that account succeeds; new LOGIN row
```

### RB-2 · Cannot reset password
```
□ Check Resend status + RESEND_API_KEY set (capture transport = no real email)
□ Check forgot-password logs; confirm email dispatched (emailStatus in audit metadata)
□ Ask user to check spam; confirm they use the latest link (single-use, 1h TTL)
□ If delivery broken → §6.2; if token logic regressed → §8 rollback
□ Verify: end-to-end reset on test account; PASSWORD_RESET_COMPLETE audited; sessions revoked
```

### RB-3 · Plaid sync stuck
```
□ Plaid status page — outage? (theirs → wait/communicate)
□ Check sync-banks last run + [plaid] error codes (parsePlaidError)
□ Confirm PLAID_ENV + creds correct; item not in error/revoked state
□ Re-run sync-banks (idempotent; won't duplicate transactions)
□ Verify: item lastSync advances; balances current; no duplicate rows
```

### RB-4 · Notification queue backed up (FUTURE — OPS-3)
```
□ (Until OPS-3) notifications = transactional email → use RB-2 / §6.2
□ (Post-OPS-3) check queue depth, worker health, dead-letter count
□ Drain/retry per idempotency keys; confirm no duplicate sends
□ Verify: queue depth returns to baseline; sample notification delivered once
Owner: OPS-3
```

### RB-5 · Cron not running
```
□ Vercel → Crons: last run status/time for the affected job
□ 401? → CRON_SECRET missing/mismatched → restore env var
□ Timeout? → exceeded maxDuration=60 → check volume; next run resumes
□ Manually trigger with Authorization: Bearer <CRON_SECRET> if urgent
□ Verify: run returns { ok: true }; next scheduled run green
```

### RB-6 · Export failing
```
□ Check user/export logs; requireFreshUser passing? (revoked session → 401 by design)
□ Rate limit: 3/day/user — 4th returns 429 by design (not a bug)
□ Check assemble/zip errors; large-account timeout?
□ Verify: test export on a representative account downloads a valid ZIP; DATA_EXPORTED audited
```

### RB-7 · Deletion pipeline paused / misbehaving  (SEV-1 if deleting wrong data)
```
□ If purging incorrectly → STOP the cron NOW (pull CRON_SECRET or disable in vercel.json) → SEV-1
□ Check process-deletions log: purged vs skipped(not-due/already-deleted) counts
□ Confirm only accounts past grace (deletionScheduledAt <= now) are purged
□ Preserve AuditLog ACCOUNT_DELETED rows (email hash + counts)
□ If wrongful deletion → assess restore from backup (§4.6)
□ Verify: cancelled accounts untouched; only due accounts purged; resumable on next run
```

### RB-8 · Unexpected database growth
```
□ Identify the growing table (transactions? AuditLog? RateLimit buckets? snapshots?)
□ Check for a runaway writer: duplicate sync, retry loop, or missing RateLimit cleanup
□ Confirm no PII/log bloat; check connection + storage metrics
□ Mitigate: pause the offending writer; schedule cleanup of aged rows (audit-retention is a Future policy)
□ Verify: growth rate returns to baseline
```

### RB-9 · High error rate
```
□ Vercel logs: which route/function? one endpoint or global?
□ Correlate with latest deploy time — deploy-induced? → §8 rollback
□ DB or provider dependency? → §4 / §6
□ Check for a 500 spike from withApiHandler ([api] <context> unhandled error)
□ Mitigate root cause or roll back; watch error rate return to baseline
□ Verify: error rate normal for 15+ min; no user-facing breakage
```

---

## 12. Production Recovery Checklist

**Purpose:** The gate for declaring an incident resolved. All green before closing a SEV-1/2.
**Owner:** Incident Commander · **Priority:** Critical
**Verification:** each box confirmed by a named person with a timestamp.
**Recovery Criteria:** every box checked; monitoring stable for a sustained window (≥15–30 min).

```
□ Authentication healthy (test login + TOTP + session hold + fresh-revocation on sensitive action)
□ Database healthy (migrate status clean; reads/writes OK; connections + locks normal)
□ Background jobs healthy (each cron authed and returning { ok: true }; next runs scheduled)
□ Emails healthy (test reset/security-alert delivers; not spam-filed)
□ Notifications healthy (OPS-3 when live; until then = emails above)
□ No elevated errors (error rate back to baseline for ≥15 min)
□ No elevated latency (p95 back to baseline)
□ Monitoring green (dashboards/alerts clear)
□ Security validated (no open containment items; secrets rotated where exposed; SECURITY_CHECKLIST consulted)
□ Release checklist completed (if a fix/rollback shipped — RELEASE_CHECKLIST §10 gate)
□ Incident closed (severity cleared; postmortem opened for SEV-1)
```

---

## 13. Incident Maturity

Where Fourth Meridian's incident-response capability stands, and what each level requires. Levels are cumulative. Improvements are mapped to owning initiatives so this doubles as an ops roadmap.

### ☐ Reactive — *current baseline*
We respond when something breaks; detection is often a user report.
Have: this runbook, Vercel/provider dashboards, AuditLog, manual rollback.
Gaps to close: proactive monitoring, defined on-call.

### ☐ Managed
Consistent process; incidents are classified, communicated, and postmortem'd.
Requires:
- Severity + comms process used every time (this doc, adopted).
- `CRON_SECRET`, `RATE_LIMIT_ENABLED`, backups verified in prod (**PO1**).
- Blameless postmortems for every SEV-1 with tracked actions (**PO1**).
- Deploy freeze + rollback drilled at least once (**PO1**).

### ☐ Measured
We detect before users do; we know our numbers.
Requires:
- Monitoring + alert thresholds: error rate, latency p95, auth-failure surge, cron success (**PO1**).
- Restore test completed with recorded RTO/RPO (**PO1**).
- Login/TOTP brute-force protection enforcing (**OPS-2**, SECURITY C2/H1).
- Structured logging + log retention; dashboards per subsystem (**PO1**).

### ☐ Highly Available
Incidents rarely become user-facing outages.
Requires:
- Automated alerting → paging with clear on-call ownership (**PO1**).
- Key-rotation runbook exercised for `ENCRYPTION_KEY` (**OPS-4**).
- Notification/queue observability and DLQ handling (**OPS-3**).
- Graceful-degradation verified for every third party (Plaid/Resend/DB) (**OPS-3/PO1**).
- Admin de-privileging propagation solved (**OPS-5**, SECURITY H3).

### ☐ Enterprise Operations
Contractual reliability and compliance-grade response.
Requires:
- Defined SLOs/SLAs + error budgets; DR failover strategy beyond single-region `sin1` (**Future/PO1**).
- Multi-region or read-replica resilience; tested DR drill (**Future**).
- Formal audit-retention + data-retention enforcement (**Future**).
- Third-party pen-test + compliance controls (SOC2-style), incident reporting obligations documented (**Future**).
- Least-privilege admin model with impersonation controls + full audit trail (**OPS-5**).

**Roadmap mapping (open improvements):**
- **OPS-2:** login/TOTP brute-force enforcement; auth-incident tooling.
- **OPS-3:** notification/queue observability; degradation playbooks.
- **OPS-4:** `ENCRYPTION_KEY` rotation runbook (referenced by §7.6).
- **OPS-5:** admin least-privilege + de-privileging propagation; impersonation audit.
- **PO1:** monitoring/alerting/paging, backups + restore drills, log retention, deploy-freeze/rollback tooling.
- **Future:** SLOs, multi-region DR, retention policy, pen-test/compliance.

---

*Living document. Keep it accurate — an out-of-date runbook is worse than none during a SEV-1. Review after every incident and at each release gate. Documentation only — no code, schema, or STATUS changes.*
