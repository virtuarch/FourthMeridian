> **POINT-IN-TIME RECORD — immutable.** For current project status see `STATUS.md` at the repository root.

# D2 Step 1D (proposed) — ProviderAccountIdentity Multi-Account Correction

Status: **revised recommendation/checklist only. No code, schema, or migration changes made.**
Supersedes the collision-handling portions of `D2_STEP2_WALLET_DUAL_WRITE_IMPLEMENTATION_CHECKLIST.md`
(now marked superseded) and corrects the framing in
`D2_STEP2_WALLET_DUAL_WRITE_INVESTIGATION.md` §C.

Corrected model, as specified:

```text
ProviderAccountIdentity(ProviderType.WALLET, externalAccountId = 0xABC123)
        │
        ├── FinancialAccount A — Chris's private interpretation/watch/account
        ├── FinancialAccount B — Alice's private interpretation/watch/account
        └── FinancialAccount C — Public whale-watch Space interpretation
```

A wallet address is a public external fact. A `FinancialAccount` is a private Fourth Meridian
object. Knowing an address must never grant access to someone else's `FinancialAccount` or its
metadata (imported history, categories, notes, AI insights, goals, tax annotations). Re-read
directly for this analysis: `prisma/schema.prisma` lines 521–574 (`Connection`,
`ProviderAccountIdentity`) and 633–719 (`FinancialAccount`) — not assumed from prior reports.

---

## 1. Does the current constraint support this model?

**No — confirmed by direct schema read, not inferred.** Two facts combine to force "one
`FinancialAccount` per wallet address," exactly as suspected:

```prisma
model ProviderAccountIdentity {
  id                 String           @id @default(cuid())
  financialAccountId String                                    // required, singular
  financialAccount   FinancialAccount @relation(fields: [financialAccountId], references: [id], onDelete: Cascade)
  ...
  @@unique([provider, externalAccountId])                      // global, no financialAccountId in the key
}
```

- `financialAccountId` is required and singular — every row points to exactly **one**
  `FinancialAccount`.
- `@@unique([provider, externalAccountId])` means **at most one row can ever exist** for a
  given `(WALLET, 0xABC123)`, full stop — regardless of which `FinancialAccount` would hold it.

Walk through what actually happens today if Chris's account already holds the
`(WALLET, 0xABC123)` row and Alice's wallet route tries to dual-write the same address for her
own `FinancialAccount`: `dualWriteProviderAccountIdentity()` looks for an existing row by
`{financialAccountId: aliceFinancialAccountId, provider: WALLET}` — finds none (the existing
row belongs to Chris's account, not hers) — and attempts `create()`. That `create()` collides
with the unique constraint, throws, and is caught by the helper's own try/catch (its whole
design point is to never block the primary write) — logged via `console.warn` and silently
swallowed. **Alice's `FinancialAccount` would simply never get a `ProviderAccountIdentity` row,
indefinitely, with no operator-visible failure beyond a buried log line.** This is a real,
mechanical consequence of the current schema, not a hypothetical.

## 2. Smallest correction

Change the unique constraint from `(provider, externalAccountId)` to
`(provider, externalAccountId, financialAccountId)`:

```diff
- @@unique([provider, externalAccountId])
+ @@unique([provider, externalAccountId, financialAccountId])
```

