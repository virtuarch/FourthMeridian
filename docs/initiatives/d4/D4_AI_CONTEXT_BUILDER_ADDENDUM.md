# D4 — AI Context Builder: Architecture Addendum

**Status: Investigation only. No schema, migration, API, or application code was modified.**

## 0. Document control

| | |
|---|---|
| Parent document | `docs/initiatives/d4/D4_AI_CONTEXT_BUILDER_INVESTIGATION.md` |
| Scope | Three architectural investigations: template-aware Context Builder, Daily Brief Aggregator, normalized signals |
| Confirmed sources | `lib/space-presets.ts` (full read), `lib/space.ts` (full read), `prisma/schema.prisma` (SpaceMemberRole, SpaceCategory, AiAgent, AiAdvice enums), `app/api/brief/route.ts` (full read), `lib/summary-status.ts`, `lib/brief-types.ts` |
| Confirmed schema fact | `SpaceMemberRole` has four values: `OWNER`, `ADMIN`, `MEMBER`, `VIEWER`. No `SpaceTemplate` model exists yet in the schema — D9 is still pending. |

---

## A. Does the current D4 investigation already support template-awareness?

**Short answer: the domain assembler pattern is the right shape, but three implementation decisions in the investigation create finance-locked contracts that would be expensive to undo after Slice 1 lands.**

### What the current investigation gets right

The per-domain assembler pattern — one function per domain, each receiving a validated `SpaceContext`, each returning a typed section or null — generalizes cleanly to any template. Nothing in an accounts assembler, a goals assembler, or a providers assembler is specific to the builder. A bookings assembler for a Travel template would look structurally identical. The separation of concerns is correct.

The permission layer (`getSpaceContext()`, `SpaceAccountLink`, role-based visibility) is completely generic. It knows nothing about domains. Template-awareness does not require changing anything in this layer.

### Where the current investigation finance-locks the contract

**Lock 1: `AgentScope` as a closed enum with finance-specific values.**

The investigation proposes:

```ts
enum AgentScope {
  OWN_ACCOUNTS        = 'OWN_ACCOUNTS',
  TRANSACTIONS_SUMMARY= 'TRANSACTIONS_SUMMARY',
  HOLDINGS_SUMMARY    = 'HOLDINGS_SUMMARY',
  // ...
}
```

This is stored in `AiAgent.agentScope` as a JSON string array in the database. Once `AiAdvice` generation ships and real `AiAgent` rows carry `['OWN_ACCOUNTS', 'TRANSACTIONS_SUMMARY', 'GOALS']`, changing those values is a data migration. More critically, the closed enum makes `ContextDomain` a compile-time concept — adding `'BOOKINGS'` for a Travel template would require extending the enum, which touches the core `lib/ai/types.ts` file every time a new template is introduced. That is exactly the evolution burden the user wants to avoid.

**Lock 2: `SpaceContext_AI` with hardcoded named domain fields.**

The investigation proposes:

```ts
interface SpaceContext_AI {
  accounts?:    SpaceContext_Accounts;
  transactions? SpaceContext_Transactions;
  holdings?:    SpaceContext_Holdings;
  goals?:       SpaceContext_Goals;
  // ...
}
```

Every consumer that ships against this interface accesses `ctx.accounts`, `ctx.transactions`, etc. A Travel template's `ctx.bookings` or `ctx.itinerary` has no home in this shape — adding it requires modifying `SpaceContext_AI`, which is the public contract between the builder and every consumer. Retrofitting an open-ended domain map after several consumers are written breaks all of them.

**Lock 3: The builder invokes assemblers directly (implied), with no registry.**

The investigation describes the builder as invoking assemblers based on `agentScope` but gives no mechanism for how the builder knows which assembler corresponds to which scope value. The natural implementation from the investigation as written is a switch/if-else block inside the builder itself:

```ts
if (scope.includes('OWN_ACCOUNTS')) {
  context.accounts = await accountsAssembler(spaceCtx, options);
}
if (scope.includes('TRANSACTIONS_SUMMARY')) {
  context.transactions = await transactionsAssembler(spaceCtx, options);
}
```

