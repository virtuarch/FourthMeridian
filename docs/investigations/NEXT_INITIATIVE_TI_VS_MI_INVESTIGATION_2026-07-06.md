> **INVESTIGATION ONLY — no code, no schema, no migrations, no roadmap-doc changes were made to produce this document.** For current project state see `STATUS.md` at the repository root.

# Next Initiative — Transaction Intelligence vs Merchant Intelligence

**Date:** 2026-07-06
**Status:** Investigation complete — sequencing recommendation only, no implementation
**Baseline:** MC1 **complete, all phases 0–4** (STATUS MC1 ledger row; `MC1_FINAL_CLOSEOUT_REPORT_2026-07-05.md`; head commit `ce51382`). FlowType P5 complete. The category↔flow desync seam is scoped but **not yet remediated** (`FLOWTYPE_CATEGORY_REWRITE_DESYNC_INVESTIGATION_2026-07-05.md` — 51 value-desynchronized rows; remediation is a named MI entry gate).
**Definitions used (assumption, labeled):** "Transaction Intelligence (TI)" = the scope defined in `TRANSACTION_INTELLIGENCE_DETAIL_VIEW_INVESTIGATION_2026-07-06.md` (canonical detail DTO + single-row endpoint + detail overlay + provenance display + annotations + AI actions). "Merchant Intelligence (MI)" = the persisted tier M0–M6 defined in `MERCHANT_INTELLIGENCE_PERSISTED_TIER_PLAN_2026-07-05.md` (categorySource provenance, enum expansion, Merchant/MerchantAlias/MerchantRule, overrides, read cutover). Neither initiative has an allocated track folder yet (`docs/initiatives/` contains neither `mi1/` nor a TI folder; MI's M0 explicitly allocates its own).
**Sources:** `prisma/schema.prisma`; `lib/transactions/{merchant,merchant-rules,fingerprint,flow-classifier}.ts`; `lib/data/transactions.ts`; `lib/ai/assemblers/transactions.ts`; `lib/ai/types.ts`; `app/api/{accounts,spaces}/[id]/transactions/route.ts`; `app/api/ai/chat/route.ts`; `components/dashboard/{BankingClient,AccountModal}.tsx`; `components/dashboard/widgets/{RecentTransactionsPanel,SpaceTransactionsPanel}.tsx`; `components/atlas/OverlaySurface.tsx`; STATUS.md; the five MI/TI/FlowType/desync investigation documents of 2026-07-05/06; `docs/KD-10_DUPLICATE_MONTHLY_EXPENSE_INVESTIGATION.md`; `docs/KD-11_KEYWORD_HEURISTIC_CONSOLIDATION_INVESTIGATION.md`.

---

## 0. Executive summary and verdict

**Recommendation: C — bounded parallel, with a hard ownership boundary and three sequencing rules,** executed as interleaved slices if capacity is single-track. Concretely: MI owns **all schema and all write paths**; TI Phases 1–3 own **read/presentation only and carry zero schema**; the tracks converge deliberately at one point — **MI M5 (the correction loop, MI's first user-facing slice) ships INTO TI's detail surface** rather than into a rowless list panel.

The evidence for this is structural, not preferential: the two initiatives touch **nearly disjoint file sets** (§5.1), each initiative's *only* awkward slice is precisely the one the other initiative fixes (MI M5 has no adequate UI host today; TI Phase 4 has no merchant data to render), and both prior planning documents already point at each other — the MI plan defers its edit affordance to "SpaceTransactionsPanel + provenance badge" (a stopgap its own product-architecture doc undermines), while the TI investigation names MI M4/M5 as its Phase 4 join point. Pure order A (TI→MI) delays the repository's own designated next initiative (STATUS: "Next initiative: Merchant Intelligence") behind UI work MI's schema slices don't need. Pure order B (MI→TI) forces MI M5 to build a correction UX in a list row that the detail surface then supersedes — the only concrete rework either ordering creates.

---

## 1. Current state

### 1.1 Transaction Intelligence domain

**Transaction model** (`prisma/schema.prisma:1176–1257`): the richest row in the schema — core fact (date/merchant/description/category/amount/pending), dual parent FK (`accountId` legacy / `financialAccountId` canonical, normalized on read), dedup keys (`plaidTransactionId` unique, `externalTransactionId`), import provenance (`importBatchId`, soft `deletedAt`), full flow block (`flowType`, `flowDirection`, `classificationConfidence`, `classificationReason`, `classifierVersion`), provider category provenance (`pfcPrimary/Detailed/ConfidenceLevel`), MI seed (`merchantEntityId`), MC1 native `currency` stamp, counterparty seam (`counterpartyAccountId`). Nine indexes including flow rollup shapes.

**FlowType:** complete and live (P5 closed 2026-07-05). `classifyFlow` is the single classification entry point; every production writer classifies; Banking/Space/Debt/AI/Brief/chat all read flow. Named residual debt (STATUS FlowType row): the 51-row value desync (scoped 07-05, unremediated), seed writes no flow, `FLOW_COST` set duplicated in `BankingClient`/`SpaceTransactionsPanel` vs the assembler's `EXPENSE_FLOWS`, `incomeTransactionCount` still counts by category name.

**Enrichment:** minimal. Of ~30 fields Plaid sends per transaction, the row persists the core seven plus the flow/pfc/currency additions; authorized date, payment channel, location, counterparties, logo/website, pending↔posted link are all discarded at sync (`TRANSACTION_METADATA_DEPTH_INVESTIGATION.md` — capture explicitly deferred as its own PII-reviewed decision).

**Merchant fields on the row:** `merchant` (string, `merchant_name ?? name`), `merchantEntityId` (captured and written by the sync pipeline — `lib/transactions/plaid-flow-input.ts:111` — but **read by zero code**).

**Transaction UI:** row lists only — `BankingClient` (search/filter/presets), `AccountModal` (paginated tab), `RecentTransactionsPanel`, `SpaceTransactionsPanel`, `DebtClient`. **Every row is non-interactive; no detail surface, no route, no affordance exists** (verified: `TxRow` has no onClick; the only onClick in `RecentTransactionsPanel` is "View all").

**AI usage:** summary-only domain `transactions_summary` (raw rows never enter context); bounded drilldowns whose DTO (`DrilldownTransaction`, `lib/ai/types.ts:483`) **lacks the row `id`** — the AI can describe rows it cannot point at. Chat additionally runs the KD-18 per-liability rollup over `getDebtTransactions()`.

**APIs:** two list endpoints (`GET /api/accounts/[id]/transactions`, `GET /api/spaces/[id]/transactions`). **No single-transaction endpoint exists.** The accounts endpoint is one of the 3 remaining legacy-`Account` read sites (unmet v2.5 exit criterion, STATUS §175).

**Editing:** none. The only `transaction.update*` writers are sync, import, import-rollback, and reconcile. No user-facing mutation of any transaction field exists anywhere.

**Normalization:** **three independent merchant normalizations** coexist: `normalizeMerchant` (`lib/transactions/merchant.ts` — canonicalKey/canonicalName for AI rollups), `normalizeMerchantKey` (`lib/transactions/fingerprint.ts` — dedup matching, reused by CSV import), and an inline `merchant.trim().toLowerCase()` in the assembler's recurring-candidate grouping (`lib/ai/assemblers/transactions.ts:504`). The MI plan already flags consolidating the first two as deferred-with-intent.

**Duplicate logic:** fingerprint matching is properly extracted and shared (`lib/transactions/fingerprint.ts`, D2 Step 4C; CSV import reuses it). Deliberately unresolved there: persisted fingerprintHash, collision semantics. Separately, the **row→DTO mapping is copy-pasted four times** (three functions in `lib/data/transactions.ts` + inline in the accounts endpoint, which has already drifted — it omits `currency`).

**Technical debt (TI-relevant):** the four-way mapping duplication; the drilldown-DTO missing `id`; dead-end rows; `FLOW_COST` triplication; legacy-`Account` read site; no server-side transaction search (client filters the full fetched array).

### 1.2 Merchant Intelligence domain

**`merchantEntityId`:** persisted on Plaid-synced rows since FlowType P3 (writer: `plaid-flow-input.ts`); read by zero code. It is exactly the "forward seed" its schema comment claims — the M4 dictionary can backfill without a Plaid re-fetch.

**Merchant models:** none persisted. What exists is Tier A compute: `normalizeMerchant` (pure canonicalization, conservative-by-doctrine) and `lib/transactions/merchant-rules.ts` (curated global brand→category catalog, Slice 1, explicitly capped: "NOT the long-term merchant system"). `Merchant`/`MerchantAlias`/`MerchantRule` exist only as a fully drafted schema in the persisted-tier plan (§3.2–3.4).

**Provenance:** none for categories. No `categorySource`, no `categoryRuleId`; `pfcPrimary/Detailed` are the only reconstruction evidence for "why is this category what it is." The MI plan's own inventory (§1): "No category writer records why a category is what it is."

**Merchant correction:** none. No override endpoint, no edit affordance anywhere (`SpaceTransactionsPanel` renders `tx.category` raw).

**Recurring detection:** a throwaway read-time heuristic only — the assembler groups by lowercased merchant, ≥2 occurrences in-window, flow-excludes TRANSFER/DEBT_PAYMENT. Nothing persisted; v2.6b plans persisted cadence records as the replacement.

**AI usage:** merchant rollups (`MerchantSummary`, top-merchant aggregation) re-normalize per request via `normalizeMerchant` — the exact re-derivation-site pattern KD-10/KD-11 catalogued as a defect class; MI M6 exists to remove it.

**Category usage:** the 16-value `TransactionCategory` enum is a **binding constraint** (MI plan §2.3): `mapPlaidCategory` collapses six entire PFC spend primaries (MEDICAL, ENTERTAINMENT, TRANSPORTATION, PERSONAL_CARE, GENERAL_SERVICES, HOME_IMPROVEMENT) to `Other`, and the Slice-1 held-out merchants are blocked solely by missing vocabulary.

**Current roadmap position:** MI is the repository's designated next initiative — STATUS's MC1 row closes with "Next initiative: Merchant Intelligence"; the 2026-07-05 next-initiative investigation ranks it first behind a short runway (desync remediation → MC1 Phase 0 → MI), of which **only the desync remediation remains open** (MC1 is fully complete).

**Technical debt (MI-relevant):** the 51-row value desync + 650 input-stale rows (scoped, runbook written, unapplied); the rewrite-invalidation contract not yet embodied in a shared helper; three normalizers; the enum bottleneck; re-derivation sites.

---

## 2. Dependency analysis

**Does MI become simpler if TI exists first? Yes, materially — but only its user-facing half.** Specifically: (a) M5's correction gesture and provenance badge get a real host. The MI product-architecture doc defines the correction moment as "the product's single most important interaction" and specifies a gesture with scope choices (this transaction / always / this Space) plus "Why this category?"; a 56px list row cannot hold that — the plan's fallback ("SpaceTransactionsPanel edit affordance") would be interim UX that the detail surface immediately supersedes. (b) TI Phase 1's single serializer means MI's read-side fields (`categorySource`, resolved merchant) are added in **one** place instead of four drifting copies. (c) TI Phase 3's humanized-provenance disclosure is the skeleton "Why this category?" plugs into. MI's schema/write slices (M1–M4) gain **nothing** from TI — they have no UI at all.

**Does TI become simpler if MI exists first? Only marginally.** TI Phases 1–3 read columns that already exist; MI changes none of them. The two touchpoints: TI's Merchant section (Phase 4) renders real data instead of being gated, and Related-transactions can group by `merchantId` instead of read-time canonicalKey (a one-line predicate swap either way). Nothing in TI's DTO, endpoint, overlay, flow disclosure, or MC1 display gets easier.

**Which creates more reusable primitives?** Different layers. MI creates the deeper **data primitives**: merchant identity spine (Merchant/Alias), `categorySource` provenance (the pattern every future automatic writer must respect), the category-rewrite helper (the contract enforcement point), expanded vocabulary. TI creates the **read/presentation primitives**: the canonical single-row DTO + endpoint (the first per-row read in the product), the extracted serializer, the canonical inspection surface every future intelligence layer renders into, and the `?tx=` deep-link target. MI's primitives are consumed by more *computation*; TI's by more *surfaces*. Counting future consumers (§3), MI edges ahead — but TI's primitives are an order of magnitude cheaper to build.

**Which unlocks more future initiatives?** MI. Cadence detection, Budget Intelligence, subscription surfacing, business-context categorization, and the AiAdvice writer's merchant-aware advice all read MI's persisted tiers. TI unlocks display-and-trust features (receipts UI, audit display, AI explanation surface) but few computations.

**Which risks rework if built first?** **MI.** Built strictly first, M5 ships correction UX into the list panel and "Why this category?" into a popover — both redone when the detail surface lands (the *only* concrete duplicated-work item found in either direction). TI built first risks almost nothing: its DTO takes MI's fields as nullable additions (the exact pattern the row DTO already used for flow and currency fields), and its Merchant section is explicitly phase-gated. The one TI rework hazard — building Related-transactions on canonicalKey then swapping to merchantId — is contained to one query predicate.

---

## 3. Architectural leverage

| Future capability | Served more by | Evidence-based reasoning |
|---|---|---|
| **Receipt Intelligence** | **TI first, MI close second** | Receipts attach to *transactions* (TI Phase 5 annotation sidecar + storage substrate + the surface to view them); merchant identity (MI) then powers receipt↔merchant matching. Without TI there is nowhere to attach or view a receipt. |
| **Tax Intelligence** | **MI** | The MI product architecture already designs tax as category→tax-treatment mapping per jurisdiction, business-Spaces-first — pure MI vocabulary + Space-context leverage. TI contributes only display. |
| **Budget Intelligence** | **MI** | Budgets aggregate by category and merchant cadence; blocked today by the enum bottleneck (six PFC primaries → `Other`) and the throwaway recurring heuristic. |
| **AI explanations** | **Split: TI the surface, MI the content** | The deterministic "why" (pfc + classificationReason) exists on rows **today** and needs only TI Phase 3 to reach users; `categorySource` (MI) completes the story for corrected rows. |
| **Business Spaces** | **MI** | The Space-rule overlay IS the business-vs-personal context per the MI product architecture ("a business Space's rules ARE the business context — no new field; wiring the overlay is the feature"). |
| **Shared Spaces** | **TI slightly** | TI's endpoint extends the KD-15 fail-closed predicate to per-row depth and its annotation model forces the author-privacy decision; MI's Space overlay is deferred-with-intent in its own plan. |
| **Ambient Intelligence (v2.6b)** | **MI** | Persisted cadence records are the v2.6b flagship; the AiAdvice writer reads merchant/flow rollups. TI contributes the link target ambient advice points at. |
| **Search** | **Split** | MI aliases give recall ("Netflix" matches all nine descriptors); TI gives the result target (a detail view to open) and the serializer a server search API would return. Neither initiative contains search itself. |
| **Analytics** | **MI** | M6 replaces per-request re-normalization with resolved `merchantId` groups — the KD-10/KD-11 "one derivation site" discipline applied to merchants. |
| **Future provider imports** | **MI** | New providers bring new merchant-string dialects; the identity spine absorbs them (entityId → alias → canonicalKey → guarded mint). TI's DTO merely gives them one read shape. |

Net: **MI carries more forward leverage across computation-heavy futures; TI is the universal *rendering* dependency** — nearly every row above ends by displaying something in the transaction detail surface.

---

## 4. User value

**Immediate value: TI, decisively.** TI Phases 1–3 surface roughly a dozen already-persisted facts (flow semantics + confidence + reason, provider category opinion, native/reporting currency with rate disclosure, import provenance) behind rows that are dead ends today — read-only, zero migrations, zero writes, zero new privacy surface beyond the existing predicate. Nothing in MI M1–M4 is user-visible at all (its own plan: "Explicitly not in M1: no writer, no reader, no backfill, no UI"); MI's first user-visible payoff arrives at M2-forward-categorization (new rows stop landing in `Other`) and its headline payoff at M5.

**Long-term architectural value: MI, decisively.** Identity spine, provenance discipline, vocabulary, and the learning loop are the substrate for §3's computation-heavy column. TI's long-term architectural contribution is real but narrower: the canonical read seam and the inspection surface.

These answers are not in tension — they describe complementary halves (write-side intelligence vs read-side trust), which is what motivates the §6 verdict.

---

## 5. Parallelization

**Yes — parallel development is safe, with one boundary and three rules.** "Parallel" here means two concurrently open tracks with interleaved slices; nothing below requires simultaneous execution. (**Assumption, labeled:** execution capacity is effectively single-track; the analysis holds either way.)

### 5.1 Why it is safe: measured file-set disjointness

MI M1–M4 touch: `prisma/schema.prisma` + two migrations, `lib/transactions/plaid-category.ts` (mapper), `lib/transactions/flow-classifier.ts` (SPEND_CATEGORIES additions), a new `lib/transactions/category-rewrite.ts`, sync/import writers, backfill scripts. TI Phases 1–3 touch: `lib/data/transactions.ts` (serializer extraction), one new route `app/api/transactions/[id]`, new components on `OverlaySurface`, four list components gaining an onClick, `lib/ai/types.ts` (one additive `id` field on `DrilldownTransaction`). **Intersection: effectively empty.** The single shared file class is type definitions (`types/index.ts`), where both sides only add optional fields — the established additive pattern (flow fields P5 Slice 1, `currency` MC1).

Migration contention — the repo's serialized-migration doctrine (MC1 plan §6, restated in MI plan §2.4) — is not violated: **TI Phases 1–3 contain zero migrations.** TI's first migration (Phase 5 annotations) must simply queue behind MI's.

### 5.2 The boundary

**MI owns everything that writes or defines meaning** (schema, enums, mappers, classifiers, writers, backfills, correction endpoints). **TI owns everything that reads and presents** (DTOs, the per-row endpoint, the overlay, disclosures, deep links). The correction *endpoint* is MI's; the correction *gesture UI* is TI-hosted. No TI slice may add a fourth merchant normalizer or any write path; no MI slice before M5 may add UI.

### 5.3 Shared models and contracts

No new shared *models* — MI's tables are MI's. Three shared **contracts**: (1) the `TransactionDetail` DTO is the integration bus — MI lands `categorySource`/`categoryRuleId`/resolved-merchant as nullable additions to it, in the one serializer TI Phase 1 creates; (2) the KD-15 visibility predicate gates both (TI's endpoint; MI's read overlay later); (3) the category-rewrite helper (MI M2) is the only path any future TI editing slice may call — TI never mutates category directly.

### 5.4 Sequencing rules (the three that matter)

1. **Desync remediation before MI M1** (already an MI entry gate; TI is unaffected by it — its reads display whatever is stored).
2. **TI Phase 2 (the read-only overlay) lands before MI M5** — so the correction loop ships into its permanent home. This is the rule that eliminates the only identified rework.
3. **TI Phase 4 gates on MI M4/M5** (already stated in the TI investigation); TI Phase 5's migration queues behind MI's migration train.

Convergence point: **MI M5 = TI Phase 4** — one slice, two track-closeouts touching it.

---

## 6. Recommended order — **C (bounded parallel)**

Defense, in architectural terms:

1. **The interlock is real and symmetric.** MI's first user-facing slice needs TI's surface (or builds throwaway UX); TI's merchant phase needs MI's data (or renders an empty section). Any pure order forces one side to ship its weakest slice into the other's absence. A defined convergence point dissolves the interlock; orders A and B merely pick which side pays.
2. **Order B's cost is rework; order A's cost is delay of the designated headline.** B makes M5 build a list-row correction UX superseded within one initiative-cycle — measurable duplicated work. A postpones MI M1 (pure schema, needing no UI) behind overlay work it does not consume, contradicting the repo's own next-initiative designation (STATUS) for no structural gain.
3. **Parallel is cheap here specifically because of how these two initiatives are already shaped.** MI M1–M4 were deliberately designed UI-free and additive (its plan: "a repo parked at M1 for a month is fully healthy"); TI 1–3 were deliberately designed schema-free and read-only. That is a boundary the two plans dug independently — this recommendation formalizes rather than invents it.
4. **The degenerate serialized form preserves the property.** If one-track discipline is preferred, the interleaving *TI 1 → MI M0/M1 (+ remediation) → TI 2–3 → MI M2–M4 → [M5 = TI 4] → M6 → TI 5–6* is order C executed sequentially: every convergence rule holds, no slice ships into a void. What matters architecturally is not simultaneity but that **neither initiative is declared "done" before the convergence slice** — that is what prevents the throwaway UX and the empty section.

Smallest-possible-recommendation framing: adopt rule 5.4(2) and the 5.2 boundary. Everything else above is existing plan content restated.

---

## 7. Proposed roadmaps (architecture only)

### 7.1 Transaction Intelligence (restates the 2026-07-06 TI investigation §10, unchanged)

- **TI-1 — Canonical DTO + single-row read.** Serializer extraction (kills the 4-way duplication); `TransactionDetail` DTO; `GET /api/transactions/[id]` under the KD-15 predicate. No UI, no schema.
- **TI-2 — Read-only detail overlay.** `OverlaySurface` dialog intent; rows become clickable in the four list surfaces; Overview/Flow/Account/collapsed-Technical sections; MC1 layered native+reporting display. **← must precede MI M5.**
- **TI-3 — Provenance & deep links.** Humanized `classificationReason`/confidence + conversion-rate disclosures; `?tx=` search-param open; `id` added to `DrilldownTransaction`.
- **TI-4 — Merchant section** (= MI M5 convergence). Merchant profile block, correction gesture host, full "Why this category?", Related-transactions on `merchantId`.
- **TI-5 — Annotations.** Sidecar `TransactionAnnotation` model (notes/tags; attachments after a storage decision). First TI migration — queues behind MI's.
- **TI-6 — AI actions.** Single-row context domain (the reserved `TRANSACTIONS_RAW` seam); AI proposals route through MI's correction endpoints only.

### 7.2 Merchant Intelligence (restates the persisted-tier plan §8, unchanged except the M5 host note)

- **M0 — Decision gate** (doc-only): enum set, precedence ranks/clobber matrix, source-enum null semantics, Space-scope deferral, minting guards; allocate `MI-x` track + folder. May start immediately.
- **Pre-M1 gate:** the 51-row desync remediation runbook (already written) applied and verified.
- **M1 — Schema foundation:** enum expansion (own migration — the one irreversible statement) + Merchant/MerchantAlias/MerchantRule + `categorySource`/`categoryRuleId`/`merchantId` (nullable, no defaults); `SPEND_CATEGORIES` companion update. No writers, readers, backfills, UI.
- **M2 — Write-path provenance + rewrite contract:** `resolveCategoryWithSource()`, mapper bucket expansion, all writers stamp, `category-rewrite.ts` shared helper, legacy scripts retrofitted.
- **M3 — Expanded-vocabulary backfill** (dry-run → apply → idempotence proof).
- **M4 — Merchant dictionary:** write-time identity resolution (entityId → alias → canonicalKey → guarded mint), `merchantId` stamping + backfill.
- **M5 — Overrides + user rules (the learning loop)** — **hosted in the TI detail surface (TI-4)**, not a list-row affordance.
- **M6 — Read cutover:** AI rollups on resolved `merchantId` groups; byte-comparison harness.
- Deferred-with-intent (per the plan): Space-rule overlay, cadence track, normalizer consolidation, enrichment.

---

## 8. Risks

**Hidden coupling.**
- `flow-classifier.ts` ⇄ category vocabulary: every enum value MI adds must enter `SPEND_CATEGORIES` in the same slice or rows classify honest-but-wrong `UNKNOWN` (MI plan §2.1). TI displays whatever is stored — it will *surface* this bug class to users, which is a feature but also an exposure-timing coupling.
- The four-way DTO mapping: if MI's read-side fields land before TI-1's extraction, MI pays the duplication four times and inherits the drift (the accounts endpoint already dropped `currency`). Cheap insurance: TI-1 first regardless of everything else.
- `DrilldownTransaction` and the chat serializer have pinned-wording/golden tests; TI-3's additive `id` and any MI serializer changes must respect them.
- Three merchant normalizers already disagree by construction; both initiatives touch merchant strings. Rule: neither adds a fourth; consolidation stays MI-owned (its deferred item).

**Future migrations.** `ALTER TYPE ... ADD VALUE` is irreversible (MI isolates it in its own migration file — correct). `merchantId` backfill must handle dual-FK legacy rows and rows with null `merchantEntityId` (canonicalKey path). TI-5's annotation table and any future fingerprintHash column join the same serialized migration train. Legacy-`Account` retirement (separately gated) will eventually touch `app/api/accounts/[id]/transactions/route.ts` — TI-1 should route the detail read through `lib/data` so that retirement touches one fewer endpoint.

**Duplicated work.** The only structural instance is order-B's M5 list-row UX (eliminated by rule 5.4(2)). Minor: Related-transactions canonicalKey→merchantId swap if TI ships it pre-M4 (contained to one predicate).

**Schema risks.** Merchant minting guards must hold under concurrent sync+import writes (the plan's find-then-create pattern needs the same defense-in-depth uniqueness discipline `ProviderAccountIdentity` uses). `categorySource` null semantics ("pre-MI, provenance unknown") must never be backfilled with fabricated values — the MC1 Phase 0 doctrine restated. TI holds schema risk near zero until TI-5 (author-privacy model for annotations on shared-account rows is the decision to get right).

**AI risks.** Context budget (D6.3D) when a single-row domain lands — TI-6 must be a bounded, opt-in domain, not ambient. Divergence risk between the deterministic "why" (TI-3) and any later LLM-phrased explanation — the LLM must phrase the stored provenance, never re-infer it (both prior docs agree). Drilldown `id` exposure must not bypass the visibility predicate (ids are capability-less; the endpoint re-checks — keep it that way).

**UX risks.** Provenance overload — confidence bands, estimated-currency markers, and provider-opinion labels can stack into noise; the TI investigation's layering doctrine (fact → interpretation → machinery, disclosures collapsed) is the mitigation and should be treated as binding. Correction-affordance placement — if any interim edit affordance ships in a list row despite rule 5.4(2), it becomes the de facto pattern and the detail surface launches as "the second place to edit." The MI product architecture's one-gesture correction with scope choice is the single interaction to protect; hosting it anywhere cramped degrades the product's designated trust moment.

---

**End of investigation. No implementation performed. Recommendation: C — bounded parallel with the §5.2 boundary and §5.4 sequencing rules; convergence at MI M5 = TI-4.**
