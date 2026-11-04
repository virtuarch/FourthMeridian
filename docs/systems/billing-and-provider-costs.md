# Billing and provider costs

> **Status markers:** **IMPLEMENTED** (code path or PR cited, verified against the code on
> this branch, 2026-11-02) · **DECIDED BUT NOT IMPLEMENTED** · **PROPOSED** · **DEPRECATED**.
> **Public repository:** this document carries provider **list prices** only. Account-specific
> invoices, contract pricing, actual monthly spend and cost-freeze billing evidence live in the
> owner's private store, never here (ADR-008 §6).

## Purpose

Fourth Meridian pays two variable-cost providers per customer action: **OpenAI** (every model
call made by Conversations, the Daily Brief and the evaluation harness) and **Plaid** (every
connected bank Item, per calendar month). This document is the canonical description of how
those costs are estimated, attributed, bounded and alerted on, which code paths cause a
billable event, and where the estimate is known to be wrong.

Every dollar the product shows is an **estimate** (usage × a code-owned rate). Neither
provider exposes a pollable invoice API, and no reconciliation against a real bill exists.
Surfaces say "estimate, not a bill" and must keep saying it.

## Authority

| Concern | Authority | Status |
|---|---|---|
| Rate card (the one pricing authority) | `lib/usage/pricing.ts` (`AI_RATES`, `PLAID_RATES`, `rateAt`, `plaidRateAt`, `priceAiUsage`, `modelFromMetric`) | IMPLEMENTED |
| AI usage vocabulary (subset rules) | `lib/usage/ai-tokens.ts` | IMPLEMENTED |
| AI invocation ledger (writer) | `lib/ai/invocation.ts` → `AiInvocation`; called only from the provider chokepoint `lib/ai/provider.ts` | IMPLEMENTED |
| Day-grain usage counter (writer) | `lib/usage/record.ts` → `ApiUsageCounter` | IMPLEMENTED |
| Attribution carrier | `lib/ai/invocation-context.ts` | IMPLEMENTED |
| Per-customer daily allowance | `lib/ai/allowance-core.ts` (pure), `lib/ai/allowance.ts` (loader), `lib/platform/ai/allowance-reservation.ts`, `lib/entitlements/ai-allowance.ts` (precedence) | IMPLEMENTED |
| Emergency pause (kill switch) | `lib/platform/ai/paid-requests-admission.ts` | IMPLEMENTED |
| Spend alerts | `lib/alerts/rules.ts` (`ai-spend-fleet-high`, `ai-spend-user-high`), `lib/platform/ai/spend-health.ts`, `lib/platform/ai/spend-thresholds.ts` | IMPLEMENTED |
| Ledger trust | `lib/platform/ai/ledger-health.ts` | IMPLEMENTED |
| Plaid Item-month census | `lib/platform/plaid/item-months.ts`, reader `lib/platform/plaid/usage.ts` | IMPLEMENTED |
| Operator controls | `lib/platform/ai/cost-controls.types.ts`, `GET/PATCH /api/platform/platform-ops/ai-cost-controls`, `GET /api/platform/platform-ops/ai-budget` | IMPLEMENTED |
| OpenAI project separation per environment | [operations/openai-environment-separation.md](../operations/openai-environment-separation.md), `lib/ai/openai-credentials.ts` | IMPLEMENTED (code); per-environment rollout is an operations matter |

## Core principle

> **Immutable usage facts. Versioned prices in code. Cost is a read-time reduction, never a
> stored column.** (IMPLEMENTED, `lib/usage/pricing.ts` header)

- A rate is resolved **at the day the usage occurred** (`effectiveFrom`, latest entry on or
  before the day). A rate change restates nothing historical; a corrected rate restates exactly
  the period it covers.
- Usage with no rate in force is reported **UNPRICED, never $0**. An unpriceable model never
  counts as zero and never bypasses a safeguard (owner rule, 2026-10-15).
