# Widget Meta Analysis

> Design pass — no code changes yet.
> Covers: widgetMeta type definition · SectionRegistry inventory · widget-to-meta mapping ·
> placeholder gaps · normalized data contracts · minimum schema changes.

---

## 1. widgetMeta types

Every registered widget should export a `WidgetMeta` object alongside its component.
The registry maps `key → { component, meta }` instead of the current `key → render function`.

```ts
// lib/widget-registry.ts  (new file, proposed)

import type { WorkspaceDashboardTab } from "@/lib/workspace-presets";

// ── Data requirements (for picker warnings + data-readiness checks) ──────────

export type AccountVisibility = "FULL" | "BALANCE_ONLY" | "any";

export interface DataRequirement {
  /** One or more account.type values that must be present */
  accountTypes: string[];
  /** Minimum visibility level for those accounts */
  visibility: AccountVisibility;
  /** How many qualifying accounts must exist (default 1) */
  minCount?: number;
  /** Human-readable explanation shown in the widget picker when not met */
  reason: string;
}

// ── Config schema (for future config panel, Phase 4) ─────────────────────────

export type ConfigFieldType = "number" | "string" | "select" | "boolean" | "date";

export interface ConfigField {
  key:       string;
  label:     string;
  type:      ConfigFieldType;
  options?:  { value: string; label: string }[];
  default?:  unknown;
  hint?:     string;
}

// ── The meta descriptor ───────────────────────────────────────────────────────

export interface WidgetMeta {
  /** Stable machine-readable key — matches WorkspaceDashboardSection.key */
  key:              string;
  /** Display name in settings list and picker */
  label:            string;
  /** One-line description shown in picker cards */
  description:      string;
  /** Default tab assignment */
  tab:              WorkspaceDashboardTab;
  /** Lucide icon name */
  icon:             string;
  /** Data tier — determines which fetch calls are needed */
  dataTier:         DataTier;
  /** Required data conditions — empty array = always renderable */
  requires:         DataRequirement[];
  /** Config fields this widget reads from WorkspaceDashboardSection.config */
  configSchema?:    ConfigField[];
  /** Can the card be collapsed? Default true */
  collapsible?:     boolean;
  /** Does the card support a fullscreen/expand mode? */
  fullscreenable?:  boolean;
  /** Is this a legacy alias for another key? */
  deprecatedAlias?: string;
}

// ── Data tiers ────────────────────────────────────────────────────────────────
// Determines which API calls the dashboard shell must make.

export type DataTier =
  | "accounts"      // NormalizedAccount[] from /api/workspaces/[id]/accounts
  | "goals"         // WorkspaceGoal[]     from /api/workspaces/[id]/goals
  | "holdings"      // Holding[]           from /api/workspaces/[id]/holdings  (future)
  | "transactions"  // aggregated tx data  from /api/workspaces/[id]/transactions (future)
  | "none";         // no external data (pure config, audit log, etc.)

// ── SectionRenderProps (refined from current implementation) ─────────────────
// Replaces the current "pass everything" approach.
// Each widget only receives what its dataTier requires.

export interface WidgetRenderProps {
  section:     { id: string; key: string; label: string; config: Record<string, unknown> | null };
  workspaceId: string;
  canManage:   boolean;
  // Data — only the tiers relevant to this widget are populated:
  accounts?:   NormalizedAccount[];       // tier: accounts
  goals?:      WorkspaceGoal[];           // tier: goals
  holdings?:   Holding[];                 // tier: holdings (future)
  // UI callbacks
  onAddGoal?:  () => void;
  onExpand?:   () => void;
  onCollapse?: () => void;
}
```

---

## 2. SectionRegistry inventory

Current registry (WorkspaceDashboard.tsx lines 1034–1051) — exact mapping:

| Key | Renders | Status |
|---|---|---|
| `net_worth` | `NetWorthCard` | ✅ Correct |
| `net_worth_section` | `NetWorthCard` | ⚠️ Alias — deprecate |
| `accounts_overview` | `AccountsCard` | ✅ Correct |
| `business_accounts` | `AccountsCard` | ✅ Correct (intentional alias) |
| `debt_summary` | `DebtCard` | ✅ Correct |
| `debt_payoff_tracker` | `DebtCard` | 🔶 Placeholder — wrong component |
| `mortgage_tracker` | `DebtCard` | 🔶 Placeholder — wrong component |
| `auto_loan_tracker` | `DebtCard` | 🔶 Placeholder — wrong component |
| `debt_breakdown_chart` | `DebtBreakdownCard` | ✅ Correct |
| `debt_payoff_calculator` | `DebtPayoffSection` | ✅ Correct |
| `investment_summary` | `InvestmentsCard` | 🔶 Placeholder — balance list only |
| `investment_allocation` | `InvestmentsCard` | 🔶 Placeholder — wrong component |
| `retirement_accounts` | `InvestmentsCard` | 🔶 Placeholder — wrong component |
| `retirement_progress` | `InvestmentsCard` | 🔶 Placeholder — wrong component |
| `goals_progress` | `GoalsCard` | ✅ Correct |
| `recent_activity` | `ActivityCard` | ⚠️ Stub — "coming soon" |

**Keys in workspace-presets.ts with no registry entry (ContextualCard fallback):**

| Key | Present in presets | Data needed |
|---|---|---|
| `cash_flow` | PERSONAL, HOUSEHOLD, FAMILY, PROPERTY, VEHICLE, TRIP, INVESTMENT, EQUIPMENT | Transactions (Tier 5) |
| `savings_rate` | PERSONAL, HOUSEHOLD, FAMILY, EMERGENCY_FUND | Transactions (Tier 5) |
| `business_cash_flow` | BUSINESS | Transactions (Tier 5) |
| `property_value` | PROPERTY | section.config or manual asset account |
| `vehicle_value` | VEHICLE | section.config or manual asset account |
| `trip_budget` | TRIP | section.config target |
| `trip_savings` | TRIP | savings account balance + goal |
| `emergency_fund_progress` | EMERGENCY_FUND | savings balance + goal target |
| `monthly_expenses` | EMERGENCY_FUND | Transactions (Tier 5) |

---

## 3. Widget-to-WidgetMeta mapping

### ✅ Properly implemented

**`net_worth`**
```
dataTier:   accounts
requires:   [] (renders a zero-state if no accounts)
configSchema: []
collapsible: true
```

**`accounts_overview`** / **`business_accounts`**
```
dataTier:   accounts
requires:   []
configSchema: []
collapsible: true
```

**`debt_summary`**
```
dataTier:   accounts
requires:   [{ accountTypes: ["debt"], visibility: "any", reason: "Share a debt account to see totals." }]
collapsible: true
```

**`debt_breakdown_chart`**
```
dataTier:   accounts
requires:   [{ accountTypes: ["debt"], visibility: "FULL", reason: "Requires FULL access to show interest rates." }]
collapsible: false   // explicitly non-collapsible in current code
```

**`debt_payoff_calculator`**
```
dataTier:   accounts
requires:   [{ accountTypes: ["debt"], visibility: "FULL", minCount: 1, reason: "Requires interestRate and minimumPayment — share debt accounts at FULL access." }]
collapsible: true
fullscreenable: true
configSchema: [
  { key: "strategy", label: "Strategy", type: "select",
    options: [{ value: "avalanche", label: "Avalanche (highest rate first)" }, { value: "snowball", label: "Snowball (lowest balance first)" }],
    default: "avalanche" }
]
```

**`goals_progress`**
```
dataTier:   goals
requires:   []
collapsible: true
```

---

### 🔶 Placeholder (registered but wrong component)

**`debt_payoff_tracker`** — currently renders `DebtCard` (the same as `debt_summary`).
Intended to show individual payoff progress bars per account.
```
What it should be: per-account progress bars showing balance vs. original balance.
Proposed component: DebtPayoffTrackerCard (new)
dataTier:   accounts
requires:   [{ accountTypes: ["debt"], visibility: "FULL" }]
configSchema: [
  { key: "strategy", label: "Payoff strategy", type: "select",
    options: avalanche/snowball/custom }
]
```

**`mortgage_tracker`** — currently renders `DebtCard`.
Intended to show mortgage amortization progress for this workspace.
```
What it should be: mortgage balance, equity built, payoff date estimate.
Proposed component: MortgageTrackerCard (new)
dataTier:   accounts
requires:   [{ accountTypes: ["debt"], visibility: "FULL",
               reason: "Share a mortgage account at FULL access to see amortization." }]
configSchema: [
  { key: "originalBalance", label: "Original loan amount", type: "number" },
  { key: "closingDate", label: "Loan origination date", type: "date" }
]
Note: interestRate and minimumPayment from the account record supply the rest.
```