Adding a Travel template's `BOOKINGS` domain to this pattern requires modifying the builder — adding another `if` branch and importing the bookings assembler. That is the maintenance burden the architecture should avoid. The builder should iterate a registry; it should not know assembler names.

---

## B. Why making this template-aware before Slice 1 is the right call

The cost calculus is clear:

**Cost of the finance-first path:**
- `agentScope` DB values are stored as finance-specific strings on `AiAgent` rows. Changing those values after Slice 7 ships `AiAdvice` generation requires a data migration across every Space that has an `AiAgent` row.
- `SpaceContext_AI` named fields become the consumer contract before Slice 7 (advice-generator) and Slice 8 (brief-enhancer) are written. Migrating those consumers from `ctx.accounts` to `ctx.domains['accounts']` is a coordinated breaking change across every consumer in the system.
- Every future template introduction requires a D4 branch — modifying the builder, the enum, and the root interface — which contradicts the user's explicit requirement ("I don't want to have to continuously modify the Context Builder every time a new Space template is introduced").

**Cost of the template-aware path before Slice 1:**
- `ContextDomain` becomes an open string type with named constants rather than a closed enum. Zero DB impact — the column already stores `string[]`. The string values change (e.g., `'accounts'` instead of `'OWN_ACCOUNTS'`), which is a change to the documentation, not to a deployed column.
- `SpaceContext_AI.domains` is a `Record<string, ContextDomainSection>` instead of named optional fields. This is a small ergonomic change at consumer call sites — `ctx.domains['accounts']` instead of `ctx.accounts` — that costs one refactor now and prevents an unbounded number of refactors later.
- An assembler registry (`lib/ai/assembler-registry.ts`) and a domain manifest (`lib/ai/domain-manifest.ts`) add two small files to the Slice 1 foundation with no schema changes and no changes to the permission layer.
- A `signals: ContextSignal[]` field added to `SpaceContext_AI` now (initially always empty) requires no change when signal detection is implemented.

The template-aware changes before Slice 1 are additive and confined to `lib/ai/`. The retrofit cost after finance-first consumers ship is breaking and wide.

---

## C. Template-aware architecture

### The revised pipeline

```
Space
  │
  │  space.category → domain manifest lookup
  ▼
Domain Manifest (lib/ai/domain-manifest.ts)
  │  Returns: string[] — the default domain list for this Space's category
  │  Currently: SpaceCategory → ContextDomain[]; later: SpaceTemplate.contextDomains
  │
  ▼
AiAgent.agentScope (optional restriction layer)
  │  Intersects the template manifest — narrows, never widens
  │  Stored as string[] in DB; values are the same string keys as the manifest
  │
  ▼
Assembler Registry (lib/ai/assembler-registry.ts)
  │  Map<string, AssemblerFn> — one entry per registered domain
  │  Finance assemblers registered at startup; future template assemblers plug in here
  │
  ▼
Context Builder (lib/ai/context-builder.ts)
  │  Generic assembly engine — iterates the resolved domain list,
  │  looks up each assembler in the registry, invokes it.
  │  The builder has no knowledge of domain names or types.
  │
  ▼
SpaceContext_AI
  │  domains: Record<string, ContextDomainSection>
  │  signals: ContextSignal[]  (populated by signal detection, see §E)
  │
  ▼
AI Consumers
  (Daily Brief Aggregator, Chat, Recommendations, Opportunity Detection, …)
```

### ContextDomain as an open string type

