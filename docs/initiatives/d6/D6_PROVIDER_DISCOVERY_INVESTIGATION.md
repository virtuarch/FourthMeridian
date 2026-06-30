# Provider Discovery Investigation

**Investigation only. No code, schema, or migration changes made. No roadmap
documentation updated as part of this work — this document is itself the
deliverable.** Originally requested as "D4.4 — Provider Discovery
Investigation." See §0 — that label conflicts with this project's own
canonical numbering and is corrected below.

---

## 0. Numbering correction (read this first)

The request framed this work as **D4** introducing the Provider Catalog, with
this investigation as **D4.4**. That does not match this project's canonical
numbering:

- `docs/architecture/PHASE_2_DECISION_MATRIX.md` §1 and §2 (D6, D7): **D6 =
  `ProviderCatalog` field set reconciliation**, **D7 = `ProviderCatalog`
  ownership + admin UI**, both owned by `feature/provider-catalog` (branch 2).
  **D4 = AI Context Builder: enforcement mechanism + `agentScope` shape**
  (`feature/ai-context-builder`).
- This project's own standing instructions (Approved Phase 2 direction list)
  list them the same way: item 4 is "D6/D7 ProviderCatalog," item 9 is "D4 AI
  Context Builder."
- This exact mislabeling already happened once before and was caught:
  `docs/architecture/D2_CONNECTION_ARCHITECTURE_REVIEW.md` §0 contains a
  near-identical correction table for a prior brief that called Provider
  Catalog "D4" and AI Context Builder "D5."
- `docs/initiatives/d4/` and `docs/initiatives/d6/` both exist on disk; both
  are currently empty (`.gitkeep` only), so no filed work has set a
  conflicting precedent either way.

**This document is filed under `docs/initiatives/d6/`, not `d4/`,** and is
scoped as a Provider Catalog (D6/D7) investigation. The eight investigation
goals below are unambiguous regardless of label, so the substance proceeds
unchanged — but the label should be corrected before this gets a roadmap
entry or an implementation checklist, so the project doesn't end up with two
different things both called "D4."

---

## 1. Inputs read in full

- `docs/architecture/PHASE_2_ARCHITECTURE_FREEZE.md` — §9.2, §13, §14, §16
- `docs/architecture/PHASE_2_DECISION_MATRIX.md` — full, esp. D6, D7
- `docs/architecture/DATABASE_ARCHITECTURE_REVIEW.md` — §8 in full
- `docs/architecture/D2_PROVIDER_CONNECTION_ARCHITECTURE.md` — §2
- `docs/architecture/D2_CONNECTION_ARCHITECTURE_REVIEW.md` — §0, §5–7
- `docs/initiatives/d2/D2_ROADMAP.md` — full (live canon)
- `docs/initiatives/d2/D2_STEP5_ADAPTER_INTERFACE_INVESTIGATION.md` — full
- `docs/initiatives/d2/D2_STEP6_FIRST_PROVIDER_INVESTIGATION.md` and
  `D2_STEP6_CLOSURE_DECISION.md` — full
- `docs/initiatives/d2/D2_STEP7G_PRODUCTION_HARDENING_CLOSEOUT_AUDIT.md` —
  ProviderCatalog references
- `prisma/schema.prisma` — `ProviderType`, `ImportSource`, `ConnectionStatus`
  enums; `Connection`, `ProviderAccountIdentity`, `PlaidItem`, `ImportBatch`
  models
- `lib/providers/plaid/adapter.ts`, `lib/plaid/retry.ts`, `lib/plaid/errors.ts`
- `app/admin/providers/page.tsx`
- `components/dashboard/AddWalletModal.tsx`
- `types/index.ts`
- `fourth-meridian-product-language.md`

---

## 2. Current state (ground truth)

- **No `ProviderCatalog` model exists in `prisma/schema.prisma`.** Confirmed
  by direct grep of every `model`/`enum` declaration.
