# Active plans

The **authoritative list of active work.** Read this before opening any other file in
`docs/plans/`; anything not listed here is historical and moves to
[`docs/archive/`](../archive/README.md). Rules: [ADR-008](../decisions/ADR-008-documentation-lifecycle.md).

- **Update before create.** Add to the plan or canonical doc that owns the topic. Start a
  new plan only for a distinct, substantial initiative (or when the owner asks), named
  without a date, with the header below, and add it here in the same PR.
- **Header** (directly under the title):
  `> **Owner:** … · **Status:** DRAFT|ACTIVE|BLOCKED|DONE|SUPERSEDED-BY <path> · **Updated:** YYYY-MM-DD · **PRs:** …`
- **Closeout:** when it finishes, set Status `DONE`, promote durable conclusions into
  `architecture/` · `systems/` · `operations/` · `decisions/` (marked IMPLEMENTED ·
  PROPOSED · DECIDED-NOT-BUILT), then move it to the release archive.
- `scripts/docs-structure.test.ts` enforces this list and the headers.

Current state of the system: [`/STATUS.md`](../../STATUS.md).

| Plan | Owner | Status | What is open |
|---|---|---|---|
| [PRE-BETA-READINESS-AND-RELEASE-PLAN-2026-11-01](PRE-BETA-READINESS-AND-RELEASE-PLAN-2026-11-01.md) | Session 1 | ACTIVE | Beta release batches. B1–B9 released; B10 paused, scope frozen |
| [BETA-REQUEST-RISK-ASSESSMENT-2026-10-31](BETA-REQUEST-RISK-ASSESSMENT-2026-10-31.md) | Session 2 | ACTIVE | Detection/block live (B9); PB-6 review UI ships with B10 |
| [BETA-GROUP-PARITY-AND-LIFECYCLE-AUDIT-2026-10-31](BETA-GROUP-PARITY-AND-LIFECYCLE-AUDIT-2026-10-31.md) | Session 1 | ACTIVE | Owner decision: remove Plaid Items when a beta ends |
| [COMMS-CENTER-NOTIFICATION-ARCHITECTURE-AUDIT-2026-10-31](COMMS-CENTER-NOTIFICATION-ARCHITECTURE-AUDIT-2026-10-31.md) | Session 1 | ACTIVE | Automations ACTIVATION_DISABLED in Production; Resend webhook inert |
| [EMAIL-CATALOG-2026-10-31](EMAIL-CATALOG-2026-10-31.md) | Session 1 | ACTIVE | Living reference of every email path |
| [SEC-PLAT-1-OPERATOR-MFA-ROLLOUT-PLAN-2026-10-27](SEC-PLAT-1-OPERATOR-MFA-ROLLOUT-PLAN-2026-10-27.md) | Session 1 | BLOCKED | Production operator-TOTP activation awaits the owner |
| [P1-REPAIR-PRODUCTION-RUNBOOK-2026-10-27](P1-REPAIR-PRODUCTION-RUNBOOK-2026-10-27.md) | Session 1 | BLOCKED | Never executed; owner decision D11. Moves to `operations/runbooks/` |
| [KD-23-CROSS-TURN-TEMPORAL-CONTINUITY](KD-23-CROSS-TURN-TEMPORAL-CONTINUITY.md) | Owner (ticket) | DRAFT | Ticket only, by owner ruling |
| [parked-ideas](parked-ideas.md) | unassigned | DRAFT | Owner decision: keep a long-range roadmap? |

## Ownership (one writer per canonical document)

Other sessions add review notes or dated sections, never a competing copy. Session 2
independently reviews every documentation PR.

| Writer | Documents |
|---|---|
| Session 1 (release owner) | `STATUS.md`, `docs/releases/`, `operations/release-checklist.md`, `operations/branching-and-protection.md`, the PRE-BETA release plan |
| Session 2 (independent reviewer) | `architecture/SECURITY_MODEL.md`, `operations/database-safety.md`, RLS documentation |
| Session 3 (workspace maintenance) | `docs/README.md`, this index, `docs/archive/`, the documentation lifecycle (ADR-008) |
| The initiative's owner | Its `systems/` document, at closeout |
