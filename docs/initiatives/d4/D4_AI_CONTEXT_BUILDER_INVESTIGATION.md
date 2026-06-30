# D4 — AI Context Builder Investigation

**Status: Investigation only. No schema, migration, API, or application code was modified to produce this document.**

## 0. Document control

| | |
|---|---|
| Branch | `feature/phase-2-architecture` |
| Baseline tag | `v2.3.0` |
| Governing docs | `docs/architecture/PHASE_2_ARCHITECTURE_FREEZE.md` (§12), `docs/architecture/PHASE_2_DECISION_MATRIX.md` (D4), `docs/architecture/DATABASE_ARCHITECTURE_REVIEW.md` (§2.F) |
| Confirmed sources | `prisma/schema.prisma` (full read), `lib/data/advice.ts`, `lib/data/accounts.ts`, `lib/data/transactions.ts`, `lib/data/snapshots.ts`, `lib/space.ts`, `lib/account-classifier.ts`, `lib/account-privacy.ts`, `lib/audit-actions.ts`, `lib/brief-types.ts`, `lib/snapshots/regenerate.ts`, `lib/summary-status.ts`, `lib/timeline-types.ts`, `lib/perspectives.ts`, `lib/plaid/encryption.ts`, `app/api/brief/route.ts` |
| Confirmed absent | `lib/ai/` directory, `lib/ai-advice.ts`, `jobs/run-ai-advice.ts` — none exist, not even as stubs. The entire AI generation path is greenfield. |

This document addresses all 15 investigation questions in the brief. It does not implement anything. It does not propose schema changes. The one schema-adjacent item — the `agentScope` field shape on `AiAgent` — was already approved in D4 (Decision Matrix §D4) as an enum array; this document recommends where it belongs in the architecture, not whether to add it.

---

## 1. What "Context" means in Fourth Meridian

Context is not a database query and it is not a prompt template. It is the **permission-filtered, scope-bounded, summarized representation of a Space's financial state** that any AI capability may consume without touching the database directly.

Three properties define it:

- **Permission-filtered.** Every datum in Context was authorized for the requesting user + Space combination before assembly. Nothing reaches Context that the current user is not permitted to see — not by convention, but by structural enforcement.
- **Scope-bounded.** Context is Space-scoped, not user-scoped. A user with three Spaces gets a different Context for each one. Cross-Space inference is never possible from a single Context object.
- **Summarized by default, raw by explicit request.** Context carries spending summaries and allocation breakdowns, not raw transaction arrays. Raw rows are available as a named, bounded opt-in section for consumers that genuinely need them — not the default.

The practical consequence: `lib/ai/context-builder.ts` is a **data gateway**, not a query helper. It exists to make "AI never queries the DB directly" enforceable rather than merely aspirational.

---

## 2. Root context object shape

The root Context object is the contract between the builder and every consumer. Its shape must be stable — consumers depend on it and must not need to rewrite if the builder's internals change.

```ts
// lib/ai/context-builder.ts — public output type

export interface SpaceContext_AI {
  // ── Identity ───────────────────────────────────────────────────────────
  requestedAt:  string;           // ISO timestamp of this assembly
  spaceId:      string;
  userId:       string;           // the requesting user, already permission-checked
  role:         SpaceMemberRole;  // their role in this Space
  agentId:      string;           // AiAgent.id for this Space
  agentScope:   AgentScope[];     // approved data categories for this agent

  // ── Space ──────────────────────────────────────────────────────────────
  space:        SpaceContext_Space;

  // ── Domains (assembled on demand per agentScope) ───────────────────────
  accounts?:    SpaceContext_Accounts;
  goals?:       SpaceContext_Goals;
  members?:     SpaceContext_Members;
  snapshot?:    SpaceContext_Snapshot;
  transactions? SpaceContext_Transactions;
  holdings?:    SpaceContext_Holdings;
  providers?:   SpaceContext_Providers;
  health?:      SpaceContext_PlatformHealth;

  // ── Audit receipt ──────────────────────────────────────────────────────
  // Written to AuditLog after assembly, not returned to consumers.
  // Included here so callers can confirm it was recorded.
  auditLogId:   string;
}
```

Key design decisions baked into this shape:

- Every domain section is **optional** — a consumer that doesn't need `holdings` doesn't pay to assemble it, and an agent without `holdings` in its `agentScope` never receives that section.
- The root always carries `spaceId`, `userId`, `role`, and `agentScope` — these cannot be stripped away or optional, because every domain assembly decision depends on them.
- `auditLogId` is required and non-optional on the returned object, making audit confirmation observable without requiring callers to trust a side effect.

---

## 3. Which domains belong in Context

The freeze doc's §12 establishes: AI may read "only accounts the requesting user owns directly, or accounts actively linked into the Space the request is scoped to via SpaceAccountLink." This is the authorization boundary. Every domain below is evaluated against it.

### Approved domains

**Space metadata** — name, type (`PERSONAL`/`SHARED`), category (`HOUSEHOLD`, `BUSINESS`, etc.), member count, creation date. Excluded: `isPublic`, `archivedAt`, `deletedAt` — these are operational facts, not financial context.