- Prices are code, not schema or settings: they change on the provider's schedule, and there is
  no evidence yet that they must be operator-editable at runtime.
- `effectiveFrom` is the date we have **evidence** for, not the date the provider set the price.
  Backdating would fabricate provenance; to price earlier usage, add a second dated entry with
  its own `source`.
- No dollar column exists on any fact table (`AiInvocation`, `ApiUsageCounter`, `ProviderCall`).

## AI cost

### How a model call is priced — IMPLEMENTED

`priceAiUsage` reduces a **set** of usage rows (never one row at a time), per
`(provider, metric = "chat.completions:<model>", UTC day)`:

```
uncached = max(0, prompt − cached)
cached   = min(cached, prompt)
usd     += (uncached × input + cached × cachedInput + completion × output) / 1,000,000
```

Provider billing rules this encodes (OpenAI documentation, fetched 2026-10-15):

- **Cached tokens are a subset of prompt tokens**, billed at the cached-input rate. Pricing both
  at full rate double-counts; a per-row API cannot see both terms, which is why the reducer
  takes a set and `AiRate` carries input, cachedInput and output together (a cached rate cannot
  be registered without the input rate it discounts). Pinned in `lib/usage/pricing.test.ts`.
- **Reasoning tokens are a subset of completion tokens** and billed as output. They are recorded
  (explanatory) but never priced separately.
- **Tool-call arguments the model writes are billed as output.** Large enumerated arguments are
  an output-cost driver, not an input one.
- Prompt caching is automatic above 1,024 tokens, prefix-matched in 128-token increments, and the
  prefix includes tool definitions. Rewriting earlier messages ends the reusable prefix at the
  rewritten message. Changing `reasoning_effort` mid-session invalidates the cache.

### Rate card — IMPLEMENTED (`AI_RATES`, all `effectiveFrom: 2026-09-08`)

Source: OpenAI public pricing page, standard tier, short context, read 2026-09-08 and
re-checked equal on 2026-10-15 (`developers.openai.com/docs/pricing`). USD per 1M tokens.

| Model | Input | Cached input | Output | Use in the product |
|---|---|---|---|---|
| gpt-5.5 | 5.00 | 0.50 | 30.00 | harness comparison arm only |
| **gpt-5.1** | **1.25** | **0.125** | **10.00** | **live**: Conversations (`CHAT_MODEL`, `lib/ai/conversation/engine.ts`), Daily Brief, guidance labeller |
| gpt-5 | 1.25 | 0.125 | 10.00 | none |
| gpt-5-mini | 0.25 | 0.025 | 2.00 | none |
| gpt-5-nano | 0.05 | 0.005 | 0.40 | none |
| gpt-4.1 | 2.00 | 0.50 | 8.00 | harness comparison arm |
| gpt-4.1-mini | 0.40 | 0.10 | 1.60 | none (not on the 2026-10-15 public table; unverified) |
| gpt-4o-mini | 0.15 | 0.075 | 0.60 | legacy default in `lib/ai/provider.ts` (`AI_CHAT_MODEL` fallback) |

Not representable in the current rate shape (no call site needs them today): the gpt-5.5
long-context tier above 272K input tokens, and the cache-write rate that applies to GPT-5.6 and
later. Adopting either needs a rate-shape change first.

**Every production model must have a rate** (IMPLEMENTED): `lib/ai/model-rate-coverage.test.ts`
fails if a production call-site model literal has no rate effective today, and the chokepoint's
`assertPricedModel` (`lib/ai/provider.ts`) refuses an unpriced model **before** calling the
provider, writing a zero-token `FAILED / UNPRICED_MODEL` invocation row.

### The two ledgers — IMPLEMENTED

Every returned completion is written twice by the chokepoint (`recordOpenAiUsage`,
`lib/ai/provider.ts`):

