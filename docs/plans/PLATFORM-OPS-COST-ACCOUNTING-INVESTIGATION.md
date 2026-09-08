# Platform Ops cost accounting — AI + Plaid

**Date:** 2026-09-09 · **HEAD:** `21499b0` · **Status:** investigation. **Nothing implemented.**

No schema change, no migration, no code change. Every claim below is a repository fact, a live
query against the local database, or a provider-documentation boundary, and each is labelled.

---

## 1. Executive verdict

**Platform Ops already has the accounting *shape* — one durable counter, one pricing seam, three
widgets and a `platform-costs` workspace. What it lacks is three facts and one idea.**

| | Finding |
|---|---|
| **1** | **The AI cost figure the repo can produce today is wrong by ~65%, and always will be.** `ApiUsageCounter` records `prompt_tokens`, but ~89% of those bill at the **cached** rate (one-tenth). Cached tokens are never read from the provider response. A dollar figure from today's data overstates by roughly 3×. |
| **2** | **Plaid call counts are not a cost signal at all.** A reconciled July invoice establishes the billable unit as the **Item-subscription-month**, not calls and not refreshes (`/transactions/refresh` costs $0). `ApiUsageCounter`'s `PLAID/<method>/calls` rows measure something real and **economically irrelevant**. |
| **3** | **Per-invocation, per-turn and per-conversation cost are structurally impossible today** — the counter's finest grain is `(provider, metric, unit, UTC day)`. There is no invocation row to attribute. |
| **4** | **Prices have no time dimension.** `UNIT_PRICES_USD` is a flat, empty code map. Immutable facts × versioned prices is the whole design idea, and half of it is missing. |

**The smallest architecture is smaller than it looks**, because two of the four gaps need no new
tables:

- **Plaid needs no new schema at all.** `PlaidItem.createdAt` plus the existing append-only
  `PLAID_ITEM_STATUS_CHANGED` transition ledger (CH-2) already contain every fact an Item-month
  census requires. Cost becomes a **pure derivation**, not a collector.
- **Pricing needs no new schema.** Adding an `effectiveFrom` dimension to the existing code
  constant preserves the repo's stated doctrine ("prices are contract-specific code/env constants,
  not schema") while making restatement correct.
- **AI needs one new table** — a per-invocation immutable fact — because nothing in the repository
  records a single model call, and per-turn cost cannot be derived from a daily sum.

**One new table, one nullable column of provider metadata, two counter units, and a pure Plaid
derivation.** That is the whole proposal.

---

## 2. What Platform Ops already stores and displays

### 2.1 The one usage ledger

`ApiUsageCounter` (schema §3091) — the only durable usage store.

```
provider  String   "PLAID" | "OPENAI"        (free string, extensible)
metric    String   Plaid: method name; OpenAI: "chat.completions:<model>"
unit      String   "calls" | "prompt_tokens" | "completion_tokens"
day       DateTime UTC day bucket
count     BigInt
@@unique([provider, metric, unit, day])
```

`lib/usage/record.ts` `recordApiUsage()` is the **single writer** — an atomic upsert-increment,
fire-and-forget, non-throwing. Two call sites feed it:

| Chokepoint | Writes |
|---|---|
| `lib/ai/provider.ts` — **three** capture blocks (lines 105–107, 220–222, 287–289) | `calls`, `prompt_tokens`, `completion_tokens` |
| `lib/plaid/client.ts` — the `PlaidApi` Proxy, one counter per method invocation | `calls` only |

The schema comment states the deliberate boundary: *"Dollar cost is deliberately NOT here —
per-unit prices are contract-specific code/env constants (lib/usage/pricing.ts), not schema."*

### 2.2 The pricing seam — present, and empty

`lib/usage/pricing.ts` ships `UNIT_PRICES_USD = {}` with `estimateUnitSpendUsd()` returning `null`
and `isPricingConfigured()` returning `false`. **Consequence:** every surface below renders "—"
rather than a dollar figure. That is the honest default working as designed, and it is why no cost
number exists in the product today.

### 2.3 The read authorities and surfaces

