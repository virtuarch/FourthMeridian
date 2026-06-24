# D3 Legacy Retirement Audit — WorkspaceAccountShare

Status: **read-only audit. No code, schema, or migration changes were made.**

## Bottom line

D3 Step 4D did cut over the two files it targeted (`app/api/brief/route.ts`, `app/api/spaces/[id]/accounts/route.ts`), and earlier steps cut over every file the original `docs/initiatives/d3/D3_STEP4_READ_CUTOVER_REVIEW.md` inventory identified. But that inventory had a gap: it never listed `app/(shell)/dashboard/settings/archived-assets/page.tsx`, a Server Component that queries `db.financialAccount.findMany(...)` directly with its own `workspaceShares` include — a separate code path from the already-migrated `app/api/accounts/manual/archived/route.ts` API route it sits next to. That page is a live, request-serving read still on `WorkspaceAccountShare` today. The claim "no production read paths should remain on WorkspaceAccountShare" is not yet true.

Past that one finding, every other `WorkspaceAccountShare` reference left in the codebase is exactly what the D3 plan expected at this stage: write paths (still required — `WorkspaceAccountShare` is the only write target), the dual-write infrastructure that mirrors those writes onto `SpaceAccountLink`, one-time/offline tooling, the schema model itself, and stale comments. Nothing else reads it for serving data.

## 1–2. Inventory and classification

54 files repo-wide match `WorkspaceAccountShare`, `workspaceAccountShare`, or `workspaceShares`. Grouped by classification:

| Classification | Count | Files |
|---|---|---|
| **Accidental remaining read** | 1 | `app/(shell)/dashboard/settings/archived-assets/page.tsx` |
| **Write path** (still the system of record) | 12 | `app/api/plaid/exchange-token/route.ts`, `app/api/accounts/wallet/route.ts`, `app/api/accounts/manual/route.ts`, `app/api/accounts/manual/[id]/route.ts`, `app/api/accounts/manual/[id]/restore/route.ts`, `app/api/accounts/manual/[id]/permanent/route.ts`, `app/api/accounts/[id]/route.ts`, `app/api/accounts/[id]/restore/route.ts`, `app/api/spaces/[id]/accounts/share/route.ts`, `app/api/spaces/[id]/members/[userId]/route.ts`, `lib/accounts/reconcile.ts` |
| **Dual-write compatibility** (mirrors writes onto SpaceAccountLink) | 1 | `lib/accounts/space-account-link.ts` |
| **Seed/test/tooling** | 4 | `prisma/seed.ts`, `scripts/backfill-space-account-link.ts`, `scripts/verify-space-account-link-backfill.ts`, `scripts/correct-home-links.ts` |
| **Schema relation/model only** | 4 | `prisma/schema.prisma`, plus 3 immutable historical migration files |
| **Comments/docs naming (stale, zero functional reference)** | 13 | `lib/data/accounts.ts`, `lib/data/transactions.ts`, `app/api/brief/route.ts`, `app/api/spaces/[id]/accounts/route.ts`, `app/api/accounts/manual/archived/route.ts`, `app/api/accounts/[id]/transactions/route.ts`, `lib/snapshots/regenerate.ts`, `lib/space-nav.ts`, `lib/plaid/refresh.ts`, `lib/account-privacy.ts`, `components/dashboard/RemoveAccountButton.tsx`, `app/api/spaces/[id]/route.ts`, `app/api/spaces/[id]/restore/route.ts`, `app/api/spaces/[id]/permanent/route.ts` |
| **Planning/historical docs** (decision record, not code) | 18 | `docs/initiatives/d3/D3_STEP4D_IMPLEMENTATION_REPORT.md`, `docs/initiatives/d3/D3_STEP4C_REGRESSION_ROOT_CAUSE.md`, `docs/initiatives/d3/D3_STEP4C_IMPLEMENTATION_REPORT.md`, `docs/initiatives/d3/D3_STEP3_HOME_SEMANTICS_CORRECTION.md`, `docs/initiatives/d3/D3_STEP4C_CORE_DASHBOARD_REVIEW.md`, `docs/initiatives/d3/D3_STEP4_READ_CUTOVER_REVIEW.md`, `docs/initiatives/d3/D3_STEP3_DUAL_WRITE_REVIEW.md`, `docs/initiatives/d3/D3_STEP2_BACKFILL_REVIEW.md`, `docs/initiatives/d3/D3_SPACE_ACCOUNT_LINK_REVIEW.md`, `docs/architecture/D2_CONNECTION_ARCHITECTURE_REVIEW.md`, `docs/bugfixes/BUGFIX_ARCHIVED_ACCOUNT_SNAPSHOT_STALENESS.md`, `docs/initiatives/d1/D1_DUPLICATE_ACCOUNT_CANDIDATE_DESIGN_REVIEW.md`, `docs/architecture/PHASE_2_DECISION_MATRIX.md`, `docs/architecture/PHASE_2_ARCHITECTURE_FREEZE.md`, `docs/architecture/WORKSPACE_TO_SPACE_RENAME_PLAN.md`, `docs/architecture/DATABASE_ARCHITECTURE_REVIEW.md`, `docs/releases/v2.0.1.md`, `fourth-meridian-product-language.md` |
| **Diagram** | 1 | `docs/images/architecture/architecture-map.svg` (label already rendered with strikethrough) |

