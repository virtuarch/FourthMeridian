> **POINT-IN-TIME RECORD — immutable.** For current project status see `STATUS.md` at the repository root.

# D6/D7 — Provider Catalog Investigation (v2.4 Refresh)

**Investigation only. No code, schema, migration, or roadmap documentation
was modified to produce this document. This document is the sole
deliverable.**

Branch: `feature/phase-2-architecture`. Baseline: `v2.4` (D2 complete, D3
Stage B complete, D14 complete).

---

## 0. Purpose and scope

The prior investigation (`D6_PROVIDER_DISCOVERY_INVESTIGATION.md`) was
conducted against v2.3 state, before D2 and D14 landed. This document
re-evaluates all recommendations against the current v2.4 baseline, answers
the 15 investigation goals enumerated in the brief, and explicitly calls out
which prior conclusions hold, which change, and why.

---

## 1. Inputs read in full

- `docs/architecture/PHASE_2_ARCHITECTURE_FREEZE.md` — §9.2, §13, §14, §16
- `docs/architecture/PHASE_2_DECISION_MATRIX.md` — D6, D7, §3
- `docs/architecture/DATABASE_ARCHITECTURE_REVIEW.md` — §8
- `docs/architecture/V24_COMPLETION_PLANNING_INVESTIGATION.md` — §4, §6
- `docs/initiatives/d6/D6_PROVIDER_DISCOVERY_INVESTIGATION.md` — full
- `docs/initiatives/d2/D2_STEP5_ADAPTER_INTERFACE_INVESTIGATION.md` — §6–§9
- `docs/initiatives/d2/D2_STEP6_CLOSURE_DECISION.md` — full
- `docs/initiatives/d2/D2_STEP7G_PRODUCTION_HARDENING_CLOSEOUT_AUDIT.md` — ProviderCatalog references
- `prisma/schema.prisma` — `ProviderType`, `ImportSource`, `Connection`,
  `ProviderAccountIdentity`, `AccountConnection`, `ImportBatch` models, all
  enums
- `lib/imports/provider-capabilities.ts` — confirmed as implemented
- `lib/providers/plaid/adapter.ts` — confirmed as implemented

---

## 2. Current state (v2.4 ground truth)

**What changed since the prior investigation:**

- `lib/imports/provider-capabilities.ts` now exists — a 40-line
  `Record<ImportSource, ImportProviderCapabilities>` registry shipping with
  `supportsUpdateOnMatch` as its single capability. This is the import-side
  counterpart of what the catalog will be for discovery.
- `lib/providers/plaid/adapter.ts` now exists — a 24-line pure re-export
  (`refreshItem`/`syncTransactions`) with `provider: ProviderType.PLAID` as
  its identity marker. The providers directory (`lib/providers/`) is
  established.
- `Connection` model now exists in `prisma/schema.prisma` with
  `provider: ProviderType` and nullable `credential String?`. It is
  in the schema but not yet written or read by any application code (all
  existing Plaid behavior still runs through `PlaidItem`).
- `ProviderAccountIdentity` model is live and dual-written for PLAID and
  WALLET connections.
- `ImportBatch` model is live with a nullable `connectionId` FK (seam for
  future Connection wiring).
- `SpaceAccountLink` is now canonical (D3 Stage B). All new account-
  creation paths dual-write or write-only to it.
- `lib/encryption/` directory now exists with HKDF-derived purpose keys
  (D14). Future credentials stored on `Connection.credential` will use a
  purpose-derived key from this module, not the root key directly.

**What has not changed:**

- No `ProviderCatalog` model exists in `prisma/schema.prisma`. Confirmed
  by direct grep of every model/enum declaration.
- `ProviderType` enum: `PLAID | MANUAL | WALLET | CSV | EXCHANGE | BROKERAGE`
- `ImportSource` enum: `CSV | EXCEL | QUICKBOOKS`
- The six distinct launch paths (Plaid Link, AddWalletModal,
  AddManualAssetModal, CSV import, Excel import, QuickBooks import) are still
  independent, hardcoded into their own UI entry points.
