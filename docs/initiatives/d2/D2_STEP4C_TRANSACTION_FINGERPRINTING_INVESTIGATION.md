# D2 Step 4C — Transaction Fingerprinting Investigation

Status: **read-only investigation complete. No code, schema, migration, route, UI, or documentation changes.** This is a new, standalone file; no existing file was modified to produce it.

Context: D2 Step 4B is complete and migrated (`ImportBatch`, `ImportSource`, `ImportBatchStatus`, `Transaction.importBatchId`, `Transaction.externalTransactionId`, `Transaction.deletedAt` all exist in production). This report investigates the transaction identity and deduplication strategy that 4C (shared fingerprint helper) and 4D (import pipeline) will rely on.

## 1. Current transaction uniqueness assumptions

`Transaction` (`prisma/schema.prisma:1094`), current full field list: `id`, `accountId`/`account` (legacy, optional), `financialAccountId`/`financialAccount` (canonical, optional, named relation `"FinancialAccountTransactions"`), `date` (`@db.Date`), `merchant`, `description` (optional), `category`, `amount` (`Float`), `pending`, `plaidTransactionId` (`String? @unique`), `importBatchId`/`importBatch` (4B, nullable FK), `externalTransactionId` (4B, nullable, **no constraint**), `deletedAt` (4B, nullable), `createdAt`, `updatedAt`.

Indexes: `[accountId]`, `[accountId, date]`, `[financialAccountId]`, `[financialAccountId, date]`, `[date]`, `[importBatchId]`. **Exactly one is unique: `plaidTransactionId`.** Postgres unique indexes permit unlimited `NULL`s, so this constraint does nothing for any row without a Plaid id — every seed row and every future CSV/Excel row included.

There is no DB-level constraint of any kind on the combination of `financialAccountId` + `date` + `amount` + `merchant`. Nothing prevents two genuinely identical-looking rows from coexisting; the only thing standing between "duplicate" and "two legitimate same-day charges" is application code, and only in the one write path that bothers to check (§4).

The schema's own comment on `externalTransactionId` (lines 1111–1118) already flags this investigation's question 5 as open: *"Deliberately no unique constraint yet — a CSV export's own id is only guaranteed unique within that one file/institution, not globally; real uniqueness shape (e.g. scoped to `[financialAccountId, externalTransactionId]`) is decided at Step 4D implementation time, not assumed here."* This report's findings are consistent with, and expand on, that note.

## 2. Plaid transaction identifiers

`plaidTransactionId` is set once, at row creation, from Plaid's `transaction_id` (`syncTransactions.ts:295`). It is looked up by exact match via `findUnique` (`:266`) on every sync pass for every `added`/`modified` transaction Plaid reports. It is the first and preferred matching key — the fingerprint fallback (§4) is only consulted on a miss.

The module header (`syncTransactions.ts:40–53`) documents, as a load-bearing design fact, that `transaction_id` is **not stable across sync runs** for the same real-world posted transaction — "observed directly: two rows, same financialAccountId/date/amount/merchant, both pending:false, different plaidTransactionId, created on different sync runs." This is the entire justification for why a fingerprint fallback exists at all for Plaid.

**That justification cites a document that does not exist.** The comment (and a second citation at line 46) points to `docs/TRANSACTION_DUPLICATION_INVESTIGATION.md`. A repo-wide search found zero such file, in the working tree or git history — and this was already independently flagged as a pre-existing dangling reference in `docs/initiatives/d0/D0_DOCUMENTATION_IA_REVIEW.md` §C.3 ("This file does not exist anywhere in the working tree or git history. It's already broken today... Worth a separate ticket"). This investigation reconfirms that finding directly. The empirical basis for the fingerprint fallback's existence is currently a comment asserting a past observation, unverifiable from the repo alone. Not a 4C blocker — the fallback's behavior is real and tested by its own logic regardless of whether the doc exists — but worth flagging as a documentation debt, since "Plaid reissues transaction_id" is exactly the kind of claim a future engineer will want primary evidence for before trusting it further (e.g. before relaxing or tightening the fallback).

