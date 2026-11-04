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

## Synthetic Preview operator (acceptance testing)

One fabricated Platform operator for acceptance testing on **Preview** (or a
local / throwaway database). It is never used on Production. The owner authorized
it and S2 approved the method. Script: `scripts/synthetic-operator.ts`. The rules
are in `scripts/lib/synthetic-operator.core.ts` and are pinned by
`scripts/synthetic-operator.test.ts`.

```
npm run ops:synthetic-operator -- --env=preview --provision
npm run ops:synthetic-operator -- --env=preview --revoke-area=GROWTH_REVENUE
npm run ops:synthetic-operator -- --env=preview --cleanup --record=<private dir>
```

- **Gate (before any contact):** the repair env guard runs in apply mode, the
  same way the Platform AI purge dispatch uses it. `--env=preview` requires
  `FM_PRODUCTION_DB_REF`, and the target's ref must not be that ref.
  `--env=production` is always refused. So are `VERCEL_ENV=production`, a
  DATABASE_URL/DIRECT_URL mismatch and any unknown flag. Refusals name the rule
  only.
- **Account:** one `USER` with the fabricated name "Synthetic Operator" and a
  reserved `@example.test` address. Its email is pre-verified. **No TOTP is
  provisioned:** a seed sealed with the script's own `ENCRYPTION_KEY` would not
  open under the deployment's key, and Preview's key (a Vercel Sensitive value)
  is never pulled. Where operator 2FA is enforced, the operator enrols through
  the app's own `/api/user/totp` setup at first sign-in. The account has the same shape registration creates: Personal Space,
  OWNER membership, agent, default policy group and a `REGISTER` audit row. It
  has no other Space, no provider connection and no customer data. The password
  is hashed the way registration does it (bcryptjs, cost 12).
- **Grants (hard-coded allowlist):** `PLATFORM_OPS` READ and `GROWTH_REVENUE`
  READ. It never grants CUSTOMER_SUCCESS, MERCHANT_OPS, WRITE/CONTROL or
  SYSTEM_ADMIN. Each grant or revocation is written in one transaction with its
  canonical audit row (`PLATFORM_GRANT_CREATED` / `PLATFORM_GRANT_REVOKED`).
  The actor is null, `actorType: SYSTEM`, and the reason is
  "synthetic acceptance operator". It never calls the admin grant routes or any
  notification or e-mail module.
- **Secrets:** they go only to
  `~/FourthMeridian-private/synthetic-operator-<UTC stamp>/credentials.json`
  (umask 077, dir 0700, file 0600): the password, user
  and grant ids, and the cleanup deadline. The deadline is
  min(provision + 14 days, 2026-11-19T23:59:59Z). Stdout prints PASS lines, the
  private directory and the deadline only. If a synthetic operator already
  exists, provisioning is refused and nothing changes.
- **Cleanup, in order:** (1) revoke the remaining ACTIVE grants, audited.
  (2) Delete the account through the account-deletion path. This writes the
  deletion-request stamp with a **zero** grace window (a deviation from the
  7-day user path: the account has a hard deadline and nobody to cancel it) plus
  `ACCOUNT_DELETION_REQUESTED`. Then it calls `purgeUser()`, the function
  `jobs/process-deletions.ts` calls. Sessions, TOTP, grants, Space,
  conversations and messages cascade, and one `ACCOUNT_DELETED` row is written.
  The purge's after-commit e-mail and its Plaid call are injected as no-ops, so
  nothing is sent. (3) Print the purge-dispatch instruction for the operator to
  run: `npm run ops:platform-ai-conversations-purge -- --env=preview`.
  (4) Shred `credentials.json` (overwrite, then unlink). (5) Write a counts-only
  `cleanup.json` (0600). Removal means our app database only. Backups age out on
  their own schedule.
- **Acceptance:** `npm run rls:accept:synthetic-operator` runs the real CLI on a
  throwaway Docker Postgres (`docker rm -f -v`): provision, refused re-provision,
  revoke, cleanup, then zero rows left.

## Related runbooks

- [key-rotation](./key-rotation.md) · [incident-response](./incident-response.md) ·
  [security checklist](../architecture/SECURITY_MODEL.md#security-checklist-release-gate) · [background-jobs](./background-jobs.md)
- Provider/connection operations: [systems/platform-operations](../systems/platform-operations.md)