**`auto_loan_tracker`** — same pattern as mortgage_tracker but for auto loans.
```
Proposed component: AutoLoanTrackerCard (new, or merged into a generic LoanTrackerCard)
dataTier:   accounts
requires:   [{ accountTypes: ["debt"], visibility: "FULL" }]
configSchema: [
  { key: "originalBalance", label: "Original loan amount", type: "number" }
]
```

**`investment_summary`** — currently `InvestmentsCard` (balance list).
Should be a portfolio summary with a chart.
```
Proposed component: InvestmentSummaryCard (new — wraps InvestmentsChart.tsx or PortfolioHistoryChart.tsx)
dataTier:   accounts    (balances only for now; holdings for chart in Phase 2)
requires:   [{ accountTypes: ["investment"], visibility: "any" }]
configSchema: [
  { key: "timeRange", label: "Time range", type: "select",
    options: 1M/3M/6M/1Y/All }
]
```

**`investment_allocation`** — currently `InvestmentsCard`.
AllocationChart.tsx already exists and renders a donut by asset class.
```
Proposed component: InvestmentAllocationCard (wraps AllocationChart.tsx)
dataTier:   holdings    (future — Tier 4; falls back to account-type breakdown in meantime)
requires:   [{ accountTypes: ["investment"], visibility: "FULL",
               reason: "Requires FULL access to show allocation." }]
```

**`retirement_accounts`** — currently `InvestmentsCard`.
Should filter to accounts that are retirement types (IRA, 401k, Roth, etc.).
```
Proposed component: RetirementAccountsCard (wraps a filtered AccountsCard)
dataTier:   accounts
requires:   [{ accountTypes: ["investment"], visibility: "any" }]
configSchema: [
  { key: "retirementAccountTypes", label: "Include account types", type: "select",
    options: IRA/401k/Roth/Other, default: all }
]
Note: Until account sub-type tagging exists, this filters by name heuristic or shows all investment accounts.
```

**`retirement_progress`** — currently `InvestmentsCard`.
Should be a target vs. current comparison widget.
```
Proposed component: RetirementProgressCard (new)
dataTier:   accounts
requires:   [{ accountTypes: ["investment"], visibility: "any" }]
configSchema: [
  { key: "targetAmount",     label: "Retirement target ($)",     type: "number" },
  { key: "retirementAge",    label: "Target retirement age",     type: "number" },
  { key: "currentAge",       label: "Current age",               type: "number" },
  { key: "expectedReturn",   label: "Expected annual return (%)", type: "number", default: 7 },
  { key: "annualContribution", label: "Annual contribution ($)", type: "number" }
]
Note: These config fields make this widget self-sufficient without a linked WorkspaceGoal.
      Link to WorkspaceGoal is optional (if goal exists, read its targetAmount).
```

**`net_worth_section`** — alias for `net_worth`. Deprecate by adding `deprecatedAlias: "net_worth"` to its meta; don't render differently.

---

### ⚠️ Stub (registered, renders "coming soon")

**`recent_activity`**
```
dataTier:   none   (will query audit log / workspace activity feed)
requires:   []
Status: registered, ActivityCard renders a placeholder. Needs real implementation.
```

---

### ❌ Missing components (ContextualCard fallback for all)

**`property_value`** / **`vehicle_value`** / **`equipment_value`**
```
dataTier:   accounts (or section.config)
Implementation path: section.config stores a manually-entered current value.
  Widget renders: current value, optional trend vs. purchase price, linked debt.
  No new API or schema change needed — config: Json already exists.
configSchema: [
  { key: "currentValue",   label: "Current estimated value ($)", type: "number" },
  { key: "purchasePrice",  label: "Purchase price ($)",          type: "number" },
  { key: "purchaseDate",   label: "Purchase date",               type: "date" }
]
```

