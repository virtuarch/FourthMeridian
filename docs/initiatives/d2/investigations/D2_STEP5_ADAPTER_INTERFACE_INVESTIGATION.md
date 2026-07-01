> **POINT-IN-TIME RECORD — immutable.** For current project status see `STATUS.md` at the repository root.

# D2 Step 5 — Adapter Interface Investigation

**Investigation only. No code, schema, or migration changes were made to
produce this document, and no other document was modified.** Branch:
`feature/phase-2-architecture`. Baseline: `v2.3.0`.

Goal: design the smallest adapter interface needed to support existing
provider flows without overbuilding. Scope is repo-wide read-only
investigation — find what already exists, then propose the least-disruptive
shape Step 5 should formalize. Nothing here is approved for implementation;
see §10 for the stop point.

Inputs read in full for this investigation: `lib/plaid/refresh.ts`,
`lib/plaid/syncTransactions.ts`, `lib/accounts/provider-identity.ts`,
`app/api/plaid/sync/route.ts`, `app/api/plaid/exchange-token/route.ts`,
`app/api/accounts/wallet/route.ts`, `lib/accounts/reconcile.ts`,
`lib/transactions/fingerprint.ts`, `lib/imports/pipeline.ts`,
`lib/imports/authorize.ts`, `lib/imports/csv.ts`,
`app/api/accounts/[id]/import/route.ts`, plus headers/excerpts of
`lib/imports/excel.ts`, `app/api/accounts/[id]/import/preview/route.ts`,
`app/api/imports/[id]/rollback/route.ts`, and the governing docs
(`PHASE_2_ARCHITECTURE_FREEZE.md` §13/§16/§19, `PHASE_2_DECISION_MATRIX.md`,
`D2_ROADMAP.md`, `D2_STEP4_CLOSURE_REVIEW.md`,
`D2_PROVIDER_CONNECTION_ARCHITECTURE.md`,
`D2_CONNECTION_ARCHITECTURE_REVIEW.md`, plus the relevant
`docs/initiatives/d2/*` step reports cited inline below).

---

## 1. Existing provider-specific sync flows

Only one provider has a real sync flow today: **PLAID**. There is no
scheduled or on-demand sync flow for WALLET — only account *creation* (see
§5). "Sync" for WALLET is aspirational comment text, not implemented code.

### 1A. PLAID

Three call sites, one shared engine:

| Caller | File | Triggers |
|---|---|---|
| Initial import | `app/api/plaid/exchange-token/route.ts` | Once, right after Link |
| Manual "Sync Now" | `app/api/plaid/sync/route.ts` | User-initiated, transactions only |
| Manual "Refresh" / future cron / future webhook | `lib/plaid/refresh.ts`'s `refreshPlaidItem()` | Balances + holdings + transactions + snapshots |

`refreshPlaidItem()` (`lib/plaid/refresh.ts` L85-258) runs, in order: (1)
`accountsGet` balance/metadata update, exact-match only, never
creates/restores an account; (2) `investmentsHoldingsGet` holdings
delete-then-recreate, best-effort/non-fatal; (3) `syncTransactionsForItem()`
(below), reused as-is; (4) `regenerateSnapshotsForAccounts()`. It also owns
lifecycle self-healing (`hasActiveLinkedAccount`/`selfHealOrphanedPlaidItem`,
L285-313) that skips/disconnects a `PlaidItem` with zero active linked
accounts before ever calling Plaid.

`syncTransactionsForItem()` (`lib/plaid/syncTransactions.ts`, 293 lines) is
the cursor-based incremental transaction sync, called by all three sites
above plus a dormant `jobs/sync-banks.ts` stub wired to call it
(`jobs/scheduler.ts` registers an interval, but nothing invokes
`startScheduler()` — no `instrumentation.ts` hook exists; this is a
pre-existing gap, not something Step 5 needs to fix). It loops Plaid's
`has_more` pages, flips Plaid's debit-positive sign convention to this app's
credit-positive convention, classifies each transaction
plaidTransactionId-exact → fingerprint-fallback → create (via
`lib/transactions/fingerprint.ts`, see §3/§4), and persists `next_cursor`
only after the full loop succeeds.

