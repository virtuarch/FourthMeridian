> **INVESTIGATION + PLAN ONLY — no data was modified, no schema was changed, nothing was implemented.** This document is the formal kickoff of the **Desync Remediation** initiative: the prerequisite that certifies the existing transaction corpus before Merchant Intelligence begins. Phases 1 and 2 below are complete and awaiting approval. Phases 3 and 4 are specified but **NOT executed** — they run only after sign-off. Every count was independently re-derived from the repository (code, git history, and `scripts/.backfill-logs/` apply records); it does not merely inherit the prior scoping note (`FLOWTYPE_CATEGORY_REWRITE_DESYNC_INVESTIGATION_2026-07-05.md`), it re-verifies it.

# Desync Remediation — FlowType/Category Corpus Certification

**Date:** 2026-07-06
**Branch:** `feature/v2.5-spaces-completion`
**Initiative type:** Data-corpus certification (prerequisite to Merchant Intelligence)
**Doctrine:** Investigation first · smallest implementation · no opportunistic refactors · preserve architecture · surgical commits · stop when scope is complete
**Status:** Phase 1 ✅ · Phase 2 ✅ · Phase 3 ✅ (executed 2026-07-06 — **no remediation was required**) · Phase 4 ✅ (**corpus certified**)
**Outcome:** **CERTIFICATION, not remediation.** The live corpus already contained zero FlowType/Category desynchronizations at execution time. See the Resolution section immediately below; Phases 1–2 are preserved verbatim as the (correct-at-the-time) derivation that this outcome supersedes.

---

## RESOLUTION (2026-07-06) — the initiative certified the corpus; no rows were changed

### What execution found

The runbook was run against the live database exactly as planned:

| Step | Result |
|---|---|
| `backfill-flowtype.ts` (dry-run) | **Nothing to classify** |
| `backfill-flowtype.ts --apply` | **Nothing to classify** (0 written) |
| `npm run audit:flow-desync` | **PASSED** — Transfer→TRANSFER: 0, Payment→DEBT_PAYMENT: 0, Fee→FEE: 0 |
| `npm test` | **45/45 passed** |

The dry-run reporting "nothing to classify" is decisive: **every** row already carries a non-null `flowType`/`flowDirection` at `classifierVersion ≥ 1`, and the audit confirms **zero** deterministic-category disagreements. The Phase-2 invalidate `UPDATE` was therefore never needed and was not run. The corpus was already certified.

### Why the derivation expected 51 REFUND rows that do not exist

The Phase-1 figure of 51 was, by its own stated caveat, a *derivation from 2026-07-04 apply-logs and code, never a live measurement* — the DB was unreachable from the analysis sandbox, and the report explicitly instructed Phase 0 to **stop and re-derive if the live count ≠ 51**. That guard fired exactly as designed. Reconciling the derivation with the live state:

1. **The desync was a point-in-time artifact of one standalone script, closed by a normal write path before execution.** The CC-1 correction shipped *twice on 2026-07-04, minutes apart*: (a) the one-time `backfill-cc-payment-categories.ts --apply` at 21:52 (rewrote `category` only — the seam), and (b) commit `275a9c8` "Merchant intelligence foundation" at **21:57**, which added `if (detailed.includes("CREDIT_CARD_PAYMENT")) return "Payment"` to **`mapPlaidCategory`** — i.e. it promoted the CC-1 rule into the *live sync write path*. Since `b6278be` (2026-07-03) the sync path already recomputes flow via `buildFlowWriteFields` from that same category, in one atomic write (`syncTransactions.ts:206,227,270`). So any subsequent sync of those transactions rewrites `category=Payment` **and** `flowType=DEBT_PAYMENT` together, consistently.
2. **There were ample re-sync events in the window.** The D2x Plaid history-sync initiative ran extensively on 2026-07-04 and 2026-07-05 (`06ae257`, `0a5b787`, `a3d895d`, `5fcf43b`, closed `0cfd029` on 07-05 16:31). Every touched credit-card-payment row passed through the corrected, atomic `mapPlaidCategory + buildFlowWriteFields` path and left consistent. (Equivalently: if any authoritative `backfill-flowtype --apply` first-classified those rows *after* the 21:52 category rewrite, they were classified `DEBT_PAYMENT` directly and were never `REFUND`. Both paths converge on the same live result.)
3. **The version-gate finding is technically correct but was no longer load-bearing for this data.** The blindspot in `backfill-flowtype.ts`'s selection predicate (algorithm-version aware, input-staleness blind) is a real, still-present structural property — but its *data consequence* (stranded REFUND rows) requires that **no** consistency-preserving write touch the rows after the standalone category rewrite. In this corpus, the sync path did touch them. The architecture observation stands; the specific data-defect instance did not survive to execution.