- **`ProviderType`** (`PLAID | MANUAL | WALLET | CSV | EXCHANGE | BROKERAGE`)
  is the schema's own comment says it best: "identifies which kind of
  provider a `Connection` represents... **Not yet used by any application
  code.**" It is a dispatch key sitting on `Connection`/`ProviderAccountIdentity`,
  not a catalog.
- **`ImportSource`** (`CSV | EXCEL | QUICKBOOKS`) is a second, narrower
  dispatch key, scoped to `ImportBatch`/the import pipeline. `CSV` exists in
  *both* `ProviderType` and `ImportSource` today; `EXCEL` and `QUICKBOOKS`
  exist only in `ImportSource`. D2 Step 5's investigation already flagged
  this gap and explicitly assigned it to Provider Catalog (D6/D7) — i.e., to
  this investigation.
- **`AccountType`** (`types/index.ts`: `checking | savings | investment |
  crypto | debt | other`) is a *third*, unrelated axis — it classifies the
  resulting `FinancialAccount`, not the integration path that created it.
- **`WalletChain`** (`BTC | ETH | SOL | BNB | MATIC | ADA | XRP | OTHER`) is a
  sub-selection inside the existing Wallet flow (`AddWalletModal.tsx`'s
  `CHAINS` array) — one launch path, many chain choices within it, not one
  catalog entry per chain.
- **Existing launch paths today**, each independent and hardcoded into its
  own UI entry point: Plaid Link (via `PlaidContext` → `create-link-token` →
  `exchange-token`), `AddWalletModal`, `AddManualAssetModal`, and the import
  pipeline (keyed by `ImportSource`). Nothing routes between them today; a
  user (or the UI) already knows which one they want before any code runs.
- **`app/admin/providers/page.tsx`** ("Provider Diagnostics," D2 Step 7F) is
  a read-only health table over `PlaidItem` rows. It is not a catalog and
  does not become one — a different concern (operational health of existing
  connections, not discovery of new ones).