| Ledger | Grain | Role |
|---|---|---|
| `ApiUsageCounter` (`20260713190000_add_api_usage_counter`) | `(provider, metric, unit, UTC day)`; units `calls`, `prompt_tokens`, `cached_prompt_tokens`, `completion_tokens`, `reasoning_tokens` | cheap trend and provider-health input; reconciliation cross-check. Has no user, Space, surface or environment dimension |
| `AiInvocation` (`20260908222415_ai_invocation`) | one model call | the cost authority: provider, model, token counts (cached ⊆ prompt, reasoning ⊆ completion), latency, tool-call count, finish reason, `environment`, `correlationId` + `turnIndex`, `surface` / `subSurface`, `userId`, `spaceId`, `conversationId`, `outcome`, `errorCode`, `providerRequestId` |

- Thrown calls write one zero-token failure row each (`FAILED`, `TIMEOUT`, `RATE_LIMITED`,
  `QUOTA`, `AI_PAUSED`, `UNPRICED_MODEL`); each retry is its own row.
- The `AiInvocation` write is **awaited** before the generation returns; a write failure is
  captured and counted by `lib/platform/ai/ledger-health.ts`, and the allowance reservation then
  fails closed (`LEDGER_UNTRUSTED`) until the signal ages out.
- **Data minimisation:** no prompt, completion or message content is stored, only counts, ids
  and timestamps. `userId`/`spaceId` are plain columns, not relations, so cost history survives
  a Space deletion; `AiInvocation.userId` is nulled on account purge
  (`lib/account-deletion/purge.ts`, pinned in `purge-census.test.ts`). Both tables are revoked
  from `fm_app`; writes go through `fm_system`.
- OpenAI project spend-limit 429s (`project_spend_limit_exceeded`,
  `organization_spend_limit_exceeded`) and `insufficient_quota` are classified as QUOTA and
  not retried (`lib/ai/rate-limit-retry.ts`).

### Attribution — IMPLEMENTED

`invocation-context.ts` carries correlation, turn, surface, sub-surface, user, Space and
conversation into every call without changing generator signatures. Surfaces: `chat`
(`chat:answer`, `chat:guidance`), `brief` (`brief:generate`), `harness` (the turn loop's default;
no user). **Customer spend = the `chat` and `brief` surfaces.** Harness and unattributed traffic is
engineering overhead and is never counted as fleet or customer spend. Platform Spaces make no
model calls. Per-user figures are visible to Customer Success; Platform Ops surfaces carry opaque
customer references only.

### Per-customer daily allowance — IMPLEMENTED

An estimated-dollar bound on the model calls one customer may cause per **UTC day** across
Conversations and the Daily Brief.

- **Effective value** (`lib/entitlements/ai-allowance.ts`, one pure function used by
  enforcement and every operator view): `USER_OVERRIDE > OVERLAY > PLATFORM_SETTING > POLICY`,
  then the catalogue ceiling clamps last. Catalogue (`lib/entitlements/catalogue.ts`,
  `aiDailyUsdAllowance`, whole USD): beta policy group $5, founder overlay $20, ceiling $20.
- **Per-customer override:** `CustomerPolicyAssignment.aiDailyUsdAllowanceOverride`
  (migration `20261016000000_customer_ai_allowance_override`), set or removed through the audited
  assignment service (`lib/platform/customer/assign.ts`) with a required reason; a value above the
  ceiling is **refused, not clamped**; audited as `CUSTOMER_AI_ALLOWANCE_OVERRIDE_CHANGED`.
- **Order in the routes** (`app/api/ai/chat/route.ts`, `app/api/brief/generate/route.ts`):
  authentication → entitlement → pacing → kill switch → allowance → body parse → model work. A refused turn costs no parse and no model call.
- **Verdict** (`reservedAllowanceVerdict`): (1) any unpriced invocation today refuses
  `UNPRICED_MODEL`, enforced or not; (2) with enforcement off nothing else refuses, but usage is
  still recorded; (3) otherwise refuse when `spent + inFlight × RESERVE_USD ≥ allowance`. An
  allowance of 0 refuses every turn.
