# Mobile Experience Audit — Customer Product Surfaces

## Scope and method

Customer surfaces only were reviewed. Platform HQ and all Platform Spaces were excluded from interaction and implementation. Authentication, registration, invitations, and beta lifecycle were not changed.

The production Space route is `/dashboard`, with the active Space resolved from the Space cookie; there is no current `/dashboard/[spaceId]` page. Deep links such as `/dashboard?tab=transactions` resolve into the shared `SpaceDashboard` and `SpaceShell`.

Browser verification used authenticated customer data at 390 × 844, 360 × 800, 768 × 1024, and 1440 × 1000. Source-level review covered the shared shell, customer workspaces, Atlas panels, charts, ledgers, settings components, and connection/import surfaces.

## Current state

The customer product already has a strong mobile foundation:

- A persistent five-destination bottom navigation replaces the desktop contextual sidebar below `lg`.
- Space workspaces use editorial ledgers rather than desktop tables.
- Atlas side panels become full-width bottom sheets with focus trapping, Escape handling, body locking, focus return, and bounded internal scrolling.
- The transaction detail sheet focuses its Close control, grows to available height, scrolls internally, and remains above the bottom navigation.
- Cash Flow and Transactions share the responsive `CalendarHeatmapGrid`; month counts collapse from multi-column desktop layouts to one/two-column mobile layouts without changing aggregation.
- Overview, Cash Flow, Wealth, Liquidity, Investments, and Debt use responsive workspace compositions rather than fixed desktop grids.
- Connections actions already stack into 48px full-width mobile controls.
- Settings use a shared URL-driven workspace rail and preserve deep links/back behavior.

The main weakness was not wholesale desktop compression. It was a set of shared edge conditions: overflowing Liquid material, undersized navigation/edit targets, clipped KPI figures, and selected tabs that could remain outside the visible rail.

## Screens audited

### Spaces

- `/dashboard/spaces`: launcher card, active/default state, Create Space entry point, public-space empty state, and mobile bottom navigation.
- Active-Space transition and `/dashboard` deep-link behavior.
- `CreateSpaceModal` structure and nested account/wallet flow composition.
- `ManageSpaceModal`: responsive FormModal frame, horizontal management tabs, General, Members, Add Accounts, Overview, and danger-flow gating.

### Space Dashboard

- `SpaceShell`, mobile identity relocation, currency/manage controls, workspace rail, contextual sidebar replacement, and bottom navigation.
- Overview / Wealth: hero figure, balance history, chart metric selector, composition, change ledger, and explanation/evidence entry point.
- Cash Flow: hero, time/trust context, period rails, activity, spending, income, insights, and shared calendar implementation. `CalendarHeatmapGrid` and aggregation logic were not changed.
- Investments: hero, balance history, holdings ledger, allocation, concentration, activity, and holding-detail panel composition.
- Liquidity: hero, ladder tiers, balance history, sources ledger, change explanation, and source detail panel.
- Debt: hero, liability ledger, payoff strip, balance history, and liability detail panel.
- Transactions: search, List/Calendar switch, time/filter/sort controls, flow filters, KPI cards, editorial transaction rows, pagination, and transaction detail bottom sheet.
- Accounts: accounts hero/ledger and account-detail panel.
- Activity: editorial timeline and event-detail panel.
- Members: hero, roster, pending invitations, invite flow, and member-detail panel.

### Settings

- Account/profile fields and inline editing.
- Security and session surfaces.
- Preferences, Notifications, and Data & Privacy routes.
- URL-driven section switching and selected-tab visibility.

### Connections

- Connections page identity/actions.
- Ready, importing, reauthentication, error, and wallet card compositions.
- Sync/freshness status, account inventory, refresh affordances, historical import entry point, and connection management modals.

## Issues ranked

### P0 — blocking

1. **Liquid cards and CTAs widened the mobile document.** The vendored Liquid canvas extends 24px beyond its host. Connections measured 392px content against a 384px viewport, creating real document-level horizontal overflow. This affected provider cards and action CTAs.

   **Implemented:** Atlas Liquid wrappers now own `min-width: 0` and clip the decorative shader at their established radius. The material remains visually intact while the document now measures exactly to the viewport.

### P1 — important

1. **Transaction KPI values were unreadable on phones.** Two-column cards reserved width for the icon and truncated values such as `-$208,811.22` and `+$268,636.00`.

   **Implemented:** mobile KPI geometry now keeps icon/title in the first row and gives the figure the full card width. At 360px, audited currency values have equal client and scroll widths—no ellipsis or clipping.

2. **Customer workspace/settings rails used 28px touch targets.** This was materially below a comfortable phone/tablet target, especially for frequent switching.

   **Implemented:** `SegmentedControl` gained an opt-in `touchOptimized` mode. Customer `SpaceShell` instances use 40px targets through tablet widths; Platform frames do not opt in and are unchanged.