**`trip_budget`** / **`trip_savings`**
```
dataTier:   accounts + goals (trip savings goal drives the target)
configSchema: [
  { key: "totalBudget",  label: "Total trip budget ($)",  type: "number" },
  { key: "departureDate", label: "Departure date",        type: "date" }
]
trip_savings links to a FINANCIAL WorkspaceGoal for the target — no new schema needed.
```

**`emergency_fund_progress`**
```
dataTier:   accounts (savings balance) + goals or section.config (target)
configSchema: [
  { key: "targetMonths", label: "Months of expenses to cover", type: "select",
    options: [3, 6, 9, 12], default: 6 },
  { key: "monthlyExpenses", label: "Monthly expenses (manual override)", type: "number" }
]
If monthly_expenses widget is present, reads its computed value automatically.
```

**`cash_flow`** / **`savings_rate`** / **`business_cash_flow`** / **`monthly_expenses`**
```
dataTier:   transactions   (Tier 5 — not yet available)
These four widgets cannot be built until transaction-level workspace data exists.
See Section 5 below.
```

---

## 4. Placeholder gap summary

| Category | Gaps |
|---|---|
| Alias / deprecated | `net_worth_section` (1 key) |
| Wrong component (same type) | `debt_payoff_tracker`, `mortgage_tracker`, `auto_loan_tracker` (3 keys) |
| Wrong component (completely different) | `investment_allocation`, `retirement_accounts`, `retirement_progress` (3 keys) |
| Stub ("coming soon") | `recent_activity` (1 key) |
| No component, config-driven | `property_value`, `vehicle_value`, `equipment_value`, `trip_budget`, `trip_savings`, `emergency_fund_progress` (6 keys) |
| No component, needs transactions | `cash_flow`, `savings_rate`, `business_cash_flow`, `monthly_expenses` (4 keys) |

**Total keys with no real component: 18 of 25 registered/referenced keys.**
**Keys with a real implementation: 7** (`net_worth`, `accounts_overview`, `debt_summary`, `debt_breakdown_chart`, `debt_payoff_calculator`, `goals_progress`, `recent_activity`-stub).

---

## 5. Normalized data contracts

### Contract A — NormalizedAccount (already defined in lib/account-privacy.ts)

```ts
interface NormalizedAccount {
  id:              string;
  name:            string;
  type:            string;          // checking | savings | investment | crypto | debt | other
  balance:         number;
  currency:        string;
  lastUpdated:     string;          // ISO string
  // FULL-only fields (undefined on BALANCE_ONLY rows):
  institution?:    string;
  creditLimit?:    number | null;
  debtSubtype?:    string | null;   // credit_card | mortgage | auto_loan | personal_loan | student_loan | heloc | line_of_credit
  interestRate?:   number | null;   // APR
  minimumPayment?: number | null;
}
```

This contract is already stable and covers Tier 1 widgets. No changes needed.

### Contract B — WorkspaceGoal (already in WorkspaceDashboard.tsx)

Used only by GoalsCard. Adequate for the current goals widget.
A `GoalSummary` projection (without check-in history) should be defined for future widgets that
only need name/target/current/status (e.g., `trip_savings`, `emergency_fund_progress`).

```ts
interface GoalSummary {
  id:            string;
  name:          string;
  goalType:      string;
  status:        string;
  targetAmount:  number | null;
  currentAmount: number;
  targetDate:    string | null;
  category:      string;
}
```

### Contract C — Holding (future, Tier 4)

For `investment_allocation`. `Holding` model already exists in Prisma:

```ts
interface WorkspaceHolding {
  symbol:    string;
  name:      string;
  quantity:  number;
  price:     number;
  value:     number;       // computed: quantity × price
  currency:  string;
  accountId: string;       // which NormalizedAccount it belongs to
}
```

No schema change needed — just a new API endpoint: `GET /api/workspaces/[id]/holdings`
that returns Holding rows for accounts the workspace has FULL access to.

### Contract D — Transaction aggregates (future, Tier 5)

This is the gap. Transaction data lives on individual users' `Transaction` model.
Sharing it into a workspace raises privacy questions distinct from account sharing:

- A user might share an account as BALANCE_ONLY but not want transaction-level details visible.
- Even FULL account shares don't currently grant transaction access.

**Proposed minimal model for Tier 5 widgets:**