- No admin route for catalog management exists.
- No catalog module of any kind has been built yet.

---

## 3. Investigation findings

### 3.1 — Where the Provider Catalog belongs architecturally

`lib/providers/catalog.ts`, colocated with `lib/providers/plaid/adapter.ts`.
The `lib/providers/` directory is already established by D2. Nothing else in
the codebase is a better host.

Not in `prisma/schema.prisma` (no table, per §3.2 below).
Not in `app/admin/providers/` (that is read-only diagnostics over `PlaidItem`
rows — an operational health concern, not discovery).
Not folded into `ProviderType` or `ImportSource` (dispatch keys consumed by
adapters; the catalog is presentation/routing metadata that sits in front of
them).

The one-way dependency rule stated in the prior investigation holds and is
now more concrete: `lib/providers/catalog.ts` may only be imported by
future UI/launch-decision code. It must never be imported by
`lib/plaid/*`, `lib/imports/*`, any adapter, or any API route other than
one whose job is explicitly "which provider should the user pick." The
module header comment should state this boundary, following the convention
established by `lib/plaid/retry.ts` and `lib/imports/provider-capabilities.ts`.

### 3.2 — Code-defined vs. database-backed for v2.4 MVP

**Code-defined. More strongly than before.**

The prior investigation's recommendation holds. With D2 now confirmed
complete, the two-tier model is clearer: the `lib/imports/provider-
capabilities.ts` registry (runtime behavior for already-launched import
flows) and the `lib/providers/plaid/adapter.ts` (thin re-export boundary for
Plaid sync) are both code-defined, and both are live. The catalog belongs
in the same tier.

No DB table. No migration. No admin CRUD route. The Decision Matrix's D7
option B recommendation (a `SYSTEM_ADMIN`-gated CRUD route at
`/admin/provider-catalog`) assumed a DB-backed table. That recommendation is
superseded for v2.4 — see §3.7 below.

The arguments for a code-defined registry are even stronger now:

1. The catalog governs a small, stable set of integration types (6–9 entries
   as of v2.4). This will not change on a timescale that justifies a writable
   DB row.
2. `lib/imports/provider-capabilities.ts` already establishes the exact
   precedent for code-defined capability registries keyed by an enum. The
   catalog is the same pattern, wider.
3. The only dynamic data that has ever been proposed for
   `ProviderCatalog` rows — `lastHealthCheck`, `reliabilityStatus`,
   `successRate` — belongs to an operational-health layer already served by
   `app/admin/providers/page.tsx`'s diagnostics table. That layer is
   correctly separate.

### 3.3 — Provider metadata

The v2.4 field set per entry, confirmed as the minimum viable set:

```ts
// Illustrative shape only — not implementation.
interface ProviderCatalogEntry {
  slug: string;               // stable identifier; future marketplace FK anchor
  displayName: string;        // user-visible name, e.g. "Banks & Brokerages", "CSV Import"
  category: CatalogCategory;  // BANKS_BROKERAGES | CRYPTO | IMPORTS | ACCOUNTING | MANUAL
  dispatch: CatalogDispatch;  // discriminated union — see §3.6
  enabled: boolean;           // false for deferred-provider placeholders
  logoUrl?: string;           // optional; path or CDN URL; absent for coming-soon entries
}
```

**Fields explicitly excluded from v2.4 (all belong to a future DB-backed
layer):**

- `successRate` — requires continuously-updated DB rows with historical data
- `lastHealthCheck` — operational metric, not a discovery property
- `reliabilityStatus` — derived from health-check history
- `knownIssue` — free text, ops-managed
- `isFeatured` — only meaningful once there are enough providers that
  curation is needed

These are correctly handled today by `app/admin/providers/page.tsx` for
the PLAID case. A catalog-level aggregate view of health is a v2.7+
concern.

### 3.4 — Provider capabilities

Two capability registries exist or will exist, with distinct responsibilities:

**`lib/imports/provider-capabilities.ts`** (already built, D2 Step 5) —
runtime behavior flags for import sources after they have been launched. Not
a discovery registry. Its `supportsUpdateOnMatch` flag governs what happens
inside the import pipeline once the user is already importing from a named
`ImportSource`. The catalog does not duplicate or replace this.

**`lib/providers/catalog.ts`** (to be built) — pre-launch discovery flags.
Its `enabled` flag governs whether the entry can be launched at all. Its
`category` governs how it is presented in a future picker UI. These are
entirely different concerns from `supportsUpdateOnMatch`.

The two registries are complementary, not redundant. A catalog entry for
"CSV Import" dispatches the user to the import flow (`{ kind: "import",
importSource: ImportSource.CSV }`), and *then* the import flow reads
`getImportProviderCapabilities(ImportSource.CSV)` internally. The catalog
never looks inside `provider-capabilities.ts` and vice versa.

**Capability flags vs. strategy objects.** The right answer for v2.4 is
capability flags on the entry — a boolean `enabled` field and the category
enum. Strategy objects (the adapters themselves: `plaidAdapter`,
`getImportProviderCapabilities`) live in their own modules and are not
embedded in the catalog. This matches the D2 Step 5 decision to keep
adapters thin and separate, validated by the fact that `plaidAdapter` in
`lib/providers/plaid/adapter.ts` is already a separate export, not bundled
into any registry.

For future providers: as a second sync adapter is added (e.g. a Coinbase
adapter in branch 3), it will live in `lib/providers/coinbase/adapter.ts`
with the same thin-re-export shape. The catalog entry for Coinbase will flip
to `enabled: true` once that adapter ships. No catalog structural change is
required.

### 3.5 — Supported asset types

Asset types are an output concern (`AccountType` on `FinancialAccount`), not
an input concern for the catalog. The catalog classifies integration paths,
not the accounts they produce. Embedding `supportedAssetTypes` on catalog
entries would couple the discovery layer to account classification — wrong
direction.

One concrete case worth naming: a Plaid connection can produce accounts of
`AccountType.checking`, `savings`, `investment`, or `debt` depending on
what the institution offers. The catalog cannot predict this at discovery
time, and should not try. `AccountType` is assigned by the adapter after
account data is received.

The `category` field on catalog entries is as close as the catalog should
get to "what kind of thing will this connect." It is a routing/grouping
hint for UI presentation, not a typed constraint on the output.

### 3.6 — Discovery and search architecture

Trivial for v2.4. `Array.prototype.filter()` over 6–9 static entries by
`category`, `enabled`, or `displayName` substring. No indexing, no
pagination, no query layer.

Real per-institution search (e.g. "find my bank among 11,000 institutions")
is Plaid Link's own job. The catalog is one level up: it selects which
integration path to launch, not which institution within Plaid to pick.
These are different UX decisions at different points in the user journey.

Three helper functions are the entire search surface:

```ts
// Illustrative only.
listProviderCatalogEntries(): ProviderCatalogEntry[]
listEnabledProviderCatalogEntries(): ProviderCatalogEntry[]
getProviderCatalogEntry(slug: string): ProviderCatalogEntry | undefined
```

### 3.7 — Launch and connect architecture

**Dispatch shape (updated from prior investigation):**

The prior investigation proposed:

```ts
type CatalogDispatch =
  | { kind: "connection"; providerType: ProviderType }
  | { kind: "import";     importSource: ImportSource }
  | { kind: "manual" };
```

This shape remains correct and is now more firmly grounded: with the
`Connection` model live in the schema (carrying `provider: ProviderType`),
the `{ kind: "connection", providerType }` variant maps directly to a
schema field. The catalog dispatch is pointing at a real model column, not
a future one.

The `{ kind: "import", importSource }` variant dispatches to the import
pipeline, which internally reads `getImportProviderCapabilities(source)`.
No change needed here.

**Dependency direction is strict and one-way:**

```
lib/providers/catalog.ts
    ↓ (imported by)
[future "Add Account" UI or launch-decision code]
    ↓ (launches)
lib/providers/plaid/adapter.ts  (for connection entries)
lib/imports/pipeline.ts         (for import entries)
app/api/accounts/wallet/route.ts (for manual/wallet entries)
```

