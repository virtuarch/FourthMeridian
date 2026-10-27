# P1 runbook: historical transfer repair in Production (2026-10-27)

**Status: READY, NOT AUTHORIZED.** This runbook describes a write to Production. Do not run any `--apply` step until the owner has given separate, written authorization for this specific run (see §1). Nothing in this document has been run against Production.

**Script:** `scripts/repair-transfer-debt-payment.ts`, which uses:
- `scripts/lib/repair-transfer-debt-payment.core.ts` (plan, strict apply, restore record);
- `scripts/lib/repair-transfer-debt-payment.rollback.ts` (rollback);
- `scripts/lib/repair-env-guard.ts` (environment gate).

**Rule:** `lib/transactions/transfer-debt-payment-correction.ts`. The Plaid sync runs the same rule after every completed sync.

**Background:**
- `docs/plans/P1-AMEX-TRANSFER-CLASSIFICATION-AUDIT-2026-10-27.md` (root cause and scope)
- `docs/plans/P1-PRODUCTION-REPAIR-CANDIDATES-2026-10-27.md` (read-only reconstruction of the current Production candidate set)

## 0. What the repair does

**Rows it targets:** Chase-checking legs of Amex-initiated ACH pulls. Plaid tagged them `LOAN_PAYMENTS`, so the context-free classifier stored them as `DEBT_PAYMENT` / `Payment`. The transfer authority can see the other leg (the Amex HYSA or Amex checking account), so it rewrites them:

| Evidence | Written values |
|---|---|
| Destination is certain | `TRANSFER` · `Transfer` · `ACCOUNT_TYPE_CONTEXT` · 1.0 |
| Unpaired leg with no liability evidence | `TRANSFER` · `Transfer` · `AMBIGUOUS_UNKNOWN` · 0.2 |

The 0.2 signature is not a silent assertion. It derives `needsClassification = UNKNOWN_TRANSFER_DESTINATION` (`lib/transactions/needs-classification.ts`, arm C), so the row shows up for review.

**Columns written (six):**
- `flowType`
- `category`
- `classificationReason`
- `classificationConfidence`
- `flowAuthority`, set to `TRANSFER_AUTHORITY`
- `classifierVersion`, set to `NULL`