Three places independently resolve a Plaid `account_id` to a
`FinancialAccount.id` via the same pattern — `ProviderAccountIdentity`
lookup first, fallback to the legacy `FinancialAccount.plaidAccountId`
unique lookup with a `console.warn` on fallback-hit
(`refresh.ts` L108-125 and L175-198, `syncTransactions.ts` L163-195,
`exchange-token/route.ts` L145-163 and L362-378). `mapAccountType()` is
independently duplicated in `refresh.ts` (L45-61) and
`exchange-token/route.ts` (L46-62) — same logic, two private copies, by
design (each file's comment says so).

### 1B. WALLET

No sync flow exists. `app/api/accounts/wallet/route.ts`'s module header says
"Balance starts at 0 — the sync job will populate it on next run," and a
newly-created wallet is given `syncStatus: "pending"` — but no job, cron, or
endpoint anywhere in the repo ever flips a WALLET account to `"synced"` or
updates its balance. This is a real, named gap, not an oversight to silently
paper over: any adapter contract Step 5 defines that implies "every provider
has a sync implementation" will be wrong for WALLET on day one.

---

## 2. Existing provider-specific import flows

Three "providers" — CSV, Excel, QuickBooks — converge on one pipeline. None
of them have any notion of a `Connection` or polled credential; an import is
a single synchronous request against an uploaded file.

| Stage | File | Notes |
|---|---|---|
| Format sniff + parse + resolve + normalize | `lib/imports/pipeline.ts` (`runImportPipeline()`) | Extension/MIME sniff → CSV or Excel branch → shared `NormalizedTransaction[]` output (§3) |
| CSV-specific parse/resolve/normalize/classify | `lib/imports/csv.ts` | `parseCsvText`, `detectColumns`/`applyExplicitMapping`/`resolveColumns`, `normalizeRow`, `resolveFingerprintOutcome`, `computeQuickBooksUpdateDiff` |
| Excel-specific parse | `lib/imports/excel.ts` | Reuses `csv.ts`'s `resolveColumns`/`mapCategory`/`parseDate`/`parseAmount` unmodified; only adds typed-cell coercion; produces the identical `NormalizedTransaction` shape |
| Shared account-resolution/authorization | `lib/imports/authorize.ts` | One function, used identically by confirm and preview routes |
| Confirm (writes) | `app/api/accounts/[id]/import/route.ts` | Creates `ImportBatch`, sequentially classifies+writes each row, update-on-match for QuickBooks |
| Preview (read-only, dry-run) | `app/api/accounts/[id]/import/preview/route.ts` | Identical pipeline + classification, never persists |
| Header-mapping suggestions | `lib/imports/suggest.ts` | Deterministic similarity scoring against `csv.ts`'s `HEADER_ALIASES`, only invoked on resolution failure |
| Rollback | `app/api/imports/[id]/rollback/route.ts` | Soft-deletes only the rows a batch created (`importBatchId`-scoped); already fully source-agnostic |

**QuickBooks is not a separate parser.** It is a caller-asserted
`source=QUICKBOOKS` form field (`app/api/accounts/[id]/import/route.ts`
L178-180) threaded through `pipeline.ts`'s `sourceOverride` — the file
itself parses through the literal same CSV/Excel code path as any other
file of that shape. The *only* QuickBooks-specific behavior is the
update-on-match gate: a hardcoded
`source === ImportSource.QUICKBOOKS && result.matchedVia === "externalId"`
check (`app/api/accounts/[id]/import/route.ts` L344, mirrored read-only in
the preview route) that overwrites an existing `Transaction`'s allow-listed
fields via `computeQuickBooksUpdateDiff()`. Both call sites carry an
in-code comment stating this check is "intentionally temporary... expected
to migrate to an adapter-capability check during D2 Step 5." This is the
single most concrete, already-named seam Step 5 exists to fill — confirmed
directly in code, not just in roadmap text.

Rows are processed **sequentially, not via `Promise.all`**
(`import/route.ts` L304, comment at L110-115) so a duplicate row later in
the same file sees the just-committed Transaction an earlier row in the
same file created, rather than racing past it into a double-create. Any
future adapter abstraction over import sources must preserve this
sequential-write invariant — `lib/imports/pipeline.ts`'s own header
(L21-29) explicitly called this out as the reason classification was *not*
hoisted into the shared pipeline extraction.

---

## 3. Existing normalized transaction/import shapes

Two normalized shapes exist, and they were never unified — by design, not
oversight:

**`NormalizedTransaction`** (`lib/imports/csv.ts` L444-453) — the
import-side shape every source (CSV, Excel, QuickBooks) converges on:
`lineNumber`, `date`, `merchant`, `description`, `category`, `amount`,
`externalTransactionId`, `error`. Produced by `csv.ts`'s `normalizeRow()`
and `excel.ts`'s row normalizer from a common `CsvColumnMap` (`date`,
`merchant`, `description`, `amount`, `debit`, `credit`, `category`,
`reference`), itself resolved by a three-tier `resolveColumns()`
(`csv.ts` L295-320): explicit caller mapping → fixed alias table
(`detectColumns`) → saved `ImportMappingProfile` trial-apply, in that
priority order.