3. **Selected rail destinations could remain offscreen.** Settings’ Notifications/Data & Privacy and the Space Members tab require horizontal scrolling, but changing routes did not guarantee the active item was visible.

   **Implemented:** touch-optimized rails scroll the selected segment into the nearest visible position. Notifications was verified at 360px with the rail scrolled and the full selected control visible.

4. **Settings edit buttons were 25px and unnamed.** Pencil-only controls had small hit areas and no programmatic label.

   **Implemented:** edit controls are now 40 × 40px through tablet widths and expose labels such as “Edit username.” Save and Cancel receive the same mobile touch-height treatment.

5. **Mobile Space metadata was clipped to one line.** The updated timestamp disappeared beside currency/manage controls.

   **Implemented:** opted-in customer shells allow the subtitle to use two lines. Platform shells retain their previous presentation.

6. **Space management tabs were 28px high.** These are primary controls inside a full-screen phone management flow.

   **Implemented:** Manage Space tabs now use 40px mobile/tablet targets and retain compact desktop density.

### P2 — polish

1. The time/trust context plus two period rails consume much of the first Space-dashboard viewport. The hierarchy is clear, but future work should explore a compact context summary that expands on demand without hiding trust evidence.
2. Horizontally scrollable rails have no persistent visual overflow cue. Auto-revealing the selected item solves navigation state, but a restrained edge fade could improve discoverability if standardized in Atlas.
3. The optional 2FA banner occupies substantial mobile vertical space. It is dismissible and valuable, but a future notification-density pass could use a more compact phone treatment.
4. Calendar tooltips support hover and keyboard focus; a phone relies on day selection opening the transaction slice. Future usability testing should verify that this two-step model is obvious without adding aggregation changes.
5. Some secondary connection/import actions remain 26–32px high. They are not primary actions, but should converge on the same Atlas touch-target contract in a subsequent component pass.
6. Pagination controls remain compact. They are usable, but a phone-first “Previous / Next” treatment could reduce precision demands without changing pagination semantics.

## Recommended fixes and implementation plan

### Completed in this pass

1. Contain decorative Liquid material inside its responsive host.
2. Add opt-in customer touch ergonomics and active-item visibility to the shared segmented-control primitive.
3. Enable that contract from customer Space, Settings, and Connections shells only.
4. Recompose transaction KPIs for readable mobile figures.
5. Improve Settings inline-edit accessibility and touch targets.
6. Improve Manage Space tab ergonomics.

### Follow-up plan

1. Define one Atlas `touchTarget` contract for secondary icon buttons, pagination, filters, and modal close controls.
2. Prototype a collapsible Space context summary and test whether it improves time-to-financial-picture without weakening provenance visibility.
3. Add automated responsive assertions for document overflow and selected segmented-control visibility at 360, 390, 768, and 1440 widths.
4. Add focused mobile interaction tests for nested panels/modals and virtual-keyboard resizing where a real device runner is available.
5. Validate calendar day selection and chart comprehension with customer usability sessions; preserve `CalendarHeatmapGrid` and financial aggregation authority.

## Implementation rules

- Keep responsive behavior in Atlas or owning domain components, not route-specific patches.
- Opt customer surfaces into shared changes when a primitive is also used by excluded Platform surfaces.
- Preserve every financial calculation, data loader, route contract, and deep link.
- Never hide financial evidence, important figures, or unavailable states to make a layout fit.
- Prefer editorial ledgers and contextual detail sheets over desktop tables or unconstrained horizontal scrolling.
- Maintain bottom safe-area padding and ensure fixed navigation never owns content scroll.
- Keep reduced-motion, focus trap, Escape, focus return, and internal-scroll behavior in shared overlay primitives.

## Verification results

- 390 × 844 iPhone: Spaces, dashboard, Transactions, Cash Flow, Investments, Settings, Connections, transaction sheet, and Manage Space checked.
- 360 × 800 Android: Transactions and Settings checked after implementation; no document overflow, 40px customer rails, selected tab visible, and KPI figures untruncated.
- 768 × 1024 tablet: no document overflow; customer rail targets remain 40px; bottom navigation remains the intended sidebar replacement.
- 1440 × 1000 desktop: no document overflow; contextual sidebar returns and bottom navigation is hidden.
- Atlas transaction panel: focus moves to Close; loaded sheet is full width, height-capped to the viewport, and contains an `overflow-y: auto` body.
- Browser console: no warnings or errors on audited routes.
- `npx tsc --noEmit`: passed after the implemented changes.
- Changed-file ESLint: passed with zero warnings.
