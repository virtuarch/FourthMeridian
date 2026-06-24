# D3 Step 4D — Final Production Read Cutover: Implementation + Validation Report

Status: **implemented, validated, stopping per instruction. Legacy retirement and D2/D4 not started.**

## Investigation findings (per the 5 items requested)

1. **Exact `WorkspaceAccountShare` reads in both files** — each had exactly one: `app/api/brief/route.ts`'s single `db.workspaceAccountShare.findMany({ where: { workspaceId: spaceId, status: ACTIVE, financialAccount: { deletedAt: null } }, include: { financialAccount: true } })`, and `app/api/spaces/[id]/accounts/route.ts`'s single `db.workspaceAccountShare.findMany({ where: { workspaceId: spaceId, status: ACTIVE, financialAccount: { deletedAt: null } }, select: {...} })`. Neither file has a second read path.

2. **Fields each route needs from the share row itself** — `brief/route.ts` only ever dereferences `financialAccount` (`{ financialAccount: r } => ({...})`); it never reads a field off the share row directly. `spaces/[id]/accounts/route.ts` reads `visibilityLevel`, `addedByUserId`, `addedByUser.{firstName,name}`, and `financialAccount.{id,name,type,institution,balance,currency,lastUpdated,creditLimit,debtSubtype,interestRate,minimumPayment}` off the share row, then hands the whole array to `normalizeSharedAccounts()`.

3. **Does `SpaceAccountLink` have the same fields?** Yes, field-for-field (`prisma/schema.prisma:733-756`): `visibilityLevel`, `status`, `addedByUserId`, `addedByUser` (relation to `User`, selectable the same way), `financialAccount` (relation to `FinancialAccount`, same target model). Only the relation name differs internally (`SpaceAccountLinkAdder` vs. `ShareAdder`) and the space FK is named `spaceId` instead of `workspaceId` — neither affects the `select`/`where` field names used by either route.

4. **Does any output field expect `workspaceId`, needing a `spaceId` mapping?** No. `brief/route.ts`'s `accounts` array (`id, name, type, institution, balance, creditLimit, syncStatus, lastUpdated, interestRate, minimumPayment`) carries no space-identifying field at all. `spaces/[id]/accounts/route.ts`'s output is `NormalizedAccount[]` (`lib/account-privacy.ts`), which also has no `workspaceId`/`spaceId` field. No output mapping was needed in either file.

5. **Does `normalizeSharedAccounts` expect a `WorkspaceAccountShare`-specific shape?** No — confirmed by reading `lib/account-privacy.ts:74-91`. Its parameter type is `ShareRow[]`, defined purely as `{ visibilityLevel, addedByUserId, addedByUser: { firstName, name }, financialAccount: {...} }`. Nothing in the function or its type references `workspaceId`, `spaceId`, or any table name — it operates only on that shape, which `SpaceAccountLink`'s `select` produces identically to what `WorkspaceAccountShare`'s did.

Net effect of the investigation: both cutovers are pure relation swaps with zero output-shape changes required.

## Impact map

| File | Used by | Effect |
|---|---|---|
| `app/api/brief/route.ts` | Daily Brief page (`GET /api/brief`) — net worth, account count, attention flags, map markers | Now reads `SpaceAccountLink` instead of `WorkspaceAccountShare` for the account list that all Brief sections derive from |
| `app/api/spaces/[id]/accounts/route.ts` | Space Detail modal's accounts tab; all Space widgets that fetch `GET /api/spaces/[id]/accounts` | Now reads `SpaceAccountLink`; `normalizeSharedAccounts()` (FULL/BALANCE_ONLY handling) is unchanged and untouched |