Neither adapters nor import pipeline code may import `catalog.ts`. The
catalog has no knowledge of how any integration works — only that it exists,
what category it belongs to, and what dispatch key routes to it.

**D7 recommendation (admin CRUD route) is superseded.** This was written
for a DB-backed table and does not apply to a code-defined registry. No
admin route is needed — the registry is edited by code change and deployed.
This should be stated explicitly in any roadmap entry for D6/D7 so a
future implementer does not rediscover D7's text and build an admin route
against a nonexistent table.

### 3.8 — Future extensibility

The `slug` field is the extensibility anchor. It should be a stable, kebab-
case string that does not change even if `displayName` changes. Future
concerns that will reference it:

- **Provider Marketplace** — a future `Framework` or `SpaceTemplate` row
  will reference provider slugs to indicate which integration a published
  template targets (e.g. "this budget template is for Plaid users"). The
  slug is what makes this lookup stable across display-name changes.
- **AuditLog entries** — when a user launches a connection, the AuditLog
  `details` JSON should include `providerSlug` as the stable identifier
  rather than `displayName`.
- **Connection.externalConnectionId scoping** — not a catalog responsibility,
  but catalog entries in the `{ kind: "connection" }` category align 1:1
  with `ProviderType` values. Any future addition to `ProviderType` should
  have a corresponding catalog entry — in code, not in DB.

The catalog design should explicitly not try to solve marketplace,
institution-level curation, or billing concerns. Those belong to a future
`feature/marketplace-v1` branch after SpaceTemplate foundation
(`feature/space-template-foundation`) is done.

### 3.9 — Interaction with D2 adapter interfaces

D2 Step 5 deliberately avoided a generic `ProviderAdapter` interface because
only one sync provider existed. That decision still holds. The full adapter
generalization is owned by `feature/provider-adapter-layer` (branch 3).

The catalog's relationship to branch 3:

- When branch 3 adds a generic `ProviderAdapter` interface, the catalog
  remains unchanged. The adapter interface is a runtime-behavior contract;
  the catalog is a discovery/routing layer. They are separate concerns.