```ts
// lib/ai/types.ts

// ContextDomain is an open string — any registered assembler key is valid.
// Consumers reference built-in domains via the constants below.
// Future template domains (e.g. 'bookings', 'revenue') use their own constants
// defined alongside their assemblers; the core types file never needs to change.
export type ContextDomain = string;

// ── Built-in finance domains ───────────────────────────────────────────────
// All current Space categories (PERSONAL, HOUSEHOLD, FAMILY, BUSINESS, PROPERTY,
// VEHICLE, TRIP, INVESTMENT, RETIREMENT, DEBT_PAYOFF, EMERGENCY_FUND) are
// served by subsets of these domains.
export const FinanceDomains = {
  ACCOUNTS:           'accounts',
  TRANSACTIONS_SUMMARY:'transactions_summary',
  TRANSACTIONS_RAW:   'transactions_raw',
  HOLDINGS_SUMMARY:   'holdings_summary',
  HOLDINGS_RAW:       'holdings_raw',
  GOALS:              'goals',
  MEMBERS:            'members',
  SNAPSHOT_HISTORY:   'snapshot_history',
  PROVIDERS:          'providers',
  PLATFORM_HEALTH:    'platform_health',
} as const;
```

A Travel template defines its own constants in its own file:

```ts
// lib/ai/assemblers/travel/domains.ts  (future, illustrative)
export const TravelDomains = {
  BOOKINGS:   'bookings',
  ITINERARY:  'itinerary',
  BUDGET:     'travel_budget',
  TASKS:      'tasks',
} as const;
```

Neither file imports the other. The builder knows neither. The registry mediates.

### SpaceContext_AI with a domain map

```ts
// lib/ai/types.ts

export interface ContextDomainSection {
  domain:      string;             // the domain key that produced this section
  assembledAt: string;             // ISO timestamp
  data:        unknown;            // typed by each assembler's return type contract
}

export interface SpaceContext_AI {
  // ── Identity (always present) ─────────────────────────────────────────
  requestedAt:    string;
  spaceId:        string;
  userId:         string;
  role:           SpaceMemberRole;
  agentId:        string;
  resolvedDomains: string[];       // which domains were actually assembled

  // ── Space metadata (always present) ──────────────────────────────────
  space: {
    id:       string;
    name:     string;
    type:     string;
    category: string;
  };

  // ── Domain sections (open map) ────────────────────────────────────────
  // Access: ctx.domains['accounts'], ctx.domains['bookings'], etc.
  // Type narrowing at the consumer: cast data to the assembler's return type.
  domains: Record<string, ContextDomainSection>;

  // ── Signals (see §E) ─────────────────────────────────────────────────
  signals: ContextSignal[];        // always present; empty until signal detection is wired

  // ── Audit receipt ─────────────────────────────────────────────────────
  auditLogId: string;
}
```

### Assembler registry

```ts
// lib/ai/assembler-registry.ts

export type AssemblerFn = (
  spaceCtx: SpaceContext,
  options:  AssemblerOptions,
) => Promise<ContextDomainSection | null>;

const registry = new Map<string, AssemblerFn>();

export function registerAssembler(domain: string, fn: AssemblerFn): void {
  if (registry.has(domain)) {
    throw new Error(`Assembler already registered for domain: ${domain}`);
  }
  registry.set(domain, fn);
}

export function getAssembler(domain: string): AssemblerFn | undefined {
  return registry.get(domain);
}
```

Finance assemblers register themselves when their module is imported:

```ts
// lib/ai/assemblers/accounts.ts
import { registerAssembler } from '@/lib/ai/assembler-registry';
// ... assembler implementation
registerAssembler(FinanceDomains.ACCOUNTS, accountsAssembler);
```

The builder imports all built-in assemblers in its module preamble, triggering registration. Future template assemblers are registered by their own module, not by the builder. The builder never imports a template-specific file.

### Domain manifest