**`FingerprintOutcome`** (`csv.ts` L505-508) — `CREATE` |
`MATCH{transactionId, matchedVia: "externalId"|"fingerprint"}` |
`SKIP{reason}` — the classification result `resolveFingerprintOutcome()`
produces against existing `Transaction` history, shared verbatim by the
confirm and preview routes.

**`SyncTransactionsResult`** (`lib/plaid/syncTransactions.ts` L71-88) — the
PLAID-only equivalent: `added`/`modified`/`removed`/`cursor` (Plaid's own
counts) plus `created`/`updatedByPlaidId`/`updatedByFingerprint`/
`skippedMissingAccount` (this app's outcome counts). Structurally
parallel to the import side's create/match/skip breakdown, but never
code-shared with `NormalizedTransaction` — Plaid's SDK already hands over
typed, already-posted transaction objects; there is no parse/column-mapping
stage for it to converge through.

The one piece of normalization logic that **is** already shared
cross-provider: `lib/transactions/fingerprint.ts`'s `findByFingerprint()`/
`normalizeMerchantKey()`, extracted in D2 Step 4C from
`syncTransactions.ts` and reused unmodified by `csv.ts`'s
`resolveFingerprintOutcome()` (see §4). This is the real convergence point
today — not the row shape, but the matching logic each row shape ultimately
feeds into.

**Implication for Step 5:** the roadmap's promise of "a shared normalized
transaction format that every adapter maps into" (`D2_ROADMAP.md` L81)
should not be read as "one DTO for both sync and import." The smallest
correct interpretation, given what already exists, is two source-shaped
normalized forms (a sync-style form for polled/credentialed providers, the
existing `NormalizedTransaction` for file-based providers) that both funnel
into the existing shared classification primitives
(`findByFingerprint`/`resolveFingerprintOutcome`). Forcing PLAID's
already-posted, already-typed transactions through a `CsvColumnMap`-shaped
parse step to manufacture single-DTO uniformity would be pure overbuilding
with no caller that needs it.

---

## 4. Existing account matching/reconcile seams

`lib/accounts/reconcile.ts` (501 lines) is already provider-conditional in
exactly the place an adapter's "resolve existing account" capability would
live:

- `providerIdentityOf()` (L111-121) and `findActiveAccountByIdentity()`
  (L139-182) already branch on `identity.kind === "plaid"` vs the WALLET
  case inline — PLAID resolves via `ProviderAccountIdentity` first,
  falling back to the legacy `plaidAccountId` unique lookup with a
  fallback-hit warning (mirrors the same pattern in §1A); WALLET resolves
  via a direct `(ownerUserId, walletAddress)` query, no identity-table
  read at all. This single exported function is the closest thing the repo
  has today to a per-provider "find my existing account" seam.
- `resolveAccountByFingerprint()` / `findCandidatesByFingerprint()` /
  `pickCanonicalAndMerge()` (L218-373) — account-level fingerprint dedup,
  used by PLAID's exchange-token relink path only today (matches on
  institutionId/mask/type/name fields that don't apply to WALLET or
  file-based imports).
