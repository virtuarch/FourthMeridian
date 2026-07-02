# Workspace Type Architecture Spec

> **North star:** A workspace is a composition of reusable widget slots, not a hardcoded dashboard.
> Every section key maps to a widget component registered in `SectionRegistry`. Tab layout, default
> slots, and enabled/disabled state live in `WorkspaceDashboardSection` rows seeded by
> `getPresetsForCategory`. Owners can toggle, reorder, and eventually add/remove widget slots
> without any code changes.

---

## Conventions

| Term | Meaning |
|---|---|
| **Section key** | Stable machine-readable string stored in `WorkspaceDashboardSection.key` |
| **Widget** | React component registered in `SectionRegistry` that consumes a section key |
| **Required dataset** | Data the widget must have to render anything useful |
| **Optional widget** | Section that is seeded `enabled: false`; owner must explicitly turn it on |
| **Tab** | `WorkspaceDashboardTab` enum value (OVERVIEW · GOALS · ACCOUNTS · DEBT · INVESTMENTS · RETIREMENT · ACTIVITY · SETTINGS) |

Role abbreviations: **O** = Owner · **A** = Admin · **M** = Member · **V** = Viewer

---

## Universal sections (every workspace)

These are injected by `getPresetsForCategory` on top of all category presets.

| Key | Label | Tab | Notes |
|---|---|---|---|
| `goals_progress` | Goals | GOALS | Goal list; GoalType scopes what is shown |
| `accounts_overview` | Accounts | ACCOUNTS | Normalized `NormalizedAccount[]` from `/api/workspaces/[id]/accounts` |
| `recent_activity` | Recent Activity | ACTIVITY | Audit log feed scoped to workspace |

---

## Category specs

### PERSONAL

> Solo dashboard. Owner shares into their own personal workspace; no other members.

**Default tabs:** OVERVIEW · GOALS · ACCOUNTS · DEBT · INVESTMENTS · ACTIVITY

**Default widgets (enabled):**

| Key | Label | Tab |
|---|---|---|
| `net_worth` | Net Worth | OVERVIEW |
| `cash_flow` | Cash Flow | OVERVIEW |
| `savings_rate` | Savings Rate | OVERVIEW |
| `debt_summary` | Debt Summary | DEBT |
| `investment_summary` | Portfolio Summary | INVESTMENTS |

**Required datasets:** Owner's own `FinancialAccount` rows (no sharing needed).

**Optional widgets (seeded disabled):**

| Key | Label | Tab |
|---|---|---|
| `investment_allocation` | Asset Allocation | INVESTMENTS |
| `retirement_progress` | Retirement Progress | RETIREMENT |
| `debt_payoff_tracker` | Payoff Tracker | DEBT |
| `emergency_fund_progress` | Emergency Fund | OVERVIEW |

**Permissions model:**
- Only the OWNER role is meaningful here; personal workspaces never have other members.
- Account sharing UI is hidden for personal workspaces.
- SETTINGS tab visible to OWNER only.

**Drag/drop (future):**
- Full reorder within each tab.
- Owner can add optional widgets from a picker in SETTINGS.

---

### HOUSEHOLD

> Two or more adults sharing finances (partners, housemates). Most common shared workspace type.

**Default tabs:** OVERVIEW · GOALS · ACCOUNTS · DEBT · ACTIVITY

**Default widgets (enabled):**

| Key | Label | Tab |
|---|---|---|
| `net_worth` | Net Worth | OVERVIEW |
| `cash_flow` | Cash Flow | OVERVIEW |
| `savings_rate` | Savings Rate | OVERVIEW |
| `debt_summary` | Debt Summary | DEBT |
| `debt_payoff_tracker` | Payoff Tracker | DEBT |

**Required datasets:** ≥1 member with at least one `FULL` or `BALANCE_ONLY` account share into this workspace.

**Optional widgets:**

| Key | Label | Tab |
|---|---|---|
| `investment_summary` | Portfolio Summary | INVESTMENTS |
| `investment_allocation` | Asset Allocation | INVESTMENTS |
| `retirement_progress` | Retirement Progress | RETIREMENT |
| `emergency_fund_progress` | Emergency Fund | OVERVIEW |
| `monthly_expenses` | Monthly Expenses | OVERVIEW |

**Permissions model:**

