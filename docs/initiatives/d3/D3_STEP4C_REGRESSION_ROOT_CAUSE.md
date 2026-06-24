# D3 Step 4C Regression — Root Cause Report

Status: **investigation only. No code changed. 4D not touched.**

## Bottom line

The 4C query rewrite itself is not the bug. Every rewritten query is structurally identical to the `WorkspaceAccountShare` query it replaced — same `status: ACTIVE` visibility gate, same `deletedAt: null` guard, no filtering on `kind`, correct relation names. This is confirmed below by direct inspection and diff, not inference.

4C did one thing that exposes a pre-existing gap: it made `SpaceAccountLink` **load-bearing** for the first time. Before 4C, `SpaceAccountLink` was a best-effort mirror that nothing read — if it was incomplete or wrong, nothing visible broke. After 4C, any account whose `SpaceAccountLink` row is missing, wrong-status, or at the wrong `spaceId` simply disappears from the dashboard, holdings, and transactions. The most likely explanation for Chris's Personal Space showing $0 is exactly that: a `SpaceAccountLink` data gap for his account(s), not a logic error in the rewritten code.

The "Spaces-list card still shows ~$81k" observation does not contradict this — see the dedicated section below. It is a stale cache, not independent confirmation that the new read path works.

## Answers to the 7 investigation questions

**1. `getAccounts()` for Personal Spaces** — `lib/data/accounts.ts:39-50`. Queries `db.spaceAccountLink.findMany({ where: { spaceId, status: ACTIVE, financialAccount: { deletedAt: null } } })`. No Personal-specific branch exists; Personal Spaces are read exactly like any other Space.

**2. `getHoldings()` for Personal Spaces** — `lib/data/accounts.ts:124-132`, the `FinancialAccount` branch. Queries `financialAccount: { deletedAt: null, spaceAccountLinks: { some: { spaceId, status: ACTIVE } } } }`. Same shape as `getAccounts()`, same lack of Personal-specific casing.

**3. How personal-space visibility is resolved through `SpaceAccountLink`** — identically to every other Space type: an `ACTIVE`-status link row at that `spaceId`. There is no longer any "Personal is special" logic in the read path — that was deliberately removed by the D3 Step 3 HOME Semantics Correction, which redefined `HOME` to mean "the account's canonical owning Space" rather than "the creator's Personal Space." `kind` (`HOME` vs `SHARED`) is ownership metadata only; it has never gated visibility.

**4. Are HOME links being filtered out accidentally?** No. Direct inspection of all five rewritten queries (`getAccounts`, the `getHoldings` FinancialAccount branch, `getTransactions`, `getDebtTransactions`, `getInvestmentTransactions`) confirms `kind` does not appear in any `where` clause, in this rewrite or the one it replaced. A `HOME` link and a `SHARED` link satisfy `status: ACTIVE` identically.

**5. Does the `spaceId` passed into `getAccounts()` match Chris's HOME links?** Within one request, this is structurally impossible to get wrong: `getSpaceContext()` is wrapped in React's `cache()`, resolved once per render pass, and `app/(shell)/dashboard/page.tsx` fans that single resolved `ctx.spaceId` into every data-helper call in one `Promise.all`. There is no path for `getAccounts()` and `getHoldings()` to see different `spaceId` values in the same page load.

