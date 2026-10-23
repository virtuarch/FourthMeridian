# AI TOKEN & PLAID COST ECONOMICS — ASSESSMENT

**Status:** PREIMPLEMENTATION / AWAITING OWNER REVIEW · **Date:** 2026-10-15 · **Branch:** v2.6 · **Baseline:** 2f5c54d (+ docs 5721e26) · **Mode:** read-only; no code, schema, config, billing, credential or Production change; no paid provider request was made; no database was queried.

**Evidence tiers:** VERIFIED = read in source at the baseline (file:line) or on an official provider page on the stated date · OBSERVED = seen on the Preview deployment on 2026-10-14 during the UX P1 browser pass · INFERRED = reasoned from verified facts, not measured · ASSUMPTION = a modelling input the owner may change · UNKNOWN = not knowable from the repository or public sources.

**Pricing vocabulary used throughout:** ACTUAL PROVIDER PRICING (what the provider publishes or invoices) · CONFIGURED APPLICATION PRICING (`lib/usage/pricing.ts`) · ESTIMATED INTERNAL COST (what Fourth Meridian computes and labels "estimate").

---

## 0. Summary table

| Item | Currently implemented | Verified correct | Incorrect | Missing | Unknown |
|---|---|---|---|---|---|
| AI input / cached-input / output pricing per model, time-versioned, subset-aware | ✔ `lib/usage/pricing.ts:243-260` | ✔ every configured rate equals OpenAI's standard tier on 2026-10-15 (§3) | | | |
| Reasoning tokens not double-counted (billed inside output) | ✔ `pricing.ts:220-222` | ✔ matches OpenAI's rule (§3.2) | | | |
| Cached tokens priced as a subset of input, clamped | ✔ `pricing.ts:253-257` | ✔ matches OpenAI's rule (§3.2) | | | |
| Cache-write pricing | n/a for models in use (no write fee) | ✔ | | ✘ for GPT-5.6+ (1.25× input on writes) if ever adopted | |
| gpt-5.5 long-context tier (>272K input) | | | | ✘ not modelled (`pricing.ts:70-87`) | |
| Provider reconciliation (OpenAI invoice / Costs API) | | | | ✘ none; `ProviderInvoice` proposed, unbuilt | actual OpenAI bill |
| AI spend across dev / preview / prod (one OpenAI account, three databases) | | | | ✘ no cross-environment total | share per environment |
| Per-user AI attribution | ✔ `AiInvocation.userId` (Customer Success) | ✔ | | ✘ in `ApiUsageCounter` (fleet surfaces) | |
| Harness / eval traffic excluded from "spend" | ✔ ledger (`surface='harness'`) | | ✘ counter-based figures include it | | |
| AI budgets / allowances / spend alerts | | | | ✘ only turns/min and turns/hour caps | |
| Plaid recurring Item-month charges (Transactions, Investments) | ✔ `lib/platform/plaid/item-months.ts:135-168` | ✔ shape matches Plaid's subscription rule (§6) | | | contracted unit rates (one invoice only) |
| Plaid per-request / one-time charges | ✔ deliberately not modelled | ✔ correct by construction: no per-request or one-time product is called (§5) | | | |
| Investments priced only when enabled | | | ✘ any non-null `investmentsConsent` is priced (`item-months.ts:161`) | | |
| Sandbox Items excluded from cost | | | ✘ `environment` is the Vercel env, not the Plaid env; Preview sandbox Items priced (§6.4) | | |
| Duplicate Item prevention | ✔ ACTIVE-only gate `lib/plaid/exchangeToken.ts:204-224` | | ✘ a NEEDS_REAUTH/ERROR Item does not block a fresh link ⇒ two billable Items | | |
| Item removal confirmation | ✔ markers `lib/plaid/disconnect.ts:103-153` | ✔ | | ✘ no scheduled retry of UNCONFIRMED removals | |
| Actual-charge ledger (any provider) | | | | ✘ none; every dollar on every surface is labelled estimate | |
| Cost per active user, per Space, per feature | | | | ✘ no composer (`lib/platform/cost/cost.ts:103-106` is `null`) | |
| Beta analytics: DAU/WAU/MAU series, feature adoption, retention cohorts, cost anomalies | partial (§9) | | ✘ DAU basis is credential sign-ins under a 30-day JWT | ✘ no view events, no series, no cohort, no cost rule | |

---

## 1. Current implementation inventory (VERIFIED)

### 1.1 AI

