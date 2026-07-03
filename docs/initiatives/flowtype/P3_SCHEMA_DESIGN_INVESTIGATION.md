> **INVESTIGATION ONLY — no schema, migration, or code changes were made to produce this document.** Every Prisma block below is a design reference, not for merge. Governing design: `docs/investigations/FLOWTYPE_FOUNDATION_INVESTIGATION.md`. Prior phases: P1 (classifier) and P2 (import fidelity) complete.

# FlowType P3 — Additive Schema Design (Investigation)

**Date:** 2026-07-03
**Branch:** `feature/v2.5-spaces-completion`
**Initiative:** v2.5.5 Financial Intelligence — Transaction Semantics
**Phase:** P3 design (persist the classifier output). Depends on P1 + P2.
**Status:** Investigation complete — schema proposal + migration plan only. No implementation.

---

## 1. Executive summary

P1 built a deterministic classifier; P2 wired the rich Plaid inputs into it in shadow. P3 designs the **permanent, additive columns** that persist the classifier's output so it becomes queryable, indexable, and the single reconciliation target for UI, AI, and the AI-4 validator. Nothing here is destructive: every proposed column is nullable, no existing column is touched, `TransactionCategory` is untouched, and no read path is cut over (that is P5).

The design carries three orthogonal facts per row — **kind** (`flowType`), **direction** (`flowDirection`), and **the other side** (`counterpartyAccountId`) — plus provenance (`classificationConfidence`, `classificationReason`, `classifierVersion`) and the raw provider taxonomy hints (`pfcPrimary`, `pfcDetailed`, `pfcConfidenceLevel`) the classifier consumes. It adds one forward seed for the Merchant Engine (`merchantEntityId`) and deliberately defers everything that would be speculative today (transfer-pair linking, principal/interest split, investment lots, multi-currency) while proving none of them are blocked.

Headline decisions:
- **10 columns + 3 native enums** on `Transaction`, all nullable at introduction.
- Merchant *attributes* do **not** go on `Transaction`; only a merchant *reference key* does. The Merchant entity is a future table.
- Three composite indexes sized to the actual rollup queries (per-liability, per-flow, reverse-attribution).
- Backfill split cleanly into **deterministic / partial / impossible** — and the impossible bucket is left `null`/`UNKNOWN`, never invented.

---

## 2. Exact `Transaction` columns (investigation #1)

Design reference — additive block on the existing `Transaction` model (`schema.prisma:1125-1168`):

```prisma
model Transaction {
  // ... all existing fields unchanged ...

  // ── FlowType semantics (P3) ──────────────────────────────────────────────
  flowType                 FlowType?                 // economic KIND
  flowDirection            FlowDirection?            // INFLOW / OUTFLOW / INTERNAL
  counterpartyAccountId    String?                   // best-effort "other side" (owned acct)
  counterpartyAccount      FinancialAccount?         @relation("TransactionCounterpartyAccount", fields: [counterpartyAccountId], references: [id], onDelete: SetNull)

  // ── Classification provenance (P3) ───────────────────────────────────────
  classificationConfidence Float?                    // 0..1, from classifyFlow()
  classificationReason     FlowClassificationReason? // stable reason code
  classifierVersion        Int?                      // logic version that produced this row

  // ── Raw provider taxonomy hints (captured P2, persisted P3) ──────────────
  pfcPrimary               String?                   // Plaid personal_finance_category.primary
  pfcDetailed              String?                   // Plaid personal_finance_category.detailed
  pfcConfidenceLevel       String?                   // Plaid PFC confidence (VERY_HIGH..UNKNOWN)

  // ── Merchant Engine forward seed (P3) ────────────────────────────────────
  merchantEntityId         String?                   // Plaid merchant_entity_id — stable merchant key

  // Reserved, NOT added now (see §6/§11): transferGroupId for pair-linking.

  @@index([financialAccountId, flowType, date])      // per-account / per-liability rollups
  @@index([flowType, date])                          // global per-flow lenses
  @@index([counterpartyAccountId])                   // reverse attribution
}
```

`FinancialAccount` gains one relation-only line (no column):
```prisma
counterpartyTransactions Transaction[] @relation("TransactionCounterpartyAccount")
```

### 2.1 Three native enums