- `mergeArchivedDuplicateIntoCanonical()` (L403-500) — provider-agnostic
  data migration (transactions, goal contributions, debt profile, space
  shares, `DuplicateAccountCandidate` audit row) run whenever two rows are
  collapsed to one canonical account. Called by both the PLAID fingerprint
  path and the WALLET archived-duplicate-merge path in
  `app/api/accounts/wallet/route.ts` (L116-122).
- `closeOutAccountConnections()` (L86-104) — PLAID-specific
  `AccountConnection`/`PlaidItem` lifecycle cleanup, invoked whenever a
  "loser" row is folded away.

Separately, `lib/transactions/fingerprint.ts`'s `findByFingerprint()` is the
**transaction-level** fingerprint matcher (date+amount+pending+normalized-merchant), already shared by PLAID sync and all three import
sources via `csv.ts`'s `resolveFingerprintOutcome()`. The account-level and
transaction-level fingerprint engines are deliberately *not* unified — they
key on disjoint field sets, and every D2 doc that has touched this
(`D2_STEP4C_TRANSACTION_FINGERPRINTING_INVESTIGATION.md`,
`D2_STEP4_CLOSURE_REVIEW.md` §2) treats that as accepted duplication, not a
defect for Step 5 to fix.

**Implication for Step 5:** account-resolution-by-identity
(`findActiveAccountByIdentity`) is already shaped like a per-provider
adapter method (it takes a tagged-union `ProviderIdentity` and branches
internally) — Step 5 could formalize this into an explicit adapter capability
with very little code movement, since the branching already exists; it
would mostly be a renaming/typing exercise, not new logic.

---

## 5. Existing wallet account creation seams

`app/api/accounts/wallet/route.ts` (POST `/api/accounts/wallet`, 297 lines)
has three branches, each ending in the same three writes:

1. **Active match found** (L58-132) — reshare into the current space,
   mirror onto `SpaceAccountLink`, dual-write `ProviderAccountIdentity`
   (provider=WALLET), then opportunistically merge any stray archived
   duplicate for the same address into the active row.
2. **Archived match found, no active match** (L139-205) — reactivate
   (`deletedAt: null`), restore connections, reshare, mirror, dual-write.
3. **No match — fresh create** (L208-296) — create `FinancialAccount`
   (`ownerType: USER`, `walletAddress`, `walletChain`, `nativeBalance: 0`,
   `syncStatus: "pending"`), create `AccountConnection` (no `PlaidItem`),
   create `WorkspaceAccountShare`, mirror onto `SpaceAccountLink`,
   dual-write `ProviderAccountIdentity`.

All three branches call `dualWriteProviderAccountIdentity(id,
ProviderType.WALLET, walletAddress)` (L103, L186, L269).

**Roadmap-vs-code discrepancy found and worth flagging plainly (not fixed
here — doc edits beyond this report are out of scope):**
`D2_ROADMAP.md`'s Step 2 table (L38) still reads "WALLET dual-write — Not
started — blocked on the same WALLET identity semantics question as 1C-C"
(⛔), and `lib/accounts/provider-identity.ts`'s own module header (L14-19)
still says "nothing calls it with provider=WALLET today." Both are stale.
WALLET dual-write was implemented and validated as its own approved
sub-step — see `docs/initiatives/d2/D2_STEP2_WALLET_DUAL_WRITE_INVESTIGATION.md`,
`..._IMPLEMENTATION_CHECKLIST.md`, and `..._IMPLEMENTATION_VALIDATION.md`,
the last of which lists `app/api/accounts/wallet/route.ts` and the two
backfill/verify scripts as changed files, confirmed independently by
reading `wallet/route.ts` directly. This is the same flavor of staleness
the Step 4 Closure Review already found and corrected for Step 4's status
line — a documentation gap, not a code gap. Worth a one-line fix the next
time `D2_ROADMAP.md` is edited; not actioned in this report per the
investigation-only / no-doc-edits-except-this-one constraint.

