# UI Interaction Model

*The interaction language every customer surface speaks. Binding for anyone building
or designing a new workspace, chart, panel, or drill-down. Companion:
[Space Architecture §17.6](./SPACE_ARCHITECTURE.md) (the panel/modal primitives) and
[Atlas Glass Modal doctrine](../design-system/ATLAS_GLASS_MODAL_DOCTRINE.md) (the
material rules).*

> **New here? The one rule.** In Fourth Meridian, **a visualization that represents a
> breakdown is interrogable — charts are not decoration.** A chart segment and a
> ledger row are *the same concept*: a named portion of a financial total that has
> constituents. So they share one interaction — **Preview → Browser → Detail** — and
> the constituents are reachable by clicking. If you are designing a new surface,
> know this grammar *before* you draw it: what previews, what a user can browse, what
> they inspect, and how a selection is dismissed and invalidated.

---

## 1. The interaction language — Preview → Browser → Detail

```
PREVIEW    in-workspace: a chart, or a top-N ledger. "What is the shape of this?"
   │  select a constituent (a segment, a row, a tier, a day)
   ▼
BROWSER    LEFT panel: the full, searchable set. "What am I operating in?"
   │  select one
   ▼
DETAIL     RIGHT (or BOTTOM) panel: one entity — its composition and actions.
           "Tell me more about the thing I selected."
```

- **Preview** is the workspace's own surface: a donut, a ranked bar list, a calendar
  heat-map, a tier ladder. It shows the *shape* and the *most important* constituents,
  not the whole set.
- **Browser** is the full set, opened in a **left-docked panel** ("what am I
  operating in") — searchable when the set is large (holdings, accounts, categories).
- **Detail** is one entity, opened in a **right-docked panel** (or a bottom sheet on
  mobile) — its constituents, its facts, its actions ("tell me more").

Not every surface needs all three: a chart *is* the browser for a small set, so a
segment click can open Detail directly. The rule is the *grammar*, not a mandatory
three-click path.

---

## 2. Charts are interrogable — a segment ≡ a ledger row

- **A chart segment is equivalent to a ledger row.** Both name a portion of a total
  and both have constituents. The shared seam is a single optional callback —
  `onSelect(item)` — the *same* seam a ledger row already has. There is **no**
  selection event bus, no chart-state provider, no global selection store: it is
  local `useState` in the workspace, and the caller opens the panel it already owns.
- **The chart and its detail read one authority.** A segment's total and the rows its
  detail panel shows come from the *same* grouping function, so they reconcile by
  construction — never two call sites that "group the same way."
- **No affordance may lie.** A chart is interactive *only* where a handler exists —
  the cursor is a pointer only on a selectable segment. An inert chart claims nothing
  (no pointer cursor, no hover-that-does-nothing).

---

## 3. Hover vs selection — two separate lifecycles

- **Hover is transient preview.** A hover card / tooltip appears on pointer-over and
  **must disappear when the pointer leaves**. It is never persistent.
- **Selection is persistent detail.** A click opens a panel that stays until
  dismissed.
- **They must not share state.** A click **ends the hover preview before it opens the
  panel** — a preview must never linger behind or beside the detail it spawned.
  Keyboard focus previews via `:focus-visible` (so a mouse click leaves no preview),
  while Tab still shows one.

---

## 4. Panels over modals for detail workflows

Detail work uses **panels, not modals**.

| | Panel (`components/atlas/panels`) | Modal (`OverlaySurface`) |
|---|---|---|
| Purpose | persistent contextual surface | interrupt for a bounded decision |
| Mental model | "continue working while inspecting" | "pause and complete" |
| Spatial | edge-docked; the workspace stays visible | centered; the workspace recedes |
| Use for | selected transaction/holding, filters, evidence, browse | delete, confirm, authenticate, destructive |
| Dismissal | non-destructive (scrim/Escape/close), workspace intact | often a committed choice |

**Which edge — role, not content, decides:**

- **LEFT = browse** — "pick from a set" (all holdings, all categories).
- **RIGHT = inspect** — "what is inside the one thing I selected" (a holding's detail,
  a category's transactions). A panel that renders a *list* is still *inspect* if its
  question is "what produced this number."
- **BOTTOM** — a full-width bottom sheet is the mobile form of a right/detail panel
  (Panel collapses to a bottom sheet below `sm`); on desktop it is reserved for a
  detail-over-browser "explorer" surface (e.g. a future asset explorer).
- **No modal for a detail workflow.** If a user is inspecting or drilling, they are
  *continuing to work*, not *pausing to decide* — that is a panel. Reserve modals for
  irreversible or authenticating decisions.

Panels are **presentation primitives, not ownership boundaries**: the panel family
(`Panel`, `LeftPanel`/`RightPanel`, `PanelHeader`/`Content`/`Footer`, `PanelStack`)
knows layout, animation, focus-trap, scroll-lock, and stacking — and *nothing* about
any domain. A domain composes its own detail from the slots; the primitive never
grows a `<TransactionPanel>`.

---

## 5. Selection must invalidate correctly

Selection is a **capability, not a constant** — and it goes stale, so it must be
invalidated deliberately:

- **Closing a panel clears its selection.** No stale detail survives dismissal.
- **A time change invalidates an open selection.** A slice answers a question about a
  *specific window*; when the [time anchor](./TIME_MODEL.md) moves, that question is
  *wrong*, not merely stale — the panel closes. (Mechanically: hold the slice through
  a shared hook keyed on the window; a key change clears it.)
- **Switching the grouping/axis clears the selection.** A selection id means a
  different thing on each axis (an institution vs an account id), so a carried-over
  selection would resolve to nothing.
- **Historical drill-downs may not exist — say so, don't fake it.** Because history
  is stored as pre-aggregated snapshots ([historical data](../systems/historical-data.md)),
  present-day drill-downs are nearly free but **per-entity historical breakdowns do
  not exist**. Where constituents are unavailable for a past date, *omit the
  affordance* and badge it "current classification" — never open an empty panel.

---

## 6. Before you design a new surface — the checklist

1. What is the **Preview** (the chart or top-N)? What is its one authority?
2. Is it a **composition** (interrogable) or a **ranking/scalar** (may be inert)? If a composition, wire `onSelect`.
3. What does **Browse** show, and does the set need search?
4. What does **Detail** show, and does it reconcile with the segment by reading the same authority?
5. Which **edge** — browse→LEFT, inspect→RIGHT/BOTTOM? Any modal here would be wrong unless it's a decision.
6. How does the selection **invalidate** — on close, on time change, on axis change?
7. Is any historical drill **impossible**? If so, badge it honest, don't fake it.

*Shipped exemplars to copy: Net Worth composition, Cash Flow calendar/categories,
Investments allocation, Liquidity tiers, and the metric-aware Wealth composition.*
