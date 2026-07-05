# Subscriptions Reclassification Backfill — Design Checklist

**Status:** Checklist / design only. No implementation. Awaiting approval.
**Goal:** One-time, reversible reclassification of already-persisted `Transaction` rows from `Other`/`Shopping` → `Subscriptions` for known subscription merchants. The forward mapper (`lib/transactions/plaid-category.ts`) is already fixed; incremental Plaid sync will not revisit stable historical rows, so a targeted backfill is required.

**Scope guardrails:** existing `Transaction` rows only · no schema changes · no Plaid re-fetch · no cursor reset · no full resync · no FlowType changes · no UI changes.

---

## 1. Convention baseline (from `scripts/backfill-flowtype.ts`)

Mirror it exactly:
- Runner: `npx tsx scripts/<name>.ts`, argv flags parsed inline; **dry-run is the default, `--apply` required to write**.
- Flags: `--apply`, `--verbose`, `--batch=N` (default 500), `--limit=N`.
- **Keyset pagination by `id`** (`id > lastId`, `orderBy id asc`) — resume-safe, drift-free.
- Writes via a **parameterized raw `UPDATE`** that touches only the intended column(s) and deliberately does **not** bump `updatedAt` (enum cast from a bound text param).
- `main().catch(...).finally(() => db.$disconnect())`.
- Idempotent by construction: a second `--apply` finds 0 candidates.

Intentional divergence: the flowtype backfill prints non-PII only. This report **does** show merchant names, because the operator must eyeball allowlist matches (§4). This is a local operator script, so that is acceptable.

---

## 2. Exact files affected

**New:**
1. `scripts/reclassify-subscriptions.ts` — the backfill (dry-run default, `--apply`, `--rollback`).
2. Runtime output (not source): a rollback log JSON, default `scripts/.backfill-logs/reclassify-subscriptions-<ISO>.json`, written only on `--apply`.

**Modified (recommended, additive-only):**
3. `lib/transactions/plaid-category.ts` — export a narrow `isKnownSubscriptionMerchant(merchantName, name?)` that wraps the existing private `isSubscriptionMerchant`. One line, zero behavior change to `mapPlaidCategory`. This keeps the merchant allowlist **single-sourced** so the backfill and the live mapper can never drift.

**Gitignore:**
4. Add `scripts/.backfill-logs/` to `.gitignore` (no such rule exists today) so rollback logs are never committed.

**Zero-touch alternative to (3):** instead of exporting a helper, the backfill can `import { mapPlaidCategory }` and reconstruct a synthetic input from the row (`merchant_name: row.merchant`, `name: row.description`, `personal_finance_category: { primary: row.pfcPrimary, detailed: row.pfcDetailed }`), then treat a row as a candidate iff `mapPlaidCategory(synthetic) === "Subscriptions"`. Faithful to the full forward contract, but heavier and reconstructs an input the mapper's other branches also read. **Recommendation: the narrow helper (3)** — precise to the goal and provably one allowlist.

---

## 3. Helper decision (investigation item 3)

Use `isKnownSubscriptionMerchant` (recommended). Detection is **merchant-allowlist-driven only** — matching the approved correction. Therefore:
- The backfill matches candidates on the **merchant allowlist** applied to `merchant` + `description`.
- **Do NOT use `pfcPrimary`/`pfcDetailed` as a match signal** — that would reintroduce the exact ENTERTAINMENT_* bucket false positives (concerts, theaters, sporting events) the correction removed. `pfc*` may be *displayed* in verbose output for context, never used to select.

---

## 4. Candidate scan (investigation item 2)

Selection predicate (ANDed):
- `category IN ('Other','Shopping')` — the only categories eligible to flip. Enforced in SQL **and** re-checked at write time (§6).
- `deletedAt: null` by default (live rows only; `--include-deleted` to override) — soft-deleted/rolled-back rows don't affect the UI filter.
- Merchant match: `isKnownSubscriptionMerchant(row.merchant, row.description)` applied in JS after the SQL page fetch. The allowlist stays single-sourced in `plaid-category.ts` — **not** duplicated as SQL `ILIKE`s (drift risk).

Query shape per page (keyset):
```ts
const rows = await db.transaction.findMany({
  where: {
    category: { in: ["Other", "Shopping"] },
    ...(INCLUDE_DELETED ? {} : { deletedAt: null }),
    ...(SPACE_ID ? spaceScopeWhere(SPACE_ID) : {}),
    ...(lastId ? { id: { gt: lastId } } : {}),
  },
  orderBy: { id: "asc" },
  take,
  select: { id: true, category: true, merchant: true, description: true,
            pfcPrimary: true, pfcDetailed: true, flowType: true, flowDirection: true },
});
```
Then `const candidates = rows.filter(r => isKnownSubscriptionMerchant(r.merchant, r.description));`

Optional scoping (`--space=<id>`, item 6): reuse the read-layer join —
`{ OR: [ { account: { spaceId } }, { financialAccount: { spaceAccountLinks: { some: { spaceId, status: "ACTIVE" } } } } ] }`. Mark optional; unscoped = all rows.

---

## 5. Dry-run mode (default — investigation item 4)

