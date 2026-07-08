> **INVESTIGATION ONLY — no code, no schema, no migration, no STATUS.md change was made to produce this document.** Nothing here is authorized to build. For current project state see `STATUS.md`.

# MI2 S1 — Merchant Merge Core & CLI (Investigation)

**Date:** 2026-07-08
**Branch:** feature/v2.5-spaces-completion
**Question:** What is the *smallest* reusable infrastructure that converts the one-off `scripts/merge-wgu-merchants.ts` into a sanctioned, contract-enforcing merge engine plus a thin CLI — with zero schema, zero UI, zero auto-merge, zero AI?
**Doctrine baseline (binding):**
- `MI1_MERGE_SUGGESTIONS_REVIEW_QUEUE_INVESTIGATION_2026-07-07.md` §8–§10 — already names this slice as **MI2 S1 (merge core + sanctioned CLI, no schema)** and specifies the extraction target `lib/transactions/merchant-merge.ts` + generalized `scripts/merge-merchants.ts`.
- Merchant identity semantics: identity columns only; no fuzzy auto-merge; never rewrite raw `Transaction.merchant`, `category`, `categorySource`, `flowType`, or `pfc*`.

**Bottom line:** The WGU script already *is* the correct merge contract. This slice extracts its atomic body into a pure-of-CLI library, parameterizes the survivor/duplicate selection, and re-packages the script as a thin adapter. **No schema is required. No auto-merge is introduced. Confirmed.**

---

## 1. Current implementation — what exists and what is reusable

### 1.1 The merge itself (the thing to extract)

`scripts/merge-wgu-merchants.ts` (195 lines) is the sole merge implementation. Its `db.$transaction` body (lines 104–172) is the entire merge algorithm and is already written to the ratified contract. Per duplicate merchant it:

1. **Re-points aliases** — `merchantAlias.updateMany({ merchantId: dup → survivor, source: USER })`.
2. **Re-points historical transactions** — `transaction.updateMany({ merchantId: dup → survivor })`, **identity column only** (nothing else on the row changes).
3. **Moves or folds rules** — for each `MerchantRule` on the dup: if the survivor already has a rule for the same `(scope, ownerUserId)`, re-point that rule's transactions (`categoryRuleId`) to the survivor's rule and delete the dup rule; otherwise move the rule to the survivor. Provenance links are re-pointed *before* any delete (no `SetNull` orphaning).
4. **Transfers `plaidEntityId`** to the survivor only if the survivor has none (unique column); otherwise drops the dup's id and notes it.
5. **Deletes** the now-empty duplicate merchant.

Post-transaction it prints verification counts (duplicate merchants remaining, transactions still on old ids, survivor alias count). It is atomic, idempotent (a re-run finds no duplicates), and dry-run-by-default (`--apply` required).

**What is WGU-specific (the only WGU-specific code in the file):**
- `SURVIVOR_RAW = "Western Governors University"` and the three hardcoded `DUPLICATE_RAWS` (lines 45–50).
- The survivor/duplicate *resolution* strategy (lines 57–82): normalize hardcoded raw descriptors → canonicalKeys → `findUnique`/`findMany`.

**What is fully reusable (everything else):** the entire `$transaction` body, the verification block, the dry-run gating, the `db`/`normalizeMerchantIdentity` wiring, and the console reporting shape.

### 1.2 Supporting merchant infrastructure (reused, not modified)

| Module | Role | Reuse posture |
|---|---|---|
| `lib/transactions/merchant.ts` | Pure normalizer (`normalizeMerchant`) — canonicalKey/canonicalName, conservative bias, no I/O | Unchanged; the identity source of truth. |
| `lib/transactions/merchant-resolver.ts` | `normalizeMerchantIdentity(raw)` → `{canonicalKey, displayName}` (wraps the normalizer + web-TLD strip) | The engine/CLI resolve keys through this — no hand-typed keys, matching the script. |
| `lib/transactions/merchant-corrections.ts` | M5 correction path; `pointAlias` = the *only* sanctioned alias re-point (`source: USER`) | The merge's alias semantics mirror this exactly; reference, not dependency. |
| `lib/transactions/merchant-write.ts` | M4 mint/reuse + alias upsert (sync/import/backfill share it) | Not called by the merge (merge re-points, never mints); it is the *forward* half the merge complements. |
| `lib/transactions/merchant-backfill.ts` | M3 pure planner | Precedent for the "pure decision, injected facts" style the engine should follow. |
| `lib/db.ts` | Prisma singleton (`db`) | The CLI passes `db`; the engine takes an injected client. |

