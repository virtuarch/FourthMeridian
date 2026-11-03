# Fourth Meridian — Architecture Doctrine (the reader's guide)

*The single entry point to "what is this system and why does it look this way." This
document **consolidates and points**; it does not restate. Each section below
summarises just enough to orient, then links to the canonical doctrine that owns the
detail (Financial Truth Spine, Space Architecture, Security Model, Time Model, UI
Interaction Model, and the ADRs).*

*Status: written at **v2.5 architecture completion**. For what is true **right now**
(version, active work, blockers) read [`/STATUS.md`](../../STATUS.md) — STATUS is the
current-state authority; this file is the durable shape.*

---

## 0. How to read the documentation

Fourth Meridian's documentation has a deliberate hierarchy. Truth lives in the
narrowest place that can own it:

| Layer | Where | What it is |
|---|---|---|
| **The code** | the repo | The ultimate source of truth. Docs describe intent; the code is reality. |
| **Current state** | [`/STATUS.md`](../../STATUS.md) | Version, active initiative, blockers, next steps. The only doc that goes stale on purpose. |
| **Doctrine** | [`architecture/`](.) | The **rules that bind the code** — this guide + Financial Truth Spine · Space Architecture · Security Model · Time Model · UI Interaction Model. |
| **Systems** | [`../systems/`](../systems/) | **Why each subsystem exists**, its authority, contracts, invariants. |
| **Decisions** | [`../decisions/`](../decisions/) | ADRs + the immutable PHASE_2_DECISION_MATRIX — decisions made and alternatives rejected. |
| **Operations / plans / releases** | [`../operations/`](../operations/) · [`../plans/`](../plans/) · [`../releases/`](../releases/) | Runbooks + readiness · active roadmap · per-version notes. |
| **Archive** | [`../archive/completed-plans/`](../archive/completed-plans/) | Historical decision context only (security reviews, frozen baselines, rejected proposals). Small by design. |

The lifecycle is **Investigation → Decision → Knowledge extraction → Deletion**: an
investigation's durable conclusions are merged into `architecture/` / `systems/` /
`decisions/`, and the working artifact is deleted (git preserves the process). This
guide is the top of that pyramid; [`architecture/README.md`](./README.md) is the
reading order.

---

## 1. What is Fourth Meridian?

Fourth Meridian is a **calm financial operating system** organised around one idea:
**the product navigates by the questions a person asks about their money, and
assembles the answer** — rather than handing them a pile of accounts, transactions,
and charts to assemble themselves.

Three nouns carry the whole product ([product-language](../design-system/product-language.md)):

- **Fourth Meridian** — the platform.
- **Space** — the organising container for a person's, household's, or entity's
  financial life. A user can have several. It is the **universal presentation/
  container primitive** (§4).
- **Space Template** — a preset that shapes a Space at creation (§8). FinTracker is
  the default; it is not a synonym for the product.

**AI** is a platform-level capability (ambient briefings and grounded
conversation), not a Space Template.

---

## 2. Where does truth live? — the financial authority model

The single most important architectural rule in the product:

> **One authoritative model · one semantic layer · one aggregation path · many
> consumers.** An *authority* decides a financial truth. Everything else is a
> *consumer* that projects it. A consumer that re-decides a truth (re-classifies a
> row, re-folds a total, re-converts a currency) is a bug — the parallel-authority
> drift the semantics layer exists to eliminate.

**Canonical authority: [FINANCIAL_TRUTH_SPINE.md](./FINANCIAL_TRUTH_SPINE.md).**
Read it in full before touching any financial number. The one-paragraph model — the
canonical funnel:

```
Providers (Plaid / exchange / wallet / CSV / manual)
  → Canonical identity / evidence   (TransferEvidence, RelationshipResolver, PositionObservation)
  → Canonical semantics             (FlowType + flow-predicates, classifyLiquidity, TransferDisposition, convertMoney)
  → Canonical facts / projections   (DayFacts fold; getCurrentPositions; reportingBalance)
  → Consumers                       (widgets, AI, export, Daily Brief)
```

The 14 authorities (financial-semantics §"Table of authorities") each own exactly
one truth: transaction population, FlowType, the economic fold, **DayFacts (the one
aggregate transaction fold)**, liquidity effect, account tier, transfer evidence
and meaning, ownership resolution, current positions, historical positions (A10),
reporting currency, the debt family, and visibility. Supporting doctrines:

- **Money & FX** — [money & FX](../systems/money-and-fx.md): `convertMoney` is the sole native→reporting seam; `reportingBalance` is the only cross-account-comparable balance; missing FX degrades to native + `estimated`, never dropped.
- **Historical data** — [historical data](../systems/historical-data.md): history is the pre-aggregated `SpaceSnapshot` (five money buckets); there is no per-account/per-entity historical row. *This one fact governs what any "over time" breakdown can ever show* (see §7).
- **Investments** — two truths never conflated: position-valuation (A10, coverage-gated, a subtotal) vs portfolio-total (balance-oriented, reconciled). `getCurrentPositions` is A10-at-today; `Current → getCurrentPositions`, `Historical → A10`, never cross-derived.
- **AI consumers** — [AI foundation](../systems/ai-foundation.md) + financial-semantics §9: assemblers *project* the authorities; they never author a parallel fold, net formula, population gate, or FX conversion.

**Sanctioned exceptions** (financial-semantics §12) are compatibility residues, not
rival authorities — each value-coincident with the authority it shadows:
the inline Spend chip, account-tier partition duplication, **btc-sync as a second
flow-fact author** (it derives category *from* flowType; scoped by
`classifierVersion` ownership, never swept into a version migration — the
[v2.5 closure record](../archive/completed-plans/v2.5-architecture-closure-decision.md) conditioned closure on keeping this comment-fenced),
legacy `Holding` retirement, and the Daily Brief savings-rate definition.

---

## 3. Who is allowed to do what? — the three authorization axes

> **Authorization has three independent axes that share the UI shell but never
> share an authz decision.** A Space role can never confer a platform capability,
> and a platform grant can never confer access to a customer Space.

**Canonical authority: [SECURITY_MODEL.md](./SECURITY_MODEL.md)** — the complete three-axis statement, verified against code.

| Axis | Model | Governs | Guard |
|---|---|---|---|
| **Customer tenancy** | `SpaceMemberRole` — `OWNER · ADMIN · MEMBER · VIEWER` (ranked) | who can see/act within a customer's financial data | `requireSpaceRole` |
| **Operator (platform ops)** | `PlatformGrant` — an `area` (`PLATFORM_OPS · SECURITY_OPS · GROWTH_REVENUE · CUSTOMER_SUCCESS`) at a `level` (`READ · WRITE`) | who can operate platform surfaces | `requirePlatformAccess` |
| **Emergency (admin)** | `UserRole.SYSTEM_ADMIN` (the only roles are `USER · SYSTEM_ADMIN`) | user access, internal access, platform configuration, break-glass | `requireSystemAdmin` / `requireFreshSystemAdmin` |

Rules that make this concrete:

1. **The axes never cross, and rows are never hard-deleted.** `PlatformGrant` is orthogonal to `SpaceMember` by construction (it mints no membership row and confers no Space authority, and vice versa). Membership and grant revocation is a provenance-bearing status flip, never a delete.
2. **`SYSTEM_ADMIN` is emergency/platform authority, not Space membership.** It is redirected *out* of `/dashboard/*` to `/admin` at the edge (`proxy.ts` — the single edge chokepoint; note Next.js 16 middleware is **`proxy.ts`, not `middleware.ts`**; API authz lives in `lib/session.ts`, not the proxy). It holds an **unconditional break-glass bypass** over the operator plane (`decidePlatformAccess` returns true for SYSTEM_ADMIN with no grant row). Admin MFA (TOTP) is **mandatory** — an un-enrolled admin's session is `requireTotpSetup` and rejected by every guard until enrolled; `DISABLE_SYSTEM_ADMIN` rejects admin login pre-session.
3. **Account visibility is a fourth, orthogonal dimension** — per-account, not per-role. A `SpaceAccountLink` grants an account into a Space at a `VisibilityLevel`: **`FULL`** (may expose transaction/position detail) · **`BALANCE_ONLY`** (a total, never rows) · **`SUMMARY_ONLY`** (a qualitative summary) · `PRIVATE` (nothing) · legacy `SHARED` (dormant, fails closed). The **sole** predicate is `TRANSACTION_DETAIL_VISIBILITY = [FULL]` (`lib/ai/visibility.ts`), read by every surface via `grantsTransactionDetail`/`grantsAccountDetail`; filtering stays server-side and fails closed. A transfer's resolved meaning is a *(row, viewer)* fact (financial-semantics §10, KD-15). *(The legacy `WorkspaceAccountShare` was retired in v2.5; `SpaceAccountLink` is the sole link path.)*

