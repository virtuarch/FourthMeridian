> **INVESTIGATION ONLY — no code, no schema, no migration, no STATUS.md change was made to produce this document.** Nothing here is authorized to build. For current project state see `STATUS.md`.

# MI2 S2 — Merchant Merge Review Queue (Investigation)

**Date:** 2026-07-08
**Branch:** feature/v2.5-spaces-completion
**Question:** What is the *smallest durable* architecture that lets a human review merchant-merge candidates and execute them — where the queue owns **decisions** and `mergeMerchants(...)` remains the **only** execution path?
**Baselines (binding):**
- `MI2_S1_MERCHANT_MERGE_CORE_CLI_INVESTIGATION_2026-07-08.md` + the shipped engine `lib/transactions/merchant-merge.ts` — the single sanctioned execution path (`mergeMerchants(client, {survivorId, duplicateIds, evidence?, dryRun?})`, dry-run default, structured `MergeReport`, atomic, id-in/report-out).
- `MI1_MERGE_SUGGESTIONS_REVIEW_QUEUE_INVESTIGATION_2026-07-07.md` §4–§9 — the tiered evidence model, the deny-list, and the "persist decisions, recompute suggestions" posture. This document **refines** that sketch with one fact it predated.

**The one fact that reshapes the design:** `Merchant` and `MerchantAlias` carry **no `userId`/`spaceId`** — they are a **global, shared dictionary** (verified: `canonicalKey @unique`, `plaidEntityId @unique`, `aliasKey @unique`, no tenant column). A merge therefore mutates identity **for every tenant at once**. The MI1 sketch framed the queue as a per-user "trust feature"; that was wrong. **A merge is a global operation, so its review queue is an operator surface (SYSTEM_ADMIN), not a per-user product surface.** Everything below follows from this.

---

## 1. Executive summary (be opinionated)

Build the smallest thing that is durable: **one small table, two endpoints, one admin page, one pure detector.**

1. **Persist decisions, never suggestions.** Suggestions are deterministically recomputable from data that already exists; persisting them only buys staleness. The one thing that is *not* recomputable is a human's judgment, so exactly two verdicts are persisted in **one** table, `MerchantMergeDecision`: **DISMISSED** (suppresses a pair from ever re-surfacing) and **MERGED** (the evidence-tagged audit trail). Keys are stored as **canonicalKey strings, not FKs**, because a merge **deletes** the duplicate `Merchant` row — an FK would dangle.
2. **Tiny lifecycle, no async.** `Detected → Pending → (Merged | Dismissed)`. There is deliberately **no separate "Accepted" state**: acceptance *is* the synchronous `mergeMerchants(...)` call inside the request, so "Accepted" and "Merged" are the same instant. "Later" is simply "write nothing" (it reappears).
3. **Detection is a pure function, computed on demand.** `lib/transactions/merchant-merge-suggest.ts` — zero I/O, injected data, deny-list first, categorical tiers. It runs when the admin page loads (merchant cardinality is small), filtering out pairs already in `MerchantMergeDecision`. No background job now; the OPS-4 registry is its home *if* cardinality ever demands it.
4. **Execution is unchanged.** Accept resolves `(survivorId, duplicateIds)` and calls the S1 engine — no duplicated merge logic, no alternate path. Reject writes one `MerchantMergeDecision` row and **touches no merchant record**.
5. **Home: the admin panel (SYSTEM_ADMIN), MI owns the logic.** Because a merge is global, the surface lives at `app/admin/merchants` behind the existing SYSTEM_ADMIN middleware gate — beside Audit Log, the nearest analog. It is **not** PO1 (PO1 is structurally forbidden from reading product content; the queue must read merchant names/samples) and **not** a per-tenant product feature.

Manual pair entry works from day one (covers "manual merge review"); automated suggestions and AI proposals feed the *same* queue and the *same* accept path later, with **zero engine change**.

---

## 2. What data must be persisted? (Objective 1)

**Recommendation: one table, `MerchantMergeDecision`, storing human verdicts only. Do not persist suggestions.**

| Candidate | Verdict | Decision |
|---|---|---|
| `MerchantMergeSuggestion` (persist detected pairs) | ❌ Reject | Deterministically recomputable; merchant cardinality is small (hundreds–low thousands). Persisting introduces a staleness/GC problem (a suggested duplicate that gets merged or renamed leaves a dead row) and a background writer, for no gain. |
| `MerchantMergeDecision` (persist verdicts) | ✅ Adopt | A human's "not the same" (DISMISSED) and "these were merged" (MERGED) are **not** derivable from data. Dismissals must persist or every detection run re-surfaces rejected pairs (noise). Merged rows are the audit trail. |
| No persistence at all | ❌ Reject | Without persisted dismissals the queue is unusable — the same rejected pair nags forever. This single requirement is what forces (a small amount of) schema. |