```ts
// lib/ai/domain-manifest.ts

// Maps SpaceCategory to the default domain list for that category.
// This is the AI-context parallel to lib/space-presets.ts's PRESET_MAP.
// When SpaceTemplate (D9) exists, the template's contextDomains field
// replaces this map; this file becomes the fallback for categories without
// a saved template row.

const FINANCE_FULL: ContextDomain[] = [
  FinanceDomains.ACCOUNTS,
  FinanceDomains.TRANSACTIONS_SUMMARY,
  FinanceDomains.GOALS,
  FinanceDomains.SNAPSHOT_HISTORY,
  FinanceDomains.PROVIDERS,
  FinanceDomains.PLATFORM_HEALTH,
];

const FINANCE_INVESTMENTS: ContextDomain[] = [
  ...FINANCE_FULL,
  FinanceDomains.HOLDINGS_SUMMARY,
];

export const DOMAIN_MANIFEST_BY_CATEGORY: Record<string, ContextDomain[]> = {
  PERSONAL:       FINANCE_FULL,
  HOUSEHOLD:      FINANCE_FULL,
  FAMILY:         FINANCE_FULL,
  BUSINESS:       FINANCE_FULL,
  PROPERTY:       [...FINANCE_FULL, FinanceDomains.MEMBERS],
  VEHICLE:        FINANCE_FULL,
  TRIP:           FINANCE_FULL,  // finance domains only until a Travel template exists
  INVESTMENT:     FINANCE_INVESTMENTS,
  EQUIPMENT:      FINANCE_FULL,
  RETIREMENT:     FINANCE_INVESTMENTS,
  DEBT_PAYOFF:    FINANCE_FULL,
  EMERGENCY_FUND: FINANCE_FULL,
  GOAL:           FINANCE_FULL,
  CUSTOM:         FINANCE_FULL,
  OTHER:          FINANCE_FULL,
};

export function getDomainManifest(category: string): ContextDomain[] {
  return DOMAIN_MANIFEST_BY_CATEGORY[category] ?? FINANCE_FULL;
}
```

**How D9 (SpaceTemplate) plugs in later:**

When `SpaceTemplate` exists and a Space's template row has a `contextDomains: string[]` field, `getDomainManifest()` checks the template row first and falls back to `DOMAIN_MANIFEST_BY_CATEGORY`. The builder calls the same function. Nothing in the builder changes.

```ts
// Future — after D9:
export async function getDomainManifest(
  category: string,
  templateId?: string | null,
): Promise<ContextDomain[]> {
  if (templateId) {
    const template = await db.spaceTemplate.findUnique({
      where: { id: templateId },
      select: { contextDomains: true },
    });
    if (template?.contextDomains?.length) return template.contextDomains;
  }
  return DOMAIN_MANIFEST_BY_CATEGORY[category] ?? FINANCE_FULL;
}
```

The builder passes one more argument. The consumers notice nothing. This is what "future templates plug into the platform rather than requiring D4 itself to evolve each time" looks like in practice.

### How AiAgent.agentScope changes role

Under the current investigation, `AiAgent.agentScope` is the primary declaration of what domains an agent may access. Under the template-aware architecture, the domain manifest is the primary declaration; `agentScope` is a restriction layer.

- If `agentScope` is empty or null: the builder uses the full template manifest.
- If `agentScope` is set: the builder uses the intersection of the manifest and `agentScope`. This allows restricting an agent to a subset of what the template declares — useful for a VIEWER-mode agent or a specialized consumer that only needs two domains.

This change makes `agentScope` meaningful as a per-agent override while removing the burden of initializing it with the full domain list on every Space creation.

---

## D. Daily Brief Aggregator

### The current architecture's limitation

`app/api/brief/route.ts` calls `getSpaceContext()`, resolves the user's currently active Space, and builds a brief for that one Space. A user with a Personal Space, a Family Space, and a Business Space gets a brief containing only the active one. The other two Spaces are silent unless the user switches to them manually. This is adequate now but becomes the wrong model as users manage more Spaces.

The more fundamental issue: the Daily Brief is intended to be a **personal intelligence layer** — "what does this user need to know this morning across their entire financial life?" That question cannot be answered by a single Space's context.

### Proposed architecture

```
User
  │
  ├─ Personal Space (OWNER)
  ├─ Family Space (ADMIN)
  ├─ Business Space (OWNER)
  └─ Friend's Space (VIEWER) ← excluded from Brief
       │
       ▼ (for each OWNER/ADMIN/MEMBER Space, independently)
  Per-Space Context (buildContext() — brief scope)
       │
       ▼
  Per-Space Signals (signal detection over that Space's context)
       │
       ▼
  Brief Aggregator (lib/ai/consumers/brief-aggregator.ts)
       │  — receives: [{spaceId, spaceName, signals[], latestAdvice?}, ...]
       │  — ranks signals by severity and recency
       │  — groups by Space for attribution
       │  — selects the top N for the brief (cap: 3–5 cross-Space signals)
       │  — produces BriefPayload
       ▼
  BriefPayload (same shape as today — no consumer-facing change)
```