54 total. Detail on the two categories that need explanation, and the write-path nuance worth flagging separately:

**The accidental read** — `app/(shell)/dashboard/settings/archived-assets/page.tsx:34-54` runs its own `db.financialAccount.findMany({ where: { ownerUserId, deletedAt: { not: null } }, select: { ..., workspaceShares: { select: { workspace: { select: { id, name } } } } } } })`, then maps `a.workspaceShares` into the `spaces: { id, name }[]` field of `ArchivedAsset` (line 90-93). This is the Archived Assets settings page — a real, currently-reachable page, not a deleted or disabled route. Its sibling API route, `app/api/accounts/manual/archived/route.ts`, returns the same shape for manual-only assets and *was* cut over to `spaceAccountLinks` in D3 Step 4B — but the page doesn't call that route; it queries the database itself, more broadly (Plaid, manual, and wallet accounts, not just manual). `docs/initiatives/d3/D3_STEP4_READ_CUTOVER_REVIEW.md`'s inventory (row 7) only ever named the API route. The page was never in the inventory, so it was never a cutover candidate, so it was never migrated. This is the one concrete instance of the "accidental remaining read" category the audit asked about.

**Write-path read-before-write nuance** — Six of the twelve write-path files (`app/api/accounts/[id]/route.ts`, `app/api/accounts/manual/[id]/route.ts`, `app/api/accounts/manual/[id]/restore/route.ts`, `app/api/accounts/[id]/restore/route.ts`, `app/api/spaces/[id]/members/[userId]/route.ts`, `lib/accounts/reconcile.ts`) read `WorkspaceAccountShare` rows immediately before mutating them, to capture the pre-mutation state for the dual-write mirror call. One of these, `app/api/accounts/[id]/route.ts`'s DELETE handler, also uses that same read for something beyond mirroring: `fa.workspaceShares.find(s => s.addedByUserId === user.id)` (line 142-144) is the authorization check that decides whether the caller may delete the account at all, and the same read also supplies the audit-log `spaceId` (line 215) and the list of spaces to re-snapshot (line 191). This is still fundamentally a write-path read — it only runs inside a mutation, never serves a GET — but unlike the other five, it isn't purely mirroring input; it's load-bearing for authorization. That matters for investigation point 4 below: this specific read needs attention before `WorkspaceAccountShare` reads can be removed from the write paths themselves, not just before the table stops being written.

## 3. Do any production read paths still use WorkspaceAccountShare?

Yes — one: `app/(shell)/dashboard/settings/archived-assets/page.tsx`, described above. Every other reference that touches `WorkspaceAccountShare` either is a write, mirrors a write, is tooling/seed code, is the schema definition itself, or is a comment. The D3 Step 4 program is real and mostly complete — this is a single missed page, not a sign the cutover didn't happen.

## 4. What must happen before WorkspaceAccountShare can be stopped as a write target

Five gating items, in the order they should be resolved:

1. **Fix the one accidental read.** Cut `app/(shell)/dashboard/settings/archived-assets/page.tsx` over to `spaceAccountLinks`, matching the shape `app/api/accounts/manual/archived/route.ts` already uses. Until this ships, stopping writes to `WorkspaceAccountShare` would make this page's account-to-space mapping silently go stale.
2. **Migrate the authorization-load-bearing read.** `app/api/accounts/[id]/route.ts`'s DELETE handler needs to derive its `userShare` authorization check, audit-log `spaceId`, and snapshot-regen space list from `SpaceAccountLink` instead of `fa.workspaceShares`. Otherwise this access-control decision keeps depending on a table that's no longer being kept current.
3. **Resolve the open data-gap question from the regression report.** `docs/initiatives/d3/D3_STEP4C_REGRESSION_ROOT_CAUSE.md` flagged that `SpaceAccountLink` may have completeness gaps (missing rows, status drift) that have not yet been confirmed fixed — `scripts/verify-space-account-link-backfill.ts` has not been re-run since before that investigation. Stopping writes to `WorkspaceAccountShare` permanently freezes whatever gap exists today. This must show clean before writes stop, not just before reads were cut over.
4. **Fix or mitigate the dual-write race in `app/api/accounts/manual/route.ts`.** Its concurrent `Promise.all` over `dualWriteSpaceAccountLink()` calls (flagged in the regression report as a real defect) can produce two `HOME` rows for one account under concurrent multi-space sharing at creation time. This is survivable today because `WorkspaceAccountShare` is still the authoritative visibility source and `kind` is never read for visibility — but once `SpaceAccountLink` is the only write target, a `kind` miscount becomes a permanent, uncorrectable data error for that account (no `WorkspaceAccountShare` copy left to re-derive from).
5. **Address the Rule 5 silent-failure design.** Every dual-write call is best-effort and only `console.warn`s on failure (`lib/accounts/space-account-link.ts`). That was an acceptable risk while `WorkspaceAccountShare` was the safety net underneath it. Once it's the only path forward, a silently-failed dual-write becomes a silently-missing row with no fallback. At minimum this needs visible alerting before writes stop; ideally a retry or reconciliation job.

