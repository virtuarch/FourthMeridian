> **INVESTIGATION + DESIGN ONLY — no implementation, no schema change, no migration, no code, and no doc-of-record update is made by this document.** Verified against the working tree at STATUS.md checkpoint `f22de52` (FlowType P5 complete; Merchant Intelligence foundation Slice 1 landed). Per project rule, the next step is approval of this plan — and the MC1 Phase 0 landing gate (§2.4) — then Slice M1.

# Merchant Intelligence — Persisted Tier — Architecture & Slice Plan

**Date:** 2026-07-05
**Branch context:** `feature/v2.5-spaces-completion`; MC1 Phase 0 implementation is running in parallel and **must land before any MI schema or backfill work begins** (§2.4).
**Prior art this design builds on (re-verified, not assumed):** `docs/investigations/MERCHANT_INTELLIGENCE_LAYER_INVESTIGATION.md` (2026-07-04), `MERCHANT_NORMALIZATION_EVOLUTION_INVESTIGATION.md` (Tier A/B/C model), `MERCHANT_INTELLIGENCE_SLICE1_CHECKLIST.md`, `docs/initiatives/flowtype/P5_CLOSEOUT_INVESTIGATION_2026-07-05.md` (§5 MI readiness + the rewrite-invalidation contract), `docs/investigations/NEXT_INITIATIVE_AND_ROUTER_E668_INVESTIGATION_2026-07-05.md` (§A runway), `docs/initiatives/mc1/MC1_PHASE0_CURRENCY_PROVENANCE_PLAN.md` (provenance-column doctrine).

---

## 0. Executive summary