| Layer | Path | Role |
|---|---|---|
| Rate card (the ONE pricing authority) | `lib/usage/pricing.ts:70-87` (`AI_RATES`), `:129-134` (`PLAID_RATES`), `:160-168` (`rateAt`), `:179-182` (`modelFromMetric`), `:225-268` (`priceAiUsage`) | pure; USD per 1M tokens; `effectiveFrom` versioning |
| Usage vocabulary | `lib/usage/ai-tokens.ts:47-55` (`OpenAiUsage`), `:94-103` (`aiUsageUnits`) | provider usage → counter units; declares cached ⊆ prompt, reasoning ⊆ completion (`:12-13`) |
| Day-counter writer | `lib/usage/record.ts:37-56` (`recordApiUsage`, upsert on `(provider, metric, unit, UTC day)`, `systemDb`, errors swallowed) | single writer to `ApiUsageCounter` |
| Invocation writer | `lib/ai/invocation.ts:138-199` (`recordAiInvocation`, `recordAiInvocationFailure`, insert-only, `systemDb`) | single writer to `AiInvocation` |
| Provider chokepoint | `lib/ai/provider.ts:200,329,469` (the only `chat.completions.create` call sites); `recordOpenAiUsage :97-132`; `recordOpenAiFailure :147-160` | no other provider, no embeddings, no Anthropic SDK |
| Attribution carrier | `lib/ai/invocation-context.ts:38-83` (correlationId, turnIndex, surface, subSurface, userId, spaceId, conversationId) | set by chat `app/api/ai/chat/route.ts:224-227` (`surface:'chat'`), turn loop `lib/ai/conversation/turn.ts:293-299` (default `'harness'`), labeller `engine.ts:353-359`, Brief `lib/ai/brief/generate.ts:241-242` (`brief:generate`) |
| Tables | `prisma/schema.prisma:3303-3388` `AiInvocation` (provider, model, occurredAt, promptTokens, cachedPromptTokens, completionTokens, reasoningTokens, latencyMs, toolCallCount, finishReason, environment, correlationId, turnIndex, surface, subSurface, userId, spaceId, conversationId, outcome, errorCode, providerRequestId); `:3390-3399` `ApiUsageCounter` (provider, metric, unit, day, count) | migrations `20260713190000_add_api_usage_counter`, `20260908222415_ai_invocation`, `20261007100000_operationalization_p0_facts:34-44`; both revoked from `fm_app` (`20261002000100_rls_roles_and_policies:190-199`) |
| Readers | `lib/platform/ai/invocations-core.ts:75-142`, `invocation-economics.ts:55-172`, `ai-usage.ts:60-130`, `failures.ts:45-76`, `brief-ops.ts:193-201`, `lib/platform/customer/customer-core.ts:262-291` + `customer-detail.ts:120-124`, `lib/platform/provider-health.ts:575-578` | |
| Routes | `app/api/platform/platform-ops/{api-usage, ai-usage-trend, ai-invocations, brief-ops, cost, plaid-usage}/route.ts` (PLATFORM_OPS READ); `customer-success/customers/[userId]` (CUSTOMER_SUCCESS READ) | |
| Surfaces | `OpsApiUsageWidget`, `OpsAiTrendWidget`, `OpsAiInvocationsWidget`, `OpsBriefOpsWidget`, `OpsCostWidget`, UX P1 `overview/{AiActivityBlock, EconomicsBlock}` | every dollar captioned "estimate, not a bill" (`ai-economics-view.ts:32-34`) |
| A second arithmetic | `lib/ai/brief/generate.ts:205-213` `costOf()` — same formula, rate day = today not `occurredAt`; result only in ephemeral `meta.costUsd` | duplicate of the authority; never stored |

Write path: every returned completion → five counter upserts (`calls, prompt_tokens, cached_prompt_tokens, completion_tokens, reasoning_tokens`) plus one `AiInvocation` row; every thrown call → one zero-token failure row (FAILED / TIMEOUT / RATE_LIMITED / QUOTA), each retry its own row. A returned completion **without** a `usage` object writes nothing (`provider.ts:108`). The recorded model is the requested alias, not `completion.model` (`provider.ts:217,339,483`).

Model selection: `CHAT_MODEL = 'gpt-5.1'` hard-coded (`lib/ai/conversation/engine.ts:61`), same for the Daily Brief (`lib/ai/brief/daily-brief.ts:26`) and the labeller (`engine.ts:378-382`); `gpt-4o-mini` is the legacy default for a dead helper and for structured calls that omit a model (`provider.ts:67,440`); no routing by entitlement or policy group. The `"o1"` hits in the code are test fixture ids, not a model.

### 1.2 Plaid

