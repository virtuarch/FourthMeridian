> **INVESTIGATION ONLY — no code, no schema, no migration, no STATUS.md change, no roadmap-doc change was made to produce this document.** For current project state see `STATUS.md` at the repository root.

# Merchant Intelligence — Architecture & Readiness Investigation

**Date:** 2026-07-07
**Baseline:** working tree at `2486b5f` (OPS-3 complete) **plus uncommitted OPS-1 S4/S5/S6 work** (23 modified/untracked files: rate limiting default-on, security headers, `instrumentation.ts`, `/api/health`, `docs/initiatives/ops4/`). The tree is dirty at the time of writing — relevant to §13.
**Question under investigation:** Is Merchant Intelligence (MI) ready to begin immediately after the current work (OPS-1 residuals / OPS-4), and is the roadmap position it has been given correct?
**Prior art (re-verified, not assumed):** `MERCHANT_NORMALIZATION_EVOLUTION_INVESTIGATION.md` (2026-07-03, Tier A/B/C model) · `MERCHANT_INTELLIGENCE_LAYER_INVESTIGATION.md` (2026-07-04) · `MERCHANT_INTELLIGENCE_PERSISTED_TIER_PLAN_2026-07-05.md` (the M0–M6 slice plan) · `MERCHANT_INTELLIGENCE_FORMS_INVESTIGATION_2026-07-05.md` (ratchet architecture) · `MERCHANT_INTELLIGENCE_PRODUCT_ARCHITECTURE_2026-07-05.md` (three-layer merchant object) · `NEXT_INITIATIVE_TI_VS_MI_INVESTIGATION_2026-07-06.md` (bounded-parallel verdict) · `docs/architecture/PORTFOLIO_MASTER_PLAN_2026-07-06.md` Rev B (the ratifiable runway) · `docs/initiatives/ops4/OPS4_BACKGROUND_JOBS_INVESTIGATION_2026-07-07.md` · `docs/initiatives/desync/CERTIFICATION_2026-07-06.md` · STATUS.md.

---

## 0. Executive summary and verdict

**Yes — Merchant Intelligence is ready, and readier than any prior initiative was at its start.** Every architectural prerequisite named by MI's own entry gates has landed since the plan was written: FlowType is the single semantic authority (P5 closed), MC1 Phase 0–4 are complete (the provenance-column doctrine MI copies is proven), the desync corpus is **certified clean** (2026-07-06, guarded by `npm run audit:flow-desync`), `merchantEntityId` has been accumulating on every Plaid-synced row since P3, TI Phase 1 shipped the canonical row serializer and the product's first per-row endpoint, and D-TEST gives every MI slice a CI-enforced runner. The design corpus is unusually complete — four investigation/design documents converge on one schema and one slice plan with no contradictions between them.

**What remains is procedural, not architectural:** M0 ratification (enum set, clobber matrix, minting guards, track allocation — no `docs/initiatives/mi1/` folder exists yet), committing the currently dirty OPS-1 working tree, and folding two named open items *into* MI's own first slices (the category-rewrite invalidation contract is literally MI M2's deliverable; the classifier version-gate input-blindspot should be ratified into M1/M2 scope rather than treated as an external gate).

**On the roadmap question — the honest answer challenges the framing in both directions:**

1. The chain "Merchant Intelligence → Transaction Intelligence → Receipt Intelligence → Ambient Intelligence → PO1" is **not what the repository says**. TI Phase 1 already shipped *before* MI's persisted tier — strict MI-before-TI ordering is already false in the git history. The 2026-07-06 TI-vs-MI investigation (endorsed by the Portfolio Master Plan) established the real relationship: **bounded parallel with a designed join** — MI owns all schema and writes, TI owns read/presentation, and MI M5 (the correction loop) ships *into* TI's detail surface. Receipt Intelligence has **zero footprint in the repository** (no code, no schema, no investigation — the only "Receipt" hits are a lucide icon). And PO1 does not trail Ambient — the repo's own documents place PO1 *before* private beta because telemetry loss is irreversible, and v2.6b's exit criteria are unmeasurable without the platform-rollup layer.
2. Against the *current* STATUS runway (OPS-1 → PO1 → Platform Facts → Rollups → Platform Ops → Private Beta), which contains no MI before beta at all: MI M0–M2 are schema-only, behavior-neutral, and file-disjoint from every OPS/PO slice. Serializing them behind the entire operational arc wastes the parallel capacity the Portfolio Master Plan explicitly authorized (runway positions ④ and ⑥: "OPS-1 with MI M0–M2 in bounded parallel"). MI does not need to wait for OPS-4 to finish; only MI's *enrichment* tier (Tier C assets, cadence jobs) genuinely wants OPS-4's dispatcher.