**Why not lean on `AuditLog` instead of a new table?** `AuditLog` is an append-only *history* keyed by `(userId, action, createdAt)`; it is the wrong shape for the queue's *functional* need — "is this pair already decided?" — which must be an indexed lookup by an order-independent pair key. Filtering live detection by scanning audit history would be awkward and slow. So the functional record lives in `MerchantMergeDecision`; a coarse `AuditLog` entry (`action: "MERCHANT_MERGE"`) can *also* be written on accept for the security-audit audience, pointing at the decision row. (Smaller alternative considered: persist *only* dismissals and route acceptances to `AuditLog`. Rejected as the primary design because it splits the merge story across two stores — "show merge history for this merchant" becomes a cross-store query — for a saving of a few columns. One table is cleaner and barely larger.)

---

## 3. Lifecycle (Objective 2) — intentionally tiny

```
        (deterministic detector, ephemeral)
   ┌───────────────┐        ┌───────────────┐
   │   Detected    │───────▶│    Pending    │   Pending = Detected − alreadyDecided
   └───────────────┘        └───────┬───────┘   (no row exists yet for these states)
                                     │
                 human decides (synchronous, in-request)
                     ┌───────────────┴───────────────┐
                     ▼                                ▼
          ┌────────────────────┐          ┌────────────────────┐
          │       MERGED       │          │      DISMISSED     │
          │ mergeMerchants(...) │          │  no merchant write │
          │ + Decision row      │          │  + Decision row    │
          └────────────────────┘          └────────────────────┘
                 (terminal)                      (terminal)
        "Later"  = write nothing → the pair re-appears next load (no state)
```

Only two states are ever **persisted** (the terminal verdicts). `Detected` and `Pending` are computed views, never rows.

**Why no `Accepted` state between Pending and Merged?** There is no async approval gap: the reviewer clicks *Merge*, the request calls `mergeMerchants(...)` synchronously, and on success writes the `MERGED` row. An intermediate `Accepted` state would only be needed for a staged/queued executor, which does not exist and is explicitly out of scope ("not an enterprise workflow"). Adding it would be speculative. Likewise there is **no `Reopen`/`Undo`** (the engine has no un-merge; ratified). Keeping the lifecycle at two terminal states is the smallest thing that works.

---

## 4. Detection (Objective 3) — architecture only

**Shape: a pure detector, evidence regenerated (not persisted), snapshotted only into decisions.**

`lib/transactions/merchant-merge-suggest.ts` — zero I/O, injected merchant/alias/entity-id data (the house resolver/backfill purity pattern), deny-list applied **first**, returns candidate pairs with a categorical tier. It is called on demand by the admin surface's loader, which supplies the (small) merchant set and filters out pairs already present in `MerchantMergeDecision`.

**Evidence is represented as a small typed value, computed per pair:**

```
type MergeEvidenceTier = "T1" | "T2" | "T3";
type MergeEvidenceSignal =
  | "PLAID_ENTITY"          // strongest: a transaction's merchantEntityId equals another merchant's plaidEntityId
  | "CANONICAL_CONTAINMENT" // one canonicalKey is a ≥2-leading-token prefix of another (the WGU class)
  | "ALIAS_TOKEN"           // a raw alias sample contains the other merchant's full canonical key as a token
  | "MANUAL"                // an operator typed the pair — no automated signal
  | "AI";                   // future: an AI proposal (still human-confirmed; never writes)
interface MergeCandidate {
  survivorKeyGuess: string; absorbedKey: string;
  tier: MergeEvidenceTier; signal: MergeEvidenceSignal;
  explanation: string;       // one human sentence
  deniedReason?: string;     // set = never shown (deny-list hit)
}
```

**Persisted or regenerated?** Regenerated for live/pending suggestions (deterministic, cheap, never stale). **Snapshotted** (tier + signal) into the `MerchantMergeDecision` row at decision time — because after a merge deletes the duplicate, the evidence can no longer be recomputed, and the snapshot is both the audit reason and the future promotion signal ("many operators confirmed the same pair" → global-catalog evidence).

