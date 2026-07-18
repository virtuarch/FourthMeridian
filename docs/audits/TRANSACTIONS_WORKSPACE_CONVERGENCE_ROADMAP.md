# Transactions Workspace Convergence Roadmap (Read-Only Investigation)

**Subject:** Convergence of the production Transactions surface onto the prototype
experience (`prototype/prototype-claude/components/workspaces/Transactions.tsx`).
**Date:** 2026-07-18 · **Branch:** `feature/v2.5-spaces-completion`
**Scope:** Investigation only. No implementation, no refactor, no commit.

**Target direction:**

```
Transaction ledger
    ↓
RightPanel detail
    ↓
Facts · Relationships · AI explanations (future)
```

**Do NOT modify (hard fences):** the flow classifier, transaction semantics,
`FlowType`, the economic fold. **Preserve:** the calendar heatmap setup.

---

## Headline verdict

> *How much of the target is presentation, and how much needs new backend?*

**The ledger → RightPanel → Facts → Relationships spine is ~entirely
presentation-only.** Every data contract it needs already exists and is **mature**:
the read authority, the `TransactionDetail` DTO, the deterministic relationship
resolver (pending↔posted, duplicate, owned-account transfer), the classifier, the
economic fold, and the Atlas panel primitives. The convergence is a **reshell** —
re-hosting a modal renderer inside a `RightPanel` and lifting an already-built
client-side filter/search stack into a workspace shell.

**Only the fourth stage — "AI explanations (future)" — is net-new backend work**,
and it is explicitly a **v2.6** initiative fenced off by the current AI convergence
doctrine ("we omit, we do not fabricate"). Two *relationship* enrichments
(`refundCandidate`, recurring groups) are also backend and out of scope for a
presentation pass.

The correct build order therefore front-loads presentation (fast, zero-risk, ships
the whole prototype shape minus AI), reserves the AI section as a **render-only-when-data
SLOT** (the established convergence pattern — see the Daily Brief / Space Launcher
work), and lists the backend as a clearly-separated future track.

---

## What already exists (the convergence is standing on mature ground)

| Capability | Authority | Maturity |
|---|---|---|
| Transaction storage + read | `lib/data/transactions.ts` (`getTransactions`, `getTransactionDetail`) | **Mature** |
| List-row DTO | `types/index.ts` `Transaction` (L148) | **Mature** |
| Detail DTO | `types/index.ts` `TransactionDetail` (L279) | **Mature** |
| Detail section projection | `lib/transactions/detail-sections.ts` (`buildTransactionDetailSections`) — presentation-agnostic | **Mature** |
| Flow classifier v4 | `lib/transactions/flow-classifier.ts` — **FENCED, do not touch** | **Mature** |
| Economic fold | `lib/transactions/cash-flow.ts` (`foldEconomicRow`, `clampEconomicSpend`) — **FENCED** | **Mature** |
| FlowType + predicates | `schema.prisma` enum + `lib/transactions/flow-predicates.ts` — **FENCED** | **Mature** |
| Merchant Intelligence | `lib/transactions/merchant-*` (resolve/write/merge/corrections) | **Mature** |
| Relationship resolver: pending↔posted, duplicate | `lib/transactions/RelationshipResolver.ts` | **Mature** |
| Relationship resolver: transfer candidate | `RelationshipResolver.ts` + `transfer-resolution.ts` (deterministic, owned-account) | **Mature** |
| Filters / search / sort / group | `components/dashboard/widgets/SpaceTransactionsPanel.tsx` + `transactions/TransactionsFilterOverlay.tsx` + `transactions-filter-constants.ts` | **Mature** (client-side, component-local state) |
| Aggregate slice drill | `components/space/widgets/TransactionSliceDrawer.tsx` (modal, data-less) | **Mature** |
| Atlas panel primitives | `components/atlas/panels/` (`RightPanel`, `LeftPanel`, `PanelContent`, `PanelHeader`, `WorkspaceLayout`, `PanelStack`) | **Mature** |
| Ledger → RightPanel idiom (reference) | `components/space/widgets/cashflow/CashFlowCategoryLedger.tsx` + `CashFlowCategoryDetail.tsx` | **Mature** |
| URL-driven detail opener | `components/transactions/useTransactionDrawer.ts` (`useOpenTransaction`, `?transaction=<id>`) | **Mature** |

