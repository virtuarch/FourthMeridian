> **POINT-IN-TIME RECORD — immutable.** For current project status see `STATUS.md` at the repository root.

# D3 Step 4 — Read Cutover Investigation

Read-only research. No code, schema, or migrations were changed to produce this report.

Status assumed true per Step 1–3 completion: `SpaceAccountLink` table exists, backfill ran and was verified, and every `WorkspaceAccountShare` mutation site now dual-writes to `SpaceAccountLink` (best-effort/non-fatal, via `lib/accounts/space-account-link.ts`).

## A. Inventory — WorkspaceAccountShare readers

"Reader" here means a file containing a direct Prisma query against `workspaceAccountShare` (`.findMany` / `.findFirst` / `.upsert`'s read half / a relation filter such as `financialAccount: { workspaceShares: { some: {...} } } }`). Sites that are write-only (the 11 D3 Step 3 dual-write sites plus `prisma/seed.ts`) are included for completeness since several also read-before-write, but they are not cutover candidates — Step 4 is reads only, and `WorkspaceAccountShare` must stay the write target until a later, separate step.

| # | File | Purpose | Read-only or write | Cut over now? | Reason |
|---|------|---------|---------------------|----------------|--------|
| 1 | `lib/data/accounts.ts` — `getAccounts()` | Central account-list helper: every Space dashboard, widget, and the Daily Brief's nearest equivalent ultimately wants this list. Direct `findMany` anchored on `workspaceId`. | Read-only | No (own step) | Highest blast radius in the app — feeds the personal dashboard, every `(shell)/dashboard/*` page that calls it, and transitively `regenerateSpaceSnapshot()`. Needs its own dedicated, isolated cutover step with full validation, not bundled into Step 4. |
| 2 | `lib/data/accounts.ts` — `getHoldings()` (FinancialAccount anchor) | Scopes `Holding` rows to a space via `financialAccount: { workspaceShares: { some: { workspaceId, status: ACTIVE } } } }`. (The parallel legacy-`Account` anchor query doesn't touch `WorkspaceAccountShare` at all.) | Read-only | No (bundle with #1) | Same relation-filter pattern and same dashboard blast radius as `getAccounts()`. Should move in the same wave so the account list and holdings list never disagree about which space sees what. |
| 3 | `lib/data/transactions.ts` — `getTransactions()`, `getDebtTransactions()`, `getInvestmentTransactions()` | Three near-identical functions, each scoping `Transaction` rows via the same `financialAccount: { workspaceShares: { some: {...} } } }` relation filter. | Read-only | No (bundle with #1/#2) | Identical pattern/risk to `getHoldings()`. Banking/Credit/Investments pages depend on these; cut over together with #1/#2 so a space's account list and its transaction list use the same source in the same release. |
| 4 | `lib/snapshots/regenerate.ts` — `regenerateSnapshotsForAccounts()` | Direct `findMany({ where: { financialAccountId: { in }, status: ACTIVE }, select: { workspaceId: true } })` — fans out "which spaces does this account touch" so each gets a `SpaceSnapshot` recompute. | Read-only | **Yes** | Output is never rendered directly — it's an internal list of space IDs to loop over. If briefly out of sync with `WorkspaceAccountShare`, the worst case is a snapshot recomputed on a slightly different set of spaces, self-correcting on the next refresh/share change. Lowest blast radius of any reader in this table. |
| 5 | `app/api/accounts/[id]/transactions/route.ts` | `findFirst` used only as a boolean visibility gate ("is this account shared into the caller's active space?") before listing transactions. Returns no share fields itself. | Read-only | **Yes** | Pure existence check, not a data-shaping query. 1:1 swap (`spaceAccountLink.findFirst({ where: { spaceId, financialAccountId, status: ACTIVE } })`) with no shape change. |
| 6 | `app/api/accounts/debug-duplicates/route.ts` | Temporary diagnostic route (its own header comment says "Delete this file once the investigation is complete... should not ship"). Uses a relation filter for "did the user own or get this shared" plus an `include` of raw share rows for human inspection. | Read-only | **Yes** (or delete) | Not part of the shipped feature set. Lowest stakes of all — either cut it over trivially or remove the file; either resolves it. |
| 7 | `app/api/accounts/manual/archived/route.ts` | Lists a user's soft-deleted manual assets plus which spaces they were (REVOKED) shared into, via `include: { workspaceShares: { select: { status, workspace } } } }`. | Read-only | **Yes** | Single settings page (archived assets), low traffic, audit-style view rather than a balance-bearing widget. Self-contained query, easy 1:1 swap. |
| 8 | `app/api/brief/route.ts` | Direct `findMany` building the Daily Brief's account list, net worth, and "needs attention" sections. | Read-only | No (own step, after #1–3) | Single page, but user-facing balance data feeding net-worth math — not as trivial as #4–7. Should follow the same shape `getAccounts()` ends up with rather than cut over independently, to avoid two different "active accounts for a space" queries existing simultaneously. |
| 9 | `app/api/spaces/[id]/accounts/route.ts` | Direct `findMany` feeding `normalizeSharedAccounts()` (`lib/account-privacy.ts`) — powers the Space Detail modal's accounts tab and, per its own header comment, "all space widgets." This is the **only** call site of `normalizeSharedAccounts(`. | Read-only | No (own step, after #1–3) | Multi-widget fan-out via the shared/balance-only privacy transform. `normalizeSharedAccounts()` itself does no Prisma query — once this one query is repointed at `SpaceAccountLink`, every widget downstream of it moves automatically. Worth its own validation pass given the privacy-sensitive BALANCE_ONLY aggregation logic riding on top of it. |
| 10 | `app/api/spaces/[id]/accounts/share/route.ts` (POST + DELETE) | Read-before-write: `upsert`/`findUnique` against `workspaceAccountShare` to check current state before mutating, then dual-writes. | Write (with read-before-write) | No | This is a write path, not a read-cutover candidate. `WorkspaceAccountShare` must remain the system of record for writes through Step 4 and beyond. |
| 11 | `app/api/spaces/[id]/members/[userId]/route.ts` (DELETE) | Captures `sharesBeforeRevoke` via `findMany`, then revokes via `updateMany`, then mirrors via `dualWriteFromShares`. | Write (with read-before-write) | No | Same reasoning as #10 — write path. |
| 12 | `lib/accounts/reconcile.ts` — `mergeArchivedDuplicateIntoCanonical()` | Reads `loserShares` via `findMany`, then `upsert`s each onto the winner account and dual-writes. | Write (with read-before-write) | No | Write path. |
| 13 | `app/api/plaid/exchange-token/route.ts`, `app/api/accounts/[id]/route.ts`, `app/api/accounts/[id]/restore/route.ts`, `app/api/accounts/manual/route.ts`, `app/api/accounts/manual/[id]/route.ts`, `app/api/accounts/manual/[id]/restore/route.ts`, `app/api/accounts/manual/[id]/permanent/route.ts`, `app/api/accounts/wallet/route.ts` | The remaining D3 Step 3 dual-write sites (create/archive/restore/delete lifecycle mutations). | Write | No | Write paths, already dual-writing since Step 3. Out of scope for a read cutover. |
| 14 | `prisma/seed.ts` | Dev/test seed data, writes both tables directly. | Write | No | Not production code. |

Note on `lib/account-privacy.ts`: confirmed via repo-wide grep that `normalizeSharedAccounts(` and `sanitizeForBalanceOnly(` have exactly one call site between them — row 9 above. The module itself issues no Prisma queries; it's a pure transform on whatever shape it's handed, so it imposes no extra cutover work beyond row 9 (its caller).

## B. Inventory — SpaceAccountLink readers

```
grep -rn "spaceAccountLink\.\(findMany\|findFirst\|findUnique\|count\|groupBy\)" .
```

| File | Purpose | Production or tooling |
|------|---------|------------------------|
| `scripts/verify-space-account-link-backfill.ts` | Step 2 backfill verification (`groupBy` HOME-link count check, full `findMany` diff against `WorkspaceAccountShare`). | Offline tooling, run manually |
| `scripts/backfill-space-account-link.ts` | Reads existing links to make the backfill idempotent on re-run. | Offline tooling, run manually |

**Finding: zero production code paths read `SpaceAccountLink` today.** Every reference to it outside `lib/accounts/space-account-link.ts` (the dual-write helper, which reads-before-write internally — e.g. `ensureHomeLink` checking for an existing HOME row) is either a write call site or one of the two offline scripts above. This matches the schema's own header comments at `Space.accountLinks`, `FinancialAccount.spaceAccountLinks`, and the `SpaceAccountLink` model block, which still say "additive, not yet read... by application code" — true for every *serving* path, though technically stale now that Step 3 writes to it.

Practically: `SpaceAccountLink` is currently a write-only mirror. It has never served a single real request. That de-risks Step 4 somewhat (no read path can regress against a structure that's already proven itself under load) but also means Step 4 will be the first time its data shape is exercised by anything other than the backfill/verify scripts — start with the lowest-stakes reader (Table A, row 4), not the highest-traffic one.

## C. Proposed cutover order

1. **`regenerateSnapshotsForAccounts()`** (Table A #4) — zero UI blast radius, self-healing, trivial revert.
2. **`app/api/accounts/[id]/transactions/route.ts`** visibility check (#5) and **`app/api/accounts/debug-duplicates/route.ts`** (#6, or delete it outright) — same low-stakes tier, can ride in the same step as #1 if desired.
3. **`app/api/accounts/manual/archived/route.ts`** (#7) — single settings page, audit view.
4. **`getAccounts()` + `getHoldings()` + `getTransactions()`/`getDebtTransactions()`/`getInvestmentTransactions()`** (#1–#3) — moved together, one release, because they must agree on which accounts a space can see. This is the step that actually de-risks the rest: once it's live and validated, it's proof `SpaceAccountLink` correctly serves the core dashboard under real traffic.
5. **`app/api/brief/route.ts`** (#8) and **`app/api/spaces/[id]/accounts/route.ts`** (#9) — moved after step 4 is proven, so there's only ever one validated "active accounts for a space" query shape to copy from.
6. Only after all reads are migrated and have baked in production for a deliberate period: consider whether `WorkspaceAccountShare` writes (Table A rows 10–14) can stop, and whether the table itself can eventually be retired. That is explicitly **not** part of Step 4 and is subtractive work the project rules require staying additive ahead of.

## D. Smallest safe Step 4 implementation scope

**Cut over `regenerateSnapshotsForAccounts()` only** (Table A, row 4 — `lib/snapshots/regenerate.ts`).

Why this one, alone, for Step 4:
- It is a single function in a single file with a single query.
- Its result is consumed internally (a list of space IDs to loop `regenerateSpaceSnapshot` over) — never returned to a client, never rendered.
- `SpaceAccountLink`'s ACTIVE-row set for a given account is, by construction of the Step 3 dual-write, the same set `WorkspaceAccountShare` has — so the swap should be behaviorally invisible.
- Worst-case failure mode (a stale or missing link skips/double-runs a snapshot regen for one space) is self-correcting on the next Plaid refresh or share change, and snapshot regen is already wrapped in non-fatal `try/catch` at every call site.
- It exercises the exact relation/model shape (`spaceAccountLink.findMany({ where: { financialAccountId: { in }, status: ACTIVE }, select: { spaceId: true } })`) that the higher-stakes reads in step 4 of section C will reuse — so this step doubles as the live proof-of-correctness for that pattern before anything user-facing depends on it.

Everything else in Table A (rows 1–3, 5–9) is deliberately left for subsequent, separately-approved steps, per "do not implement all decisions in one branch or one commit."

## E. Rollback plan

This is a read-only cutover — no schema or migration changes are involved, so rollback is a pure code revert, not a data operation:

1. **Revert the query change** in `lib/snapshots/regenerate.ts` back to `db.workspaceAccountShare.findMany(...)`. Single-file diff, trivially revertable via `git revert` or a direct re-edit.
2. **No data is at risk either direction.** `WorkspaceAccountShare` remains the write system of record throughout — Step 3's dual-write is untouched and keeps both tables in sync regardless of which one Step 4 reads from. Cutting a read over to `SpaceAccountLink` and rolling it back are both no-op from a data-integrity standpoint.
3. **No migration rollback needed.** `SpaceAccountLink` already exists (Step 1) and is already populated (Step 2 backfill + Step 3 dual-write); Step 4 changes which table a query reads, nothing about either table's structure or contents.
4. **Detection:** if snapshots stop regenerating for a space (or regenerate for the wrong set), that's the signal to revert immediately — compare `regenerateSnapshotsForAccounts()`'s returned space-ID list against the equivalent `workspaceAccountShare` query for the same account IDs; any mismatch indicates a dual-write gap that should be fixed in `lib/accounts/space-account-link.ts`, not papered over in the reader.
5. **Do not remove `WorkspaceAccountShare` writes or the table itself** as part of this or any near-term follow-up step — consistent with "keep changes additive before subtractive" and "do not remove legacy tables prematurely." Subtractive work is a separate, later, explicitly-approved step, gated on every read in Table A having been migrated and baked in production first.

---

Stopping here per instruction. No code, schema, or migration changes were made.
