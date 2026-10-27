# SEC-PLAT-1: mandatory operator TOTP, rollout and recovery plan

**Status:** PREPARED, NOT ACTIVATED. The branch `sec/platform-operator-mfa` will be a draft PR. Merging it to `develop` activates the policy on Preview, and promotion activates it on Production. **Both need explicit owner rollout approval.**
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

## 3. Rollout sequence (each step needs owner approval)

1. **Pre-enrol** every operator *before* activation:
   - Each operator: Settings → Security → Set up two-factor (scan, verify, store recovery codes).
   - Re-run §1 / §1.1. Target: `operators_without_totp = 0` on the environment about to be activated.
2. **Preview activation:** merge the SEC-PLAT-1 PR to `develop` (after the gates: `npm run ci` under the shared lock, then GitHub checks).
3. **Preview verification (owner's browser):**
   - (a) An enrolled operator opens every Platform area: unchanged.
   - (b) A throwaway USER with a READ grant and no TOTP: `/dashboard/platform/PLATFORM_OPS` redirects to enrolment, and an API call returns 403 `OPERATOR_TOTP_REQUIRED`. After enrolling: access works.
   - (c) That user tries to disable 2FA: 403.
   - (d) Security Ops shows the `platform_access_denied` trip with grant posture `mfa_required`.
   - (e) Revoke the throwaway grant and confirm 2FA can be disabled again. Then delete the throwaway account.
4. **Production:** run §1.1. If any operator lacks TOTP, they enrol first. Then promote with the normal release train (`develop` → `main`, Production deploy), and only on explicit approval.
5. **Post-deploy:** re-run §1.1 and spot-check one operator session on Production.

---

## 4. Recovery and rollback

| Situation | Recovery |
|---|---|
| Operator lost their authenticator, still has recovery codes | Sign in with a recovery code, then Settings → Security → regenerate the authenticator. |
| Operator lost the device and the recovery codes | A SYSTEM_ADMIN uses `/admin/security` → user → **Reset 2FA**. That requires the admin's own live TOTP and the literal `RESET`, revokes the user's sessions and emails them. The operator signs in, is refused Platform access, and enrols again. Grants stay intact throughout. |
| An operator must keep working without TOTP (exceptional) | Not supported by design. Revoke or downgrade the grant instead; there is no per-user bypass. |
| SYSTEM_ADMIN lost their own TOTP | Unchanged break-glass procedure: another SYSTEM_ADMIN resets it, or use DB-level recovery under the existing runbook. SEC-PLAT-1 does not touch SYSTEM_ADMIN. |
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