| Action | O | A | M | V |
|---|:---:|:---:|:---:|:---:|
| View shared accounts | ✓ | ✓ | ✓ | ✓ |
| Share own account into workspace | ✓ | ✓ | ✓ | — |
| Revoke own account share | ✓ | ✓ | ✓ | — |
| Invite members | ✓ | ✓ | — | — |
| Remove members | ✓ | ✓ | — | — |
| Change member roles | ✓ | — | — | — |
| Toggle/reorder widgets | ✓ | ✓ | — | — |
| Delete workspace | ✓ | — | — | — |

**Drag/drop (future):**
- OWNER and ADMIN can reorder and toggle widgets.
- MEMBER/VIEWER sees whatever layout the admins set.
- Per-member layout overrides (personal column order) considered v2.

---

### FAMILY

> Multi-generational or extended-family group. May include children or dependents. More varied financial complexity than HOUSEHOLD.

**Default tabs:** OVERVIEW · GOALS · ACCOUNTS · DEBT · ACTIVITY

**Default widgets (enabled):**

| Key | Label | Tab |
|---|---|---|
| `net_worth` | Net Worth | OVERVIEW |
| `cash_flow` | Cash Flow | OVERVIEW |
| `savings_rate` | Savings Rate | OVERVIEW |
| `debt_summary` | Debt Summary | DEBT |

**Required datasets:** Same as HOUSEHOLD.

**Optional widgets:**

| Key | Label | Tab |
|---|---|---|
| `debt_payoff_tracker` | Payoff Tracker | DEBT |
| `investment_summary` | Portfolio Summary | INVESTMENTS |
| `retirement_progress` | Retirement Progress | RETIREMENT |
| `emergency_fund_progress` | Emergency Fund | OVERVIEW |
| `goals_by_member` | Goals by Member | GOALS |

**Permissions model:** Same role matrix as HOUSEHOLD. VIEWER role useful for giving adult children read-only access to family finances.

**Drag/drop (future):** Same as HOUSEHOLD. "Goals by member" widget should support filtering by workspace member.

---

### BUSINESS

> LLC, sole prop, partnership, side hustle. Separates business finances from personal.

**Default tabs:** OVERVIEW · ACCOUNTS · DEBT · INVESTMENTS · ACTIVITY

**Default widgets (enabled):**

| Key | Label | Tab |
|---|---|---|
| `business_cash_flow` | Cash Flow | OVERVIEW |
| `business_accounts` | Business Accounts | ACCOUNTS |
| `debt_summary` | Debt Summary | DEBT |
| `investment_summary` | Portfolio Summary | INVESTMENTS |

**Required datasets:** At least one checking, savings, or business account shared FULL (BALANCE_ONLY is low-value for business contexts).

**Optional widgets:**

| Key | Label | Tab |
|---|---|---|
| `net_worth` | Net Worth | OVERVIEW |
| `debt_payoff_tracker` | Payoff Tracker | DEBT |
| `investment_allocation` | Asset Allocation | INVESTMENTS |
| `monthly_expenses` | Monthly Expenses | OVERVIEW |

**Permissions model:**

| Action | O | A | M | V |
|---|:---:|:---:|:---:|:---:|
| View accounts | ✓ | ✓ | ✓ | ✓ |
| Share accounts | ✓ | ✓ | — | — |
| Invite members | ✓ | ✓ | — | — |
| Remove members | ✓ | ✓ | — | — |
| Toggle widgets | ✓ | ✓ | — | — |

> MEMBER role is intentionally more restricted for business workspaces — employees shouldn't be able to share accounts into the workspace without explicit promotion.

**Drag/drop (future):** OWNER/ADMIN layout control. Future: link to external accounting export (QuickBooks, Wave) as an optional widget.

---

### PROPERTY

> Single real estate asset: primary home, rental, vacation property.

**Default tabs:** OVERVIEW · ACCOUNTS · DEBT · ACTIVITY

**Default widgets (enabled):**

| Key | Label | Tab |
|---|---|---|
| `property_value` | Property Value | OVERVIEW |
| `mortgage_tracker` | Mortgage | DEBT |
| `cash_flow` | Cash Flow | OVERVIEW |

**Required datasets:** A `debt` account with `debtSubtype: "mortgage"` shared FULL into this workspace. Property value can be a manually tracked asset account.

**Optional widgets:**