| Layer | What it does | Cost today |
|---|---|---|
| `app/api/platform/platform-ops/api-usage` (Wave 2 S7) | calls today/7d/30d per provider, tokens per model over 30 days | `estimatedSpendUsd: null` |
| `lib/platform/ai/ai-usage.ts` (OPS-6D) | per-day AI trend from `ApiUsageCounter`, models from the metric dimension | `estimatedSpendUsd: null` |
| `lib/platform/cost/cost.ts` (OPS-5 S10) | "Cost & Latency Intelligence" — **latency and runtime, not dollars**. Pure reduction over S7 history + S9 convergence | one metric, `spend-usd`, hard-coded `value: null, tier: "unknown"` |
| `lib/platform/provider-health.ts` | reads `unit: "calls"` per provider for health, not cost | n/a |
| Widgets | `OpsApiUsageWidget`, `OpsAiTrendWidget`, `OpsCostWidget` | all render "—" for spend |
| Workspace | **`platform-costs` already exists** — `sections: ["ops_cost", "ops_ai_trend"]` (`lib/platform/workspaces.ts:151`) | the UI home is built |

> **There is no parallel accounting system to avoid — there is one, it is correct in shape, and it
> is starved of three facts.**

### 2.4 Adjacent infrastructure that is *not* cost, and should stay that way

- **`ProviderCall`** (DF-2D) — immutable per-attempt Plaid execution attribution, FK'd to
  `RefreshExecution` with cascade. Its own comment: *"ATTRIBUTION, NOT BILLING … No dollar/billable
  units here — usage reconciliation is deferred."* **Do not extend it** (§6.3).
- **`AuditLog` / `PLAID_ITEM_STATUS_CHANGED`** (CH-2) — append-only transition ledger. **This is the
  Plaid lifecycle evidence** (§4.2).
- **No rollup table exists.** The roadmap's Slice 3.1 "rollup substrate" is unbuilt; grepping the
  schema for `Rollup` / `PlatformDay` returns nothing. `ApiUsageCounter` *is* the daily rollup.

---

## 3. The AI provider-data boundary

### 3.1 What the response exposes vs what is captured

Measured live (Cost Clip 4 probes) against `/v1/chat/completions`:

| Field | Exposed by provider | Read in `provider.ts` | Written to `ApiUsageCounter` |
|---|---|---|---|
| `usage.prompt_tokens` | ✅ | ✅ ×3 sites | ✅ |
| `usage.completion_tokens` | ✅ | ✅ ×3 sites | ✅ |
| `usage.total_tokens` | ✅ | ✅ 1 site | ❌ (derivable) |
| **`usage.prompt_tokens_details.cached_tokens`** | ✅ | ❌ **never read anywhere** | ❌ |
| **`usage.completion_tokens_details.reasoning_tokens`** | ✅ | ✅ **1 of 3 sites** (`generateWithTools`), returned to the caller | ❌ **discarded at the counter** |
| model id | ✅ (echoed) | via the `metric` string | ✅ (encoded in `metric`) |
| request id / latency | ✅ | latency only, in-memory | ❌ |

### 3.2 Why `cached_tokens` is the difference between a number and a wrong number

OpenAI prompt caching is **automatic above 1,024 tokens**, prefix-matched in 128-token increments,
and the cached prefix **includes tool definitions**. Measured on this product's own traffic
(AI-BETA-COST-ECONOMICS-INVESTIGATION §11): **89.2% cache hit rate**, and gpt-5.5 prices cached
input at **$0.50/1M against $5.00/1M** — a 90% discount.

```
two dogfood sessions, 377,454 prompt tokens
  priced from ApiUsageCounter today   377,454 × $5.00/1M          = $1.887
  priced with cached tokens known     41k × $5.00 + 336k × $0.50  = $0.372
                                                       overstatement ≈ 5×
```

**The semantics trap, stated once:** `cached_tokens` is a **subset** of `prompt_tokens`, not a
sibling. Any pricing that charges both at full rate double-counts. The correct reduction is
`(prompt_tokens − cached_tokens) × input_rate + cached_tokens × cached_rate`. A `cached_prompt_tokens`
unit added naively to the existing map would produce a *larger* wrong number than today's.

### 3.3 What cannot be obtained from the provider at all

- **No billing API.** Neither OpenAI nor Plaid exposes a pollable invoice endpoint; the
  `api-usage` route already says so. Every dollar figure this system produces is an **estimate
  from usage × configured price**, never a bill. That framing must survive.