Rather than exposing raw transactions, expose pre-aggregated monthly summaries:
```ts
interface WorkspaceMonthlyAggregate {
  month:      string;   // "2025-01"
  income:     number;   // sum of positive transactions from shared accounts
  expenses:   number;   // sum of negative transactions from shared accounts
  netFlow:    number;   // income − expenses
  currency:   string;
}
```

This aggregate can be computed server-side and would be appropriate to show even for
BALANCE_ONLY account shares (no individual transaction detail leaks).

See Section 6 for whether this requires a schema change.

---

## 6. Minimum schema changes

### No changes needed for:

- **Tier 1 widgets** (net_worth, debt_summary, debt_breakdown, debt_payoff_calculator,
  investment_summary, accounts_overview, goals_progress): existing data contracts are sufficient.
- **Tier 2 widgets** (property_value, vehicle_value, equipment_value, trip_budget,
  emergency_fund_progress): use `WorkspaceDashboardSection.config Json?` which already exists.
  Target values live in config — no new columns needed.
- **Tier 3 widgets** (trip_savings, retirement_progress): use `WorkspaceGoal` which already
  exists, plus optional config fallback.
- **Tier 4 widgets** (investment_allocation, retirement_accounts): use `Holding` which already
  exists. Only need a new API route.

### New route needed (no schema change):

```
GET /api/workspaces/[id]/holdings
```
Returns Holding rows for accounts with FULL visibility in this workspace.
BALANCE_ONLY account shares cannot expose holdings.

### Schema change needed (Tier 5 — transaction widgets):

If `cash_flow`, `savings_rate`, and `monthly_expenses` are to be built, the cleanest approach is:

**Option A — Compute on request (no schema change)**
Query `Transaction` rows for accounts shared as FULL into the workspace, aggregate by month.
Pro: no migration. Con: expensive, requires joining across user-ownership boundaries.

**Option B — Materialized monthly summaries (new table)**
```prisma
model WorkspaceMonthlySnapshot {
  id          String @id @default(cuid())
  workspaceId String
  accountId   String    // the FinancialAccount that was aggregated
  month       String    // "2025-01"
  income      Float
  expenses    Float
  currency    String
  computedAt  DateTime

  workspace Workspace       @relation(...)
  account   FinancialAccount @relation(...)

  @@unique([workspaceId, accountId, month])
  @@index([workspaceId, month])
}
```
Pro: fast reads, privacy-safe. Con: requires a background job or webhook to keep snapshots fresh.

**Recommendation: defer Tier 5 widgets.** Build them after the activity feed is live and the transaction-sharing privacy model is defined. Use `ContextualCard` placeholders (already in place) in the meantime. The existing `config Json` field gives `cash_flow` and `savings_rate` a graceful upgrade path when ready — the widget can read a manually entered monthly income/expense from config as a temporary proxy.

---

## 7. Build order recommendation

From least to most effort, given existing infrastructure:

| Priority | Key(s) | Effort | Blocker |
|---|---|---|---|
| 1 | `property_value`, `vehicle_value`, `equipment_value`, `trip_budget`, `emergency_fund_progress` | Low — config-driven, no new data | None |
| 2 | `debt_payoff_tracker` | Low — refactor DebtCard to show per-account progress bars | None |
| 3 | `mortgage_tracker`, `auto_loan_tracker` | Low — filtered DebtCard variant | None |
| 4 | `retirement_progress`, `trip_savings` | Medium — config panel + optional goal link | None |
| 5 | `investment_allocation` | Medium — AllocationChart.tsx already exists | `/holdings` route |
| 6 | `investment_summary` | Medium — InvestmentsChart.tsx exists | `/holdings` route optional |
| 7 | `retirement_accounts` | Medium — filtered investment list | None |
| 8 | `recent_activity` | Medium — audit log query + feed UI | Activity API |
| 9 | `cash_flow`, `savings_rate`, `monthly_expenses`, `business_cash_flow` | High — transaction model needed | Privacy + data model decision |

**Deprecations (safe to do now):**
- Remove `net_worth_section` alias from SectionRegistry; rename any existing DB rows to `net_worth`.
- Remove the `isDebtWorkspace` key override hack in `SectionCard.renderBody()` once any remaining DEBT_PAYOFF workspaces with legacy `cash_flow`/`savings_rate` keys are migrated to `debt_breakdown_chart`/`debt_payoff_calculator`.