### Why VIEWER Spaces are excluded

`SpaceMemberRole.VIEWER` represents read-only observership — the user can see what's happening in a Space but is not an active participant accountable for it. Including a VIEWER Space in a user's Daily Brief creates two problems:

1. **Inverse privacy concern.** The Space owner shared their data with a viewer in the context of that Space's UI. They did not consent to that data flowing into the viewer's personal AI intelligence layer, which may persist it, summarize it, or share it with other AI consumers outside the Space context.
2. **Signal relevance.** A viewer cannot act on signals from a Space they don't control. "The Martinez Family Space has high credit utilization" is not an actionable signal for a user whose role is VIEWER — they have no levers to pull.

VIEWER Spaces may still generate AI summaries *within* the Space (a VIEWER-scoped `buildContext()` call from the Space's own dashboard), but those summaries do not propagate into the user's personal Brief.

### Brief scope for aggregation

The Brief Aggregator does not request the full domain manifest for every Space — that would be expensive when a user has many Spaces. It uses a "brief scope": the minimal domain set sufficient for signal detection.

```ts
const BRIEF_SCOPE: ContextDomain[] = [
  FinanceDomains.ACCOUNTS,          // totals for net worth signal
  FinanceDomains.GOALS,             // goal status signals
  FinanceDomains.SNAPSHOT_HISTORY,  // 30-day trend signal
  FinanceDomains.PLATFORM_HEALTH,   // connection issue signals
];
```

Each Space's `buildContext()` is called with this narrow scope. The Aggregator collects signals from all Spaces, ranks them by severity and recency, and selects the most significant ones for the brief. The top `AiAdvice` row per Space (if recent) contributes its `summary` as an insight signal.

### What changes in the Slice 8 description

The current Slice 8 reads: "Wire the advice generation into the Brief pipeline. The Brief assembles its own data (as today) and calls `buildContext()` for the Insight section only." This is the single-Space model.

The revised Slice 8 should read: "Replace `app/api/brief/route.ts`'s single-Space context fetch with a Brief Aggregator that calls `buildContext()` once per active (OWNER/ADMIN/MEMBER) Space at brief scope, collects signals from all Spaces, and passes the ranked signals to the `BriefPayload` builder." The `BriefPayload` shape (`lib/brief-types.ts`) does not change — only how it is populated.

### Multi-Space AiAdvice

Currently `AiAdvice` is Space-scoped: one row per advice run per Space. This is already the right shape for the aggregator — it reads the most recent `AiAdvice.summary` for each Space and includes it as a "top insight" signal from that Space. No schema change needed.

---

## E. Normalized Signals

### What signals are and why they matter

Currently, condition detection in Fourth Meridian is fragmented:

- `lib/summary-status.ts` detects cash and debt threshold states (for dashboard UI pills)
- `app/api/brief/route.ts`'s `buildAttention()` detects high credit utilization, stale manual assets, low liquidity (for the Brief)
- Future Chat, Recommendations, and Opportunity Detection consumers would each need to re-detect these conditions independently

Signals normalize condition detection. A signal is a discrete named condition detected from assembled Context data, emitted once, and consumed by any number of consumers. "HIGH_CREDIT_UTILIZATION detected in Chase Sapphire account" is detected once and is available to the Brief, to Chat, to Recommendations, and to any future consumer — none of them re-implement the detection rule.

### Signal shape

```ts
// lib/ai/types.ts

export interface ContextSignal {
  id:          string;                      // stable type key: 'EMERGENCY_FUND_BELOW_TARGET'
  domain:      string;                      // which domain this signal came from: 'accounts'
  spaceId:     string;                      // source Space
  severity:    'info' | 'warning' | 'critical';
  title:       string;                      // human-readable: "Emergency fund below target"
  body?:       string;                      // supporting detail
  value?:      number;                      // measured value: 0.62 (62% funded)
  threshold?:  number;                      // threshold crossed: 1.0 (100%)
  metadata?:   Record<string, unknown>;     // type-specific extra fields
  detectedAt:  string;                      // ISO timestamp of this detection run
}
```

Signals are deterministic and rule-based. The AI consumes them as inputs; it does not generate them. This distinction is critical: signals are grounded facts derived from canonical data, not inferences. An AI consumer can say "you have an emergency fund below target" because a detection rule verified it against real balances — not because the LLM inferred it from prose.

### Signal detection as a registry

Signal detection rules are registered per domain, parallel to assemblers:

```ts
// lib/ai/signal-registry.ts

export type SignalDetectorFn = (
  domain: string,
  section: ContextDomainSection,
  spaceId: string,
) => ContextSignal[];

const signalRegistry = new Map<string, SignalDetectorFn[]>();

export function registerSignalDetector(domain: string, fn: SignalDetectorFn): void {
  const existing = signalRegistry.get(domain) ?? [];
  signalRegistry.set(domain, [...existing, fn]);
}
```

Finance signal detectors register alongside their assemblers:

```ts
// lib/ai/assemblers/accounts.ts
registerSignalDetector(FinanceDomains.ACCOUNTS, (domain, section, spaceId) => {
  const data = section.data as AccountsDomainData;
  const signals: ContextSignal[] = [];

  // Emergency fund signal
  const efGoal = data.goals?.find(g => g.category === 'EMERGENCY_FUND');
  if (efGoal && efGoal.progress < 1.0) {
    signals.push({
      id: 'EMERGENCY_FUND_BELOW_TARGET',
      domain, spaceId,
      severity: efGoal.progress < 0.5 ? 'critical' : 'warning',
      title:    'Emergency fund below target',
      value:    efGoal.progress,
      threshold: 1.0,
      detectedAt: new Date().toISOString(),
    });
  }

  // High credit utilization signal
  for (const acct of data.liabilities) {
    if (acct.creditLimit && Math.abs(acct.balance) / acct.creditLimit > 0.7) {
      signals.push({
        id: 'HIGH_CREDIT_UTILIZATION',
        domain, spaceId,
        severity: 'warning',
        title:    `High utilization — ${acct.name}`,
        value:    Math.abs(acct.balance) / acct.creditLimit,
        threshold: 0.7,
        detectedAt: new Date().toISOString(),
      });
    }
  }

  return signals;
});
```

### Where detection runs

Signal detection runs inside `buildContext()` after all domain assemblers complete, before the `SpaceContext_AI` object is returned:

```
Domain Assemblers → assembled domains
                         │
                         ▼
                 Signal Detector (lib/ai/signal-registry.ts)
                 Iterates assembled domains; runs registered detectors
                         │
                         ▼
                 ContextSignal[]
                         │
                         ▼
                 SpaceContext_AI.signals (populated)
```

This placement means every consumer automatically receives signals — they do not request them separately, and signal detection is not duplicated across consumers.

### Built-in finance signals (initial set)

| Signal ID | Domain | Severity trigger |
|---|---|---|
| `EMERGENCY_FUND_BELOW_TARGET` | `accounts` / `goals` | fund < 100% of target |
| `HIGH_CREDIT_UTILIZATION` | `accounts` | utilization > 70% |
| `STALE_SYNC` | `platform_health` | any connection not synced > 7 days |
| `NEEDS_REAUTH` | `platform_health` | any connection in NEEDS_REAUTH status |
| `GOAL_AT_RISK` | `goals` | goal past target date and < 80% complete |
| `NET_WORTH_DECLINING` | `snapshot_history` | net worth down >5% over 30 days |
| `CASH_BELOW_THRESHOLD` | `accounts` | liquid cash < $1,000 |
| `PORTFOLIO_ALLOCATION_DRIFT` | `holdings_summary` | any asset class drifted > 10% from target |

Travel template signals (future, illustrative — register alongside travel assemblers):

| Signal ID | Domain | Trigger |
|---|---|---|
| `TRIP_BUDGET_EXCEEDED` | `travel_budget` | spent > budget |
| `HOTEL_RESERVATION_EXPIRING` | `bookings` | cancellation window closing |

The `buildContext()` function never needs to change when new signals or new templates are added. The signal registry is the extension point.

### Relationship to existing lib/summary-status.ts

`lib/summary-status.ts` is the primitive precursor to signals. It returns UI display strings (`"Cash is tight"`, `"High debt load"`) from threshold comparisons. The signal layer generalizes this: same threshold logic, but output is a typed `ContextSignal` with a stable `id` that all consumers can act on, rather than a Tailwind class string.

`lib/summary-status.ts` continues to serve its current purpose (dashboard UI labels). The signal layer serves the AI layer. They are complementary, not redundant. When the signal `CASH_BELOW_THRESHOLD` fires, the dashboard may show "Cash is tight" (from `summary-status.ts`) and the Brief Aggregator includes a "Cash is tight in your Personal Space" signal (from the signal registry). Same fact, two appropriate surfaces.

---

## F. Revised implementation slices

The original Slice 1–8 list stands with the following amendments. A new Slice 9 is added.

### Revised Slice 1 — Foundation: registry, manifest, types, builder shell, audit entry

**What changes from the original:**

Replace the original Slice 1's deliverables with the following expanded (but still schema-minimal) foundation:

1. **`lib/ai/types.ts`** — defines `ContextDomain` (open string type), `FinanceDomains` constants, `ContextDomainSection`, `SpaceContext_AI` (with `domains: Record<string, ContextDomainSection>` and `signals: ContextSignal[]`), `ContextSignal`.

2. **`lib/ai/assembler-registry.ts`** — `registerAssembler()` / `getAssembler()`.

3. **`lib/ai/signal-registry.ts`** — `registerSignalDetector()` / running detectors over assembled domains.

4. **`lib/ai/domain-manifest.ts`** — `getDomainManifest(category)` keyed by `SpaceCategory`, returning `ContextDomain[]`. No DB queries — pure mapping function. D9-ready: the function signature accepts an optional `templateId` even though D9 doesn't exist yet; the implementation ignores it until D9 lands.

5. **`lib/ai/context-builder.ts`** — `buildContext(spaceId, userId, scopeOverride?)` that: resolves `SpaceContext` via `getSpaceContext()`, resolves `AiAgent`, derives the domain list from `getDomainManifest()` intersected with `AiAgent.agentScope` (if set), iterates the domain list and invokes registered assemblers, runs signal detection, writes `AuditLog`, returns `SpaceContext_AI`. At Slice 1, no assemblers are registered yet — the returned `domains` is `{}` and `signals` is `[]`. This proves the foundation compiles and the audit write works.

6. **`lib/ai/index.ts`** — exports only `buildContext` and public types.

**Schema change (same as original):** Add `agentScope String[]` (JSON array of `ContextDomain` string keys) to `AiAgent`, nullable, default empty. Values are now open domain key strings (`'accounts'`, `'goals'`) rather than finance enum constants.

**No other changes.**

### Slices 2–7 (unchanged in purpose, updated domain map access)

Assemblers in Slices 2–5 call `registerAssembler(FinanceDomains.X, fn)` at module load time. Signal detectors in Slices 2–5 call `registerSignalDetector(FinanceDomains.X, fn)`. No other changes to the slice deliverables.

### Revised Slice 8 — Daily Brief Aggregator (replaces single-Space brief integration)

**Replaces the original Slice 8 description entirely.**

**Deliverable:** `lib/ai/consumers/brief-aggregator.ts`. This function:

1. Queries all `SpaceMember` rows for the requesting user where `status = ACTIVE` and `role IN (OWNER, ADMIN, MEMBER)` — excluding VIEWER and excluding archived/trashed Spaces.
2. Calls `buildContext(spaceId, userId, BRIEF_SCOPE)` for each Space in parallel. `BRIEF_SCOPE = [FinanceDomains.ACCOUNTS, FinanceDomains.GOALS, FinanceDomains.SNAPSHOT_HISTORY, FinanceDomains.PLATFORM_HEALTH]`.
3. Collects all `ContextSignal[]` from each Space's context.
4. Reads the most recent `AiAdvice.summary` for each Space (if any, generated by Slice 7).
5. Ranks signals by severity and recency; caps at 5 cross-Space signals in the brief.
6. Produces a `BriefPayload` with signal-sourced sections, attributed to their source Space by name.

`app/api/brief/route.ts` calls `brief-aggregator.ts` instead of building its own data inline. The `BriefPayload` shape (`lib/brief-types.ts`) is unchanged — no consumer-facing change.

**Validation:** Multi-Space seeded test: user with Personal + Family Spaces. Brief includes signals from both Spaces with correct Space attribution. Brief for a user with a VIEWER Space does not include that Space's signals.

### New Slice 9 — Signal baseline (finance detectors)

**Deliverable:** Signal detector functions registered for the built-in finance domains, covering the initial set in §E: `EMERGENCY_FUND_BELOW_TARGET`, `HIGH_CREDIT_UTILIZATION`, `STALE_SYNC`, `NEEDS_REAUTH`, `GOAL_AT_RISK`, `NET_WORTH_DECLINING`, `CASH_BELOW_THRESHOLD`.

These detectors run automatically when their domain assembler has produced a section. No new infrastructure needed — the signal registry from Slice 1 is already in place.

**Validation:** Seeded Space with a low emergency fund fires `EMERGENCY_FUND_BELOW_TARGET`. Brief aggregator includes the signal in its output. `getCashStatusMessage()` in `lib/summary-status.ts` is unchanged — signals and UI status messages are parallel, not conflated.

---

## G. What does NOT change

The following elements of the original D4 investigation are correct as written and require no amendment:

- The permission enforcement architecture (§7 of the main investigation) — SpaceContext validation, query-level scoping, and the credential import boundary are all generic and template-agnostic.
- The credential exclusion rules (§4) — unchanged.
- The summarized-vs-raw decision (§11) — unchanged. The domain map carries the same summarized data; consumers access it via `ctx.domains['accounts'].data`.
- The caching strategy (§13) — unchanged.
- The module structure (§16) — add `assembler-registry.ts`, `signal-registry.ts`, `domain-manifest.ts` to `lib/ai/`; the rest is as described.
- The `AuditLog` write behavior (§14 Slice 1) — unchanged.
- The lint rule and runtime guard (§7, Slice 6) — unchanged.

---

## H. Summary answer to the investigation questions

**Should D4 be template-aware before Slice 1?**

Yes. The `AgentScope` enum values and the `SpaceContext_AI` named domain fields would both become baked-in finance-first contracts that require breaking changes to undo. The template-aware alternatives — open string `ContextDomain` type, domain map in the root interface, assembler registry, domain manifest — are small additive changes that prevent an unbounded future maintenance burden. The builder remains generic. Future templates plug in via the registry without touching D4.

**Should the Daily Brief consume one Context or aggregate across Spaces?**

Aggregate. The Brief is a personal intelligence layer, not a per-Space dashboard. Each eligible Space (OWNER/ADMIN/MEMBER, not VIEWER) builds its own Context independently at brief scope; the Aggregator combines significant signals. VIEWER Spaces are excluded on both consent and relevance grounds.

**Should Context emit normalized signals?**

Yes. The signal layer is the principled generalization of what `lib/summary-status.ts` and `buildAttention()` already do in fragmented form. Signals normalize condition detection so every consumer reasons over the same named facts rather than each independently re-detecting important conditions. The signal registry is template-extensible by the same mechanism as the assembler registry.

**Is any of this a Slice 1 blocker?**

Only the type and registry foundation changes need to be in Slice 1 — and they add two small files and one type change. None of it requires schema changes beyond the already-planned `AiAgent.agentScope` column. The signal detection rules and the Brief Aggregator land in Slices 8–9, after assemblers are proven.