- **Per-user / per-Space attribution** is absent because the *counter* has no such dimension, not
  because the provider withholds it. This is the roadmap's OPS-6H.

---

## 4. The Plaid provider-data boundary

### 4.1 The billable unit — established against a real invoice

Invoice `S-J7Y5657ZK0-2607` (July 2026, **$13.40**) reconciles exactly to the Plaid dashboard:

- **Transactions qty 40** = *"Items billed in the 7/1–7/31 cycle"*
- **Investments qty 4** = Investments-Transactions billed (Holdings 2; the invoice bundles at the higher)
- **`/transactions/refresh` has zero call sites and the dashboard Refresh chart reads 0 → refreshes cost $0**

> **The billable unit is the Item-subscription-month, per product. Not calls. Not refreshes. Not
> syncs.** `/transactions/sync` is included in the subscription.

**Therefore `ApiUsageCounter`'s ~16 `PLAID/<method>/calls` series, however carefully collected, has
no monotonic relationship to the bill.** It is a health and rate-limit signal. Pricing it would
invent a cost curve.

A second recorded fact matters for interpretation: **one Plaid client id spans local dev, preview
and production**, so development churn mints real billable Items — ~$11.70 of July's $12.00
Transactions charge was development. Any cost surface must therefore be able to say *which
environment an Item-month belongs to*, or it will report a product cost that is mostly the
operator's own dev loop.

### 4.2 What the repository can already observe — and it is enough

Live query against the local database (2026-09-09):

```
PlaidItem by status : ACTIVE 12, NEEDS_REAUTH 1        (REVOKED 0)
earliest createdAt  : 2026-07-19                        (13 rows)
investmentsConsent  : set on 2 items
PLAID_ITEM_STATUS_CHANGED audit rows : 7
```

| Fact needed for an Item-month census | Where it already lives |
|---|---|
| When an Item started being billable | **`PlaidItem.createdAt`** |
| Which products it is billed for | **`PlaidItem.investmentsConsent`** (+ transactions implied by existence) |
| When it stopped being billable | **`AuditLog` `PLAID_ITEM_STATUS_CHANGED` → `REVOKED`**, metadata `{ provider, plaidItemId, from, to, errorCode }` — append-only, written by the CH-2 chokepoint `lib/connections/health-transitions.ts` |
| That the row survives removal | `lib/plaid/disconnect.ts` sets status `REVOKED`; it **does not delete the row** |

**So Item-months are a pure function of two existing sources. No collector, no new table, no
background job.**

### 4.3 The three honest limits

1. **`PlaidItem` has no `retiredAt` column.** Retirement is reconstructable only from the audit
   transition, so the census inherits **AuditLog's** completeness — and the operator's own record
   notes production AuditLog was *"completely dark 07-03 → 07-21"*.
2. **Pre-CH-2 history is unreconstructable**, and the local table's earliest `createdAt` is
   2026-07-19 (a wipe/reseed boundary). **Item-months before that date cannot be derived and must
   be reported as unknown, never as zero.**
3. **The cycle-count reading is ambiguous.** The dashboard tooltip says *"Items billed in the
   7/1–7/31 cycle"* while the tile is labelled *"Lifetime Items on 7/31"*. Whether Plaid bills
   **any-Item-present-during-the-cycle** or **Items-present-at-cycle-end** is not settled by the
   evidence, though the July reconciliation is consistent with both. A derivation over a lifecycle
   interval can compute **both** and show the reading it used; a stored monthly count would have to
   pick one and would be silently wrong if it picked the other.

---

## 5. Where `ApiUsageCounter` is insufficient — precisely