| Key | Label | Tab |
|---|---|---|
| `debt_payoff_tracker` | Payoff Tracker | DEBT |
| `net_worth` | Net Worth | OVERVIEW |
| `rental_income` | Rental Income | OVERVIEW |
| `maintenance_log` | Maintenance Log | OVERVIEW |

**Permissions model:**
- Useful for co-owners (spouses, partners, investors). Role matrix same as HOUSEHOLD.
- VIEWER useful for property managers who need read-only visibility.

**Drag/drop (future):** `property_value` widget should support manual value entry + Zillow/Redfin estimate lookup (v2 data source). Reorder within OVERVIEW/DEBT tabs.

---

### VEHICLE

> Single vehicle: car, motorcycle, boat, RV.

**Default tabs:** OVERVIEW · DEBT · ACTIVITY

**Default widgets (enabled):**

| Key | Label | Tab |
|---|---|---|
| `vehicle_value` | Vehicle Value | OVERVIEW |
| `auto_loan_tracker` | Auto Loan | DEBT |
| `cash_flow` | Cash Flow | OVERVIEW |

**Required datasets:** A `debt` account with `debtSubtype: "auto_loan"` shared FULL. Vehicle value can be a manually tracked asset.

**Optional widgets:**

| Key | Label | Tab |
|---|---|---|
| `debt_payoff_tracker` | Payoff Tracker | DEBT |
| `maintenance_log` | Maintenance Log | OVERVIEW |
| `insurance_tracker` | Insurance | OVERVIEW |

**Permissions model:** Typically single-owner or shared with partner. Same role matrix as HOUSEHOLD but MEMBER/ADMIN rarely needed.

**Drag/drop (future):** `vehicle_value` widget should support KBB/Edmunds estimate integration as data source option.

---

### TRIP

> Time-boxed savings and budget for a specific trip or vacation.

**Default tabs:** OVERVIEW · GOALS · ACCOUNTS · ACTIVITY

**Default widgets (enabled):**

| Key | Label | Tab |
|---|---|---|
| `trip_budget` | Trip Budget | OVERVIEW |
| `trip_savings` | Trip Savings | OVERVIEW |
| `cash_flow` | Cash Flow | OVERVIEW |

**Required datasets:** A savings or checking account shared into the workspace. A `WorkspaceGoal` with `GoalType.SAVINGS` and a target amount.

**Optional widgets:**

| Key | Label | Tab |
|---|---|---|
| `goals_progress` | Goal Progress | GOALS |
| `expense_categories` | Expense Breakdown | OVERVIEW |
| `trip_countdown` | Countdown | OVERVIEW |

**Permissions model:** Usually 2–5 people splitting trip costs. All MEMBER-level members should be able to share accounts and track spending. Role matrix same as HOUSEHOLD.

**Drag/drop (future):** `trip_countdown` widget configurable with departure date. `trip_budget` widget supports category budget lines (flights, lodging, food, activities).

---

### INVESTMENT

> Pure investment portfolio tracker. Focus on performance, allocation, and growth.

**Default tabs:** OVERVIEW · INVESTMENTS · ACCOUNTS · GOALS · ACTIVITY

**Default widgets (enabled):**

| Key | Label | Tab |
|---|---|---|
| `investment_summary` | Portfolio Summary | INVESTMENTS |
| `investment_allocation` | Asset Allocation | INVESTMENTS |
| `net_worth` | Net Worth | OVERVIEW |
| `cash_flow` | Cash Flow | OVERVIEW |

**Required datasets:** At least one `investment` account shared FULL into the workspace.

**Optional widgets:**

| Key | Label | Tab |
|---|---|---|
| `retirement_progress` | Retirement Progress | RETIREMENT |
| `retirement_accounts` | Retirement Accounts | RETIREMENT |
| `savings_rate` | Savings Rate | OVERVIEW |
| `goals_progress` | Goals | GOALS |

**Permissions model:**

| Action | O | A | M | V |
|---|:---:|:---:|:---:|:---:|
| View portfolio | ✓ | ✓ | ✓ | ✓ |
| Share accounts | ✓ | ✓ | ✓ | — |
| Invite members | ✓ | ✓ | — | — |

> Investment clubs: all members typically share. Advisory: advisor is ADMIN, clients are MEMBER or VIEWER.