Merchant Intelligence Slice 1 (the pure, curated global catalog in `lib/transactions/merchant-rules.ts`) rescued recognizable merchants from `Other`, but it is deliberately capped: it cannot remember, cannot be corrected, cannot scope to a user or Space, and is blocked by a category vocabulary with no Medical/Entertainment/Transport/Education. The persisted tier adds the four missing capabilities in order of dependency: **provenance** (`categorySource` — who set this category, so re-runs never clobber corrections), **vocabulary** (the `TransactionCategory` enum expansion decision), **identity** (`Merchant` + `MerchantAlias` — the Tier B dictionary keyed on Plaid `merchant_entity_id` with `normalizeMerchant` as fallback), and **correction** (row-level user overrides + persisted `MerchantRule` rows scoped to user, with Space scope schema'd but deferred).

Three contracts bind the whole design:

1. **Category is the only output; flow is derived.** `classifyFlow` remains the single flow authority. No merchant rule, override, or backfill ever writes `flowType` directly.
2. **The category-rewrite invalidation contract** (P5 closeout §5): *any* write that changes `category` reclassifies flow synchronously through one shared helper. The existing merchant backfill violates this; the persisted tier would violate it at scale, so the helper is built before any persisted rewrite exists.
3. **Provenance before rewriting** (the MC1 Phase 0 doctrine applied to categories): `categorySource` is nullable-no-default, null means "pre-MI, provenance unknown," and every automatic writer's authority to overwrite is rank-gated by the current source. A forgotten writer produces nulls that a one-line count surfaces — it can never silently manufacture provenance or destroy a user correction.

The first implementation slice after MC1 Phase 0 lands is **M1 — schema foundation** (§8.3): two additive migrations (enum expansion; Merchant/MerchantAlias/MerchantRule + the two provenance columns + the `merchantId` FK), companion classifier-set updates, zero writers, zero readers, trivially rollback-safe.

---

## 1. Current state — verified inventory (2026-07-05)

### 1.1 What exists

| Piece | Location | Status |
|---|---|---|
| Global merchant→category catalog (pure, code) | `lib/transactions/merchant-rules.ts` — 15 ordered rules + 10-brand subscription allowlist; `resolveMerchantCategory()` | Live in the forward mapper since Slice 1 |
| Forward category mapper | `lib/transactions/plaid-category.ts` `mapPlaidCategory()` — detailed overrides → flow-structural primaries → **merchant rules** → spend primaries → legacy array → `Other` | Live; merchant rules sit *below* flow-structural PFC by design |
| Card-payment-leg rescue | `isLiabilityCardPaymentLeg()` (same module) — descriptor + account-side + sign guard, applied before `classifyFlow` on sync and backfill | Live; deliberately NOT a merchant rule |
| Tier A normalizer | `lib/transactions/merchant.ts` `normalizeMerchant()` → `{canonicalKey, canonicalName}` | Read-time only; sole consumer is the AI assembler rollup |
| Dedup normalizer (separate) | `lib/transactions/fingerprint.ts` `normalizeMerchantKey()` | Sync fingerprint + CSV match; intentionally different bias; known KD-11-class duplication |
| Merchant identity forward seed | `Transaction.merchantEntityId` (Plaid `merchant_entity_id`) | **Written by `buildFlowWriteFields` since P2/P3, never read** — enables dictionary backfill with no Plaid re-fetch |
| Historical backfill | `scripts/backfill-merchant-categories.ts` — Other→rule category, dry-run default, rollback log, idempotent | Ran; **leaves `flowType`/`classifierVersion` untouched** (the desync seam) |
| Flow backfill | `scripts/backfill-flowtype.ts` — `classifierVersion`-gated, idempotent | The house backfill pattern MI adopts |
| FlowType | Complete (P5): `classifyFlow` is the single semantic authority; `SPEND_CATEGORIES` / flow-value categories hardcoded in the classifier | Binding: new enum values not added to the classifier's sets fall to honest `UNKNOWN` |

### 1.2 What does not exist

No `Merchant` / `MerchantAlias` / `MerchantRule` model. No `categorySource` or any category provenance. No user or Space override of any kind — `SpaceTransactionsPanel` renders `tx.category` raw with no edit affordance. No category writer records *why* a category is what it is; `pfcPrimary`/`pfcDetailed` (persisted since P3) are the only reconstruction evidence.

### 1.3 Every writer of `Transaction.category` (grep-verified)

| # | Writer | Paths that set/change category | MI obligation |
|---|---|---|---|
| 1 | Plaid sync — `lib/plaid/syncTransactions.ts` | shared `fields` object feeds **create**, **update-by-plaidId** (Plaid `modified`), and fingerprint-update | Stamp source on create; **preserve user-tier category+source on updates** (clobber risk today: a Plaid `modified` event rewrites category unconditionally) |
| 2 | Import pipeline — `app/api/accounts/[id]/import/route.ts` | create (~L357) and QuickBooks update-on-match (~L403–411); **already reclassifies flow on category change** (the one compliant rewriter) | Stamp `IMPORT`; update-on-match must not overwrite user-tier rows |
| 3 | CSV/Excel keyword mapping — `lib/imports/csv.ts` / `excel.ts` | produces the category the route writes (only producer of `Groceries` today) | Source = `IMPORT` (stamped by the route, not the parser) |
| 4 | `scripts/backfill-merchant-categories.ts` | raw UPDATE of category only | Retrofit to the rewrite helper (§5); guard on source rank |
| 5 | `scripts/reclassify-subscriptions.ts` | raw UPDATE (Other→Subscriptions era tool) | Same retrofit or retire |
| 6 | `scripts/backfill-cc-payment-categories.ts` | raw UPDATE (CC-1 rescue backfill) | Same retrofit if re-run; historical runs predate provenance (null is the honest stamp) |
| 7 | `prisma/seed.ts` | dev-only rows | Stamp for hygiene, non-blocking (mirrors its missing-flow debt) |
| 8 | `app/api/imports/[id]/rollback/route.ts` | soft-deletes only (deletedAt), no category write | None |

Writers 1, 2, and 4 are where user corrections die if provenance doesn't exist. That is why `categorySource` precedes overrides in the slice order.

---

## 2. Binding constraints and entry gates

### 2.1 FlowType P5 is complete — what that fixes in place

`classifyFlow` needs **no API or semantic change** for MI (P5 closeout §5, re-verified): merchant/description are accepted inputs used by zero rules, merchant identity cannot leak into flow. What MI *does* touch: the classifier's `SPEND_CATEGORIES` set must learn every new enum value in the same slice that creates the value, or rows carrying it classify `UNKNOWN` (flow-classifier.ts step 5 — honest but wrong). The `classifierVersion` gate is the reclassification mechanism MI reuses; `FLOW_CLASSIFIER_VERSION` bumps only if classifier *behavior for existing inputs* changes (adding new categories to `SPEND_CATEGORIES` does not change any existing row's output, so no bump — new-category rows are classified at rewrite time by the contract helper).

### 2.2 The category-rewrite invalidation contract (entry-gate design rule)

Adopted verbatim from P5 closeout §5: **any category rewrite must reclassify flow synchronously (or clear `classifierVersion` for the flow backfill to drain).** This plan chooses *synchronous reclassification through one shared helper* (§5.1) because clearing-and-draining leaves a window where category and flow disagree on live dashboards. Precondition (already in the pre-MI runway, not this initiative): the one-time desync remediation over rows the Slice-1 backfill rewrote — verify first with `SELECT count(*) FROM "Transaction" WHERE category='Fee' AND "flowType"='SPENDING'`, then re-run `backfill-flowtype.ts --apply` scoped to the rewritten predicate. MI's M1 assumes a clean baseline.

### 2.3 The enum is a binding constraint

The Slice-1 held-out merchants (pharmacies, clinics, Vox Cinema, Six Flags, USPS, car washes, transit) are blocked solely by missing categories. Additionally — verified in this investigation — `mapPlaidCategory` collapses six entire PFC spend primaries (`MEDICAL`, `ENTERTAINMENT`, `TRANSPORTATION`, `PERSONAL_CARE`, `GENERAL_SERVICES`, `HOME_IMPROVEMENT`) to `Other` via its `default` arm, while the flow classifier already recognizes all six as spend buckets. Enum expansion therefore rescues whole provider buckets, not just curated merchants. Decision framework in §3.6.

