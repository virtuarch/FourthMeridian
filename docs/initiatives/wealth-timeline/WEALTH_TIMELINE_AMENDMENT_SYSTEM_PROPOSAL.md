# Wealth timeline amendment system — proposal + implementation plan

Status: **Phase 1 (leak fix) approved and implemented same day. Phases 2–4 are proposals — no schema/route changes made for them yet.**

This consolidates a same-day investigation thread that started as "why does historical
investment valuation fall off after ~30 days" and grew into a design for how the whole
Wealth timeline should behave when accounts are added, removed, or re-added over time.

## 0. Context — what was already shipped before this doc

Same day, prior to this proposal, four surgical fixes landed (no schema changes):

1. **Live-row jump suppression** (`lib/snapshots/regenerate.ts`) — a freshly-connected
   checking/savings/debt account with zero synced transactions is excluded from the
   live Space total until it has real transaction evidence, mirroring the existing
   investments-consent-pending gate. Prevents a vertical jump the moment a chart first
   renders after connect.
2. **A9 regen floor fix** (`lib/snapshots/regenerate-history.ts`) — the per-account floor
   used to be `FinancialAccount.createdAt`/`SpaceAccountLink.createdAt` (stamped at
   connect = today, so it permanently collapsed the reconstructable window to zero for
   that account on every future re-run). Now floors at the account's earliest real
   `Transaction`, matching `backfill.ts`, so a later re-run can actually pick up days it
   previously couldn't.
3. **A9 now runs for every connect and every daily sync**, not just when the connect
   includes an investment/crypto account (`lib/plaid/backgroundHistorySync.ts`,
   `jobs/sync-banks.ts`) — a pure cash/debt connect used to get zero refinement passes.
4. **A9 force-backfill window bug** (`lib/prices/backfill.ts`,
   `lib/prices/backfill-core.ts`) — the historical price request for A9's
   constant-quantity fallback was reusing "resume after the latest covered date" logic,
   which is only valid for the daily cron's forward-growing coverage. The moment ANY
   recent price coverage existed (which it always does, from the daily cron), the
   force-backfill window resolved to `null` and never reached the price vendor for the
   older span — the actual root cause of investment valuation silently flat-lining
   after ~30 days. Fixed with `resolveForceBackfillWindows`, which fills the gap(s)
   around existing coverage instead of assuming coverage only grows forward.

Chasing (4) down led to manually running the wealth-history regen script over a 2-year
window on a real account, which surfaced the design question this doc is actually
about: **what should happen when the account set underneath an already-computed
historical range changes?**

## 1. The bug this proposal starts from

`docs/bugfixes/BUGFIX_ARCHIVED_ACCOUNT_SNAPSHOT_STALENESS.md` (an earlier, unrelated
fix) established a deliberate principle: archiving or restoring an account must never
retroactively change historical `SpaceSnapshot` rows — only today's live row updates.
That was correctly implemented for the archive/restore routes at the time.

A9 regen (`regenerateWealthHistory`) was built later and violates that principle
without anyone deciding to, because it queries **currently** `ACTIVE`
`SpaceAccountLink` rows with no awareness of who was active on each historical day:

```
const linkRows = await client.spaceAccountLink.findMany({
  where: { spaceId, status: ShareStatus.ACTIVE, financialAccount: { deletedAt: null } },
  ...
});
```

Concretely: remove account B from a space today. Next week, account A's daily sync
triggers A9 for the same space (Phase 1's fix in §0.3 made this fire far more often —
every day, for every account, not just investment/crypto connects). A9 recomputes the
still-`isEstimated: true` window using only currently-active links — B silently drops
out of last week's numbers, even though B was genuinely part of the space last week.
Nobody asked for that; it's a side effect of an unrelated account's sync.

## 2. Root architectural constraint

`SpaceSnapshot` is a Space-level aggregate only (cash/savings/debt/stocks/crypto/
netWorth totals per day) — there is no per-account historical attribution stored
anywhere. This has two consequences that shaped every decision below:

- You cannot cleanly "subtract just this account's slice" from an already-written
  total; the only way to change a day's numbers is to fully re-derive it from whatever
  accounts are currently queried.