**Internal Fourth Meridian teams** (Platform Operations, Security Operations, Growth
& Revenue, Customer Success) are **real, built Spaces operated through Space
primitives** — four seeded HQ Platform Spaces (`Space.platformArea @unique`,
system-singletons, never client-creatable) render through the same
`DashboardChrome → SpaceShell → Workspace` stack as a customer Space, at
`/dashboard/platform/[area]`. But they carry **zero `SpaceMember` rows** — their
access is the `PlatformGrant` operator plane alone. **Same primitives, separate
authz plane.** The admin console (`/admin`) is *not* a customer Space; its
privileged writes are audited append-only (`AuditLog`, with `performedByAdminId`
for on-behalf actions). Operator WRITE routes are WRITE-grant-gated by design
(`requireFreshPlatformAccess`), though no operator write actions have shipped yet
(PO-1) — the gate exists ahead of its first use. See
[`systems/platform-ops.md`](../systems/platform-operations.md).

---

## 4. How do Spaces, Perspectives, Workspaces, and the dashboard fit together?

**Canonical authority: [SPACE_ARCHITECTURE.md](./SPACE_ARCHITECTURE.md)** (the full
tier ownership rules) and [`systems/spaces.md`](./SPACE_ARCHITECTURE.md) (the shipped
composition). The shape, top to bottom:

```
Space               a durable domain/environment (Personal Finance, or an HQ Platform area)
  └── SpaceShell    the permanent, domain-AGNOSTIC frame — the same for every Space
        └── Workspace   the domain experience filling the slot
```

- **A Space** is the universal container primitive. A Personal Finance Space and a Platform Operations Space are the **same architectural primitive** — same shell, same navigation architecture — differing only in domain, composition, data, and permitted presentation. A Space is **not** a database authority, **not** a replacement for platform authorization, and **not** a command centre; it is a presentation/container primitive.
- **SpaceShell** owns the frame and *only* the frame: navigation, the single URL authority, the one canonical time model (`{preset, asOf, compareTo}`), refresh/invalidation, shell overlays, responsive layout, and shared Space capabilities (the FX "view as" control). It **never** computes a workspace's figures or knows a domain word.
- **A Workspace** is an isolated business domain — it owns its rendering, its domain math, its own `*SpaceData` read-model, its own FX presentation, and its own trust envelope. It is blind to the shell's internals and to other workspaces.
- **A Perspective** is a *specialised analytical Workspace* — a canonical domain seen through a lens across time and comparative states. **Every Perspective is a Workspace; not every Workspace is a Perspective** (the discriminator is `kind`). The five Personal-Finance Perspectives — **Wealth, Cash Flow, Liquidity, Investments, Debt** — all participate in the canonical `asOf`/`compareTo` time model. Perspectives are **analytical lenses, not independent applications**: each answers one question, and every widget inside it answers a sub-question of that one (the five Perspective design laws, doctrine/spaces §16).

**Where `SpaceDashboard` fits — and what it must not become.** `SpaceDashboard` is the
**orchestration / composition root**: it wires navigation → data → shell state and
places the resolved workspace in the slot. It must **not** own financial
calculations, become a giant controller, or duplicate domain logic. The SD-7/8/9
decompositions exist precisely to keep it a composition root
([`SD9_WORKSPACE_RUNTIME_CONVERGENCE.md`](./SPACE_ARCHITECTURE.md),
[`WORKSPACE_CONTRACT_DOCTRINE.md`](./SPACE_ARCHITECTURE.md)). Time is canonical
via **TimelineLens**, the sole time selector, which *emits intents* and owns no state
([`CANONICAL_TIME_DOCTRINE.md`](./TIME_MODEL.md)).

---

## 5. Why does the architecture look this way?

Five principles explain nearly every decision:

