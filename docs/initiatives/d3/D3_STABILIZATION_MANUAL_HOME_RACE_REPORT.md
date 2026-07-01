> **POINT-IN-TIME RECORD — immutable.** For current project status see `STATUS.md` at the repository root.

# D3 Stabilization — Fix Manual HOME Race: Implementation + Validation Report

Status: **implemented, validated where possible, stopping per instruction. Legacy retirement and D2/D4 not started.**

## The race, confirmed

`app/api/accounts/manual/route.ts`'s create handler fanned its `SpaceAccountLink` dual-write out via `Promise.all(shareTargets.map((wsId) => dualWriteSpaceAccountLink({ spaceId: wsId, financialAccountId: fa.id, ... })))`, where `shareTargets = [personalSpaceId, ...additionalIds]`.

`dualWriteSpaceAccountLink()` calls `computeLinkKind()` (`lib/accounts/space-account-link.ts:96-116`) before every upsert, which decides HOME vs. SHARED by counting existing `SpaceAccountLink` rows for that `financialAccountId`:

```ts
const existingLinkCount = await db.spaceAccountLink.count({ where: { financialAccountId } });
if (existingLinkCount === 0) return SpaceAccountLinkKind.HOME;
```

With `Promise.all`, every target's `count()` can run before any target's `upsert()` commits — there's no transaction or lock between the read and the write. When a manual account is shared into Personal plus one or more additional spaces at creation, two or more of those concurrent `count()` calls can each observe `0` and each independently decide `HOME`. That produces more than one HOME row for a single account, violating the "exactly one HOME per account" invariant the schema comment notes is not yet DB-enforced (`SpaceAccountLinkKind` enum doc, `prisma/schema.prisma`).

This was the only call site that fans `dualWriteSpaceAccountLink()` out concurrently across multiple spaces for one account — confirmed by repo-wide grep, both at the time of the original regression report and again during this fix. `app/api/spaces/[id]/accounts/share/route.ts`'s two call sites and `app/api/plaid/exchange-token/route.ts`'s are each single-target, so they were never exposed to this race and were left untouched.

## Fix

Smallest change that removes the race: replaced the `Promise.all` fan-out with a sequential `for...of` loop, awaiting each `dualWriteSpaceAccountLink()` call before starting the next. `shareTargets[0]` is always `personalSpaceId` (unchanged invariant, still noted in the new comment), so it now deterministically commits first — its `count()` sees `0`, it becomes HOME, and that row is committed before the next target's `count()` ever runs. Every subsequent target's `count()` now sees a count greater than zero and an existing HOME row at a different `spaceId`, so `computeLinkKind()` correctly returns SHARED for all of them. No transaction, lock, or schema change was needed — serializing the calls is sufficient because the only actor that can create concurrent writes for one account's links, at creation time, is this one loop.

The `WorkspaceAccountShare` upsert loop directly above it (`db.workspaceAccountShare.upsert(...)`, lines ~131-150) was left untouched — that model has no `kind` field and no equivalent race, and per scope this fix targets `SpaceAccountLink` HOME assignment only. `lib/accounts/space-account-link.ts` itself was not modified; the fix is entirely in the one call site that misused it concurrently.

## Diff

```diff
-  // ── D3 Step 3 — mirror onto SpaceAccountLink (best-effort, non-fatal).
-  //    shareTargets[0] is always personalSpaceId, so no Rule 4 gap here.
-  await Promise.all(shareTargets.map((wsId) =>
-    dualWriteSpaceAccountLink({
+  // ── D3 Stabilization — mirror onto SpaceAccountLink (best-effort,
+  //    non-fatal). Sequential, NOT Promise.all: computeLinkKind() ...
+  for (const wsId of shareTargets) {
+    await dualWriteSpaceAccountLink({
       spaceId:            wsId,
       financialAccountId: fa.id,
       creatorUserId:       userId,
       create: { addedByUserId: userId, visibilityLevel: VisibilityLevel.FULL, status: ShareStatus.ACTIVE },
       update: { status: ShareStatus.ACTIVE, visibilityLevel: VisibilityLevel.FULL, revokedAt: null, revokedByUserId: null },
-    })
-  ));
+    });
+  }
```