Only after all five are done should `verify-space-account-link-backfill.ts --verbose` be re-run once more as a final go/no-go gate, immediately before flipping any write path off.

## 5. What must happen before WorkspaceAccountShare can be removed from the Prisma schema

Everything in (4), plus:

- All twelve write paths actually stop writing to `WorkspaceAccountShare` (not just capable of stopping — actually switched, deployed, and baked).
- The four back-relations tied to the model are removed together with it: `User.addedShares`/`revokedShares` (`@relation("ShareAdder")`/`("ShareRevoker")`), `Space.accountShares`, `FinancialAccount.workspaceShares`. None of these are independently retirable — they exist only because the model exists.
- A new, additive-first migration drops the table; the three existing migrations that created/altered it (`20260611000001_financial_account_tables`, `20260611144156_financial_account_sharing`) are never edited — migration history is immutable, and a `DropTable` is itself a new migration, not a rewrite of old ones.
- `docs/architecture/PHASE_2_ARCHITECTURE_FREEZE.md` currently lists `WorkspaceAccountShare` as a "**Protected legacy table — deliberately excluded from Phase 1 naming and from any Phase 2 schema change**" (its own §17 reference). Read literally, that freeze covers schema changes to the table, which removal is. This audit cannot tell you whether that protection was meant to expire once D3 fully supersedes it or whether removal needs a separate, explicit freeze amendment — that's a product/architecture call, not something inferable from the code. Flagging it so it isn't missed: **get explicit sign-off that removal is in-scope before scheduling it**, independent of the technical sequence above.
- `ShareStatus` (the enum) and `VisibilityLevel.SHARED` are not exclusively `WorkspaceAccountShare`'s — `ShareStatus` is shared with `SpaceAccountLink`, and `VisibilityLevel.SHARED` is documented as "legacy — maps to FULL; kept for backward compat with **Account model**" (the unrelated legacy table, not `WorkspaceAccountShare`). Removing `WorkspaceAccountShare` should not touch either enum.

## 6. Related legacy fields likely to retire later

- **`ownerSpaceId` / `ownerWorkspaceId`** — `FinancialAccount.ownerSpaceId` is already `@map("ownerWorkspaceId")` (Prisma-layer rename done; DB column name unchanged, no DDL). The `SpaceAccountLink` model's own header comment says it's the intended future consolidation of *both* `WorkspaceAccountShare` and `ownerSpaceId`/`ownerUserId` (`kind: HOME` replaces the declared-owner pair). That makes this a second, related-but-separate legacy retirement, one step behind this one — it shouldn't be bundled into the `WorkspaceAccountShare` retirement, but it's the logical next audit once `SpaceAccountLink.kind: HOME` is fully trusted as ownership source of truth.
- **`ownerType: SPACE`** — repo-wide grep found only two references (`exchange-token/route.ts`, `permanent/route.ts`), neither of which actually sets `ownerType: AccountOwnerType.SPACE` on a write — every `FinancialAccount.create()` found in this audit sets `ownerType: USER`. `SPACE` appears to be a dormant, never-exercised enum value today. Low urgency, but worth confirming with a dedicated grep for `ownerType:\s*AccountOwnerType.SPACE` / `ownerType:\s*"SPACE"` before assuming it's truly unused anywhere (this audit's grep was scoped to `ownerSpaceId`/`ownerWorkspaceId`, not every `ownerType` write site).
- **`workspaceShares` / `accountShares` relation names** — covered in (5); retire together with the model, not independently.
- **Comments/docs naming** — the 13 stale-comment files listed in the inventory table reference `WorkspaceAccountShare` descriptively (mostly "this used to query X, see doc Y") and are already harmless, but should be swept once the table is actually gone, not before — editing them now would describe a cutover that hasn't shipped yet (the archived-assets page) or state things as past-tense that are still live (the write paths). The historical planning docs (`D3_STEP*`, `D2_CONNECTION_ARCHITECTURE_REVIEW.md`, `D1_DUPLICATE_ACCOUNT_CANDIDATE_DESIGN_REVIEW.md`, `PHASE_2_ARCHITECTURE_FREEZE.md`, `DATABASE_ARCHITECTURE_REVIEW.md`) are decision records and per the project's own rule `WORKSPACE_TO_SPACE_RENAME_PLAN.md` is historical-context-only — none of these should be rewritten even at final cleanup; they're the audit trail of how this happened, not living documentation. `docs/images/architecture/architecture-map.svg` already renders its `WorkspaceAccountShare` label with a strikethrough — someone already marked it deprecated visually; deleting that label is a one-line SVG edit once the table is gone, not before.