### 2.4 MC1 Phase 0 gate

**No MI migration or backfill runs until MC1 Phase 0 Slices 1–3 (schema, writers, currency backfill) have landed and been verified.** Rationale (MC1 plan §6, honored here): serialized one-initiative-at-a-time migrations, each independently rollback-trivial; and MI's backfills rewrite rows at scale — running them over currency-stamped rows costs nothing, running them before enlarges the unstamped surface. **Exempt from the gate:** Slice M0 (decisions, doc-only) may proceed in parallel with MC1 Phase 0 — it changes nothing. MI does not read or write `currency`; the only touchpoint is sequencing.

### 2.5 Doctrine carried forward unchanged

Merchant rules output **spend/merchant-meaningful categories only** — never flow-structural values (`Income`/`Transfer`/`Payment`/`Interest`). Flow-structural PFC primaries continue to beat merchant rules in the automatic chain (`plaid-category.ts` step 2 vs step 3 — preserved). The single carve-out is the **human row-level override** (§3.4), which may set any category because it is an explicit correction, not a merchant-text inference — and flow still follows through the classifier, preserving single authority.

---

## 3. Architecture

### 3.1 The resolution stack

```
                      write path (sync / import)                    correction path (user)
                      ───────────────────────────                   ──────────────────────
 provider payload / file row                                        PATCH override endpoint
          │                                                                  │
          ▼                                                                  ▼
 ┌────────────────────────────────────────────┐              ┌──────────────────────────────┐
 │ Merchant resolution (M4)                   │              │ category-rewrite helper (M2) │
 │  1. plaidEntityId → Merchant               │              │  category + categorySource + │
 │  2. alias key     → Merchant               │              │  synchronous classifyFlow    │
 │  3. canonicalKey  → mint/attach            │              └──────────────────────────────┘
 └────────────────────────────────────────────┘                             │
          │ merchantId                                                      │
          ▼                                                                 │
 ┌────────────────────────────────────────────┐                             │
 │ Category resolution (pure, rules-as-data)  │                             │
 │  flow-structural PFC  (unchanged, step 2)  │                             │
 │  > USER MerchantRule  (persisted, M5)      │                             │
 │  > GLOBAL catalog     (code, unchanged)    │                             │
 │  > PFC spend buckets  (expanded, M2)       │                             │
 │  > legacy array > Other                    │                             │
 └────────────────────────────────────────────┘                             │
          │ category + categorySource (+ categoryRuleId)                    │
          ▼                                                                 ▼
   classifyFlow (unchanged single authority) ──────────────► flow columns on the row
```

Space-scope rules exist in schema but resolve at **read time** as an overlay, never as a row write (§3.7).

### 3.2 `Merchant` model

The Tier B dictionary (evolution investigation §4), deliberately minimal — identity only; enrichment and behavioral fields are explicitly excluded (§9).

```prisma
model Merchant {
  id            String   @id @default(cuid())
  /// Fallback identity: normalizeMerchant(raw).canonicalKey. Unique — one
  /// dictionary row per canonical key. Tier A mints it; the dictionary owns it.
  canonicalKey  String   @unique
  /// Canonical human label (Plaid merchant_name preferred over raw descriptor).
  displayName   String
  /// Preferred identity when present: Plaid merchant_entity_id. Single-column
  /// (not a provider-id table) because exactly one provider supplies ids today;
  /// generalizing to a MerchantProviderId table is additive if/when a second
  /// id-supplying provider lands (MC1 Phase 7 territory).
  plaidEntityId String?  @unique
  /// The merchant's dominant category — informational default, NOT a rule.
  /// Nullable; populated opportunistically. Rules and PFC always outrank it;
  /// it exists for display and future Brief/AI copy, not for the resolver (M4
  /// resolver ignores it — recorded so scope cannot creep).
  defaultCategory TransactionCategory?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  aliases       MerchantAlias[]
  rules         MerchantRule[]
  transactions  Transaction[]  @relation("TransactionMerchant")
}
```

**Scoping decision — Merchant rows are deployment-global, not per-user.** Merchant identity is universal (the same doctrine that scoped the code catalog). User-specific *meaning* lives in `MerchantRule`/overrides, never on the Merchant row. Guards that make global minting safe:

- **PII deny-list (hard constraint, from the evolution investigation §3):** counterparty account/routing identifiers and person names must not become Merchant rows. Minting is gated: auto-mint only for rows with a `plaidEntityId`, or rows whose `flowType ∈ {SPENDING, REFUND, FEE, INTEREST}`; rows with `TRANSFER`/`DEBT_PAYMENT`/`INCOME`/`UNKNOWN` flow do **not** auto-mint (Zelle/Venmo/payroll descriptors routinely embed person names). Income-source identity stays a read-time rollup (as today) until a deliberate, deny-listed design exists.
- **Conservative merge:** identity attaches by exact `plaidEntityId`, exact alias key, or exact `canonicalKey`. No fuzzy clustering, ever, in this initiative.