```prisma
enum FlowType {
  SPENDING
  INCOME
  REFUND
  DEBT_PAYMENT
  TRANSFER
  INVESTMENT
  FEE
  INTEREST
  ADJUSTMENT
  UNKNOWN
}

enum FlowDirection {
  INFLOW
  OUTFLOW
  INTERNAL
  UNKNOWN
}

enum FlowClassificationReason {
  PLAID_PFC_DETAILED
  PLAID_PFC_PRIMARY
  CATEGORY_FLOW_VALUE
  CATEGORY_INVESTMENT_VALUE
  ACCOUNT_TYPE_CONTEXT
  SIGN_DEFAULT_SPENDING
  SIGN_DEFAULT_INFLOW
  AMBIGUOUS_UNKNOWN
}
```

No `@@map` is needed — `@@map` in this schema exists only to preserve DB type names across the Workspace→Space rename; these are brand-new types. All three enum value sets are 1:1 promotions of the P1 TypeScript unions (`lib/transactions/flow-classifier.ts`), so the classifier's output serializes directly.

### 2.2 Rationale for every field

| Field | Type | Why it exists | Why on `Transaction` |
|---|---|---|---|
| `flowType` | `FlowType?` | The canonical economic kind — the field every consumer will filter on; collapses ~4 drifting inline definitions. | It is a financial fact about the movement, exactly like `category`/`amount` (freeze §13). |
| `flowDirection` | `FlowDirection?` | Money in/out **of the user's world**, which per-account sign cannot express; marks `INTERNAL` legs for structural exclusion from cash flow. | Same — per-row financial fact. |
| `counterpartyAccountId` | `String?` FK | The "other side" when it's an owned account. Makes destination-aware debt attribution (KD-18) and per-account transfer analysis deterministic without double-entry. | It's a per-row relationship; `onDelete: SetNull` mirrors `importBatchId`. |
| `classificationConfidence` | `Float?` | Gates `UNKNOWN`, AI honesty disclosures, and safe selective re-classification. | Provenance of this row's classification. |
| `classificationReason` | `FlowClassificationReason?` | Auditable, testable "why" — distinguishes a PFC-driven decision from a sign default; drives backfill targeting. | Provenance of this row. |
| `classifierVersion` | `Int?` | Lets a later, better classifier re-run over only stale rows (`WHERE classifierVersion < N`) without re-touching high-confidence ones. Monotonic Int is cheapest to compare. | Provenance of this row. |
| `pfcPrimary` | `String?` | Raw Plaid taxonomy the classifier consumes; kept for re-classification and the drawer. | Provider-agnostic in meaning (a taxonomy hint), null for non-Plaid. |
| `pfcDetailed` | `String?` | The single field that recovers transfer/loan subtypes `mapPlaidCategory` discarded (foundation §5); highest-value classifier signal. | Same. |
| `pfcConfidenceLevel` | `String?` | Plaid's own confidence; can later scale `classificationConfidence`. | Same. |
| `merchantEntityId` | `String?` | Stable Plaid merchant key — the forward seed that lets the Merchant Engine backfill Merchant rows and a `merchantId` FK later **without re-fetching from Plaid**. | Reference key only; merchant *attributes* live on the future Merchant entity (§3). |

**Why `String` for `pfcPrimary`/`pfcDetailed`/`pfcConfidenceLevel` and not enums:** Plaid owns and revises that taxonomy (hundreds of `detailed` values, versioned); modeling it as our enum would couple our schema to Plaid's release cycle and force a migration per Plaid change. It is a captured provider hint, not our semantics — our semantics are `flowType`. Keep it a plain string.

**Why `classifierVersion` is `Int`, not a semver string:** the only operation is "is this row older than the current classifier?" — an integer comparison is index-friendly and unambiguous. A human-readable mapping (1 = P1 rules, 2 = P3 rules, …) lives in the classifier module doc, not the DB.

---

## 3. `Transaction` vs. a future Merchant entity (investigation #2)

**Principle:** `Transaction` carries *what happened* (flow, amount, date, raw provider hints, and a merchant *reference*). A Merchant entity carries *who the merchant is* (identity/attributes), deduplicated across transactions. Putting merchant attributes on every transaction row is the denormalization anti-pattern the freeze doc warns against (`§7`: nothing that should be summed/sorted/filtered once should be copied per row).

| Belongs on `Transaction` now | Belongs on a future `Merchant` entity |
|---|---|
| `merchant` (raw per-row descriptor — already exists) | canonical `displayName` / normalized name |
| `merchantEntityId` (reference key / seed) | `logoUrl`, `website`, `entityIdSource` |
| flow semantics + provenance + pfc hints | merchant `category` glyph, MCC, aggregate stats |
| (later) `merchantId` FK → Merchant | one row per real merchant, keyed by `merchantEntityId` |

