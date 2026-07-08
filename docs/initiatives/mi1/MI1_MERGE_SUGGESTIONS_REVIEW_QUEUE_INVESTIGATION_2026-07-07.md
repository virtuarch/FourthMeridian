> **INVESTIGATION ONLY — no code, no schema, no migration, no STATUS.md change was made to produce this document.** Nothing here is authorized to build. For current project state see `STATUS.md`.

# Merchant Intelligence — Merge Suggestions / Review Queue Investigation

**Date:** 2026-07-07
**Question:** What is the *smallest* architecture that lets users fix split merchants (the WGU case) through the product — detection without auto-merge, review without noise, execution through the sanctioned merge contract — so duplicate clusters never again require a custom script?
**Doctrine baseline (binding):** `MI1_MERCHANT_IDENTITY_SEMANTICS_INVESTIGATION_2026-07-07.md` — a Merchant is the consumer-recognizable counterparty brand; no fuzzy auto-merges; no parent-brand merges; no rewriting raw `Transaction.merchant`; no encoding products/services/fees into identity; merges are corrections, not detections.
**Verified in-tree:** M6 read cutover live (`lib/ai/assemblers/transactions.ts:545` groups by `id:${merchantId}` with `resolvedMerchant.displayName`); OPS-4 complete (dispatcher `lib/jobs/dispatch.ts`, typed registry, append-only `JobRun` ledger, job-health detector); M5 correction endpoint (`app/api/transactions/[id]/correct`); `scripts/merge-wgu-merchants.ts`; `Merchant`/`MerchantAlias`/`MerchantRule` schema incl. enrichment columns (`website`/`logoUrl`/`enrichmentSource`); admin surface is SYSTEM_ADMIN-only (`app/admin/`) — not a user home.

---

## 1. Executive summary (deliverable 1)

**Detect deterministically, persist only decisions, execute through one shared merge core.** The smallest architecture is three pieces, two of them mostly extractions of what already exists: (1) a **pure candidate-pair detector** (`suggestMerchantMerges`-style module, no I/O, injected data — the house resolver pattern) that pairs merchants using signals already in the database, tiered by evidence strength, with a hard deny-list for the never-suggest classes; (2) a **decisions-only store** — suggestions themselves are *recomputed on demand* (merchant cardinality is small; three indexed queries), and the only new persistence is the user's verdicts (dismissed pairs must never resurface; accepted pairs are the audit trail). No suggestion table, no staleness problem, no background write path; (3) the **merge core extracted from the WGU script** into a shared library executed by both the generalized CLI and a future accept-endpoint — one contract, two callers, exactly the M4/M5 single-sourcing pattern.

Detection is *never* wired into sync, import, or AI answering — read and write paths stay pure; the queue is a maintenance surface the user visits (or is quietly pointed to), and every merge remains a human YES. Tier-1 evidence (provider entity-id contradiction) is near-certain and still not auto-merged: the doctrine's value is that identity changes are always attributable to a person. This belongs to **MI as its own small slice** (suggested MI2 S1–S2), not PO1 (only the merge *audit events* belong to PO1's grammar) and not admin. Build now: the merge-core extraction + generalized sanctioned script (no schema, closes the "next WGU needs another custom script" gap immediately). Defer: the review UI until a merchants surface exists to host it. Avoid: auto-merge at any tier, LLM-proposed merges writing anything, suggestion computation on the write path.

---

## 2. Current MI capabilities relevant to merging (deliverable 2)