- When branch 3 wires `Connection` rows for PLAID (the `connectionId` FK on
  `AccountConnection`), the catalog's `{ kind: "connection", providerType:
  ProviderType.PLAID }` dispatch value remains valid — it points at the same
  `ProviderType` that lives on the `Connection` model. No catalog update
  needed.
- When branch 3 adds `Connection.credential` write paths for real providers,
  `lib/encryption/hkdf.ts` (D14) provides the purpose-derived key. The
  catalog does not touch encryption at all — it sits above this layer.
- The catalog can be built, shipped, and used before branch 3 starts. It has
  no technical dependency on the Connection model being populated.

### 3.10 — Interaction with future import providers

Import provider entries (CSV, Excel, QuickBooks) are fully functional today.
The catalog's import dispatch entries are immediately usable by any future
"Add Account" picker UI.

If a new import format is added (e.g. OFX, IIF, Schwab CSV), the workflow
is:

1. Add the new `ImportSource` enum value to `prisma/schema.prisma`.
2. Add a `REGISTRY` entry in `lib/imports/provider-capabilities.ts`.
3. Add a catalog entry in `lib/providers/catalog.ts`.

Steps 2 and 3 are independent, in the right modules, with no coupling
between them. This is the correct design.

### 3.11 — Interaction with future sync providers

Future sync providers (Coinbase, Schwab, Kraken — represented as
`ProviderType.EXCHANGE` and `ProviderType.BROKERAGE`) should appear in the
catalog as `enabled: false` entries from day one. This establishes the slug
and dispatch shape before the adapter exists, so the UI placeholder and the
eventual live entry have the same slug and no migration is needed when
`enabled` flips to `true`.

When a sync provider adapter ships (in `lib/providers/coinbase/adapter.ts`
or similar), the only catalog change is `enabled: true` for that entry.

The critical constraint: a catalog entry must not appear as `enabled: true`
unless its dispatch target has a working implementation. An `enabled: true`
catalog entry for Coinbase with no adapter behind it creates a dead-end UX
trap — the prior investigation named this explicitly and it remains valid.

### 3.12 — Interaction with future Provider Marketplace

The catalog's slug is the bridge to marketplace. The intended sequence:

1. v2.4: static code-defined catalog with 6–9 entries and stable slugs.
2. Future (`feature/space-template-foundation`): `SpaceTemplate` rows may
   optionally reference a `providerSlug` to indicate "this template works
   best with Plaid" or "this template is for CSV importers."
3. Farther future (`feature/marketplace-v1`): if a `Framework`/`CreatorProfile`
   table is built, `Framework.targetProviderSlug` references the catalog
   slug. The catalog becomes the stable identity layer beneath the
   marketplace.

No DB table is needed in v2.4 for this relationship to exist — the slugs
just need to be stable and documented once defined.

### 3.13 — Capability flags vs. strategy objects (summary)

Capability flags win for v2.4. The reasoning:

- **Flags** (`enabled`, `category`) belong in the catalog because they govern
  routing and presentation decisions that the catalog module itself can
  answer without knowing how any integration works.
- **Strategy objects** (`plaidAdapter`, `getImportProviderCapabilities`)
  belong in their own modules because they govern runtime behavior inside
  active flows.

The two levels must not merge. Embedding `plaidAdapter` inside a
`ProviderCatalogEntry` would couple discovery to implementation and violate
the one-way dependency rule in §3.7. Embedding a `supportsUpdateOnMatch`
flag in the catalog would duplicate `provider-capabilities.ts` and create
two sources of truth for the same fact.

The only runtime behavior flag that arguably belongs in the catalog is
`enabled` — it gates whether an integration can be launched at all, which
is a pre-launch discovery concern. Every other behavior flag belongs in the
appropriate downstream module.

### 3.14 — Smallest implementation slices

Three slices, each independently approvable, in dependency order:

**Slice 1 — Types and registry module (no consumers).**
`lib/providers/catalog.ts`: `CatalogCategory` and `CatalogDispatch`
types; `ProviderCatalogEntry` interface; static array of the v2.4 entries;
`listProviderCatalogEntries()`, `listEnabledProviderCatalogEntries()`, and
`getProviderCatalogEntry(slug)` helpers. No consumers wired. Zero schema
change. Zero behavior change. Smallest possible diff.

Entries for Slice 1:

| slug | displayName | category | dispatch | enabled |
|---|---|---|---|---|
| `plaid` | Banks & Brokerages | `BANKS_BROKERAGES` | `{ kind: "connection", providerType: PLAID }` | `true` |
| `wallet` | Crypto Wallet | `CRYPTO` | `{ kind: "connection", providerType: WALLET }` | `true` |
| `csv` | CSV Import | `IMPORTS` | `{ kind: "import", importSource: CSV }` | `true` |
| `excel` | Excel Import | `IMPORTS` | `{ kind: "import", importSource: EXCEL }` | `true` |
| `quickbooks` | QuickBooks Import | `ACCOUNTING` | `{ kind: "import", importSource: QUICKBOOKS }` | `true` |
| `manual` | Manual Account | `MANUAL` | `{ kind: "manual" }` | `true` |
| `coinbase` | Coinbase | `CRYPTO` | `{ kind: "connection", providerType: EXCHANGE }` | `false` |
| `schwab` | Charles Schwab | `BANKS_BROKERAGES` | `{ kind: "connection", providerType: BROKERAGE }` | `false` |
| `kraken` | Kraken | `CRYPTO` | `{ kind: "connection", providerType: EXCHANGE }` | `false` |

The three disabled entries (Coinbase, Schwab, Kraken) establish slugs now
so they are stable when adapters ship. They should not appear in
`listEnabledProviderCatalogEntries()` output.

**Slice 2 — Wire one read-only consumer (optional, separate PR).**
Connect the catalog to one read-only call site — e.g. an API route that
returns the enabled provider list for a future picker UI. Zero behavior
change to any existing flow. Proves the lookup works end-to-end.

**Slice 3 — Future, explicitly deferred.** A polished picker UI, any admin-
editable catalog layer, or per-institution entries (bank-level, not
integration-type-level). Out of scope for v2.4; belongs to a future
`feature/marketplace-v1` or a separate `feature/provider-picker-ui` branch
once a concrete product requirement exists.

### 3.15 — Validation plan

For Slice 1:

- `npx tsc --noEmit` — confirms the discriminated `CatalogDispatch` union
  type-checks with no `any` leakage and that every `ProviderType`/
  `ImportSource` reference resolves to a real Prisma enum member.
- `npx prisma generate` — expected no-op (no schema change).
- `npm run lint` — no new violations expected.
- Grep check: confirm no file under `lib/plaid/`, `lib/imports/`, or
  `app/api/` (except a future picker route) imports `lib/providers/catalog.ts`.
  Proves the one-way dependency held.
- Manual cross-check: every `dispatch` value references a real `ProviderType`
  or `ImportSource` enum member (no DB validation exists for a code-only
  registry).
- Confirm the three disabled entries (`coinbase`, `schwab`, `kraken`) do
  not appear in `listEnabledProviderCatalogEntries()` output.
- Confirm no health/reliability fields (`successRate`, `lastHealthCheck`,
  `reliabilityStatus`, `knownIssue`, `isFeatured`) are present.
- No route or UI testing needed — no route or UI changes in Slice 1.

---

## 4. Prior D6 recommendation review

| Prior recommendation | Status after D2/D3/D14 | Notes |
|---|---|---|
| Code-defined static registry | **Confirmed, stronger.** | `lib/imports/provider-capabilities.ts` and `lib/providers/plaid/adapter.ts` now provide direct precedent. |
| `lib/providers/catalog.ts` location | **Confirmed.** | `lib/providers/` directory now established by D2. |
| Discriminated dispatch union | **Confirmed, more grounded.** | `Connection.provider: ProviderType` now exists in schema; dispatch union maps to a real column. |
| 6–9 entries, not institution-level | **Confirmed.** | Unchanged rationale. |
| Exclude health/reliability fields | **Confirmed.** | Operational health is correctly handled by `app/admin/providers/page.tsx` for PLAID; catalog-level aggregate health is v2.7+. |
| D7 admin CRUD route superseded | **Confirmed.** | No DB table means no CRUD route. This should be documented explicitly in any roadmap entry so D7's original text is not rediscovered and implemented. |
| One-way dependency rule | **Confirmed.** | Now has two live precedents: `provider-capabilities.ts` (never imported by adapters) and `plaidAdapter` (never imported by import pipeline). |
| Deferred providers as `enabled: false` | **Confirmed, more specific.** | `ProviderType.EXCHANGE` and `ProviderType.BROKERAGE` are the correct dispatch values for Coinbase/Kraken and Schwab respectively. |

**One refinement from the prior investigation:**

The prior investigation stated "the two registries are complementary" but
did not fully articulate the boundary. Post-D2, that boundary is now
precise:

- `lib/providers/catalog.ts`: pre-launch discovery layer. Answers "which
  providers exist and can be launched?"
- `lib/imports/provider-capabilities.ts`: post-launch runtime behavior layer.
  Answers "for an already-running import, how does it behave?"
- `lib/providers/plaid/adapter.ts`: runtime sync layer. Answers "for an
  already-authenticated Plaid connection, how do we refresh it?"

These three are separate modules with separate jobs. The catalog imports
none of them. They import none of the catalog. All three must remain
independently usable.

---

## 5. Architectural risks

**Risk 1 (Medium) — Enum fragmentation with dispatch shape.**
`ProviderType.CSV` exists in the schema but the correct catalog dispatch
for a "CSV Import" entry is `{ kind: "import", importSource: ImportSource.CSV }`,
not `{ kind: "connection", providerType: ProviderType.CSV }`. This is
because import sources have no `Connection` row (nullable `connectionId` on
`ImportBatch`). If a future implementer uses `ProviderType.CSV` in the
dispatch for the CSV catalog entry, they would be implying a `Connection`
should be created for CSV imports — which is wrong for v2.4 and would
conflict with `ImportBatch.connectionId`'s design intent.
**Mitigation:** document the dispatch shape explicitly in the module header;
add a unit test that confirms each enabled entry's dispatch resolves to an
existing flow.

**Risk 2 (Low-Medium) — Registry drift from UI.**
If any future UI component hardcodes its own list of provider buttons
instead of reading `listEnabledProviderCatalogEntries()`, the two will
diverge. The same "two readers of one flag" risk named by D2 Step 5.
**Mitigation:** the catalog module should be the only place that answers
"which providers are available." State this in the module header comment.

**Risk 3 (Low) — Slug stability.**
Slugs referenced by `SpaceTemplate` rows or `AuditLog` details cannot be
renamed without a data migration. Any slug defined in Slice 1 is a
commitment.
**Mitigation:** choose slugs once, document them as stable identifiers in
the module header, and treat slug changes the same way Prisma treats enum
value renames — as a migration event, not a cosmetic edit.

**Risk 4 (Low) — D7 text rediscovery.**
`PHASE_2_DECISION_MATRIX.md` §D7 recommends a `SYSTEM_ADMIN`-gated CRUD
route for `ProviderCatalog`. That recommendation assumed a DB table. The
DB table was never built. If a future implementer reads D7 without also
reading the prior investigation, they may build an admin route against a
table that does not exist.
**Mitigation:** the implementation checklist for Slice 1 (when approved)
should include a single-sentence note in its deliverable confirming D7's
route recommendation does not apply for a code-defined registry. Not a doc
edit — a checklist note.

**Risk 5 (Low) — Three disabled entries creating confusion.**
The Coinbase, Schwab, and Kraken entries with `enabled: false` may cause a
future engineer to assume "the adapter exists but is toggled off" rather
than "no adapter exists yet."
**Mitigation:** a code comment on each disabled entry stating why it is
disabled ("no adapter yet — see feature/provider-adapter-layer").

---

## 6. MVP recommendation

Slice 1 alone is the MVP. It is:

- Zero schema change.
- Zero behavior change to any existing flow.
- Zero migration.
- Zero UI change.
- One new file (`lib/providers/catalog.ts`), approximately 60–80 lines.

This file becomes the authoritative source of truth for "which integration
types exist" before any "Add Account" picker UI is built. Building the
picker UI without this module first would require the UI to embed its own
inline list — exactly the registry-drift risk in §5.

The MVP does not include:
- Any admin route (no DB table exists to CRUD).
- Any UI consumer (that is Slice 2 territory).
- Any health/reliability fields.
- Any marketplace-layer concerns.

---

## 7. Recommended implementation order

| # | Step | Dependency | Risk |
|---|---|---|---|
| 1 | `lib/providers/catalog.ts` — types, registry, helpers (Slice 1) | None | Low |
| 2 | Wire one read-only API consumer (Slice 2) | Slice 1 complete | Low |
| 3 | Future: wire picker UI once a "Add Account" redesign is scoped | Slice 2 complete | Low |
| 4 | Future: flip `enabled: true` for disabled entries as adapters ship | Adapter for that provider landed in branch 3 | Low (one-line change) |
| 5 | Future: DB-backed catalog layer if/when marketplace requires it | `feature/marketplace-v1` approved | Medium |

D6/D7 has no dependency on D3 Stage C (WorkspaceAccountShare removal),
D11 (schema modernization), or D9 (SpaceTemplate foundation). It can be
implemented in parallel with any of them. The V24 Completion Planning
Investigation (§4) confirms this explicitly.

---

## 8. Stop point

This document is the complete deliverable. No schema, migration, route,
UI, or roadmap-document changes were made.

Recommended next step: approve Slice 1 and produce a short implementation
checklist before any file is touched.