What this doesn't rule out is a mismatch **at the data layer** — whether the `SpaceAccountLink` rows that exist for Chris's accounts were ever written at the same `spaceId` his session resolves to today (`lib/space.ts`'s cookie → `preferredSpaceId` → Personal-membership fallback chain). That's a question about what's in the table, not about the request — answered by the diagnostic below, not by code review.

**6. Does `getAccounts()` return zero rows for the Personal Space?** Most likely yes, though I can't confirm a literal row count without DB access (confirmed unreachable from this sandbox in earlier sessions — `localhost:5432` refused, Prisma engine fetch blocked). The supporting evidence: Net Worth, Assets, and Liabilities each independently compute to exactly $0 in `DashboardClient.tsx` via `classifyAccounts(accounts)`, where `accounts` is the live prop from `getAccounts()`. Three independent aggregates all landing on exactly zero is the signature of an empty input array, not a calculation bug. The diagnostic below confirms this directly.

**7. Current 4C query vs. pre-4C `WorkspaceAccountShare` behavior** — captured via `git diff` during implementation:

```diff
- { financialAccount: { deletedAt: null, workspaceShares: { some: { workspaceId: spaceId, status: ShareStatus.ACTIVE } } } },
+ { financialAccount: { deletedAt: null, spaceAccountLinks: { some: { spaceId, status: ShareStatus.ACTIVE } } } },
```

Only the relation/field names changed (`workspaceShares`→`spaceAccountLinks`, `workspaceId`→`spaceId`). The visibility condition, the `deletedAt: null` guard, and the absence of any `kind`/ownership filter are all unchanged. Same conclusion for `getAccounts()`'s top-level query and all three `lib/data/transactions.ts` functions. The regression is not in this diff.

## Why the Spaces-list card looking "healthy" is misleading

`app/(shell)/dashboard/spaces/page.tsx` gets each card's net worth from `getSpaceNetWorthSummaries()` (`lib/data/snapshots.ts`), which reads `SpaceSnapshot` — a precomputed cache, not a live query. The only writer of that cache is `regenerateSpaceSnapshot()` (`lib/snapshots/regenerate.ts:45-79`), and its first line is:

```ts
const accounts = await getAccounts({ spaceId });
```

The same `getAccounts()` that 4C rewrote. `SpaceSnapshot.netWorth` for Chris's Personal Space is whatever `getAccounts()` returned the last time something triggered a regeneration (Plaid relink, manual Refresh, wallet create, a share/revoke) — not a live recomputation on every page load. If that last successful trigger happened before the `SpaceAccountLink` data gap existed (or before 4C shipped), the cached ~$81k is simply old, not evidence that today's `SpaceAccountLink` data is complete. The card and the dashboard are not disagreeing about live data; one of them is looking at a snapshot that hasn't been invalidated.

## Most likely root cause

A `SpaceAccountLink` completeness or correctness gap for Chris's Personal Space specifically — most plausibly one of:

- The account predates the one-time Step 2 backfill (`scripts/backfill-space-account-link.ts`), and the backfill skipped it as a `NO_RESOLVABLE_CREATOR` or `NO_ACTIVE_PERSONAL_SPACE` exception, with no live dual-write having fired since (no relink, no re-share) to fill the gap.
- A live dual-write attempt failed silently at some point after the backfill. Every `dualWriteSpaceAccountLink()` call is wrapped in try/catch and only `console.warn`s on failure (`lib/accounts/space-account-link.ts` Rule 5) — it never throws, never alerts, never retries. This was invisible by design before 4C, because nothing read `SpaceAccountLink` yet.

One piece of existing evidence does **not** resolve this either way: the prerequisite check run before 4C began (`correct-home-links.ts --dry-run`: "27/27 HOME-at-PERSONAL rows legitimate, 0 synthesized") only validates rows that already exist with `kind: HOME` at a Personal Space — it presupposes a row is there and checks whether it's properly share-backed. It does not check for the failure mode in question here: an account with **zero** `SpaceAccountLink` rows at all. That check answers a different question than the one this regression raises.

The script that actually answers this question already exists and has not been re-run since the Step 2 backfill: `scripts/verify-space-account-link-backfill.ts`. Its Check 1 ("every active FinancialAccount has exactly one HOME link") and Check 3 ("every `WorkspaceAccountShare` row has a matching `SpaceAccountLink` row, same status/visibilityLevel") are precisely the two checks that would surface a missing-row or wrong-status gap. It was last confirmed passing right after the Step 2 backfill — before the Step 3 HOME correction and before however much live traffic has hit the dual-write path since. It is read-only and safe to run again right now.

## Secondary finding (not the likely cause of the $0 symptom, but a real defect)

`app/api/accounts/manual/route.ts:152-171` fans `dualWriteSpaceAccountLink()` out via `Promise.all` across every target space when a manual account is shared to Personal **plus** one or more `additionalIds` at creation time. `computeLinkKind()` (`lib/accounts/space-account-link.ts:96-116`) decides `HOME` vs. `SHARED` by counting existing links for that `financialAccountId` with no transaction or lock — when two calls in that `Promise.all` batch run concurrently for the same account, both can read `count === 0` before either write commits, and both independently decide `HOME`. That's a `kind`-correctness bug (could produce two `HOME` rows for one account, violating the "exactly one HOME" invariant the schema comment notes is not yet DB-enforced), not a row-absence bug — no read path filters on `kind`, so it wouldn't by itself produce the $0 symptom. Confirmed via repo-wide grep that this is the only call site that fans `dualWriteSpaceAccountLink()` out concurrently across multiple spaces for one account; `app/api/spaces/[id]/accounts/share/route.ts`'s two call sites and `app/api/plaid/exchange-token/route.ts`'s are each single-target. Worth fixing on its own merits; flagged here so it isn't mistaken for the explanation if it turns up during the diagnostic below.

## Diagnostic to run locally (read-only, zero writes)

The sandbox this investigation ran in has no route to the dev database, so the following must be run on your machine.

**Step 1 — re-run the existing verification script**, unmodified:

```
npx tsx scripts/verify-space-account-link-backfill.ts --verbose
```

If Check 1 or Check 3 fails and lists one of Chris's `FinancialAccount` ids, that confirms the data gap directly — `--verbose` will print every offending id rather than truncating at 10.

**Step 2 — scoped triage**, if you want the answer for Chris's account specifically without cross-referencing the full output above. Save as a throwaway file (not part of the repo) and run with `npx tsx`:

```ts
import { PrismaClient, ShareStatus } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  const user = await prisma.user.findUnique({
    where: { email: "chr.hogan1997@gmail.com" },
    select: { id: true },
  });
  if (!user) { console.log("user not found"); return; }

  const membership = await prisma.spaceMember.findFirst({
    where: { userId: user.id, status: "ACTIVE", space: { type: "PERSONAL" } },
    select: { spaceId: true },
  });
  if (!membership) { console.log("no ACTIVE personal space membership"); return; }
  const spaceId = membership.spaceId;
  console.log("Personal spaceId:", spaceId);

  const shares = await prisma.workspaceAccountShare.findMany({
    where: { workspaceId: spaceId, status: ShareStatus.ACTIVE },
    select: { financialAccountId: true, status: true, visibilityLevel: true },
  });
  console.log(`ACTIVE WorkspaceAccountShare rows at this space: ${shares.length}`);

  const links = await prisma.spaceAccountLink.findMany({
    where: { spaceId },
    select: { financialAccountId: true, status: true, kind: true, visibilityLevel: true },
  });
  console.log(`SpaceAccountLink rows at this space (any status): ${links.length}`);

  const linkByAccount = new Map(links.map((l) => [l.financialAccountId, l]));
  for (const share of shares) {
    const link = linkByAccount.get(share.financialAccountId);
    if (!link) {
      console.log(`MISSING LINK — account=${share.financialAccountId} has an ACTIVE share but no SpaceAccountLink row at all`);
    } else if (link.status !== share.status) {
      console.log(`STATUS DRIFT — account=${share.financialAccountId} share.status=${share.status} link.status=${link.status}`);
    } else {
      console.log(`OK — account=${share.financialAccountId} kind=${link.kind} status=${link.status}`);
    }
  }
}

main().finally(() => prisma.$disconnect());
```

This prints, per account, exactly one of: `MISSING LINK` (the row never exists — the most likely finding), `STATUS DRIFT` (the row exists but isn't `ACTIVE`), or `OK` (the row is correct, which would mean the gap is elsewhere — e.g. the `spaceId` your session resolves to doesn't match this one, pointing back at Q5's data-layer case).

## Not done here

No schema, query, or application code was changed. `app/api/accounts/manual/route.ts`'s race condition was identified but not fixed. 4D was not started. Next step is running the diagnostic above and sharing the output before any fix — for the $0 symptom or the manual-route race — is scoped or implemented.