**Never written:**
- `amount`, `date`, `flowDirection`
- `counterpartyAccountId`
- `pending`, `deletedAt`
- `categorySource` (it is read only, so a human's category always wins)
- provider PFC columns
- any balance

**Rows it never touches:**
- rows with `USER_OVERRIDE` or `USER_RULE`;
- rows whose destination is a liability, or whose PFC detailed category names a liability;
- cross-owner boundaries;
- cash movements;
- pending rows whose posted twin is live. These are listed under `retiringPending` and left for `removed[]` to retire.

**Write semantics:**
- One interactive transaction.
- Each row's `updateMany` is guarded on its full BEFORE shape: the six columns, live, and not a human category.
- All-or-nothing: if any row changed since planning, the whole write rolls back (`ABORTED_CONFLICT`, 0 written).
- Idempotent: a second run proposes 0.

## 1. Prerequisites (every one of these is required)

1. **Owner authorization.** A written approval from the owner for *this* Production apply, with a ticket or issue id (for example `FM-OPS-142` or `virtuarch/FourthMeridian#NN`). That id becomes `--i-have-owner-approval=<ticket>` and is recorded in the report and the restore file. Approval to "fix the Amex rows" in general is not authorization for this run.
2. **Production runs v2.7 code containing PR #58 or later.** This is required, not optional.
   - On v2.6 (main `43768b5`), the sync's ownership gate preserves `flowType` but **not** the category. The next `modified[]` re-delivery would put `Payment` back next to `TRANSFER`.
   - v2.6 also has no sync-time pass to correct a pending row's posted successor.
   - Confirm the Production deployment SHA contains `4febb33` ("transfer authority writes its verdict…") and this PR before applying.
3. **Credentials and connection.**
   - `DATABASE_URL` is the Production database as a role that can read and write `Transaction` (the migration/owner role).
   - Prefer the direct host `db.<ref>.supabase.co:5432` or the session pooler. The interactive transaction is short (16 updates, 60 s timeout), but do not run through anything that can leak session state.
   - `DIRECT_URL`, if set, must be the same database. The gate refuses otherwise.
   - `FM_PRODUCTION_DB_REF=<prod project ref>` must be set. The gate requires the target ref to equal it for `--env=production`, and to differ from it for `--env=preview`.
   - Do **not** set `FM_DB_GUARD=clone-only` (it refuses Production by design) or `FM_RLS_STRICT`.
   - The URL is never printed. Errors are redacted before printing.
4. **Working copy.** A clean checkout of the exact SHA being deployed. Then `npm ci` with Node 24:
   ```
   PATH=/opt/homebrew/opt/node@24/bin:$PATH
   ```
5. **Backup of the affected rows** (§3.1), taken read-only before the apply. The script's restore file is the primary rollback source. The CSV is an independent copy.
6. **A fresh read-only dry run** (§3.2) immediately before the apply, in the same sitting. Its count is the `--expect` value.
   - The documented expectation is **16** (13 posted −22,000.00, 3 pending −2,372.67, total −24,372.67).
   - Syncs can change the set: a pending row that posts moves to `retiringPending`, and its posted twin becomes a candidate or is corrected by the v2.7 sync itself. If the fresh dry run is not 16, stop and reconcile before choosing `--expect`. Never copy 16 blindly.
7. **Where the output goes.** `--out` must be outside the repo or under the repo's git-ignored `tmp/`. The restore file holds raw row ids: never commit it, paste it into a ticket or share it.

## 2. Guard design (what refuses, and why)

| Situation | Result |
|---|---|
| No flags | Dry run, reads only |
| `--env=production` without `--apply` | Dry run, after proving the target **is** the Production ref. A dry run labelled production that reads Preview is refused |
| `--apply` without `--env` | Refused |
| `--apply --env=preview` against the Production ref | Refused |
| `--apply --env=production` without `--i-have-owner-approval=<ticket>` (3–80 chars `[A-Za-z0-9._:#/-]`, no URL) | Refused |
| `--apply --env=production` without `--expect=<n>` | Refused |
| `--apply --env=production` against a non-Production ref, or with `FM_PRODUCTION_DB_REF` unset | Refused |
| `--i-have-owner-approval` with any env other than production | Refused, so the env can never be ambiguous |
| `--apply` without `--out`, with `--out` inside the repo outside `tmp/`, or with an existing `<out>.restore.json` | Refused before any database contact |
| Unknown or mistyped flag (for example `--aply`) | Refused, never a silent dry run |
| Plan count ≠ `--expect` | `REFUSED_EXPECT_MISMATCH`, nothing written, exit 3 |
| A row changed between plan and write | `ABORTED_CONFLICT`, transaction rolled back, nothing written, exit 3 |
| The restore record cannot be written before the first write | Abort, nothing written |

Exit codes: 0 = ok, 2 = refused by the gate, 3 = expect mismatch or conflict, 1 = error (redacted).

## 3. Procedure

Every command below runs from the repo root. Assume these environment variables are set:
- `DATABASE_URL` (and optionally `DIRECT_URL`) = Production;
- `FM_PRODUCTION_DB_REF` = the Production ref.

```
TSX="npx tsx --require ./scripts/lib/server-only-preload.cjs scripts/repair-transfer-debt-payment.ts"
```

### 3.1 Backup snapshot (read-only)

Use a transaction-scoped read-only statement only. **Never** run a session-level `SET` (or `SET SESSION` / `ALTER ROLE … SET default_transaction_read_only`) through the Supavisor pooler. On 2026-10-25 that leaked to `fm_system` and broke Preview AI writes (`25006`).

```
psql "$DATABASE_URL" -X -1 --csv -o tmp/p1-repair-backup-$(date -u +%Y%m%dT%H%M%SZ).csv -c "SET TRANSACTION READ ONLY;
SELECT t.id, left(encode(sha256(convert_to(t.id,'UTF8')),'hex'),12) AS id_hash,
       t.\"financialAccountId\", a.type, t.date, t.amount, t.pending, t.\"deletedAt\",
       t.\"flowType\", t.category, t.\"flowAuthority\", t.\"classifierVersion\",
       t.\"classificationReason\", t.\"classificationConfidence\", t.\"categorySource\",
       t.\"counterpartyAccountId\", t.\"pfcPrimary\", t.\"pfcDetailed\", t.\"plaidTransactionId\", t.\"pendingTransactionRef\"
FROM \"Transaction\" t JOIN \"FinancialAccount\" a ON a.id = t.\"financialAccountId\"
WHERE a.type IN ('checking','savings') AND (
  (t.\"flowType\"='DEBT_PAYMENT' AND t.\"flowAuthority\"='CLASSIFIER' AND (t.\"pfcPrimary\"='LOAN_PAYMENTS' OR t.category='Payment'))
  OR (t.\"flowType\"='TRANSFER' AND t.\"flowAuthority\"='TRANSFER_AUTHORITY' AND t.\"classificationReason\"='AMBIGUOUS_UNKNOWN'
      AND t.\"classificationConfidence\"=0.2 AND t.category='Transfer' AND t.\"pfcPrimary\"='LOAN_PAYMENTS'))
ORDER BY t.date, t.id;"
chmod 600 tmp/p1-repair-backup-*.csv
```

This is a superset of the candidates: every row the rule can consider, including the genuine card payments it keeps. On 2026-10-27 that was about 153 depository `DEBT_PAYMENT` rows. Like the restore file, it contains raw ids.

### 3.2 Fresh read-only dry run (Production)

```
$TSX --env=production --expect=16 --out=tmp/p1-repair.production.dryrun.json
```

- It proves the target is the Production ref. It writes nothing and needs no ticket.
- It exits 3 if the plan does not have 16 rows. In that case stop and reconcile.

**Expected output shape:**

```
[DRY RUN] v2.7-P1 transfer-authority debt-payment correction · env=production
  target: <16-hex target hash>
  scope: all depository accounts
  scanned <N> candidate(s); proposed 16 (-24372.67)
    posted  13 (-22000.00)
    pending 3 (-2372.67)  — live pending rows with NO posted twin
    by kind TRANSFER_CERTAIN=15 TRANSFER_UNRESOLVED=1
  retiring pending (posted twin live; NOT rewritten): 0 (0.00)
  untouched: LIABILITY_COUNTERPARTY=… LIABILITY_EVIDENCE=… …
  expect 16: MATCHED

  id#          account           date           amount  lc      before → after                            evidence / maturity
  d988da3ad343 checking ••••NNNN 2025-09-11    -500.00  POSTED  DEBT_PAYMENT/Payment → TRANSFER/Transfer  ACCOUNT_CERTAIN / SAVINGS_TRANSFER [TRANSFER_CERTAIN]
  …
  Dry run — nothing written. …
```

**Check before going on:**
- (a) `proposed` = 16 and `expect … MATCHED`.
- (b) The 16 `id#` values equal the anonymized list in `P1-PRODUCTION-REPAIR-CANDIDATES-2026-10-27.md`. Both use the same `sha256(id)[:12]`.
- (c) `by kind` is 15 certain and 1 unresolved (the unpaired leg), unless the far leg has since arrived.
- (d) All 16 have `before` = `DEBT_PAYMENT/Payment`, `CLASSIFIER`, `PLAID_PFC_PRIMARY`, 0.8 (in the JSON).
- (e) `retiringPending` and `untouched` look plausible. The 137 genuine payments land in `LIABILITY_COUNTERPARTY` and `LIABILITY_EVIDENCE`.

A `scanned 0` means the role cannot see the rows (RLS). Stop.

### 3.3 Authorized apply (only with the owner's ticket)

```
$TSX --apply --env=production --i-have-owner-approval=<ticket> --expect=<n from 3.2> \
     --out=tmp/p1-repair.production.json
```

**Files written:**

| File | Contents |
|---|---|
| `tmp/p1-repair.production.restore.json` | Mode 0600. Created exclusively **before** the first write (state `PLANNED`), rewritten `APPLIED` after commit. Raw ids, with all six columns BEFORE and AFTER per row, env, target hash, ticket, and a checksum |
| `tmp/p1-repair.production.json` | Hashed report (shareable) |
| `tmp/p1-repair.production.summary.txt` | The printed summary |

**Expected result:** the summary ends `APPLIED — 16 row(s) written in one transaction.`, with exit 0.
- On `REFUSED_EXPECT_MISMATCH` or `ABORTED_CONFLICT` (exit 3), nothing was written. Re-run §3.2 and reconcile. Do not retry blindly.
- If the process dies after `PLANNED` was written, the restore file is still valid. Rollback reverts only rows that are actually in the repaired state.

**Why real ids live in a separate restricted file:**
- The report and summary get pasted into tickets and PRs, so they carry only `sha256(id)[:12]`.
- A restore needs the real primary keys. Putting them in the shareable report would leak them wherever the report goes.
- The restore file is 0600, git-ignored (under `tmp/`) or outside the repo, never overwritten, checksummed, and bound to the database by target hash.
- Rollback cross-checks every `id` against its `idHash`.

### 3.4 Post-apply verification (read-only)

1. **Idempotence.** The repair should now propose 0:
   ```
   $TSX --env=production --expect=0
   ```
2. **The rows** (replace the hash list with the 16 `id#` values):
   ```
   psql "$DATABASE_URL" -X -1 -c "SET TRANSACTION READ ONLY;
   SELECT left(encode(sha256(convert_to(t.id,'UTF8')),'hex'),12) h, t.pending, t.\"flowType\", t.category, t.\"flowAuthority\",
          t.\"classifierVersion\", t.\"classificationReason\", t.\"classificationConfidence\", t.\"categorySource\", t.amount
   FROM \"Transaction\" t
   WHERE left(encode(sha256(convert_to(t.id,'UTF8')),'hex'),12) IN ('d988da3ad343','e3734687cae2' /* …16 */)
   ORDER BY t.date;"
   ```
   **Expected:**
   - 15 rows `TRANSFER | Transfer | TRANSFER_AUTHORITY | NULL | ACCOUNT_TYPE_CONTEXT | 1`;
   - 1 row `… | AMBIGUOUS_UNKNOWN | 0.2`;
   - `amount` and `categorySource` the same as in the backup CSV.
3. **Nothing else moved.** Compare the backup CSV with a fresh export using the same query as §3.1:
   - the only differing rows are the 16;
   - the only differing columns are the six;
   - `counterpartyAccountId`, `amount`, `date`, `pending`, `deletedAt`, PFC and `categorySource` are identical.
4. **Ownership coupling holds.** This should return 0 rows:
   ```
   psql "$DATABASE_URL" -X -1 -c "SET TRANSACTION READ ONLY;
   SELECT count(*) FROM \"Transaction\" WHERE (\"flowType\" IS NULL) <> (\"flowAuthority\" IS NULL);"
   ```

### 3.5 Post-apply re-sync check

The re-sync safety is proven in tests: `scripts/repair-transfer-debt-payment.resync.test.ts` runs the real `syncTransactionsForItem` on repaired rows. It covers:
- `modified[]` and `added[]` re-sends with PFC `LOAN_PAYMENTS`;
- tombstone and resurrection;
- provider-id churn (fingerprint adoption);
- pending → posted, with `removed[]` in the same sync or a later one;
- a same-id pending → posted flip.

In every case the row stays `TRANSFER` / `Transfer` / `TRANSFER_AUTHORITY`. In Production:
1. After the next scheduled sync of the Chase Item (or a manual Refresh by the owner), re-run the §3.4 step 2 query. The 16 rows must be unchanged.
2. The 3 pending rows: when they post, the posted successors must come out `TRANSFER` (the sync-time pass) and the pending rows must be tombstoned. Check with:
   ```
   psql "$DATABASE_URL" -X -1 -c "SET TRANSACTION READ ONLY;
   SELECT t.pending, t.\"deletedAt\" IS NOT NULL AS tomb, t.\"flowType\", t.category, t.\"flowAuthority\", t.amount, t.date
   FROM \"Transaction\" t JOIN \"FinancialAccount\" a ON a.id=t.\"financialAccountId\"
   WHERE a.type IN ('checking','savings') AND t.\"pfcPrimary\"='LOAN_PAYMENTS' AND t.date >= DATE '2026-10-20'
   ORDER BY t.date, t.pending DESC;"
   ```
3. The repair dry run (`--expect=0`) should still propose 0 after the sync.

## 4. Rollback

The restore file is the source. Rollback is a dry run by default.

**How it works:**
- It reverts only rows **still in the repaired state**. Each row is guarded on all six AFTER values and on "not a human category".
- A row that has moved on is reported and left as it is:
  - `DRIFTED`: the sync pass re-settled it, or something reclassified it;
  - `USER_CATEGORY`: a person overrode it;
  - `MISSING`: the row is gone.
- Tombstoned rows still in the repaired state are restored too, for exactness.
- One interactive transaction, all-or-nothing, with the same gate.

```
# 1. dry run — shows revertible / drifted / user-category / missing per id hash
$TSX --rollback=tmp/p1-repair.production.restore.json --env=production --expect=16

# 2. apply — separately authorized, like the forward run
$TSX --rollback=tmp/p1-repair.production.restore.json --apply --env=production \
     --i-have-owner-approval=<ticket> --expect=<revertible count from step 1> --out=tmp/p1-repair.production.rollback.json
```

**Restore file checks.** The rollback refuses the file if:
- it was edited or truncated (checksum);
- an `id` does not match its `idHash`;
- an AFTER is not one of the repair's own shapes;
- it records an `ABORTED` repair;
- it belongs to another database (target hash);
- it was written for another env.

**Verification:** re-run §3.4 step 2. The rows must show the backup CSV's values exactly (`DEBT_PAYMENT | Payment | CLASSIFIER | 5 | PLAID_PFC_PRIMARY | 0.8`).

⚠️ **A rollback restores data, not behaviour.** While v2.7 code runs, the sync-time pass will re-correct any reverted row the provider re-delivers. To revert behaviour as well, roll the deployment back to the previous Production release first (rollback target recorded in the release notes), then roll back the data.

**Fallback if the restore file is lost:** restore from the backup CSV, using the same six columns, guarded on the AFTER values. Write a one-off script reviewed like this one. Never use ad-hoc SQL through the pooler.

## 5. Expected product impact

**Money totals are unchanged:**
- Cash Flow income, spending and net.
- Liquidity.
- Net worth and balances.
- Debt-payment totals. An unattested `DEBT_PAYMENT` cash leg was already excluded by the debt-payment attestation.

A `TRANSFER` leg resolves identically on the liquidity axis, because `flowDirection` is preserved.

**What changes (corrected):**
- **Transaction filters:** the 16 rows leave "Debt payments" and join "Transfers".
- **Category chip:** `Transfer` instead of `Payment`.
- **AI narration and tools:**
  - `transferTotal` / `measure_flows` now count the settled legs (they were understated by up to $22,000 posted);
  - the Brief's recent activity reads the rows as transfers;
  - the chat no longer calls savings contributions "debt payments".
- **Needs classification:** the one unpaired leg is surfaced (`UNKNOWN_TRANSFER_DESTINATION`) until its far leg resolves. When it does, the sync pass settles it to the certain signature on its own.

**Unchanged:**
- the 137 genuine card and loan payments;
- the Schwab and Apple Cash rows;
- every human-categorized row.

## 6. Residual risks

- **Set drift between dry run and apply.** Covered by `--expect` and the BEFORE guard (all-or-nothing).
- **Code/data skew.** Running on v2.6 code would let a re-sync restore the `Payment` category (§1.2). This is a procedural prerequisite; the script cannot detect it.
- **Unpaired leg.** It becomes `TRANSFER @0.2` (surfaced), not `DEBT_PAYMENT`. If the owner says it really was a card payment, a user override is the fix. The repair and the sync both respect `USER_OVERRIDE`.
- **Restore file custody.** Raw ids on an operator's disk. Keep it at 0600 and delete it after the rollback window, which the owner should set (suggested: 30 days).