**Drag/drop (future):** `investment_allocation` widget supports custom grouping (by sector, geography, asset class). `investment_summary` supports time-range picker.

---

### RETIREMENT

> Long-horizon retirement planning. Focus on projections, withdrawal rate, and account tracking.

**Default tabs:** OVERVIEW · RETIREMENT · INVESTMENTS · GOALS · ACTIVITY

**Default widgets (enabled):**

| Key | Label | Tab |
|---|---|---|
| `retirement_progress` | Retirement Progress | RETIREMENT |
| `retirement_accounts` | Retirement Accounts | RETIREMENT |
| `investment_allocation` | Asset Allocation | INVESTMENTS |
| `net_worth` | Net Worth | OVERVIEW |

**Required datasets:** At least one `investment` account with retirement flag (IRA, 401k, Roth) or any investment account shared FULL.

**Optional widgets:**

| Key | Label | Tab |
|---|---|---|
| `investment_summary` | Portfolio Summary | INVESTMENTS |
| `savings_rate` | Savings Rate | OVERVIEW |
| `fire_calculator` | FIRE Calculator | OVERVIEW |
| `social_security_estimate` | SS Estimate | RETIREMENT |
| `withdrawal_rate` | Withdrawal Rate | RETIREMENT |

**Permissions model:** Usually single owner or shared with partner. VIEWER useful for financial advisor access.

**Drag/drop (future):** `retirement_progress` widget configurable: target retirement age, annual spending target, expected return rate. `fire_calculator` as a standalone interactive widget.

---

### DEBT_PAYOFF

> Dedicated debt elimination workspace. Avalanche, snowball, or custom strategy.

**Default tabs:** OVERVIEW · DEBT · ACCOUNTS · GOALS · ACTIVITY

**Default widgets (enabled):**

| Key | Label | Tab |
|---|---|---|
| `debt_breakdown_chart` | Debt Breakdown | OVERVIEW |
| `debt_payoff_calculator` | Payoff Planner | OVERVIEW |
| `debt_summary` | Debt Summary | DEBT |
| `debt_payoff_tracker` | Payoff Tracker | DEBT |

**Required datasets:** ≥1 `debt` account shared FULL (interest rate and minimum payment required for strategy calculations).

**Optional widgets:**

| Key | Label | Tab |
|---|---|---|
| `cash_flow` | Cash Flow | OVERVIEW |
| `savings_rate` | Savings Rate | OVERVIEW |
| `net_worth` | Net Worth | OVERVIEW |
| `goals_progress` | Goals | GOALS |

**Permissions model:** Usually single-owner or shared with partner. Role matrix same as HOUSEHOLD.

> **Important:** BALANCE_ONLY shares are nearly useless here — the payoff calculator requires `interestRate` and `minimumPayment`. The account share UI for DEBT_PAYOFF workspaces should strongly suggest FULL visibility and warn when BALANCE_ONLY is selected.

**Drag/drop (future):** `debt_payoff_calculator` widget supports strategy selector (avalanche/snowball/custom order). `debt_breakdown_chart` supports donut vs. bar toggle.

---

### EMERGENCY_FUND

> Single-purpose: build and protect an emergency savings buffer.

**Default tabs:** OVERVIEW · GOALS · ACCOUNTS · ACTIVITY

**Default widgets (enabled):**

| Key | Label | Tab |
|---|---|---|
| `emergency_fund_progress` | Emergency Fund | OVERVIEW |
| `monthly_expenses` | Monthly Expenses | OVERVIEW |
| `savings_rate` | Savings Rate | OVERVIEW |
| `cash_flow` | Cash Flow | OVERVIEW |

**Required datasets:** At least one savings or checking account shared FULL. A `WorkspaceGoal` with a target amount (ideally 3–6× monthly expenses).

**Optional widgets:**

| Key | Label | Tab |
|---|---|---|
| `goals_progress` | Goals | GOALS |
| `net_worth` | Net Worth | OVERVIEW |

**Permissions model:** Usually single-owner or shared with partner. No special role requirements beyond HOUSEHOLD defaults.

**Drag/drop (future):** `emergency_fund_progress` widget configurable: target months of expenses (3/6/12). Auto-computes target from `monthly_expenses` widget if present.

---

### EQUIPMENT

> Business or personal equipment: tools, machinery, tech gear, studio equipment.

