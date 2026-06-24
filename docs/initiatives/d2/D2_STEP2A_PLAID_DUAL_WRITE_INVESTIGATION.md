# D2 Step 2A — PLAID ProviderAccountIdentity Dual-write Investigation

Status: **read-only investigation. No code, schema, or migration changes made.**

Context confirmed before writing this report:
- D2 1A, 1B applied locally. D2 1C-A/1C-B complete for PLAID (3 rows backfilled, verification passed). WALLET deferred per `docs/initiatives/d2/D2_STEP1C_C_WALLET_IDENTITY_COLLISION_INVESTIGATION.md` (global-unique schema vs. owner-scoped app behavior mismatch).
- `grep -r plaidAccountId` across `app/`, `lib/`, `jobs/` (excluding `scripts/`, `prisma/seed.ts`, and the already-ruled-out `manual/[id]/restore` route) returns exactly the files read for this report — every one is covered below.
- `grep -r "db.connection."` / `"prisma.connection."` across the whole repo returns **zero matches** — the `Connection` model (Step 1A) has no writers anywhere yet. This matters for the design in B: `connectionId` stays `null` in every dual-write path, consistent with the backfill script's existing rule.

---

## A. PLAID identity write-site inventory

**Central finding: every `FinancialAccount.plaidAccountId` create or reassignment happens in exactly one file — `app/api/plaid/exchange-token/route.ts` — at exactly two call sites.** No other route, job, or helper ever writes `plaidAccountId`. `lib/accounts/reconcile.ts` (the merge/dedup engine) never touches `plaidAccountId` on any row, on either side of a merge — confirmed by reading its full implementation. This significantly narrows the scope of the dual-write work.

| # | Location | Operation | plaidAccountId behavior | Identity action needed |
|---|---|---|---|---|
| 1 | `exchange-token/route.ts:132–149` — exact match found (`findUnique({ where: { plaidAccountId: acct.account_id } })`) | `financialAccount.update` (balance/availableBalance/creditLimit/syncStatus/deletedAt only) | **Unchanged** — this branch exists precisely because the value already matches | None required (value is by definition already correct). Optional defensive "ensure exists" — see B. |
| 2 | `exchange-token/route.ts:175–187` — fingerprint match resolved an **archived** or **differently-keyed** row as canonical (`resolveAccountByFingerprint` returned a result) | `financialAccount.update({ data: { plaidAccountId: acct.account_id, ... } })` | **Reassigned** — this is the literal repoint case described in `reconcile.ts`'s own header comment (Plaid reissuing `account_id` on reconnect; the historical 3-id Robinhood example) | **Upsert/repoint** — this is the one case that actually changes `externalAccountId` for an existing identity, or creates one for the first time if the canonical row predates backfill |
| 3 | `exchange-token/route.ts:189–218` — no match at all, brand-new account | `financialAccount.create({ data: { plaidAccountId: acct.account_id, ... } })` | **New value, new row** | **Create** — a fresh `ProviderAccountIdentity` row, no prior row can exist for a brand-new `financialAccountId` |

**Sites confirmed to never write `plaidAccountId` (read-only with respect to identity):**

- `lib/plaid/refresh.ts` (`refreshPlaidItem`) — looks accounts up `by plaidAccountId` (`findUnique({ where: { plaidAccountId } })`) to apply balance updates; explicitly documented in its own header as "never creates or restores a FinancialAccount." Never reassigns the field.
- `lib/plaid/syncTransactions.ts` (`syncTransactionsForItem`) — resolves `FinancialAccount.id` from `plaidAccountId` purely to attach transactions; read-only with respect to the account row's identity field.
- `app/api/plaid/refresh/route.ts`, `app/api/plaid/sync/route.ts`, `jobs/sync-banks.ts` — thin callers of the two functions above; no independent writes.
- `app/api/accounts/[id]/restore/route.ts` — generic restore; calls `mergeArchivedDuplicateIntoCanonical`/`resolveAccountByFingerprint` (reconcile.ts) but never assigns `plaidAccountId` itself (confirmed by reading reconcile.ts in full — see point 2 below).
- `app/api/accounts/[id]/route.ts` (PATCH/DELETE) — PATCH's allowed-field list never includes `plaidAccountId`; DELETE only ever sets `deletedAt`.
- `app/api/accounts/manual/[id]/restore/route.ts` — hard-guarded to `type === "other" && syncStatus === "manual"`, can never act on a Plaid-linked row.

**No Plaid webhook handler exists today.** Confirmed via `find app/api/plaid` — only `create-link-token`, `exchange-token`, `link-token`, `refresh`, `sync` exist. The webhook handler referenced in `lib/plaid/syncTransactions.ts`'s header comment ("a future Plaid webhook handler (SYNC_UPDATES_AVAILABLE)") is explicitly not yet built — nothing to dual-write there until it exists.