What is still genuinely true and unresolved: WALLET's **read cutover**
(Step 3) has not happened (`findActiveAccountByIdentity`'s WALLET branch
still queries `FinancialAccount` directly, never
`ProviderAccountIdentity`), and the original 1C-C identity-semantics
question (who "owns" a watched address that isn't the connecting user's
own wallet) is still open. Dual-write existing does not imply the wallet
identity model is fully settled — only that the mirror-write half of it
shipped.

---

## 6. What adapter interface can be introduced with the least disruption

The Architecture Freeze doc's §13 contract —

```ts
interface ProviderAdapter {
  discoverAccounts(connection: Connection): Promise<DiscoveredAccountDTO[]>;
  syncActivity(connection: Connection): Promise<SyncResultDTO>;
  normalizeProviderData(raw: unknown): NormalizedAccountDTO;
}
```

— does not fit today's reality cleanly enough to implement as-is without
overbuilding:

- PLAID does not use `Connection` at all today. Its credential lives on
  `PlaidItem`; `Connection` rows are not written or read by any application
  code for PLAID (confirmed: `lib/accounts/provider-identity.ts` L20-22,
  unchanged since Step 1A). Wiring `PlaidItem → Connection` is an explicit,
  separately-tracked Open Decision (Decision Matrix), not something Step 5
  should silently force through by requiring every adapter to take a
  `Connection`.
- Imports have **no credential and no `Connection` concept whatsoever** —
  an import is a synchronous file upload, not a polled or
  webhook-driven external account. `discoverAccounts`/`syncActivity` have
  no meaningful implementation for CSV/Excel/QuickBooks; the only thing
  Step 4 actually needs formalized is the update-on-match capability check.
- WALLET has no `syncActivity` to generalize yet (§1B) — there is nothing
  running today that this interface would wrap.

Forcing all three onto one `Connection`-keyed `ProviderAdapter` interface
right now would require either standing up `Connection` wiring for PLAID
(out of scope — a separate, unapproved decision) or inventing a synthetic
`Connection` per import (overbuilding — exactly what the stated goal asks
to avoid).

**Recommendation: two narrow, independent interfaces, not one unified
one**, each scoped to the providers that actually need it today:

1. A **sync capability** for credentialed/polled providers (PLAID only,
   initially) — a thin named wrapper around what `refresh.ts`/
   `syncTransactions.ts` already do, keyed on the credential id they
   already use (`PlaidItem.id`) rather than requiring `Connection` wiring
   as a prerequisite.
2. An **import capability** for file-based providers (CSV/Excel/QuickBooks)
   — not a parsing abstraction (csv.ts/excel.ts already converge on
   `NormalizedTransaction`; re-abstracting the parse stage has no caller
   that needs it) but a small **capability lookup keyed by `ImportSource`**
   that replaces the one concrete placeholder named in §2 and in the Step 4
   Closure Review: `supportsUpdateOnMatch`.

WALLET should not be force-fit into either interface yet. It has no sync
implementation to wrap (§1B) and its identity model is still openly
unresolved (§5). The least-disruptive move is to leave it unmodeled in this
slice rather than design speculative shape for a sync mechanism that
doesn't exist.

---

## 7. Minimal interface shape

Smallest shape that actually replaces the one named placeholder, without
inventing machinery nothing calls yet:

```ts
// lib/imports/provider-capabilities.ts (new, ~20 lines)

import { ImportSource } from "@prisma/client";

export interface ImportProviderCapabilities {
  /**
   * True if an exact externalTransactionId match for this source should
   * overwrite the existing Transaction's allow-listed fields
   * (computeQuickBooksUpdateDiff's field set) instead of leaving it
   * untouched. Replaces the hardcoded
   * `source === ImportSource.QUICKBOOKS` check in
   * app/api/accounts/[id]/import/route.ts and the read-only parity check
   * in the preview route.
   */
  supportsUpdateOnMatch: boolean;
}

const REGISTRY: Record<ImportSource, ImportProviderCapabilities> = {
  [ImportSource.CSV]:        { supportsUpdateOnMatch: false },
  [ImportSource.EXCEL]:      { supportsUpdateOnMatch: false },
  [ImportSource.QUICKBOOKS]: { supportsUpdateOnMatch: true  },
};

export function getImportProviderCapabilities(
  source: ImportSource
): ImportProviderCapabilities {
  return REGISTRY[source];
}
```