| # | Gap | Consequence | Fixable by |
|---|---|---|---|
| 1 | **No `cached_tokens`** | AI cost overstated ~5× on measured traffic | a new unit + one provider read |
| 2 | **No `reasoning_tokens`** | The largest output component on gpt-5.x is invisible (74% of completion tokens on a 31-turn session). Not a *pricing* gap — reasoning bills at the output rate — but the cost **explanation** is absent | a new unit + moving an existing read |
| 3 | **Day is the finest grain** | Per-invocation, per-turn, per-conversation cost impossible. "Which conversation cost $0.26?" unanswerable | a per-invocation fact row |
| 4 | **No user/space/surface dimension** | No cost-to-serve, no per-Space attribution (roadmap OPS-6H) | dimensions on the fact row |
| 5 | **`metric` is an overloaded string** | `"chat.completions:gpt-4.1"` must be substring-parsed to recover the model; a second model family or endpoint would need a new parse rule | typed columns on the fact row |
| 6 | **Counters are written outside the provider boundary only** | Probe scripts calling the SDK directly record nothing — measured during Cost Clip 4, where **none** of ~$1.53 of evaluation traffic reached the counters | doctrine, not schema: the counter is a floor, and should say so |
| 7 | **No price-effective date** | A rate change silently restates all history | versioned pricing |
| 8 | **`PLAID/calls` is not cost** | Pricing it would fabricate a curve | derive Item-months instead |

---

## 6. Proposed architecture

### 6.1 The organising idea

> **Immutable usage facts. Versioned prices. Cost is a read-time reduction, never a stored column.**

A stored dollar column freezes a price into a fact and makes a rate correction unrepresentable.
Everything below keeps money out of the fact tables.

**Three grains, because the providers genuinely have three:**

| Grain | Provider | Fact | Source |
|---|---|---|---|
| **Invocation** | OpenAI | one model call | new table (§6.2) |
| **Day** | both | existing aggregate | `ApiUsageCounter` (unchanged, + 2 units) |
| **Item-month** | Plaid | one Item × product × cycle | **derived**, no storage (§6.4) |

### 6.2 AI: one new immutable fact table

```prisma
model AiInvocation {
  id             String   @id @default(cuid())
  // ── identity of the call ──────────────────────────────────────────────
  provider       String   // "OPENAI"
  endpoint       String   // "chat.completions"
  model          String   // "gpt-5.5" — typed, not parsed out of a metric string
  occurredAt     DateTime
  latencyMs      Int
  finishReason   String?
  providerRequestId String?      // support/incident correlation when exposed

  // ── the billable quantities, exactly as the provider reported them ─────
  promptTokens       Int
  cachedPromptTokens Int   @default(0)   // ⚠️ SUBSET of promptTokens
  completionTokens   Int
  reasoningTokens    Int   @default(0)   // ⚠️ SUBSET of completionTokens
  // NOTE: no totalTokens — derivable, and a stored derivation can disagree.

  // ── correlation, all nullable, all opaque ─────────────────────────────
  correlationId  String?  // one conversation
  turnIndex      Int?     // one user turn within it
  surface        String?  // "chat" | "brief" | "harness" — where it originated
  userId         String?
  spaceId        String?

  @@index([occurredAt])
  @@index([model, occurredAt])
  @@index([correlationId, turnIndex])
  @@index([spaceId, occurredAt])
}
```

**Why a new table and not an extension of something existing** — the alternatives, and why each fails:

| Candidate | Why not |
|---|---|
| `ApiUsageCounter` | Its grain *is* the day and its value is that grain. Adding invocation rows would destroy the atomic upsert-increment idiom and the `@@unique` that makes it race-safe. |
| `ProviderCall` | Required FK to `RefreshExecution` **with cascade** — an AI call has no refresh execution. Reuse would mean nullable-ing the FK (breaking *"a provider call belongs to its execution"*) and adding five token columns meaningless to Plaid. Its own doctrine says *"ATTRIBUTION, NOT BILLING"*. |
| `AuditLog` | Security feed; the schema comment on `ApiUsageCounter` already rejects it for usage as *"high-frequency, aggregated — the wrong read shape and would pollute the security feed"*. |

**No `Conversation` table.** The repo documents that `Conversation`/`ChatMessage` deliberately do
not exist. `correlationId` is an **opaque caller-supplied string**, not an FK — per-conversation
cost without resurrecting conversation storage.

**Volume:** the busiest recorded day was 396 OpenAI calls. At ~500/day that is ~180k rows/year —
trivially indexable, and one order of magnitude below `Transaction` (4,745 rows today).

**`ApiUsageCounter` stays.** It remains the cheap 30-day/90-day trend and the provider-health input,
and it becomes the **reconciliation check** against summed invocations — two independently-written
figures that must agree, the repo's own anti-KD-10 posture.