No new table, no new column, no FK-direction change, no change to any reader's code shape —
`financialAccountId` keeps meaning exactly what it means today on every existing row. What
changes: multiple rows may now share the same `(provider, externalAccountId)` value as long as
each points at a different `FinancialAccount`. The diagram's "one public identity, many private
interpretations" is realized as **N rows sharing the same `externalAccountId` value**, each
with its own `financialAccountId` — not as one row referenced by N accounts. A future "who else
is tracking this address" query is a plain `WHERE provider = 'WALLET' AND externalAccountId =
'0xABC123'` returning N rows, each joinable to its own `FinancialAccount`.

**This is a migration.** Relaxing a unique constraint is the low-risk direction, though — it
can never violate a row that already exists (you're removing a restriction, not adding one),
so `npx prisma migrate dev` needs no accompanying data backfill or cleanup step. Confirm this
by reading the generated migration diff before applying it: it should be exactly "drop index X,
create index Y," nothing else.

**Does this weaken PLAID's protection?** No — checked directly, not assumed. PLAID's real
uniqueness guarantee never lived solely in this constraint; `FinancialAccount.plaidAccountId`
(schema.prisma:665) carries its own independent `@unique`, untouched by this change. Two
`FinancialAccount` rows could still never legitimately hold the same `plaidAccountId` even
after this migration. `walletAddress` (schema.prisma:676) has no equivalent independent
constraint and never did — so WALLET isn't losing a safety net either; it never had this one to
lose, only the *false* one this migration removes.

**Considered and rejected as the correction (not the smallest fix):** reversing the relation so
`ProviderAccountIdentity` becomes the true structural parent (`FinancialAccount.providerIdentityId
→ ProviderAccountIdentity`, with the FK direction flipped and `financialAccountId` removed from
`ProviderAccountIdentity` entirely). This is arguably the more "textbook" shape for the
diagram, but it ripples into every existing reader: the PLAID call site, the dual-write helper,
both scripts, and the restore route — all already shipped and validated, and explicitly
off-limits for re-touching right now. The composite-unique fix achieves the same outcome
(many `FinancialAccount`s, one recognized address) without moving anything PLAID already
depends on.

**Optional, while the migration is open (not required for the core fix):** add a second,
independent constraint `@@unique([provider, financialAccountId])`. This would make "at most one
WALLET identity row per `FinancialAccount`" a hard DB guarantee instead of relying solely on the
dual-write helper's own find-then-update logic. Worth doing in the same migration since it's
free once the file is open; not a blocker if deferred.

## 3. Should WALLET dual-write be paused until this is corrected?

**Yes.** Not as a matter of sequencing convenience — under the current constraint, dual-write
calls for any account whose address collides with another user's already-written identity will
silently fail (per §1), with zero operator visibility. Shipping dual-write call sites before
this migration lands means shipping a code path that quietly drops data for exactly the
cross-owner case the corrected model says is normal and expected to occur. The migration is a
precondition, not parallel work.

## 4. What should `wallet/route.ts` do today on a cross-owner address match?

**Nothing different from its current, already-shipped behavior.** The previous checklist's
recommendation — drop `ownerUserId` from the active/archived lookups, re-share or reactivate
into the second user's space — is rejected outright; it would grant a second user live access
to the first user's private `FinancialAccount` (and everything hanging off it) on nothing
stronger than typing in a string. Reverting to today's actual behavior:

- Active-match lookup stays exactly `{ ownerUserId: userId, walletAddress, deletedAt: null }`
  (unchanged, lines 52–55).
- Archived-match lookup stays exactly `{ ownerUserId: userId, walletAddress, deletedAt: null }`
  (unchanged, lines 127–130).
- Same-owner archived-duplicate fold (lines 99–102) stays exactly as-is.
- If no match for *this* user, the create branch runs exactly as today (lines 192–207) —
  produces a new, independent `FinancialAccount`, `AccountConnection`, and
  `WorkspaceAccountShare` for this user, **even though another user already has a
  `FinancialAccount` for the identical address.** That's not a bug under the corrected model —
  it's the intended outcome: Chris's and Alice's private interpretations of the same public
  address are supposed to be two separate rows.

No new collision-handling logic is needed in this route at all. The entire §2/§3 collision
design from the superseded checklist is unnecessary under the corrected model — once §2's
migration lands, a "collision" at the `FinancialAccount` layer isn't an error case to handle,
it's just two unrelated private accounts that happen to reference the same public address.

## 5. What should `findActiveAccountByIdentity()` do for WALLET?

**No change. Stays owner-scoped exactly as it is today** (`lib/accounts/reconcile.ts` lines
116–123). This directly reverses the previous checklist's §4 recommendation to make it global.
This function backs the generic restore route — making it global would mean restoring Chris's
archived wallet could silently fold it into Alice's unrelated active account of the same
address, which is precisely the cross-owner exposure now being ruled out.

`mergeArchivedDuplicateIntoCanonical()` (lines ~335–432): still no change needed, for a
different reason than before — it's same-owner-only fold logic (the only caller that reaches it
for wallets is the same-owner archived-duplicate branch in §4 above), so it was never actually
implicated in the cross-owner question either way.

## 6. How should backfill handle duplicate wallet addresses across users?

**It no longer needs to "handle" them at all, once §2's migration lands.** The
1C-C-recommended Option B (pre-check, exclude colliding addresses, backfill the rest) existed
specifically to work around the one-row-per-address constraint — that workaround is no longer
necessary once the constraint is corrected to allow one row per `(address, FinancialAccount)`
pair. Revised backfill design: every eligible active WALLET `FinancialAccount`
(`deletedAt IS NULL`, `walletAddress IS NOT NULL`) gets its own
`ProviderAccountIdentity` row, full stop — no exclusion set, no pre-check-driven skip logic, no
distinction between "collision-free" and "colliding" addresses. This is materially simpler than
the superseded checklist's §5, not just different.

The §1 pre-check queries from the original 1C-C investigation are still worth running — not to
decide what to exclude, but as a one-time sanity read on how many addresses are actually shared
across users today, useful context for prioritizing/sizing this work, not a gate on it.

## 7. What should be deferred to future signature verification?

Everything that would grant capability or trust based on proving address ownership:

- Rejecting a wallet-add submission for an address the submitter can't cryptographically prove
  control of (today's no-friction add stays as-is).
- Any "verified owner" flag or badge on `FinancialAccount`/`ProviderAccountIdentity`.
- Any privilege that lets a verified owner act on, merge into, or gain visibility into another
  user's unverified private interpretation of the same address.
- Enabling any write-capable or sync-privileged behavior tied to an address (vs. today's
  passive/manual entry).

None of the above is needed for this correction. The corrected model deliberately grants zero
new access based on address knowledge alone — every `FinancialAccount` stays exactly as private
as it is today. Signature verification remains a distinct future decision, not a precondition
or a side effect of this slice.

## 8. Is this still D2 Step 2, or its own prerequisite slice?

**Its own small prerequisite slice — proposing it as D2 Step 1D.** Reasoning: what surfaced
here is a modeling defect in `ProviderAccountIdentity` itself, shipped in Step 1B — it cannot
represent "one public identity, many private interpretations," a case Step 1B's design didn't
anticipate. That's a correction to the *schema* layer, categorically different from Step 2's
job (extend the existing dual-write *write-path* pattern to a new provider). Bundling a
unique-constraint migration into "Step 2 WALLET dual-write" would conflate a schema-correctness
fix with a mechanical write-path extension in one commit/PR — against the project's standing
practice of one decision, one reviewable slice at a time. Recommended sequencing:

1. **D2 Step 1D** (this slice): migrate the constraint (§2), validate, ship on its own.
2. **D2 Step 2 WALLET** (resumed, simplified): add the three `dualWriteProviderAccountIdentity`
   call sites to `wallet/route.ts` (unchanged from the superseded checklist's §3 — that part
   was never the problem) — now with no collision-handling logic needed anywhere, since §4
   above establishes the route needs none.
3. **Backfill/verify extensions** (§6 above): simplified versions of the superseded checklist's
   §5/§6, no exclusion-set machinery.

This is a recommendation for whoever owns the roadmap numbering, not a unilateral renumbering —
flagging it as "Step 1D" here so it's traceable, not asserting it into `D2_ROADMAP.md` myself.

---

## Revised checklist (lightweight — most of the superseded checklist's complexity is gone)

**Step 1D — schema correction:**
- [ ] `prisma/schema.prisma`: change `ProviderAccountIdentity`'s
      `@@unique([provider, externalAccountId])` to
      `@@unique([provider, externalAccountId, financialAccountId])`.
- [ ] Optional, same migration: add `@@unique([provider, financialAccountId])` as a second,
      independent constraint (belt-and-suspenders on "one WALLET identity per account").
- [ ] `npx prisma generate`, then `npx prisma migrate dev` — read the generated migration
      file before applying; expect exactly an index drop + index create, nothing else.
- [ ] `npx tsc --noEmit`, `npm run lint`.
- [ ] Confirm via direct query that PLAID rows are unaffected: `FinancialAccount.plaidAccountId`
      uniqueness still holds independently (it does — different column, different constraint).

**Step 2 WALLET (resumed) — dual-write call sites only, no collision logic:**
- [ ] `app/api/accounts/wallet/route.ts`: add `ProviderType` to the existing import (currently
      missing) and import `dualWriteProviderAccountIdentity`.
- [ ] Call it in the active-match branch (`activeFa.id`), the archived/reactivate branch
      (`archivedFa.id`), and the create branch (`fa.id`) — three call sites, owner-scoped
      lookups in all three branches **unchanged** from current shipped behavior.
- [ ] No new 409, no new sharing, no new merge logic anywhere in this route.

**Backfill/verify (after Step 1D ships):**
- [ ] `scripts/backfill-provider-account-identity.ts`: add a WALLET branch covering every
      eligible active account, no exclusion set.
- [ ] `scripts/verify-provider-account-identity-backfill.ts`: extend checks 1–3 to WALLET for
      all eligible accounts (no exclusion bucket); generalize check 5 beyond PLAID-only; add an
      informational "N addresses tracked by more than one account" report (descriptive now, not
      a risk flag — multiple owners per address is the expected, intended state).

**Files expected to change:** `prisma/schema.prisma`, `app/api/accounts/wallet/route.ts`,
`scripts/backfill-provider-account-identity.ts`,
`scripts/verify-provider-account-identity-backfill.ts`.

**Not expected to change:** `lib/accounts/reconcile.ts` (both `findActiveAccountByIdentity`'s
WALLET branch and `mergeArchivedDuplicateIntoCanonical()` need no edits — see §5);
`lib/accounts/provider-identity.ts` (already provider-generic); anything PLAID-related.

**Rollback:** the schema correction (Step 1D) reverts cleanly — re-tightening a constraint
that no live duplicate rows exist yet to violate is a normal reversible migration, unlike the
superseded checklist's asymmetric rollback concern (which existed only because that checklist
proposed a real cross-owner *behavior* change). Nothing in this revised plan grants new
cross-account access at any point, so there is no "already-granted share that a code revert
can't undo" risk this time.

---

Stopping here. No code, schema, or migration changes have been made. Awaiting approval to
implement.
