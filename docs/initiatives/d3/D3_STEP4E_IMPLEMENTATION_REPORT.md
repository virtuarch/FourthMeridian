> **POINT-IN-TIME RECORD — immutable.** For current project status see `STATUS.md` at the repository root.

# D3 Step 4E — Missed Archived Assets Read Cutover: Implementation + Validation Report

Status: **implemented, validated, stopping per instruction. Legacy retirement, D2, D4 not started.**

## What changed

`app/(shell)/dashboard/settings/archived-assets/page.tsx` — the only file in scope. Its `db.financialAccount.findMany(...)` query (the source for the Archived Assets settings page's `assets` list) included `workspaceShares` to build each asset's `spaces: {id, name}[]` field. Swapped for `spaceAccountLinks`, matching the pattern already used by the sibling route `app/api/accounts/manual/archived/route.ts` (cut over in D3 Step 4B).

No `status` filter was added to the `spaceAccountLinks` include — the prior `workspaceShares` include had none either, so active and revoked links both surfaced on this page before, and both still do now. Preserving that was a deliberate choice, not an oversight: this page is explicitly an archive view, and narrowing to ACTIVE-only would be a behavior change outside the approved scope.

## Diff

```diff
         institution:   true,
-        workspaceShares: {
+        spaceAccountLinks: {
           select: {
-            // WorkspaceAccountShare keeps its own pre-Phase-1 relation name (workspace).
-            workspace: { select: { id: true, name: true } },
+            space: { select: { id: true, name: true } },
           },
         },
       },
       orderBy: { deletedAt: "desc" },
     }),
     ...
   const assets: ArchivedAsset[] = accounts.map((a) => ({
     ...
-    spaces: a.workspaceShares.map((s) => ({
-      id:   s.workspace.id,
-      name: s.workspace.name,
+    spaces: a.spaceAccountLinks.map((l) => ({
+      id:   l.space.id,
+      name: l.space.name,
     })),
   }));
```

The `ownerUserId` and `deletedAt: { not: null }` filters on the top-level query, the `orderBy`, `deriveSource()`, and every other field on `ArchivedAsset` are untouched. `ArchiveBinClient`'s prop shape (`assets: ArchivedAsset[]`, each with `spaces: {id, name}[]`) is unchanged — this is a pure relation swap, identical in kind to every other D3 Step 4 cutover.

## Impact map

| File | Used by | Effect |
|---|---|---|
| `app/(shell)/dashboard/settings/archived-assets/page.tsx` | Settings → Archived Assets page (server component, no API route) | Now reads `SpaceAccountLink` instead of `WorkspaceAccountShare` for the per-asset spaces list shown on each archived/soft-deleted account row |

Not affected, by design: `WorkspaceAccountShare` writes (every dual-write call site untouched), the `WorkspaceAccountShare` table itself (not removed, still the live write target), the two other tabs on this page (`archivedMemberships`/`trashedMemberships`, both `SpaceMember`-based, never touched `WorkspaceAccountShare`), `app/api/accounts/manual/archived/route.ts` (already cut over in 4B, not touched again here), schema/migrations (none), and any D2/D4 work (not started).

Per `docs/initiatives/d3/D3_LEGACY_RETIREMENT_AUDIT.md`, this was the last known production read path on `WorkspaceAccountShare`. With this cutover shipped, no `app/`, `lib/`, or `components/` code reads `WorkspaceAccountShare` for serving data — confirmed below by repo-wide grep, same method used to confirm the prior three cutover steps.

## Files changed

```
 M app/(shell)/dashboard/settings/archived-assets/page.tsx
```

`git diff --stat -- prisma/` returned empty — no schema or migration changes. No write path, no UI component other than the one in scope, and no D2/D4 file was touched.

## Validation results

- `npx tsc --noEmit` — clean, zero errors.
- `npm run lint` — clean; only the same 4 pre-existing warnings in untouched files (`AccountModal.tsx:45`, `TotpSection.tsx:152`, `CoinIcon.tsx:78`, `:97`, all `@next/next/no-img-element`) seen in every prior D3 Step 4 report — unrelated to this change.
- Repo-wide grep for `workspaceShares`/`workspaceAccountShare` post-change — the only remaining matches are write paths, the dual-write helper module, seed/tooling scripts, the schema model itself, and stale comments, matching `docs/initiatives/d3/D3_LEGACY_RETIREMENT_AUDIT.md`'s inventory minus this one entry. No application read path references it anymore.
- Manual test (Archived Assets page loads; archived assets still show associated Spaces correctly) — **not performed by me**, same DB-access limitation noted in every prior report (sandbox has no route to the dev database — `localhost:5432` connection refused). Recommend running this locally before merge. If an archived account's spaces list comes back empty where it previously showed a space, that would point to the same `SpaceAccountLink` completeness question raised in `docs/initiatives/d3/D3_STEP4C_REGRESSION_ROOT_CAUSE.md` (unresolved as of the legacy retirement audit) — not a new bug introduced by this change, since the query logic is structurally identical to the already-shipped `manual/archived/route.ts` cutover.

## Rollback plan

Pure code revert, no schema or data risk:
- `git checkout -- "app/(shell)/dashboard/settings/archived-assets/page.tsx"`, or revert the relation-name/select swap directly.
- `WorkspaceAccountShare` remains the live write target throughout (dual-write untouched) — reverting this read is a no-op for data integrity.
- Detection signal: if this page's spaces list disagrees with what `app/api/accounts/manual/archived/route.ts` shows for the same manual asset (the one place the two overlap), that indicates a `SpaceAccountLink` data gap, not new drift from this step — both now run the same query shape.

Stopping here per instruction. Legacy retirement, D2, and D4 not started.
