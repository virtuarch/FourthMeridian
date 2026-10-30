# SEC-PLAT-1: mandatory operator TOTP, rollout and recovery plan

**Status:** PREPARED, NOT ACTIVATED (owner, 2026-10-27: request-level enforcement approved; #78 merge/activation NOT yet authorized). The branch `sec/platform-operator-mfa` will be a draft PR. Merging it to `develop` activates the policy on Preview, and promotion activates it on Production. **Both need explicit owner rollout approval.**
**Date:** 2026-10-27 · **Author:** Claude 2 · **Ruling:** P-2. Every ACTIVE Platform access holder must have TOTP, regardless of level.

---

## 1. Enrollment counts (read-only, aggregate only)

| Environment | ACTIVE grants without TOTP | Operators without TOTP / total operators | `require_totp_all_users` | How measured |
|---|---|---|---|---|
| **Preview** | 5 of 5 (CONTROL on all five areas: CUSTOMER_SUCCESS, GROWTH_REVENUE, MERCHANT_OPS, PLATFORM_OPS, SECURITY_OPS) | **1 / 1** | `false` | 2026-10-27 ~20:28 local. One `psql -1` transaction opened with `SET TRANSACTION READ ONLY` (`transaction_read_only = on` confirmed in the same transaction). Counts only, no identities. No session-level SET. |
| **Production** | **not measured** | **not measured** | **not measured** | Production database credentials are Vercel *Sensitive* and are not available on this machine. **Owner action:** run the query in §1.1 in the Supabase SQL editor (read-only). |

The single Preview operator holds CONTROL in every area. The owner should be able to tell whose account this is without an identity being disclosed here. Activating SEC-PLAT-1 on Preview today would refuse that operator's Platform access until they enrol.

### 1.1 Production query (read-only, aggregate)

```sql
BEGIN TRANSACTION READ ONLY;
SELECT g.area::text, g.level::text, u."totpEnabled" AS totp_enrolled,
       (u."deactivatedAt" IS NOT NULL) AS deactivated, count(*) AS grants
FROM "PlatformGrant" g JOIN "User" u ON u.id = g."userId"
WHERE g.status = 'ACTIVE'
GROUP BY 1,2,3,4 ORDER BY 1,2,3,4;
SELECT count(DISTINCT g."userId") FILTER (WHERE NOT u."totpEnabled") AS operators_without_totp,
       count(DISTINCT g."userId") AS operators_total
FROM "PlatformGrant" g JOIN "User" u ON u.id = g."userId" WHERE g.status = 'ACTIVE';
SELECT key, value FROM "PlatformSetting" WHERE key IN ('require_totp_all_users','require_totp_admins');
ROLLBACK;
```

---

## 2. What SEC-PLAT-1 changes

| Path | Before | After |
|---|---|---|
| Every Platform page and `/api/platform/**` / `/api/merchant-ops/**` route (shared guard) | ACTIVE grant ⇒ allowed | ACTIVE grant **and** `User.totpEnabled` ⇒ allowed. Otherwise 403 `OPERATOR_TOTP_REQUIRED`, recorded as a refusal (`mfa_required`). Read fresh on every request. |
| Platform pages for a grant holder without TOTP | open | redirect to `/dashboard/settings/security?setup2fa=true` (the existing enrolment screen) |
| `POST /api/user/totp/disable` | allowed with a fresh code | **403 while the caller holds any ACTIVE grant** |
| Admin security console | "Require TOTP for all Admins" toggle (never enforced since v2.0, `639e9a5`) | removed. Replaced by a locked line: "Require TOTP for Platform operators: Always on" |
| Admin grant matrix | no 2FA signal | "2FA off: Platform access waits for enrolment" badge |
| Login and session re-derivation | grant-blind | **unchanged in this phase** (see §5) |
| SYSTEM_ADMIN | mandatory TOTP at login | unchanged |
| Customers (non-operators) | TOTP opt-in | unchanged |

**Why the guard and not a login lockout.** A grant holder without TOTP keeps full use of their own personal account. Only Platform access waits until they enrol, and enrolment takes about a minute on the existing screen. Nobody can be locked out of their account by this change.

---

## 2a. Exact steps for Preview's one unenrolled CONTROL operator (do these BEFORE activation)

These steps work on Preview **today**, before SEC-PLAT-1 merges: enrolment is an existing feature and needs no deploy. Doing them first means activation changes nothing for this operator.

**Before you start.** Have an authenticator app on your phone (1Password, Authy, Google Authenticator or similar) and a safe place for 10 recovery codes (a password manager entry, not the same phone). Preview custom domains sit behind Vercel SSO, so use the browser that is already signed in to Vercel.

**Enrol (about 2 minutes):**
1. Sign in to the Preview app (`https://preview-app.fourthmeridian.com`) as the operator account.
2. Open **Settings → Security** (`/dashboard/settings/security`).
3. Click **Enable 2FA** in the two-factor section. The **"Set up two-factor authentication"** dialog opens.
4. Scan the QR code with the authenticator app. If you can't scan it, type the manual key shown under the QR code.
5. In **"Enter the 6-digit code from your app"**, type the current code and confirm.
6. The dialog switches to **"Save your recovery codes"**. Copy all ten into your password manager **now**; they are shown once.
7. Close the dialog. The section should read **"Two-factor authentication is now enabled."**

**Confirm it took (aggregate, read-only):** re-run the §1 count on Preview. Expect `operators_without_totp = 0`.

**Sign-in from now on:** after your password, enter the 6-digit code (or one unused recovery code).

**If something goes wrong on Preview:**

| Problem | What to do |
|---|---|
| The QR code won't scan | Use the manual key from step 4. |
| "Invalid code" in step 5 | Check that the phone's clock is set automatically, wait for the next code, and try again. Verification allows ±1 time step. |
| Lost the phone, still have recovery codes | Sign in with password + a recovery code. Then Settings → Security → **Disable** → **Lost device** (recovery code + password) and enrol again on the new phone. **Once SEC-PLAT-1 is active, turning 2FA off is refused for operators**, so use the next row instead. |
| Lost the phone and the codes | A SYSTEM_ADMIN signs in to `/admin/security`, finds the account and chooses **Reset 2FA** (confirm with `RESET` + their own live TOTP code). Your sessions are revoked and you get an email. Sign in with your password and enrol again (steps 2–7). Your grants are untouched. |
| No SYSTEM_ADMIN can sign in | The existing break-glass runbook applies (SYSTEM_ADMIN 2FA is mandatory and unchanged by SEC-PLAT-1). |

---

## 2b. Preview enrolment + recovery verification (prepared; run after §2a, BEFORE any activation)

**Owner rulings (2026-10-27, later):**
- Request-level enforcement is approved for the initial rollout.
- PR #78 is **not** authorized to merge or activate until the owner approves it explicitly, after enrolment.
- No login-database privilege change (Phase 2 stays separate).
- Production requires a verified operator count and a separate approval.

**V1. Enrolment took (read-only, aggregate; Claude 2 runs it on request).** The same `psql -1` + `SET TRANSACTION READ ONLY` helper as §1:
```sql
SELECT count(DISTINCT g."userId") FILTER (WHERE NOT u."totpEnabled") AS operators_without_totp,
       count(DISTINCT g."userId") AS operators_total
FROM "PlatformGrant" g JOIN "User" u ON u.id = g."userId" WHERE g.status = 'ACTIVE';
-- recovery codes held by enrolled operators (counts only; never a code or hash)
SELECT count(DISTINCT rc."userId") AS operators_with_unused_codes
FROM "RecoveryCode" rc JOIN "PlatformGrant" g ON g."userId" = rc."userId" AND g.status = 'ACTIVE'
WHERE rc."usedAt" IS NULL;
```
**Expect:** `operators_without_totp = 0`, and `operators_with_unused_codes = operators_total`.

**V2. Sign-in works with the second factor (owner, in their browser).**
1. Sign out.
2. Sign in with your password, then the 6-digit code.
3. Open `/dashboard/platform`. Every area should load exactly as before; no behaviour changes while #78 is unmerged.

**V3. Recovery path works (owner, optional but recommended before activation).**
1. Sign out.
2. Sign in with your password and **one** recovery code instead of the authenticator code. That code is now spent.
3. Re-run V1. `operators_with_unused_codes` is still `operators_total` because 9 codes remain.
4. If you'd rather not spend a code, skip V3. The admin Reset-2FA path in §2a covers a lost device and codes.

**V4. Gate for activation (owner decision).** Only when V1 shows `operators_without_totp = 0`:
1. The owner approves merging #78 to `develop`.
2. Claude 2 runs the full gate under the shared lock, merges, and verifies on Preview:
   - the operator still reaches every area;
   - Settings → Security → **Disable** answers "can't be turned off while you have Platform access";
   - the grant matrix shows no "2FA off" badge.

## 3. Rollout sequence (each step needs owner approval)

> **Updated 2026-10-30 (PLATFORM-SEC-1).** Enforcement now ships **dormant** behind a per-deployment
> switch: `OPERATOR_TOTP_ENFORCEMENT=enforce` turns it on (guard refusal, page redirects, and the
> 2FA-disable refusal together); unset = behaviour exactly as before. Merging no longer activates
> anything. Activation = setting the variable on one environment and redeploying; rollback = removing it.
> The same PR fixes the SYSTEM_ADMIN kill-switch gap on Platform APIs (§7) — that part is not gated.

1. **Pre-enrol** every operator *before* activation:
   - Each operator: Settings → Security → Set up two-factor (scan, verify, store recovery codes).
   - Re-run §1 / §1.1. Target: `operators_without_totp = 0` on the environment about to be activated.
2. **Preview activation:** merge the PR to `develop` (dormant), then set `OPERATOR_TOTP_ENFORCEMENT=enforce` on the Preview (develop) environment and redeploy develop. `/admin/security` shows **Enforced** once live.
3. **Preview verification (owner's browser):**
   - (a) An enrolled operator opens every Platform area: unchanged.
   - (b) A throwaway USER with a READ grant and no TOTP: `/dashboard/platform/PLATFORM_OPS` redirects to enrolment, and an API call returns 403 `OPERATOR_TOTP_REQUIRED`. After enrolling: access works.
   - (c) That user tries to disable 2FA: 403.
   - (d) Security Ops shows the `platform_access_denied` trip with grant posture `mfa_required`.
   - (e) Revoke the throwaway grant and confirm 2FA can be disabled again. Then delete the throwaway account.
4. **Production:** the code may reach Production dormant with any normal promotion. Activation is separate and only on explicit approval: run §1.1; every operator enrols and has working recovery codes (or a second SYSTEM_ADMIN able to reset); then set `OPERATOR_TOTP_ENFORCEMENT=enforce` on Production and redeploy.
5. **Post-deploy:** re-run §1.1 and spot-check one operator session on Production.

---

## 4. Recovery and rollback

| Situation | Recovery |
|---|---|
| Operator lost their authenticator, still has recovery codes | Sign in with a recovery code, then Settings → Security → regenerate the authenticator. |
| Operator lost the device and the recovery codes | A SYSTEM_ADMIN uses `/admin/security` → user → **Reset 2FA**. That requires the admin's own live TOTP and the literal `RESET`, revokes the user's sessions and emails them. The operator signs in, is refused Platform access, and enrols again. Grants stay intact throughout. |
| An operator must keep working without TOTP (exceptional) | Not supported by design. Revoke or downgrade the grant instead; there is no per-user bypass. |
| SYSTEM_ADMIN lost their own TOTP | Unchanged break-glass procedure: another SYSTEM_ADMIN resets it, or use DB-level recovery under the existing runbook. SEC-PLAT-1 does not touch SYSTEM_ADMIN. |
| Fast rollback (any environment) | Remove `OPERATOR_TOTP_ENFORCEMENT` (or set it to anything but `enforce`) and redeploy. Enforcement, page redirects and the disable refusal all switch off together; nothing else changes. |
| Full rollback | Revert the SEC-PLAT-1 merge commit on `develop` (and on `main` if promoted) and redeploy. No schema or data change to undo. The removed `require_totp_admins` row may still exist in `PlatformSetting`; nothing reads it, and a revert makes it visible again. |
| Partial rollback (keep the switch removal, drop enforcement) | Revert only the guard hunk in `lib/platform/authorize.ts` and the disable-route hunk. |

---

## 5. Phase 2 (optional, separate approval): force enrolment at login

The owner asked for "TOTP at login". Phase 1 enforces it on every *protected* request, and an enrolled operator is already challenged for a code on every login. Phase 1 does **not** force an un-enrolled operator into the enrolment screen at login.

That would require the session re-derivation (`lib/auth/session-proof.ts`, run as `fm_auth`) to know about grants. `fm_auth` can read only `User`, `UserSession` and `RecoveryCode`. Two options:
- **(a)** A migration granting `fm_auth` `SELECT` on `PlatformGrant` (`userId`, `status` only, via a policy). This widens the pre-identity role.
- **(b)** A denormalised `User.platformOperator` flag, maintained in the same transaction as grant changes (a schema change plus a backfill).

**Recommendation:** stay on Phase 1. It meets the ruling's intent (no privileged action without TOTP) without widening `fm_auth` or risking account lockout. Revisit if login-time forcing is wanted for its own sake.

---

## 6. Tests

`lib/platform/operator-mfa.test.ts` inverts the discovery characterization (G1–G5). It also checks:
- the guard's single fresh query;
- MFA is decided only after the grant;
- refusals are recorded;
- page redirects;
- the disable refusal comes before any secret check;
- the switch has no consumer left;
- the locked console line;
- the matrix badge;
- SYSTEM_ADMIN and customer rules are unchanged.

---

## 7. PLATFORM-SEC-1 companion fixes (same PR, 2026-10-30)

- **Kill switch on Platform APIs.** The SYSTEM_ADMIN break-glass bypass in `resolvePlatformAccess` now applies `decideAdminApiAccess` — the same rule as `/api/admin` — so `DISABLE_SYSTEM_ADMIN` and pending admin TOTP enrolment refuse Platform API calls too, including from sessions issued before the switch was flipped. Refusals are recorded (`break_glass_refused`). Not gated: it makes the documented invariant true.
- **Fleet-wide manual operations.** Running `sync-banks`, `sync-crypto` or `sol-history-backfill` from Manual operations needs fresh CONTROL and a structured reason (dry runs stay WRITE), matching single-wallet history resume.
- **Tests:** `lib/platform/platform-sec-1.test.ts` (mutation-checked: removing the kill-switch check, the CONTROL check or the MFA decision each fails it), plus the updated ratchets in `capability-control.test.ts`, `ops-write-access-gating.test.ts`, `operator-action-adoption.test.ts`, `operator-mfa.test.ts`, `rls-server-component-authority.test.ts`.