### 3.3 `MerchantAlias` model

Resolves "same merchant, many descriptors" — the thing a pure function structurally cannot (no memory).

```prisma
enum MerchantAliasSource {
  PLAID   // observed on a Plaid-synced row
  IMPORT  // observed on an imported row
  USER    // user attached this descriptor to this merchant ("this is also Amazon")
}

model MerchantAlias {
  id         String   @id @default(cuid())
  merchantId String
  merchant   Merchant @relation(fields: [merchantId], references: [id], onDelete: Cascade)
  /// normalizeMerchant(raw).canonicalKey of the observed descriptor. Globally
  /// unique: one descriptor key resolves to exactly one merchant — ambiguity is
  /// resolved by refusing to create the second mapping, not by guessing.
  aliasKey   String   @unique
  /// One raw sample for diagnostics/UI ("SQ *BLUE BOTTLE #442").
  rawSample  String
  source     MerchantAliasSource
  createdAt  DateTime @default(now())
  lastSeenAt DateTime @updatedAt
  @@index([merchantId])
}
```

Note the Merchant's own `canonicalKey` is effectively its primary alias; `MerchantAlias` holds the *additional* keys (rail-variant descriptors, USER attachments). Resolution order: `plaidEntityId` → `aliasKey` → `canonicalKey` → mint (subject to §3.2 guards).

### 3.4 `MerchantRule` + the row-level override model

Two distinct correction mechanisms, deliberately not one:

**A. Row-level user override** — "this transaction is X." Stored **on the row** (no new table): `category` rewritten through the M2 helper, `categorySource = USER_OVERRIDE`. Any category value is permitted, including flow-structural ones (an explicit human correction of a misfiled transfer is legitimate; flow follows category through the classifier, so single-authority holds). Original provider truth remains reconstructable from persisted `pfcPrimary`/`pfcDetailed` + `mapPlaidCategory` — no shadow "previousCategory" column needed, and the override endpoint's audit-log entry records the from→to for the append-only audit trail.

**B. Persisted `MerchantRule`** — "transactions from this merchant are X." Automatic, merchant-matched — therefore restricted to spend/merchant-meaningful categories (the §2.5 doctrine), enforced in the rule-creation endpoint and asserted in tests.

```prisma
enum MerchantRuleScope {
  USER   // one user's meaning for a merchant (M5 writer)
  SPACE  // one Space's meaning — schema'd now, writer/reader deferred (§3.7)
}

model MerchantRule {
  id         String            @id @default(cuid())
  merchantId String
  merchant   Merchant          @relation(fields: [merchantId], references: [id], onDelete: Cascade)
  scope      MerchantRuleScope
  /// Exactly one of userId/spaceId set, matching scope (CHECK-style invariant
  /// enforced in the write path + a guard test; Prisma can't express it).
  userId     String?
  user       User?             @relation(fields: [userId], references: [id], onDelete: Cascade)
  spaceId    String?
  space      Space?            @relation(fields: [spaceId], references: [id], onDelete: Cascade)
  category   TransactionCategory
  active     Boolean           @default(true)
  createdByUserId String
  createdAt  DateTime          @default(now())
  updatedAt  DateTime          @updatedAt
  deletedAt  DateTime?         // D8 soft-delete
  @@unique([merchantId, scope, userId, spaceId])
  @@index([userId, active])
  @@index([spaceId, active])
}
```

The override→rule loop: correcting a row offers "apply to all from this merchant," which (a) creates/updates the USER-scope rule and (b) re-resolves that merchant's other rows *through the rank guard* (§3.8) — rows the user individually overrode are untouched. GLOBAL scope is deliberately **absent** from the enum: the global catalog stays in code (§3.7).

### 3.5 `categorySource` provenance

The load-bearing column — everything else (safe re-runs, sticky corrections, honest UI badges) hangs off it.

```prisma
enum CategorySource {
  PROVIDER       // mapPlaidCategory PFC/legacy path (incl. the CC-1 rescue)
  GLOBAL_RULE    // curated code catalog (merchant-rules.ts)
  USER_RULE      // persisted MerchantRule scope=USER
  SPACE_RULE     // persisted MerchantRule scope=SPACE (no writer until the Space slice)
  USER_OVERRIDE  // explicit row-level correction
  IMPORT         // CSV/Excel keyword mapping via the import pipeline
}

// Transaction — additive columns (after merchantEntityId / MC1 currency):
categorySource CategorySource?   // null = pre-MI row; provenance unknown
categoryRuleId String?           // the MerchantRule that produced it, when one did
categoryRule   MerchantRule?     @relation(fields: [categoryRuleId], references: [id], onDelete: SetNull)
merchantId     String?           // Tier B dictionary FK (written from M4)
merchantRef    Merchant?         @relation("TransactionMerchant", fields: [merchantId], references: [id], onDelete: SetNull)
@@index([merchantId])
@@index([categorySource])
```