**Migration path to Merchant (fully additive, not designed here):** when the Merchant Engine lands, create `Merchant` keyed by `merchantEntityId`, populate it from `SELECT DISTINCT merchantEntityId` over `Transaction`, then add a nullable `Transaction.merchantId` FK and backfill it by join. Nothing in P3 blocks this; capturing `merchantEntityId` now is what *enables* it without a Plaid re-fetch. **P3 does not create the Merchant table** — that is scope creep into the Merchant Engine.

---

## 4. Index strategy (investigation #3)

Three composite/secondary indexes, each tied to a concrete query, plus a note on what was deliberately *not* indexed.

1. **`@@index([financialAccountId, flowType, date])`** — the per-account / per-liability rollup. The KD-18 capability query is exactly `WHERE financialAccountId = ? AND flowType = 'DEBT_PAYMENT' [AND date ∈ window] GROUP/ORDER BY date`. Leading `financialAccountId` also serves per-account income/spend/interest questions (the KD-18 §6 watch list). Supersedes the need for a bare `[financialAccountId, flowType]`.
2. **`@@index([flowType, date])`** — global per-flow lenses (Perspective Engine, Daily Brief, "all transfers", "all refunds this month") that aren't account-scoped. Date second supports the near-universal windowing.
3. **`@@index([counterpartyAccountId])`** — reverse attribution ("what paid this card / funded this account"), and makes the `onDelete: SetNull` cascade check cheap.

**Deliberately not indexed (with rationale):**
- `classifierVersion` — backfill/re-classification is a batched offline job; a full scan is acceptable and an index would add write amplification on a high-write table for a rare read. Add later only if online re-classification becomes frequent.
- `merchantEntityId` — the Merchant backfill (`SELECT DISTINCT`) is a one-off batch; index it when the Merchant Engine needs online lookups, not now.
- `flowDirection` alone — low cardinality (4 values); a standalone index is poor selectivity. It rides as a filter after the `flowType`/account predicates.

**Write-amplification note:** `Transaction` is the highest-write table (every sync). Three new indexes is a real but bounded cost; §10 quantifies. The set is intentionally minimal — three, not "one per column."

---

## 5. Nullable vs. required (investigation #4)

**All new columns are nullable at introduction — non-negotiable for an additive migration** (existing rows must read back valid without a rewrite, and Postgres adding a nullable column is a metadata-only, lock-cheap operation; adding `NOT NULL` with a default on a large table is not).

Longer-term disposition:

| Column | At P3 | Eventual |
|---|---|---|
| `flowType`, `flowDirection` | nullable | **Could** tighten to `NOT NULL` after backfill validates + read cutover (P5), with `UNKNOWN` as the floor value. `null` = "not yet classified"; `UNKNOWN` = "classified, uncertain" — a meaningful distinction worth keeping through transition. |
| `classificationConfidence`, `classificationReason`, `classifierVersion` | nullable | Effectively always-set for classified rows post-cutover; keep nullable to tolerate any unclassified straggler. |
| `counterpartyAccountId` | nullable | **Permanently nullable** — the other side is often genuinely unknown (external transfer, unpaired source leg). Null is a correct answer, not a gap. |
| `pfcPrimary`, `pfcDetailed`, `pfcConfidenceLevel` | nullable | **Permanently nullable** — non-Plaid rows (CSV, manual, wallet) have no PFC. |
| `merchantEntityId` | nullable | **Permanently nullable** — payroll/transfers and non-Plaid rows have no merchant entity. |

The "tighten to NOT NULL" step, if ever taken, is its **own** later migration with its own gates — never bundled into the additive P3 migration.

---

## 6. Backfill strategy (investigation #6) — deterministic / partial / impossible

The governing rule (stated by the user, and the KD-18 doctrine): **do not invent data.** Anything not derivable stays `null` / `UNKNOWN`.

### 6.1 Deterministic backfill (all rows, safe, idempotent)
Run `classifyFlow({ category, amount, accountType, debtSubtype })` over every existing row to populate `flowType`, `flowDirection`, `classificationConfidence`, `classificationReason`, `classifierVersion`. Inputs are all already-stored columns (category, amount) plus a join to the owning `FinancialAccount` for `type`/`debtSubtype`. This is pure, re-runnable, and produces the coarse-but-always-correct classification. **Destination-side debt attribution needs no backfill** — the card-side credit leg already sits on its own `financialAccountId`; the rollup is a read, not a stored value.