**Signals, ordered by strength (all queryable today):** provider entity-id contradiction (T1, near-zero false positives) → canonical-key containment (T2, the WGU truncation class) → alias-sample token evidence (T2/T3) → lexical similarity (T3, hidden by default) → shared enrichment domain (future, sparse today). The **deny-list runs before tiering** (person/P2P descriptors, parent-brand aggregators like `GOOGLE *`/`AMZN`, single-token keys like `SHELL`, city/state-distinct locals, marketplaces, rails) and is the detector's most important, most-tested feature. **Build first:** T1 + T2 (+ MANUAL always available). **Defer:** T3 lexical exposure, enrichment-domain, and AI.

**Manual and AI both feed the same queue:** a MANUAL candidate is an operator typing two keys; an AI candidate (future) is a proposal object of the identical `{survivorKeyGuess, absorbedKey}` shape. Neither writes anything — both terminate in the same human-confirmed accept path. This is exactly why the engine never needs to change (§8).

---

## 5. Review experience (Objective 4) — reads only, no merge logic

The review layer **only reads evidence and calls accept/dismiss**; it contains no merge logic. Minimum information per candidate pair, all obtainable from existing selects/counts:

- **Identity:** both `displayName` + `canonicalKey`; the **proposed survivor pre-selected** (least-truncated / longest canonical, or the provider-preferred one for T1). The operator can flip which side survives.
- **Confidence:** the categorical **tier** + the one-sentence `explanation` ("your bank identifies these as the same business"; "'WESTERN GOVERNORS UN' looks like a truncation of 'WESTERN GOVERNORS UNIVERSITY'").
- **Per merchant:** alias count **+ a few sample `aliasKey`s**, transaction count (`_count.transactions`), merchant-rule count **+ their categories** (so the reviewer sees if a rule fold will occur), and `plaidEntityId` presence.
- **Sample transactions for the duplicate:** ~3–5 rows (date, amount, raw `merchant` descriptor) — the concrete evidence a human needs to confirm "yes, same business." Read-only; never mutated here.
- **Optional dry-run preview:** because the engine already supports `dryRun`, the surface *may* call `mergeMerchants(db, {…, dryRun:true})` to show exact projected counts before the operator commits. Nice-to-have, not required for the smallest build.

No badges, no notifications, no digests initially (deferred, per MI1 §7).

---

## 6. Execution (Objective 5) — confirmed single path