Read-only. For each candidate collect `{ id, merchant, from: category }`; `to` is always `Subscriptions`. Then print:
- **Total candidate count.**
- **Group by merchant**, sorted desc: `merchant → count` (this is the operator's sanity check that only Netflix/Spotify/Adobe/… appear).
- **Before/after**: per-merchant `from` breakdown (how many Other vs Shopping) → `Subscriptions`.
- `--verbose`: per-row `id  merchant  from → Subscriptions` (and `pfcPrimary/pfcDetailed` for context).
- Footer: `Dry run only — no writes. Re-run with --apply to write.`

No writes, no log file in dry-run.

---

## 6. Apply mode (investigation item 5)

`--apply` (and not a rollback run). For each candidate, a **parameterized raw UPDATE of only `category`**, guarded so a concurrent edit can't cause an unintended flip:
```sql
UPDATE "Transaction"
SET "category" = ${'Subscriptions'}::"TransactionCategory"
WHERE "id" = ${r.id}
  AND "category" IN ('Other','Shopping')
```
- Touches **only `category`**. `amount`, `flowType`, `flowDirection`, `pfc*`, `merchant`, `date`, `pending`, FKs, `plaidTransactionId` are all left byte-identical.
- Follows the flowtype precedent: raw SQL so `@updatedAt` is **not** bumped. *(Decision point — see §9: if you prefer an audit trail, switch to `db.transaction.update` which bumps `updatedAt`. Default = no bump, minimal footprint.)*
- Batched atomically per page via `db.$transaction([...])` (keyset paginate, `--batch=N` rows per tx).
- Writes the rollback log (§8) as it goes.
- Idempotent: re-running `--apply` finds 0 candidates (they're now `Subscriptions`, excluded by the `category IN ('Other','Shopping')` predicate).

---

## 7. Safety (investigation item 6)

- **Dry-run default**, `--apply` required to write.
- **Category guard** in both the JS filter and the SQL `WHERE` — a row is never updated unless it is currently `Other` or `Shopping`.
- **`--limit=N`** to cap a first cautious run; **`--batch=N`** for tx size.
- **`--space=<id>`** optional user/space-scoped run for a controlled pilot.
- **Per-batch `db.$transaction`** — a mid-run failure leaves completed batches consistent and the keyset lets a re-run resume.
- Allowlist single-sourced (§3) — backfill can't diverge from the live mapper.

---

## 8. Rollback (investigation item 8)

- On `--apply`, append every change to a JSON log: `[{ id, from, to: "Subscriptions" }, …]` at `scripts/.backfill-logs/reclassify-subscriptions-<ISO>.json`. `from` records whether it was `Other` or `Shopping` — exact per-row prior state.
- **`--rollback=<file>` mode** in the same script: read the log and, for each entry, raw-UPDATE back guarded:
  ```sql
  UPDATE "Transaction" SET "category" = ${entry.from}::"TransactionCategory"
  WHERE "id" = ${entry.id} AND "category" = 'Subscriptions'
  ```
  The `AND "category" = 'Subscriptions'` guard means rows a user has since re-categorized are left alone.
- Because only `category` was ever touched, rollback is a pure, lossless restore — no `flowType`/`amount`/timestamp reconstruction needed.

---

## 9. Open decisions to confirm before build

1. **`updatedAt`**: leave unbumped (mirror flowtype precedent, default) or bump for an audit trail? Default: unbumped.
2. **Scope for first apply**: whole DB, or a `--space=<id>`/`--limit=N` pilot first? Recommended: pilot, then full.
3. **Soft-deleted rows**: excluded by default; include only if you want historical completeness.

---

## 10. Command examples

```bash
# Dry run — full DB, see candidate merchants + counts
npx tsx scripts/reclassify-subscriptions.ts

# Dry run — verbose, scoped pilot
npx tsx scripts/reclassify-subscriptions.ts --space=<spaceId> --limit=100 --verbose

# Apply — writes category, emits rollback log
npx tsx scripts/reclassify-subscriptions.ts --apply

# Apply — cautious first pass
npx tsx scripts/reclassify-subscriptions.ts --apply --batch=200 --limit=500

# Rollback a specific run
npx tsx scripts/reclassify-subscriptions.ts --rollback=scripts/.backfill-logs/reclassify-subscriptions-2026-07-04T18-00-00Z.json
```

---

## 11. Validation plan (investigation item 7)

1. **Dry run** → candidate list groups only to expected brands (Netflix, Spotify, Hulu, Disney+, Adobe, Microsoft 365, Google One/Workspace, Apple.com/Bill, YouTube Premium). No unexpected merchants.
2. **`tsc --noEmit`** + **eslint** on the new script and the one-line `plaid-category.ts` export — clean. (Run the new `plaid-category.test.ts` again — export is additive, suite stays 33/33.)
3. **Apply** → `updated` count equals the dry-run candidate count.
4. **Re-run dry run** → 0 candidates (idempotency proof).
5. **Transactions page** → the `Subscriptions` filter is now non-empty; those merchants show the `Subscriptions` chip.
6. **Spend/In totals unchanged** — they derive from `flowType` (untouched). Optionally assert programmatically that `flowType`/`flowDirection` are byte-identical for the affected ids before/after (they are never in the UPDATE).
7. **Rollback rehearsal** (in a pilot/scoped run): `--rollback=<file>` restores exactly the affected ids to their prior `Other`/`Shopping`, and a subsequent dry-run again lists them as candidates.

---

## 12. Stop

Design/checklist only. No files created or edited. Awaiting approval (recommend: build the script + additive `isKnownSubscriptionMerchant` export, run a scoped dry-run first).