**Reconnect/relink/fingerprint-merge paths (investigation points 3–4), confirmed via full read of `lib/accounts/reconcile.ts`:**

- `resolveAccountByFingerprint()` — finds candidates, picks one canonical row via `pickCanonicalAndMerge()`, folds every other matching row's history into it via `mergeArchivedDuplicateIntoCanonical()`. **Returns the canonical row with its OWN existing `plaidAccountId` (old or null) — never modifies it.** The actual reassignment to the new `acct.account_id` happens back in `exchange-token/route.ts:176–187`, one line after `resolveAccountByFingerprint()` returns. This is why the dual-write hook belongs in the route, not inside `reconcile.ts`.
- `mergeArchivedDuplicateIntoCanonical(loserId, winnerId, ...)` — moves `Transaction`, `GoalContribution`, `DebtProfile`, `WorkspaceAccountShare` rows from loser to winner; writes a `DuplicateAccountCandidate` audit row. **Never touches `plaidAccountId` on either side.** The loser's `FinancialAccount` row is never hard-deleted (module header: "NEVER hard-deletes") — it stays archived, inert, forever.
- `pickCanonicalAndMerge()`'s loser-archival step (`reconcile.ts:199`) sets `deletedAt` on a loser that was simultaneously active under a different `plaidAccountId` — again, no `plaidAccountId` write.

**Conclusion for points 3–4:** reconcile.ts is purely a "move history, archive the loser" engine. It is never itself a `plaidAccountId` write site. Any existing `ProviderAccountIdentity` row belonging to a loser becomes orphaned the same way the loser's `FinancialAccount` row becomes archived — and per the precedent already established in `scripts/verify-provider-account-identity-backfill.ts` (Check 5: orphaned identities pointing at a soft-deleted account are **informational only, never a failure**), this is expected, tolerated behavior, not a gap to close. It mirrors the codebase's broader "preserve history, never hard-delete" philosophy exactly.

---

## B. Proposed dual-write helper design

**One helper, one call site type, two call sites.** Mirrors the existing `dualWriteSpaceAccountLink()` pattern already used throughout this codebase (best-effort, non-fatal, called inline after the primary write commits).

```ts
// lib/accounts/provider-identity.ts (proposed location/name — not created by this report)

async function dualWriteProviderAccountIdentity(
  financialAccountId: string,
  provider: ProviderType.PLAID,   // PLAID-only for this step; signature could
                                   // generalize later, but only PLAID is wired now
  externalAccountId: string
): Promise<void> {
  // Best-effort, non-fatal — never throws into the caller. Same pattern as
  // dualWriteSpaceAccountLink / regenerateSnapshotsForAccounts / every other
  // "mirror" write in this codebase.
  try {
    const existing = await db.providerAccountIdentity.findFirst({
      where: { financialAccountId, provider },
    });

    if (!existing) {
      await db.providerAccountIdentity.create({
        data: { financialAccountId, connectionId: null, provider, externalAccountId },
      });
      return;
    }

    if (existing.externalAccountId !== externalAccountId) {
      // The repoint case — Plaid reissued account_id for this row.
      await db.providerAccountIdentity.update({
        where: { id: existing.id },
        data:  { externalAccountId },
      });
    }
    // else: already correct, nothing to do — idempotent no-op.
  } catch (e) {
    // Defensive: a global (provider, externalAccountId) unique-constraint
    // violation here would mean some OTHER FinancialAccount already holds
    // this externalAccountId — extremely unlikely for PLAID (the value comes
    // straight from Plaid's own account_id, and findUnique({plaidAccountId})
    // already guarantees only one active row holds it), but caught rather
    // than allowed to fail the Plaid import/relink flow it's attached to.
    console.warn(`[dualWriteProviderAccountIdentity] failed for account ${financialAccountId} (non-fatal):`, e);
  }
}
```

**Call sites — both inside `app/api/plaid/exchange-token/route.ts`:**

1. **Create branch (line ~189–218):** call immediately after `fa = await db.financialAccount.create(...)`, passing `fa.id` and `acct.account_id`. Lands as a plain `create` inside the helper (no existing row possible).
2. **Fingerprint-resolved branch (line ~175–187):** call immediately after `fa = await db.financialAccount.update(...)` (the one that sets the new `plaidAccountId`), passing `fa.id` and `acct.account_id`. Lands as the `update`/repoint path if a stale row exists (e.g. the canonical account was previously backfilled under its old `plaidAccountId`), or a plain `create` if it was never backfilled at all (e.g. it was an archived fingerprint-only match with no identity row yet).
3. **Exact-match branch (line ~132–149) — optional, recommended:** call the same helper after the update, passing the unchanged `plaidAccountId`. Since the helper is idempotent (no-op when `externalAccountId` already matches), this costs nothing on the common path and self-heals any row that, for whatever reason, was never backfilled or whose identity row was lost — without needing to special-case "did the value actually change." Recommended specifically because it turns the whole identity table into a self-correcting mirror rather than something that can only be fixed by re-running the standalone backfill script.

