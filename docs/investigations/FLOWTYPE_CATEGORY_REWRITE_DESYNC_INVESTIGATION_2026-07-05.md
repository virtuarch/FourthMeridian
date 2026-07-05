> **INVESTIGATION ONLY — no data was modified, no schema was changed, nothing was implemented.** This document scopes the category↔flowType desynchronization seam named in `P5_CLOSEOUT_INVESTIGATION_2026-07-05.md` §2.1, recommends a remediation, and defines the permanent contract Merchant Intelligence must inherit. Every claim was re-derived from the repository (code, git history, and the `scripts/.backfill-logs/` apply records). The database itself was not reachable from this environment; §2 states the exact read-only queries that confirm the derived counts.

# FlowType — Category-Rewrite Flow-Desync: Scope, Remediation & MI Contract

**Date:** 2026-07-05
**Branch:** `feature/v2.5-spaces-completion` (post-P5 closeout, `f22de52`)
**Trigger:** FlowType P5 closeout §2.1 / §5 — the one remaining data seam before Merchant Intelligence
**Verdict:** The seam is real, but the closeout named the wrong instance. The Fee example it cites is **expected to be 0 rows**; the actual value-desynchronized population is **51 credit-card payment rows** left at `flowType=REFUND` where the classifier now says `DEBT_PAYMENT` — a population the closeout did not list. A further **650 rows** are input-stale but value-identical (architectural only). Remediation is a two-statement runbook using existing tooling; no code, no schema.

---

## 1. Root cause (one paragraph)

`scripts/backfill-flowtype.ts` selects rows to classify with `flowType IS NULL OR flowDirection IS NULL OR classifierVersion IS NULL OR classifierVersion < FLOW_CLASSIFIER_VERSION` (currently 1). That gate encodes *algorithm* staleness. It cannot see *input* staleness: when a later tool rewrites `category` (a classifier input) on a row that already carries `classifierVersion = 1`, the row's stored flow was computed against an input that no longer exists, and every re-run of the backfill skips it. Three category backfills ran on 2026-07-04 — **after** the P4 flow backfill had fully populated the table (the 2026-07-04 end-to-end investigation records the standing "0 UNKNOWN, DB fully populated" claim) — and all three deliberately left `flowType`/`classifierVersion` untouched. The `backfill-cc-payment-categories.ts` header even prescribes "re-derive their flow with the EXISTING FlowType backfill" as the follow-up — an instruction the version gate silently turns into a no-op. That is the seam.

---

## 2. Objective 1 — Exact scope

### 2.1 Timeline (reconstructed from git + apply logs)

| When (local, +0300) | Event | Evidence |
|---|---|---|
| 2026-07-03 23:52 | `backfill-flowtype.ts` committed (`0b100c2`) | git log |
| by 2026-07-04 (midday) | P4 flow backfill `--apply` complete — table fully populated at version 1 | `P5_END_TO_END_CUTOVER_STATE_INVESTIGATION.md` (dated 07-04): "standing P4 backfill claim: 0 UNKNOWN, DB fully populated" |
| 2026-07-04 17:05 | `reclassify-subscriptions.ts --apply` — **151 rows** (134 Shopping→Subscriptions, 17 Other→Subscriptions) | `scripts/.backfill-logs/reclassify-subscriptions-2026-07-04T14-05-35-961Z.json` |
| 2026-07-04 17:43 | `backfill-merchant-categories.ts --apply` — **499 rows** (455 Other→Travel, 31 Other→Shopping, 13 Other→Subscriptions, **0 Other→Fee**) | `scripts/.backfill-logs/backfill-merchant-categories-2026-07-04T14-43-32-166Z.json`; rules incl. the Fee rule were live at run time (`c8601b9`, same minute) |
| 2026-07-04 18:10 | `backfill-cc-payment-categories.ts --apply` — **0 rows** (the pre-CC-1 `debtSubtype` filter bug; scanned nothing) | empty log `...T15-10-43-217Z.json` |
| 2026-07-04 21:52 | `backfill-cc-payment-categories.ts --apply` (post-CC-1 fix) — **51 rows** Other→Payment | `scripts/.backfill-logs/backfill-cc-payment-categories-2026-07-04T18-52-22-176Z.json` |
| never | The prescribed follow-up flow re-derivation for those 51 rows | No log, no version clear anywhere in git; the version gate makes a plain re-run a no-op; P5 closeout (07-05) does not list them |