**Verdict:** open MI at M0 (doc-only, safe even against a dirty tree) as soon as the OPS-1 S4–S6 work commits; run M1–M4 as the schema-owning second track in bounded parallel with OPS-4 implementation; hold M5 until TI P2 provides its host surface; hold enrichment until the OPS-4 dispatcher exists. MI is the next major *product* initiative; it is not, and should not try to be, the next *serialized* initiative.

---

## 1. Current merchant architecture (deliverable 1)

Merchant identity today is **a string column plus three disconnected compute layers**, with one persisted forward seed nothing reads.

### 1.1 The persisted surface

`Transaction` (`prisma/schema.prisma` ~1241–1322) carries exactly two merchant-bearing fields:

- `merchant String` — required; written as `txn.merchant_name ?? txn.name` by Plaid sync (`lib/plaid/syncTransactions.ts:230`), as the mapped file column by the import pipeline, and by the dev seed. Raw bank-feed descriptor; never normalized at rest.
- `merchantEntityId String?` — Plaid's stable `merchant_entity_id`, captured by `buildPlaidFlowInput` (`lib/transactions/plaid-flow-input.ts:111`) and persisted since FlowType P3. Its schema comment declares it a "forward seed for the Merchant Engine." **Read by zero code** (grep-verified: the only non-write references are the import pipeline's careful preserve-on-update logic at `app/api/accounts/[id]/import/route.ts:402,429`).

Supporting provenance that MI will lean on: `pfcPrimary` / `pfcDetailed` / `pfcConfidenceLevel` (persisted provider category hints, P3), `flowType` + `classifierVersion` (the re-runnability pattern), `currency` (MC1 Phase 0). There is no `Merchant` table, no alias table, no rule table, no `categorySource`, and no user-facing edit of any transaction field anywhere in the product.

### 1.2 The compute layers (three normalizers — the KD-11 pattern, live)

| Normalizer | Location | Contract | Consumers |
|---|---|---|---|
| `normalizeMerchant` → `{canonicalKey, canonicalName}` | `lib/transactions/merchant.ts` (154 lines, tested) | Conservative merge: strips rail prefixes (SQ*/TST*/PAYPAL*/POS/ACH/…), store numbers, masked tails; never-empty fallback; explicitly defers city/state to "Tier B" | `lib/ai/assemblers/transactions.ts` only — merchant rollups (line 563), income rollups (644), drilldown display names (1123) |
| `normalizeMerchantKey` (uppercase/collapse only) | `lib/transactions/fingerprint.ts` | Maximally conservative — dedup must never over-merge | Sync fingerprint fallback (`syncTransactions.ts:303`), CSV import clean-match (`lib/imports/csv.ts:566`) |
| Inline `merchant.trim().toLowerCase()` | `lib/ai/assemblers/transactions.ts:504` | Ad-hoc grouping key | The read-time recurring-candidate heuristic |

Two of the three have opposite biases *by design* (rollup wants to merge; dedup must not); the third is drift. The evolution investigation already named consolidating the first two "the most valuable thing to do *before* any entity work begins."

### 1.3 The categorization layer (MI Slice 1 — already landed)

`lib/transactions/merchant-rules.ts` (182 lines): a curated, ordered, global merchant→category catalog (15 rules + the 10-brand `SUBSCRIPTION_MERCHANTS` allowlist), consumed by `mapPlaidCategory` (`lib/transactions/plaid-category.ts`) *below* flow-structural PFC primaries. Its own header caps it: "NOT the long-term merchant system." It outputs categories only, never flow — the doctrine every MI document restates. `isLiabilityCardPaymentLeg` (same module) is the one other merchant-string consumer on the write path — a descriptor+account-side+sign rescue applied before `classifyFlow`, deliberately not a merchant rule.

### 1.4 What already acts as a merchant identity

Three things, none coordinated: (a) `merchantEntityId` where Plaid supplies it — the only *true* identity, persisted but unread; (b) `normalizeMerchant().canonicalKey` — the AI layer's de-facto identity, recomputed per request; (c) the raw `merchant` string — the identity every UI list, search filter, export, and the fingerprint effectively use. Three identities for one concept is the precise gap MI's Tier B dictionary closes.

---

## 2. Existing merchant data inventory (deliverable 2)

### 2.1 Where merchant information enters the platform