- **Concurrency:** the decision runs in one short `fm_system` transaction under a per-customer
  advisory lock, counting in-flight turns (`RateLimit` counter, released in the routes' `finally`,
  self-healing within two hours). `RESERVE_USD` is **computed from the rate card** for
  `RESERVE_MODEL = gpt-5.1` × 7 invocations (6 answer hops + 1 guidance call) × 30,000 prompt +
  1,500 completion tokens, uncached (≈ $0.37 at the list prices above). **Guarantee, stated
  honestly:** admitted spend ≤ allowance + Σ(actual turn cost − reserve) over concurrently
  admitted turns. It is a bounded overshoot, **not an absolute hard cap**.
- **The lock is taken with `$executeRaw`, never `$queryRaw`**
  (`lib/platform/ai/allowance-reservation.ts`, pinned by its unit test).
  `pg_advisory_xact_lock()` returns `void`, which Prisma's `$queryRaw` cannot
  deserialize (P2010). Until the fix (`89a46ad`) the reservation threw on every real database,
  so every turn took the plain fallback check and concurrent-turn protection never
  existed in any environment. The unit test passed because its fake `$queryRaw`
  returned `[]`: a fake client cannot catch a driver-level deserialization failure.
  The guard is therefore a real-Postgres suite, `npm run rls:accept:allowance`
  (`scripts/ai-allowance-acceptance.ts`), a required step in CI's architecture job
  (`scripts/lib/ci-contract.ts`). It covers single reservation and release, N
  concurrent turns for one customer (bounded admissions), no cross-customer blocking,
  exhaustion, the override path, the enforcement and pause flags, and revoked lock or
  counter privileges (rolled back and refused).
- **Fail closed:** if the reservation cannot be taken while enforcement is on, the turn is refused
  `RESERVATION_UNAVAILABLE` (503, `Retry-After: 15`); if the ledger has been failing writes,
  `LEDGER_UNTRUSTED` (503). Both are retryable and nothing is spent.
- Allowance and pause refusals write no `AuditLog` row; they are observable by response code and
  (at the chokepoint) by the ledger's failure rows.

### Emergency pause (kill switch) — IMPLEMENTED

`PlatformSetting ai_paid_requests_paused` (`lib/platform/ai/paid-requests-admission.ts`), read
together with `maintenance_mode` in one query; **either** denies paid AI work.

| Row state | Verdict |
|---|---|
| absent | admitted (the switch ships absent) |
| `"false"` | admitted |
| `"true"` | paused |
| any other value | paused (only the typed setter writes the row) |
| read failed | paused (fail closed) |

- Judged in the Conversations and Daily Brief routes **before** the allowance, and at the
  provider chokepoint before `assertPricedModel` on every entry point, so harness and scripts are
  refused too. The turn loop asks per model call, so a pause lands mid-turn at the next hop.
- Response: 503 `{ error: <customer sentence>, code: "AI_PAUSED" }`, `Cache-Control: no-store`.
- **No exemption:** no overlay, per-customer override or System Admin lifts it.
- Not cached: every decision reads the row.

### Spend alerts — IMPLEMENTED

Both read the `AiInvocation` RETURNED customer-surface rows over a trailing 24 hours, priced by
the rate card (`lib/platform/ai/spend-health.ts`).

| Rule | Fires | Threshold setting (default) |
|---|---|---|
| `ai-spend-fleet-high` | fleet customer spend ≥ threshold (warning), ≥ 2× (critical); **also** a warning whenever any invocation in the window was on an unpriceable model | `ai_spend_alert_fleet_usd_24h` ($10) |
| `ai-spend-user-high` | one customer ≥ threshold (warning), ≥ 2× (critical); names the customer by opaque reference only | `ai_spend_alert_user_usd_24h` ($3) |