### 6.2 Partial backfill (only where the signal was captured)
- `pfcPrimary` / `pfcDetailed` / `pfcConfidenceLevel` / `merchantEntityId`: exist only for **P2-forward** Plaid rows (they were never stored before P2). Historical Plaid rows and all CSV/manual rows have none → those columns stay `null` and their `flowType` is the coarse §6.1 value. Fine — additive by nature.
- `counterpartyAccountId` (source-side, e.g. checking→card): heuristic only (merchant-string / unique-liability inference). Populate **only** when unambiguous; leave `null` otherwise. Low `classificationConfidence` accompanies these.

### 6.3 Impossible backfill (leave null/UNKNOWN — never fabricate)
- Historical `pfcDetailed` for pre-P2 rows — never stored; the Plaid cursor model resists re-fetch (a full re-sync is a separate, later decision, interacts with KD-7's 5,000-row cap).
- Principal vs. interest split inside a debt payment — insufficient provider signal.
- Source-side "which card" without transfer-pair linking.
- Multi-currency normalization (MC1).
These remain `null` / `UNKNOWN` with an honest `classificationReason` (`AMBIGUOUS_UNKNOWN`), preserving the KD-18 posture.

**Idempotence contract:** the backfill must converge — re-running yields identical output for the same classifier version. `classifierVersion` lets a future improved classifier re-run over only `classifierVersion < N` rows, never disturbing higher-confidence ones.

---

## 7. Migration phases (investigation #7)

P3 is the **schema** phase; population and cutover are its successors. Each phase is its own migration/checklist with its own gates.

- **Phase A — Additive schema (the P3 migration).** Create the 3 enums; add the 10 nullable columns + the counterparty relation; add the 3 indexes. Zero behavioral change: nothing reads or writes the columns yet. This is the only DDL P3 authorizes (on approval).
- **Phase B — Write-time population (P3/P4 boundary).** Promote the P2 shadow classification to a real write on the sync/import/manual paths, so **new** rows carry `flowType` going forward. Reads still ignore it. `fields`-object discipline from P2 is relaxed *only* to add the new columns to the write, nothing else.
- **Phase C — Historical backfill (P4).** The §6 batched, re-runnable script over existing rows.
- **Phase D — Read cutover + optional NOT NULL tightening (P5).** Point assemblers/UI/validator at the stored columns; delete the scattered inline definitions; add the per-liability rollup; relax the KD-18 guardrail only for the now-backed dimension.

Migration file naming follows the existing convention (`YYYYMMDDHHMMSS_v255_flowtype_schema`, cf. `20260703120000_v25a_retire_workspace_account_share`). The backfill is a `scripts/` job (cf. `backfill:ai-agents`), **never** embedded in the migration.

---

## 8. Rollback (investigation #8)

Phase A is fully reversible: drop the 3 indexes, the 3 enums, and the 10 columns + relation. **No data loss of record** — `category`, `amount`, `merchant`, and all provider lineage are untouched; only the additive classification columns disappear. Because reads are not cut over until Phase D, dropping the columns cannot break any query. Prisma-level rollback is a down-migration; operationally, the columns can also be left in place and simply ignored (a null column is inert). Phase B rollback = stop writing the columns (revert the write-path hunk); Phase C rollback = the columns already tolerate null, so an aborted backfill just leaves some rows unclassified.

---

## 9. Validation checklist (investigation #9)

For the Phase A migration (on approval):
- [ ] `npx prisma format` + `npx prisma validate` — clean.
- [ ] `npx prisma migrate dev` — generated SQL is **purely additive**: `CREATE TYPE` ×3, `ALTER TABLE ADD COLUMN` ×10 (all nullable, no default backfill), `ADD CONSTRAINT` for the FK, `CREATE INDEX` ×3. **No `ALTER COLUMN`, no `SET NOT NULL`, no `DROP`, no data migration.** Review the SQL by eye against this list.
- [ ] `npx prisma generate` — client regenerates; new optional fields appear.
- [ ] `npx tsc --noEmit` — clean (no consumer references the new fields yet).
- [ ] `npm run lint` — clean.
- [ ] Confirm **no read path** references the new columns (grep) — P3 is schema-only.
- [ ] `EXPLAIN` the per-liability rollup query → uses `[financialAccountId, flowType, date]`.
- [ ] Migration is reversible: a scratch `migrate reset` + re-apply round-trips.
- [ ] KD-17 / KD-18 / AI-4 / P1 / P2 suites green, unchanged (additive-only guarantees this).
- [ ] (Phase C dry-run, later) backfill is idempotent: run twice on a snapshot → identical rows; UNKNOWN/null rate matches the P2 `FLOWTYPE_SHADOW=count` distribution.

---

## 10. Risks (investigation #10)

- **Index write-amplification.** 3 new indexes on the highest-write table. *Mitigation:* the set is minimal and query-justified; `flowType`/`flowDirection` are low-width enums; monitor sync latency after Phase A; the composite `[financialAccountId, flowType, date]` replaces what would otherwise be 2–3 narrower indexes.
- **Enum churn.** Adding a `FlowType`/`FlowClassificationReason` value later. *Mitigation:* Postgres enum value additions are additive DDL; start with the P1-proven set. `pfc*` kept as `String` precisely to avoid coupling to Plaid's taxonomy churn.
- **Backfill misclassification.** Coarse historical rows. *Mitigation:* deterministic + re-runnable + `classifierVersion`-gated; `ADJUSTMENT`/`UNKNOWN` absorb ambiguity; nothing invented.
- **`Float` money (pre-existing, STATUS §6).** `flowDirection = INTERNAL` lets cash-flow exclude transfers structurally instead of relying on sign cancellation — this design *reduces* exposure rather than adding to it. MC1 remains orthogonal (no currency column proposed).
- **`counterpartyAccountId` FK semantics.** `onDelete: SetNull` means deleting an account nulls the pointer on the *other* account's transactions (correct — the fact "paid an account that no longer exists" degrades gracefully). Soft-deleted accounts (the common case) keep the pointer.
- **PII surface.** `pfc*` are taxonomy strings; `merchantEntityId` is an opaque id; `counterpartyAccountId` is an internal FK. None carry names/numbers (the sensitive counterparty sub-fields were deny-listed in P2 and are not proposed for storage). The new columns remain behind the FULL-only `TRANSACTION_DETAIL_VISIBILITY` gate when reads eventually consume them; `counterpartyAccountId` must be redaction-checked in Phase D so a shared Space can't learn about an account it can't see.
- **Premature NOT NULL.** *Mitigation:* explicitly deferred to a separate later migration; P3 ships everything nullable.

---

## 11. Does anything proposed today block a future capability?

Explicit evaluation — the answer is **no** in every case, and several are actively *enabled*:

| Future capability | Blocked? | Why |
|---|---|---|
| **Merchant entities** | No — enabled | `merchantEntityId` is the seed; a `Merchant` table + `merchantId` FK are additive later, backfillable from distinct `merchantEntityId` without a Plaid re-fetch. Merchant *attributes* are deliberately kept off `Transaction`. |
| **Double-entry** | No | `flowType`/`flowDirection`/`counterpartyAccountId` are compatible with a future entry/ledger table; nothing here assumes single-entry beyond what already exists. |
| **Internal transfer pairing** | No | A nullable `transferGroupId` (reserved, not added) is additive whenever pairing lands; `counterpartyAccountId` already records the paired account, seeding it. |
| **Debt attribution** | No — enabled | Destination-side per-liability rollup works from `[financialAccountId, flowType]` today; `counterpartyAccountId` adds the source side. This is the KD-18 capability, structurally supported. |
| **Investment lots** | No | A future `Lot`/`Position` table references `Holding`/`Transaction`; `flowType = INVESTMENT` is an umbrella, lot detail is a separate table. No conflict. |
| **Tax reporting** | No — enabled | `INTEREST`, `FEE`, `REFUND`, and dividend-as-`INCOME` become directly selectable; realized-gain reporting needs lots (separate table), which this does not block. |

The one guardrail that keeps all six open: **`Transaction` gains only per-row financial facts and reference keys — never denormalized entity attributes.** Merchant identity, lot detail, ledger entries, and currency normalization each get their own additive table/columns when their initiative arrives.

---

## 12. Deliverable summary

- **Complete schema proposal:** §2 (10 columns, 3 enums, 1 relation, 3 indexes) with per-field rationale (§2.2).
- **Migration plan:** §7 phases A–D, additive-first, backfill as a separate `scripts/` job (§6), naming per existing convention.
- **Rationale for every field:** §2.2, plus the `String`-vs-enum and `Int`-version justifications.
- **Forward compatibility:** §3 (Merchant), §11 (six capabilities), §5 (MC1 orthogonality).
- **Backfill:** §6 deterministic / partial / impossible, "do not invent" enforced.
- **Rollback / validation / risks:** §8 / §9 / §10.

No implementation performed. Stop after investigation.