Call-site change, confirm route (`app/api/accounts/[id]/import/route.ts`
L344):

```diff
- if (source === ImportSource.QUICKBOOKS && result.matchedVia === "externalId") {
+ if (getImportProviderCapabilities(source).supportsUpdateOnMatch && result.matchedVia === "externalId") {
```

Same one-line change, mirrored in the preview route's read-only parity
check.

This is deliberately *not* a `ProviderAdapter` class/object with
`discoverAccounts`/`syncActivity`/`normalizeProviderData` methods — none of
those have a second real implementation to justify the abstraction yet
(only PLAID syncs; only import sources matter for update-on-match). It is a
named seam at exactly the place code comments already say Step 5 should
fill it, sized to today's two QuickBooks-only/CSV-Excel-only cases, and
extensible by adding a field to the interface and a row to the registry —
no caller signature changes required — if Step 6 picks a provider that
needs a second capability flag.

If Step 6 instead validates the **sync** side (Coinbase/Schwab/Wallet-xpub),
a second, separate, equally small interface would be the next slice — not
designed here in detail, since inventing its shape now (before a second
sync provider exists to validate it against) is exactly the overbuilding
the stated goal warns against. The one signal already available from
`refreshPlaidItem()`'s shape (`RefreshItemResult`, balances → holdings →
transactions → snapshots as four independently-optional steps) is the
strongest hint for that future interface's shape, but committing to it now,
with only one implementation to generalize from, is premature.

---

## 8. Recommended D2-5 implementation slices

In dependency order, each independently approvable per the project's
standing "checklist → approval → implement only that decision" rule:

1. **Import capability lookup** (§7) — `lib/imports/provider-capabilities.ts`
   + the two one-line call-site swaps. Smallest possible Step 5 slice;
   removes the one placeholder every prior Step 4 doc already flagged as
   Step 5's job. No schema change (`ImportSource` already has all three
   values it needs). No behavior change for existing data — `CSV`/`EXCEL`
   keep `supportsUpdateOnMatch: false`, `QUICKBOOKS` keeps `true`.