1. **One authority, many consumers.** Every truth is decided once and projected everywhere. This is why there is one classifier, one fold (DayFacts), one conversion seam, one visibility predicate, one URL writer, one time reducer. Parallel authorities drift; the architecture spends real effort to have exactly one of each.
2. **Questions, not objects.** The product is organised around the questions a person asks ("how am I doing?", "what can I reach?", "am I on track to be debt-free?"), not around accounts/transactions/holdings. Perspectives are those questions; Overview owns the scalar, a Perspective owns the decomposition.
3. **Same primitives, every domain.** Internal HQ surfaces reuse Space/Shell/Workspace rather than forking an admin framework — so the platform team's tools get the same architecture, and the abstraction stays domain-neutral. Authorization is the one thing that does *not* generalise (two planes, §3).
4. **Honesty over completeness.** A number is shown only when the data can defend it: coverage gates on investments, `estimated` taints on missing FX, "current classification" badges where history can't decompose, unclassified rows surfaced not hidden. The product would rather show a shorter honest series than a silently mixed one.
5. **Presentation is not authority.** Facts hold numbers; projections hold labels, ordering, and payloads. A Space is chrome and identity; it is not where truth or authorization lives.

---

## 6. The subsystem map

Each subsystem has a "why it exists + its contracts" doc under
[`docs/systems/`](../systems/): investments · wealth · cash-flow · liquidity · debt ·
transactions · spaces · connections · platform-ops · ai. Start with
[`systems/spaces.md`](./SPACE_ARCHITECTURE.md) for the composition, then the domain doc
for whichever workspace you're touching. Time doctrine:
[`CANONICAL_TIME_DOCTRINE.md`](./TIME_MODEL.md). Design language:
[`docs/design-system/`](../design-system/) (Atlas material/modal doctrines) and
[`docs/design/product-language.md`](../design-system/product-language.md).

---

## 7. The interrogation interaction language

*Summary; the canonical doctrine is [UI Interaction Model](./UI_INTERACTION_MODEL.md).*

> **A visualization that represents a breakdown is interrogable. Charts are not
> decoration.** A chart segment and a ledger row are the **same concept** — a named
> portion of a financial total that has constituents — so they share one interaction,
> not one runtime.

**The interaction language — Preview → Browser → Detail:**

```
PREVIEW    in-workspace: a chart or a top-N ledger. "What is the shape?"
   │  select a constituent
   ▼
BROWSER    LEFT panel: the full, searchable set. "What am I operating in?"
   │  select one
   ▼
DETAIL     RIGHT (or BOTTOM) panel: one entity, its composition and actions. "Tell me more."
```

**Rules:**