| Layer | Path | Role |
|---|---|---|
| Client chokepoint | `lib/plaid/client.ts:76-100` (Proxy: every SDK call → `recordApiUsage("PLAID", <method>, "calls", 1)`; inside a refresh execution also one `ProviderCall` row per attempt via `lib/plaid/provider-call.ts:100-148`) | per-request telemetry, unpriced |
| Link token | `app/api/plaid/link-token/route.ts:164,182-187,218-250` | fresh link `products: [Transactions]`, `additional_consented_products: [Investments]` always; update mode passes `access_token`; `transactions.days_requested: 730` |
| Exchange / Item creation | `lib/plaid/exchangeToken.ts:197-262` (upsert on `externalItemId`; `environment` stamped on create only from `deploymentEnvironment()` = Vercel env) | duplicate gate `:204-224` (ACTIVE-only, best-effort `itemRemove` + 409) |
| Sync | `lib/plaid/syncTransactions.ts:422-427` (`transactionsSync`), `lib/plaid/refresh.ts:193-196` (`accountsGet` every pipeline), `lib/plaid/sync-investments.ts:130-133` (`investmentsHoldingsGet`, consent-gated, link + manual refresh only), `lib/investments/investment-event-ingest.ts:273-280` (`investmentsTransactionsGet`, flag-gated `INVESTMENT_EVENTS_ENABLED`) | |
| Removal | `lib/plaid/disconnect.ts:71-153` (`itemRemove` → REVOKED + `PLAID_ITEM_REVOCATION_{CONFIRMED,UNCONFIRMED}` marker), `lib/account-deletion/purge.ts:95-135`, operator retry `app/api/platform/platform-ops/provider-cleanup/route.ts:86-139` | no scheduled retry (`:34`) |
| Cost model | `lib/platform/plaid/item-months.ts:66-168,235-296`; reader `lib/platform/plaid/usage.ts:38-164`; route `plaid-usage` (PLATFORM_OPS READ); `OpsPlaidUsageWidget.tsx:60-89`; `EconomicsBlock.tsx:56-58`; overview tile `lib/platform/ops/overview.ts:149-159` | ESTIMATED tier, both cycle readings, `limits{dailyAllocation:false}` |
| Status ledger | `lib/connections/health-transitions.ts:56-130` (`AuditLog PLAID_ITEM_STATUS_CHANGED {from,to,errorCode}` on change) | the retirement authority for Item-months |
| Webhooks | `lib/plaid/webhook-receiver.ts:47-50,92-99,123-127` (TRANSACTIONS/* and HOLDINGS/DEFAULT_UPDATE ⇒ sync scheduled; everything else acknowledged; non-ACTIVE Items refused; every delivery persisted to `PlaidWebhookEvent`) | webhooks cannot add Items |
| Invoice evidence | `docs/invoices/Plaid-2026-08-Invoice.pdf`; reconciliation `docs/plans/PLATFORM-OPS-COST-ACCOUNTING-INVESTIGATION.md:145-151` | July 2026: $12.00 Transactions / 40 Item-months; $13.40 total; 4 Investments Item-months |

---

## 2. Actual AI formula implemented (VERIFIED)

`lib/usage/pricing.ts:243-260`, applied per `(provider, metric = "chat.completions:<model>", UTC day)` group:

```ts
const tokens = g.prompt + g.completion; if (tokens === 0) continue;
const rate = g.model ? rateAt(g.provider, g.model, g.day, rates) : null;
if (!rate) { unpriced += tokens; unpricedDays.add(g.day); continue; }
const uncached = Math.max(0, g.prompt - g.cached);
const cached   = Math.min(g.cached, g.prompt);
usd += (uncached * rate.usdPerMillion.input
      + cached   * rate.usdPerMillion.cachedInput
      + g.completion * rate.usdPerMillion.output) / 1_000_000;
```

Returned as `{ usd: anyPriced ? usd : null, pricedTokens, unpricedTokens, unpricedDays }` (`:262-267`). All adapters feed this one function: per invocation (`invocation-economics.ts:55-69`), per group (`invocations-core.ts:75-82,99`), per day over the counter (`ai-usage.ts:85-91`), per customer (`customer-core.ts:268-283`, RETURNED only), per Brief (`brief-ops.ts:193-201`).

Mapped onto the owner's reference formula:

| Component | Implemented | Where | Rates | Configurable | Model-specific | Historical rates | Reconciled | Missing data |
|---|---|---|---|---|---|---|---|---|
| INPUT_TOKEN_COST (uncached) | yes | `:255` | `AI_RATES.input` | code only (no env, no DB) | yes | `effectiveFrom`, latest ≤ day (`:160-168`); usage before 2026-09-08 permanently unpriced | no | no rate ⇒ `usd: null`, tokens reported as unpriced |
| CACHE_READ_COST | yes | `:256` | `.cachedInput` | code | yes | yes | no | same |
| OUTPUT_TOKEN_COST | yes | `:257` | `.output` | code | yes | yes | no | same |
| Reasoning | counted, **not priced** (subset of output) | `:220-222` | — | — | — | — | — | explanatory only |
| CACHE_WRITE_COST | not applicable to models in use | — | — | — | — | — | — | would be needed for GPT-5.6+ |
| OTHER_PROVIDER_CHARGES (tool calls, batch, long context) | tool calls counted at $0; batch not used; long-context tier not modelled | `:223` | — | — | — | — | — | — |

Places that yield a number with partial coverage: `ai-usage.ts:94-102` and `invocation-economics.ts:97` fold unpriced days or invocations at $0 once anything is priced, while reporting the unpriced counts beside the total. `cost.ts:103-106` never yields a number (`spend-usd` is `null`, tier `unknown`). `isPricingConfigured()` is `AI_RATES.length > 0` (`:151-153`), always true today.

**Financially accurate?** For what it models, yes: the arithmetic and the subset handling match the provider's rules, and every configured rate matches the official standard tier today. It is **not a statement of spend**: it is unreconciled against the OpenAI bill, cannot separate the three environments that share one OpenAI account, counts harness traffic in counter-based figures, and silently misprices after any provider price change.

---

## 3. AI pricing verification

### 3.1 Configured rates vs official (ACTUAL PROVIDER PRICING: OpenAI, `developers.openai.com/docs/pricing`, standard tier, short context, fetched 2026-10-15)

| Model | Configured input / cached / output (USD per 1M) `pricing.ts:70-87`, effectiveFrom 2026-09-08 | Official 2026-10-15 | Verdict | In use |
|---|---|---|---|---|
| gpt-5.5 | 5.00 / 0.500 / 30.00 | 5.00 / 0.50 / 30.00 (<272K); **10.00 / 1.00 / 45.00 above 272K input** | rates equal; long-context tier not modelled | harness "ceiling" arm only |
| gpt-5.1 | 1.25 / 0.125 / 10.00 | 1.25 / 0.125 / 10.00 | equal | **live** (chat, Brief, labeller) |
| gpt-5 | 1.25 / 0.125 / 10.00 | 1.25 / 0.125 / 10.00 | equal | none |
| gpt-5-mini | 0.25 / 0.025 / 2.00 | 0.25 / 0.025 / 2.00 | equal | none |
| gpt-5-nano | 0.05 / 0.005 / 0.40 | 0.05 / 0.005 / 0.40 | equal | none |
| gpt-4.1 | 2.00 / 0.500 / 8.00 | 2.00 / 0.50 / 8.00 | equal | harness "mid" arm |
| gpt-4.1-mini | 0.40 / 0.100 / 1.60 | not on the fetched table | NOT VERIFIED | none |
| gpt-4o-mini | 0.15 / 0.075 / 0.60 | 0.15 / 0.075 / 0.60 | equal | legacy default (dead helper) |
| gpt-4o, o1, o3, o4-mini | not configured | 2.50/1.25/10.00 · 15/7.5/60 · 2/0.5/8 · 1.10/0.275/4.40 | not needed (no call site) | none |

Batch tier (≈50 % of standard) is published but not used by the product. Models in use with no rate: none. Risk: a dated snapshot id set through `AI_CHAT_MODEL` would be unpriced.

### 3.2 Billing-rule verification (official OpenAI guides, fetched 2026-10-15)

- **Cached input** (`developers.openai.com/docs/guides/prompt-caching`): cached tokens are billed at the reduced cached-input rate ("discounted up to 95 %"); the guide's own cost formula subtracts cached (and cache-write) tokens from `input_tokens`, so cached tokens are **inside** the input total — matching `pricing.ts:253-257`. For models before GPT-5.6 there is **no additional cache-write charge**; for GPT-5.6 and later "cache writes cost 1.25× the standard, uncached input-token rate" and are "not an additive fee" (a token uses exactly one of the three input rates). Cached-token counts on earlier models are reported "rounded down to the nearest multiple of 128".
- **Reasoning** (`developers.openai.com/docs/guides/reasoning`): reasoning tokens "are billed as output tokens" and appear as `output_tokens_details.reasoning_tokens`, a breakdown of `output_tokens`, not an addition — matching `pricing.ts:220-222`. On gpt-5.1 without `reasoning_effort` the recorded value is always 0 (`docs/plans/OPERATIONALIZATION-P0-REPORT-2026-10-07.md:34`).

### 3.3 Discrepancies and gaps (AI)

| # | Severity | Finding | Evidence |
|---|---|---|---|
| A1 | HIGH | No provider reconciliation: no invoice record, no OpenAI Costs/Usage API pull, no `ProviderInvoice` | `pricing.ts:7-11`; `OPERATIONALIZATION-INVESTIGATION-2026-10-07.md:233` |
| A2 | HIGH | One OpenAI account spans dev, preview and prod; each has its own database; no surface can total the bill | `schema.prisma:3322-3325`; `invocation-economics.ts:161-168` |
| A3 | MED | Rate card is a single 2026-09-08 reading; no staleness check or price-change alert | `pricing.ts:55-69` |
| A4 | MED | Two ledgers written independently, fire-and-forget, errors swallowed; no job compares them | `provider.ts:109-113`; `record.ts:53-55`; `invocation.ts:162-164` |
| A5 | MED | Counter-based spend cannot exclude harness/eval traffic (dev ledger was 372 of 443 rows harness) | `OPERATIONALIZATION-INVESTIGATION:201` |
| A6 | MED | No token or dollar allowance per user, no daily cap, no spend alert; `quota-low` is dormant and bound to the FX provider | `lib/entitlements/catalogue.ts:42-47`; `lib/alerts/rules.ts:147-155` |
| A7 | LOW | Second cost arithmetic in the Brief generator; rate day = now | `brief/generate.ts:205-213,265` |
| A8 | LOW | Completion without `usage` writes no row at all | `provider.ts:108` |
| A9 | LOW | Recorded model = requested alias, not the served snapshot | `provider.ts:217,339,483` |
| A10 | LOW | Totals fold unpriced days at $0 once anything is priced (coverage reported beside) | `ai-usage.ts:94-102` |
| A11 | LOW | Stale captions claim failures are unrecorded and rows carry no identity | `OpsAiInvocationsWidget.tsx:31`; `brief-ops.ts:25` |
| A12 | LOW | `AiInvocation.userId` not scrubbed on account purge (recorded P2) | `lib/account-deletion/*`; STATUS §8 |
| A13 | INFO | gpt-5.5 long-context tier and GPT-5.6+ cache-write rate not representable in the rate card shape | `pricing.ts:70-87` |

Not defects: reasoning double-count (prevented), cached double-count (prevented, pinned `pricing.test.ts:63-64`), Plaid calls priced as AI (prevented by `modelFromMetric`), units (per 1M, floor on fractional counts, correct).

---

## 4. AI cost attribution (VERIFIED)

| Dimension | Available | Reader | Area |
|---|---|---|---|
| User | `AiInvocation.userId` | `customer-detail.ts:120-124` → `customer-core.ts:262-291` (30 d: invocations, outcomes, surfaces, conversations, tokens, estimated USD) | CUSTOMER_SUCCESS only; fleet readers mark it `RECORDED_NOT_EXPOSED` (`invocations.ts:234-239`) |
| Space | `AiInvocation.spaceId` (soft) | no reader aggregates by Space | — |
| Conversation | `conversationId`, `correlationId#turnIndex` (turn), session | `invocation-economics.ts` by turn/session/model/day/environment — **no route consumer** | — |
| Feature | `surface` ∈ {chat, brief, harness}; `subSurface` (`chat:answer`, `chat:guidance`, `brief:generate`) | `invocations-core.ts` groups by surface | PLATFORM_OPS |
| Provider / model | `provider`, `model` (alias) | all readers | |
| Background operations | none: no AI call sites under `lib/jobs`; the Brief is generated lazily on view | — | |
| Platform-wide overhead | **Platform Spaces make no AI calls** (no provider import under `app/api/platform` or `lib/platform` except the ledger reader); the only non-customer AI usage is the evaluation harness (`surface='harness'`, no userId) | | |
| Environment | `environment` column (Vercel env) within one database | | |

Gaps: `ApiUsageCounter` has no user, Space, surface or environment dimension, so every fleet-grain spend figure (AI activity block, Economics block, API usage widget, trend) mixes customer and harness traffic and cannot be allocated. Per-conversation economics exist as a pure reader with no route.

---

## 5. Plaid: products, endpoints and billable events (VERIFIED)

Products requested: Transactions (`products`), Investments (`additional_consented_products`, always, non-gating). Never requested or called: Liabilities, Identity, Auth, Balance (`/accounts/balance/get`), Assets, Statements, Income, Enrich, `/transactions/refresh`, `/investments/refresh`, `/item/get` (one offline script only), `/institutions/get_by_id`.

| Endpoint | Call sites | Plaid billing class (official billing page, fetched 2026-10-15) |
|---|---|---|
| `/link/token/create`, `/item/public_token/exchange` | link-token route; `exchangeToken.ts:197` | not billed |
| `/accounts/get` | `exchangeToken.ts:324`; `refresh.ts:193-196` (every pipeline); `backgroundHistorySync.ts:547` | not a per-request product |
| `/transactions/sync` | `syncTransactions.ts:422-427` | inside the Transactions subscription |
| `/investments/holdings/get` | `sync-investments.ts:130-133` (link + manual refresh only; cron never calls it) | adds the Investments **Holdings** subscription to the Item |
| `/investments/transactions/get` | `investment-event-ingest.ts:273-280` (holdings sync; cron post-loop, flag-gated) | adds Investments **Transactions** (and Holdings) |
| `/item/remove` | `disconnect.ts:103`; `exchangeToken.ts:217`; `purge.ts:114`; ops scripts | ends the Item's subscriptions |
| `/webhook_verification_key/get` | `webhook-verify.ts:131` | not billed |

Plaid's official billing rules (`plaid.com/docs/account/billing`, fetched 2026-10-15): Transactions (except `/transactions/refresh`), Recurring Transactions, Liabilities and Investments (except `/investments/refresh`) are **subscription-fee products billed per Item per calendar month in UTC**; "fees for Items created or removed mid-month are not pro-rated"; a subscription is charged "even if no API calls are made for the Item" or if calls "cannot be successfully made for the Item (e.g. because the Item is in an error state)"; billing continues "as long as a valid `access_token` exists for the Item" and ends on `/item/remove` (or end-user revocation); the same subscription is not added twice to one Item; adding Investments via Link or calling holdings adds Holdings only, while calling investments transactions adds both. One-time products (Auth, Identity, Income, Layer) and per-request products (`/accounts/balance/get`, refresh endpoints, Signal, Transfer, reports) are **not used** by Fourth Meridian.

**Billable events as modelled by Fourth Meridian:** one Item-month per billable Item per calendar cycle for Transactions, plus one for Investments when `investmentsConsent` is non-null (`item-months.ts:135-168`); statuses NEEDS_REAUTH and ERROR count as billable (correct per Plaid's rule); only a recorded REVOKED transition retires an Item (`:88-94`); seeded fixtures (`demo_item_*`) excluded (`:66-67`); no proration (correct per Plaid); two cycle readings, present-during and present-at-end, with `agree` (`:285-296`).

Contract rates: **UNKNOWN as a price sheet.** Neither Plaid's pricing page nor its billing page lists any per-unit dollar price ("Contact for pricing"; "Pricing is viewable only through the Production access request form"). Fourth Meridian's configured rates are invoice-derived: Transactions **$0.30 per Item-month** ($12.00 / 40 Item-months, July 2026 invoice S-J7Y5657ZK0-2607) and Investments **$0.35 per Item-month** (($13.40 − $12.00) / 4, by subtraction, not quoted) — `pricing.ts:129-134`. These are CONFIGURED APPLICATION PRICING consistent with one invoice, not ACTUAL PROVIDER PRICING. Plaid plan: Pay-as-you-go ("no minimum spend or commitment") per the public plan descriptions; the account's plan is not recorded in the repository (UNKNOWN).

---

## 6. Actual Plaid formula implemented (VERIFIED)

```
PLAID_COST_ESTIMATE(cycle, reading) =
    Σ_{billable Items present under reading}            rate(transactions, cycle.start)
  + Σ_{those Items with investmentsConsent != null}     rate(investments,  cycle.start)
  rate = plaidRateAt(product, cycle.start) ∈ {0.30, 0.35} for cycle.start ≥ 2026-07-01, else null (unpriced, never zero)
```

| Reference component | Modelled | Notes |
|---|---|---|
| RECURRING_ITEM_CHARGES | yes (only component) | per Item × product × calendar month |
| PRODUCT_ACTIVATION_CHARGES | no | no one-time product is used; correct by construction. Investments has no activation timestamp, so past cycles are unevidenced (`item-months.ts:130-133`) |
| BILLABLE_REQUEST_CHARGES | no, by design | no per-request product is called; `/accounts/get` and `/transactions/sync` are inside the subscription. Per-call telemetry exists but is never priced (`pricing.ts:173-177`) |
| OTHER_CONTRACTUAL_CHARGES | no | minimums, credits, tax, refunds unknown |

**Financially accurate?** The shape is right for the products in use and matches Plaid's published rules (per Item, per calendar month, no proration, error-state Items still billed, removal ends billing). Four things make the number an estimate rather than a bill:

1. **Rates are one invoice's quotients** (Investments by subtraction) — UNKNOWN whether they hold across plan changes, volume, or the Holdings-vs-Transactions bundling Plaid applies.
2. **Investments is over-counted**: any non-null `investmentsConsent` (ENABLED, CONSENT_REQUIRED, UNSUPPORTED) is priced (`item-months.ts:161`), while Plaid only adds the subscription once holdings are actually fetched. INFERRED to overstate.
3. **Sandbox Items are priced**: `PlaidItem.environment` is the Vercel environment (`lib/env.ts:239-246`), stamped on create only, null on legacy rows; Preview has used Plaid sandbox since 2026-10-06, so its Items (e.g. the 12 OBSERVED on Preview: "12 billable Items; 12 transactions and 3 investments Item-months this cycle, $4.65 estimated") are priced as if production. Plaid sandbox Items cost nothing.
4. **Lower-bound census**: pre-ledger Items and the 9 production orphans with lost tokens are invisible (`item-months.ts:186-207`; `docs/operations/plaid-support-ticket-orphaned-items.md`); UNCONFIRMED removals are counted billable (correct) but never retried automatically.

### 6.1 Plaid cost attribution

| Dimension | Possible | Join / note |
|---|---|---|
| User | yes | `PlaidItem.userId` (CUSTOMER_SUCCESS: `customer-detail.ts:85-86`); the fleet cost reader deliberately selects no userId (`usage.ts:79-81`) |
| Item | yes | native grain |
| Institution | yes | `PlaidItem.institutionId/Name`; not selected by the cost reader (identity minimization) |
| Account | structurally | `AccountConnection.plaidItemDbId` → `FinancialAccount`; cost is never split to accounts — **one Item with N accounts is one billable Item, never N** (`item-months.ts:144-166`) |
| Product | Transactions, Investments | `billed_products` / `consented_products` from `/accounts/get` are read but not persisted (`lib/plaid/investmentsConsent.ts:30-54`) |
| Space | indirect | Items belong to Users; `FinancialAccount.ownerSpaceId` would allocate accounts, not Items |
| Background vs manual | executions only (`RefreshExecution.trigger`) | irrelevant to subscription cost |
| Environment | partial | Vercel env only; Plaid env is global per deployment |

### 6.2 Controls in place and cost-growth vectors

Controls (VERIFIED): link-token 10 per 15 min per user; exchange 10 per 15 min; manual refresh 20 per hour; manual bank cooldown entitlement (policy 60 min, founder 15, floor 15); cron `sync-banks` daily on ACTIVE Items of live owners; admission gate on every pipeline; per-Item sync lock; ACTIVE-only duplicate gate with rollback; investments consent learned from `PRODUCTS_NOT_SUPPORTED`; operator cleanup read with manual retry.

Growth vectors (VERIFIED unless noted): (1) a fresh link to an institution whose Item is NEEDS_REAUTH or ERROR mints a second billable Item while the first keeps billing until revoked; (2) UNCONFIRMED removals keep billing with no scheduled retry; (3) dev/preview churn on the shared production client id was about $11.70 of the $12.00 July Transactions line (mitigated by the Preview sandbox lane since 2026-10-06); (4) Investments consent is requested on every fresh link and becomes billable the first time holdings are fetched, which happens at link for any investment-type account; (5) Admin "Expand History" mints a new Item per use; (6) **no connection-count entitlement exists** (`lib/entitlements/catalogue.ts:40-57`).

---

## 7. Financial model (ESTIMATED; projections, not spending)

All per-user figures are **per active user per month** at CONFIGURED APPLICATION PRICING (OpenAI rates verified today; Plaid rates = one invoice's quotients). Fixed infrastructure (Vercel, Supabase, Sentry, Resend, Open Exchange Rates, Alchemy, CoinGecko plans) is **not assessed** here: their plan tiers are not recorded in the repository (UNKNOWN) and they are fixed or stepped, not per-user variable.

### 7.1 Unit inputs

| Input | Low | Baseline | High | Basis |
|---|---|---|---|---|
| AI cost per chat turn (gpt-5.1, ~80 % cached) | $0.0065 | $0.0116 | $0.0116 | OBSERVED in dogfood ledgers: $0.0065 (`AI-GPT51-RETRIEVAL-DISPOSITION-EXPERIMENT.md:340`), $0.0104 (`AI-TRANSACTION-PAGE-COVERAGE.md:185`), $0.0116 (`AI-GPT51-PROMOTION-DOGFOOD-GATE.md:237`) |
| AI cost per Daily Brief | $0.003 | $0.004 | $0.005 | `PRE-S1-FULL-SYSTEM-AUDIT-2026-09-21.md:652`; memory of live runs $0.0034–0.005 |
| Chat turns per active user per month | 20 | 60 | 200 | ASSUMPTION |
| Briefs viewed per active user per month | 15 | 30 | 30 | ASSUMPTION (one per day, lazily generated on view) |
| Plaid Items (institutions) per active user | 1 | 2 | 4 | ASSUMPTION; OBSERVED on Preview: 3 live connections across 5 customers |
| Share of Items with Investments | 25 % | 50 % | 75 % | ASSUMPTION |
| Duplicate / stranded Item overhead | 0 % | 10 % | 25 % | ASSUMPTION from vectors (1)–(2) in §6.2 |
| Model-routing shock (gpt-5.5 at $0.0741/turn) | — | — | shown separately | OBSERVED `AI-BETA-COST-ECONOMICS-INVESTIGATION.md:11-23` |

### 7.2 Per active user per month

| | Low | Baseline | High |
|---|---|---|---|
| AI chat | 20 × 0.0065 = $0.13 | 60 × 0.0116 = $0.70 | 200 × 0.0116 = $2.32 |
| AI Brief | 15 × 0.003 = $0.05 | 30 × 0.004 = $0.12 | 30 × 0.005 = $0.15 |
| **AI_PROVIDER_COST** | **$0.18** | **$0.82** | **$2.47** |
| Plaid Transactions | 1 × 0.30 = $0.30 | 2 × 0.30 = $0.60 | 4 × 0.30 = $1.20 |
| Plaid Investments | 0.25 × 0.35 = $0.09 | 1 × 0.35 = $0.35 | 3 × 0.35 = $1.05 |
| Duplicate overhead | $0 | +10 % = $0.10 | +25 % = $0.56 |
| **PLAID_COST** | **$0.39** | **$1.05** | **$2.81** |
| OTHER identified variable costs | $0 (none per-user today) | $0 | $0 |
| **TOTAL_VARIABLE_COST per active user** | **$0.57** | **$1.87** | **$5.28** |

Derived unit figures (baseline): COST_PER_AI_REQUEST ≈ $0.012 (turn) / $0.004 (Brief); COST_PER_CONVERSATION ≈ $0.12 at 10 turns; COST_PER_SPACE ≈ per-user cost ÷ Spaces per user (Spaces carry no cost of their own; Items are per user); AI_COST_PER_FEATURE: chat ≈ 85 % of AI cost, Brief ≈ 15 %, harness/evals = operational overhead (0 for customers, variable with engineering activity). Model-routing shock: promoting chat to gpt-5.5 at $0.0741/turn makes baseline AI $4.56 and high AI $14.97 per active user — the single largest controllable swing.

### 7.3 Monthly platform variable cost (active users = all users at 5; 70 % at 50; 50 % at 500 and 5,000 — ASSUMPTION)

| Users | Active (assumed) | Low | Baseline | High | High + gpt-5.5 routing |
|---|---|---|---|---|---|
| 5 | 5 | $2.85 | $9.35 | $26 | $89 |
| 50 | 35 | $20 | $65 | $185 | $622 |
| 500 | 250 | $143 | $468 | $1,320 | $4,445 |
| 5,000 | 2,500 | $1,425 | $4,675 | $13,200 | $44,450 |

Caveats: Plaid Items persist for inactive users and keep billing (Plaid bills while the access token exists), so Plaid cost tracks **connected** users, not active users — at 5,000 registered users with 50 % inactive, add roughly the inactive users' Item-months (baseline +$2,375/month) unless disconnection on inactivity is enforced. Plaid Growth/Custom plans add minimum commitments (UNKNOWN amounts). None of these figures is actual spending.

### 7.4 Margin and break-even (no customer price exists — illustrative)

GROSS_MARGIN = (CUSTOMER_REVENUE − ATTRIBUTABLE_COST) / CUSTOMER_REVENUE, variable costs only (fixed infrastructure and overhead excluded):

| Illustrative price per active user per month | Low cost $0.57 | Baseline $1.87 | High $5.28 |
|---|---|---|---|
| $5 | 89 % | 63 % | −6 % |
| $10 | 94 % | 81 % | 47 % |
| $20 | 97 % | 91 % | 74 % |

BREAK_EVEN_REVENUE_PER_USER (variable only) = $0.57 / $1.87 / $5.28 per active user per month. Fixed costs push the true break-even higher; they are not assessed here.

### 7.5 Where costs could increase unexpectedly (ranked)

1. Model routing or reasoning effort changes (gpt-5.5 is 6× per turn; a dated snapshot id would be unpriced and invisible).
2. Plaid Items that outlive their users or their connections (no inactivity disconnect; UNCONFIRMED removals; duplicate Items beside broken ones; no connection-count entitlement).
3. OpenAI price changes going unnoticed (single-reading rate card, no reconciliation).
4. Long-context prompts on gpt-5.5 (>272K tokens bills a 2× tier the card cannot express).
5. Harness/eval runs on a shared account inflating the bill while being invisible in fleet figures.
6. Investments subscriptions added on link for every investment-type account (one extra Item-month each).

Safeguards evaluated (none implemented in this assessment): per-user AI daily allowance over `AiInvocation` (reader exists as a P2 item); an `ai-spend-high` alert rule (fleet + per-user, one registry entry); model routing pinned to a rate-carded model with a test that every call-site model has a rate; a connection-count entitlement (`maxConnections`); an inactivity disconnect policy with owner ruling; duplicate detection widened to non-ACTIVE Items of the same institution (re-link instead of re-mint); scheduled retry of UNCONFIRMED removals; a `ProviderInvoice` record per provider per month with a reconciliation reader; rate versioning kept as is plus a "rate age" caption and staleness alert; Plaid environment recorded on the Item (sandbox excluded from cost).

---

## 8. Attribution gaps (both providers)

| Gap | Effect | Minimum fix (not implemented) |
|---|---|---|
| Fleet AI figures are counter-based (no user/surface/env) | harness traffic and customers indistinguishable on Platform Ops | derive fleet figures from `AiInvocation` grouped by surface; keep the counter as the reconciliation cross-check |
| No per-conversation route | cost per conversation only computable offline | expose `invocation-economics` by session (CUSTOMER_SUCCESS) |
| No Space attribution | cost per Space unavailable | group `AiInvocation.spaceId`; Items stay per user by construction |
| Plaid cost reader selects no userId | per-user Plaid cost unavailable even in Customer Success | add `userId` to the Item facts for the CS area only |
| Platform Spaces consume no AI | operational AI overhead is the harness only | tag harness runs as overhead in reporting |

---

## 9. Beta analytics readiness (VERIFIED)

No product-analytics SDK exists (`package.json:109-110` has only Sentry, error capture, `tracesSampleRate: 0`; `app/layout.tsx` has no script). Every figure is a projection over `AuditLog`, `UserSession`, `AiInvocation`, `ApiUsageCounter`, `User`, `PlaidItem`, `DailyBrief`.

| Metric | Status | Source | Gap |
|---|---|---|---|
| DAU / WAU / MAU | PARTIALLY IMPLEMENTED | `AuditLog LOGIN` → `lib/platform/activity/activity.ts:68-110` → `growth-revenue/activity` | LOGIN fires only on credential sign-in under a 30-day JWT (`lib/auth.ts:525,718-719`) ⇒ undercounts (INFERRED); `UserSession.lastActiveAt` (bumped ≤ every 60 s, `lib/auth.ts:668`) is the better basis but is one mutable column, so no series |
| Feature adoption | NOT IMPLEMENTED | per-feature audit writers exist for Spaces, manual accounts, Plaid actions, exports; conversations via `AiInvocation.surface='chat'` | no view events for chat page, Brief view (`app/api/brief/route.ts:27-46` writes nothing), Space view, transactions, scenario (sealed cookie) |
| Space engagement | PARTIALLY IMPLEMENTED | `AuditLog SPACE_SWITCH` → `activity.ts:82-93` top Spaces | explicit switches only, not opens; no per-user × Space |
| AI requests / tokens / spend per user | IMPLEMENTED (Customer Success only) | `customer-detail.ts:122-126` → `customer-core.ts:262-291`, 30 d, estimated USD | no fleet per-user table or per-day series |
| Plaid-connected users | PARTIALLY IMPLEMENTED | per customer `customers.ts:58`; lifecycle stage `customer-core.ts:89,206` | no fleet count; funnel has no "connected" stage (`growth.ts:30-36`) |
| Plaid Items per user | IMPLEMENTED (CS) | `customer-detail.ts:84-85` | — |
| Plaid operating costs | IMPLEMENTED (ESTIMATE, fleet) | `plaid/usage.ts` | per-user allocation absent |
| Cost per active user | NOT IMPLEMENTED | components exist; `cost.ts:103-106` is `null` | no composer; MAU denominator unreliable |
| Usage trends | PARTIALLY IMPLEMENTED | AI per day (counter); invocations by day ≤ 30 d | signups/day and activity/day absent (viz investigation G5/G6); per-user per-day absent |
| Retention and engagement | PARTIALLY IMPLEMENTED | `returning7` ratio (`growth.ts:107-112`); per-customer last active | no D1/D7/D30 cohorts; no engagement depth over time |
| Cost anomalies | NOT IMPLEMENTED | six alert rules, none on cost (`lib/alerts/rules.ts:95-156`) | no spend threshold, no per-user outlier, no drift |

**Minimum instrumentation for the first five beta users (recommended, not implemented):**

- P0, readers only, no new events: (1) per-user usage/cost roll-up in the Customer Success list (`aiInvocation.groupBy(['userId'])`, 30 d, priced per model-day; Plaid ACTIVE non-demo Items already counted); (2) rebase active users on `UserSession.lastActiveAt`, keep LOGIN as "sign-ins"; (3) a cost-per-active-user composer ((AI 30 d + Plaid current cycle) ÷ distinct active users, ESTIMATED, null when either side unpriced); (4) fleet "users with ≥1 ACTIVE Item" in the growth funnel; (5) signups/day as a minted projection.
- P1, three new `AuditLog` actions through `buildAuditData`/`auditInsert` (one row per user-day each, ≤15 rows/day at five users; kept out of Security History and the member Space feed): `SESSION_ACTIVE_DAY` (from the session callback beside `touchSessionActivity`, unlocks DAU/WAU/MAU series and D1/D7/D30 cohorts), `SPACE_VIEWED` (once per user, Space, UTC day from the Space server page; no spaceName in metadata), `BRIEF_VIEWED` (from `GET /api/brief` on success).
- P2: an `ai-spend-high` alert rule (fleet and per-user 24 h USD vs a `PlatformSetting` threshold) and the `AiInvocation.userId` purge scrub already recorded as P2.
- Not needed for five users: scenario/transactions events, a per-user counter dimension, any third-party SDK.

---

## 10. Recommended improvements and implementation priorities

| Priority | Improvement | Scope | Why |
|---|---|---|---|
| 1 | Record the Plaid environment on each Item at creation (`PLAID_ENV` at link time) and exclude sandbox from cost; backfill legacy rows by the known cutover date | additive column or reuse of `environment` with a Plaid value; small migration **needs approval** | Preview's $4.65 is sandbox and counted today |
| 2 | Price Investments only when `investmentsConsent === ENABLED` (or when holdings were actually fetched) and persist `billed_products` from `/accounts/get` | reader change; one additive column for `billedProducts` **needs approval** | removes an over-count and gives the one provider-side product signal |
| 3 | Widen the duplicate-Item gate to any non-REVOKED Item of the same institution (offer re-link), and add a scheduled retry of UNCONFIRMED removals | logic + one job entry | closes the two Plaid growth vectors |
| 4 | Fleet AI spend from `AiInvocation` grouped by surface (customer vs harness), keeping the counter as the cross-check; a reconciliation reader that compares the two ledgers | readers only | makes the Economics figures allocable and auditable |
| 5 | `ai-spend-high` alert + per-user daily allowance reader + a test that every call-site model has a rate | small | first cost safeguard; catches routing or snapshot drift |
| 6 | `ProviderInvoice` record (provider, period, amount, source) and a monthly reconciliation surface (OpenAI invoice/Costs export; Plaid invoice) | one table **needs approval** | turns estimates into reconciled figures |
| 7 | Beta analytics P0 readers, then P1 events | readers, then three audit actions | §9 |
| 8 | Connection-count entitlement and an owner-ruled inactivity disconnect policy | entitlement dimension + policy | bounds Plaid growth at scale |

---

## 11. Decisions requiring owner approval

| # | Decision |
|---|---|
| C1 | Record Plaid environment per Item (schema change) and exclude sandbox Items from cost |
| C2 | Investments pricing rule: ENABLED-only, or "holdings fetched at least once" |
| C3 | Persist `billed_products` / `consented_products` per Item (schema change) |
| C4 | Duplicate-Item gate widened to non-REVOKED Items; scheduled retry of UNCONFIRMED removals |
| C5 | `ProviderInvoice` table and monthly reconciliation; whether to pull the OpenAI Costs API |
| C6 | Fleet AI spend derived from the ledger by surface (harness excluded) rather than the counter |
| C7 | First cost safeguards: `ai-spend-high` alert threshold; per-user daily token/dollar allowance; connection-count entitlement value |
| C8 | Inactivity disconnect policy for Plaid Items (and its customer-facing wording) |
| C9 | Beta analytics P1 events (`SESSION_ACTIVE_DAY`, `SPACE_VIEWED`, `BRIEF_VIEWED`) and their visibility rules |
| C10 | Confirm the Plaid plan and obtain the contracted price sheet (replaces invoice-derived rates); confirm the OpenAI account/project split per environment |
| C11 | Whether an illustrative customer price should be adopted for planning (none exists; §7.4 is illustrative only) |

---

## 12. Sources

- OpenAI pricing (standard and batch tiers): https://developers.openai.com/docs/pricing — fetched 2026-10-15.
- OpenAI prompt caching rules: https://developers.openai.com/docs/guides/prompt-caching — fetched 2026-10-15.
- OpenAI reasoning tokens: https://developers.openai.com/docs/guides/reasoning — fetched 2026-10-15.
- OpenAI GPT-5.1 Chat model page (corroborating $1.25 / $0.125 / $10.00): https://developers.openai.com/docs/models/gpt-5.1-chat-latest — fetched 2026-10-15.
- Plaid billing rules: https://plaid.com/docs/account/billing/ — fetched 2026-10-15.
- Plaid pricing plans (no per-unit prices published): https://plaid.com/pricing/ — fetched 2026-10-15.
- Repository: `lib/usage/pricing.ts`, `lib/platform/plaid/item-months.ts`, `lib/platform/plaid/usage.ts`, `lib/ai/provider.ts`, `lib/ai/invocation.ts`, `lib/platform/ai/*`, `lib/platform/customer/*`, `lib/platform/activity/*`, `lib/alerts/rules.ts`, `docs/plans/PLATFORM-OPS-COST-ACCOUNTING-INVESTIGATION.md`, `docs/plans/AI-BETA-COST-ECONOMICS-INVESTIGATION.md`, `docs/plans/AI-GPT51-PROMOTION-DOGFOOD-GATE.md`, `docs/invoices/Plaid-2026-08-Invoice.pdf`.

*Assessment only. No implementation was started; no safeguard was built; no provider was called; nothing here is actual spending.*