**Gaps / backend-only:**

| Capability | Status | Track |
|---|---|---|
| Relationship resolver: **refundCandidate** | Stub (reserved `null`) | v2.5.5 / TI — out of scope |
| **Recurring / subscription grouping** | Absent | Backend — out of scope |
| **Per-transaction AI explanation** | Does not exist | **v2.6** |
| `AnswerCard` structured slots (`facts/evidence/actions/relatedEntities`) | Typed `never[]`, inert | **v2.6** |
| Conversation persistence (`conversationId`) | Not built | v2.6a (AI-5) |
| Model-initiated actions / tool-calling | Not built | v2.6b |

---

## The prototype target, concretely

`prototype/prototype-claude/components/workspaces/Transactions.tsx` — "a ledger you
can actually read," a reflowing day-grouped list, **not a table at any width**. Its
structure, and the production mapping:

1. **Two figures, not six** (Money in / Money out, transfers excluded) + a `TimeBar`
   on the figures' baseline. → production `Figure` / editorial header + existing
   window authority.
2. **Calendar heatmap** ("the temporal spine," 13 weeks, honesty vocabulary). →
   **PRESERVE** existing `TransactionsCalendarHeatmap.tsx` / Cash Flow
   `CalendarHeatmapGrid`. This is a fence, per instruction.
3. **Activity** — filter pills (All / Spending / Income / Transfers), transactions
   **grouped by day** with a sticky day header, editorial empty states. → existing
   `SpaceTransactionsPanel` filter/group/sort stack, re-presented.
4. **`TxnRow`** — merchant / `category · account` / right-aligned amount + native
   subtext; transfers get an `ArrowLeftRight` glyph, never a color. → existing row
   render, restyled.
5. **`TxnDrawer`** (right-edge panel) — the drill target, sections in order:
   **Headline figure → Chips (flow/pending/native) → Facts (Date/Account/Native) →
   Relationships/Evidence (paired counterpart or "unresolved movement") → Note.**
   → this is exactly `buildTransactionDetailSections` re-hosted in a `RightPanel`.
   There is **no AI section in the prototype drawer today** — it is the stated future
   direction.

The prototype's interaction contract (`lib/drill.ts` `resolveDrill`) is *"a filter
over data already in hand, never a new loader."* Production's equivalent is already
true: all list surfaces consume one shared `Transaction[]` fetch; only the detail
does a per-id `TransactionDetail` read.

---

## The presentation / backend seam

**Presentation-only (buildable today, zero classifier/semantics/FlowType/fold change):**

- The Transactions Workspace **shell** (day-grouped editorial ledger, two figures,
  filter pills), rendering the existing shared `Transaction[]`.
- **Re-hosting** `TransactionDetailContent` (via presentation-agnostic
  `buildTransactionDetailSections`) from its current `OverlaySurface` **modal** into
  an Atlas **`RightPanel`** — a shell swap, not a data change.
- Surfacing **Facts** (Summary/Account/TI2/Provenance/Reporting sections — already
  projected) and **Relationships** (pending↔posted, duplicate, transfer-candidate —
  already resolved and already in the DTO) inside that panel.
- Lifting the **filter/search/sort/group** stack out of `SpaceTransactionsPanel` into
  the workspace, reusing `TransactionsFilterOverlay` + `transactions-filter-constants`.
- An **`AskChip`-style seam** deep-linking a transaction's context into
  `/dashboard/analyze` with a seeded question (the D6 drilldown assembler already
  answers "what is this made up of?"). This is a UI hand-off, not new AI backend.

**Backend / TI / v2.6 (out of scope for this convergence; separate tracks):**

- **Per-transaction AI explanation** — needs a new assembler/domain
  (`FinanceDomains.TRANSACTIONS_RAW`, currently a named-but-unimplemented slot), a
  prompt-serializer block, and likely action plumbing. Gated by AI convergence
  doctrine.
- **Lighting the `AnswerCard` slots** (`facts/evidence/actions/relatedEntities`) —
  v2.6, requires wire-contract changes currently forbidden ("omit, don't fabricate").
- **`refundCandidate`** (fuzzy heuristic) and **recurring-group** resolution —
  relationship enrichments; would appear in the Relationships section *when* built,
  but building them is TI backend work, not this pass.

---

## Roadmap

### Phase 0 — Gate (read-only, before any code)