**Accounts** — account name, type, institution, balance, currency, `lastUpdated`, `syncStatus`. Classified into `liquid`, `investments`, `digitalAssets`, `realAssets`, `liabilities` using `classifyAccounts()` (already in `lib/account-classifier.ts`). Pre-computed totals included. Excluded: `plaidAccountId`, `walletAddress`, `walletChain` (provider-identity data, not financial context), `displayName` unless it's the effective display name (resolution order: `displayName ?? officialName ?? plaidName ?? name` — one clean string, not all four raw fields).

**Transactions** — summarized spending by category over configurable windows (30-day, 90-day). Not raw rows by default. See §11 for the raw/summary decision.

**Holdings** — allocation by asset class (equity, fixed income, crypto, cash-equivalent). Total portfolio value, diversification count. Not individual position details by default.

**Goals** — name, category, status (`ACTIVE`/`COMPLETED`/`ARCHIVED`), progress percentage, target amount (if `FINANCIAL`), target date, contribution account count. Habit streak and check-in details included. Enough to describe what the Space is working toward without exposing underlying account-level detail beyond what's already in the Accounts domain.

**Members** — member count, roles (counts only — not names or emails). For Personal Spaces: `{ count: 1, roles: { OWNER: 1 } }`. Context never exposes one member's identity to the AI in a way that could be surfaced to another member. If the AI generates member-referenced text, it must use the same permission model the UI applies.

**Providers and connections** — provider type (PLAID, WALLET, EXCHANGE, MANUAL), connection status (ACTIVE/ERROR/NEEDS_REAUTH), institution name, last synced date. Count of accounts per provider. Excluded: `credential`, `encryptedToken`, `cursor`, `externalConnectionId` — none of these are financial context.

**Snapshots** — the 90-day `SpaceSnapshot` time series (already pre-aggregated at `lib/snapshots/regenerate.ts`). Net worth trend, asset/liability breakdown over time. This is the cheapest AI-facing data in the system — it's already a derived aggregate with no raw financial detail. Snapshots are the preferred source for any time-series question.

**Platform health** — connection error counts, stale-sync flags (accounts not updated in >7 days), accounts needing reauth. Relevant for recommendations ("your Chase connection needs attention") without exposing credential state.

**Daily Brief inputs** — `lastBriefViewedAt` (on `User`), the current `VisitState` derived from it, pending invite count. The `BriefPayload` shape already exists in `lib/brief-types.ts`. The Brief's current `buildInsight()` function consults `db.aiAdvice` rows if they exist, and falls back to rule-based text. Context Builder is the mechanism by which those `AiAdvice` rows eventually get generated.

### Deferred domains — not in Context now

**Audit history** — raw `AuditLog` rows are explicitly excluded per the freeze doc's §12: "`AuditLog`... must never be read by the Context Builder." Context does write an audit row but does not read prior ones. If a consumer needs audit context (e.g. "what changed recently"), the Timeline API (`/api/spaces/[id]/activity`) already exists for that; the AI should not bypass it.

**Duplicate candidates** — `DuplicateAccountCandidate` is an audit ledger for automatic merges (D1 decision). Not financial context; not relevant to any current AI capability.

**Credit scores** — `CreditScore` table exists. Relevant to Debt Reduction goals but scoped to User, not Space. Deferred until a specific AI feature needs it; include when a `DEBT_PAYOFF` Space's Context is being built and there's a concrete consumer.

**PublishedAccountView** — a future projection layer. When it exists, Context for a "public Space" scenario will need to use the published view rather than the raw canonical data. Architecture must accommodate this but it is not needed before the first AI feature.

---

## 4. What should NOT be in Context

The freeze doc §12 establishes a categorical exclusion list. This section restates it with the implementation rationale for each exclusion.

**`Connection.credential` / `PlaidItem.encryptedToken`** — provider OAuth tokens, API keys, OAuth access tokens, and any wallet private key. Credential decryption belongs exclusively to provider adapters and sync execution, not to AI Context. The Context Builder never selects these fields, never imports `lib/plaid/encryption`, and never calls any decrypt function. The Providers assembler reads only plaintext fields from `Connection` — `status`, `provider`, `lastSyncedAt`, `errorCode`, `institutionId` — which are sufficient to convey connection health without touching anything encrypted.

**`User.totpSecret`** — TOTP seed. Same reasoning as above. The builder assembles Space-scoped data; TOTP is a user-level security secret entirely outside the financial domain.

**`User.dateOfBirthEncrypted`** — DOB is PII with no financial calculation use. Not included.

**`User.passwordHash` / `User.passwordResetToken`** — authentication secrets. Categorically excluded.

**Raw `AuditLog` rows** — stated explicitly in freeze doc §12. The audit layer is for compliance, not AI input.

**Cross-Space data** — a context assembly for Space A must never include data from Space B, even if the requesting user is an owner of both. This follows directly from "scope is owned-or-linked accounts only" in §12. The builder enforces this by assembling all queries with `spaceId` as a mandatory filter, never joining or subquerying across Spaces.

**ImportBatch internals** — `ImportBatch`, `ImportMappingProfile` are operational pipeline state. An AI does not need to know how data arrived, only what the current state is.

**`AccountConnection.plaidItemDbId` / `AccountConnection.connectionId`** — internal FK implementation details. The Providers domain section exposes connection status in consumer terms, not FK references.

**`DuplicateAccountCandidate`** — audit ledger for completed merges, not financial context.

---

## 5. How Context should be layered