- The cash/debt walk-back (`reconstructDailyCashBalances`/
  `reconstructDailyLiabilityBalances`, `lib/snapshots/backfill-core.ts`) anchors at a
  **single shared `today`** for the whole batch, walking every account backward from
  its *current* `balance` field. A revoked account's `balance` isn't meaningful as of
  "today" — it stopped syncing when it was removed. Correctly reconstructing a revoked
  account's historical contribution would require generalizing that anchor to be
  per-account (anchor at removal date, not today) — a real change to a shared, heavily
  fixture-tested pure function, not a quick patch. **Deferred, not solved here** — see
  §6.

## 3. Design principle adopted

Not a single rule for "add" and "remove" — an asymmetric principle that resolves to
the same underlying idea in both directions: **show the truest picture available,
except a mere disconnection must never make it look like money that existed didn't.**

- Adding a long-held account should be *allowed* to enrich the past (more truth becomes
  available) — but only as an explicit, opt-in action, never silently overnight.
- Removing an account should *not* retroactively erase the past by default — disconnecting
  today doesn't undo that the money was real while the account was active.
- Only an explicit, consent-gated "amendment" is allowed to rewrite an already-written
  day on purpose, in either direction.

## 4. `SnapshotAmendment` — proposed table (not built yet)

One row per deliberate rebuild request:

| Field | Purpose |
|---|---|
| `spaceId`, `financialAccountId` | scope of the request |
| `kind` | `ACCOUNT_ADDED_RETROACTIVE` \| `ACCOUNT_REMOVED_RETROACTIVE` \| `ACCOUNT_HARD_DELETED` \| `IMPORT_ENRICHMENT` |
| `fromDate`, `toDate` | affected range |
| `requestedByUserId`, `requestedAt` | who asked |
| `status` | `PENDING` → `APPLIED` (personal space) or `PENDING_APPROVAL` → `APPROVED`/`DENIED` → `APPLIED` (shared space) |
| `approvedByUserId`, `approvedAt` | shared-space approval (§5) |
| `consentedAt` | the explicit "yes, rewrite my history" confirmation — makes consent an auditable fact, not a boolean anyone could flip |

**Per-day breakdown, stored, not recomputed** — a child table or JSON array, one entry
per affected date, storing before/after values for whichever fields actually changed.
Chosen over a lighter "just log the event, recompute-on-read for display" version
specifically because Activity needs to show a real, quantified fact ("June net worth
revised $14,235 → $19,940"), and a stored value stays true forever even if the account
is later hard-deleted and its source transactions are gone — a recompute-on-read
version would go silently wrong or unanswerable once the underlying data disappears.

**`SpaceSnapshot` gets exactly one new nullable field:** `amendedByAmendmentId`,
pointing at the most recent amendment that touched that row. `[spaceId, date]`
uniqueness is untouched — no `supersededById` chain the way `PositionObservation` does
it; the "old" value lives on the amendment record, and the `SpaceSnapshot` row is
updated in place. A previously-frozen (`isEstimated: false`) row that gets amended
flips to `isEstimated: true` afterward — once a real observation has been deliberately
revised because the account set changed, it's honest to call it a reconstruction again,
not a pristine observation.

One `AuditLog` row per amendment, same `auditLogId`-link pattern the sync-complete flow
already uses, so Activity gets a natural entry with a quantified delta without needing
to know anything about snapshot internals.

## 5. SHARED-space approval (proposed)

Maps onto the existing `SpaceMemberRole` hierarchy (`OWNER`/`ADMIN`/`MEMBER`/`VIEWER`)
rather than inventing a new one:

- **`ADMIN` can approve** "accept the account and its transaction history" — visible,
  additive, doesn't touch anything anyone's already seen.
- **`OWNER` only can approve** "also alter the shared snapshots" — the action that
  actually rewrites history every member has looked at. Matches the existing precedent
  that `OWNER` is reserved for the hardest-to-reverse, space-wide actions (permanent
  delete, member removal, space restore) — this is the same tier of consequence.
- **No self-approval**, except when the requester is the *sole* `OWNER`/`ADMIN` in the
  space (nobody else to provide oversight). Same underlying check as the existing
  `isSoleOwnerBlock` in `lib/account-deletion/preflight.ts` — "is there someone else who
  could exercise oversight here" — reused, not reinvented, just inverted (that one
  blocks an action when no successor exists; this skips a gate when no other approver
  exists).
- Personal spaces skip the approval state entirely (`PENDING` → `APPLIED` directly) —
  requester and sole authority are the same person.