2. *(Separately approved, not bundled with #1)* — a documentation-only fix
   to `D2_ROADMAP.md`'s Step 2 table and
   `lib/accounts/provider-identity.ts`'s stale header comment (§5). Not a
   Step 5 code change; flagged here so it isn't lost, consistent with how
   the Step 4 Closure Review handled its own roadmap-staleness finding
   (documented, not silently fixed in the same pass).
3. *(Not recommended yet)* — a sync-side adapter interface generalizing
   `refreshPlaidItem()`. Deferred until Step 6 selects a second sync
   provider to validate against (§7's closing note) — designing it now
   would be speculative.
4. *(Explicitly not in scope for D2-5 at all)* — any WALLET sync
   implementation, any `Connection` wiring for PLAID, any
   `ProviderType`/`ImportSource` enum additions beyond what already exists.

---

## 9. Files likely to change (slice #1 only)

| File | Change |
|---|---|
| `lib/imports/provider-capabilities.ts` (new) | `ImportProviderCapabilities` interface + `getImportProviderCapabilities()` |
| `app/api/accounts/[id]/import/route.ts` | Swap hardcoded `source === ImportSource.QUICKBOOKS` for the capability lookup (one line, L344) |
| `app/api/accounts/[id]/import/preview/route.ts` | Same swap, read-only parity check |

Not expected to change for slice #1: `prisma/schema.prisma`,
`lib/imports/csv.ts`, `lib/imports/excel.ts`, `lib/imports/pipeline.ts`,
`lib/transactions/fingerprint.ts`, `lib/accounts/reconcile.ts`,
`lib/plaid/*`, `app/api/accounts/wallet/route.ts`.

---

## 10. What should stay out of scope

- No schema or migration changes — `ProviderType` still lacks
  `QUICKBOOKS`/`EXCEL` entries; that gap belongs to Provider Catalog
  (D6/D7), not Step 5's adapter-shape work, and is independent of the
  capability lookup proposed above (which keys on the existing
  `ImportSource` enum, not `ProviderType`).
- No `Connection` wiring for PLAID — separate, not-yet-made Open Decision.
- No WALLET sync implementation — doesn't exist yet; building one is Step
  6 territory if Wallet is selected as the proof provider, not Step 5.
- No unification of the account-level (`reconcile.ts`) and
  transaction-level (`fingerprint.ts`) fingerprint engines — already an
  accepted, named duplication (§4).
- No fix for the cross-request fingerprint-matching race condition flagged
  by the Step 4 Closure Review §2 — an internal correctness property of the
  matching mechanism, not part of the adapter contract surface.
- No new file formats (no IIF, no OFX/QFX).
- No UI changes.
- No rollback-of-update-on-match capability — already an accepted
  limitation (`D2_STEP4D4_QUICKBOOKS_IMPLEMENTATION_CHECKLIST.md` §7).
- No `WorkspaceAccountShare` rename, no billing/payout/messaging tables —
  standing project rules, unaffected by and unrelated to this work either
  way.

---

## 11. Risks

- **Capability-lookup drift from reality.** If a future import source needs
  a capability this registry doesn't yet model (e.g. a source that should
  update on a *fingerprint* match, not just an exact id match),
  `supportsUpdateOnMatch: boolean` is too coarse and would need a richer
  shape. Low risk for this slice specifically — no such source exists today
  — but worth naming so a future slice doesn't have to rediscover it.
- **Two readers of the same flag drifting.** The confirm route and preview
  route currently re-implement the identical gate check independently. The
  capability lookup fixes the *logic* duplication but both call sites still
  need to be updated together; missing one would silently break the
  preview/confirm parity the original 4D-5c-2 investigation called out as
  an authorization-equivalence requirement (not just a display nicety).
- **Roadmap staleness compounding.** §5's flagged discrepancy
  (`D2_ROADMAP.md` Step 2 / `provider-identity.ts` header) is the second
  instance of this pattern after Step 4's. If left uncorrected, a future
  step's investigation may again waste effort re-discovering that WALLET
  dual-write already shipped.
- **Scope creep toward the sync-side interface.** §7's closing note
  deliberately stops short of designing the sync adapter. The risk is
  schedule pressure to "just do both halves of Step 5 at once" — directly
  against the standing "do not implement all decisions in one branch or one
  commit" rule and against this investigation's own goal (smallest
  interface, no overbuilding).

---

## 12. Validation plan (for slice #1, once approved)

- `npx prisma generate` — no schema change expected; should be a no-op.
- `npx prisma migrate dev` — not expected to run (no schema change).
- `npx tsc --noEmit` — confirms the new module's types and the two
  call-site swaps compile cleanly.
- `npm run lint` — confirms no new lint errors.
- Targeted route testing: a QuickBooks-sourced file with an
  externalTransactionId-exact match still triggers update-on-match
  (unchanged behavior); a CSV/Excel file with the same kind of match still
  does not (unchanged behavior). This is a refactor of *how* the gate is
  computed, not a behavior change — the validation pass should confirm
  exactly zero observable difference in either route's response for every
  existing test file/fixture already used in the 4D-1/4D-2/4D-4 validation
  reports.

---

## 13. Stop point

This report stops here. No implementation checklist in §8 is approved by
virtue of appearing in this document — each slice still needs its own short
implementation checklist submitted separately, per the project's standing
working style. Recommended next step: review §6-§9, decide whether slice #1
(the import capability lookup) is the right starting point for D2 Step 5,
and explicitly approve it before any file in §9 is touched.