```
Raw Database (Prisma)
      │
      ▼
Canonical Models (FinancialAccount, Transaction, Holding, SpaceGoal, Connection …)
      │
      │   lib/data/* — existing per-domain query functions
      │   lib/account-classifier.ts — existing classification
      │   lib/snapshots/regenerate.ts — existing aggregate
      ▼
Domain Assemblers (one per domain, each permission-scoped)
lib/ai/assemblers/accounts.ts
lib/ai/assemblers/transactions.ts
lib/ai/assemblers/holdings.ts
lib/ai/assemblers/goals.ts
lib/ai/assemblers/members.ts
lib/ai/assemblers/snapshot.ts
lib/ai/assemblers/providers.ts
lib/ai/assemblers/health.ts
      │
      │   Each assembler receives a pre-validated SpaceContext
      │   (from lib/space.ts getSpaceContext) and an agentScope.
      │   They return typed domain sections or null if the domain
      │   is excluded by scope.
      ▼
Context Builder (lib/ai/context-builder.ts)
      │
      │   - Resolves SpaceContext (via getSpaceContext)
      │   - Resolves AiAgent + agentScope for this Space
      │   - Invokes only the assemblers whose domains are in agentScope
      │   - Enforces: no provider secrets, no cross-Space leakage
      │   - Writes AuditLog row (IDs + scope, never raw values)
      │   - Returns SpaceContext_AI
      │
      ▼
AI Consumers (lib/ai/consumers/*)
lib/ai/consumers/advice-generator.ts   (future — generates AiAdvice rows)
lib/ai/consumers/brief-enhancer.ts     (future — enhances BriefPayload)
lib/ai/consumers/chat-responder.ts     (future — handles conversational AI)
lib/ai/consumers/opportunity-detector.ts (future)
      │
      ▼
AiAdvice rows / BriefPayload / Chat responses
```

The critical rule: **Domain Assemblers and Context Builder are the only modules that query the database for AI purposes.** Consumers receive only the assembled `SpaceContext_AI` object. Nothing upstream of the Context Builder is visible to consumers.

---

## 6. Builder architecture: one large builder, domain builders, plugin registry, or other

**Recommended: Multiple domain assemblers + single gated builder.**

### Why not one large builder

A single `buildContext()` function that queries all domains in sequence becomes unmanageable as the domain count grows. More critically, it cannot selectively skip domains — every invocation would pay the full query cost regardless of which consumer needs which data. The current codebase already has patterns that would make a monolithic builder inconsistent: `classifyAccounts()` in `lib/account-classifier.ts`, `getAccounts()` in `lib/data/accounts.ts`, `getLatestAdvice()` in `lib/data/advice.ts` — these are separate for good reasons.

### Why not a plugin registry

A registry (dynamic registration of assemblers at runtime) adds infrastructure complexity with no near-term benefit. Fourth Meridian has eight to ten domain assemblers, all known at compile time. Registries are warranted when the domain list is open-ended or externally extensible — neither is true here. A registry also makes the permission boundary harder to audit: "which assemblers are registered right now" becomes a runtime question rather than a static one.

### Why multiple domain assemblers + single gate

Each assembler is a **pure function** (or close to it): it takes a validated `SpaceContext` + options, runs its queries, and returns a typed section or null. The gated builder in `lib/ai/context-builder.ts` is the single entry point responsible for:

1. Validating the requesting user's Space membership (via `getSpaceContext`).
2. Resolving `AiAgent` and `agentScope`.
3. Deciding which assemblers to invoke based on `agentScope`.
4. Combining their outputs into `SpaceContext_AI`.
5. Writing the AuditLog row.
6. Enforcing the lint rule + runtime guard.

This separates concerns cleanly. The builder is simple enough to audit in one read. Each assembler is independently testable without needing a Space context or an LLM client.

---

## 7. How Context enforces permissions

Permission enforcement happens in three layers, each a genuine safeguard rather than a convention:

### Layer 1: SpaceContext validation (entry gate)

`lib/ai/context-builder.ts` calls `getSpaceContext()` as its first action. This function (in `lib/space.ts`) validates that the requesting user has an active `SpaceMember` row for the requested Space and derives their role and permissions. The freeze doc §12 confirms: "no bypass — consistent with `lib/space.ts`'s existing no-bypass guarantee for SYSTEM_ADMIN." If `getSpaceContext()` throws, the builder throws. No partial context is assembled.

### Layer 2: Query-level scoping (assembler gate)

Every assembler receives `spaceId` from the validated SpaceContext and uses it as a mandatory `WHERE` clause filter. No assembler accepts an arbitrary `spaceId` from a caller — it receives the already-validated one. The `SpaceAccountLink` query pattern already enforces this for accounts: only `ACTIVE` links for the validated `spaceId` are included.

For visibility-tier accounts (accounts shared at `BALANCE_ONLY`), the assembler respects the `visibilityLevel` on `SpaceAccountLink` exactly as `lib/account-privacy.ts` does today for the non-AI path. The AI does not get a full-detail view of a BALANCE_ONLY account; it gets the same sanitized shape a Space member sees in the UI.

### Layer 3: Import boundary (credential gate)

The Context Builder must never import `lib/plaid/encryption` or call any decrypt function. The Providers assembler reads only plaintext columns from `Connection` and `PlaidItem` — `status`, `provider`, `lastSyncedAt`, `errorCode`, `institutionId`, `institutionName` — all of which are unencrypted by design. There is no credential that AI Context legitimately needs, so there is no authorized decrypt path to design; the boundary is categorical exclusion.