## 3. Manual transaction identification

There is no manual-transaction-creation path in the application today. `app/api/accounts/[id]/transactions/route.ts` is GET-only (confirmed in prior investigation). The only non-Plaid `Transaction`-creation code is `prisma/seed.ts`'s fixture loader, which is a categorically different case, not a preview of how manual/imported transactions will work:

- Seed transactions are built via local helpers `tx()`/`itx()` (`seed.ts:553–556`), which populate `{ accountId, date, merchant, category, amount, pending, description }` — **the legacy `accountId` field, not `financialAccountId`** — and set none of `plaidTransactionId`, `externalTransactionId`, `importBatchId`. They are inserted via `prisma.transaction.createMany()` with zero dedupe, zero fingerprint check, zero identity column populated.
- This is correct and fine for one-time fixture data, but it means **no code path in the repo today demonstrates what "manual transaction identity" should look like.** 4D is greenfield here, not extending an existing convention.

This matters for question 5/6 below: CSV/Excel imports will be the first time a `Transaction` row is created that is neither Plaid-sourced nor a seed fixture, and the schema currently has nothing purpose-built for that case beyond the unconstrained `externalTransactionId` column.

## 4. How duplicates are currently prevented

Exactly one real mechanism exists, and it is Plaid-specific (`syncTransactions.ts:264–299`), per transaction, per sync pass:

1. **Exact match** — `findUnique({ where: { plaidTransactionId: txn.transaction_id } })`. Hit → `update`, counted `updatedByPlaidId`.
2. **Fingerprint fallback** (`findByFingerprint`, `:107–130`) — only reached on a miss. Queries `db.transaction.findMany({ where: { financialAccountId, date, amount, pending } })` (an indexed scan via `[financialAccountId, date]`), then narrows in memory by `normalizeMerchantKey()` equality (trim, collapse whitespace, uppercase — deliberately *not* stripping reference/trace numbers, so distinct transactions that merely share date+amount but differ in merchant text are never merged). Hit → `update`, **overwriting that row's `plaidTransactionId` with the new one**, counted `updatedByFingerprint`, with a `console.warn` if more than one candidate matched (first one wins, no error).
3. **Miss on both** → `create`, counted `created`.
4. Plaid's `removed` array → `deleteMany({ where: { plaidTransactionId: { in: ids } } })` — a hard delete, not a `deletedAt` soft-delete (4B's `deletedAt` is not used here; nothing sets it anywhere yet).

A structurally parallel but independently-written matcher exists one layer up, at the account level, in `lib/accounts/reconcile.ts`: `findCandidatesByFingerprint()` matches on `mask` + (`institutionId` OR `institution`) + `type` + (`officialName` OR `plaidName` OR `name`), all case-insensitive/trimmed; `pickCanonicalAndMerge()` reduces multiple matches to one canonical row by most-linked-transaction-history; `mergeArchivedDuplicateIntoCanonical()` re-points that loser's `Transaction` rows (and other related rows) onto the winner via `updateMany` (`reconcile.ts:339`) — a re-pointing operation, not a creation/dedupe path, included here only because it is the other place `Transaction.financialAccountId` is bulk-written outside of sync. Every account-level merge writes an audit row to `DuplicateAccountCandidate` (`status: CONFIRMED_DUPLICATE`, `detectionSource`, `detectedAt`/`resolvedAt`, never `resolvedByUserId` since no human is in the loop for automatic merges) — **the transaction-level fingerprint match has no equivalent audit trail.** When `findByFingerprint` reuses a row, that fact is logged to console and nowhere else; there is no `Transaction`-level analog of `DuplicateAccountCandidate`. This is the same "duplicated, independently-implemented fingerprint logic" finding 4A originally surfaced and the literal reason 4C exists per the roadmap.