(Comment shortened above for the diff; full comment is in the file and explains the race and why sequential awaits fix it.)

## Impact map

| File | Effect |
|---|---|
| `app/api/accounts/manual/route.ts` | `SpaceAccountLink` dual-write at manual account creation is now sequential instead of concurrent. Functionally: exactly one HOME link (at `personalSpaceId`) and zero-or-more SHARED links (at `additionalIds`) per created account, every time — previously nondeterministic under concurrency. |

Not affected: `WorkspaceAccountShare` writes (same upsert loop, same semantics, no `kind` concept to race on), every other dual-write call site (single-target, never exposed to this race), `lib/accounts/space-account-link.ts` (unchanged), response shape/status code (unchanged — `POST` still returns `{ accountId, name, balance, ... }` at 201), schema, migrations, D2, D4.

**Performance note:** this trades a small amount of latency (N sequential round-trips instead of N concurrent ones, where N = 1 + `additionalIds.length`) for correctness. `additionalIds` is normally 0 or 1 in practice (sharing a new manual asset into one extra space at creation); the added latency is one extra DB round-trip in the common case, not a meaningful regression.

## Files changed

```
 M app/api/accounts/manual/route.ts
```

`git diff --stat -- prisma/` returned empty — no schema or migration changes. No other write path, no `WorkspaceAccountShare` table change, and no D2/D4 file was touched.

## Validation results

- `npx tsc --noEmit` — clean, zero errors.
- `npm run lint` — clean; only the same 4 pre-existing warnings in unrelated files (`AccountModal.tsx:45`, `TotpSection.tsx:152`, `CoinIcon.tsx:78`, `:97`, all `@next/next/no-img-element`) seen in every prior D3 report.
- `npx tsx scripts/verify-space-account-link-backfill.ts --verbose` — **could not run to completion in this sandbox.** Unlike earlier sessions (which failed on `localhost:5432` connection refused), this attempt failed earlier, at Prisma Client initialization: the client in this sandbox was generated for a `darwin-arm64` target and the sandbox runtime is `linux-arm64-openssl-3.0.x`, so the query engine binary for this platform isn't present. This is an environment/binary-target mismatch, not evidence about the fix's correctness or about the database. **This must be run on your machine** (or any environment with a matching Prisma engine and a live route to the dev DB) before merging — it's the one validation step in this task that can directly confirm Check 1 ("every active FinancialAccount has exactly one HOME link") now holds for accounts created through this path. Recommend running it, then creating a manual account with 2+ `spaceIds` once locally as a live functional check.

## Manual test (recommended, not performed here)

Create a manual asset via `POST /api/accounts/manual` with `spaceIds` containing two or more additional spaces in one request, then query `SpaceAccountLink` for that `financialAccountId` and confirm exactly one `kind: HOME` row (at `personalSpaceId`) and the rest `kind: SHARED`. Repeating this a few times is the most direct way to confirm the race is gone, since the original bug only manifested under concurrency that a single manual click wouldn't reliably reproduce — the fix removes the concurrency itself, so this should now be deterministic on every run.

## Rollback plan

Pure code revert, no schema or data risk:
- `git checkout -- app/api/accounts/manual/route.ts`, or revert the `for` loop back to `Promise.all` directly.
- No `WorkspaceAccountShare` or `SpaceAccountLink` data was migrated or backfilled by this change — it only affects how future writes from this one endpoint are sequenced. Reverting has no effect on any existing row.
- If `SpaceAccountLink` rows created before this fix already have a duplicate-HOME defect for some account, this fix does not retroactively correct them — that's a data-correction concern, separate from this race fix, and `scripts/correct-home-links.ts` (already exists, previously used for the equivalent Personal-Space HOME correction) is the right tool to check for and fix any pre-existing duplicates if the verification script (once run with a working engine) surfaces any.

Stopping here per instruction. Legacy retirement, D2, and D4 not started.