Total category rewrites applied after flow classification: **701 rows**, all recorded id-by-id in the three rollback logs.

### 2.2 The three desync classes

**(a) Value-desynchronized — 51 rows (the real defect).**
The CC-1 rows: destination-side card-payment legs (`amount > 0`, on liability accounts), rewritten Other→Payment. At P4 time they were `category=Other`, positive, `pfc*` null → the classifier's sign-default gave `REFUND / INFLOW` (`SIGN_DEFAULT_INFLOW`, conf 0.5) — the cc script's own header confirms "the rescued rows currently hold flowType = REFUND". The classifier today, given `category=Payment, amount>0`, returns `DEBT_PAYMENT / INFLOW` (conf 1.0, `CATEGORY_FLOW_VALUE`, `flow-classifier.ts:206-210`). Stored output is wrong for current input.

**(b) The closeout's named instance — expected 0 rows.**
`category='Fee' AND flowType='SPENDING'` was cited as the concrete example. The merchant-backfill log shows the Fee rule matched **zero** rows on 07-04; no other path writes `Fee`. The closeout's example was predicate-eligible, not observed. (Verify anyway — query below.)

**(c) Input-stale, value-identical — 650 rows (architectural only).**
The 499 + 151 rewrites all move between members of `SPEND_CATEGORIES` (Other/Shopping ↔ Travel/Shopping/Subscriptions). For every such category the classifier's output is identical (sign-default SPENDING or REFUND), so stored flow **values** are still exactly what the classifier would produce. These rows violate only the provenance invariant ("classified against current input"), not any number any consumer shows.

### 2.3 Verification queries (read-only; run against dev/prod before remediation)

```sql
-- (a) the real defect — expect 51, all currently REFUND
SELECT count(*) FROM "Transaction"
WHERE "category" = 'Payment' AND "flowType" IS DISTINCT FROM 'DEBT_PAYMENT';

-- distribution check for (a) — expect {REFUND: 51}
SELECT "flowType", count(*) FROM "Transaction"
WHERE "category" = 'Payment' AND "flowType" IS DISTINCT FROM 'DEBT_PAYMENT'
GROUP BY 1;

-- (b) the closeout's Fee instance — expect 0
SELECT count(*) FROM "Transaction"
WHERE "category" = 'Fee' AND "flowType" = 'SPENDING';

-- general deterministic-category invariant sweep — expect 0 rows returned
SELECT "category", "flowType", count(*) FROM "Transaction"
WHERE ("category" = 'Transfer' AND "flowType" IS DISTINCT FROM 'TRANSFER')
   OR ("category" = 'Payment'  AND "flowType" IS DISTINCT FROM 'DEBT_PAYMENT')
   OR ("category" = 'Fee'      AND "flowType" IS DISTINCT FROM 'FEE')
GROUP BY 1, 2;
```

(Income/Interest/Dividend are account-context- or sign-dependent and are not clean single-value predicates; the three above are unconditional in the classifier.)

### 2.4 Complete rewrite-path inventory

Every path that can change `Transaction.category`, and whether it invalidates flow:

| # | Path | Reclassifies / invalidates? | Flow-changing? |
|---|---|---|---|
| 1 | `lib/plaid/syncTransactions.ts` (create + Plaid `modified`) | ✅ `buildFlowWriteFields` on every write | safe |
| 2 | `app/api/accounts/[id]/import/route.ts` (create + update-on-match) | ✅ `computeFlowFields` on both | safe |
| 3 | `scripts/backfill-merchant-categories.ts --apply` | ❌ (documented, line 31) | only via the Fee rule (0 matched to date) |
| 4 | `scripts/reclassify-subscriptions.ts --apply` | ❌ | no — value-identical moves |
| 5 | `scripts/backfill-cc-payment-categories.ts --apply` | ❌ — prescribes a follow-up re-run **that the version gate defeats** | **yes** — the 51 rows |
| 6 | `--rollback` mode of scripts 3–5 | ❌ | **yes** — e.g. rolling Payment→Other back after remediation would strand `DEBT_PAYMENT` on an `Other` row |
| 7 | `prisma/seed.ts` | writes categories, never flow | dev-only; produces null flow (visible-to-gate), not desync — known §2.2 closeout item |
| 8 | *(prospective)* MI persisted tier — user/Space category overrides | — | the reason the §5 contract exists |

No runtime user-recategorization endpoint exists today (verified: the only `transaction.update` sites touching `category` are #1 and #2, both safe).

---

## 3. Objective 2 — Remediation options and recommendation

| Option | Assessment |
|---|---|
| **A. Re-run `backfill-flowtype` over a filtered population** | As-is, a **no-op** — the affected rows carry `classifierVersion = 1` and the selection gate skips them. Making it work needs a new `--ids`/`--force` flag → code change. Rejected: unnecessary surface. |
| **B. Clear `classifierVersion` on the affected rows, then re-run `backfill-flowtype --apply`** | **Recommended.** One guarded UPDATE makes the rows visible to the existing, tested, idempotent tool; the classifier stays the sole author of flow values; the run is self-verifying (an immediate dry-run reports 0). No code, no schema. |
| **C. Targeted direct UPDATE of `flowType`** | Rejected. Hand-writes classifier output (flowType + flowDirection + confidence + reason must all be consistent); violates the single-authority architecture the whole initiative exists to enforce. |
| **D. Bump `FLOW_CLASSIFIER_VERSION` to 2** | Works (re-classifies all ~42k rows) but is a code change, conflates *algorithm* versioning with an *input-freshness* incident, and rewrites 60× more rows than needed. Rejected. |

**Recommended population for the invalidation:** the union of the three rollback logs' ids — **701 rows**, exact provenance, bounded. This fixes the 51 value-desynced rows and simultaneously restores the provenance invariant on the 650 value-identical rows (whose re-derivation writes back identical values — zero user-visible change, confirmed by the §2.2(c) analysis). Minimal alternative if only value correctness is wanted: the two predicates in §2.3(a)/(b) (~51 rows). The log-driven set is preferred — same tooling, same risk, and it leaves **no** residual class-(c) rows for a future auditor to re-litigate.

---

## 4. Objective 3 — Blast radius of the 51 rows (current, wrong state)

Fixing them flips `REFUND/INFLOW → DEBT_PAYMENT/INFLOW`. Per consumer, **as the code stands today**:

| Consumer | Actual user-visible impact (today) | After fix | Architectural note |
|---|---|---|---|
| **Banking tab / Space panel chips** | `Payment` is in `BANKING_CATEGORIES`, so the rows are fetched; stored REFUND **nets against the Spend chip** (`BankingClient.tsx:170-177`) → Spend understated by Σ\|amount\| of in-window rows | rows leave the chip math entirely (DEBT_PAYMENT ∉ FLOW_COST, ∉ REFUND netting) → Spend rises to its true value | window-dependent: only rows inside the displayed range distort |
| **Debt view** | **Largest visible defect.** `totalDebtPaid` and the Slice-3 per-card rollup sum `flowType = DEBT_PAYMENT` only (`lib/debt.ts:47-71`) → "total paid toward debt" and the per-card breakdown **miss all 51 destination legs** | totals rise by the rows' Σ\|amount\|; per-card rows appear | this is exactly the KD-18 capability the rows were rescued *for* |
| **AI assembler** | rows enter via `BANKING_FLOWS` as REFUND → `refundTotal` **overstated**, and `netCashFlow = income + refund − expense − debtPayment` **overstated** by the same amount (monthly buckets identically) | `refundTotal`/`netCashFlow` correct; as DEBT_PAYMENT with `amount > 0` the rows are deliberately not summed (destination-leg exclusion, `transactions.ts:316-322`) — no double-count | the sign-guard partition behaves correctly once flow is correct |
| **Daily Brief** | pure assembler consumer → inherits the refund/netCashFlow overstatement | inherits the correction | no independent logic |
| **Merchant rollups** | none — rollup is `flowType = SPENDING` only (`transactions.ts:494`); REFUND rows excluded today, DEBT_PAYMENT excluded after | none | had the Fee instance been real, desynced SPENDING rows *would* have stayed merchant-eligible — the closeout's concern was right in kind, wrong in instance |
| **Annotation engine** | none — the Slice-5 gate **re-classifies live from the category name** (`classifyFlow({category, amount:-1})`, `annotations.ts:774`), so it sees Payment→DEBT_PAYMENT and gates it out regardless of the stored column; the rows are also `amount > 0` and byCategory opportunity math is KD-17 debit-only | none | note the asymmetry: annotations are immune precisely because they *don't* trust the stored column — two answers to "what flow is this row" exist in the codebase. The contract (§5) makes the stored column trustworthy again; a later consolidation could then have annotations read it |
| **Chat serializer** | per-liability debt line sums stored `DEBT_PAYMENT` legs on debt accounts (`chat/route.ts:656+`) → **understates "paid toward <card>"** for affected cards; `NON_SPENDING_CATEGORY_NAMES` is a static name-set → unaffected | per-liability line correct | pure consumer of stored flow |

The 650 class-(c) rows have **zero** impact on any consumer today or after remediation (stored value already equals classifier output).

---

## 5. Objective 4 — The permanent contract (Merchant Intelligence entry gate)

**Rule: a persisted change to any classifier input on a classified row is incomplete until the row's flow columns are recomputed. Category-write and flow-classification are one atomic operation.**

Concretely, if `category` changes after classification:

1. **Runtime paths (MI overrides, rules engine, any future recategorization API): recompute synchronously, in the same DB transaction.** `classifyFlow` is a pure, in-process, O(1) function — there is no cost argument for deferral. The write goes through `classifyFlow` + `buildFlowWriteFields` exactly as sync/import do today. `classifierVersion` is written as the current version, same as any other write.
2. **Bulk/backfill paths: the same UPDATE that rewrites `category` clears `classifierVersion` (single statement), and `backfill-flowtype.ts --apply` runs as the next step of the same runbook.** Clearing the version converts an invisible desync into a state the existing gate, the pre-slice "dry-run reports 0" invariant, and the §2.3 sweep can all see. A backfill runbook that ends before the flow re-run is an incomplete runbook.
3. **Rollback paths are symmetric.** Restoring a prior category is a category write; it re-invalidates and re-classifies the same way. (Scripts 3–5's `--rollback` modes violate this today — any future use of them must be followed by the same clear-and-rerun step.)
4. **Asynchronous recompute is rejected as the contract default.** A stale/null window is *observable*: readers query `flowType IN BANKING_FLOWS`, so a null-flow row vanishes from the AI, the chips, and the debt rollup until the sweeper runs. And there is no job substrate to hang "async" on (D5: `startScheduler()` is never invoked) — in practice async means manual, which is precisely how this incident happened. Async is acceptable only as a *supplement* (a periodic invariant sweep), never as the mechanism of record.
5. **`classifierVersion` keeps exactly one meaning: the algorithm version that produced the stored output; NULL means "not validly classified".** It is not a per-row dirty counter. Input-staleness is prevented by rules 1–3, not tracked in the column.

**Enforcement (design items for MI Slice 1a — no code now):**

- A single category-write choke point (a helper that couples the category mutation to reclassification in one transaction); MI's persisted-override tier writes only through it.
- A repo gate (lint rule or CI grep): no `SET "category"` / `data: { category` on Transaction outside the choke point and the three retired backfill scripts.
- The §2.3 invariant sweep as a standing check (test or ops script): all three deterministic-category predicates must count 0.

**Invariant, stated once:** for every transaction row, `(flowType, flowDirection)` equals `classifyFlow(current row inputs)` at algorithm version `classifierVersion`. The classifier is the only writer; category rewrites preserve the invariant by recomputing, never by assuming.

---

## 6. Objective 5 — Implementation plan (NOT executed; approval gate before Phase 2)

**Phase 0 — Verify (read-only).** Run the §2.3 queries. Expected: 51 / {REFUND:51} / 0 / one Payment-row group. If actuals differ, stop and re-derive scope (Plaid `modified` events could have re-classified some rows since 07-04).

**Phase 1 — Snapshot (read-only; rollback precondition).**
```sql
\copy (SELECT id, "category", "flowType", "flowDirection",
              "classificationConfidence", "classificationReason", "classifierVersion"
       FROM "Transaction"
       WHERE id IN (<701 ids from the three scripts/.backfill-logs/*.json files>))
TO 'flow-desync-preimage-2026-07-05.csv' CSV HEADER;
```

**Phase 2 — Invalidate (first write; requires approval).**
```sql
UPDATE "Transaction" SET "classifierVersion" = NULL
WHERE id IN (<same 701 ids>);
-- assert: exactly 701 rows updated (fewer is acceptable only if Phase 0 explained why)
```
Touches one column; no `updatedAt` bump concern (raw SQL); flow values remain readable throughout (no null-flow window — readers keep seeing the old values until Phase 3 corrects them, so there is no moment where rows vanish from `BANKING_FLOWS`).

**Phase 3 — Reclassify (existing tooling).**
```
npx tsx scripts/backfill-flowtype.ts            # dry-run: must report exactly the Phase-2 count
npx tsx scripts/backfill-flowtype.ts --apply    # writes flow columns only; idempotent
```

**Phase 4 — Validate.**
- §2.3 queries all return 0 / empty.
- `backfill-flowtype.ts` dry-run reports 0 to classify (the standing P5 invariant, restored).
- Diff the Phase-1 snapshot against the same SELECT re-run: exactly 51 rows changed value (REFUND→DEBT_PAYMENT), 650 identical, confidence/reason updated per classifier.
- Spot-check surfaces: Debt view "total paid" and per-card rollup rise by the 51 rows' Σ|amount|; AI `refundTotal` falls by the in-window portion; Banking Spend chip rises accordingly. All three move in the *correcting* direction — brief user-facing note optional.
- `npm test` green (no code changed; suites confirm nothing else moved).

**Rollback plan.**
- Preferred: none — Phase 3 output is by construction the correct classifier result; a surprise here is a classifier bug, which ships as a `FLOW_CLASSIFIER_VERSION` bump + re-run (the P4 doctrine), not a rollback.
- Hard rollback if required: restore the Phase-1 snapshot (`UPDATE ... FROM` the CSV over the 701 ids, flow columns only). Category columns are untouched by this remediation, so the three scripts' own rollback logs remain independently valid.
- Abort between Phase 2 and 3: harmless — rows sit at `classifierVersion = NULL` with old (readable) flow values and are picked up by any later `--apply`.

**Documentation follow-ups (with the remediation PR/runbook, not now):** update the STATUS.md FlowType residual-debt entry (§2.1 instance corrected: cc-payment rows, not Fee; Fee count 0); annotate the three backfill scripts' headers that re-runs after category rewrites require the version clear (comment-only, at MI Slice 1a); record the §5 contract in the MI charter as an entry gate.

---

## 7. Summary for the MI kickoff

The architectural contract — *category rewrite → flow invalidated → flow reclassified* — was broken exactly once, by design-documented omission, across 701 rows on 2026-07-04; 51 of them (CC-1 card-payment legs) carry materially wrong flow today, visibly understating Debt-view totals and the chat per-liability line while overstating AI refund/net-cash-flow figures. The fix is a two-statement runbook over existing tooling. The permanent rule is synchronous recompute for runtime writes and clear-version-then-rerun for bulk writes, enforced through a single category-write choke point that Merchant Intelligence's persisted tier must be built on from Slice 1a.