| Capability | State | Relevance |
|---|---|---|
| Exact-key identity resolution (`plaidEntityId` → `aliasKey` → `canonicalKey` → guarded mint) | Live (`merchant-write.ts` `lookupExisting`) | Prevents *new* splits when descriptors repeat exactly; cannot heal existing splits |
| USER alias re-point | Live — M5 `pointAlias` (the only sanctioned re-point) | The forward-looking half of a merge; touches one row + one alias |
| Historical unification | **Script-only** (`merge-wgu-merchants.ts`, WGU-hardcoded) | The gap this investigation addresses: correct contract, wrong packaging |
| Safe-merge contract | Ratified on paper (semantics investigation §5) | The accept-action's spec — already written, needs one implementation home |
| M6 reads | Assembler groups by `merchantId`, renders `displayName`, emits `rawMerchant` when it differs | Split merchants now *visibly* split every rollup — the product motivation |
| Enrichment columns (`website` etc.) | Schema live; capture via M4 passthrough | Future Tier-2 signal (shared domain) as data accumulates |
| OPS-4 dispatcher + JobRun ledger | Complete | An offline detection job has a home *if ever needed* (§9 argues it mostly isn't) |
| Correction confirm-gating (409 + candidates) | Live in M5 | The UX grammar to reuse: system proposes, human disposes |

What does **not** exist: any merchant list/browse surface, any suggestion persistence, any pair-similarity code, any un-merge.

## 3. Existing signals available today (deliverable 3)

Ordered by evidential strength; all but the last two are queryable right now.

1. **Provider entity-id contradiction (strongest).** Rows assigned to Merchant A whose `Transaction.merchantEntityId` equals Merchant B's `plaidEntityId` — the provider asserts one identity where MI holds two. Arises from mint-order races (canonicalKey mint before the entityId variant arrived). Deterministic join, near-zero false positives.
2. **Canonical-key truncation/containment.** One merchant's `canonicalKey` is a leading-token-prefix of another's (`WESTERN GOVERNORS UN` ⊂ `WESTERN GOVERNORS UNIVERSITY`), minimum two shared leading tokens. Catches provider truncation — the WGU class.
3. **Alias-sample token evidence.** A raw alias `sample` on merchant A contains the full canonical key of merchant B as a token substring (`NBS-WGU*SERVICE FEE` contains `WGU`); catches rail-wrapped variants the normalizer conservatively refused to strip.
4. **Shared enrichment domain.** Same `website` registrable domain on two merchants — strong brand signal once M4 passthrough populates it; today sparse.
5. **`displayName` lexical similarity** (token overlap / edit distance). Weakest; corroboration only, never a primary signal.
6. **Shared `defaultCategory` / rule category.** Pure corroboration — same category is nearly meaningless alone (every coffee shop shares Dining).
7. **User-correction adjacency.** A USER alias re-point from key K to merchant M implies keys near K deserve a look against M. A learning signal for *ranking*, not for new pair generation.
8. **Receipt evidence** — future layer; a receipt naming a sub-merchant must *never* flow back into identity automatically (semantics doctrine §6.7); at most it can rank an existing suggestion.

## 4. Proposed suggestion confidence model (deliverable 4)

Three tiers plus a floor; tier = strongest single signal, corroboration can promote within (never across) the top boundary:

| Tier | Evidence | Product treatment |
|---|---|---|
| **T1 — Provider-verified** | Signal 1 (entity-id contradiction) | Shown at top of queue, labeled with the provider evidence ("your bank identifies these as the same business"). **Still human-confirmed** — no tier auto-merges, ever. |
| **T2 — Strong structural** | Signal 2 (truncation-prefix, ≥2 leading tokens) or signal 4 (shared domain), optionally corroborated by 5/6 | Shown in the queue as suggestions with the evidence sentence spelled out. |
| **T3 — Weak lexical** | Signal 3 alone, or signal 5 above a threshold | **Hidden by default** — only behind an explicit "find more possible duplicates" action on the review surface. Never notified, never counted in any badge. |
| **Floor** | Anything below T3, or anything matching §6 | Not computed into results at all. |

Confidence is **categorical, not numeric**: three named tiers whose meaning a user can be told in one sentence each — the provenance-explainer doctrine ("every claim can answer why in three hops") applied to suggestions. No ML scores; identical inputs yield identical tiers (testable with the pure in-memory pattern every MI module already uses).

## 5. Safe merge rules (deliverable 5)

The contract is already ratified (semantics investigation §5); restated as the accept-action's spec: human-confirmed always; explicit survivor selection (least-truncated brand-name form); **identity columns only** (alias re-point with `source: USER`, `Transaction.merchantId`, rule move-or-fold with provenance links re-pointed before any rule delete, `plaidEntityId` transfer when survivor lacks one, duplicate deletion last); never touches raw descriptors, `category` values, `categorySource`, `flowType`, `pfc*`; atomic (`$transaction`); idempotent; alias memory strictly grows; auditable (printed verification counts now; PO1 identity-correction events when the grammar exists). One addition for the queue context: **an accepted suggestion records which tier/evidence justified it** — that record is both the audit trail and the future promotion-pipeline signal ("many users confirmed this pair" is global-catalog evidence).

## 6. Cases that must never auto-merge — or even be suggested (deliverable 6)

The deny-list runs *before* tiering; a denied pair is not shown at any tier, including T3.

1. **Person/P2P descriptors.** Any merchant whose transactions are predominantly TRANSFER/INCOME-flow, or that would have failed the minting guard — never paired (extends the ratified PII fence from minting to suggesting; IMPORT-minted rows can slip past the original guard, so the detector re-checks).
2. **Parent-brand collapse.** A static aggregator-family deny-list (`GOOGLE *`, `APPLE`/`Apple.com/bill`, `AMZN`/`AMAZON`, `PAYPAL` as counterparty, `META`, etc.): two merchants that are *different service suffixes of the same aggregator* (GOOGLE \*Fi vs GOOGLE \*CLOUD) are never paired. The shared prefix is precisely the non-evidence.
3. **Google/Apple/Amazon service ambiguity.** Special case of 2 worth naming separately: `Apple.com/bill` vs `APPLE STORE` (services vs retail), `AMZN MKTP` vs `AMAZON.COM` vs `AMAZON PRIME` — plausible merges a user may *want*, but the system must not propose them because channel/product distinctions are cadence-intelligence raw material. User-initiated manual merge remains available; the system stays silent.
4. **Local same-name businesses.** Lexical pairs whose descriptors differ in city/state tokens are denied at T2/T3 (the normalizer keeps those tokens exactly for this reason); single-token canonical keys (`SHELL`, `DELTA`) are denied at all lexical tiers (T1 provider evidence may still pair them — the provider knows what a string doesn't).
5. **Marketplaces.** Never pair a marketplace merchant-of-record with a seller-brand merchant, whatever a receipt someday says.
6. **Rails/processors.** Never pair a rail-as-counterparty merchant (PayPal-the-fee-charger, Square-the-subscription) with merchants reached *through* that rail.

## 7. Recommended user workflow (deliverable 7)

Quiet by default, review-queue pull, one-tap-per-decision:

1. **Entry.** A "Merchants" maintenance surface (future home: wherever the merchant browse/list view lands; interim: a settings-level page). It lists suggestions T1-first with the evidence sentence: *"'Western Governors Un' and 'Western Governors University' look like the same merchant — 'Western Governors Un' appears to be a truncated version. 14 transactions would move."*
2. **Decision.** Three actions per pair: **Merge** (choose survivor, default pre-selected per §5; executes the contract atomically; shows the verification counts), **Not the same** (persists a dismissal; the pair never resurfaces at any tier), **Later** (no write; reappears next visit). Mirrors the M5 confirm-gate grammar: the system proposes with evidence, the human disposes.
3. **No pushes initially.** No notifications, no badges, no brief mentions. If suggestion volume proves real, a digest line ("3 possible duplicate merchants to review") can ride the existing OPS-3 notification substrate later — a deliberate v-later decision, not part of the smallest architecture.
4. **Undo posture.** No un-merge (out of scope, as ratified); the confirm step therefore states consequences plainly and defaults conservatively (T3 pairs require typing/re-picking the survivor, T1 pairs are one tap).

## 8. Recommended architecture (deliverable 8) — the smallest one

Three components; the only schema is a decisions table.

1. **`lib/transactions/merchant-merge.ts` — the merge core (extraction, no new behavior).** Lift the WGU script's `$transaction` body into a library function `mergeMerchants(client, survivorId, duplicateIds, evidence)` implementing §5. Callers: the generalized CLI now, the accept-endpoint later. Single-sourced like `merchant-write.ts`.
2. **`scripts/merge-merchants.ts` — the sanctioned utility (generalization of the WGU script).** `--survivor=<canonicalKey|id> --absorb=<key|id>...`, dry-run default, `--apply`, prints the same verification counts, JSON log per house backfill pattern. Ships independently of everything else and immediately retires the custom-script failure mode. **Answer to Q7: yes** — the WGU script is the correct contract already; it needs parameterization and the core extracted, nothing more.
3. **`lib/transactions/merchant-merge-suggest.ts` — the pure detector.** Zero I/O; takes injected merchant/alias/sample/entity-id data (the resolver's in-memory-testable pattern); returns `{pair, tier, evidence, deniedReason?}`. Deny-list first, tiers per §4. Computed **on demand** when the review surface loads (or the CLI runs it): merchant cardinality per deployment is hundreds-to-low-thousands — three indexed queries plus an O(n·log n) key sort, no cache, no staleness, no background writer. *(Answer to Q8: on demand for the surface; offline/dispatcher only if cardinality someday makes on-demand slow — the OPS-4 registry makes that a 20-line registration when proven necessary; never during import/sync — partial-batch data mid-import makes false pairs, and the write path stays pure; never during AI question handling — read paths never derive-and-persist, and chat must not become a mutation surface.)*
4. **Decisions table — the one schema item (future slice, not now).** `MerchantMergeDecision`: pair key (ordered canonicalKey pair, unique), verdict (`MERGED`/`DISMISSED`), tier + evidence snapshot, acting user, timestamp. Dismissals filter the detector's output; merged rows are the audit trail until PO1 events supersede the audit half. Suggestions themselves are deliberately **not** persisted — recomputation is deterministic, so storing them buys only staleness bugs.
5. **Accept-endpoint + review surface — last.** `POST /api/merchants/merge` (SP-2 auth posture, calls the merge core, writes the decision) + the queue UI, gated on a merchants surface existing to host it.

**Q9 — how this improves "How much did I spend at Lulu?":** since M6, the assembler's rollups group by `merchantId` (`transactions.ts:545`), so a split merchant is a split answer — "LULU HYPERMARKET" and a truncated "LULU HYPERMKT" produce two summary rows, the chat's merchant match latches onto one, and the total silently undercounts (exactly the WGU symptom, but inside an AI answer where the user can't see the split). Every accepted merge collapses those rollups into one complete group with one display name, and the re-pointed aliases keep future descriptor drift inside it. The AI needs no changes and gets no new powers — it answers better because the identity substrate under it is unified. (The AI must *not* be the trigger: detecting "two Lulu-like groups" mid-answer and merging or even suggesting from chat violates the ratchet. At most, a future assembler annotation could disclose "a possible duplicate merchant exists for this rollup" — deferred, and only after the queue exists.)

## 9. Where this belongs (deliverable 9)

**MI, as its own small slice — recommended: MI2 S1 (merge core + sanctioned CLI, no schema) and MI2 S2 (detector + decisions table + endpoint + minimal surface).** Not PO1: PO1 owns telemetry/rollups/event grammar — the only PO1 dependency is coining identity-correction events, which §8's decision table deliberately does not wait for (evidence snapshot suffices; events supersede later). Not admin: split merchants are per-deployment user data and the correction loop is a *user* trust feature; `app/admin` is the SYSTEM_ADMIN surface for a different audience. Not MI1 scope creep: MI1's ratification explicitly ends at M6; this is a new decision record's job. Sequencing constraint worth honoring: the review surface wants a merchants view to live in — if TI/product work delivers one first, S2 rides it; otherwise S2 ships the minimal settings-level page.

## 10. Final recommendation (deliverable 10)

**Build now (no schema, no product surface): the merge-core extraction and the generalized `merge-merchants` CLI.** That single small slice converts the WGU precedent from "custom script per incident" into a sanctioned, dry-run-defaulted, contract-enforcing utility — the gap that actually bit. **Defer (next MI slice, own ratification): the pure detector, the decisions table, the accept-endpoint, and the minimal review surface** — in that order, with the detector's deny-list (§6) treated as its most important feature and tested more heavily than its matching. **Defer further: notifications/digest mentions, T3 lexical tier exposure, receipt-evidence ranking, assembler duplicate-disclosure annotations.** **Avoid permanently: auto-merge at any confidence tier including provider-verified; suggestion computation during sync/import; merges or suggestions originating from the AI conversation path; any fuzzy matching that bypasses the deny-list; un-merge.** The architecture stays honest to the doctrine because every component is a proposal mechanism — the only thing in the entire design that changes identity is still a human pressing Merge, through the same contract the WGU merge already proved.
