# ADR-003 — Per-account visibility tiers behind one predicate; three authz axes never merge

**Status:** accepted · **Doctrine:** [SECURITY_MODEL](../architecture/SECURITY_MODEL.md)

## Context

Fourth Meridian holds three kinds of privileged relationship: a customer to their own
(and their household's) money; a Fourth Meridian employee to a platform operating
area; and a break-glass administrator to the platform itself. Within a shared Space, a
member may be allowed to see *some* of another member's account (the balance) but not
*all* of it (the transactions).

## Problem

If these collapse into "one role system," authority leaks. A customer Space OWNER
could gain platform power; a support employee could reach customer money; "shared"
would mean "fully visible" with no gradient. And a single wrong predicate for "can
this viewer see transaction detail" — duplicated across the AI, the UI, and the export
— would eventually disagree with itself and leak.

## Decision

**Three independent authorization axes that never share a decision, plus one
orthogonal per-account visibility dimension behind a single predicate.**

- **Customer** = `SpaceMember` role (`OWNER/ADMIN/MEMBER/VIEWER`) + per-account
  `VisibilityLevel`.
- **Operator** = `PlatformGrant` (area × level), orthogonal to Space membership.
- **Emergency** = `User.role = SYSTEM_ADMIN`, break-glass, mandatory TOTP.
- **Visibility tiers:** a `SpaceAccountLink` grants an account at `FULL` /
  `BALANCE_ONLY` / `SUMMARY_ONLY` / `PRIVATE` (legacy `SHARED` fails closed). Only
  `FULL` may expose transaction/position detail, decided by the **single** predicate
  `TRANSACTION_DETAIL_VISIBILITY = [FULL]` (`grantsTransactionDetail` /
  `grantsAccountDetail`), read by every surface, server-side, failing closed.

## Alternatives considered

- **One unified RBAC role system** across customer + platform + admin. Rejected: it
  makes "grant on one axis confers authority on another" the *default* — the exact
  leak we must prevent. The axes are separate models, separate policy modules, and
  never import one another.
- **`SYSTEM_ADMIN` as a super-role that also grants platform + Space access
  implicitly.** Rejected as too broad. Admin holds an explicit *break-glass bypass*
  over the operator plane (documented, audited), but it is not day-to-day access; the
  operator tier is a plain `USER` + `PlatformGrant`, least-privilege.
- **Per-surface visibility predicates** ("the AI has its own rule, the UI has its
  own"). Rejected: a privacy rule duplicated is a privacy rule that eventually
  disagrees with itself. One predicate, shared everywhere.
- **UI-level hiding as the access control.** Rejected: a hidden button leaves the API
  reachable. Authorization is enforced at the route-handler/loader layer, not by
  hiding UI. `proxy.ts` is only an edge session/redirect chokepoint and does not run
  for `/api/*`.
- **Hard-deleting membership/grant rows on removal.** Rejected: revocation is a
  provenance-bearing status flip, so history and audit survive.

## Consequences

- Internal HQ areas are real Spaces with **zero `SpaceMember` rows** — access is the
  `PlatformGrant` plane alone; the platform surface reads only operational ledgers,
  never customer money tables.
- Escalation is closed: only `SYSTEM_ADMIN` mints grants, only onto plain `USER`
  accounts; no platform capability mints platform capability.
- Admin is the highest-value credential: mandatory 2FA enrolment (no password-only
  path), a `DISABLE_SYSTEM_ADMIN` kill switch, and every admin action audited with
  `performedByAdminId`.
- A transfer's resolved meaning is a *(row, viewer)* fact — visible legs change what a
  viewer may know. Fails closed.
- The cost: three planes and one predicate must be enforced consistently — guarded by
  source-scan and parity tests, not convention.
