# Doctrine — Platform & Security

*Governs the two authorization planes, the route-guard families, and the security boundaries that are expensive to retrofit and therefore must stay correct. Origin: the OPS-1 platform-operations foundation and the security architecture.*

## Two authorization planes — never merged

Fourth Meridian has **two independent authorization planes** that share the same UI shell frame but never share an authz decision:

1. **Customer tenancy — `SpaceMemberRole`.** Every Space grants one of `OWNER · ADMIN · MEMBER · VIEWER` (`prisma/schema.prisma`). This governs who can see and act within a customer's financial data. Membership rows are never deleted — removal is a status flip with provenance.
2. **Platform operations — `PlatformGrant`.** Platform-ops surfaces are gated by a `PlatformGrant` of an `area` (`PLATFORM_OPS · SECURITY_OPS · GROWTH_REVENUE · CUSTOMER_SUCCESS`) at a `level` (`READ · WRITE`). Grants are never deleted — revocation is a status flip mirroring `SpaceMember`.

**Rule: platform-ops data lives on a separate authz plane from customer tenancy, and never inside it.** Platform Spaces may render through the shared `SpaceShell` frame (see [spaces.md](./spaces.md)) for UI consistency, but a Space role can never confer a platform capability and a platform grant can never confer access to a customer Space. Putting privileged ops data inside customer tenancy would weaken the codebase's strongest boundary — this is why internal-ops Spaces remain parked rather than built inside customer tenancy.

`SYSTEM_ADMIN` is a distinct account role with a fully separate admin surface (`/admin`) and redacted provider diagnostics — not a Space role and not a substitute for a platform grant.

## Route-guard families

`proxy.ts` is the single edge chokepoint (Next.js middleware, matching `/dashboard/:path*` and `/admin/:path*`):

- Any `/dashboard/*` or `/admin/*` route requires a valid JWT session.
- `SYSTEM_ADMIN` users are redirected out of `/dashboard/*` to `/admin`; non-`SYSTEM_ADMIN` users are redirected out of `/admin/*` to `/dashboard`. The two surfaces do not overlap.
- Forced-2FA posture is enforced at the edge (users without TOTP set up are funnelled to the setup route).
- Platform-ops **write** routes are additionally WRITE-grant-gated at the route handler and write an `AuditLog` row; a manual operation runs through one path only (see [../systems/platform-ops.md](../systems/platform-ops.md)).

## Security boundaries (single-chokepoint discipline)

The security architecture is built on *single* chokepoints so a rule can be enforced in exactly one place:

- **One auth chokepoint** (`proxy.ts` + the auth module); no admin bypass of tenancy.
- **One decrypt module**; Plaid access tokens encrypted at rest with **AES-256-GCM** and **HKDF per-purpose key derivation** (no purpose reuses another's derived key).
- **One LLM provider import site** (see [intelligence.md](./intelligence.md) and [../systems/ai.md](../systems/ai.md)).
- **Append-only audit log** on every login, account change, session event, and Space/platform action.
- **TOTP + recovery codes**, session management with a revocation cache, hashed password-reset tokens.
- **`DISABLE_SYSTEM_ADMIN`** environment kill switch rejects system-admin login before it starts.

## Beta gate & anti-abuse

- **`registration_mode ∈ {open, invite_only, closed}`** is a DB `PlatformSetting`, not a build-time flag, so the gate can be flipped without a deploy. (The DB default is `open`; production must be verified `invite_only` before external beta — a CAPTCHA is a no-op without live keys.)
- **Beta access** is request → founder Approve/Deny → a **hashed, email-bound, 14-day, single-use** invite → atomic redemption → born-verified account (`BetaAccessRequest`).
- **Cloudflare Turnstile** on registration, access-request, and stepped-up login.
- **Rate limiting** is default-on in production (`lib/rate-limit.ts`); disabling it is an explicit, `validateEnv`-warned emergency opt-out.
- A real-time **authentication-anomaly detector** with a lockout hybrid + owner-email alert.

## Invariants

1. A Space role never confers a platform capability, and vice versa — the two planes never cross.
2. Platform-ops data is never stored inside customer tenancy.
3. Every privileged write is audited (append-only) and, for platform ops, WRITE-grant-gated.
4. Secrets are encrypted with per-purpose derived keys through one decrypt module; no purpose shares a key.
5. Grant and membership rows are never hard-deleted — state changes are provenance-bearing status flips.

## Known limitations

- Production configuration (invite-only flip, Turnstile keys, Plaid environment, Sentry, backup-restore drill) is an operational floor tracked in the production-readiness audit, distinct from the code boundaries above.
- Counsel-reviewed final legal text is deferred; the drafted legal/disclosure pages are operationally honest but not attorney-approved.