| Entry point | What enters | What is kept / discarded |
|---|---|---|
| **Plaid sync** (`lib/plaid/syncTransactions.ts` → `buildPlaidFlowInput`) | `merchant_name`, `name`, `merchant_entity_id`, `personal_finance_category(.detailed/.confidence_level)`, `counterparties[]` (each with name, type, `entity_id`, `website`, `logo_url`, confidence) | Keeps: `merchant` (coalesced), `merchantEntityId`, `pfc*`. **Discards at persistence: the entire `counterparties[]` array — including per-transaction `website` and `logo_url`** — captured in memory for the flow input shape (`plaid-flow-input.ts:99–112`) then dropped (no Transaction column exists; `counterparties[].account_numbers` is deny-listed by design, header line 17). Also discarded: location, payment channel, authorized date, pending↔posted link (`TRANSACTION_METADATA_DEPTH_INVESTIGATION.md` — deliberate deferral) |
| **CSV/Excel/QuickBooks import** (`lib/imports/csv.ts`, `excel.ts`, `app/api/accounts/[id]/import/route.ts`) | `merchant` column + keyword→category mapping | Keeps merchant string + mapped category; `merchantEntityId`/`pfc*` null on create, preserved on QuickBooks update-on-match |
| **Seed** (`prisma/seed.ts`) | dev-only merchant strings | n/a |

There is **no manual transaction creation** and no user-facing transaction editing anywhere — the only `transaction.create/update` writers are sync, import, import-rollback, and reconcile (re-verified; unchanged since the TI investigation).

### 2.2 Where merchant information is consumed

| Consumer | Form consumed | Evidence |
|---|---|---|
| **Transaction UI** ×5 — `BankingClient`, `AccountModal`, `RecentTransactionsPanel`, `SpaceTransactionsPanel`, `DebtClient` | Raw `merchant` string rendered per row; no detail surface, rows non-interactive | e.g. `BankingClient.tsx:550` |
| **Search** | Client-side substring filter over raw `merchant` (`BankingClient.tsx:201`); **no server-side transaction search exists** | grep |
| **AI assembler** (`lib/ai/assemblers/transactions.ts`) | `MerchantSummary` top-merchant rollups + income rollups via `normalizeMerchant` (re-derived per request); recurring-candidate heuristic via the inline third normalizer; drilldown rows serialize `canonicalName` | lines 504, 563, 644, 1123 |
| **AI chat route** | KD-18 per-liability rollup over `getDebtTransactions()`; drilldowns | `app/api/ai/chat/route.ts` |
| **Daily Brief** (`app/api/brief/route.ts`) | Spending/income totals only — `merchants`/`incomeSources` rollups are **omitted at `scopeHint='brief'`** (`lib/ai/types.ts:629,639`). The Brief consumes no merchant identity today | grep |
| **Exports** (OPS-2 S6) | `transactions.csv` writes the raw `merchant` column, importer-compatible by design (`lib/export/csv.ts:30`); rides the ZIP export | code |
| **Fingerprint/dedup** | `normalizeMerchantKey(merchant)` in the sync fallback + CSV match | `fingerprint.ts` |
| **Flow write path** | `isLiabilityCardPaymentLeg` reads merchant+descriptor; `classifyFlow` accepts merchant as input **used by zero rules** (P5 closeout guarantee — identity cannot leak into flow) | `plaid-category.ts` |
| **SyncIssue / integrity gate** | `SyncIssue.detail Json` embeds `{ merchant, amount, … }` for diagnostics (`schema.prisma:1660`); sync error paths embed merchant in issue detail (`syncTransactions.ts:220,329`) | schema |
| **TI Phase 1 detail endpoint** | `GET /api/transactions/[id]` returns the canonical DTO incl. `merchant` (`lib/transactions/serialize.ts`, `lib/transactions/detail-query.ts`) | code |
| **Notifications** (OPS-3) | No merchant consumption today (item-level sync-failure notifications only) | grep of `lib/notifications/` |

### 2.3 What is duplicated

Three merchant normalizers (§1.2). Two identity vocabularies (entityId vs canonicalKey vs raw string). The subscription allowlist is now single-sourced (`merchant-rules.ts`, re-exported by `plaid-category.ts:45`) — one prior duplication already fixed. The row→DTO duplication that TI-1 existed to kill is **fixed** (`serialize.ts` is the single derivation site).

### 2.4 What is missing

No persisted merchant identity (table/FK). No category provenance (`categorySource` — "no category writer records why a category is what it is"). No correction mechanism of any kind (no override endpoint, no edit affordance; `SpaceTransactionsPanel` renders `tx.category` raw). No alias memory (the system cannot learn that two descriptors are one merchant). No persisted cadence/recurrence (the heuristic is recomputed and discarded per request). No merchant assets (logo/website discarded at sync; no blob storage exists anywhere in the repo). No server-side merchant search or per-merchant view. Six PFC spend primaries still collapse to `Other` (enum gap, persisted-tier plan §2.3).

---

## 3. Proposed architecture (deliverable 3)

**Adopt the persisted-tier plan's architecture (M0–M6) as-is, with three amendments (§9).** This investigation re-derived the question from the current tree rather than assuming the plan, and the tree still points at the same answer:

- **Write-time resolution → persisted identity → rank-gated category provenance → read cutover.** This is the FlowType template (write-time classifier + additive columns + version-gated backfill + staged read cutover), which is the one pattern in this repository with a completed, certified, end-to-end execution. MI is structurally the same problem one dimension over (who the counterparty is vs. what kind of movement it is).
- **The resolution stack:** provider payload → merchant resolution (`plaidEntityId` → `aliasKey` → `canonicalKey` → guarded mint) → category resolution (flow-structural PFC > USER rule > GLOBAL catalog > expanded PFC spend buckets > legacy > Other, each arm returning its source) → `classifyFlow` unchanged as the single flow authority.
- **Corrections as two mechanisms, not one:** row-level `USER_OVERRIDE` (stored on the row, any category, flow follows through the classifier) and merchant-level `MerchantRule` (spend-meaningful categories only). Space-level meaning is a **read-time overlay**, never a row write — a shared row cannot hold two Spaces' truths (SpaceAccountLink makes this structural, not stylistic).
- **Everything the system knows is a readable row with provenance and rank** (the forms investigation's ratchet: detectors propose, the deterministic store disposes, human correction always dominates).

### 3.1 On `MerchantIdentity` / `MerchantAlias` / `MerchantAsset` specifically

The proposed triple is two-thirds right and one-third premature:

- **`MerchantIdentity`** → yes, but named **`Merchant`** per the ratified-in-draft schema (persisted-tier plan §3.2): `canonicalKey @unique`, `displayName`, `plaidEntityId? @unique`, informational `defaultCategory?`. Deployment-global, PII-minting-guarded (auto-mint only with `plaidEntityId` or spend-family flow; TRANSFER/DEBT_PAYMENT/INCOME/UNKNOWN rows never auto-mint — Zelle/Venmo/payroll descriptors embed person names). No fuzzy clustering, ever, in this initiative.
- **`MerchantAlias`** → yes, exactly as drafted (§3.3): globally-unique `aliasKey`, one raw sample, source enum (PLAID/IMPORT/USER); ambiguity resolved by refusing the second mapping.
- **`MerchantAsset`** → **no, not as a model, not yet.** The repository contains no consumer of merchant assets (no surface renders a merchant logo), no storage substrate (no blob store, no image pipeline; `ProviderCatalog.logoUrl` — the only precedent — is an optional externally-referenced string, `lib/providers/catalog.ts:82`), and no fetch pipeline (which would want OPS-4's dispatcher, unbuilt). A dedicated asset model now would be the ProviderAdapter mistake (STATUS §8: generalization before a second consumer is speculation). What *is* justified now is cheap capture of what Plaid already sends and we throw away — see §6/§7. The triple also omits the two models the repository actually demands first: **`MerchantRule`** and the **`categorySource`** provenance columns, without which every correction dies at the next Plaid `modified` event (persisted-tier plan §1.3 writer table — the sync update path rewrites category unconditionally today).

---

## 4. Recommended models (deliverable 4)

Adopt the persisted-tier plan §3 schema verbatim; summarized with amendments:

1. **`Merchant`** — identity only (canonicalKey, displayName, plaidEntityId, defaultCategory-informational). *Amendment (asset seed, see §6):* add nullable `website String?`, `logoUrl String?`, `enrichmentSource MerchantEnrichmentSource?` (`PLAID_COUNTERPARTY` initially), `enrichmentConfidence Float?`, `enrichedAt DateTime?`. Five nullable columns, no new table, no fetch pipeline — capture-class, since the source data flows through sync daily and is currently discarded.
2. **`MerchantAlias`** — as drafted.
3. **`MerchantRule`** — as drafted (scope USER live in M5; SPACE schema'd, writer/reader deferred to its own KD-19-proofed slice). GLOBAL deliberately absent — the global catalog stays in code.
4. **`Transaction` additive columns** — `categorySource CategorySource?` (nullable-no-default; null = "pre-MI, provenance unknown" — the MC1 Phase 0 doctrine), `categoryRuleId` (SetNull), `merchantId` (SetNull), indexes on both.
5. **Enum work** — `TransactionCategory` +6 (Medical, Entertainment, Transport, PersonalCare, Services, Education), each with a committed producer, in its own migration file (the one irreversible statement); `CategorySource`, `MerchantRuleScope`, `MerchantAliasSource`.
6. **Not models:** cadence/recurrence records (v2.6b, its own track), a `Category` lookup table (rejected — retypes the codebase for no approved goal), a `MerchantProviderId` table (single id-supplying provider today; additive later).

---

## 5. Recommended normalization pipeline — and where it belongs in the lifecycle (deliverable 5)

### 5.1 The transaction lifecycle, as-built

```
Provider (Plaid sync / CSV·Excel·QB import)
  → capture (buildPlaidFlowInput: merchant, entityId, pfc*, counterparties[in-memory])
  → category (mapPlaidCategory: PFC-structural > merchant rules > PFC-spend > legacy > Other)
  → flow (isLiabilityCardPaymentLeg rescue → classifyFlow)
  → persistence (create / update-by-plaidId / fingerprint-fallback; soft-delete + resurrection)
  → AI (assembler re-normalizes merchants per request; chat drilldowns; KD-18 rollup)
  → Dashboard (5 list surfaces, client-side search, subscriptions filter)
  → Daily Brief (totals only; merchant rollups excluded at scopeHint='brief')
  → Exports (raw merchant → transactions.csv, importer-compatible)
  → Notifications (none merchant-level today) → Receipts (nothing exists)
```

### 5.2 Where merchant normalization belongs: **at write time, with a version-gated backfill for history — not lazily on read, not post-processing, not (primarily) background**

- **During sync AND during import** (both, via one shared resolver — the import pipeline is already "the one compliant rewriter" for the flow contract and must not become the incompliant one for identity). Write-time is the repository's proven pattern: FlowType classified at write, backfilled once, cut reads over in slices, and closed certified. Identity resolution is cheaper than flow classification (three indexed lookups + an occasional insert) and rides the same write.
- **Not lazily on read.** Read-time re-derivation is this repository's *catalogued defect class* (KD-10/KD-11), and MI M6 exists to remove the one read-time normalization site that exists today. Lazy resolution also cannot power corrections ("apply to all from this merchant" needs persisted membership) or the alias ratchet (memory requires writes).
- **Not post-processing (deferred rewrite).** The desync initiative is the standing lesson: a window where two derived columns disagree on live dashboards is a real, audited failure mode. The persisted-tier plan chose synchronous reclassification through one shared helper (`buildCategoryRewrite`) over clear-and-drain for exactly this reason; identity should ride the same synchronous write.
- **Background enrichment is reserved for what is genuinely asynchronous:** Tier C asset fetch/refresh and future cadence detection — both naturally OPS-4 dispatcher registrations, neither on the row-write critical path.
- **History via the house backfill pattern** (dry-run default, `--apply`, keyset pagination, JSON rollback logs, idempotent re-run proves 0): M3 expanded-vocabulary category backfill (every write through `buildCategoryRewrite`, so it *cannot* recreate the desync seam), M4 dictionary backfill (pass 1 mints from distinct `merchantEntityId` — the forward seed pays off with no Plaid re-fetch; pass 2 canonicalKey grouping under minting guards; pass 3 stamps `merchantId`).
- **Normalizer consolidation rides M4 as a prerequisite refactor** (amendment — the evolution investigation's "most valuable thing" should be scheduled, not left "if timing allows"): keep both biases, but make `normalizeMerchantKey` a named, tested layer of `merchant.ts`'s vocabulary and delete the assembler's inline third normalizer.

---

## 6. Recommended enrichment pipeline (deliverable 6)

Three sources, in cost order:

1. **Plaid counterparty passthrough (now, in M4).** `counterparties[]` already arrives on every synced transaction with `name`, `entity_id`, `website`, `logo_url`, `confidence` — and is discarded. When M4's write-time resolution attaches/mints a Merchant, opportunistically fill the Merchant's `website`/`logoUrl`/`enrichmentConfidence` from the top counterparty **when its `entity_id` matches the row's `merchantEntityId`** (identity-safe join), stamping `enrichmentSource=PLAID_COUNTERPARTY`, `enrichedAt`. Refresh policy: overwrite only same-source with newer `enrichedAt`; never overwrite a higher-ranked source. Zero fetch pipeline, zero new infrastructure, capture-class (data flowing daily, currently destroyed).
2. **Background enrichment job (post-OPS-4, its own slice).** Favicon/logo fetch for merchants with a `website` but no `logoUrl`, registered on the OPS-4 dispatcher, ledgered per JobRun, bounded per run. Gated on an actual UI consumer existing (TI detail surface or a merchant view) — build it demand-pulled, the POS1 anti-navel-gazing rule.
3. **Editorial/curated (later).** Corrections to canonical names/domains for high-frequency merchants — a maintainer act (PR or admin surface), same doctrine as global-catalog promotion.

Categories are **not** enrichment — they stay in the resolution stack (§3). Brand colors have no consumer and no source; explicitly out (§12).

---

## 7. Storage strategy (deliverable 7)

| Asset | Strategy | Rationale |
|---|---|---|
| Canonical names, aliases | **Stored directly** (Merchant/MerchantAlias rows) | Identity is the product's own fact; must survive provider changes |
| Websites, logo URLs | **Externally referenced** (URL strings on Merchant), source+confidence+timestamp stamped | Matches the only in-repo precedent (`ProviderCatalog.logoUrl`); Plaid CDN URLs are stable enough for a pre-beta product; zero storage/egress cost; a broken image degrades to the existing no-logo rendering |
| Logo/favicon binaries | **Not stored, not cached — yet.** Revisit when (a) a UI consumer renders logos at scale and (b) OPS-4's dispatcher exists to host a fetch/refresh job. If/when cached: cache-aside with `enrichedAt`-based staleness, never a hard dependency of any read path | No blob substrate exists in the repo; inventing one for an unconsumed asset is premature infrastructure. Tradeoff acknowledged: external URLs leak a request to a third-party CDN per render and can rot — acceptable pre-beta, re-evaluate at beta with real traffic |
| Confidence / enrichment source | **Stored directly** next to the enriched value | The meta-intelligence doctrine (forms investigation Family D): every learned value carries who-said-so and how-sure |
| Refresh | Opportunistic at sync (source 1); scheduled via dispatcher (source 2) later. Never at read time | Read paths stay pure; the FxRate/append-only idiom |

---

## 8. Consumer inventory (deliverable 8)

**Existing consumers that improve immediately (M2–M6):** AI merchant/income rollups (M6 reads resolved `merchantId` groups — removes a re-derivation site, KD-10/KD-11 discipline); every transaction list surface ×5 (canonical `displayName` instead of `SQ *BLUE BOTTLE #442`); client search (matches canonical names); exports (a canonical-name column *added*, raw merchant kept for importer round-trip fidelity); the recurring-candidate heuristic (groups by real identity); the chat drilldown display names; category quality everywhere (enum expansion rescues six whole PFC buckets from `Other`).

**Designed near-term consumers:** TI P2–P4 detail surface (provenance display "why this category?" — the product-architecture doc's MVP trust feature — and the M5 correction loop as its designed join); Daily Brief (merchant rollups currently excluded at `scopeHint='brief'` can be re-admitted once they are resolved rows, not per-request derivations).

**Future consumers found in the repository (each names MI as input):** persisted cadence/recurring detection and subscription intelligence (v2.6b; the PlayStation trap needs identity × cadence); Ambient Intelligence (v2.6b — briefs that say "Netflix renewed" require identity); AiAdvice (`jobs/run-ai-advice.ts` stub, v2.6b entry criterion); budgeting/spending reports and merchant analytics (no code yet; every design doc routes them through the dictionary); Space-scope category overlay (schema'd in M1, own slice); notification producers (a future "large charge at <merchant>" producer would consume displayName); server-side transaction search (TI residual — canonical keys make it indexable); Receipt Intelligence (**no repo footprint**; if it ever exists, receipt→transaction matching would consume merchant identity — MI precedes it trivially); PO-track rollups (merchant-dimension platform analytics, post-POR1); the opportunity engine (no repo footprint).

---

## 9. Proposed implementation slices (deliverable 9)

**Adopt M0–M6 from the persisted-tier plan, with three amendments:**

| Slice | Content (delta from the plan in bold) | Gate |
|---|---|---|
| M0 | Decision ratification + `MI-x`/`docs/initiatives/mi1/` allocation. **Amendment 1: explicitly ratify the classifier version-gate input-blindspot fix into M1/M2 scope** (STATUS names it an open MI entry-gate item; it is a design decision about when category-changes re-enter classification — exactly M2's territory) | Decision record; STATUS §4 allocation |
| M1 | Two migrations (enum ×6 in its own file; Merchant/MerchantAlias/MerchantRule + 3 Transaction columns) + `SPEND_CATEGORIES` companion. **Gate update: the plan's MC1-Phase-0 and desync-remediation entry gates are already satisfied** (MC1 complete; corpus certified 2026-07-06) — restate as "flow-desync audit green at M1 entry" (`npm run audit:flow-desync`) | Additive-neutrality proof (tsc, zero consumer edits) |
| M2 | `resolveCategoryWithSource`; PFC bucket expansion + Groceries rider; all writers stamp; clobber matrix in sync/import; `buildCategoryRewrite` helper; retrofit legacy scripts. Closes the rewrite-invalidation contract structurally | Precedence + matrix unit tests; override survives forced Plaid `modified` |
| M3 | Expanded-vocabulary backfill via the rewrite helper | Dry-run review; desync count = 0; idempotent re-run |
| M4 | Dictionary write-time resolution + backfill (entityId → alias → canonicalKey → guarded mint). **Amendment 2: normalizer consolidation as M4's entry refactor (promoted from "if timing allows"), and Plaid-counterparty asset passthrough (§6.1) rides M4's capture path** | Integrity counts; minting-guard proof; byte-identical AI context |
| M5 | Overrides + user rules + provenance badge. **Amendment 3: hard-gated on TI P2 (detail overlay) existing as host** — the TI-vs-MI investigation identified M5-into-a-list-row as the only proven rework path in either ordering | SP-2 auth; audit entries; two-user privacy proof |
| M6 | AI read cutover to resolved merchant groups | Byte-comparison harness |
| Deferred, unchanged | Space overlay · cadence (v2.6b) · logo fetch job (post-OPS-4) · enrichment beyond passthrough · catalog promotion analytics | — |

---

## 10. Complexity assessment (deliverable 10)

| Slice | Schema | Code | Effort | Risk |
|---|---|---|---|---|
| M0 | — | doc | trivial | none |
| M1 | 2 migrations, 3 tables, 3 cols, 4 enums | classifier set + tests | small | low (enum file isolated — the one irreversible piece) |
| M2 | — | mapper sibling, rewrite helper, 2 write paths, 2 script retrofits | **medium-high — the initiative's core** | medium (clobber matrix correctness; mitigated by pure rules-as-data tests) |
| M3 | — | 1 backfill | small | low (house pattern, rollback logs) |
| M4 | — | resolver + 2 write-path wirings + 3-pass backfill + normalizer consolidation | medium-high | medium (minting guards = PII boundary) |
| M5 | — | 2 endpoints + UI affordance in TI's surface | medium | medium (auth/privacy proofs; UX) |
| M6 | — | assembler cutover | small-medium | low (byte harness) |

Comparable in total to FlowType P1–P5 — a known, completed quantity. Nothing here approaches MC1's scope. M1–M4 are runnable as a second track (schema-owning, file-disjoint from OPS/PO work); M5–M6 want dedicated attention.

## 11. Risks (deliverable 11)

1. **Enum irreversibility** — 6 values can never be dropped; mitigated by the admission rule, own migration file, and each value having a committed producer.
2. **Clobber-matrix drift** — if any writer implements preservation privately instead of through the helper, corrections die silently; mitigated by encoding once + guard tests + the `categorySource` null-count tripwire.
3. **PII minting** — person names becoming global Merchant rows; mitigated by the flow-gated minting guards + M4's zero-minted-from-transfer proof; residual risk in mislabeled-flow rows is bounded by FlowType's certified corpus.
4. **WIP-limit pressure** — the master plan's limit is 2 active initiatives, one schema owner. OPS-4 owns one narrow model (`JobRun`); MI owns transaction-domain schema. Compatible, but a *third* track is not — TI P2 must wait for an OPS-4 or MI slice boundary.
5. **Dirty tree at open** — OPS-1 S4–S6 is uncommitted right now; the master plan's rule ("no initiative starts while the tree is dirty") applies. Cheap to clear, real if ignored.
6. **STATUS drift** — the Current-focus section predates OPS-2/OPS-3 completion and the runway line omits both OPS-4 and MI; opening MI against a stale runway invites the exact ledger-drift class the STATUS-supremacy rule exists to stop. M0's STATUS row should fix the runway in the same PR.
7. **Merge-vs-split identity errors** — over-merge in a financial ledger is worse than under-merge; the conservative doctrine (exact-key resolution only, refusal on alias ambiguity) is the mitigation, and it is already codified in three documents.
8. **Scope gravity toward enrichment/UI** — logos and merchant pages are attractive and unconsumed; the §12 non-goals and the demand-pulled rule are the fence.

## 12. Explicit non-goals (deliverable 12)

No fuzzy/ML merchant clustering. No LLM in the resolution path (detectors may propose later, v2.6b, under the ratchet; never in M0–M6). No `MerchantAsset` table, no binary/blob storage, no favicon fetch pipeline in this initiative. No brand colors. No cadence/recurring/subscription detection (v2.6b track). No Space-overlay *behavior* (schema only). No GLOBAL rules in the database (catalog stays in code). No user-defined categories / no `Category` lookup table. No merchant analytics surfaces. No cross-deployment/shared dictionary. No flow-semantics changes of any kind — `classifyFlow` remains the single authority and MI never writes `flowType` directly. No Plaid re-fetch for backfills (the `merchantEntityId` seed exists precisely so history resolves offline).

---

## 13. Recommended roadmap position — and the answer to the final question (deliverable 13)

### 13.1 Dependencies with the named future initiatives

- **MI → Transaction Intelligence:** not a chain — a *designed interleave*. TI P1 already shipped (before MI). TI P2–P3 are read-only/zero-schema and file-disjoint from MI M1–M4; MI M5 ships into TI P2's surface. Delaying MI would leave TI P4 ("AI actions", provenance display) with no merchant data to render; delaying TI P2 past M4 would force M5 into the list-row stopgap — the one proven rework path.
- **MI → Receipt Intelligence:** Receipt Intelligence does not exist in this repository in any form. If chartered someday, receipt↔transaction matching would want merchant identity + the TI detail surface as host. MI naturally precedes it; nothing about it constrains MI.
- **MI → Ambient Intelligence:** real dependency, in MI's favor. v2.6b's flagship (persisted cadence, briefs that name merchants, AiAdvice) consumes the dictionary; building Ambient on per-request string normalization would re-create the defect class MI removes. MI before v2.6a/v2.6b is the correct order and is what every roadmap document already says (v2.5.5 "Financial Semantics" window).
- **MI → PO1:** the prompt's chain puts PO1 last; the repository puts PO1 *early* (STATUS runway; master plan: telemetry loss is irreversible daily; v2.6b exit criteria are unmeasurable without the rollup layer). MI and PO1 are file-disjoint and non-competing — PO1 P0's event grammar should exist before M5 coins its override/rule audit events, which is an argument for PO1-P0-first, not MI-later.
- **MI ← OPS-4:** MI M0–M4 need nothing from OPS-4. Only the deferred enrichment job and future cadence detection want the dispatcher. OPS-4's own investigation (§12) asks for OPS-1 S4–S6 first (now in the tree, uncommitted) and permits parallel work explicitly.

### 13.2 Should Merchant Intelligence become the next major initiative after OPS-1/OPS-4?

**Yes as the next major *product* initiative — no as a serialized successor.** The precise recommendation:

1. **Commit the OPS-1 S4–S6 tree** (dirty-tree rule), close OPS-1's small residuals (S9 legal / S10 beta gate can trail per OPS-4 §12).
2. **Open MI M0 immediately** — doc-only, requires nothing, and fixes the STATUS runway drift in the same PR. Ratify PO1 P0 (event grammar) alongside, per the master plan's Rev B ruling.
3. **Run MI M1–M4 as the schema-owning second track in bounded parallel with OPS-4 implementation** (S1–S6). File-disjoint, both additive, within the WIP limit. This is the master plan's own runway (positions ④–⑥), already written to be ratified.
4. **Interleave TI P2–P3 at an OPS-4/MI slice boundary; ship M5 into TI's detail surface; M6 closes the initiative.** Private beta stays gated on the OPS floor + PO1 capture — never on MI.

**Are architectural prerequisites still missing? No.** Every gate the MI plan named in July 5's design has since been satisfied or absorbed: MC1 complete (Phase 0 gate ✅), desync corpus certified with a permanent audit (entry cleanliness ✅), FlowType single authority (✅), TI P1 serializer/endpoint (M5's host *foundation* ✅ — P2 remains, and is sequenced above), test runner + CI (✅), `merchantEntityId` seed accumulating (✅). The two items STATUS still lists as "open MI entry-gate items" — the rewrite-invalidation contract and the version-gate input-blindspot — are not missing prerequisites; they are MI M2's own deliverables and should be ratified as such at M0. The only things standing between the repository and M1 are a commit, a ratification document, and a STATUS row.

**Where the roadmap deserves to be challenged:** the STATUS runway line ("OPS-1 → PO1 → Platform Facts → Rollups → Platform Operations → Private Beta") is the *operational* lane only — read literally, it would idle the product lane for the entire pre-beta window and serialize MI behind four platform initiatives it shares no files with. The Portfolio Master Plan already corrected this (bounded parallel, two lanes, MI M0–M2 riding second-track) but was never ratified into STATUS §3/§5 — the runway drift is visible in STATUS's own Current-focus section, which still predates OPS-2/OPS-3. Ratifying the master-plan runway (or at minimum adding MI to the upcoming line as the parallel product track) is the single roadmap correction this investigation recommends.

---

*Sources (all verified in-tree at `2486b5f` + working tree, 2026-07-07): `prisma/schema.prisma` (Transaction ~1241–1322, SyncIssue ~1660, ProviderCatalog precedent) · `lib/transactions/{merchant,merchant-rules,plaid-category,plaid-flow-input,fingerprint,flow-classifier,serialize,detail-query}.ts` · `lib/plaid/syncTransactions.ts` · `lib/imports/csv.ts` · `lib/ai/assemblers/transactions.ts` (lines 504, 563, 644, 1123) · `lib/ai/types.ts` (419, 626–639) · `lib/export/{csv,zip,assemble}.ts` · `app/api/{brief,transactions/[id],accounts/[id]/import,accounts/[id]/transactions,spaces/[id]/transactions}` routes · `components/dashboard/BankingClient.tsx` (201, 550) · `lib/notifications/*` · `jobs/*` · STATUS.md (FlowType, MC1, OPS-1 ledger rows; §5–§6) · git log `f809819..2486b5f` + `git status` · the nine investigation/plan documents listed in the header.*