This was the last pair of application read paths still on `WorkspaceAccountShare` (per `docs/initiatives/d3/D3_STEP4_READ_CUTOVER_REVIEW.md` and the D3 Step 4C report's confirmation that these two were explicitly deferred). After this step, no `app/`, `lib/`, or `components/` code reads `WorkspaceAccountShare` — confirmed below.

Not affected, by design: `WorkspaceAccountShare` writes (every dual-write call site untouched), the `WorkspaceAccountShare` table itself (not removed, still the live write target), `lib/account-privacy.ts` (zero changes — confirmed table-agnostic in the investigation above), schema/migrations (none), and any D2/D4 work (not started).

## Query diffs

`app/api/brief/route.ts`:
```diff
- const shares = await db.workspaceAccountShare.findMany({
+ const links = await db.spaceAccountLink.findMany({
    where: {
-     // WorkspaceAccountShare keeps its own pre-Phase-1 field name.
-     workspaceId: spaceId,
+     spaceId,
      status:           ShareStatus.ACTIVE,
      financialAccount: { deletedAt: null },
    },
    include: { financialAccount: true },
  });
- const accounts = shares.map(({ financialAccount: r }: any) => ({
+ const accounts = links.map(({ financialAccount: r }: any) => ({
```

`app/api/spaces/[id]/accounts/route.ts`:
```diff
- const shares = await db.workspaceAccountShare.findMany({
+ const links = await db.spaceAccountLink.findMany({
    where: {
-     workspaceId: spaceId,
+     spaceId,
      status:           ShareStatus.ACTIVE,
      financialAccount: { deletedAt: null },
    },
    select: { /* unchanged — visibilityLevel, addedByUserId, addedByUser{firstName,name}, financialAccount{...} */ },
    orderBy: [ /* unchanged */ ],
  });
- return NextResponse.json(normalizeSharedAccounts(shares));
+ return NextResponse.json(normalizeSharedAccounts(links));
```

In both files: the `select`/`include` shapes, `orderBy`, and every downstream field mapping are byte-for-byte unchanged — only the source table/relation name and the `where` key (`workspaceId` → `spaceId`) changed. No `kind` filter was added, matching every other D3 Step 4 cutover: `HOME` and `SHARED` links both confer visibility.

## Files changed

- `app/api/brief/route.ts` — accounts query + doc comment
- `app/api/spaces/[id]/accounts/route.ts` — accounts query + two doc comments

Confirmed via `git status --short` — exactly these two files:
```
 M app/api/brief/route.ts
 M app/api/spaces/[id]/accounts/route.ts
```
`git diff --stat -- prisma/` returned empty — no schema or migration changes. No write path, no `WorkspaceAccountShare` mutation, no UI component, and no D2/D4 file was touched.

## Rollback plan

Pure code revert, no schema or data risk:
- `git checkout -- app/api/brief/route.ts "app/api/spaces/[id]/accounts/route.ts"`, or revert the two relation/where-key swaps individually.
- `WorkspaceAccountShare` remains the live write target throughout (dual-write untouched) — reverting either read is a no-op for data integrity, identical in kind to the 4C rollback.
- Detection signal: if the Brief's net worth/account count or a Space's accounts tab disagrees with the dashboard surfaces already cut over in 4C for the same Space, that indicates a `SpaceAccountLink` data gap (see `docs/initiatives/d3/D3_STEP4C_REGRESSION_ROOT_CAUSE.md`), not new drift from this step — the query logic in both files is structurally identical to what 4C already shipped elsewhere.

## Validation results

- `npx tsc --noEmit` — clean, zero errors.
- `npm run lint` — clean; only the same 4 pre-existing warnings in untouched files (`AccountModal.tsx:45`, `TotpSection.tsx:152`, `CoinIcon.tsx:78`, `:97`, all `@next/next/no-img-element`) seen in the 4C report — unrelated to this change.
- `npx tsx scripts/verify-space-account-link-backfill.ts --verbose` — **not run in this session.** This sandbox has no route to the dev database (confirmed unreachable in earlier sessions — `localhost:5432` connection refused). This is the same check already recommended in `docs/initiatives/d3/D3_STEP4C_REGRESSION_ROOT_CAUSE.md` to resolve the open Personal Space data-gap question; running it once now will validate both that investigation and this step's correctness together.
- Repo-wide grep for `workspaceAccountShare` reads — after this change, the only remaining references are dual-write call sites (writes, explicitly out of scope) and the model definition itself. No application read path references it anymore.
- Manual test checklist (Daily Brief loads; Brief net worth/accounts correct; Space accounts route loads; Space widgets/accounts tab render; BALANCE_ONLY behavior preserved; FULL behavior preserved) — **not performed by me**, same DB-access limitation. Recommend running this locally before merge, ideally right after the verify script above and on the same data — if Chris's Personal Space still has the `SpaceAccountLink` gap described in the regression report, the Brief and the Space accounts route will reproduce the same $0/empty symptom the dashboard did, which would be expected and not a new bug from this step.

Stopping here per instruction. Legacy retirement, D2, and D4 not started.