**Default tabs:** OVERVIEW · ACCOUNTS · DEBT · ACTIVITY

**Default widgets (enabled):**

| Key | Label | Tab |
|---|---|---|
| `equipment_value` | Equipment Value | OVERVIEW |
| `debt_summary` | Debt Summary | DEBT |
| `cash_flow` | Cash Flow | OVERVIEW |

**Required datasets:** Asset account(s) representing equipment value. Optional debt account for financing.

**Optional widgets:**

| Key | Label | Tab |
|---|---|---|
| `debt_payoff_tracker` | Payoff Tracker | DEBT |
| `maintenance_log` | Maintenance Log | OVERVIEW |
| `depreciation_tracker` | Depreciation | OVERVIEW |

**Permissions model:** Business context — same restrictions as BUSINESS for account sharing. VIEWER useful for bookkeepers.

**Drag/drop (future):** `depreciation_tracker` widget supports straight-line and declining-balance methods. Useful for tax planning.

---

### GOAL (legacy)

> Legacy category. Predates `WorkspaceGoal` model. Treat as a generic workspace with goal focus.

**Default tabs:** OVERVIEW · GOALS · ACCOUNTS · ACTIVITY

**Default widgets (enabled):**

| Key | Label | Tab |
|---|---|---|
| `net_worth` | Net Worth | OVERVIEW |
| `cash_flow` | Cash Flow | OVERVIEW |

**Required datasets:** Any account share.

**Permissions model:** Same as HOUSEHOLD.

> **Migration note:** New workspaces should not use GOAL. During workspace creation, GOAL is not offered as a category option — existing rows are read-only legacy. A future migration could offer to convert GOAL workspaces to EMERGENCY_FUND, DEBT_PAYOFF, or RETIREMENT based on their existing goal types.

---

### CUSTOM

> Blank slate. No default widgets beyond the universal trio.

**Default tabs:** OVERVIEW · GOALS · ACCOUNTS · ACTIVITY

**Default widgets (enabled):** None (universal sections only — goals, accounts, activity).

**Required datasets:** None — owner defines what to show.

**Optional widgets:** All registered widgets in `SectionRegistry` are available to add.

**Permissions model:** Same as HOUSEHOLD. Since there are no locked defaults, ADMIN role becomes more important — they must actively configure the dashboard rather than inheriting a meaningful preset.

**Drag/drop (future):** Full widget picker. CUSTOM is the primary testing ground for the drag/drop widget runtime before it rolls out to other categories.

---

### OTHER

> General-purpose fallback. Minimal preset, functions like a lightweight PERSONAL.

**Default tabs:** OVERVIEW · GOALS · ACCOUNTS · ACTIVITY

**Default widgets (enabled):**

| Key | Label | Tab |
|---|---|---|
| `net_worth` | Net Worth | OVERVIEW |
| `cash_flow` | Cash Flow | OVERVIEW |

**Required datasets:** Any account share.

**Permissions model:** Same as HOUSEHOLD.

---

## Cross-cutting: Permissions model summary

The role system is uniform across all workspace types. Category-specific notes above call out meaningful deviations.

### Default role matrix

| Action | OWNER | ADMIN | MEMBER | VIEWER |
|---|:---:|:---:|:---:|:---:|
| Read workspace data | ✓ | ✓ | ✓ | ✓ |
| Share own accounts | ✓ | ✓ | ✓ | — |
| Revoke own shares | ✓ | ✓ | ✓ | — |
| View account details (FULL) | ✓ | ✓ | ✓ | ✓ |
| View account balances (BALANCE_ONLY) | ✓ | ✓ | ✓ | ✓ |
| Toggle/reorder widgets | ✓ | ✓ | — | — |
| Create/edit goals | ✓ | ✓ | ✓ | — |
| Invite members | ✓ | ✓ | — | — |
| Revoke invites | ✓ | ✓ | — | — |
| Remove members | ✓ | ✓ | — | — |
| Change member roles | ✓ | — | — | — |
| Rename workspace | ✓ | ✓ | — | — |
| Delete workspace | ✓ | — | — | — |

### Restricted-sharing categories