- **Accept** = resolve the chosen `survivorId` + `duplicateIds` (from the pair's canonicalKeys) → `await mergeMerchants(db, { survivorId, duplicateIds, evidence: { tier, signal, note }, dryRun: false })` → on success write the `MERGED` `MerchantMergeDecision` row (+ optional `AuditLog`). **No merge logic in the queue.** The engine's atomic `$transaction`, rule move/fold, alias re-point, and `plaidEntityId` transfer are reused verbatim.
- **Reject** = write one `MerchantMergeDecision` row with `verdict: DISMISSED`. It **must touch no merchant/alias/rule/transaction record** — this is an invariant to test explicitly (§10).
- There is **no alternate execution path** and no second place that mutates merchant identity. This is the whole point of S1.

---

## 7. Schema (Objective 6) — one small model, every field justified

A schema addition **is** justified, and only because persisted **dismissals** cannot be regenerated (§2). Recommend the **smallest** model — one table, one enum, pairwise rows.

```prisma
enum MerchantMergeVerdict {
  MERGED
  DISMISSED
}

/// A human verdict on ONE candidate merchant pair. Suggestions are never
/// persisted (recomputed on demand); only decisions are. Keys are canonicalKey
/// STRINGS, not FKs, because a merge DELETES the absorbed Merchant row — an FK
/// would dangle. One row per pair; a 3-way merge writes 2 rows sharing survivorKey.
model MerchantMergeDecision {
  id            String               @id @default(cuid())
  /// Order-independent pair key: the two canonicalKeys sorted + joined. THE
  /// dedupe/suppress key — makes "is this pair already decided?" an indexed
  /// lookup and blocks duplicate decisions. A dismissal is symmetric (direction
  /// doesn't matter), so the key must be order-independent.
  pairKey       String               @unique
  verdict       MerchantMergeVerdict
  /// The surviving merchant's canonicalKey (meaningful for MERGED; for DISMISSED
  /// it is simply one of the two, informational). Durable: the survivor persists.
  survivorKey   String
  /// The absorbed merchant's canonicalKey. Durable record of WHAT was merged even
  /// after that Merchant row is deleted (no FK possible).
  absorbedKey   String
  /// Evidence snapshot — WHY the decision was made. Regenerated evidence is
  /// unavailable post-merge; this is the audit reason + future promotion signal.
  evidenceTier   String
  evidenceSignal String?
  /// The SYSTEM_ADMIN who decided. Nullable + SetNull to survive user deletion
  /// (mirrors AuditLog.userId posture). Accountability only.
  decidedByUserId String?
  createdAt       DateTime            @default(now())

  @@index([verdict, createdAt])
}
```

**Why each field exists** is inline above. **Deliberately excluded (anti-speculation):** no `status`/state timestamps (no async lifecycle — §3); no numeric confidence (tier is categorical); no `assignee`/`notes`/`comments`/`reopenedAt` (not an enterprise workflow); no `mergeSummary Json` (the S1 `MergeReport` counts *could* be snapshotted for MERGED rows, but they are recoverable from the returned report at accept time and not needed for suppression — **defer** unless an audit requirement appears). No FK relations to `Merchant` (the absorbed row is deleted). This is one table and one enum — the minimum that makes dismissals durable.

**Migration note:** purely additive (new model + enum), no change to existing tables, no backfill. It does **not** touch the S1 engine or the MI-column tripwire (the dismiss route writes only this new table; the accept route calls the already-sanctioned engine — see §10).

---

## 8. Ownership & where it belongs (Objective 7)

**Merchant Intelligence owns the logic; the Admin panel hosts the surface (SYSTEM_ADMIN); it is not PO1 and not a per-tenant product feature.**

- **Not a per-user product surface.** `Merchant`/`MerchantAlias` are global (the decisive fact). One user's merge changes every tenant's rollups, so the trigger cannot be an ordinary user. It belongs behind the existing SYSTEM_ADMIN gate (`app/admin/*`, enforced in middleware).
- **Not Platform Operations (PO1).** PO1's binding doctrine is that platform-operations capability is *structurally incapable of reading product content* (it reads metadata only — counts, statuses, timestamps). The review queue must read merchant **names, alias samples, and sample transaction descriptors** to let a human judge identity. That is product content, so it cannot live inside PO1. PO1's *only* legitimate interest here is coining a future identity-correction **event** from an accepted merge — which the `MerchantMergeDecision` row + optional `AuditLog` entry already provide without waiting on PO1.
- **Home:** logic in `lib/transactions/` (beside the engine, resolver, corrections); surface at **`app/admin/merchants`** (a new Admin nav item beside "Audit Log", the nearest analog — a filterable review list). "Operations Dashboard" is the wrong host (it is user/product-facing); a standalone product page is the wrong host (global mutation by non-admins).

---

## 9. Future compatibility (Objective 8) — no engine change, ever

The engine's id-in/report-out boundary makes every future consumer a *producer of `{survivorId, duplicateIds}`* that terminates in the same accept path:

- **Manual merge review** — MANUAL evidence; operator types the pair. Works day one.
- **Future automated suggestions** — the pure detector emits candidates into the same queue; acceptance is unchanged.
- **Future admin tooling** — reuses the accept/dismiss endpoints and the decision table; no new execution path.
- **Future Platform Operations** — consumes the `MerchantMergeDecision` / `AuditLog` records as events; never executes merges itself.
- **Future AI-assisted suggestions** — AI produces the *same proposal shape* and feeds the *same human-confirmed queue*; **AI never writes** (writes happen only through a human-accepted `mergeMerchants` call). This satisfies the "no AI-generated writes" principle structurally.

None of these require touching `lib/transactions/merchant-merge.ts`.

---

## 10. Validation plan (Objective 9)

- **Pure detector unit tests** (`merchant-merge-suggest.test.ts`, injected data, no DB): deny-list is exhaustively tested (person/P2P, parent-brand, single-token, city/state locals, marketplaces, rails — each must NOT be suggested at any tier); tier assignment (T1 entity-id, T2 containment ≥2 tokens); determinism (identical input → identical output); a denied pair is never returned.
- **Suppression test:** a pair present in `MerchantMergeDecision` (either verdict) is filtered out of the detector's live output — dismissed pairs never re-surface; merged pairs can't (duplicate is gone) but are filtered defensively.
- **Accept-path test:** the accept handler calls `mergeMerchants` **exactly once** with the operator's `{survivorId, duplicateIds}` and writes **one** `MERGED` decision row; on engine failure it writes **no** decision row (atomic with the merge's own rollback).
- **Reject invariant test (critical):** the dismiss handler writes exactly one `DISMISSED` row and performs **zero** writes to `Merchant`/`MerchantAlias`/`MerchantRule`/`Transaction`. Assert via an in-memory fake client that no merchant-table mutation method is called.
- **Schema-tripwire check:** confirm `lib/transactions/merchant-schema.test.ts` still passes unchanged — the dismiss route writes only the new `MerchantMergeDecision` table (outside the MI-column/MerchantRule guards), and the accept route calls the already-allowlisted engine rather than stamping MI columns itself. If the accept route is placed under `app/` and directly references `merchantId:` in a select, confirm it is a READ (the tripwire already distinguishes read surfaces).
- **Engine-unchanged proof:** `git diff --stat HEAD -- lib/transactions/merchant-merge.ts` is empty at the end of S2.
- **Standard gates:** `tsc --noEmit` clean, `eslint` clean, full `npm run test:unit` green, no `STATUS.md` change until close-out.
- **Manual QA:** on `app/admin/merchants`, confirm a seeded WGU-style split shows as a T2 candidate with correct counts; Merge collapses it (verification counts → 0); Dismiss suppresses it on reload; Later re-shows it.

