> **POINT-IN-TIME RECORD — immutable.** For current project status see `STATUS.md` at the repository root.

# D3 Step 3 — HOME Semantics Correction Investigation

Read-only research. No code, schema, or migration changes were made to produce this report. D3 Step 4C remains paused.

## Product decision driving this report

HOME must mean **canonical owning Space**, not "the user's Personal Space." Personal Space is not the automatic, universal owner of every account — an LLC/business account scoped to a Business Space should not appear in Personal net worth unless explicitly shared there. This report investigates whether current D3 Step 3 behavior matches that, and if not, what the smallest safe pre-4C correction is.

## 1. Where does `ensureHomeLink()` synthesize personal HOME links?

`lib/accounts/space-account-link.ts:219-263`. Given `{ financialAccountId, creatorUserId, excludeSpaceId? }`, it:

1. Resolves the creator's personal Space via `resolvePersonalSpaceId(creatorUserId)` (lines 38-49 — ACTIVE membership in a non-archived, non-deleted, `type: PERSONAL` Space).
2. No-ops if none is resolvable, or if that personal space equals `excludeSpaceId`.
3. Otherwise **upserts a new `SpaceAccountLink` row at the personal space** with `kind: HOME, status: ACTIVE, visibilityLevel: FULL` — independent of, and with no corresponding write to, `WorkspaceAccountShare`.

This is the literal synthesis point: it manufactures visibility into the personal space that nothing else (no share, no explicit user action) ever requested.