**Nullable, no default — deliberately mirroring MC1 Phase 0 §3.2, for the same three reasons:** null must mean "unknown, pre-MI," not a manufactured claim (we genuinely cannot distinguish which historical rows got their category from PFC vs the legacy array vs a Slice-1-era backfill); writer gaps stay loudly detectable by a one-line null count on post-M2 rows; and no backfill "drains" it with assertions — provenance for old rows is simply unknown, and that *is* their provenance. The only derivable historical stamps come from the Slice-1 backfill's own rollback logs (`scripts/.backfill-logs/*.json` — those row ids provably got `GLOBAL_RULE`); stamping from the logs is an optional, evidence-based mini-backfill, not a requirement.

`onDelete: SetNull` on `categoryRuleId` mirrors the `importBatchId`/`counterpartyAccountId` precedent: deleting a rule degrades the pointer, never the transaction; the category value itself survives (with its source rank) until something re-resolves it.

### 3.6 Category enum expansion — the decision

**Recommendation: expand the enum (Option A), with a hard admission rule.** Alternatives rejected: a `Category` lookup table (Option C) re-types the entire codebase — every writer, the classifier, four UI filter dropdowns, the CSV keyword map, the annotations sets — for zero user-visible gain at this stage, and user-*defined* categories are not a product goal on any approved roadmap; a `subcategory String` sidecar (Option B) creates a second, weaker vocabulary that every consumer would have to merge with the first — the KD-11 drift pattern by construction.

**Admission rule:** a value enters the enum only with (a) a committed producer in the same initiative (a PFC bucket mapping or a curated rule) and (b) its classifier/consumer updates riding the same slice. Postgres enum values are effectively **irreversible** (`ALTER TYPE … ADD VALUE` cannot be dropped without a type rebuild), so the enum only ever grows — add nothing speculative.

**Recommended set (6 values), each with its producer:**

| New value | Producer at M2 | Unblocks (Slice-1 held-outs) |
|---|---|---|
| `Medical` | PFC `MEDICAL` primary | pharmacies, clinics pattern-family |
| `Entertainment` | PFC `ENTERTAINMENT` primary | Vox Cinema, Six Flags, Speedzone |
| `Transport` | PFC `TRANSPORTATION` primary | transit/trolley, car services |
| `PersonalCare` | PFC `PERSONAL_CARE` primary | salons, gyms bucket |
| `Services` | PFC `GENERAL_SERVICES` primary | USPS (postal), car washes, professional services |
| `Education` | curated rules + PFC detailed `GENERAL_SERVICES_EDUCATION` | tuition-class merchants (WGU stays a USER rule, but the vocabulary must exist) |

Explicitly **not** added: `Auto` (parts→Shopping exists, services→`Services`, fuel→PFC `TRANSPORTATION`→`Transport` — no orphaned producer), `Home`/`HOME_IMPROVEMENT` (→ `Shopping`/`Services` for now; add later if a real rule needs it), `Government` (→ `Services`/`Fee`; revisit with real data). **Rider fix (same slice, flagged for ratification):** map PFC detailed `FOOD_AND_DRINK_GROCERIES` → `Groceries` — the enum value exists today but the Plaid path can never emit it (investigation §4.2); this is a two-line mapper change that makes an existing value real.

**Consumer-impact inventory for every new value (all ride M1/M2, none optional):** `flow-classifier.ts` `SPEND_CATEGORIES` (M1 — else `UNKNOWN` flow); `mapPlaidCategory` spend-bucket switch (M2); `BANKING_CATEGORIES` ×2 (`lib/data/transactions.ts`, assembler `resolveCategory`) (M2); annotations discretionary/semi/fixed sub-classing sets (M2 — decide each value's class: Medical=fixed-ish, Entertainment=discretionary, Transport=semi, PersonalCare=discretionary, Services=semi, Education=fixed); UI category filter dropdowns ×4 (`BankingClient`, `DebtClient`, `AccountModal`, `SpaceTransactionsPanel`) (M2); CSV keyword map additions (M2, optional); chat serializer needs nothing (its exclusion set is flow-derived since P5 Slice 6).

### 3.7 Global vs user vs Space rules — where each lives and why

| Tier | Store | Rationale |
|---|---|---|
| **Global** | **Code** (`merchant-rules.ts`), unchanged | Git-reviewed, deterministic, `tsx`-testable with zero DB; the curation bar ("no dumping ground") is enforced by code review; a DB copy would create a second authority that drifts. Promotion of high-frequency user rules into the catalog stays a *maintainer* act (a PR), not a runtime mechanism. |
| **User** | `MerchantRule` scope=USER | Real user data; must persist; powers the learning loop. Applies wherever that user's identity owns the row's connection. |
| **Space** | `MerchantRule` scope=SPACE — **schema now, writer/reader deferred to its own slice** | A Transaction row is shared into multiple Spaces via `SpaceAccountLink`; the single stored `category` column cannot hold two Spaces' truths simultaneously. A Space recategorization is therefore a **read-time overlay** (applied in the data layer/assembler for that Space's views), never a row write. That overlay touches KD-19-guarded read paths and deserves its own slice with its own privacy proof. Shipping the enum + columns now costs one migration and prevents later churn; shipping the behavior now would be rushed. |