## 6. Future initiative — delegated authority + governance models (brainstormed, not scoped for build)

Explicitly bigger than this proposal; captured now only so the schema above doesn't
need reworking later.

**`SpaceDelegatedAuthority`** — general-purpose, not amendment-specific: `spaceId`,
`granteeUserId`, `grantedByUserId` (must be an `OWNER` at grant time), `scope`
(extensible tag — `SNAPSHOT_AMENDMENT` today, room for `ACCOUNT_LINK_APPROVAL`,
`MEMBER_INVITE`, etc. without a schema change each time), `grantedAt`,
`revokedAt`/`revokedByUserId`, optional `expiresAt`. Lets an owner extend approval
authority to a specific member for a specific scope without promoting them to full
`ADMIN`/`OWNER` generally. Today's role-only design is just "this table is empty."

**`SpaceGovernanceModel`** (space-level enum, per-decision-kind override deferred):
`SINGLE_OWNER` (today's default — literal owners only) · `HIERARCHY` ("kingdom" — any
one eligible approver, owner or delegate, acts unilaterally — needs nothing beyond the
delegation table) · `CONSENSUS` ("democracy" — requires multiple eligible approvers to
agree; needs a real child vote table and a resolution rule (majority/unanimous/
threshold) — this is a materially bigger build than everything else in this doc, closer
to its own initiative).

Layering: base `SpaceMemberRole` decides who can act by default → delegated authority
extends that to specific people for specific scopes → governance model decides whether
one eligible approver suffices or a quorum is required. The amendment approval step
only ever asks "is this user eligible, and has the governance model been satisfied" —
it doesn't need to know about delegation or voting internally.

## 7. Known limitation carried forward from §2

`SpaceAccountLink` has `@@unique([spaceId, financialAccountId])` — one row per
(space, account) pair, ever. `revokedAt` is cleared back to `null` on restore, so a
revoke → restore → revoke history collapses to only the *latest* transition; the
current schema cannot represent "this account was out of the space from March to June,
then back." Phase 1 below (§8) handles the common case (removed once, never re-added)
correctly and safely degrades — by skipping, never by silently guessing — on the
compound case. A fully precise fix needs an append-only membership-history table,
which could piggyback on `SnapshotAmendment` itself if every future revoke/restore is
routed through it.

## 8. Implementation plan

**Phase 1 — fix the leak (implemented same day, no schema change).** Stop automatic,
non-amendment A9 regen from silently dropping a since-revoked account's contribution
from a day it was genuinely part of. Detailed in the companion fix below.

**Phase 2 — `SnapshotAmendment` table + personal-space flow.** Schema addition,
`PENDING`/`APPLIED` status only, single explicit "rebuild history" action per add/remove,
before/after diff shown before committing (reusing the diff-printing pattern already in
`scripts/regenerate-wealth-history.ts`), `AuditLog` + Activity wiring.

**Phase 3 — SHARED-space two-tier approval.** `PENDING_APPROVAL`/`APPROVED`/`DENIED`
statuses, `ADMIN` vs `OWNER` gating per §5, sole-approver exception, request/approve/
deny notifications.

**Phase 4 — delegated authority + governance models.** Its own initiative per §6; not
scoped in detail here.

## 9. Phase 1 fix detail

**Chosen approach:** rather than trying to correctly *reconstruct* a revoked account's
historical contribution (blocked on the walk-back anchor generalization in §2), make
automatic regen defensively skip any day where doing so is uncertain, and leave
whatever is already stored. This needs no schema change and no anchor generalization.

For each candidate day `d` in an automatic (non-amendment) A9 run: if any
`SpaceAccountLink` in the space has `revokedAt` strictly after `d`, that account was
plausibly part of the space as of day `d` and has since left — skip regenerating `d`
entirely via the automatic path (new `RegenAction`: `"skip-membership-changed"`),
leaving the existing row untouched. Deliberately conservative: it can skip a day that
was actually fine (the revoked account didn't contribute to that day for unrelated
floor/evidence reasons), but it can never silently corrupt one — consistent with the
"no fabrication, unknown is preferable to guessing" rule already governing every other
decision in `regenerate-history.core.ts`.

Explicit amendments (Phase 2+) are exempt from this guard by construction — that's the
whole point of the consent-gated path — and are the only way to deliberately revise a
day whose membership has changed.