## 7. Proposed safe retirement sequence

1. **Stop reads (remaining work, not yet done):** cut over `app/(shell)/dashboard/settings/archived-assets/page.tsx`. This is the only thing standing between "no production read paths" being true today and being aspirational.
2. **Bake:** run with both tables live, `WorkspaceAccountShare` still the only write target, for a deliberate period. During this window: re-run and pass `verify-space-account-link-backfill.ts --verbose` clean; fix the `manual/route.ts` concurrency race; resolve or accept-with-monitoring the Rule 5 silent-failure risk; migrate the `accounts/[id]/route.ts` authorization read off `workspaceShares`.
3. **Stop writes:** flip the twelve write paths to write `SpaceAccountLink` only, in their own small batches per the project's "not all in one commit" rule — not all twelve at once. `WorkspaceAccountShare` rows stop changing from this point; existing rows are retained, untouched, as a rollback fallback.
4. **Bake:** confirm nothing depended on `WorkspaceAccountShare` continuing to update (e.g., any report, export, or admin view not caught by this audit's grep that reads it expecting fresh data). Watch for the failure mode being silence, not an error — that's this system's established pattern.
5. **Remove table/relations:** only after explicit confirmation that `docs/architecture/PHASE_2_ARCHITECTURE_FREEZE.md`'s protection on this table is meant to be lifted at this point. Then: one migration to drop the table, one schema edit to remove the model and its four back-relations.
6. **Cleanup names/comments:** sweep the 13 stale-comment code files. Leave the historical docs and migration files untouched. Delete the struck-through label from the architecture diagram.

Each numbered stage above is its own branch/commit per the project's standing rules — this sequence is not a license to do it in one pass.

## Risk assessment

| Risk | Severity | Notes |
|---|---|---|
| Archived Assets page silently drifts from `SpaceAccountLink` reality | Medium | Low-traffic settings page, audit-style view — wrong but not balance-bearing. Still a real bug once writes stop. |
| `manual/route.ts` HOME-kind race | Medium | Kind-correctness only; no visibility impact today. Becomes uncorrectable once `WorkspaceAccountShare` is gone. |
| Unconfirmed `SpaceAccountLink` completeness gap (regression report) | Medium-High | Directly blocks safely stopping writes; unresolved as of this audit. |
| Silent dual-write failures (Rule 5) | Medium | No alerting today; acceptable only while `WorkspaceAccountShare` is the fallback. |
| Authorization read in `accounts/[id]/route.ts` | Low-Medium | Functionally correct today (table still live); becomes a correctness risk only after writes stop, not before. |
| Removing the table against an active architecture freeze | Process risk | Needs explicit sign-off, not a technical fix. |

## Recommended timing

Not now, and not as the next D3 step. Item 1 (the accidental read) is small and could reasonably be its own immediate follow-up. Stopping writes is gated on the unresolved `SpaceAccountLink` data-gap question from the regression report — that should be closed out first, independent of this audit. Table removal is gated on an explicit freeze-amendment decision this audit can't make. Recommend treating "stop reads," "stop writes," and "remove table" as three separately-approved future steps, consistent with how D3 Step 4 was already broken into 4A/4B/4C/4D rather than shipped as one step.

## Rollback plan

Nothing in this audit changed code, so there is nothing to roll back from this step itself. For the sequence proposed above: stage 1 (archived-assets cutover) rolls back the same way every prior D3 Step 4 cutover did — pure `git revert`, zero data risk, `WorkspaceAccountShare` still live underneath. Stage 3 (stop writes) is the first stage with real rollback cost: reverting means re-enabling `WorkspaceAccountShare` writes, and any `SpaceAccountLink`-only writes that happened during the stopped-write window would need a gap-fill pass before `WorkspaceAccountShare` could be trusted again — this should be scoped explicitly when stage 3 is actually planned, not assumed. Stage 5 (table removal) is the only irreversible stage; it should not be scheduled until stages 1-4 have baked long enough that reverting is purely theoretical.

---

Stopping here per instruction. No implementation performed.