No other write site exists. Confirmed via repo-wide grep for `.transaction.(create|createMany|upsert|update|updateMany|delete|deleteMany)(` (both `db.` and `prisma.` prefixes) across `app/`, `lib/`, `scripts/`, and `prisma/`: five non-seed call sites, all five already accounted for above (four in `syncTransactions.ts`, one in `reconcile.ts`); nine `createMany` calls in `seed.ts`; zero matches under `scripts/`.

## 5. Is `externalTransactionId` alone sufficient?

No, for two independent reasons:

- **It has no uniqueness constraint today**, by design (4B deliberately deferred this — see §1's schema comment). Without a constraint, "sufficient" can't mean "DB-enforced unique identity" yet; today it would only ever function as an additional `findUnique`-style lookup field, no different in kind from `plaidTransactionId`, except unenforced.
- **Not every import source produces one.** QuickBooks exports typically carry a stable internal transaction/reference id (QBXML `TxnID`, QBO API `Id`) — a real candidate for `externalTransactionId`, structurally equivalent to `plaidTransactionId`. **CSV and Excel exports generally do not** — most bank/card CSV exports are just rows of `date, description, amount` with no per-row identifier at all. For those two sources, `externalTransactionId` will almost always be `null`, and **fingerprint matching is not a fallback — it is the only mechanism available.** Any design that treats fingerprinting as merely Plaid's fallback-of-last-resort undersells its role for CSV/Excel: there, it's primary.

## 6. Should a fingerprint column exist?

Distinguish two different things this question could mean, because they have different scope and different urgency:

**(a) A shared, reusable fingerprint *function*** — yes, and this is exactly what the roadmap already scopes 4C to be: extract `findByFingerprint`/`normalizeMerchantKey` into a shared module, re-point `syncTransactions.ts` onto it, behavior-preserving, no schema change. This is a refactor, not a migration.

**(b) A persisted fingerprint *column*** (e.g. a stored deterministic hash, queryable/indexable at the DB level) — this is a larger, separate decision, and this investigation recommends it be tracked as one, not folded into 4C:

- Today's matching is "query an indexed scan on existing columns, then filter in application memory." That's fine at Plaid's per-account, per-sync-pass volume (the module's own comment: "candidate sets here are always small — a handful of same-day transactions per account at most"). It does **not** scale to bulk CSV import, where a single file could be hundreds or thousands of rows each needing its own `findMany` + in-memory filter — O(n) round-trips instead of one set-based query.
- A persisted hash column queryable via a single `WHERE fingerprintHash IN (...)` (or joined against a temp table of incoming rows) turns that into one query for the whole batch.
- It also closes a real concurrency gap (§7) that the current find-then-write pattern has no defense against.

Recommendation: keep 4C scoped exactly as the roadmap already states (helper extraction, no schema change), and raise "should `Transaction` get a persisted `fingerprintHash` column" as its own, explicitly separate future decision — most naturally as part of 4D's design (since bulk-import performance is what actually motivates it) or a deliberately-named follow-up (4C-2 / 4E), not bundled into 4C. This keeps with the standing "smallest safe slice" / "do not implement multiple decisions at once" rules — 4C's value (one shared helper, zero duplicated logic for a third implementation) is fully realized without a schema change.