The root cause one layer down is `computeLinkKind()` (lines 76-90), used by every *other* dual-write call: it defines HOME as `spaceId === resolvePersonalSpaceId(creatorUserId)` — full stop. There is no code path by which a Business, Household, or Property space can ever be assigned `kind: HOME` today. `ensureHomeLink()` exists only to patch the resulting gap (an account created entirely outside the personal space would otherwise end up with **zero** HOME links, violating the schema's "exactly one HOME row per account" invariant) — but it patches it by reinforcing the wrong rule, not by fixing it.

## 2. Which account creation paths call it?

Exactly two, both creation-only, both gated to brand-new accounts:

| Call site | Trigger | Primary share write |
|---|---|---|
| `app/api/plaid/exchange-token/route.ts:287` | `if (isNewAccount)` after linking a Plaid item | One `WorkspaceAccountShare` + mirrored `SpaceAccountLink` at `spaceId` (the active space from `getSpaceContext()`, which can be any space the user is currently in) |
| `app/api/accounts/wallet/route.ts:222` | Unconditional, but only reached on the brand-new-wallet branch (lines 163-222) | Same pattern — one `WorkspaceAccountShare` + mirror at `spaceId` |

Both call it as `ensureHomeLink({ financialAccountId: fa.id, creatorUserId: userId, excludeSpaceId: spaceId })` — i.e., "make sure personal has a HOME link, unless personal *is* the space we just wrote to."

`app/api/accounts/manual/route.ts` does **not** call `ensureHomeLink()`. It sidesteps the gap differently: `shareTargets = [personalSpaceId, ...additionalIds]` (line 131) always includes the creator's personal space as an explicit share target, regardless of which space was active at creation. So manual accounts get a *real* `WorkspaceAccountShare` row at personal, not a synthesized-only `SpaceAccountLink` — no `ensureHomeLink()`-style asymmetry. But it has the same product-direction problem by a different mechanism: a manual asset created while a Business space is active is unconditionally also shared to Personal, with no way to opt out, because the client never passes `ctx.spaceId` into `additionalIds` unless asked, and `personalSpaceId` is added unconditionally regardless. This is flagged for awareness but is **not** part of questions 1-5 below, and should be a separate, explicitly-approved decision rather than bundled into this correction — it's a "default share targets" behavior, not a HOME-synthesis bug.

## 3. Can a Plaid/wallet account created from inside a non-personal Space have HOME = that active Space instead?

**Not today.** Tracing the exact sequence for, say, a Plaid item connected while a Business space is active:

1. `WorkspaceAccountShare` is created at the Business space (`spaceId`). Correct — this is the real, user-intended share.
2. `dualWriteSpaceAccountLink()` mirrors that same write to `SpaceAccountLink` at the Business space — but calls `computeLinkKind()`, which checks `spaceId === personalSpaceId`. Business ≠ personal, so this row is written as `kind: SHARED`, not `HOME`.
3. Because `isNewAccount` is true, `ensureHomeLink()` then runs and synthesizes a **second**, different `SpaceAccountLink` row at the personal space with `kind: HOME`.

Net result: the Business space — the space the account was actually created in and is actually visible from via a real share — gets `SHARED`. The Personal space — which has no real share and where the user never took any action — gets `HOME`. This is exactly backwards from "HOME = canonical owning Space."

Nothing structurally prevents fixing this (no schema change needed — `kind` is a plain enum column with no DB-level constraint tying it to `type: PERSONAL`, confirmed by the schema's own comment that the one-HOME-per-account invariant is "not yet enforced by a DB constraint"). The fix is entirely in `computeLinkKind()`'s decision rule plus removing the `ensureHomeLink()` patches — see §5.

## 4. Are there existing `SpaceAccountLink` HOME rows synthesized to Personal Space that may be product-wrong?

**Structurally, yes, by construction, for any account meeting this exact condition:** a Plaid item or wallet was created (`isNewAccount: true`) while the user's active space (`getSpaceContext()`) was a non-personal space. Every such event has, since Step 3 shipped, produced precisely one personal-space `SpaceAccountLink` row with `kind: HOME` and **no backing `WorkspaceAccountShare` row** at that `(personalSpaceId, financialAccountId)` pair — that absence is the fingerprint that distinguishes a synthesized row from a real mirrored one.

I could not get an exact count: this sandbox has no network path to the local dev Postgres instance (`localhost:5432` resolves only on your machine, not from this isolated environment — confirmed, connection refused), and there's no internet-reachable dev/staging database to query instead. I prepared a read-only diagnostic script to get the exact figures; it hasn't been run. To execute it yourself:

```ts
// scripts/diagnose-home-synthesis.ts  (NOT added to the repo — paste and run locally:
//   npx tsx scripts/diagnose-home-synthesis.ts)
import { db } from "@/lib/db";

async function main() {
  const homeLinks = await db.spaceAccountLink.findMany({
    where: { kind: "HOME" },
    select: {
      spaceId: true,
      financialAccountId: true,
      space: { select: { type: true, category: true, name: true } },
      financialAccount: { select: { type: true, name: true, deletedAt: true } },
    },
  });

  console.log("Total HOME links:", homeLinks.length);
  console.log(
    "HOME links by space.type:",
    homeLinks.reduce((acc: Record<string, number>, l) => {
      acc[l.space.type] = (acc[l.space.type] ?? 0) + 1;
      return acc;
    }, {})
  );

  // Synthesized-only = HOME link at a PERSONAL space with no backing share
  let synthesizedOnly = 0;
  const details: unknown[] = [];
  for (const l of homeLinks.filter((l) => l.space.type === "PERSONAL")) {
    const share = await db.workspaceAccountShare.findUnique({
      where: {
        workspaceId_financialAccountId: {
          workspaceId: l.spaceId,
          financialAccountId: l.financialAccountId,
        },
      },
    });
    if (!share) {
      synthesizedOnly++;
      details.push({ financialAccountId: l.financialAccountId, account: l.financialAccount });
    }
  }
  console.log("Synthesized-only personal HOME links (no backing share):", synthesizedOnly);
  console.log(details);

  // Invariant check: accounts with 0 or >1 HOME links
  const counts: Record<string, number> = {};
  for (const l of homeLinks) counts[l.financialAccountId] = (counts[l.financialAccountId] ?? 0) + 1;
  const multi = Object.entries(counts).filter(([, c]) => c > 1);
  console.log("Accounts with >1 HOME link (invariant violation):", multi.length, multi);

  const allActive = await db.financialAccount.findMany({ where: { deletedAt: null }, select: { id: true } });
  const zero = allActive.filter((a) => !counts[a.id]);
  console.log("Active accounts with 0 HOME link:", zero.length, zero.map((a) => a.id));
}

main().finally(() => db.$disconnect());
```

What this would tell us, and how to read it:
- **Synthesized-only count > 0** confirms the product-wrong rows exist in your data today, and gives the exact accounts to correct.
- **Any account with 0 HOME links** would mean even the patch failed somewhere (e.g. `ensureHomeLink()`'s best-effort `try/catch` swallowed an error) — worth knowing before relying on `kind` for anything.
- **Any account with >1 HOME link** would be a separate, pre-existing invariant violation independent of this correction (e.g. if a user's personal-space membership changed between two writes, `resolvePersonalSpaceId()` could resolve differently across calls).

I'd recommend running this (or having it run) before executing any correction, so the backfill step in §5 has real numbers instead of working blind.

## 5. Smallest safe correction before 4C

**Recommended scope — two small, additive-first changes plus one data-correction script. Not a schema change.**

**A. Redefine `computeLinkKind()`'s HOME rule.** Replace "HOME iff `spaceId` matches the creator's personal space" with "HOME iff this is the first link ever written for this `financialAccountId`":

```ts
export async function computeLinkKind(
  spaceId: string,
  financialAccountId: string,
): Promise<SpaceAccountLinkKind> {
  const existingHome = await db.spaceAccountLink.findFirst({
    where: { financialAccountId, kind: SpaceAccountLinkKind.HOME },
    select: { spaceId: true },
  });
  if (!existingHome) return SpaceAccountLinkKind.HOME;          // first link → canonical owner
  return existingHome.spaceId === spaceId
    ? SpaceAccountLinkKind.HOME                                  // re-asserting the same HOME row
    : SpaceAccountLinkKind.SHARED;                                // any other space is additional visibility
}
```

This makes HOME equal to whichever space an account was actually created in — Personal, Business, Household, Property, whatever was active — with no special-casing of Personal anywhere. It naturally satisfies "every account has exactly one HOME Space" without a DB constraint, because once a HOME row exists, every subsequent call for that account resolves against it instead of recomputing independently.

**B. Stop calling `ensureHomeLink()`.** Under rule A, the single primary dual-write at account creation already gets `kind: HOME` automatically (there's no existing HOME row yet, so it qualifies). The entire reason `ensureHomeLink()` exists — backfilling a HOME row at personal when creation happens elsewhere — goes away, because personal is no longer entitled to a row at all unless someone actually shares the account there. Remove the two call sites (`exchange-token/route.ts:287`, `wallet/route.ts:222`); leave the function itself in place but unused (or delete it) rather than touching its internals, since nothing else calls it.

**C. One-time backfill-correction script for existing rows.** Rule A only governs new writes going forward. Existing synthesized-only personal HOME rows (§4) need an explicit, reviewed correction pass:
- For each `FinancialAccount` with a HOME link at a `PERSONAL` space and no backing `WorkspaceAccountShare` there: find that account's real `WorkspaceAccountShare` row(s) (there should be exactly one, from the actual creation-time space, since these are exactly the accounts the §3 sequence affected), promote the link at *that* space to `kind: HOME`, and delete the synthesized personal-space row outright (not demote it to `SHARED` — there was never a real share there, so it shouldn't exist in any form).
- This is a write/data operation, scoped narrowly to rows matching the exact synthesized-only fingerprint from §4 — not a bulk reassignment of all HOME links. It should ship as its own reviewed script (mirroring `scripts/backfill-space-account-link.ts`'s pattern: idempotent, dry-run-first, logged), not folded into the `computeLinkKind()` code change.

**Why this is the smallest safe scope:**
- No schema or migration change — `kind` is already a plain column; the fix is entirely in the write-path logic that decides its value.
- Per the 4C report's own finding (§B of `D3_STEP4_READ_CUTOVER_REVIEW.md`), **zero production read paths consult `SpaceAccountLink` today** except the internal, self-healing `regenerateSnapshotsForAccounts()` (4A) and the not-yet-committed transactions-route visibility gate (4B). This is the cheapest possible moment to correct HOME assignment — nothing user-facing depends on it yet, so there is no read-side blast radius to manage. Waiting until after 4C would mean correcting it while dashboards are live on top of it.
- It directly unblocks 4C's actual blocker (the 4C report's §0): once HOME is assigned correctly and `ensureHomeLink()` no longer manufactures personal-space visibility, the personal space genuinely sees only what it's been actually granted, which is the precondition 4C's relation-filter swap (`workspaceShares` → `spaceAccountLinks`, `status: ACTIVE`, no `kind` filter) was already designed around.
- It does not touch the manual-account auto-share-to-personal behavior (§2) — that's a distinct product decision (whether manual asset creation should default-share to personal at all) and should be approved and implemented separately, consistent with "do not implement all decisions in one branch or one commit."
- It is additive-before-subtractive: step C only deletes rows that were never backed by a real share in the first place (synthesized artifacts of a bug), not any legitimate data; steps A/B are pure logic changes to a write path that nothing reads from yet.

## Recommendation

Treat A + B + C as one Step 3 correction (one commit, one PR) — they're tightly coupled (B is only safe once A ships; C's targets are only correctly identifiable in light of A's new rule) — separate from, and prior to, 4C. Resume 4C only after this correction lands and the §4 diagnostic (run against the real dev DB) confirms zero remaining synthesized-only rows.

This report is the checklist-equivalent investigation step per the project's working style; awaiting approval before any of A/B/C is implemented. No code, schema, or migration changes were made to produce this report.