**Why update-in-place rather than delete-then-create on repoint:** avoids a window where the `(provider, externalAccountId)` row briefly doesn't exist, and avoids any ordering question with the `onDelete: Cascade` FK. A plain `UPDATE ... SET externalAccountId` is the simplest correct operation here.

**Why never delete:** no path in this codebase ever hard-deletes a `FinancialAccount` row (confirmed — every "removal" is `deletedAt`-based). `ProviderAccountIdentity.financialAccountId` is `onDelete: Cascade`, so the row would only ever disappear automatically if a hard delete happened — which doesn't occur today. Consistent with `reconcile.ts`'s explicit "NEVER hard-deletes" philosophy, the dual-write design should never delete a `ProviderAccountIdentity` row either. An identity row left pointing at an archived loser is the same kind of tolerated, informational-only state as an archived `FinancialAccount` itself — already the precedent set by the 1C-B verification script's Check 5.

**`connectionId` stays `null`** at every call site, identical to the backfill script's existing rule — `Connection` has zero writers anywhere in the codebase today; wiring `PlaidItem → Connection` is out of scope for this step (carried over from the Step 1A/1C reports).

---

## C. Failure mode / rollback plan

| Failure mode | Effect | Mitigation |
|---|---|---|
| Dual-write throws (DB error, constraint violation) | Could block the Plaid import/relink flow if unhandled | Wrapped in try/catch inside the helper itself, logged, never re-thrown — matches every other "mirror" write in this codebase (`dualWriteSpaceAccountLink`, snapshot regeneration, etc.). The Plaid import succeeds regardless of identity-write outcome. |
| Repoint collides with another row's `(provider, externalAccountId)` | `update` throws a unique-constraint error, caught and logged per above | Should not occur in practice — `acct.account_id` is Plaid's own identifier and the canonical row was already resolved as the unique owner of that real-world account by `resolveAccountByFingerprint`. Flagged as defensive, not expected. |
| Dual-write silently no-ops when it should have written (bug in the helper) | Drift — `ProviderAccountIdentity` falls out of sync with `FinancialAccount.plaidAccountId` | Caught by the existing `scripts/verify-provider-account-identity-backfill.ts` Check 3 (provider mismatch) and Check 1 (missing identity) — re-run after any dual-write rollout to confirm no drift was introduced. |
| Need to roll back the dual-write entirely | `ProviderAccountIdentity` is still read by nothing | Same rollback as Step 1C: `DELETE FROM "ProviderAccountIdentity";` followed by re-running the Step 1C-A backfill script clean. Removing the dual-write call sites themselves is a pure code revert — no migration involved, since no schema changes are proposed by this step. |

No schema change is needed to support this design — the existing `@@unique([provider, externalAccountId])` and `@@index([financialAccountId])` (Step 1B) are sufficient. The helper's `findFirst({ where: { financialAccountId, provider } })` is not backed by a unique index (there's no `@@unique([financialAccountId, provider])`), so it relies on the application-level invariant that at most one PLAID identity row exists per account — already verified true today by the 1C-B verification script's Check 2, and not threatened by this design since the helper never creates a second row when one already exists.

---

## D. Smallest safe implementation slice

Given the inventory in A, the implementation (not performed by this report) reduces to a small, contained change:

1. Add the single helper function (`dualWriteProviderAccountIdentity` or equivalent) in a new or existing `lib/accounts/` file.
2. Call it at exactly the two required sites inside `app/api/plaid/exchange-token/route.ts` (create branch, fingerprint-resolved branch) — the third (exact-match) call site is recommended but separable; could ship in a follow-up if the team wants the first slice even smaller.
3. No changes to `lib/plaid/refresh.ts`, `lib/plaid/syncTransactions.ts`, `reconcile.ts`, any restore/delete route, or any job — confirmed none of them need one.
4. Re-run `scripts/verify-provider-account-identity-backfill.ts` after shipping to confirm the existing 3 backfilled rows still pass and no new drift was introduced by the change itself.
5. No schema change, no migration, no read cutover — `ProviderAccountIdentity` remains write-only/unread by application code until a separate, later step.

This is not an implementation request — per the brief, this report stops here.

---

## Open items carried forward (not resolved by this report)

1. Whether the exact-match branch's defensive "ensure exists" call (B, call site 3) ships in the same change as the other two, or as a deliberate follow-up — a scope choice, not a technical blocker.
2. `Connection`/`connectionId` wiring remains entirely unaddressed — unchanged from Step 1A/1C.
3. WALLET dual-write is explicitly out of scope here and remains blocked on the collision-handling decision from Step 1C-C.

**No implementation performed. No schema, migration, route, UI, or data changes made in this step.**