If/when that column is approved separately, the shape this investigation would propose: `fingerprintHash String?` (nullable — not retroactively backfilled unless separately decided), `@@index([financialAccountId, fingerprintHash])` (composite, **not** `@@unique` — mirrors the existing design's deliberate choice to allow genuine same-day/same-amount/same-merchant repeats as valid data, never blocked from creation).

## 7. Should fingerprints be deterministic hashes of account + date + amount + description + merchant?

Partially. Recommend account + date + amount + normalized merchant, **not** description, as the primary key fields — with an explicit precedence rule for sources that only have one text field:

- Today's fallback already excludes `description` from the match (`financialAccountId, date, amount, pending` at the DB level, normalized `merchant` in memory). Adding `description` into the hash would more often reduce match recall than improve precision: Plaid frequently sets `merchant` from `merchant_name ?? name`, so `description` (`txn.name`) is often the same or a near-duplicate of `merchant` already — hashing both adds redundancy, not discrimination, while making the hash more brittle to formatting noise between the two nearly-identical fields.
- **CSV/Excel rows usually have no separate merchant field** — just one description-like text column. The shared helper therefore needs an explicit precedence rule (`merchant` if present and non-empty, else `description`, normalized identically) rather than assuming both will always be populated. This is a real decision 4C's extraction needs to make explicit (today it's implicit/moot because Plaid always supplies both).
- `pending` is part of today's match scope and should stay — a pending and posted instance of the same real transaction can legitimately have different `pending` values across two sync passes for the *same* row being updated (which is fine, since that's an update-path concern), but treating `pending: true` and `pending: false` rows as fingerprint-equivalent for *new-row* matching would risk matching a posted transaction against an unrelated still-pending one.
- Normalization should stay conservative, matching `normalizeMerchantKey`'s existing philosophy (trim, collapse whitespace, uppercase; deliberately not stripping reference numbers) — over-aggressive normalization (e.g. stripping all digits) would increase false-positive merges, which is the worse failure mode for financial history (see §8).
- `amount` and `date` need an explicit equality rule in the shared helper's contract (today: exact `Float` equality and `@db.Date`-truncated equality respectively, inherited implicitly from Prisma's `where` semantics) — worth stating explicitly once extracted, since a hash-based version (§6b) would need to canonicalize amount formatting (e.g. fixed-point string, not float-to-string) to avoid floating-point hash instability that the current `where`-clause approach doesn't have to worry about.

## 8. Collision and edit scenarios