For BUSINESS and EQUIPMENT workspaces, MEMBER-level account sharing is intentionally blocked (MEMBER cannot share accounts into the workspace). Only OWNER and ADMIN can share. The UI should reflect this by hiding the "Share Account" button for MEMBER-role users in these workspace types. This can be enforced via a `restrictedSharing: boolean` flag in `getPresetsForCategory` metadata rather than a new role.

---

## Cross-cutting: Future drag/drop behavior

### Runtime model

```
WorkspaceDashboardSection
  key:     string          ← widget identity
  tab:     Tab             ← slot grouping
  order:   int             ← position within tab
  enabled: boolean         ← visible or hidden
  config:  JSON            ← widget-specific settings (target, date range, strategy, etc.)
```

The `SectionRegistry` maps `key → React component`. The dashboard loops over enabled sections ordered by `(tab, order)` and renders each widget. No hardcoded layout exists in component code.

### Drag/drop phases

**Phase 1 — Toggle (current):** OWNER/ADMIN can enable/disable sections via the SETTINGS tab toggle list. Order is fixed per preset. Already implemented via `WorkspaceDashboardSection.enabled`.

**Phase 2 — Reorder:** Drag handles within a tab. PATCH `/api/workspaces/[id]/sections/reorder` updates `order` values in a transaction. UI: `@dnd-kit/sortable` within each tab panel.

**Phase 3 — Widget picker:** A "+ Add Widget" button opens a picker showing all registered `SectionRegistry` keys not yet present in the workspace. Creates new `WorkspaceDashboardSection` rows. Each widget declares its required datasets in a `widgetMeta` export; the picker shows a warning when required data isn't shared.

**Phase 4 — Config panel:** Right-click or gear icon on a widget opens a config drawer. Widget-specific settings (retirement age, debt strategy, months of expenses, time range) write to `WorkspaceDashboardSection.config` as JSON. Widgets read `section.config` from their render props.

**Phase 5 — Cross-tab move:** Drag a widget from one tab to another (e.g., move `debt_payoff_tracker` from DEBT to OVERVIEW). The PATCH reorder endpoint already accepts a new `tab` value alongside `order`. UI: cross-tab drag with tab highlight on hover.

**Constraints:**
- Universal sections (`goals_progress`, `accounts_overview`, `recent_activity`) cannot be removed — only disabled.
- MEMBER and VIEWER roles see the layout set by OWNER/ADMIN; they cannot drag or configure.
- Per-member layout overrides are out of scope until Phase 5 is stable.

---

## Widget registry reference

All registered section keys as of this spec, with their minimum required account type:

| Section key | Widget | Min account type |
|---|---|---|
| `net_worth` | Net Worth card | any |
| `cash_flow` | Cash Flow chart | checking or savings |
| `savings_rate` | Savings Rate gauge | checking or savings |
| `debt_summary` | Debt Summary card | debt (FULL) |
| `debt_payoff_tracker` | Payoff Tracker | debt (FULL) |
| `debt_breakdown_chart` | Debt Breakdown donut | debt (FULL) |
| `debt_payoff_calculator` | Payoff Planner | debt (FULL) with interestRate |
| `mortgage_tracker` | Mortgage progress | debt/mortgage (FULL) |
| `auto_loan_tracker` | Auto Loan progress | debt/auto_loan (FULL) |
| `investment_summary` | Portfolio Summary | investment (FULL) |
| `investment_allocation` | Asset Allocation pie | investment (FULL) |
| `retirement_progress` | Retirement Progress | investment (FULL) |
| `retirement_accounts` | Retirement Accounts list | investment (FULL) |
| `emergency_fund_progress` | EF Progress bar | savings (FULL or BALANCE_ONLY) |
| `monthly_expenses` | Monthly Expenses | checking (FULL) |
| `property_value` | Property Value | asset account |
| `vehicle_value` | Vehicle Value | asset account |
| `trip_budget` | Trip Budget | any |
| `trip_savings` | Trip Savings progress | savings |
| `business_cash_flow` | Business Cash Flow | checking (FULL) |
| `business_accounts` | Business Accounts list | any |
| `equipment_value` | Equipment Value | asset account |
| `goals_progress` | Goals list | none (goal records) |
| `accounts_overview` | Accounts list | any |
| `recent_activity` | Activity feed | none (audit log) |

> Widgets without an account requirement render from `WorkspaceGoal` or `AuditLog` records directly.
> The `widgetMeta` export (Phase 3) will formalize this table as machine-readable constraints.
