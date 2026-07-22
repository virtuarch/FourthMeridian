# Admin Operations

*How administrators and platform operators actually operate the platform. The
authorization *model* is [SECURITY_MODEL](../architecture/SECURITY_MODEL.md); this is
the operational runbook that sits on top of it.*

## Who operates what

| Surface | Who reaches it | How it is gated |
|---|---|---|
| `/admin/*` (admin console) | `SYSTEM_ADMIN` only | `requireSystemAdmin` / `requireFreshSystemAdmin`; edge-redirected by `proxy.ts` |
| `/dashboard/platform/[area]` (HQ Spaces) | holders of a `PlatformGrant` for that area | `requirePlatformAccess(area, level)` — grant-gated, **not** admin-gated |
| a customer Space | its `SpaceMember`s | `requireSpaceRole(spaceId, minRole)` |

`SYSTEM_ADMIN` reaches an HQ area only via its break-glass bypass — it is not the
normal path. Day-to-day operator work is a plain `USER` account holding one or more
per-area `PlatformGrant`s (least-privilege, zero customer-data reach).

## The admin console (`/admin`)

Real routes: `/admin/security`, `/admin/platform-access`, `/admin/platform-grants`.
Responsibilities: **issue/revoke `PlatformGrant`s** (only onto plain `USER` accounts),
user & space oversight, security settings, and audit review. It reads only operational
ledgers — never `Transaction`/`Holding`/`Position`/balance tables (source-scan
enforced). It is **not a customer Space.**

## Mandatory 2FA for admins (there is no password-only path to admin power)

- An **un-enrolled** `SYSTEM_ADMIN` is *always* forced into TOTP enrolment at login
  (`requireTotpSetup = true`), independent of the `REQUIRE_TOTP_*` platform settings.
  That session is rejected by every guard and confined by `proxy.ts` to
  `/admin/security?setup2fa=true` — it can complete enrolment and reach nothing else.
- An **enrolled** `SYSTEM_ADMIN` is challenged for a live TOTP (or a recovery code) on
  **every** login.
- **Bootstrap (no lockout):** the first login of a never-enrolled admin is
  password-only *into the enrolment flow only* — a zero-capability session. They enrol
  via `/api/user/totp/*` (which opt out of the gate), and every subsequent login is
  password + TOTP. This is mandatory-enrolment, chosen over outright denial so the sole
  founder-admin can never be locked out.
- **Kill switch:** `DISABLE_SYSTEM_ADMIN` rejects admin login pre-session.
- Customer authentication is unchanged — a normal `USER` is forced into enrolment only
  when the operator turns on `require_totp_all_users` (default off).

## Audit requirements for privileged actions

- **One append-only foundation: `AuditLog`.** No second table. It is append-only,
  `SET NULL`-on-delete, indexed on `(action, createdAt)`, with a dedicated
  `performedByAdminId` column for on-behalf-of actions.
- Every privileged read/write records: actor (`userId`), actor type
  (`metadata.actorType ∈ USER | SYSTEM_ADMIN | PLATFORM_OPERATOR | SYSTEM`), action
  (typed `AuditAction`), target (`{type, id}`), timestamp, result
  (`SUCCESS | FAILURE`), and metadata (counts/ids/kinds only — **never** financial
  values or user content).
- The successful-login event records the second factor used
  (`metadata.mfa = totp | recovery | none`). Failed logins go through the purpose-built
  `LOGIN_FAILED` recorder (with inline anomaly detection).
- Platform-ops **write** routes are additionally WRITE-grant-gated
  (`requireFreshPlatformAccess`) and audited — the machinery exists ahead of its first
  shipped write action.

## Related runbooks

- [key-rotation](./key-rotation.md) · [incident-response](./incident-response.md) ·
  [security-checklist](./security-checklist.md) · [background-jobs](./background-jobs.md)
- Provider/connection operations: [systems/platform-operations](../systems/platform-operations.md)