The D4 decision's "lint rule and runtime guard" commitment applies here, but the direction is different from what an earlier draft implied. The lint rule blocks `lib/ai/context-builder.ts` and `lib/ai/assemblers/*` from importing `lib/plaid/encryption` at all — not merely from calling it outside a narrow window. The runtime guard on `decryptWithPurpose` catches any call from any path, including a future refactor that might inadvertently reach it from an assembler. Both rules protect credentials from the Context Builder, not on behalf of it.

Implementation note for the implementation branch: the lint rule should be stated as "no file under `lib/ai/` may import `lib/plaid/encryption`" — a simpler, more auditable rule than the prior "only context-builder may call decrypt."

### What this does NOT do

It does not prevent a developer from writing a rogue route that queries `db.aiAdvice` directly to read AI-generated text. That is not the threat model — `AiAdvice` rows are output, not input secrets. The permission model protects the **input pipeline** (what data reaches the LLM), not the output read path.

---

## 8. Supporting all Space types without changing the public interface

The `SpaceContext_AI` interface is stable regardless of Space type. Domain assemblers use `space.type` and `space.category` (available in the root `SpaceContext`) to adjust their behavior without the builder or consumers needing to branch.

**Personal Space (`type: PERSONAL`):** Standard assembly. Members domain returns `{ count: 1 }`. No shared-account privacy tier applies (owner sees everything).

**Shared Space (`type: SHARED`):** Standard assembly. Members domain returns role counts. The Accounts assembler applies `account-privacy.ts` visibility tiers — `BALANCE_ONLY` accounts are sanitized before entering Context, exactly as they are in the current non-AI read path.

**Future Organization Spaces:** No change to the builder interface. If organization Spaces introduce new roles (e.g. `FINANCE_VIEWER`), those roles flow through `getSpaceContext()` which is the already-established permission boundary. The builder inherits whatever role the user has.

**Internal Spaces (if D12 is eventually approved):** `getSpaceContext()` already restricts Space access by membership. An internal Space would require `SYSTEM_ADMIN` to be a member — that gate lives in the API layer, not the Context Builder. The builder receives a validated SpaceContext and does not need to know the Space is "internal."