**Schema (`prisma/schema.prisma`), unchanged, relevant models:** `Merchant` (`canonicalKey @unique`, `plaidEntityId @unique`), `MerchantAlias` (`aliasKey @unique`, `source`, `onDelete: Cascade`), `MerchantRule` (`merchantId`, `scope`, `ownerUserId`, `onDelete: Cascade`), `Transaction` (`merchantId` → `onDelete: SetNull`, `categoryRuleId` → `onDelete: SetNull`). These relations are exactly what the WGU script already exploits; nothing new is needed.

### 1.3 There is no `lib/merchant/` directory

All merchant code lives under `lib/transactions/`. Per §2 below and the MI1 baseline, the engine belongs at **`lib/transactions/merchant-merge.ts`** (not `lib/merchant/merge.ts`) — it preserves the existing directory convention and sits beside the resolver/write/corrections modules it is a peer to.

---

## 2. Extractable merge engine — the smallest reusable library

**File:** `lib/transactions/merchant-merge.ts` — contains the merge algorithm and **zero CLI logic** (no `process.argv`, no `console.log`, no `process.exit`, no `db` import; the client is injected). This mirrors `merchant-write.ts`, which is client-injected and shared by three callers.

### 2.1 Inputs

The engine works on **already-resolved merchant ids** (resolution — raw descriptor / canonicalKey → id — is the caller's job, so the engine is identical whether the caller is a CLI or a future endpoint):

```
mergeMerchants(
  client: Prisma.TransactionClient,      // db OR a $transaction tx — both satisfy the type
  input: {
    survivorId: string,
    duplicateIds: string[],              // never includes survivorId (caller-validated)
    evidence?: MergeEvidence,            // opaque provenance tag: which tier/signal justified it
    dryRun?: boolean,                    // default true
  }
): Promise<MergeReport>
```

Rationale for **ids, not raw descriptors:** the WGU script's descriptor→key→id step is WGU packaging. A reusable engine must not embed a resolution strategy — the CLI resolves flags to ids, a future accept-endpoint already has ids from the suggestion. `evidence` is accepted and echoed into the report now (so callers can log it), but **persisting** it is an MI2 S2 concern (the decisions table) and out of scope here.

### 2.2 Outputs (structured report — no printing)

```
MergeReport {
  applied: boolean,                      // false on dry-run
  survivor: { id, canonicalKey, displayName },
  perDuplicate: Array<{
    id, canonicalKey, displayName,
    aliasesRepointed: number,
    transactionsRepointed: number,
    rulesMoved: number,
    rulesFolded: number,
    plaidEntityTransferred: boolean,
    plaidEntityDropped: string | null,   // dup entityId discarded because survivor had one
    deleted: boolean,
  }>,
  verification: {                        // the WGU script's post-merge counts, as data
    duplicateMerchantsRemaining: number, // want 0
    transactionsOnOldIds: number,        // want 0
    survivorAliasCount: number,
  },
  notes: string[],                       // e.g. "no merchant row for key=… — skipped"
}
```

On dry-run the engine performs the same **reads** the script does (find survivor, find duplicates with alias/rule/transaction counts) and returns a report with `applied: false` and the *projected* counts, executing no writes.

### 2.3 Merge operations (unchanged from the ratified contract)

Alias re-point (`source: USER`) → transaction `merchantId` re-point (identity column only) → rule move-or-fold (provenance re-pointed before delete) → `plaidEntityId` transfer-if-empty → duplicate delete. Wrapped in a single `$transaction` **only when the caller passes a plain client**; when the caller already passes a `tx`, the engine runs inline (composability — a future endpoint may merge inside a larger transaction). Recommended shape: the engine exposes a pure-ish `applyMergeWithin(tx, …)` and a `mergeMerchants(client, …)` wrapper that opens the transaction — identical to how corrections/write modules accept `Prisma.TransactionClient`.

### 2.4 Dry-run support

Dry-run is an **engine-level** capability (`input.dryRun`, default `true`), not merely a CLI flag — so every caller (CLI now, endpoint later) inherits preview-before-write for free. Dry-run reads and projects; it never opens a write transaction.

### 2.5 Reporting

The engine **returns** the report; it never prints. The CLI formats the report into the console lines the WGU script emits today. This is the single change that makes the logic reusable by a non-console caller.

### 2.6 Rollback characteristics

- **Atomicity:** all writes for all duplicates occur in one `$transaction` — a failure rolls the whole merge back; no half-merged state.
- **No native un-merge** (out of scope by doctrine). Recovery is forward-only.
- **Idempotency = the practical safety net:** because the selection is by duplicate id and the operation deletes the duplicate, a re-run finds nothing to do. Alias memory strictly grows; the survivor is never destroyed.
- **Reconstruction cost if a wrong merge is applied:** raw `Transaction.merchant` descriptors are never altered, so a mistaken merge can be reversed by a subsequent explicit correction/merge in the other direction (re-mint the survivor-that-should-have-been and re-point) — manual, but the data to do it is fully preserved.

---

## 3. CLI — the smallest thin adapter

**File:** `scripts/merge-merchants.ts` — a thin adapter that (a) parses flags, (b) resolves flags to merchant ids via `normalizeMerchantIdentity` + a lookup, (c) calls `mergeMerchants(db, …)`, (d) formats the returned report, (e) `db.$disconnect()`. All merge logic lives in the engine.

**API / flags (house pattern from `backfill-merchant-intelligence.ts`):**

```
npx tsx scripts/merge-merchants.ts \
  --survivor=<canonicalKey|merchantId> \
  --absorb=<canonicalKey|merchantId> [--absorb=… …]     # or comma-separated
  [--apply]        # WRITE; omitted → dry run (default)
  [--json]         # emit the MergeReport as JSON instead of human lines
```

Requirements satisfied:
- **Dry-run default** — no `--apply` ⇒ read-only projection (engine `dryRun` defaults true; CLI flips it only on `--apply`).
- **Explicit `--apply`** — the only thing that authorizes writes.
- **Structured summary** — prints the per-duplicate counts + verification block; `--json` emits the raw `MergeReport` for scripting/CI capture.
- **No interactive prompts** — survivor and duplicates are fully specified by flags; the CLI never asks a question (matches the non-interactive backfill scripts).
- **Reusable for future merge jobs** — any future split cluster is a flag invocation, not a new script. This retires the "next WGU needs another custom script" failure mode.

**Disposition of `scripts/merge-wgu-merchants.ts`:** it becomes redundant. Options (decide at build time, not now): (a) delete it, (b) keep it as a documented historical record, or (c) reduce it to a one-line wrapper that calls the generalized CLI with the WGU flags. Recommended: **(b) leave untouched** — it is already applied/idempotent and serves as a worked example; no reason to churn it in an additive slice. **npm script:** optionally add `"merge:merchants": "tsx scripts/merge-merchants.ts"` alongside the existing `backfill:*` entries (additive, non-essential).

---

## 4. Future compatibility — confirmed without changing the engine

The MI1 baseline already designed toward this; the id-in / report-out boundary is exactly what each future consumer needs:

- **MI2 Review Queue / accept-endpoint** — the pure detector (`merchant-merge-suggest.ts`, S2) yields `{survivorId, duplicateIds, tier, evidence}`; the accept-endpoint calls the **same** `mergeMerchants(client, …)` with `evidence`. One contract, two callers — the M4/M5 single-sourcing pattern. No engine change.
- **Future admin tooling** — an admin surface calls the same engine (or shells the CLI); the structured `MergeReport` is display-ready. No engine change.
- **Future Platform Operations** — the engine's `evidence` tag and returned counts are the raw material for PO1 identity-correction events; PO1 wraps the engine, it does not modify it. (Persisting the decision/event is S2+/PO1, not S1.)
- **Merge suggestions** — suggestions only ever *propose* `(survivorId, duplicateIds)`; execution is unchanged. Detection is deliberately never wired into sync/import/AI.

The seam that makes all four free: **the engine takes ids and returns data, holding no CLI, no printing, no resolution strategy, and no persistence of decisions.**

---

## 5. Persistence — schema decision

**No schema is required for MI2 S1. Confirmed.**

The merge operates entirely on existing columns and relations (`Merchant`, `MerchantAlias`, `MerchantRule`, `Transaction.merchantId`/`categoryRuleId`/`plaidEntityId`). The WGU script already proves this against the live schema with zero migrations. The `MerchantMergeDecision` table (dismissals + audit) named in the MI1 baseline belongs to **MI2 S2**, gated on the detector/queue existing to write it — S1 neither needs nor should introduce it. Per the implementation principles: schema was not proven necessary, so none is proposed. **If a future slice proves a decisions table is needed, stop and propose it there.**

---

## 6. Auto-merge — confirmed NO automatic merges

This architecture performs **no automatic merges**. Every merge is explicitly invoked:
- The engine writes only when a caller passes `dryRun: false` **and** supplies an explicit `survivorId` + `duplicateIds`.
- The CLI writes only under an explicit `--apply` with operator-supplied flags.
- Nothing wires the engine into sync, import, backfill, AI answering, or any scheduled job.
- No fuzzy matching, no ranking, no AI proposal path exists in this slice. Detection (S2) will *propose* but still require a human YES before the engine runs.

The only thing that changes merchant identity remains a human explicitly invoking the merge — exactly as the WGU merge already established.

---

## 7. Deliverables

### 7.1 Proposed architecture

A two-layer additive extraction, no schema, no UI:

```
          resolves flags → ids,           takes ids, returns report,
          formats report                  owns the $transaction body
   ┌─────────────────────────┐      ┌──────────────────────────────────┐
   │ scripts/merge-merchants  │────▶│ lib/transactions/merchant-merge   │
   │ (thin CLI adapter)       │ db  │ (pure-of-CLI engine)              │
   └─────────────────────────┘      └──────────────────────────────────┘
                                          │ reuses (unchanged)
                                          ▼
                normalizeMerchantIdentity · Merchant/Alias/Rule/Transaction schema
   (future) accept-endpoint / admin / PO1  ──▶ same mergeMerchants(client, …)
```

### 7.2 Proposed module boundaries

- **`lib/transactions/merchant-merge.ts`** — merge algorithm; client injected; dry-run; returns `MergeReport`; **no** `process.*`, **no** `console.*`, **no** `db` import, **no** flag parsing, **no** raw-descriptor resolution, **no** decision persistence.
- **`scripts/merge-merchants.ts`** — flags, resolution (key/id → id), calls engine with `db`, formats/prints report, disconnects; **no** merge logic.
- Everything else (`merchant.ts`, `merchant-resolver.ts`, `merchant-corrections.ts`, `merchant-write.ts`, schema) — **untouched**.

### 7.3 Reusable merge engine API (surface)

```
export type MergeEvidence = { tier?: string; signal?: string; note?: string };

export interface MergeInput {
  survivorId: string;
  duplicateIds: string[];
  evidence?: MergeEvidence;
  dryRun?: boolean;               // default true
}

export interface MergeReport { /* §2.2 */ }

// Opens a $transaction when given a plain client; runs inline when given a tx.
export function mergeMerchants(
  client: Prisma.TransactionClient,
  input: MergeInput,
): Promise<MergeReport>;
```

### 7.4 CLI API

```
scripts/merge-merchants.ts
  --survivor=<canonicalKey|id>          (required)
  --absorb=<canonicalKey|id> [...]      (required, ≥1; repeatable or comma-sep)
  --apply                               (optional; default = dry run)
  --json                                (optional; emit MergeReport as JSON)
```
No interactive prompts. Exit 0 on success, 1 on error (survivor not found, duplicate resolves to survivor, etc.).

### 7.5 File list

**New (2):**
- `lib/transactions/merchant-merge.ts` — the engine.
- `scripts/merge-merchants.ts` — the CLI adapter.

**New tests (2, house `*.test.ts` + tsx pattern, discovered by `scripts/run-tests.ts` under `lib/`):**
- `lib/transactions/merchant-merge.test.ts` — pure/injected-client unit tests (in-memory fake Prisma client, mirroring the corrections/backfill test style): alias re-point, transaction re-point, rule move vs. fold, entityId transfer-vs-drop, delete, dry-run writes nothing, idempotent re-run, atomic rollback on injected failure, "duplicate == survivor" guard.
- (Optional) a thin CLI arg-parsing test if the flag parser grows beyond trivial.

**Modified (0 required):** none. *(Optional, non-essential:* add `merge:merchants` to `package.json` scripts.*)*

**Explicitly NOT touched:** `prisma/schema.prisma`, `merge-wgu-merchants.ts`, any live write path, `STATUS.md`.

### 7.6 Implementation sequence

1. Extract the WGU `$transaction` body verbatim into `mergeMerchants(client, {survivorId, duplicateIds})`, converting each `console.log` into a `MergeReport` field; keep behavior byte-for-byte equivalent to the WGU path.
2. Add engine-level `dryRun` (default true): perform the reads + projection, skip the write transaction.
3. Add the `client`-vs-`tx` composability wrapper (open `$transaction` only for a plain client).
4. Write `merchant-merge.test.ts` against an in-memory fake client; prove every operation + dry-run + idempotency + rollback.
5. Build `scripts/merge-merchants.ts`: flag parse → resolve `--survivor`/`--absorb` (key or id) to ids via `normalizeMerchantIdentity` + `merchant.findUnique` → call engine → format report → disconnect.
6. Validation pass (§9): re-run the WGU flags through the new CLI in dry-run against a copy/preview DB and diff the projected counts against the historical WGU run; confirm idempotent 0-op.

Each step is independently reviewable; steps 1–4 ship the reusable core even if the CLI slips.

### 7.7 Risks

- **Behavioral drift during extraction** — the engine must reproduce the WGU semantics exactly (alias `source: USER`, identity-column-only re-point, rule fold-before-delete, entityId transfer-if-empty). *Mitigation:* extract verbatim; golden test asserting the same counts; diff against the historical WGU run.
- **`plaidEntityId` uniqueness** — transferring a dup's entityId when the survivor already has one would violate the unique constraint. The script's transfer-if-empty guard handles this; the engine must preserve it and record `plaidEntityDropped`. *Mitigation:* explicit test for the "survivor already has entityId" branch.
- **Rule fold correctness** — folding must re-point `categoryRuleId` on transactions *before* deleting the dup rule, or provenance `SetNull`s. *Mitigation:* preserve ordering; test the conflict branch.
- **Multi-duplicate atomicity** — merging N duplicates in one transaction is larger than the WGU 3-group case; a mid-batch failure must roll all back. *Mitigation:* single `$transaction`; test injected failure on the k-th duplicate leaves zero writes.
- **Wrong-survivor operator error (CLI)** — flags let an operator pick the wrong survivor; there is no un-merge. *Mitigation:* dry-run default + printed projection + explicit `--apply`; raw descriptors preserved so a reverse correction is possible.
- **CLI resolution ambiguity** — a `--survivor` key that matches no merchant, or an `--absorb` that resolves to the survivor. *Mitigation:* CLI validates and exits 1 with a clear message before calling the engine (mirrors the script's "Survivor not found. Aborting.").
- **Scope creep toward S2** — temptation to add detection/suggestion/decision-persistence. *Mitigation:* out of scope by this investigation and the MI1 baseline; engine takes ids only.

### 7.8 Validation plan

- **Unit (pure, no DB):** `lib/transactions/merchant-merge.test.ts` with an in-memory fake `Prisma.TransactionClient` — asserts alias re-point count + `source: USER`, transaction re-point count, rule move vs. fold (incl. `categoryRuleId` re-point before delete), entityId transfer vs. drop, duplicate deletion, `dryRun` performs no writes, idempotent re-run reports 0 ops, atomic rollback on injected failure at duplicate k, and the "absorb == survivor" / "survivor missing" guards. Runs under `npm run test:unit` (auto-discovered by `scripts/run-tests.ts`).
- **Equivalence check (offline, preview/copy DB):** run the WGU flags through the new CLI in **dry-run**; confirm the projected report matches the semantics of the historical WGU merge (and, since WGU is already applied, that it now reports **0 duplicates remaining** — proving idempotency and that the generalized path sees the same world).
- **Contract re-read:** diff the extracted engine body against `merge-wgu-merchants.ts` lines 104–185 to confirm operation-for-operation equivalence (no added or dropped step).
- **Static guards:** grep the engine for `process.`, `console.`, `argv`, and `@/lib/db` → must be zero (proves CLI-free). `npm run lint` + `prisma generate && tsx` type-check.
- **No-write proof:** run the CLI without `--apply` against a live-shaped DB and confirm zero row deltas (counts before == after).

---

## 8. Stop point

This is the investigation deliverable. No code was written, no files modified, `STATUS.md` untouched. Recommended next action for a human: ratify this scope, then implement §7.6 steps 1–6. Detection, decisions table, endpoint, and review surface remain **MI2 S2**, out of this slice.