**Collision — two genuinely different transactions sharing account/date/amount/merchant** (e.g. two identical recurring charges posted the same day): the current fallback's behavior is to silently reuse the first match and overwrite its `plaidTransactionId`, logging a warning only. For Plaid's actual use case (the same real transaction reappearing under a new `transaction_id`) this is correct. But the heuristic cannot distinguish that case from a true second, distinct transaction that happens to match on all four fields — and if it picks wrong, the practical effect today is fairly benign (the row's other fields get overwritten with values that are, in the false-positive case, identical anyway, since both "transactions" look the same) but the **count** of rows could end up one short of reality. This is a low-probability/low-impact risk for Plaid given its narrow trigger (only fires on a `transaction_id` miss), but **CSV import changes the odds**: a user re-uploading the same statement file (a far more common real-world action than Plaid silently reissuing an id) would hit this exact collision path at much higher frequency. Recommendation: CSV/Excel/QuickBooks import's use of the shared fingerprint helper should not default to "silently reuse," it should default to "flag and skip, surfaced to the user" (e.g. an import summary: "12 rows matched existing transactions and were skipped") — closer to `DuplicateAccountCandidate`'s candidate-and-review philosophy than to the silent-overwrite behavior Plaid sync uses today. This is a 4D decision, not a 4C one, but 4C's extracted helper should be designed so its caller can choose "reuse silently" vs. "flag for review" rather than hard-coding Plaid's current behavior into the shared primitive.

**Edit scenarios — a transaction's amount/description changes after being matched once:** there is no edit UI/route today (the transactions endpoint is GET-only), so this is forward-looking. If a persisted fingerprint hash (§6b) is ever added, it should be computed once at creation/match time and frozen, not recomputed on every read or write — the same pattern `plaidTransactionId` already follows (immutable once set, except for the one explicit overwrite-on-fingerprint-match branch). A fingerprint that silently drifts to track a row's current values would make a previously-matched row invisible to future dedupe passes that already matched it once, which defeats the purpose.

## 9. Import rollback requirements

4B already added the two structural pieces rollback needs — `ImportBatch.status` (including `ROLLED_BACK`) and `Transaction.deletedAt` — but a gap remains that 4D will need to resolve, surfaced directly by this investigation: **`importBatchId` alone doesn't currently distinguish "this row was freshly created by this batch" from "this row already existed and the batch only matched/touched it."** A naive rollback ("soft-delete every `Transaction` with this `importBatchId`") would be wrong for the second case — a row that predates the batch (matched via fingerprint or `externalTransactionId`, not created) must not be deleted just because a later batch happened to touch it; other relationships (goal contributions, shares) may already depend on it, and it has its own independent history.

This mirrors a distinction `syncTransactions.ts` already tracks at the in-memory/counter level (`created` vs. `updatedByFingerprint` vs. `updatedByPlaidId`) but does not persist per-row. For import rollback to be safe, that distinction needs to become a durable, per-row fact. Two options, both deferred to 4D as an explicit open design question rather than decided here:

- **(a)** Add a discriminator (e.g. `importMatchType: CREATED | MATCHED_EXISTING` or similar) so rollback can filter precisely.
- **(b)** Simpler: only ever set `importBatchId` on rows the batch genuinely creates; never set/overwrite it on a row the batch merely matched against an existing one. Rollback then becomes the originally-intended simple filter, at the cost of losing an audit trail of "which batches touched this pre-existing row" for matched rows.

(b) is simpler and sufficient for the `ROLLED_BACK` use case as currently scoped; (a) is more auditable. Recommend 4D pick one explicitly rather than default into whichever the import-writer code happens to do first.

Separately, the roadmap's own Step 4D entry already names the hard prerequisite this investigation reaffirms: every existing `Transaction` read site needs an audit for `deletedAt: null` filtering *before* `deletedAt` is ever set to non-null anywhere in production — the same investigation-before-cutover sequencing Step 3A used for `ProviderAccountIdentity`. Today, zero read sites filter on `deletedAt` (confirmed implicitly: nothing sets it, so no site has needed to yet) — this audit has not started and is correctly out of scope for both 4C and this report.

## 10. Interaction with future CSV, Excel, and QuickBooks imports

- **CSV / Excel** — structurally identical for this purpose: no native per-row external id in the general case (format is arbitrary per bank/export). `externalTransactionId` will almost always be `null` for these sources. Fingerprint matching is the *primary*, not fallback, dedupe mechanism. Column-mapping/parsing is 4D's problem; the only 4C-relevant requirement is that the parsed output conform to whatever shape the shared helper expects (account + date + amount + merchant-or-description, per §7's precedence rule).
- **QuickBooks** — the one import source with a real native id (`TxnID` / API `Id`), structurally equivalent to `plaidTransactionId`. This is the source where `externalTransactionId`-exact-match-first genuinely parallels Plaid's existing two-tier pattern; CSV/Excel will rely on the fingerprint tier almost exclusively.
- This asymmetry — some sources have a stable external id, some never will — is the direct argument for why a *shared, parameterized* helper (4C's literal goal) is the right design rather than three adapter-specific implementations: every adapter gets the same externalTransactionId-first/fingerprint-second contract for free; sources without a real id simply never populate the first tier and always fall to the second.

## Duplicate-risk analysis (summary)

| Risk | Where | Severity today | Severity post-CSV import |
|---|---|---|---|
| Two independently-implemented fingerprint matchers (account-level, transaction-level) | `reconcile.ts` + `syncTransactions.ts` | Low — both work correctly in isolation | Would become **three** without 4C — the exact problem 4C exists to prevent |
| Fingerprint fallback's empirical justification cites a non-existent doc | `syncTransactions.ts:46` comment | Low — behavior is real regardless | Unchanged; documentation debt only |
| Silent reuse/overwrite on fingerprint match, no audit trail | `syncTransactions.ts` fingerprint branch | Low — narrow trigger (plaidTransactionId miss only) | **Higher** — re-uploading the same file is a common user action, not a rare id-reissuance quirk |
| No DB-level uniqueness beyond `plaidTransactionId` | `Transaction` schema | Low — app-code check is the only guard, but call volume is low/sequential | Higher at CSV bulk-import volume — N findMany-per-row doesn't scale, and the find-then-write pattern is racy under concurrent batches |
| No discriminator for "created by this batch" vs. "matched by this batch" | `ImportBatch`/`Transaction` (4B) | N/A — nothing populates `importBatchId` yet | **Blocks safe rollback** unless resolved in 4D |
| No manual/CSV transaction identity precedent in the codebase | n/a | N/A — no such path exists yet | 4D is greenfield, not extending a convention — already reflected in this report's recommendations |

## Schema impact assessment

**4C as scoped by the roadmap (helper extraction): zero schema impact.** Pure code refactor — new module under `lib/` (e.g. `lib/transactions/fingerprint.ts`), `syncTransactions.ts` re-pointed onto it, `reconcile.ts` optionally sharing only the string-normalization primitive (see Rollout, below) — no Prisma schema changes, no migration.

**A persisted `fingerprintHash` column is a separate, larger decision**, not part of 4C's scope, and not recommended for bundling into it. If and when separately approved: one additive nullable `String?` column + one composite (non-unique) index, following the exact additive pattern already used for `externalTransactionId` in 4B.

## Migration requirements

**None**, for 4C as literally scoped — this is a code-only step. If the `fingerprintHash` column is later approved as its own decision, its migration would be a single `ALTER TABLE "Transaction" ADD COLUMN "fingerprintHash" TEXT;` + `CREATE INDEX` — additive, no backfill, same shape as every other D2 schema step — but that migration is explicitly **not** part of this report's recommended scope.

## Rollout plan

1. **4C (as already scoped by the roadmap):** extract a shared, parameterized fingerprint module from `syncTransactions.ts`'s `findByFingerprint`/`normalizeMerchantKey`, generalized just enough to support the merchant-or-description precedence rule (§7) that Plaid's case never needed. Re-point `syncTransactions.ts` onto it. Behavior-preserving — verify via the existing `created`/`updatedByPlaidId`/`updatedByFingerprint`/`skippedMissingAccount` counters producing identical results on a re-run against the same fixture/test data.
2. Re-pointing `reconcile.ts`'s account-level matcher onto the same module is explicitly optional per the roadmap and, per this investigation, a smaller win than it sounds — the two matchers key on entirely disjoint field sets (mask/institution/name vs. date/amount/merchant); only a shared string-normalization primitive (`cleanStr`/`normalizeMerchantKey`'s shared spirit) is realistically reusable, not the matching logic itself.
3. 4D consumes 4C's helper for CSV/Excel/QuickBooks import, supplying each source's own externalTransactionId-or-null and merchant-or-description per §7/§10, and makes its own explicit choice on collision handling (§8: flag-and-review recommended over silent-reuse) and the create-vs-matched discriminator (§9).
4. The `fingerprintHash` column (if separately approved): add column → write forward only from new Plaid-sync and CSV-import rows → leave historical rows `null` indefinitely, or backfill only as its own explicitly-approved follow-up step → reconsider the `findMany`-based lookup only once column coverage is well understood.

## Rollback plan

**4C as scoped:** revert the commit. No schema, no migration, no data — the cleanest rollback profile of any D2 step so far, by virtue of being a pure refactor.

**The optional future `fingerprintHash` column**, if undertaken separately: identical additive-rollback shape as every prior D2 step — `DROP INDEX`, `DROP COLUMN`, no application code depends on it until a future step wires it up, so no code rollback needed either.

## Validation (this report)

| Check | Result |
|---|---|
| `git diff --stat` | Only this new file added; zero modifications to any existing file, including `D2_ROADMAP.md` |
| Code changes | None |
| Schema changes | None |
| Migrations | None |
| Documentation changes to existing files | None — this task's constraint ("do not modify... documentation") was honored; `D2_ROADMAP.md`'s 4B status line, though now slightly stale relative to the confirmed-applied migration, was deliberately left untouched per that constraint |

---

**Stopping here per scope. No fingerprint helper extraction, no schema changes, no migrations. 4C implementation requires its own explicit approval before any code changes begin.**