**PublishedAccountView:** When this exists, a "public" AI context (e.g. for a Creator Space's publicly-visible AI summary) would use a separate assembler variant that reads from `PublishedAccountView` rather than raw `FinancialAccount`. This can be a distinct function (`buildPublicContext()`) that shares assembler logic but replaces the accounts assembler. The public interface shape is identical — consumers don't know whether the underlying accounts came from the published view or canonical data.

**SpaceTemplate:** Templates describe a Space's configuration (section presets, default goals, suggested providers), not financial data. Context Builder does not assemble template data. If an AI capability ever needs to know "what template this Space was created from," that belongs in the Space metadata section, not a separate domain.

---

## 9. Where agentScope fits

`AiAgent.agentScope` is an **allow-list filter**, not an enforcement mechanism.

The freeze doc §12 says `agentScope` is "declarative metadata that's queryable, not a second access-control system." The D4 decision recommends an enum array shape (e.g. `['OWN_ACCOUNTS', 'LINKED_SPACE_ACCOUNTS', 'GOALS', 'TRANSACTIONS_SUMMARY']`). This investigation confirms that framing and proposes a concrete placement:

```
agentScope sits between the builder and the assemblers.
```

Specifically: after `getSpaceContext()` validates the user, and after the AiAgent row is resolved, the builder consults `AiAgent.agentScope` to determine which assemblers to invoke. If `agentScope` does not include `HOLDINGS`, the holdings assembler is never called and the `holdings` section is absent from the returned Context.

**agentScope does NOT replace permission enforcement.** An assembler is never invoked with a broader scope than `agentScope` permits — but `agentScope` itself cannot grant access the user's SpaceContext does not permit. The hierarchy is: SpaceContext permissions ⊇ agentScope ⊇ consumer-requested sections.

**Proposed enum values** (to be confirmed in the implementation branch):

```ts
export enum AgentScope {
  OWN_ACCOUNTS        = 'OWN_ACCOUNTS',         // accounts the user directly owns
  LINKED_ACCOUNTS     = 'LINKED_ACCOUNTS',       // accounts linked into the Space by other members
  ACCOUNTS_SUMMARY    = 'ACCOUNTS_SUMMARY',      // totals only, no individual account detail
  TRANSACTIONS_SUMMARY= 'TRANSACTIONS_SUMMARY',  // spending summaries, no raw rows
  TRANSACTIONS_RAW    = 'TRANSACTIONS_RAW',       // raw transaction window (bounded)
  HOLDINGS_SUMMARY    = 'HOLDINGS_SUMMARY',      // allocation summary
  HOLDINGS_RAW        = 'HOLDINGS_RAW',           // individual positions
  GOALS               = 'GOALS',
  MEMBERS             = 'MEMBERS',               // role counts only
  SNAPSHOT_HISTORY    = 'SNAPSHOT_HISTORY',      // SpaceSnapshot time series
  PROVIDERS           = 'PROVIDERS',             // connection status, no credentials
  PLATFORM_HEALTH     = 'PLATFORM_HEALTH',       // stale sync flags, error counts
}
```

The Personal Space's default AiAgent gets a broad scope (`OWN_ACCOUNTS`, `TRANSACTIONS_SUMMARY`, `HOLDINGS_SUMMARY`, `GOALS`, `SNAPSHOT_HISTORY`). A future Shared Space agent with less trust might get `ACCOUNTS_SUMMARY` and `GOALS` only. A future autonomous agent might add `TRANSACTIONS_RAW` with an explicit `TRANSACTIONS_RAW_WINDOW_DAYS` limit.

---

## 10. Supporting multiple future consumers without each rebuilding its own queries

The current codebase already illustrates the problem this solves: `app/api/brief/route.ts` (335 lines) contains its own direct Prisma queries for accounts, snapshots, advice, and pending invites — all assembled inline in a route handler. If a Chat endpoint needed the same data, it would likely duplicate those queries. If a Recommendations engine needed similar data, a third copy.

The Context Builder collapses this. Each consumer:

1. Calls `buildContext(spaceId, userId, requestedScopes)` — one call.
2. Receives a `SpaceContext_AI` with only the sections it needs, already permission-checked.
3. Passes the Context to its LLM call (or its rule-based engine) as the factual input.

**Daily Brief** is the immediate first consumer. Today's `app/api/brief/route.ts` already has a commented path: `if (advice?.summary) { ... }` — it consults `db.aiAdvice` for an AI-generated insight and falls back to rule-based text. The Context Builder is what eventually produces those `AiAdvice` rows. The Brief route does not need to change its interface when AI advice starts being generated; it just starts finding non-null rows.

**Chat** — a future conversational AI endpoint needs accounts, transactions summary, and goals. It requests exactly those scopes. It does not need Holdings or Members. It builds a system prompt from the Context sections it received. The LLM call is isolated in `lib/ai/consumers/chat-responder.ts`; the Context Builder is separate.

**Recommendations / Opportunity Detection** — needs Accounts, Snapshot history, Goals, Platform health. Requests those scopes. The detection logic runs against the assembled Context, not the database.

**Autonomous Agents** — need the broadest scope, explicitly granted via `agentScope` on their `AiAgent` row. The same builder serves them; their wider scope simply causes more assemblers to run.

No consumer rebuilds queries. All consumers read from the same permission-checked, summarized `SpaceContext_AI`.

---

## 11. Summarized vs. passed through directly

This is a concrete decision with real query-cost and prompt-size implications.

### Transactions: summaries, not raw rows

**Do not pass raw transaction rows to AI.** Reasons:

1. A Space with 12 months of Plaid-synced transactions can have 500–2,000 rows. That is 50–200KB of JSON before any prompt framing. At current LLM context limits this crowds out everything else; at future limits it is still waste.
2. The information an AI needs to answer "how is this Space spending money?" is already captured by spending-by-category summaries with period-over-period deltas. Raw rows add merchant names and individual amounts without adding insight at the context-building layer — merchant-level analysis is a feature to implement on top of summaries, not a reason to pass all raw rows.
3. The `BANKING_CATEGORIES` already defined in `lib/data/transactions.ts` (12 categories) give a natural summary structure.

**Transaction summary shape:**

```ts
interface TransactionSummary {
  windowDays:       number;           // 30 or 90
  totalInflow:      number;           // positive transactions sum
  totalOutflow:     number;           // negative transactions sum (absolute value)
  netCashFlow:      number;           // inflow - outflow
  byCategory: {
    category:       string;
    total:          number;
    transactionCount: number;
    percentOfOutflow: number;
  }[];
  largestCategories: string[];        // top 3
  pendingCount:     number;
  periodLabel:      string;           // "Last 30 days"
}
```

**Raw transactions as opt-in.** If a consumer (e.g. a future "explain this specific charge" chat feature) needs raw rows, it requests `TRANSACTIONS_RAW` scope and receives a bounded window: last 90 days, max 200 rows, most recent first. This is an explicit, narrow exception — not the default.

### Holdings: allocation summaries, not positions

**Do not pass individual holding positions by default.** A brokerage account with 40 equity positions produces 40 rows, each with symbol, name, quantity, price, value, change24h. For AI purposes, "this Space has 60% equities, 15% bonds, 20% crypto, 5% cash, total portfolio value $180K" conveys the relevant financial picture without the position detail.

**Holdings summary shape:**

```ts
interface HoldingsSummary {
  totalPortfolioValue: number;
  allocationByClass: {
    assetClass:   string;           // "equity", "fixed_income", "crypto", "cash_equivalent", "other"
    value:        number;
    percentOfTotal: number;
    positionCount: number;
  }[];
  topSymbols:       string[];       // top 3 by value — symbols only, not quantities
  dataAsOf:         string;         // ISO timestamp of most recent holding update
}
```

**Individual positions as opt-in.** `HOLDINGS_RAW` scope returns position-level detail. Reserved for a future "explain my portfolio" feature that genuinely needs it.

### Accounts: full classified list by default

Unlike transactions and holdings, the account list is bounded — most Spaces have 3–15 accounts, occasionally 20–30. Passing the full classified account list (name, type, institution, balance, currency, lastUpdated) is appropriate by default. The `classifyAccounts()` output (already in `lib/account-classifier.ts`) is the natural shape: pre-bucketed totals plus the individual account list within each bucket.

Excluded from account detail even in full mode: `plaidAccountId`, `walletAddress`, provider-identity fields, raw `syncStatus` string (replaced by a computed `connectionHealth` enum: `HEALTHY` / `STALE` / `ERROR` / `NEEDS_REAUTH`).

### Goals: full list

Goals are sparse objects (name, category, status, progress, target). A Space rarely has more than 10–15. Pass the full list.

### Snapshots: bounded time series

The `SpaceSnapshot` table already pre-aggregates — no further summarization needed. Pass the last 90 days of daily snapshot rows (net worth, total assets, debt, cash breakdown). This is the cheapest AI-facing data in the system: pre-computed, no raw financial detail, bounded to ~90 rows.

---

## 12. Context size management

Three mechanisms keep Context from growing unboundedly:

### Bounded windows

Every time-series domain has a hard ceiling:
- Transactions: 90-day window, max 200 rows (raw) or summarized to 12-category breakdown (default).
- Snapshots: 90-day window, 90 rows maximum.
- Holdings: summarized by default; position list capped at 100 positions when raw scope is used.
- Audit events for Timeline: not included in AI Context (the Timeline API serves this purpose separately).

### Tiered assembly

Context has two assembly tiers:

**Tier A — always included (small, fast):** Space metadata, account classified totals, goal status, member counts, platform health flags, snapshot (last 30 days). This tier assembles in one database round-trip per domain.

**Tier B — on-demand (larger, explicit):** Transaction summaries, holdings details, snapshot history beyond 30 days. Consumers request Tier B sections explicitly via scope. The builder assembles them only when requested.

The daily Brief, for example, needs Tier A only. A deep financial chat session needs Tier A + transaction summary (Tier B). A portfolio review needs Tier A + holdings detail (Tier B).

### Serialization budget

The builder enforces a soft maximum on the serialized Context payload. If the assembled Context exceeds a configurable threshold (e.g. 32KB), the builder logs a warning and truncates the lowest-priority sections rather than failing. This prevents context-window overruns from causing silent failures at the LLM call site. The truncation policy is deterministic (Tier B before Tier A, longer windows before shorter).

---

## 13. Caching strategy

Context should be **partially cached, not rebuilt from scratch on every request and not fully snapshot-backed.**

### What to cache

**SpaceSnapshot data** is already pre-computed by `lib/snapshots/regenerate.ts`. The snapshot assembler reads from `SpaceSnapshot` rows — already a cache. No further caching needed for this domain; the data is already materialized.

**`getSpaceContext()` is already request-memoized** via React's `cache()` wrapper (confirmed in `lib/space.ts`). The permission check costs one database round-trip per request, not per assembler. This is the existing pattern and it is correct.

**`AiAdvice` rows are already the persistence layer.** When the Context Builder eventually drives `AiAdvice` generation, the output is stored and the Daily Brief reads from stored rows — it does not regenerate on every page load. The Brief already implements this correctly: it consults `db.aiAdvice.findFirst()` and falls back to rule-based text.

### What not to cache

**The assembled `SpaceContext_AI` object itself should not be cached at the application layer** (Redis, in-memory, etc.). Reasons:

1. The permission check must run on every request. A cached Context from a prior request could be served to a user whose role has since changed (member removed, visibility tier changed on a shared account). The query cost of `getSpaceContext()` is already minimized by the existing memoization.
2. Financial balances change on sync. A cached Context would show stale balances to an AI generating advice. The correct pattern is: sync updates the `SpaceSnapshot` (already wired), the Context assembler reads the fresh snapshot.
3. The assemblers are fast — they read from pre-indexed tables with `spaceId`-filtered queries. The overhead of assembling a fresh Context per request is comparable to the overhead of a complex dashboard data load, which the app already does on every page visit.

**Exception: transaction summaries.** Computing a 90-day category breakdown is a potentially expensive aggregate query. This is the one domain where a short-lived cache (e.g. 15-minute TTL, keyed by `spaceId + windowDays`) is worth considering. Implementation detail for the feature branch, not a requirement of the architecture.

---

## 14. Smallest implementation slices

D4's implementation parallels D2 (Connection model) and D3 (SpaceAccountLink): build the structural foundation first, prove it without an LLM call, then layer AI capabilities on top.

### Slice 1 — Foundation: types, builder shell, audit entry

**Deliverable:** `lib/ai/context-builder.ts` exports a `buildContext()` function that:
- Calls `getSpaceContext()` and resolves `AiAgent` + `agentScope`.
- Writes an `AuditLog` row with `action: AuditAction.AI_CONTEXT_ASSEMBLED` (new constant in `lib/audit-actions.ts`).
- Returns a `SpaceContext_AI` object with only the Space metadata and identity fields populated. No domain sections yet.

**Validation:** `npx prisma generate`, `npx tsc --noEmit`. No LLM call, no AI feature. Confirms the structural foundation compiles and the AuditLog write works.

**Schema change needed:** New `AuditAction` constant (`AI_CONTEXT_ASSEMBLED`, `AI_ADVICE_GENERATED` — two constants, added to `lib/audit-actions.ts`). No schema migration.

**agentScope field:** Add `agentScope` as a JSON-stored string array to `AiAgent`. This requires a schema migration. Nullable, defaults to `[]` (no scope). Validated as an array of `AgentScope` enum values by the builder at runtime. This is the only schema change D4 requires, and it is small and additive.

### Slice 2 — Accounts assembler

**Deliverable:** `lib/ai/assemblers/accounts.ts`. Wraps `getAccounts()` from `lib/data/accounts.ts` and `classifyAccounts()` from `lib/account-classifier.ts`. Returns `SpaceContext_Accounts`. The builder invokes this assembler when `agentScope` includes `OWN_ACCOUNTS` or `LINKED_ACCOUNTS`.

**Validation:** Unit test that `buildContext()` with `agentScope: ['OWN_ACCOUNTS']` returns a `SpaceContext_AI.accounts` section with correct totals for a seeded Space.

### Slice 3 — Snapshot and goals assemblers

**Deliverable:** `lib/ai/assemblers/snapshot.ts` (wraps `db.spaceSnapshot.findMany` for last 90 days) and `lib/ai/assemblers/goals.ts` (wraps `db.spaceGoal.findMany`). Builder wires these to the `SNAPSHOT_HISTORY` and `GOALS` scope values.

**Validation:** `buildContext()` returns correct snapshot time series and goal list for a seeded Space.

### Slice 4 — Transaction summary assembler

**Deliverable:** `lib/ai/assemblers/transactions.ts`. Implements the 30/90-day spending-by-category aggregation described in §11. Does not use raw rows by default.

**Validation:** Unit test against seeded transactions. Confirm the summary matches manual calculation.

### Slice 5 — Holdings and providers assemblers

**Deliverable:** `lib/ai/assemblers/holdings.ts` and `lib/ai/assemblers/providers.ts`. Holdings returns allocation summary; providers returns connection status per provider type (no credentials).

**Validation:** Unit tests against seeded data.

### Slice 6 — Lint rule + runtime guard

**Deliverable:** ESLint custom rule stating "no file under `lib/ai/` may import `lib/plaid/encryption`." Runtime guard on `decryptWithPurpose` that throws on any call regardless of caller — credential decryption has no authorized path from within AI Context.

**Validation:** A test file under `lib/ai/` that imports `lib/plaid/encryption` fails the lint check. A direct call to `decryptWithPurpose` in any context throws the runtime guard error.

### Slice 7 — First consumer: AiAdvice generation stub

**Deliverable:** `lib/ai/consumers/advice-generator.ts`. Calls `buildContext()`, formats the Context as a system prompt, calls an LLM client, writes an `AiAdvice` row. No job scheduler integration yet — invocable via a manual admin endpoint (`POST /admin/ai/generate-advice/:spaceId`).

**Validation:** Manual invocation against a seeded Space produces a valid `AiAdvice` row with non-null `summary` and `adviceText`. The Brief route's `buildInsight()` path starts returning AI-generated text for that Space.

### Slice 8 — Daily Brief integration

**Deliverable:** Wire the advice generation into the Brief pipeline. The Brief assembles its own data (as today) and calls `buildContext()` for the Insight section only, with scope `['OWN_ACCOUNTS', 'ACCOUNTS_SUMMARY', 'SNAPSHOT_HISTORY', 'GOALS']`. If a fresh `AiAdvice` row is recent enough (< 24h), it uses that; otherwise it invokes the advice generator inline (or defers to the next scheduled run).

**Validation:** Brief route returns AI-generated insight text for a Space with a recent `AiAdvice` row.

---

## 15. Risks — what would be hardest to undo

### Risk 1: Building consumers before the builder exists

If any future route handler or job queries the database directly for AI purposes before `lib/ai/context-builder.ts` exists — even temporarily, "just to ship the feature" — the "AI never queries the DB directly" rule becomes a guideline that was already violated once. Retrofitting it is the expensive path the freeze doc explicitly calls "nearly free to guarantee right now." **Mitigation:** The lint rule and runtime guard from Slice 6 must land before any consumer is written, even if the builder's domain sections are not yet complete.

### Risk 2: Caching the assembled Context object

If an engineer adds a Redis or in-memory cache for the full `SpaceContext_AI` object, the permission check stops running on every request. A member who was removed from a Space could continue receiving AI outputs generated from their prior access. This is a subtle security regression that would not cause obvious errors. **Mitigation:** Document clearly in `lib/ai/context-builder.ts` that the object must not be cached. The permission check is fast; there is no legitimate performance reason to cache it.

### Risk 3: Making agentScope the primary permission enforcement

If `agentScope` is treated as the permission boundary (rather than `SpaceContext` from `getSpaceContext()`), a misconfigured or overly-broad `agentScope` value on an `AiAgent` row would grant an AI access to data the user is not authorized to see. The architecture must enforce that `SpaceContext` permissions are the outer constraint and `agentScope` is a filter within that constraint. **Mitigation:** State this invariant explicitly in `context-builder.ts`'s module comment and in the assembler interface. Unit tests that verify assemblers respect the SpaceContext boundary regardless of `agentScope`.

### Risk 4: Passing raw transaction rows as the default

If the transaction assembler defaults to raw rows because "the LLM might want the detail," context size grows with every Plaid sync. A Space with 18 months of history would produce a Context that cannot fit in a standard LLM call. Early consumers would work on small seed data and fail silently on real Spaces. **Mitigation:** Summary-by-default is the architecture; raw rows are a named, bounded opt-in. This must be enforced at the assembler level, not left to consumers to manage.

### Risk 5: Assembling Context inside a Server Component or API route directly

If consumers call assemblers directly (bypassing the builder), the AuditLog write is skipped and the runtime guard is bypassed. The builder's centralization only holds if it is the sole public entry point. **Mitigation:** Assemblers should not be exported from `lib/ai/index.ts` or any public barrel. They are internal to `lib/ai/`. The only export from `lib/ai/` is `buildContext()` and the `SpaceContext_AI` type.

### Risk 6: No lint rule for cross-Space queries inside assemblers

An assembler that receives `spaceId` from the validated SpaceContext could, through a future refactor, accidentally join to data outside that Space. This is a latent risk in any multi-tenant system. **Mitigation:** Assemblers use only `getAccounts({ spaceId })`, `getTransactions({ spaceId })`, etc. — the existing, already-Space-scoped data functions. They must not construct raw `db.*` queries with joins that could cross Space boundaries. A code review policy for the `lib/ai/assemblers/` directory (analogous to the `server-only` import guard already on `lib/data/*.ts`) would enforce this.

---

## 16. Recommended module structure

```
lib/ai/
  index.ts                        // public barrel — exports buildContext() and SpaceContext_AI only
  context-builder.ts              // gated entry point: permission check, agentScope, audit write, assembly
  types.ts                        // SpaceContext_AI, AgentScope enum, all domain section types
  assemblers/
    accounts.ts
    transactions.ts
    holdings.ts
    goals.ts
    members.ts
    snapshot.ts
    providers.ts
    health.ts
  consumers/
    advice-generator.ts           // AiAdvice row writer (Slice 7)
    brief-enhancer.ts             // Daily Brief AI integration (Slice 8)
    // chat-responder.ts          // future
    // opportunity-detector.ts    // future
```

Assemblers are not exported from `lib/ai/index.ts`. Consumers are not exported from `lib/ai/index.ts`. Both are internal modules. The only public surface of `lib/ai/` is `buildContext()` and the types needed to call it and type-check its output.

---

## 17. Context ownership boundaries

| Layer | Owner | May read | May not read |
|---|---|---|---|
| Context Builder | `lib/ai/context-builder.ts` | Canonical models (plaintext fields only) | Provider credentials, decryption functions, `lib/plaid/encryption`, raw `AuditLog`, cross-Space data |
| Domain Assemblers | `lib/ai/assemblers/*` | Canonical models via `lib/data/*`, `lib/account-classifier.ts`, `lib/snapshots/regenerate.ts` | Provider credentials, decryption functions, raw `AuditLog`, cross-Space data |
| Consumers | `lib/ai/consumers/*` | `SpaceContext_AI` only | Database, assemblers, decryption functions, `lib/plaid/encryption` |
| Daily Brief route | `app/api/brief/route.ts` | `db.aiAdvice` (output rows), `SpaceContext_AI` via `buildContext()` | Assemblers directly |
| All other routes | `app/api/**` | Their normal data sources | `lib/ai/assemblers/*` directly |

---

## 18. Validation plan

For each implementation slice:

1. `npx prisma generate` — confirms schema compiles (required for Slice 1 only, which adds `agentScope`).
2. `npx tsc --noEmit` — confirms TypeScript compiles with no new errors.
3. `npm run lint` — confirms the new ESLint rule catches violations (Slice 6 onward).
4. Unit test `buildContext()` returns a valid `SpaceContext_AI` with an `auditLogId` set.
5. Unit test that `db.auditLog.findUnique({ where: { id: result.auditLogId } })` returns a row with the correct `action` and no raw financial values in `metadata`.
6. Unit test that `buildContext()` with an invalid `spaceId` (user is not a member) throws before any assembler is invoked.
7. Unit test that a Consumer that calls an assembler directly fails the lint check.
8. Integration test (Slice 7): `POST /admin/ai/generate-advice/:spaceId` produces a valid `AiAdvice` row. The Brief route returns the AI-generated summary for that Space.

---

## 19. Open questions requiring product/eng confirmation before Slice 1

1. **`agentScope` default for the Personal Space AiAgent.** What scope should be granted by default on Space creation? Recommendation: `['OWN_ACCOUNTS', 'ACCOUNTS_SUMMARY', 'SNAPSHOT_HISTORY', 'GOALS', 'TRANSACTIONS_SUMMARY', 'PLATFORM_HEALTH']`. Needs explicit approval before the schema migration is written.
2. **LLM provider and client.** `lib/ai/consumers/advice-generator.ts` needs to call an LLM. No LLM SDK is currently in the repository. Which provider (Anthropic, OpenAI, etc.) and which client library? This is a dependency of Slice 7; Slices 1–6 are unaffected.
3. **Transaction summary window.** 30 days, 90 days, or configurable per consumer? Recommendation: 90-day default with a 30-day "recent" sub-window included in the same summary object.
4. **Brief AI integration timing.** Should Slice 8 (Brief integration) land in the `feature/ai-context-builder` branch or as a follow-on branch once Slice 7 is proven in production? Recommendation: separate branch, after Slice 7 has run against real data for at least one release cycle.

---

## 20. Sign-off & next steps

This document makes no code changes.

Recommended next step: product/eng review. Confirm the 19 open questions above (particularly question 1 — `agentScope` defaults — and question 2 — LLM provider). Then open `feature/ai-context-builder` starting with Slice 1 only, pending approval of that slice's implementation checklist.

The implementation sequencing from the Decision Matrix (§3) places `feature/ai-context-builder` last in the six-branch sequence, after `feature/published-account-view`. Slices 1–6 of this investigation have no dependency on the prior branches and can begin in parallel. Slice 7 (AiAdvice generation) has no dependency on any remaining Phase 2 branch. `SpaceAccountLink` is the canonical read model; the accounts assembler queries it directly — no fallback, no dual-read path.