Each rule has its own engine enable key (`alert_rule_enabled:<rule id>`); disabling changes
evaluation only, never the ledger or the Economics figures. Dedupe keys keep the
`<rule>:<fleet|user|unpriced>:<day>` family with the 20-hour suppress-while-open window. An
unreadable threshold row falls back to the default and reports `INVALID_SETTING`.

### Operator controls and authority — IMPLEMENTED

All seven controls live under **Platform Operations → Policies → AI Cost Controls**
(`lib/platform/ai/cost-controls.types.ts`, `AI_COST_CONTROL_DEFAULTS`). They are
`OPERATOR_CONFIGURABLE` `PlatformSetting` rows; reset deletes the row and the default applies.

| Control | Setting key | Default |
|---|---|---|
| Allowance enforcement | `ai_daily_allowance_enforced` | on |
| Platform allowance (USD/UTC day, integer 1…ceiling) | `ai_daily_allowance_usd` | 5 |
| Per-customer alert enabled / threshold | `alert_rule_enabled:ai-spend-user-high` / `ai_spend_alert_user_usd_24h` | on / 3 |
| Fleet alert enabled / threshold | `alert_rule_enabled:ai-spend-fleet-high` / `ai_spend_alert_fleet_usd_24h` | on / 10 |
| Pause paid AI requests | `ai_paid_requests_paused` | off (absent) |

- **Authority:** reads `requirePlatformAccess("PLATFORM_OPS", "READ")`; changes
  `requireFreshPlatformAccess("PLATFORM_OPS", "CONTROL")` plus the `platform-policy` pacing window
  (`app/api/platform/platform-ops/ai-cost-controls/route.ts`). The per-customer override rides
  the Customer Success WRITE fresh-access route. The server re-validates every rule; the UI's
  `canControl` only decides whether an affordance renders.
- **Confirmation** is required in the UI for disabling enforcement and for any pause/resume.
- **Audit:** every change writes one `PLATFORM_POLICY_CHANGED` / `PLATFORM_POLICY_RESET` row per
  control through `recordOperatorAction`, in the same transaction as the setting write (actor,
  target key, required reason, before/after value + origin). No secret, prompt, email or
  free-form dollar figure enters a row.
- **Propagation:** nothing is cached; a change is in force for the very next decision.
- **Economics → AI Budget** (`ops_ai_budget` section, `lib/platform/ai/ai-budget.ts`): fleet
  rolling-24 h estimate vs the fleet threshold, pause/enforcement state, per-customer rows
  (opaque refs) vs effective allowance, spend by surface (customer vs overhead), an unpriced-usage
  warning (never $0), recent alert deliveries. A new Platform section needs
  `platform:seed-spaces` on every environment.

## Plaid cost

### Billing model (Plaid public documentation, `plaid.com/docs/account/billing`, fetched 2026-10-15)

- Transactions and Investments are **subscription products billed per Item per calendar month
  (UTC)**. Mid-month creation or removal is **not pro-rated**.
- A subscription is charged even when no call is made, or when calls fail because the Item is in
  an error state. Billing continues while a valid `access_token` exists and ends on `/item/remove`
  (or end-user revocation).
- Investments consent alone adds no subscription (Plaid update-mode docs: billing starts "only
  when those endpoints are called"). The first `/investments/holdings/get` adds Holdings; the first
  `/investments/transactions/get` adds Investments Transactions (+ Holdings). The same
  subscription is not added twice to one Item. (Consistent with October 2026: every fresh link
  requests Investments as an additional consented product, yet far fewer Items were billed for
  Holdings than for Transactions.)
- `/transactions/refresh`, `/investments/refresh`, `/accounts/balance/get` and the one-time
  products (Auth, Identity, Income, Assets, Statements…) are separately billed. **Fourth Meridian
  calls none of them.**
- Plaid publishes **no per-unit list price** ("contact for pricing"). The configured
  `PLAID_RATES` are derived from the account's own invoice (each entry's `source` says so). They are
  configured application pricing, not a provider list price, and this document does not restate
  account-specific amounts.