- **P0.1** Confirm the detail re-host is a pure shell swap: `buildTransactionDetailSections`
  must stay the field authority; `RightPanel`/`PanelContent` replace `OverlaySurface`
  with **no change** to section content. If the projection needs edits, stop — that is
  a contract change, not presentation.
- **P0.2** Decide the detail-open mechanism: keep URL-driven (`?transaction=<id>` via
  `useOpenTransaction`, back-button-friendly, already global in `DashboardChrome`) vs
  panel-state-driven. **Recommendation: keep URL-driven** — it already works and
  matches the prototype's single shell-level panel instance (`PanelHost`).
- **P0.3** Confirm the calendar heatmap component is imported, not reimplemented, in
  the new shell. Fence check.
- **P0.4** Confirm no read touches the fenced authorities (classifier / fold /
  FlowType / predicates) beyond calling their existing outputs.

### Phase 1 — Ledger shell (presentation)

Build the editorial day-grouped ledger workspace over the existing shared
`Transaction[]`: two-figure header, `TimeBar`, filter pills, day groups with sticky
headers, `TxnRow` styling (transfer glyph not color), editorial empty states.
**Preserve** the calendar heatmap block as-is. Reuse the `CashFlowCategoryLedger`
idiom for structure. No new fetch, no new authority.

### Phase 2 — RightPanel detail re-host (presentation)

Re-host `TransactionDetailContent` inside `WorkspaceLayout` + `RightPanel` +
`PanelContent`/`PanelHeader`. Keep the URL opener. The section renderer and
`buildTransactionDetailSections` move **unchanged**; only the shell (modal →
right-edge panel) changes. Retire the `OverlaySurface` modal host once parity is
verified (or keep both behind the same opener during migration).

### Phase 3 — Facts + Relationships surfacing (presentation)

Ensure the panel renders, in prototype order: **Headline → Chips → Facts →
Relationships/Evidence → Note/Reporting.** All fields already exist in
`TransactionDetail`:
- **Facts** = Summary + Account + Transaction-Intelligence + Provenance + Reporting
  sections.
- **Relationships** = `relationships.pendingPosted` / `duplicate` /
  `transferCandidate` (the prototype's Evidence panel, incl. the honest
  "unresolved movement" empty state when no counterpart).
- `refundCandidate` stays **omitted** (stub) — render-only-when-data; do not
  fabricate a section.

### Phase 4 — AI-explanation SLOT (presentation scaffold, no emission)

Reserve an **"Explain this transaction"** region in the RightPanel as a
**render-only-when-data slot** — identical discipline to the Brief's trust/jump/ask
slots and `AnswerCard`'s inert `never[]` fields. It emits nothing today; it renders
only if/when a future backend supplies an explanation payload. Ship the shell dark.
Optionally wire the **`AskChip` hand-off** (Phase-4b) to seed `/dashboard/analyze`
with the transaction context — this uses the *existing* chat + drilldown backend, no
new contract.

### Backend track (FUTURE — v2.5.5 / v2.6, NOT this convergence)

- **B1 (v2.6)** `TRANSACTIONS_RAW` assembler + prompt serializer + per-transaction
  explanation, feeding the Phase-4 slot.
- **B2 (v2.6)** Light `AnswerCard` structured slots on the wire.
- **B3 (TI)** `refundCandidate` heuristic → Relationships section (auto-appears via
  render-only-when-data).
- **B4 (TI)** Recurring/subscription grouping → Relationships section.
- **B5 (v2.6a/AI-5)** Conversation persistence; **B6 (v2.6b)** model actions.

Each backend item, when built, lights an **already-shipped** presentation slot —
no further UI work required. That is the payoff of the SLOT discipline in Phase 3–4.

---

## Fences (restated)

- **Do not touch:** `flow-classifier.ts`, transaction semantics, `FlowType` enum +
  `flow-predicates.ts`, the economic fold (`cash-flow.ts`). Consume outputs only.
- **Preserve:** the calendar heatmap (`TransactionsCalendarHeatmap.tsx` /
  `CalendarHeatmapGrid`) — import, do not reimplement.
- **Omit, do not fabricate:** `refundCandidate`, recurring groups, and every
  `AnswerCard`/AI slot render only when a real backend payload exists.
- **No new read authority:** ledger reuses the shared `Transaction[]`; detail reuses
  `getTransactionDetail` / `TransactionDetail`.