### 3.8 Override precedence — the rank order and the clobber matrix

Rank (highest wins): **USER_OVERRIDE > SPACE_RULE (read-overlay only) > USER_RULE > GLOBAL_RULE > PROVIDER = IMPORT > null.**

Within the *automatic write-path* chain, flow-structural PFC primaries continue to outrank merchant rules of every scope (§2.5) — a merchant string never overrides income/transfer/loan/fee structure; only a human override can.

The clobber matrix — who may overwrite whom (row's current `categorySource` → writer):

| Row's current source ↓ / Writer → | Plaid sync update | Import update-on-match | Rule application / backfill (GLOBAL) | Rule application (USER) | User override |
|---|---|---|---|---|---|
| `null` (pre-MI) | ✅ | ✅ | ✅ | ✅ | ✅ |
| `PROVIDER` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `IMPORT` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `GLOBAL_RULE` | ⚠️ only if re-resolution still yields GLOBAL_RULE-or-better | same | ✅ (idempotent re-run) | ✅ | ✅ |
| `USER_RULE` | ❌ preserve | ❌ preserve | ❌ | ✅ (rule owner's re-resolution) | ✅ |
| `USER_OVERRIDE` | ❌ preserve | ❌ preserve | ❌ | ❌ | ✅ (the user again) |

"Preserve" concretely: the sync `fields` object and the import update-diff **exclude** `category`/`categorySource`/`categoryRuleId` when the existing row's source is user-tier — the same surgical-exclusion pattern MC1 Phase 0 specifies for `currency` in `computeQuickBooksUpdateDiff`. This matrix is encoded once, in the rewrite helper (§5.1), and guard-tested; no writer implements it privately.

### 3.9 FlowType interplay — the one shared helper

`lib/transactions/category-rewrite.ts` (M2): a single function every category-changing site calls —

```
buildCategoryRewrite({ row, newCategory, source, ruleId? }) →
  { category, categorySource, categoryRuleId,
    flowType, flowDirection, classificationConfidence,
    classificationReason, classifierVersion }        // via classifyFlow + buildFlowWriteFields
```

Pure (rules-as-data, row fields in) so it tests under `tsx` with no DB. Call sites: the override endpoint (M5), rule application/re-resolution (M5), every category backfill from M3 on, and the retrofit of `backfill-merchant-categories.ts` / `reclassify-subscriptions.ts` (M2) so the desync seam class is structurally closed — after M2 there is **no code path that can change category without flow following.**

### 3.10 MC1 interaction summary

MI stores no monetary values — `Merchant`, `MerchantAlias`, `MerchantRule`, and the provenance columns are identity/classification data, so MI neither reads nor writes `currency`. The interaction is purely sequencing (§2.4) plus one forward note: when merchant spend rollups and cadence detection eventually persist derived figures, they inherit the currency dimension from Phase-0-stamped rows and must group by currency rather than summing bare floats (MC1 plan §6.3) — recorded here so the future slice cannot claim ignorance.

---

## 4. Write-path obligations (post-M2 steady state)

| Writer | Stamps | Preserves |
|---|---|---|
| Plaid sync create | `PROVIDER` or `GLOBAL_RULE` (whichever arm of `mapPlaidCategory` fired — the mapper returns `{category, source}` from M2) + `USER_RULE` when a persisted rule matched (M5) | — |
| Plaid sync update-by-plaidId / fingerprint-update | re-stamps only per clobber matrix | user-tier category/source/ruleId |
| Import create | `IMPORT` | — |
| Import update-on-match | `IMPORT` per matrix; category stays **in** the update-diff trigger (unchanged behavior) but the write is matrix-gated | user-tier |
| Override endpoint (M5) | `USER_OVERRIDE` | n/a (it IS the top rank) |
| Rule create/apply (M5) | `USER_RULE` + `categoryRuleId` | `USER_OVERRIDE` rows |
| Backfills (M3+) | the source of whichever resolver arm fired | everything above their rank |
| Seed (dev) | `PROVIDER`-equivalent stamp for hygiene | n/a |

Mapper change enabling this: `mapPlaidCategory` gains a sibling `resolveCategoryWithSource()` returning `{category, source}` (the existing signature stays for compatibility; both share one implementation so they cannot drift).

---

## 5. Backfill strategy

All backfills follow the house pattern (`backfill-flowtype.ts` / `backfill-merchant-categories.ts`): **dry-run default, `--apply` to write, keyset pagination by id, batched atomic writes, per-run JSON rollback log, idempotent re-run proves 0, soft-deleted rows excluded by default, `--space` scoping for cautious rollout.** Order is dependency-driven:

1. **(Pre-MI runway, already scheduled — not this initiative)** flow-desync remediation over Slice-1-rewritten rows; then MC1 Phase 0's currency backfill. MI starts from a clean, stamped baseline.
2. **M3 — expanded-vocabulary category backfill** (`scripts/backfill-expanded-categories.ts`): candidates = `category='Other' AND categorySource IS DISTINCT FROM user-tier` where the M2 resolver (persisted `pfcPrimary`/`pfcDetailed` + expanded buckets + expanded curated rules) yields non-Other. Every write goes through `buildCategoryRewrite` — category, source, and flow move together, so this backfill *cannot* recreate the desync seam. Conservative source-restriction to `Other` keeps rollback deterministic (same doctrine as Slice 1).
3. **M4 — merchant dictionary backfill** (`scripts/backfill-merchant-dictionary.ts`): pass 1 mints Merchants from distinct `merchantEntityId` values (identity from Plaid, display name from the most common `merchant` string, no Plaid re-fetch — the forward seed pays off); pass 2 groups remaining rows by `normalizeMerchant(merchant).canonicalKey` under the §3.2 minting guards; pass 3 stamps `Transaction.merchantId`. Category untouched — this backfill writes identity only, so the rewrite contract is not in play. Alias rows created from observed descriptor variants that share an entityId.
4. **(Optional, evidence-based)** stamp `categorySource='GLOBAL_RULE'` on the exact row ids in the Slice-1 rollback logs — the only historical provenance that is provable rather than assumed. Everything else stays null on purpose (§3.5).
5. **M5 — no bulk backfill.** Rule application re-resolves only the affected merchant's rows, matrix-gated, at rule-creation time.

---

## 6. Validation

Per slice, in addition to the invariant gate (`npx prisma migrate dev` + `generate` for schema slices; `npx tsc --noEmit`; `npm run lint`; `npm test` — flow suites must stay green throughout since rewrite fields ride next to flow fields):

- **M1:** `tsc` passes with **zero consumer edits** (the additive-neutrality proof, same as MC1 Slice 1); spot-query: new columns null everywhere; new enum values present in the type; classifier unit tests extended — every new enum value classifies `SPENDING`/`REFUND` by sign, never `UNKNOWN`.
- **M2:** resolver precedence unit tests (rules-as-data, `tsx`, no DB): flow-structural PFC beats every rule tier; USER rule beats GLOBAL beats PFC-spend; clobber matrix — each cell of §3.8 asserted; `buildCategoryRewrite` equivalence — for every category value, output flow equals a direct `classifyFlow` call. Sandbox sync + import runs: created rows stamped; a hand-set USER_OVERRIDE row survives a forced Plaid `modified` update and an import re-match. Retrofitted scripts' dry-runs produce byte-identical candidate sets pre/post retrofit.
- **M3:** dry-run diff report (counts per source-category → target) reviewed before `--apply`; post-apply: the one-line desync count (`category IN (new values) AND flowType='UNKNOWN'`) is **0**; idempotent re-run = 0 candidates; rollback-log restore tested on a sample.
- **M4:** dictionary integrity counts — every `merchantEntityId` row has `merchantId`; no alias key maps to two merchants (`@unique` proves it, but the dry-run reports attempted conflicts); minting-guard proof: zero Merchants minted from TRANSFER/DEBT_PAYMENT/INCOME-flow rows without entityId; AI assembler output unchanged (it still uses read-time normalization until M6 — byte-identical context proof).
- **M5:** authorization — override/rule endpoints reject non-owners (route through the SP-2 policy predicate); two-user privacy proof extended: user A's rules never affect user B's rows or context; audit-log entries written for override/rule mutations; UI provenance badge renders only for user-tier sources.
- **Every slice:** the KD-19 two-user visibility proof stays green; `STATUS.md` updated per the maintenance rule.

---

## 7. Rollback

- **Schema (M1):** new tables + columns drop cleanly (`DROP TABLE` ×3, `DROP COLUMN` ×3, `DROP TYPE` ×3 for the new enums) — zero readers exist at M1 by design. **Exception, stated honestly:** `TransactionCategory` **added values cannot be dropped**; rollback for the enum expansion is "stop producing them + backfill affected rows back to `Other` via the rollback logs," not type surgery. This is why the admission rule (§3.6) is strict and why enum expansion is its own migration file — everything else in M1 remains fully reversible independent of it.
- **Write-path slices (M2, M5):** revert commits; stamped rows are harmless residue (correct data, rank-guarded). Rules disable instantly via `active=false`/soft-delete without deleting user data.
- **Backfills (M3, M4):** JSON rollback logs restore prior category **and** trigger flow re-classification through the same helper on restore (a rollback is itself a category rewrite — the contract applies in both directions; the Slice-1 rollback path did not need this, the M3 one does). Dictionary backfill inverts by `SET merchantId = NULL` + truncating minted rows — identity-only, no behavior at stake pre-M6.
- **Read cutover (M6):** feature-flag or revert; the read-time normalizer path is kept intact until M6 closes, so reverting is a one-commit operation.

---

## 8. Slice plan

Strictly ordered; each additive, independently shippable, a safe stopping point.

### M0 — Decision gate (doc-only; may run in parallel with MC1 Phase 0)

Ratify: the enum set + annotations classing + the Groceries rider (§3.6); the precedence ranks + clobber matrix (§3.8); the source enum + null semantics (§3.5); Space-scope deferral (§3.7); the minting guards (§3.2). Allocate the track per the STATUS §4 namespace rule (suggest `MI-x`, folder `docs/initiatives/mi1/`) and record the decisions there. **Output:** decision record; no code.

### M1 — Schema foundation ⟵ **first implementation slice after MC1 Phase 0 lands**

- **Gate:** MC1 Phase 0 Slices 1–3 verified (columns live, writers stamping, currency null-count drained); desync remediation done; M0 ratified.
- **Migrations (two, separate files):** `mi1_category_enum_expansion` — `ALTER TYPE "TransactionCategory" ADD VALUE` ×6 (own file because it is the one irreversible statement); `mi1_merchant_foundation` — `Merchant`, `MerchantAlias`, `MerchantRule` tables, `CategorySource` + `MerchantRuleScope` + `MerchantAliasSource` enums, `Transaction.categorySource` / `categoryRuleId` / `merchantId` (all nullable, no defaults) + the three indexes/relations (§3.5).
- **Code (companion, behavior-neutral):** `flow-classifier.ts` `SPEND_CATEGORIES` += the 6 values (no `FLOW_CLASSIFIER_VERSION` bump — no existing row's output changes) + tests; schema comments per house style.
- **Explicitly not in M1:** no writer, no reader, no backfill, no mapper change, no UI.
- **Validation/rollback:** §6/§7 M1 rows. A repo parked at M1 for a month is fully healthy (FlowType P3 Phase A precedent).

### M2 — Write-path provenance + the rewrite contract

`resolveCategoryWithSource()`; PFC bucket expansion + Groceries rider in the mapper; all §4 writers stamp; clobber-matrix preservation in sync/import update paths; `lib/transactions/category-rewrite.ts`; retrofit the two legacy category scripts. Forward behavior change (new rows get real categories instead of `Other`) is the point and is confined to the mapper's already-tested seam.

### M3 — Expanded-vocabulary backfill

§5.2. One script, one dry-run review, one apply, one idempotence proof.

### M4 — Merchant dictionary (identity tier)

Write-time resolution (entityId → alias → canonicalKey → guarded mint) wired into sync + import; `merchantId` stamped on new rows; §5.3 backfill. AI assembler untouched.

### M5 — User overrides + user rules (the learning loop)

Override endpoint (PATCH, SP-2-authorized, audited, via the rewrite helper); "apply to all from this merchant" → USER `MerchantRule` + matrix-gated re-resolution; sync-path honors user rules; `SpaceTransactionsPanel` edit affordance + provenance badge ("you set this" vs "auto"). First user-facing slice.

### M6 — Read cutover

AI assembler merchant/income rollups read resolved `merchantId` groups instead of re-normalizing per request (KD-10/KD-11 discipline: remove a re-derivation site); byte-comparison harness before/after on a fixed fixture set.

### Deferred with intent (recorded so deferral is a decision)

**Space-rule overlay** (own slice: read-time application in the KD-19-guarded data layer + privacy proof); **cadence/recurring detection** (own track — time-series over the ledger; resolves PlayStation/Prime Video; never a merchant-name rule); **normalizer consolidation** (`normalizeMerchant` vs `normalizeMerchantKey` — valuable, orthogonal; best taken as a prerequisite refactor inside M4 if timing allows, else standalone); **enrichment** (logos/websites — Tier C, needs a fetch pipeline and visibility review); **global-catalog promotion analytics**; **Merchant `defaultCategory` as a resolver input** (explicitly excluded from the M4 resolver, §3.2); **cross-user shared dictionary concerns** (single-deployment reality today; revisit at multi-tenant scale).

---

## 9. Open questions for ratification at M0

1. Final enum value list — is 6 right, or trim `PersonalCare`/`Services` to 4? (Recommendation: keep 6; all have PFC producers.)
2. Annotations discretionary/semi/fixed class per new value (§3.6 proposes; product call).
3. Does the Groceries `FOOD_AND_DRINK_GROCERIES` rider ride M2, or is remapping historical Dining rows (a much bigger, opt-in backfill) wanted too? (Recommendation: forward-only in M2; historical remap deferred — Dining→Groceries rewrites are not `Other`-sourced and break the conservative rollback doctrine.)
4. Track naming: `MI-x` prefix + `docs/initiatives/mi1/` folder allocation.
5. Whether the optional evidence-based provenance stamp from Slice-1 rollback logs (§5.4) is worth running (recommendation: yes — cheap, provable, zero risk).

---

*End of plan. Stopping here per instruction: no implementation, no schema, no migration, no writer, no backfill, and no doc-of-record change was made. Next step: M0 ratification; M1 waits on the MC1 Phase 0 landing gate (§2.4).*