**The billable unit is the Item-subscription-month, not the call.** One Item with N accounts is
one billable Item. `PLAID/<method>/calls` counters are health and rate-limit telemetry only and
are structurally excluded from pricing (`modelFromMetric` never parses a Plaid metric).

### Code paths that trigger billable events — IMPLEMENTED

| Call | Where | Billing effect |
|---|---|---|
| `/link/token/create` | `app/api/plaid/link-token/route.ts` — fresh link `products: [Transactions]`, `additional_consented_products: [Investments]` (non-gating) | none itself; a completed link creates an Item |
| `/item/public_token/exchange` | `lib/plaid/exchangeToken.ts` | **creates a billable Item** (Transactions subscription) |
| `/transactions/sync` | `lib/plaid/syncTransactions.ts` | inside the Transactions subscription |
| `/accounts/get` | `lib/plaid/refresh.ts`, `lib/plaid/exchangeToken.ts`, `lib/plaid/backgroundHistorySync.ts` | not separately billed |
| `/investments/holdings/get` | `lib/plaid/sync-investments.ts` (consent-gated; link and manual refresh) | adds Investments Holdings to the Item |
| `/investments/transactions/get` | `lib/investments/investment-event-ingest.ts` (behind `INVESTMENT_EVENTS_ENABLED`) | adds Investments Transactions (+ Holdings) |
| `/item/remove` | `lib/plaid/disconnect.ts`, `lib/plaid/exchangeToken.ts` (duplicate rollback), `lib/account-deletion/purge.ts`, `jobs/plaid-removal-retry.ts` | **ends billing** when Plaid confirms |
| Admin "Expand History" | `app/api/admin/plaid/expand-history-token/route.ts` | a fresh link ⇒ **a new Item**; the old one bills until retired |

Webhooks never create Items; non-ACTIVE Items' webhooks are refused (`lib/plaid/webhook-receiver.ts`).

### The Item-month census — IMPLEMENTED (`lib/platform/plaid/item-months.ts`)

A pure derivation, no collector and no stored count: an Item is born at `PlaidItem.createdAt` and
retired at its first recorded `PLAID_ITEM_STATUS_CHANGED → REVOKED` audit transition
(`lib/connections/health-transitions.ts`; removal keeps the row).

