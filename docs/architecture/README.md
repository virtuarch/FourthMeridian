# Architecture — the binding doctrine

This folder holds the **rules that bind the code** — the "what it is and why."
Everything here is binding architectural law, verified against the code and (mostly)
enforced by tests. If a doc here and the code disagree, the code wins and the doc is
wrong; fix the doc. For what is true *right now* (version, active work, blockers),
read [`/STATUS.md`](../../STATUS.md).

## Read in this order

A new engineer or founder should read these top to bottom and come away able to make
architectural changes without violating existing doctrine.

1. **[FOURTH_MERIDIAN_DOCTRINE.md](./FOURTH_MERIDIAN_DOCTRINE.md)** — start here. The
   reader's guide: what Fourth Meridian is, where truth lives, who may do what, how
   the pieces fit, and why. It links out to everything below.
2. **[FINANCIAL_TRUTH_SPINE.md](./FINANCIAL_TRUTH_SPINE.md)** — the most important
   engineering document. One authoritative model · one semantic layer · one
   aggregation path · many consumers. The 14 financial authorities and where each
   truth lives. *Read before touching any financial number.*
3. **[SPACE_ARCHITECTURE.md](./SPACE_ARCHITECTURE.md)** — what a Space is (and is
   not), the Shell → PerspectiveShell → Workspace hierarchy, Perspectives, the
   workspace contract, and the dashboard-as-composition-root rule.
4. **[SECURITY_MODEL.md](./SECURITY_MODEL.md)** — the three authorization axes
   (Customer · Operator · Emergency), the per-account visibility tiers, and where
   authorization is enforced (and why hiding UI is not security).
5. **[TIME_MODEL.md](./TIME_MODEL.md)** — the `asOf` anchor, presets as backward
   windows, TimelineLens intents, and why every Perspective shares one time model.
6. **[UI_INTERACTION_MODEL.md](./UI_INTERACTION_MODEL.md)** — Preview → Browser →
   Detail, chart interrogability, panels over modals, and selection invalidation.
7. **[SPACE_MOUNT_DOCTRINE.md](./SPACE_MOUNT_DOCTRINE.md)** — the mount boundary: what
   the shared `SpaceMountContext` owns (identity · nav · shell config), what stays a
   workspace loader, the hydration allowlist, and why finance/platform load differently.

## Where to go when you change a feature

| I am changing… | Read first |
|---|---|
| any financial calculation | FINANCIAL_TRUTH_SPINE + the relevant [systems/](../systems/) doc |
| a workspace, panel, or dashboard | SPACE_ARCHITECTURE |
| the /dashboard mount, mount context, or initial hydration | SPACE_MOUNT_DOCTRINE |
| a chart, drill-down, or detail surface | UI_INTERACTION_MODEL |
| anything time-windowed (asOf/compareTo) | TIME_MODEL |
| a route, API, or who-can-see-what | SECURITY_MODEL |
| an AI feature | [systems/ai-foundation.md](../systems/ai-foundation.md) (AI is a consumer, never an authority) |

## The rest of the tree

- **[../systems/](../systems/)** — subsystem reference ("how each part works"): transactions, investments, wealth, cash-flow, liquidity, debt, connections, money-and-fx, historical-data, ai-foundation, platform-operations.
- **[../decisions/](../decisions/)** — ADRs: the decisions already made, and the alternatives rejected. Do not revisit a decision here without a new ADR.
- **[../operations/](../operations/)** — runbooks, deployment, incident response, admin operations, production readiness.
- **[../design-system/](../design-system/)** — the Atlas material/glass/modal design authority.
- **[../archive/](../archive/)** — historical decision context only (security reviews, frozen baselines, rejected proposals). Small by design.

## Historical decision records (in this folder)

- **[PHASE_2_DECISION_MATRIX.md](../decisions/PHASE_2_DECISION_MATRIX.md)** — the immutable D1–D14 decision record.
- **[PHASE_2_DOCTRINE.md](../archive/completed-plans/PHASE_2_DOCTRINE.md)** / **[PHASE_2_ARCHITECTURE_FREEZE.md](../archive/completed-plans/PHASE_2_ARCHITECTURE_FREEZE.md)** — the Phase-2 convergence closure record and frozen baseline (archived).