- **Precedent for a code-defined static registry already exists twice**:
  `lib/imports/provider-capabilities.ts`'s `REGISTRY: Record<ImportSource,
  ImportProviderCapabilities>`, and `AddWalletModal.tsx`'s `CHAINS` array.
  Both are small, static, in-file arrays/records with no DB backing.
- **The canonical roadmap has already pre-decided the big question.**
  `D2_PROVIDER_CONNECTION_ARCHITECTURE.md` §2 explicitly defers a queryable
  `ProviderCatalog` table in favor of "a code-level `ProviderType` enum + small
  static registry for D2." `D2_ROADMAP.md` reaffirms: "Provider Catalog
  polished UI remains a later v2.7 Provider Ecosystem concern, not D2
  foundation." `D2_STEP7G`'s closeout audit reconfirms this is a
  product/timing call, not a technical blocker.
- **Existing architecture docs already sketch the exact routing shape this
  investigation is asked about.** `D2_CONNECTION_ARCHITECTURE_REVIEW.md`'s
  own diagram reads:

  ```
  Account-creation request --> {ProviderCatalog lookup -- D6/D7, separate branch}
                                  --> Plaid adapter (existing, unchanged)
                                  --> Coinbase/Kraken adapter (not yet built)
                                  --> Manual asset path (existing, unchanged)
  ```

  This is direct, pre-existing precedent for "lookup step in front of,
  routing to, but not coupled into, the adapters" — it just hasn't been
  built yet.

---

## 3. Findings, by investigation goal

### 3.1 Where should provider discovery live?

A new, small, additive module — `lib/providers/catalog.ts` (or
`registry.ts`) — sitting next to the existing `lib/providers/plaid/adapter.ts`.
Not in `prisma/schema.prisma` (no table, per the already-settled D2
decision). Not in `app/admin/providers/` (that's diagnostics over
`PlaidItem`, a different concern with a different audience). Not folded into
`ProviderType` or `ImportSource` (those are dispatch keys consumed by
adapters; the catalog is presentation/routing metadata that sits in front of
them, per the Freeze doc's own framing and the diagram in §2 above).

### 3.2 How should existing connection flows consume it?

They don't have to change at all for this slice. Plaid Link, the wallet
modal, the manual-asset modal, and the import pipeline each already know
which flow they are — none of them currently ask "which provider should I
be?" The catalog's only consumer for now is hypothetical future UI (the
v2.9 "Add Account" surface). Zero required changes to
`exchange-token`, the wallet route, or any import route. This is a fully
additive, zero-blast-radius slice if scoped correctly.

### 3.3 Should discovery remain entirely code-defined for v2.4?

Yes, and more strongly than the original framing assumed — see §3.8's
reconsidered assumption. With discovery scoped to *integration paths*
(Plaid aggregator, Wallet, CSV, Excel, QuickBooks, Manual — roughly six
entries, maybe a handful more if Coinbase/Schwab/Kraken are listed as
disabled placeholders) rather than *individual institutions*, a static
in-memory array is not just sufficient, it's the only sane choice. No DB
table, no search index, no admin UI.

### 3.4 How should provider search/filtering work?

Trivially: `Array.prototype.filter()` over a half-dozen to dozen static
entries by category, dispatch capability, or name substring. No indexing,
no pagination, no query layer. Real per-institution search (e.g., "find my
bank among 11,000 institutions") is already Plaid Link's own job — Plaid's
Link UI ships its own institution search. Fourth Meridian's catalog is one
level up: it picks *which aggregator/import path* to launch, not which of
thousands of institutions within Plaid to pick.

### 3.5 How should provider grouping work?

A small, fixed `category` field on each entry — e.g. `BANKS_BROKERAGES |
CRYPTO | IMPORTS | ACCOUNTING | MANUAL` — purpose-built for this catalog,
not reused from `AccountType` (classifies the resulting account, not the
integration path) or `ProviderType`/`ImportSource` (dispatch, not
presentation). This is deliberately coarser than the Freeze doc §14's
original `institutionType` concept (bank/brokerage/exchange/credit union),
which only makes sense once the catalog has many institution-level rows —
see §3.8.

### 3.6 How should launch routing be structured, decoupled from implementations?

Each entry carries a `dispatch` value that names *which existing adapter
path* it routes to, without the catalog module importing any adapter code.
Illustrative shape (not committed code):

```ts
// Illustrative shape only — not implementation.
type CatalogDispatch =
  | { kind: "connection"; providerType: ProviderType }  // PLAID, WALLET, EXCHANGE, BROKERAGE
  | { kind: "import";     importSource: ImportSource }  // CSV, EXCEL, QUICKBOOKS
  | { kind: "manual" };