- `NEEDS_REAUTH` and `ERROR` Items count as billable (matches Plaid's rule).
- Investments is priced **only when `investmentsConsent === "ENABLED"`** (owner decision C2), and
  only evidenced for the cycle that includes today (consent has no timestamp).
- **Sandbox Items are free:** `PlaidItem.plaidEnvironment` (stamped at exchange from `PLAID_ENV`,
  create-only; decision C1) buckets Items as sandbox / development / production / unknown; only
  the literal `sandbox` is excluded.
- Seeded demo fixtures are excluded. No proration.
- **Both cycle readings** are computed (present-during-cycle and present-at-cycle-end) with an
  `agree` flag, because the invoice evidence cannot yet separate them.
- Cycles before the evidenced rate are **unpriced, not zero**; the census is a lower bound
  (pre-ledger Items and Items with lost tokens are invisible).

### Plaid growth controls — IMPLEMENTED

| Control | Where |
|---|---|
| Duplicate gate: **any non-REVOKED** Item of the same institution blocks a fresh link (re-link instead of re-mint); decision C4 | `lib/plaid/exchangeToken.ts` (`duplicateGateWhere`) |
| Daily retry of removals Plaid did not confirm (`PLAID_ITEM_REVOCATION_UNCONFIRMED`) | `jobs/plaid-removal-retry.ts`, `lib/jobs/registry.core.ts` |
| Connection-count entitlement `maxConnections` (beta 10, ceiling 25; gates creation only) | `lib/entitlements/catalogue.ts`, `lib/connections/connection-cap.ts` |
| Billable-operation gate (policy state: no owner, stale catalogue, lifecycle restrictions such as a cost freeze, beta paused/ended ⇒ refuse metered work; reads of own data stay available) | `lib/entitlements/billable-gate-core.ts` |
| Rate limits: link token and exchange 10 per 15 min per user; manual bank refresh cooldown entitlement | `app/api/plaid/link-token/route.ts`, `app/api/plaid/exchange-token/route.ts`, `lib/entitlements/catalogue.ts` |

## Provider-data boundaries

- **No billing API** from either provider: every figure is usage × configured rate.
- OpenAI returns `cached_tokens` and `reasoning_tokens` in the usage object; both are captured.
  A completion returned **without** a `usage` object writes no row.
- The recorded model is the **requested alias**, not the snapshot the provider served
  (`completion.model` is not stored).
- One Plaid client id per Plaid environment; the Plaid environment is global per deployment, so
  per-Item `plaidEnvironment` is the only way to separate sandbox from billable Items.
- Plaid's `billed_products` / `consented_products` from `/accounts/get` are read
  (`lib/plaid/investmentsConsent.ts`) but not persisted.
- OpenAI usage across environments: each environment has its own database, so no in-app surface
  can total the provider bill. Separate OpenAI projects per environment make the provider's own
  usage view the cross-environment total ([runbook](../operations/openai-environment-separation.md)).
  OpenAI project budgets are a backstop (soft-edged monthly stops), not the enforcement; the
  application allowance and kill switch are.

## Known gaps

| Gap | Status |
|---|---|
| No reconciliation against a real invoice (`ProviderInvoice` record + monthly reconciliation; OpenAI Costs API pull) | PROPOSED (decision C5 not taken) |
| Rate card is one dated reading; no staleness check or price-change alert | PROPOSED |
| `ApiUsageCounter` and `AiInvocation` are written independently; no job compares them | PROPOSED |
| Counter-based figures (the API-usage and AI-trend widgets) cannot exclude harness traffic; the spend alerts, allowance and AI Budget read `AiInvocation` by surface and do | IMPLEMENTED for safeguards; counter widgets unchanged |
| `lib/platform/cost/cost.ts` `spend-usd` metric is hard-coded `null` (`tier: "unknown"`); no cost-per-active-user composer | open |
| A second cost arithmetic in the Brief generator (`costOf`, `lib/ai/brief/generate.ts`) prices at today's rate into the ephemeral `meta.costUsd` only | open (low) |
| Allowance reserve is not sized from the transcript (reserved before the body is read; worst-case shape assumed) | DECIDED (documented, SEC-AI-002) |
| A pause landing between the Brief route's check and generation surfaces as a Brief provider error | open (low) |
| No inactivity disconnect policy for Plaid Items: Items of inactive users keep billing | PROPOSED (decision C8) |
| Per-Space and per-conversation cost readers (data exists on `AiInvocation`; no route) | PROPOSED |

## Why it is built this way

- **Versioned code rates instead of a pricing table:** a stored dollar column freezes a price into
  a fact and makes a rate correction unrepresentable; a table plus admin UI would add a mutable
  money authority with no evidence it is needed.
- **A new `AiInvocation` table instead of extending `ApiUsageCounter` or `ProviderCall`:** the
  counter's value is its race-safe day grain; `ProviderCall` belongs to a refresh execution and is
  attribution, not billing; `AuditLog` is the security feed. The counter stays as the cheap trend
  and an independent cross-check.
- **No `Conversation` model:** `correlationId` is an opaque string, so per-conversation cost needs
  no conversation storage.
- **Plaid as a derivation:** `createdAt` plus the append-only status ledger already hold every
  fact a census needs, and a derivation can compute both cycle readings where a stored monthly
  count would have to pick one.
- **Fail closed everywhere money is unknown:** an unpriced model, an unreadable pause row, an
  untaken reservation or an untrusted ledger all refuse rather than admit, because an unknown
  spend is never "under the allowance".