---

## 11. Deliverables summary

**Recommended architecture:** one decision table + a pure detector + two admin endpoints + one admin page; execution delegated wholly to the S1 engine.

**Recommended schema:** `MerchantMergeDecision` (one model) + `MerchantMergeVerdict` (one enum), additive, no backfill (§7).

**Ownership boundaries:** detection & decision logic → `lib/transactions/` (MI); surface → `app/admin/merchants` (SYSTEM_ADMIN); execution → `lib/transactions/merchant-merge.ts` (unchanged); **not** PO1, **not** per-tenant product.

**Proposed file list (for the eventual build — not authorized here):**
- `lib/transactions/merchant-merge-suggest.ts` — pure detector (deny-list + tiers).
- `lib/transactions/merchant-merge-suggest.test.ts` — detector + deny-list tests.
- `lib/transactions/merchant-merge-decisions.ts` — thin read/write helpers for the decision table + pair-key derivation + live-suggestion filtering (client injected; testable).
- `lib/transactions/merchant-merge-decisions.test.ts` — suppression + reject-invariant tests.
- `app/api/admin/merchants/merge/route.ts` — accept: calls `mergeMerchants`, writes MERGED decision (+ AuditLog).
- `app/api/admin/merchants/dismiss/route.ts` — reject: writes DISMISSED decision only.
- `app/admin/merchants/page.tsx` (+ a small client component) — the review list.
- `prisma/schema.prisma` — additive `MerchantMergeDecision` + `MerchantMergeVerdict` (the only schema change).
- Admin nav: add a "Merchants" entry.

**Implementation sequence:**
1. Add the schema model + enum; migrate (additive only).
2. Build the decision helpers (`pairKey` derivation, record verdict, filter live suggestions) + tests.
3. Build the pure detector with T1 + T2 signals and the full deny-list + tests.
4. Build the accept endpoint (delegates to the engine) + the dismiss endpoint (decision-only) + tests, including the reject invariant.
5. Build the minimal admin page (list, evidence, Merge / Dismiss / Later) + nav entry.
6. Manual QA on a seeded split; then STATUS.md close-out.

**Risks:**
- **Global-mutation blast radius** — a wrong merge affects all tenants and cannot be un-merged. *Mitigation:* SYSTEM_ADMIN-only; dry-run preview available; conservative survivor pre-selection; deny-list is the most-tested code; raw descriptors preserved so a reverse merge is possible.
- **Deny-list gaps** — a bad suggestion (parent-brand, P2P) reaching a tired operator. *Mitigation:* deny-list before tiering, heavily tested; T3 hidden by default; T1/T2 only at launch.
- **Pair-key correctness** — an order-dependent key would let a dismissed pair re-appear reversed. *Mitigation:* order-independent sorted key + unique constraint + test.
- **Scope creep** — pressure to add Accepted state, assignees, notes, notifications, AI. *Mitigation:* explicitly deferred here; lifecycle frozen at two terminal states.
- **Detector cost at scale** — on-demand recompute could slow the page if merchant cardinality grows. *Mitigation:* it's O(n log n) on a small set today; the OPS-4 registry is a ~20-line job registration if/when proven necessary — not built now.

**Validation plan:** §10.

---

## 12. Stop point

This is the investigation deliverable. No code, no schema, no migration, no `STATUS.md` change. Recommended next action for a human: ratify this scope (especially the SYSTEM_ADMIN ownership call and the single-table schema), then implement §11's sequence. The engine stays frozen; the queue owns decisions; every merge remains a human pressing *Merge* through the one sanctioned path.