interface ProviderCatalogEntry {
  slug: string;
  displayName: string;
  category: CatalogCategory;
  dispatch: CatalogDispatch;
  enabled: boolean;          // false for comingSoon placeholders
  logoUrl?: string;
}
```

The dependency direction is one-way and strict: `lib/providers/catalog.ts`
must never be imported by `lib/plaid/*`, `lib/imports/*`, or any adapter —
only by future UI/launch-decision code. This matches the Freeze doc's own
"sits in front of, not inside" framing and the diagram already present in
`D2_CONNECTION_ARCHITECTURE_REVIEW.md`.

### 3.7 Hidden architectural risks

1. **Enum fragmentation.** `ProviderType` and `ImportSource` are two
   different "what kind of provider" axes today, with `CSV` already
   duplicated across both and `EXCEL`/`QUICKBOOKS` only in `ImportSource`.
   A catalog `dispatch` field cannot be a single flat enum reference the way
   the Freeze doc §14 originally sketched (`providerType` alone) — it needs
   the discriminated shape in §3.6, or the catalog will hit entries it
   cannot route.
2. **"Provider" is already an overloaded word in this codebase**:
   `ProviderType` (Connection dispatch), `ProviderAccountIdentity`,
   `ProviderAdapter` (proposed in the Freeze doc, never built generically),
   `app/admin/providers` (diagnostics, unrelated), and now `ProviderCatalog`.
   Naming the new module and its types precisely (`ProviderCatalogEntry`,
   not just "Provider") and cross-referencing this doc from anything D2-Step-7
   adjacent reduces the odds of a third numbering/identity mixup like §0's.
3. **D7's old recommendation is superseded but not yet marked as such.** The
   Decision Matrix's D7 recommendation (option B: a `SYSTEM_ADMIN`-gated CRUD
   route at `/admin/provider-catalog`) was written for a DB-backed table. The
   roadmap has since moved the whole catalog to a code-defined registry for
   this era, which makes an admin CRUD route pointless — there's no table to
   CRUD. If this isn't stated plainly, a future implementer could rediscover
   D7's old text and build an admin route against a table that doesn't
   exist. This investigation's recommendation (§5) explicitly retires that
   plan for the v2.4 slice.
4. **Dead-end UX trap for deferred natives.** Coinbase, Schwab, and Kraken
   are named in scope but have no working adapter behind them (native
   implementations are intentionally deferred). Listing them as live,
   clickable catalog entries with nothing behind them recreates the exact
   "table nobody can finish" anti-pattern the Decision Matrix's D7 section
   already warned about for a different reason. Any entry without a working
   `dispatch` target should ship `enabled: false` or be omitted outright.
5. **Registry drift.** If a future UI hardcodes its own provider button list
   instead of reading the registry, the two will drift — the same
   "two readers of one flag" risk D2 Step 5's investigation already named for
   capability flags. The registry should be the single source even before
   any UI consumes it.
6. **One-way dependency discipline is easy to violate accidentally.** Nothing
   technically stops `lib/plaid/*` from importing `lib/providers/catalog.ts`
   later "just to check something." That import direction should be called
   out explicitly in the module's own header comment (matching this
   codebase's existing convention, e.g. `lib/plaid/retry.ts`'s own header) so
   it's visible at the point someone might add it.
7. **Numbering confusion (§0).** Filing this under the wrong ID risks a
   roadmap doc later citing "D4" for two unrelated things.

### 3.8 Assumptions worth reconsidering

- **"One catalog row per institution" should become "one row per
  integration path."** `DATABASE_ARCHITECTURE_REVIEW.md` §8.1's "Chase /
  Amex / Schwab / Fidelity / Coinbase / Kraken / CSV Import / Manual" framing
  reads as a flat list of institutions. Taken literally, that means either
  mirroring Plaid's entire institution list (thousands of rows, constant
  churn, duplicating work Plaid Link's own search already does for free) or
  hand-curating a "featured institutions" subset. Given "no marketplace
  functionality," "no provider CRUD," and "smallest architecture satisfying
  scope," the right v2.4 read is: the catalog has one entry for "connect a
  bank or brokerage" (routes to Plaid Link, which does its own institution
  search), one for Wallet, one each for CSV/Excel/QuickBooks, one for
  Manual, and optionally disabled placeholders for Coinbase/Schwab/Kraken.
  That's 6–9 entries, not thousands. This is the single biggest assumption
  shift from the original framing and the reason §3.3/§3.4's answers are as
  simple as they are.
- **The D6 "merge both field lists" recommendation doesn't transfer cleanly
  to a code-defined registry.** D6 recommended including both
  `lastHealthCheck` (raw timestamp) and `reliabilityStatus` (derived from
  health-check history), plus `successRate` and `knownIssue` text — all
  fields that assume a writable, continuously-updated DB row maintained by
  ops. A hardcoded constant can't represent a "rolling success rate." Those
  fields should be dropped from the v2.4 code-defined field set entirely —
  not deferred-but-included, actually excluded — since they describe a
  fundamentally different (dynamic, DB-backed) layer that `D2_ROADMAP.md`
  already places at v2.7+. (`app/admin/providers/page.tsx`'s diagnostics
  table already covers connection-level health today; a catalog-level
  aggregate health view is a later, separate concern.)
- **The name "ProviderCatalog" itself may overstate what's being built.**
  "Catalog" connotes a browsable, queryable collection — the DB-table
  mental model. What's actually being built this slice is a short static
  list with routing metadata. Worth being explicit in any roadmap entry that
  "ProviderCatalog" as named in the Phase 2 docs (a Prisma model with admin
  CRUD) is not what ships now — only the discovery/routing *behavior* that
  model would have powered, via a plain module.

---

## 4. Risks (consolidated)

See §3.7 items 1–7 above. In priority order: (1) enum-dispatch shape must be
a discriminated union, not a single flat field, or it can't represent every
entry; (3) D7's CRUD-route recommendation must be explicitly marked
superseded so it isn't rebuilt against a nonexistent table; (4) deferred
native providers must not appear as live dead ends; (7) the numbering must
be corrected before this is filed anywhere durable.

---

## 5. Recommendations

- Relabel this work under **D6/D7** (`feature/provider-catalog`), not D4,
  before any roadmap entry or implementation checklist is written.
- Build as a new, additive module — `lib/providers/catalog.ts` — exporting a
  static array of entries plus small lookup/filter helpers. No schema
  change, no migration, no admin route.
- v2.4 field set per entry: `slug`, `displayName`, `category`, `dispatch`
  (discriminated per §3.6), `enabled`, optional `logoUrl`. Explicitly
  **exclude** `successRate`, `lastHealthCheck`, `reliabilityStatus`,
  `knownIssue`, and `isFeatured` from this slice (§3.8).
- v2.4 entries: Plaid aggregator (banks/brokerages), Wallet, CSV import,
  Excel import, QuickBooks import, Manual. List Coinbase/Schwab/Kraken only
  if shipped with `enabled: false` and no functioning click-through, or omit
  them until a real adapter exists.
- Zero changes to any existing route, modal, or adapter in this slice.
- Document the one-way dependency rule (catalog → consumed by UI; never
  imported by adapters) directly in the new module's header comment.
- Explicitly mark D7's `/admin/provider-catalog` CRUD-route recommendation
  as superseded for this era, in whatever doc eventually records this
  decision (not done here, per the "don't update roadmap docs" instruction
  for this investigation).

---

## 6. Suggested implementation slices (for a future, separate, approved checklist)

1. **Registry + types only** — `lib/providers/catalog.ts`: `ProviderCatalogEntry`,
   `CatalogCategory`, `CatalogDispatch` types; static array of the six v2.4
   entries; `listProviderCatalogEntries()` / `getProviderCatalogEntry(slug)`
   helpers. No consumers wired. Smallest possible diff.
2. *(Optional, separate PR)* Wire exactly one read-only consumer to prove the
   lookup works end-to-end — still no UI redesign, no picker.
3. *(Explicitly deferred, v2.7 Provider Ecosystem per `D2_ROADMAP.md`)* A
   polished, searchable picker UI and any admin-editable catalog layer.
   Out of scope for this slice and not recommended now.

---

## 7. Validation plan (for when a slice above is approved and built)

- `npx tsc --noEmit` — new module type-checks with no `any` leakage in the
  discriminated `dispatch` union.
- Grep check: confirm no file under `lib/plaid/`, `lib/imports/`, or
  `app/api/accounts/` imports `lib/providers/catalog.ts` — proves the
  one-way dependency held.
- Manual cross-check: every entry's `providerType`/`importSource` value is a
  real member of the corresponding Prisma enum (no DB validation exists for
  a code-only registry, so this has to be checked by hand or a small unit
  test).
- Confirm the registry contains exactly the six v2.4 entries decided in §5 —
  no extra speculative entries, no health/reliability fields.
- No `npx prisma generate` / `npx prisma migrate dev` needed — no schema
  changes in this slice.
- No route or UI testing needed — no route or UI changes in this slice.

---

## 8. Stop point

This document is the complete deliverable for this investigation. No
schema, migration, route, UI, or roadmap-document changes were made.
Awaiting direction on whether to (a) correct the numbering per §0 and file
this under D6/D7, and (b) produce a short implementation checklist for
slice 1 in §6, before any code is written.