### 6.3 Two new units on the existing counter

`cached_prompt_tokens` and `reasoning_tokens`, written from the same three chokepoints. Additive:
no migration (units are free strings), no reader breaks (readers switch on known unit names).

⚠️ **Both are subsets.** The pricing reducer must be written as
`(prompt − cached) × input + cached × cachedInput`, never `prompt × input + cached × cachedInput`.
This is the single most likely defect in the whole design and belongs in a test before code.

### 6.4 Plaid: a pure derivation, no schema

```
billableItemMonths(cycleStart, cycleEnd) =
  for each PlaidItem:
     bornAt   = createdAt
     retiredAt = first AuditLog PLAID_ITEM_STATUS_CHANGED to "REVOKED" for this item, else null
     if the [bornAt, retiredAt) interval intersects the cycle:
        emit { itemId, product: "transactions", cycle }
        if investmentsConsent granted within the cycle:
           emit { itemId, product: "investments", cycle }
```

- Returns **both readings** (`presentDuringCycle` and `presentAtCycleEnd`) with the one it priced
  named in provenance, because §4.3(3) is unresolved.
- Returns `coverageFrom` = the earliest date the derivation can be trusted (max of the audit
  ledger's start and the earliest `createdAt`), and reports earlier cycles as **unknown**.
- Carries an `environment` dimension if one can be established, so dev churn is separable (§4.1).

**`PLAID/<method>/calls` counters keep their current job — health and rate-limit pressure — and are
explicitly excluded from the cost reduction.** A one-line guard in the pricing resolver plus a test
that no `PLAID` metric resolves a price prevents this being reintroduced by accident.

### 6.5 Versioned pricing — code, not schema

Preserves the stated doctrine while adding the missing time dimension:

```ts
export interface Rate {
  provider: string; endpoint?: string; model?: string;
  unit: 'input' | 'cached_input' | 'output' | 'item_month';
  product?: string;               // Plaid: "transactions" | "investments"
  usdPerUnit: number;             // per token, or per item-month
  effectiveFrom: string;          // YYYY-MM-DD, inclusive
  source: string;                 // "openai pricing page 2026-09-08" | "invoice S-J7Y…-2607"
}
export const RATES: readonly Rate[] = [ /* ships empty, as today */ ];
export function rateAt(sel, on: string): Rate | null   // latest effectiveFrom <= on
```

- **Facts stay immutable; prices are looked up at the fact's own date.** Correcting a rate restates
  history correctly and automatically.
- `source` makes every dollar traceable to a page or an invoice — the provenance discipline
  `CostMetric` already enforces for latency.
- **Still ships empty**, so the honest "—" remains the default until the operator populates it.
- No migration, no table, no admin UI. If prices ever need to be operator-editable at runtime,
  `PlatformSetting` is the existing seam — but there is no evidence yet that they do.

### 6.6 Data flow

```
lib/ai/provider.ts  ──┬─► recordApiUsage(...)         → ApiUsageCounter   (day grain, unchanged + 2 units)
  (3 chokepoints)     └─► recordAiInvocation(...)     → AiInvocation      (invocation grain, NEW)
                              fire-and-forget, non-throwing, same posture

PlaidItem.createdAt ──┐
AuditLog transitions ─┴─► billableItemMonths()        → derived, nothing stored

                          lib/platform/cost/cost.ts   ← ONE definition site
                            + reduce(AiInvocation × rateAt)
                            + reduce(itemMonths × rateAt)
                            → MTD, projected month, per model/day/conversation
                          (existing CostMetric shape: value, unit, tier, provenance)
```

**Every reduction lands in `lib/platform/cost/` — the existing single definition site** — honouring
the roadmap's rule that *"every metric must have exactly one definition site or the platform's
numbers about itself will disagree"*. `ai-usage.ts` and the `api-usage` route keep reading counters
for trend and health; they do not gain a second pricing path.

### 6.7 UI — no new workspace

`platform-costs` already exists with `ops_cost` + `ops_ai_trend`.

- **`OpsCostWidget`** — `spend-usd` stops being hard-coded null; gains `mtd-spend-usd`,
  `projected-month-usd`, `ai-spend-usd`, `plaid-spend-usd`, each with `tier` and `provenance`.
  The widget is presentation-only and needs **no change** — it already renders any `CostMetric`.
- **`OpsAiTrendWidget`** — gains cached/reasoning token lines from the two new units.
- **One new widget, `ops_ai_invocations`** (registered in `lib/platform/policy.ts` + the
  `PlatformSpaceDashboard` map, the established path): most expensive conversations and turns, the
  question the daily grain cannot answer.
- **Projection** must carry `tier: "estimated"` — the existing `projected-daily-load` metric is the
  precedent for an honestly-tiered projection.

---

## 7. Migration implications

| Change | Migration | Risk |
|---|---|---|
| `AiInvocation` table | **one additive migration**, new table, no FK to existing rows (`userId`/`spaceId` as plain nullable columns, *not* relations — avoids cascade surprises and lets a Space deletion leave cost history intact) | **Low.** Nothing reads it until slice 3 |
| Two counter units | **none** — `unit` is a free string | **None** |
| `cached`/`reasoning` capture | code only | **Low**, fire-and-forget posture already proven |
| Versioned pricing | code only | **None** |
| Plaid derivation | code only | **None** |

**Deployment caveat, from the record:** `build` runs `prisma generate && next build` — it does
**not** run `migrate deploy`. A migration must be applied deliberately
(`npm run db:migrate:safe` = backup + `migrate deploy`). `prisma migrate dev` is
non-interactive-hostile here; generate SQL with
`migrate diff --from-schema-datamodel <HEAD schema> --to-schema-datamodel` and apply with
`migrate deploy` — and diff from the **schema**, not the datasource, or unrelated pre-existing
index-name drift rides along.

**Retention:** `AiInvocation` grows ~180k rows/year. No policy needed now; when one is wanted, the
day-grain counter is already the durable summary, so invocation rows can age out without losing
the trend — which is a reason to keep both grains rather than replace one with the other.

**Data minimisation:** the fact table carries **no prompt, no completion, no message content, no
tokenised text** — only counts, ids and timestamps. This is the `ProviderCall` allowlist doctrine
applied to AI, and it should be enforced by a source-scan test the way the tombstone audits are.

---

## 8. Smallest implementation slices

Each independently shippable, independently revertible, and mechanically testable.

| # | Slice | Size | Delivers | Depends on |
|---|---|---|---|---|
| **1** | **Capture cached + reasoning tokens.** Read both from all three `provider.ts` blocks; write two new `ApiUsageCounter` units. Pricing reducer written subset-aware, with the double-count test first. | ~30 lines + tests | The single largest correctness gain. Makes every existing surface's future dollar figure ~5× less wrong | — |
| **2** | **Versioned pricing.** `Rate[]` + `rateAt()`, `estimateUnitSpendUsd` delegating to it; ships empty. Populate from the OpenAI pricing page and invoice `S-J7Y…-2607`. | ~60 lines | The first *real* dollar figures on surfaces that already render them | 1 |
| **3** | **`AiInvocation` fact table + writer.** One migration, one `recordAiInvocation()` beside `recordApiUsage()`, called from the same three chokepoints. Reconciliation check: summed invocations vs the day counter. | ~120 lines + migration | Per-invocation, per-model, per-day cost; the substrate for turn/conversation | 1 |
| **4** | **Plaid Item-month derivation.** Pure function over `PlaidItem` + the CH-2 audit ledger; both cycle readings, explicit `coverageFrom`, `PLAID/calls` excluded from pricing by guard + test. | ~100 lines | Truthful Plaid cost at the invoice's own unit | 2 |
| **5** | **Combined MTD + projection in `lib/platform/cost/`.** AI + Plaid reduced in the one definition site; `spend-usd` replaced by `mtd-spend-usd` and `projected-month-usd`, honestly tiered. | ~80 lines | The number the operator actually wants | 2,3,4 |
| **6** | **Correlation dimensions.** Thread `correlationId` / `turnIndex` / `surface` from the callers; add `ops_ai_invocations`. | ~60 lines | Cost per turn and per conversation | 3 |
| **7** | *(deferred — OPS-6H)* `userId` / `spaceId` populated at the chokepoint | — | Cost-to-serve per user/Space | 3, and a product decision on operator visibility of per-user cost |

**Slices 1 and 2 are worth shipping alone**: together they turn every existing widget's "—" into a
figure that is right, without a migration.

---

## 9. What NOT to build

- **No second usage ledger.** `ApiUsageCounter` keeps the day grain and the provider-health role.
- **No dollar column on any fact table.** Cost is always `facts × rateAt(date)`.
- **No cost fields on `ProviderCall`.** Its doctrine is attribution; billing is a different grain.
- **No pricing table, no pricing admin UI** until there is evidence prices must change at runtime.
- **No Plaid call-based cost curve** — it would be a fabricated number.
- **No `Conversation` model.** Correlation is an opaque string.
- **No background collector or rollup job.** Every proposed figure is a read-time reduction over
  facts that already exist or are written at an existing chokepoint.
- **No per-user cost surface before §7's product decision.** The roadmap's own security note warns
  that ops surfaces aggregate exactly the metadata an attacker wants, *"cost outliers"* named
  explicitly.

---

## 10. Unresolved questions

1. **Which Plaid cycle reading is billed** — any-Item-during-cycle or Items-at-cycle-end? (§4.3)
   The derivation computes both; one invoice with a mid-cycle removal would settle it.
2. **Can environment be established per Item?** One client id spans dev/preview/prod, and ~97% of
   July's bill was development churn. Without an environment dimension the "product cost" figure is
   mostly the operator's own loop. Is there a marker on the Item, or is a separate dev client id the
   real answer?
3. **Is AuditLog complete enough to trust for retirement?** The operator's record notes production
   AuditLog was dark 07-03→07-21. If not, a `retiredAt` column on `PlaidItem` is the alternative —
   one nullable column, written at the existing chokepoint.
4. **Should `AiInvocation` capture the harness?** The experimental harness bypasses `provider.ts`
   for some probes and would under-report. Routing all research traffic through the provider seam is
   a discipline question, not a schema one.
5. **Email cost** — `lib/platform/email-health.ts` exists; the roadmap's economics slice is
   "LLM + email + Plaid". Deliberately out of scope here; the `Rate` shape accommodates it.
6. **Does the operator want per-user cost at all before beta?** §7 is written as deferred for that
   reason.

---

## 11. Files changed

- **`docs/plans/PLATFORM-OPS-COST-ACCOUNTING-INVESTIGATION.md`** — this document. **Nothing else.**

No schema change, no migration, no code change. `app/`, `lib/`, `prisma/`, `components/` and
`scripts/` are untouched.

## 12. Evidence gathered

| Source | Established |
|---|---|
| `prisma/schema.prisma` | `ApiUsageCounter`, `ProviderCall`, `PlaidItem`, `PlaidItemStatus`; **no rollup table** |
| `lib/usage/record.ts`, `lib/usage/pricing.ts` | single writer; empty flat price map |
| `lib/ai/provider.ts` | three capture sites; `cached_tokens` never read; `reasoning_tokens` read once, never stored |
| `lib/plaid/client.ts`, `lib/plaid/disconnect.ts` | Proxy writes `calls` only; removal sets `REVOKED`, keeps the row |
| `lib/connections/health-transitions.ts` | CH-2 append-only `PLAID_ITEM_STATUS_CHANGED` ledger |
| `lib/platform/{cost,ai,history,provider-health}` | existing authorities; `spend-usd` hard-coded null |
| `lib/platform/workspaces.ts`, `policy.ts`, `PlatformSpaceDashboard.tsx` | `platform-costs` workspace and widget registration path already exist |
| `docs/plans/platform-ops-roadmap.md` | origination doctrine; one-definition-site rule; Plaid cost flagged as needing manual/invoice input |
| Live DB query (2026-09-09) | 13 Items (12 ACTIVE, 1 NEEDS_REAUTH), earliest `createdAt` 2026-07-19, 2 with investments consent, 7 transition rows |
| Reconciled July invoice `S-J7Y5657ZK0-2607` | **billable unit = Item-subscription-month**; refreshes $0 |
| AI-BETA-COST-ECONOMICS-INVESTIGATION | 89.2% measured cache hit rate; 90% cached discount |