### Answers to the four questions posed

1. **Was the remediation already applied previously?** Not the documented runbook (git shows no clear-version-and-rerun; `FLOW_CLASSIFIER_VERSION` is still `1`; the Phase-2 `UPDATE` was never run). But an **equivalent correction** was already in place through the normal sync write path — the CC-1 rule lives in `mapPlaidCategory`, and sync writes category+flow atomically. The seam that only the standalone category script had opened was closed by ordinary syncs before this initiative ran.
2. **Were the backfill logs describing historical state rather than current state?** **Yes.** `scripts/.backfill-logs/*.json` are immutable *apply records* of the 2026-07-04 category transitions — a historical event log, not a snapshot of current rows. Between 07-04 and execution the corpus continued to be written by sync/import, which the logs cannot reflect.
3. **Was the version-gate investigation technically correct but no longer applicable?** **Exactly.** The predicate blindspot is genuine and still exists in code; its predicted *data* impact was a 07-04-state hypothesis that a later atomic write path had already resolved. Correct analysis, superseded instance.
4. **Update the docs to reflect certification, not remediation.** Done — this section, the finalized `CERTIFICATION_2026-07-06.md`, and the STATUS.md residual-debt entry.

### Net outcome and what remains true

- **The transaction corpus is certified: zero FlowType/Category desynchronizations.** Merchant Intelligence may begin.
- **The investigation was not wasted.** It produced the *permanent* certification apparatus that now proves the property and prevents regression: `scripts/audit-flow-desync.ts` (`npm run audit:flow-desync`), the pure regression test `lib/transactions/flow-desync-invariant.test.ts`, and `RUNBOOK.sql`. Remediation was simply found unnecessary — the desired end-state already held.
- **The architectural items in §1.8 remain open and deliberately unfixed** (version-gate input blindspot; backfill `--rollback` modes; the absent single category-write choke point — MI's entry gate). Certification of the current data does not close them; they are MI-runway design items, unchanged by this outcome.

> **Note on preservation:** Phases 1–4 below are retained *verbatim* as written pre-execution. They correctly describe the derivation and the plan given the information then available; the Resolution above is the authoritative outcome and supersedes the "51 rows will be changed" expectation wherever the two differ.

---

## Environment caveat (read first)

The production/dev database is a **local Postgres** (`postgresql://fintracker@localhost:5432/fintracker`) that lives on the operator's machine and is **not reachable from this analysis sandbox**. Every count in this report is therefore *derived* from three authoritative, in-repo sources — the classifier source, git history, and the id-by-id `--apply` rollback logs — not from a live `SELECT`. The derivation is exact and falsifiable: Phase 0 of the remediation (§6) runs the confirming queries against the live DB before any write. **Treat "51" as a derived expectation to be confirmed at Phase 0, not as a live measurement.**

---

## Phase 1 — Investigation Report

### 1.1 What "desynchronized" means here

A transaction row carries a persisted `category` (`TransactionCategory` enum) and, since FlowType P3/P4, a persisted `flowType` (`FlowType` enum). The single source of truth that relates them is the pure classifier `classifyFlow()` in `lib/transactions/flow-classifier.ts`. The corpus invariant is:

> For every row, `(flowType, flowDirection) == classifyFlow(current row inputs)` at algorithm version `classifierVersion`.

A row is **value-desynchronized** when its stored `flowType` differs from what `classifyFlow` returns for its *current* inputs. It is **input-stale but value-identical** when a classifier input (e.g. `category`) was rewritten after classification but the recomputed `flowType` is byte-identical to what is already stored (invariant technically violated on provenance, but no number any consumer reads is wrong).

Only three categories map to a flow value *unconditionally* (independent of amount sign or account context), so only these three give a clean single-value predicate:

| category | classifier flowType | source |
|---|---|---|
| `Transfer` | `TRANSFER` | `flow-classifier.ts:203` |
| `Payment` | `DEBT_PAYMENT` | `flow-classifier.ts:206-210` |
| `Fee` | `FEE` | `flow-classifier.ts:226-227` |

`Income`, `Interest`, `Dividend`, and the spend categories are **sign- or account-context-dependent by design** (e.g. `Interest` on a debt account is `INTEREST`/cost, on a savings account it is `INCOME`). These are *not* desyncs and **must not** be swept into any predicate — doing so would corrupt correct rows.

### 1.2 Exactly how many desynchronized transactions exist

**Value-desynchronized: 51 rows** (derived; confirm at Phase 0).

- Source: `scripts/.backfill-logs/backfill-cc-payment-categories-2026-07-04T18-52-22-176Z.json` — a list of **exactly 51** entries, every one `{from: "Other", to: "Payment"}`.
- These are the **CC-1 rows**: destination-side credit-card payment legs (`amount > 0`, on liability accounts) that `scripts/backfill-cc-payment-categories.ts --apply` rewrote `Other → Payment` on 2026-07-04 21:52, *after* the P4 flow backfill had already classified the whole table.
- Their stored flow was computed when they were still `category=Other, amount>0, pfc=null`. That path returns `REFUND / INFLOW` (`SIGN_DEFAULT_INFLOW`, conf 0.5 — `flow-classifier.ts:244-246`). The script's own header (line 39-42) confirms: *"The rescued rows currently hold flowType = REFUND."*
- The classifier today, given `category=Payment, amount>0`, returns `DEBT_PAYMENT / INFLOW` (conf 1.0, `CATEGORY_FLOW_VALUE` — `flow-classifier.ts:206-210`). **Stored `REFUND` ≠ classifier `DEBT_PAYMENT` → 51 value-desynced rows.**

**Input-stale but value-identical: 650 rows** (architectural only — no consumer sees a wrong number).

- 499 rows from `backfill-merchant-categories` (455 Other→Travel, 31 Other→Shopping, 13 Other→Subscriptions) + 151 rows from `reclassify-subscriptions` (134 Shopping→Subscriptions, 17 Other→Subscriptions).
- Every one of these moves *between members of `SPEND_CATEGORIES`* (`flow-classifier.ts:111-113`). For all such categories the classifier's output is identical (sign-default `SPENDING` for `amount<0`, `REFUND` for `amount>0`), so the stored flow **value** already equals the classifier's current output. Only the provenance invariant ("classified against current input") is violated.

**Total category rewrites applied after flow classification: 701 rows** (51 + 499 + 151), each recorded id-by-id in the three rollback logs.

### 1.3 Every mismatch category

There is exactly **one** value-mismatch class:

| # | Predicate | Expected count | Nature |
|---|---|---|---|
| (a) | `category='Payment' AND flowType='REFUND'` | **51** | The real defect (CC-1 legs) |
| (b) | `category='Fee' AND flowType='SPENDING'` | **0** | Named by the P5 closeout as the example, but predicate-eligible only — the merchant-backfill log shows **0** `Other→Fee` matches, and no other path writes `Fee`. Confirmed: `Fee targets: 0`. |
| (c) | `category='Transfer' AND flowType≠'TRANSFER'` | **0** | No rewrite path produced this |

Classes (b) and (c) are expected-zero and are included in the standing audit purely as guards.

### 1.4 Root cause

`scripts/backfill-flowtype.ts` selects rows to (re)classify with:

```
flowType IS NULL OR flowDirection IS NULL OR classifierVersion IS NULL
  OR classifierVersion < FLOW_CLASSIFIER_VERSION   -- currently 1
```

(`backfill-flowtype.ts:101-109`). That gate encodes **algorithm staleness**. It is structurally blind to **input staleness**: when a later tool rewrites `category` (a classifier input) on a row that already carries `classifierVersion = 1`, the stored flow was computed against an input that no longer exists, yet the gate — seeing a current version — skips the row forever.

Three category backfills ran on 2026-07-04, all *after* the table was fully flow-populated, and all three deliberately left `flowType`/`classifierVersion` untouched. `backfill-cc-payment-categories.ts` even prescribes (header line 42) re-running the FlowType backfill as the follow-up — an instruction the version gate silently converts into a no-op. That follow-up **never ran** (no log, no version clear in git). That omission is the seam.

### 1.5 Classification of each mismatch

| Mismatch | historical import? | classification drift? | manual edit? | bug? | expected edge case? |
|---|---|---|---|---|---|
| **51 CC-1 rows** (Payment/REFUND) | Partly — they are historical Plaid rows, but the desync was introduced by a **backfill script**, not by import itself | No — the classifier logic never changed (still v1) | No — no human edited these rows | **Process bug**: a runbook omission (category rewrite not paired with flow re-derivation), enabled by the version-gate blindspot | No |
| **650 value-identical rows** | Same provenance | No | No | Same process omission, but **no wrong value** — provenance-only | Effectively yes — they are inert; correcting them is optional hygiene |
| **Fee (0), Transfer (0)** | — | — | — | — | Expected-zero guards |

**Net:** the incident is a single-cause **process/runbook bug** (bulk category write not atomically paired with flow re-classification), not classifier drift, not a manual edit, and not a classifier logic bug. The classifier is correct; the data is stale relative to it.

### 1.6 Should any rows intentionally remain exceptions?

**No row should intentionally remain value-desynced.** All 51 must be corrected.

Two things that look like exceptions but are not:

1. The 650 value-identical rows are *not* exceptions — they are already value-correct; re-deriving them writes back identical values (zero user-visible change) and restores the provenance invariant. Including them is a cleanliness choice, not a correctness need (see Phase 2 for the population decision).
2. `Income` / `Interest` / `Dividend` / spend categories are **legitimately not deterministic** on category alone. They are excluded from the invariant predicates by design; they are correct behaviour, not exceptions to be tolerated.

### 1.7 Blast radius of the 51 wrong rows (current state, per consumer)

| Consumer | Impact today (wrong) | After fix |
|---|---|---|
| Debt view (`lib/debt.ts:47-71`) | **Largest defect.** `totalDebtPaid` and per-card rollup sum `flowType=DEBT_PAYMENT` only → **miss all 51 legs** | totals rise by Σ\|amount\|; per-card rows appear |
| Banking / Space Spend chip (`BankingClient.tsx:170-177`) | stored `REFUND` **nets against Spend** → Spend understated (window-dependent) | rows leave chip math → Spend rises to true value |
| AI assembler (`transactions.ts`) | rows enter as `REFUND` → `refundTotal` and `netCashFlow` **overstated** | corrected; destination-leg exclusion applies |
| Daily Brief | inherits assembler overstatement | inherits correction |
| Chat serializer (`chat/route.ts:656+`) | per-liability "paid toward <card>" **understated** | correct |
| Merchant rollups (`transactions.ts:494`) | none (`SPENDING`-only) | none |
| Annotation engine (`annotations.ts:774`) | none — re-classifies live from category, ignoring the stored column | none |

All movements are in the **correcting** direction.

### 1.8 Additional architectural issues found (DOCUMENT, DO NOT FIX — out of scope)

Per the stop condition, these are recorded and explicitly deferred:

1. **Version-gate input blindspot (the root enabler).** `classifierVersion` tracks algorithm version, not input freshness; a category rewrite on a current-version row is invisible to every future backfill. Structural, not a data fix.
2. **Backfill `--rollback` modes re-introduce desync.** Scripts 3–5's rollback restores `category` without touching `flowType`, stranding the old flow. Any future rollback must be followed by clear-version-and-rerun.
3. **No runtime category-write choke point.** Nothing today couples a `category` mutation to reclassification in one transaction. Verified there is currently **no runtime recategorization endpoint** (the only `transaction.update` sites touching category are `syncTransactions.ts` and the import route, both of which already recompute flow; `reconcile.ts:446` only re-points `financialAccountId`). This becomes load-bearing the moment Merchant Intelligence adds a persisted category-override tier — it is MI's entry-gate design item, not this initiative's.
4. **Two sources of truth for "what flow is this row."** `annotations.ts` re-classifies live rather than trusting the stored column; other consumers trust the column. A future consolidation could let annotations read the (now-trustworthy) column. Not now.

These are **not** fixed by this initiative. This initiative certifies the corpus only.

---

## Phase 2 — Remediation Plan

### 2.1 Design goal

Smallest possible change that makes the stored `flowType` equal the classifier's output for every row, using the **existing, tested, idempotent** classifier and backfill tooling, with the classifier remaining the *sole author* of flow values. No code, no schema, no hand-written flow values.

### 2.2 Options considered

| Option | Verdict |
|---|---|
| **A. Re-run `backfill-flowtype` filtered** | **Rejected** — no-op as-is (affected rows carry `classifierVersion=1`, gate skips them); making it work needs a new `--ids`/`--force` flag = code change = new surface. |
| **B. Clear `classifierVersion` on the affected rows, then re-run `backfill-flowtype --apply`** | **✅ RECOMMENDED** — one guarded `UPDATE` makes rows visible to the existing gate; classifier stays sole author; self-verifying (immediate dry-run reports the exact count); no code, no schema. |
| **C. Targeted direct `UPDATE` of `flowType`** | **Rejected** — hand-writes classifier output (flowType+direction+confidence+reason must stay consistent); violates single-authority architecture. |
| **D. Bump `FLOW_CLASSIFIER_VERSION` to 2** | **Rejected** — code change; conflates algorithm versioning with an input-freshness incident; rewrites ~42k rows to fix 51. |

### 2.3 Which records change, which values change

- **Records touched by the fix (write #1 — invalidation):** the **701 ids** from the union of the three rollback logs. (Rationale below.) Only the `classifierVersion` column is set to `NULL`.
- **Records whose *values* change (write #2 — reclassify):** of those 701, exactly **51** flip `flowType REFUND → DEBT_PAYMENT` (and `flowDirection` stays `INFLOW`, `classificationConfidence 0.5 → 1.0`, `classificationReason SIGN_DEFAULT_INFLOW → CATEGORY_FLOW_VALUE`, `classifierVersion → 1`). The other **650** are rewritten to **byte-identical** flow values (only `classifierVersion` returns to 1) — zero user-visible change.
- **Columns never touched:** `category`, `amount`, `merchant`, `date`, `pending`, `accountId`, `financialAccountId`, `plaidTransactionId`, `importBatchId`, `updatedAt`, and every timestamp. `backfill-flowtype --apply` writes only the 10 flow columns via a parameterized raw `UPDATE` that deliberately does not bump `updatedAt`.

**Population decision (701 vs 51):** the **701-id log-driven set** is recommended over the minimal 51-row predicate. Same tooling, same risk, same classifier; it corrects the 51 value-desyncs *and* restores the provenance invariant on the 650 value-identical rows, leaving **no** residual input-stale class for a future auditor to re-litigate. The minimal 51-only alternative (via the §1.3(a) predicate) is available if the operator wants the tightest possible touch, but it leaves the 650 provenance-stale.

### 2.4 Are the changes deterministic?

**Yes, fully.** `classifyFlow` is pure (same input → same output; no I/O, no clock, no randomness — enforced by the module's design contract). Given the fixed 701 ids and unchanged category/amount/account inputs, the output is a single determined value per row. There is no model, no heuristic threshold in play for these rows (the 51 hit `CATEGORY_FLOW_VALUE` at confidence 1.0).

### 2.5 Is there any ambiguity?

**None for the 51.** `category=Payment, amount>0` → `DEBT_PAYMENT/INFLOW` is unconditional and confidence 1.0. The only residual uncertainty is the **live count** (sandbox cannot query the DB): a Plaid `modified` event since 2026-07-04 could in principle have re-synced and re-classified a handful of these rows already. Phase 0 detects this — if the live count ≠ 51, **stop and re-derive** before writing.

### 2.6 Rollback strategy

- **Preferred: none needed.** Phase 3 output *is* by construction the correct classifier result; a surprise would be a classifier bug, which ships as a `FLOW_CLASSIFIER_VERSION` bump + re-run (P4 doctrine), not a data rollback.
- **Precondition snapshot (rollback insurance):** before write #1, `\copy` the 7 flow-related columns for the 701 ids to `flow-desync-preimage-2026-07-06.csv`.
- **Hard rollback:** restore that CSV over the 701 ids (flow columns only). Category columns are untouched by this remediation, so the three scripts' own category rollback logs remain independently valid.
- **Abort between write #1 and write #2 is harmless:** rows sit at `classifierVersion=NULL` with their old, still-readable flow values, and are picked up by any later `--apply`. No null-flow window (readers keep seeing old values until reclassify corrects them), so nothing vanishes from `BANKING_FLOWS` mid-run.

### 2.7 Validation strategy

Covered in full by the Phase 4 certification below. In brief: the three §1.3 predicates must all count 0; `backfill-flowtype` dry-run must report 0 to classify; the pre/post snapshot diff must show exactly 51 value changes and 650 identical; `npm test` green.

---

## Phase 3 — Implementation Checklist (⏸ NOT EXECUTED — runs only after approval, on the operator's machine with DB access)

- [ ] **P0 Verify (read-only).** Run the three §1.3 predicate queries + the `Payment`-distribution query against the live DB. Expect `51 / {REFUND:51} / 0 / 0`. If actuals differ, **STOP** and re-derive scope.
- [ ] **P1 Snapshot (read-only).** `\copy (SELECT id, category, flowType, flowDirection, classificationConfidence, classificationReason, classifierVersion FROM "Transaction" WHERE id IN (<701 ids>)) TO 'flow-desync-preimage-2026-07-06.csv' CSV HEADER;`
- [ ] **P2 Invalidate (write #1).** `UPDATE "Transaction" SET "classifierVersion" = NULL WHERE id IN (<701 ids>);` — assert exactly 701 rows updated (fewer acceptable only if P0 explained why).
- [ ] **P3 Reclassify (write #2, existing tooling).** `npx tsx scripts/backfill-flowtype.ts` (dry-run must report the P2 count) → `npx tsx scripts/backfill-flowtype.ts --apply` (writes flow columns only; idempotent).
- [ ] **P4 Validate.** Run the Phase 4 audit (below). All predicates 0; dry-run reports 0; snapshot diff = 51 changed / 650 identical; `npm test` green.
- [ ] **Surgical commit.** One data-remediation commit + the certification artifacts (Phase 4). No app code, no schema, no UI.

Scope guardrails (hard NOs for this phase): no schema changes · no UI · no Merchant Intelligence · no Transaction Intelligence · no AI changes · no category redesign · no FlowType redesign · update only the incorrect records.

---

## Phase 4 — Certification Design (⏸ built at implementation time, after approval)

Goal: future releases can *prove* "there are zero FlowType/Category desynchronizations." Three permanent artifacts, all authored as code (no DB needed to write them; the audit script needs DB to *run*):

1. **Validation command — `scripts/audit-flow-desync.ts`** (new, read-only). Runs the three deterministic-category invariant predicates and prints a pass/fail line each; exit code 1 if any predicate counts > 0. Wired as an npm script `audit:flow-desync`. This is the repeatable audit and the validation command in one.
2. **Regression test(s) — pure unit tests** (no DB) that pin the classifier invariant the corpus depends on: `classifyFlow({category:'Payment', amount: 1}).flowType === 'DEBT_PAYMENT'`; `'Transfer' → 'TRANSFER'`; `'Fee', amount:-1 → 'FEE'`. These fail loudly if anyone ever changes the classifier such that a deterministic category stops mapping 1:1 — i.e. they protect the *contract* the audit enforces. Added under `lib/transactions/` so `scripts/run-tests.ts` auto-discovers them.
3. **Certification report** — a short `CERTIFICATION_2026-07-06.md` capturing: the P0 live counts, the P4 post-run counts (all 0), the snapshot diff summary, and a signed statement of the invariant. Appended once Phase 3 runs.

Standing invariant (the thing certified): *for every transaction row, `(flowType, flowDirection) == classifyFlow(current inputs)` at `classifierVersion`; the classifier is the only writer; category rewrites preserve the invariant by recomputing, never by assuming.*

---

## Deliverables status

| Deliverable | Status |
|---|---|
| Investigation report | ✅ Phase 1 above |
| Remediation plan | ✅ Phase 2 above |
| Implementation checklist | ✅ Phase 3 above (unexecuted) |
| Validation checklist | ✅ Phase 4 audit + P4 step above (unexecuted) |
| Certification report | ⏸ produced when Phase 3 runs |

## Stop point

Phases 1 and 2 are complete. **This is the approval gate.** Nothing is written to the database and no code is changed until the plan above is approved. On approval, Phase 3 executes on the operator's machine (DB access required) and Phase 4 artifacts are committed alongside the remediation. Merchant Intelligence starts only after Phase 4 certifies the corpus.