- **Role, not content, decides the edge.** LEFT = browse (pick from a set); CENTER = the workspace; RIGHT/BOTTOM = inspect (what's inside the one thing selected). A panel that renders a list is still *inspect* if its question is "what produced this number."
- **Panels vs modals.** A **Panel** is a persistent contextual surface ("tell me more" / "what am I operating in") — it preserves the workspace behind it. A **Modal** is "pause and complete a decision." Detail drills are panels, not modals (`WORKSPACE_CONTRACT_DOCTRINE.md §7`, [`ATLAS_GLASS_MODAL_DOCTRINE.md`](../design-system/ATLAS_GLASS_MODAL_DOCTRINE.md)).
- **The seam is a callback, not a framework.** Selectable charts expose an optional `onSelect(item)` — the same seam a ledger row has. No selection event bus, no provider, no global chart state. Local `useState` in the workspace; the caller opens the panel it already owns.
- **No affordance may lie.** A chart is interactive only where a handler exists (the cursor tells the truth); an inert chart claims nothing.
- **Selection is a capability, not a constant.** Because history is pre-aggregated (`SpaceSnapshot`, §2), present-day drill-downs are nearly free but **historical per-entity breakdowns do not exist**. Where constituents are unavailable, omit the affordance and say why ("current classification"); never open an empty panel. Selection also invalidates when the time question changes.
- **One authority behind chart and panel.** A segment's total and the rows its detail shows read the *same* grouping function, so they reconcile by construction.

Shipped consumers: Net Worth composition, Cash Flow calendar/categories, Investments
allocation, Liquidity tiers, and the metric-aware Wealth composition/change ledger.

---

## 8. Template doctrine *(canonical here — supersedes the V25-CLOSE-4/4B audits)*

> **Templates are entry points and configuration presets. They are not separate
> products, and the picker only offers concepts that are real today.**

- **A template implies a category; a category is not a template** (the 1:1 mapping is a coincidence of the initial set). A template is consumed *once*, at Space creation, to seed the Space's category, metadata, and initial sections. It never owns a Space afterward.
- **Exposure is three-state** (`TemplateStatus`): **`live`** — selectable and creatable; **`comingSoon`** — shown in the picker but *disabled* (visible roadmap, not creatable — the create route rejects any non-`live` id); **`hidden`** — off the picker but still resolvable, so existing Spaces of that category keep materialising.
- **v2.5 picker truth:**
  - **Live (selectable):** **Family** (Household merged in — identical composition) · **Custom**.
  - **Coming soon (disabled):** Retirement · Business · Property · Vehicle · Trip.
  - **Deferred / hidden:** goals-based templates, Debt Payoff, Emergency Fund, Investment, Equipment, Other, plus the never-picker Personal (registration default) and legacy Goal.
- **Truthfulness rules that earned this shape** ([V25-CLOSE-4 audit](./FOURTH_MERIDIAN_DOCTRINE.md)): a template must not lead with a `comingSoon` *lens* it can't render; a description must promise only what renders (no "rental income" without the feature); a seeded section key must have a real renderer. The picker renders the descriptions that already exist rather than inventing a CMS.
- **The structural caveat** worth knowing: on Overview, 14 of 15 categories auto-engage the Wealth workspace, so most seeded *section widgets* are inert — templates differ by **hero + lens list**, not by seeded sections. Making the manual-asset widgets (Property/Vehicle/Equipment) actually render is v2.6, not v2.5.

---

## 9. The v2.5 → v2.6 boundary *(canonical here)*

**v2.5 is the architecture, semantics, permissions foundation, Spaces, and the UX
interrogation/truthfulness layer** — the load-bearing structure a product can be
built *on*. It is complete when every scoped exit criterion is met (see STATUS);
what remains before beta is a **release** gate (config + ops), not an architectural
one.

**v2.5 completed:**

- Canonical financial semantic layer (one funnel, 14 authorities) and money/FX/historical doctrine.
- The two-plane permissions foundation (customer tenancy · platform grants · admin role · visibility tiers).
- Spaces / Shell / Workspaces / Perspectives as the universal composition primitive (SD-7/8/9), one canonical time authority (TimelineLens), bounded transaction reads (TX-1→4), connection lifecycle (CONN-1→4A).
- The UX interrogation language (§7) and template truthfulness (§8).

**v2.6 begins** — everything that builds *on* the structure rather than *being* it:

- **Intelligence & the conversation layer** — grounded conversation with persistence (`conversationId`), the advisor/advice write path, the failure corpus.
- **Provider catalog** — the provider-neutral `Connection`/`ProviderCatalog` abstraction (introduced from the *second* provider, per financial-semantics §2.8), and de-aliasing generic section renderers.
- **Heuristics & deeper semantics** — the reconciled portfolio-total authority, per-tier liquid history, the DayFacts sole-fold convergence, richer flow heuristics.
- **AI context & richer historical breakdowns** — which, where they need *per-entity history*, require the schema evolution beyond pre-aggregated `SpaceSnapshot` (§2). This is why "composition over time per mode" is a v2.6 data-model change, not a v2.5 visualization change.

**The dividing principle:** v2.5 removes every *false* promise and establishes every
*authority*; v2.6 adds the *missing capability* on top. Active roadmap:
`ROADMAP.md` (removed; see git history) (removed; see git history).

---

## 10. The five founder questions — where each is answered

| Question | Read |
|---|---|
| **What is Fourth Meridian?** | §1 here · [product-language](../design-system/product-language.md) |
| **Where does truth live?** | §2 here · [financial-semantics](./FINANCIAL_TRUTH_SPINE.md) · [money-and-fx](../systems/money-and-fx.md) · [historical-data](../systems/historical-data.md) |
| **Who is allowed to do what?** | §3 here · [Security Model](./SECURITY_MODEL.md) · [ADR-003](../decisions/ADR-003-visibility-model.md) |
| **How do Spaces / Perspectives / Workspaces / dashboards / permissions fit?** | §4 here · [doctrine/spaces](./SPACE_ARCHITECTURE.md) · [systems/spaces](./SPACE_ARCHITECTURE.md) |
| **Why does the architecture look this way?** | §5 here · [PHASE_2_DECISION_MATRIX](../decisions/PHASE_2_DECISION_MATRIX.md) (D1–D14) · [DEC-0](../decisions/ADR-005-numeric-precision.md) |

*If this guide and a linked canonical doc ever disagree, the canonical doctrine
wins and this guide is wrong — fix this guide. If a canonical doc and the code
disagree, the code wins and the doc is wrong — fix the doc.*
