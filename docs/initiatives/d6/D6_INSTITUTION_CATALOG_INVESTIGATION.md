# D6/D7 — Institution Catalog Investigation

**Investigation only. No code, schema, migration, or roadmap documentation
was modified to produce this document. This document is the sole
deliverable.**

Branch: `feature/phase-2-architecture`. Baseline: `v2.4`.

This investigation follows `D6_PROVIDER_CATALOG_INVESTIGATION.md` and
`D6_PROVIDER_DISCOVERY_INVESTIGATION.md`. It does not supersede either —
it introduces a new architectural layer above them, answers whether it
should exist, and clarifies the relationship between the two layers.

---

## 0. The question being investigated

The Provider Catalog investigation established that Fourth Meridian needs an
internal routing layer that maps integration methods (Plaid, Wallet, CSV,
etc.) to their launch flows. The question here is different: the product
vision has always been that users discover *institutions* through Fourth
Meridian, not integration methods. A user thinks "I want to connect my Chase
account," not "I want to use Plaid." Should that institution-first discovery
model introduce a separate architectural layer, and if so, what does it look
like?

---

## 1. Inputs read for this investigation

- `D6_PROVIDER_CATALOG_INVESTIGATION.md` — full
- `D6_PROVIDER_DISCOVERY_INVESTIGATION.md` — full
- `fourth-meridian-product-language.md` — full (esp. §2, §4, §5)
- `prisma/schema.prisma` — `PlaidItem`, `Connection`, `FinancialAccount`,
  `ProviderType`, `ImportSource` models and enums
- `components/dashboard/ConnectAccountButton.tsx` — the live Plaid entry point
- `components/dashboard/AddWalletModal.tsx` — the live wallet entry point
- `app/api/plaid/create-link-token/route.ts` — deprecated POST link token
- `app/api/plaid/exchange-token/route.ts` — exchange token and institution
  fields written at connect time

---

## 2. Current state (ground truth — what is actually running)

**The current Add Account entry points are provider-first, not
institution-first:**

- `ConnectAccountButton` opens Plaid Link directly and immediately. The
  button label reads "Connect Bank / Brokerage" — the user knows they are
  going into a Plaid flow before they search for anything.
- Inside Plaid Link, institution search is handled by Plaid's own modal UI.
  Fourth Meridian never sees the search query, only the result
  (`institution_id`, `institution_name`) returned at `onSuccess`.
- `AddWalletModal` enters a chain/address directly — no institution concept.
- `AddManualAssetModal` creates an account from scratch — no institution concept.
- Import flows (CSV, Excel, QuickBooks) are account-specific, not
  institution-specific.

**Institution metadata is already captured at the Plaid level:**

- `PlaidItem.institutionId` (e.g. `"ins_3"`) and `PlaidItem.institutionName`
  (e.g. `"Chase"`) are written at token exchange.
- `FinancialAccount.institution` (human-readable) and
  `FinancialAccount.institutionId` (Plaid's id, nullable) carry the same
  data down to the account level.
- This data flows out of Plaid Link's `onSuccess` callback — Fourth Meridian
  does not call Plaid's `/institutions/search` or `/institutions/get_by_id`
  anywhere today.

**No institution discovery layer exists.** Users cannot search for
institutions within Fourth Meridian. The current architecture is:
pick a connection method → enter that provider's flow → Plaid or another
provider handles institution selection internally.

---

## 3. Investigation findings

### 3.1 — Is Provider Catalog still the correct architectural primitive beneath this model?

Yes, without qualification. The institution-first product vision does not
invalidate the Provider Catalog — it adds a layer above it.

The Provider Catalog answers: *"Which integration methods exist, how do I
route to them, and are they available?"*

The Institution Catalog (proposed new layer) would answer: *"Which
institution does the user want to connect, and which integration methods
can serve that institution?"*

These are distinct questions with distinct data, distinct owners, and
distinct lifecycles. Provider Catalog remains the correct internal routing
primitive. Institution Catalog, if built, calls into it.

### 3.2 — Should Institution Catalog exist as a separate architectural layer?

Yes. The case is strong enough to state as a recommendation, not just an
option, because the two layers have fundamentally different properties
across every dimension that matters for architectural placement:

| Dimension | Provider Catalog | Institution Catalog |
|---|---|---|
| What it represents | Integration methods | Real-world financial institutions |
| Owner | Fourth Meridian entirely | Mix: Fourth Meridian owns the resolution layer, Plaid owns the underlying institution data |
| Cardinality | ~9 entries, stable | Potentially thousands (Plaid covers ~12,000+ institutions) |
| Update frequency | Only when Fourth Meridian adds a new integration method | As providers add/remove institution support |
| User-facing? | No — internal routing only | Yes — primary user search surface |
| Entry type | "Plaid", "CSV Import", "Wallet" | "Chase", "Coinbase", "Charles Schwab" |
| Who populates it? | Fourth Meridian engineers | Partly code-defined (native providers), partly provider-fed (Plaid API) |

These differences make a single-layer design a forced fit. Merging them
would either require the Provider Catalog to grow to thousands of
institution rows (wrong — it would inherit Plaid's maintenance burden) or
restrict the Institution Catalog to nine entries (wrong — it would fail to
model the institution-first UX the product demands).

### 3.3 — What belongs in Institution Catalog vs. Provider Catalog?

**Provider Catalog** (already designed in prior investigations):
- Integration method identity: slug, displayName, category, dispatch
- Whether the method is launchable today: `enabled`
- How to route to the underlying flow: `dispatch` discriminated union

**Institution Catalog** (proposed):
- Institution identity: slug (Fourth Meridian's stable ID), displayName,
  logoUrl, institutionType
- Available providers for this institution: a ranked list of Provider
  Catalog slugs that can connect to it
- Institution-level identity in the provider's namespace: e.g.
  `plaidInstitutionId: "ins_3"` for Plaid-covered institutions, null for
  native-only institutions

The critical demarcation: the Provider Catalog entry for "Plaid" (`slug:
"plaid"`) does not know which institutions Plaid covers — that would require
mirroring 12,000 rows. The Institution Catalog entry for "Chase" (`slug:
"chase"`) knows that Chase is reachable via `{ providerSlug: "plaid",
priority: 1 }` — that is Fourth Meridian's resolution logic, not
institution data. The two are linked by the Institution Catalog referencing
Provider Catalog slugs, never the reverse.

**Illustrative Institution Catalog shapes (not committed code):**

```ts
// An institution with only Plaid support today:
{
  slug: "chase",
  displayName: "Chase",
  plaidInstitutionId: "ins_3",
  providers: [{ providerSlug: "plaid", priority: 1 }],
}

// A future institution with native support + Plaid fallback:
{
  slug: "schwab",
  displayName: "Charles Schwab",
  plaidInstitutionId: "ins_12",
  providers: [
    { providerSlug: "schwab-native", priority: 1 }, // future
    { providerSlug: "plaid",         priority: 2 }, // fallback
  ],
}

// An institution with no Plaid support — native only:
{
  slug: "coinbase",
  displayName: "Coinbase",
  plaidInstitutionId: null,
  providers: [
    { providerSlug: "coinbase-native", priority: 1 }, // future adapter
    { providerSlug: "csv",             priority: 2 }, // import fallback today
  ],
}
```

### 3.4 — Should Institution Catalog be code-defined, provider-fed, or database-backed?

The answer is tiered, and getting the tier wrong for each population source
is the primary architectural risk.

**Tier 1 — Featured institutions with native adapters (code-defined,
small).**
Institutions where Fourth Meridian has or is building a native adapter
(Coinbase, Schwab, Kraken) should be a small, code-defined list in
`lib/institutions/featured.ts` or similar. This list will grow slowly and
only when a native adapter is under active development — exactly the same
lifecycle as Provider Catalog entries. Code-defined is correct here.

**Tier 2 — General Plaid-covered institutions (provider-fed, not Fourth
Meridian's data to own).**
Plaid covers ~12,000+ institutions. Fourth Meridian should not own, cache,
or maintain this data. For general institution search ("find my bank"),
Fourth Meridian should call Plaid's `/institutions/search` API on-demand
(or keep using Plaid Link's own institution search UI) and present the
results. This is a provider-fed discovery pattern: Fourth Meridian provides
the search surface and the resolution layer, Plaid provides the underlying
institution data.

This is a critical distinction: the product vision asks Fourth Meridian to
*own the discovery experience*, not to *own the institution data*. These
are different things. Fourth Meridian can present a seamless "Search
institutions..." UI that calls Plaid's search API behind the scenes — the
user never needs to know the data source — while Plaid continues to own
the institution list, the logos, the OAuth support flags, and the
maintenance burden.

**Tier 3 — Institutions with confirmed native adapters (database-backed,
when they exist).**
When the first native adapter ships (e.g. a direct Coinbase API adapter),
the Institution Catalog entry for that institution should become a DB row.
A DB row supports: admin-editable provider rankings, A/B testing of
provider priority, eventual marketplace attribution. But this tier does not
exist yet and should not be built speculatively — the same "no concrete
feature yet" rule that deferred marketplace tables in D9/D10 applies here.

**MVP answer for v2.4:** Tier 1 only, code-defined. Tier 2 is Plaid API
on-demand when the institution search UI is built. Tier 3 waits for the
first native adapter to actually ship.

### 3.5 — How would Plaid institution metadata fit into this design?

Plaid's `/institutions/search` API returns per-institution metadata that
Fourth Meridian does not currently use: `institution_id`, `name`, `logo`
(base64 PNG), `url`, `oauth` (boolean), `products` (which Plaid products
are available). This is rich enough to build a real institution picker
without any Fourth Meridian-side DB table for the general case.

The correct usage pattern is on-demand, not cached:

1. User types in institution search box.
2. Debounced call to a Fourth Meridian API route that proxies Plaid's
   `/institutions/search` with the query string.
3. Results are displayed with logo, name, and "Available through: Plaid."
4. User selects an institution.
5. Plaid Link is opened, pre-seeded with the selected `institution_id`
   using Plaid's `institution_id` parameter in the link token creation.
   Plaid Link then jumps straight to that institution's OAuth or credential
   form, skipping its own search step.

This pattern gives Fourth Meridian full control of the discovery UI while
delegating institution data maintenance to Plaid entirely. It also avoids
the logo storage problem (base64 PNGs from Plaid's API can be passed
directly to the UI without caching them in an S3 bucket or DB field).

**What already exists in the schema to support this:**

- `PlaidItem.institutionId` already captures Plaid's `institution_id` after
  connection. This field becomes the join key if Fourth Meridian ever needs
  to link a connected `PlaidItem` back to an Institution Catalog entry (e.g.
  "you are already connected to Chase — add more accounts?").
- `FinancialAccount.institution` and `FinancialAccount.institutionId` carry
  the institution identity down to the account level, already indexed.

No schema changes are needed to support the on-demand Plaid search
pattern. The existing fields are sufficient.

### 3.6 — How would native providers coexist with Plaid institutions?

The key insight: "Available through: ✓ Native Schwab ✓ Plaid" is an
*Institution Catalog* resolution result, not a *Provider Catalog* display.
The Provider Catalog entries `"schwab-native"` and `"plaid"` exist
independently and don't know about each other. The Institution Catalog
entry for "Charles Schwab" holds the resolution list:
`providers: ["schwab-native" (priority 1), "plaid" (priority 2)]`.

The resolution layer at the Institution Catalog level is the only place in
the architecture where "provider A and provider B both support institution
X" is expressed. Neither provider knows about the other. Neither needs to.

**When a native adapter ships, the workflow is:**

1. Add `schwab-native` to Provider Catalog (set `enabled: true` in
   `lib/providers/catalog.ts`) with dispatch
   `{ kind: "connection", providerType: ProviderType.BROKERAGE }`.
2. Add or update the Institution Catalog entry for "schwab" to include
   `{ providerSlug: "schwab-native", priority: 1 }` before the existing
   `{ providerSlug: "plaid", priority: 2 }`.
3. The resolution layer automatically shows both options to the user.
4. Existing Plaid connections to Schwab are unaffected — they continue
   through `PlaidItem` unchanged.

No Provider Catalog changes are needed when the resolution list changes.
No Institution Catalog changes are needed when a Provider Catalog entry
changes its dispatch mechanics. The layers are genuinely independent.

### 3.7 — Provider resolution when multiple providers support one institution

Resolution is a simple priority-ordered list with all options visible to
the user. The design principles:

1. **Show all available options, ranked by quality.** The user should see
   "Available through: Native Schwab (recommended) · Plaid (also available)"
   rather than auto-selecting the best option silently. Auto-selection is
   correct for a single-provider institution (where there is no choice to
   make), but when two real options exist, the user deserves to know.
2. **Rank by data quality, not convenience.** Native (direct API) > Plaid
   aggregator > import (file-based) > manual. This ranking reflects data
   freshness, sync reliability, and user effort.
3. **The recommended option is shown first.** The first entry in the
   institution's `providers` array is the default pre-selection. The user
   can change it.
4. **Disabled providers do not appear.** A provider with `enabled: false`
   in the Provider Catalog does not appear in any institution's resolution
   list, even if the Institution Catalog entry references it. The check
   happens at resolution time, not at catalog definition time.
5. **Resolution is synchronous and local.** For v2.x, resolution is a
   pure in-memory lookup: given an institution slug, return its
   `providers` array filtered by `Provider Catalog.enabled`. No DB query,
   no network call. Fast enough to happen on institution selection.

### 3.8 — Should the future Add Account flow search institutions rather than providers?

Yes, for the connection-type path. But the Add Account flow has two
fundamentally different branches that should not be collapsed into one:

**Branch 1 — Connect an account at a financial institution.**
Institution-first. The user searches for their bank, brokerage, or
exchange. Fourth Meridian resolves the best available provider(s). The
user confirms or picks, then the provider-specific launch flow runs.

**Branch 2 — Import data from a file or service.**
Method-first. The user already knows they have a CSV export, an Excel
file, or a QuickBooks file. They pick the format and upload. There is no
institution to discover — the import pipeline does not care which
institution the file came from.

These branches are not interchangeable. Branch 1 is institution-led.
Branch 2 is format-led. The Add Account UX should present them as two
distinct paths:

```
What would you like to add?

[Search for your bank, brokerage, or exchange...]  → Branch 1: Institution discovery
[Import from a file]                               → Branch 2: Format picker (CSV / Excel / QuickBooks)
[Add crypto wallet]                                → Wallet address entry (no institution)
[Add manually]                                     → Manual account creation (no institution)
```

Provider Catalog powers all four branches internally. Institution Catalog
powers only Branch 1. The user sees institution names in Branch 1 and
format names in Branch 2 — they never see "Plaid" as a top-level choice.

### 3.9 — Where do Wallet, CSV, Excel, QuickBooks, and Manual fit?

None of them belong in the Institution Catalog. Each has a different
reason:

**Wallet.** A crypto wallet is not an institution. It is a public address
on a blockchain. There is no "Chase of crypto" to search for. The wallet
flow is address-entry, not institution-discovery. It belongs as a
top-level option ("Add crypto wallet") in the Add Account UX, routing
directly through the Provider Catalog entry for `"wallet"`.

**CSV / Excel / QuickBooks.** These are file formats, not institutions.
A CSV export from Chase is not a "Chase connection" — it is a file that
happens to contain Chase transaction data. The import flow is
format-first by nature. These belong in the Provider Catalog as import
entries and route through Branch 2 of the Add Account UX, not through the
Institution Catalog at all.

One nuance worth naming: a future institution entry for "Chase" could
optionally note that Chase offers CSV export (as a fallback option when
native or Plaid is unavailable or undesired). That would be represented
as `{ providerSlug: "csv", priority: 3 }` in Chase's resolution list —
not a separate Institution Catalog category, but an additional provider
in the same entry's list. This is an edge case and should not influence
the v2.4 design.

**Manual.** Manual accounts have no institution, no file, and no
connection. They are created entirely from user input. Manual belongs as
a top-level option ("Add manually") in the Add Account UX, routing
directly through `{ kind: "manual" }` in Provider Catalog dispatch.

**Summary:** CSV, Excel, QuickBooks, Wallet, and Manual are all
Provider Catalog-routed. They exist outside the Institution Catalog
entirely. This is correct and clean: the Institution Catalog is the
discovery layer for things that have a real-world institutional identity.
Import formats, wallets, and manual entries do not.

### 3.10 — Does this change any D6 recommendation?

**No existing D6 recommendation changes.** The Institution Catalog is
an additive layer above the Provider Catalog, not a replacement or a
revision. Every finding in `D6_PROVIDER_CATALOG_INVESTIGATION.md` and
`D6_PROVIDER_DISCOVERY_INVESTIGATION.md` remains valid:

- Provider Catalog is still `lib/providers/catalog.ts`, code-defined,
  ~9 entries, discriminated dispatch union.
- D7's admin CRUD route is still superseded for this era.
- Slice 1 is still the right first implementation step.
- The one-way dependency rule (catalog → consumed by UI, never by adapters)
  still holds.

**What this investigation adds is a confirmed two-layer architecture and a
clear sequencing rule:**

Provider Catalog is a prerequisite for Institution Catalog. Institution
Catalog references Provider Catalog slugs. The implementation sequence is
therefore: Provider Catalog first (Slice 1), Institution Catalog later
(when the "Add Account" UI redesign is scoped or when the first native
adapter ships).

**One Provider Catalog implication confirmed here:**

The disabled entries for Coinbase, Schwab, and Kraken in Provider Catalog
(`enabled: false`) should not be exposed as browsable Institution Catalog
entries until their providers are `enabled: true`. But the Provider
Catalog slugs for those entries should be chosen now with Institution
Catalog in mind. Specifically:

- `"coinbase"` as a Provider Catalog slug works if Coinbase is the only
  provider available. But once a native Coinbase adapter exists alongside
  a CSV import path, the Provider Catalog has one entry `coinbase-native`
  (dispatch: `EXCHANGE`) and one entry `csv` (dispatch: `CSV`), while the
  Institution Catalog has one entry `coinbase` that references both
  providers. The Institution Catalog slug (`"coinbase"`) and the Provider
  Catalog slug (`"coinbase-native"`) are different identifiers.

This is a slug naming clarification, not a design change: Provider Catalog
slugs name *integration methods*; Institution Catalog slugs name
*institutions*. They may coincidentally share a name (like "Plaid" —
both the institution catalog entry for "Plaid-connected banks" and the
provider catalog entry are conceptually called "Plaid"), but they are
in different registries with different meanings.

---

## 4. Two-layer architecture summary

```
User: "Search institutions..."
           │
           ▼
┌──────────────────────────────────────┐
│         INSTITUTION CATALOG          │   User-facing discovery layer.
│                                      │   Owns: institution identity, provider
│  chase → providers: [plaid:1]        │   resolution list, Plaid institution_id
│  schwab → providers: [native:1,      │   linkage. For general search: wraps
│            plaid:2]                  │   Plaid /institutions/search on-demand.
│  coinbase → providers: [native:1,    │   For featured institutions: code-defined
│              csv:2]                  │   small list. DB-backed only when native
└─────────────────┬────────────────────┘   adapters actually ship.
                  │  (references provider slugs)
                  ▼
┌──────────────────────────────────────┐
│          PROVIDER CATALOG            │   Internal routing layer. Fourth
│                                      │   Meridian-owned entirely. Code-defined,
│  plaid   → { kind: connection, PLAID}│   ~9 entries. Never shown to users
│  wallet  → { kind: connection, WALL} │   directly. Slug is the stable join key
│  csv     → { kind: import,  CSV }   │   to Institution Catalog.
│  excel   → { kind: import, EXCEL }  │
│  manual  → { kind: manual }         │
│  coinbase-native → enabled: false    │
└─────────────────┬────────────────────┘
                  │  (dispatches to)
                  ▼
┌──────────────────────────────────────┐
│             ADAPTERS                 │   lib/providers/plaid/adapter.ts,
│                                      │   lib/imports/provider-capabilities.ts,
│  plaidAdapter.refreshItem()          │   future coinbase/adapter.ts etc.
│  plaidAdapter.syncTransactions()     │   Never imported by catalog layers.
│  getImportProviderCapabilities()     │
└──────────────────────────────────────┘
```

**The data flows strictly downward.** Institution Catalog references
Provider Catalog slugs. Provider Catalog dispatches to adapters. No
upward references exist at any layer.

---

## 5. Architectural risks specific to the two-layer model

**Risk 1 (Medium) — Slug namespace collision.**
Provider Catalog slugs name integration methods; Institution Catalog slugs
name institutions. If both layers use `"coinbase"` as a slug for different
things, any future code that tries to resolve "coinbase" becomes ambiguous.
Mitigation: adopt a convention now — Institution Catalog slugs are always
institution names (nouns: `"coinbase"`, `"schwab"`, `"chase"`); Provider
Catalog slugs for native adapters are `"{institution}-native"` (e.g.
`"coinbase-native"`, `"schwab-native"`). Provider Catalog slugs for generic
methods keep their current names (`"plaid"`, `"csv"`, `"wallet"`). No
collision is possible under this convention.

**Risk 2 (Medium) — Plaid institution search as an API boundary.**
Proxying Plaid's `/institutions/search` through a Fourth Meridian API
route introduces a Plaid API dependency at search-time, not just at
connect-time. Rate limits, latency, and Plaid API errors now affect the
institution search experience. Mitigation: debounce searches, cache
results client-side per session, and degrade gracefully (show "We couldn't
search institutions right now — connect directly" with a fallback to the
current Plaid Link flow). The fallback is already live and requires zero
changes.

**Risk 3 (Low-Medium) — Plaid institution_id drift.**
Plaid occasionally retires and replaces `institution_id` values. The
`PlaidItem.institutionId` field stores these IDs today. If Institution
Catalog entries are linked to Plaid `institution_id` values in a future
DB-backed tier, retired IDs would orphan those entries.
Mitigation: Institution Catalog entries should carry their own stable
Fourth Meridian slug as the primary key, with `plaidInstitutionId` as an
optional, nullable cross-reference — not as the primary identifier. This
is consistent with how `ProviderAccountIdentity` models the identity layer
(platform ID as the PK, provider ID as a FK).

**Risk 4 (Low) — "You're already connected" path.**
When a user searches "Chase" and they already have a Plaid connection to
Chase, the expected behavior is "add more accounts from your existing Chase
connection" rather than initiating a fresh Link flow. This is a UX concern,
not a catalog concern, but the Institution Catalog's `plaidInstitutionId`
field is what makes this detection possible: look up `PlaidItem` rows for
the current user where `institutionId` matches. This detection capability
is already latent in the schema today and does not require any catalog
change — it just needs to be wired in the future Add Account UI.

**Risk 5 (Low) — Premature DB-backing of Institution Catalog.**
The temptation to build a full `InstitutionCatalog` DB model immediately
is predictable, and should be resisted. The "no concrete feature yet" rule
that correctly deferred `CreatorPayout`, `SpaceRating`, and Platform-Ops
tables applies equally here. Tier 1 (featured institutions, code-defined)
is the correct v2.4 scope. Tier 3 (DB-backed) only makes sense once a
native adapter is shipping and admin-editable provider rankings are an
actual operational need, not a hypothetical one.

---

## 6. MVP recommendation

For v2.4, the only required change is Provider Catalog Slice 1 from
`D6_PROVIDER_CATALOG_INVESTIGATION.md`. Institution Catalog has no
implementation at this stage.

The two immediate Institution Catalog deliverables that can be produced
without implementation are:

1. **Slug naming convention** (stated in §5 Risk 1 above) — adopt before
   Slice 1 ships so Provider Catalog slugs are compatible with the future
   Institution Catalog. Specifically: rename the three disabled Provider
   Catalog entries from `"coinbase"` / `"schwab"` / `"kraken"` to
   `"coinbase-native"` / `"schwab-native"` / `"kraken-native"`. This is a
   one-word change per entry in the Provider Catalog registry that doesn't
   affect dispatch or enabled state.

2. **Architecture decision record** (this document) — the two-layer model
   is settled here and should not be re-derived by whoever builds the Add
   Account UI or the first native adapter.

The full Institution Catalog implementation (search UI, Plaid
`/institutions/search` proxy, featured institutions list, provider
resolution display) is deferred until the Add Account redesign is scoped
as a product initiative. That initiative should include Institution Catalog
as a prerequisite, not discover it mid-implementation.

---

## 7. Recommended implementation sequence (both layers combined)

| # | Layer | Step | Trigger | Risk |
|---|---|---|---|---|
| 1 | Provider Catalog | Slice 1: `lib/providers/catalog.ts`, ~9 entries including disabled placeholders with `-native` slug suffix convention | Approved now | Low |
| 2 | Provider Catalog | Slice 2: wire one read-only consumer | After Slice 1 | Low |
| 3 | Institution Catalog | Tier 1: `lib/institutions/featured.ts`, small code-defined list of native-provider institutions (Coinbase, Schwab, Kraken) with provider resolution list | When Add Account UI is scoped | Low |
| 4 | Institution Catalog | Plaid on-demand search: a Fourth Meridian API route proxying Plaid `/institutions/search`, pre-seeding Plaid Link with the selected institution_id | Same scope as step 3 | Low-Medium |
| 5 | Institution Catalog | Provider resolution UI: "Available through: ✓ Native · ✓ Plaid" display for featured institutions | Same scope as steps 3-4 | Low |
| 6 | Institution Catalog | Tier 3: DB-backed Institution Catalog entry for the first institution with a shipping native adapter | When first native adapter ships in branch 3 or later | Medium |
| 7 | Institution Catalog | Full marketplace integration: Institution Catalog entries gain Framework/Template associations | When `feature/marketplace-v1` is scoped | Medium |

Steps 1-2 are the only v2.4 scope. Steps 3-5 are the "Add Account
redesign" scope. Steps 6-7 are post-native-adapter and post-marketplace
respectively.

---

## 8. Stop point

This document is the complete deliverable for this investigation phase.
No schema, migration, route, UI, or roadmap documentation was modified.

The architectural verdict:

- **Provider Catalog is confirmed as the internal routing layer.** No
  change to any prior recommendation.
- **Institution Catalog exists as a distinct layer above Provider Catalog.**
  It is user-facing, institution-scoped, and not built in v2.4.
- **The two-layer model has a clear precedent and a clear sequencing rule.**
  Provider Catalog first; Institution Catalog when the Add Account redesign
  is scoped or when the first native adapter ships, whichever comes first.
- **The only actionable change to Slice 1** is adopting the slug naming
  convention (`coinbase-native` not `coinbase`) before the Provider Catalog
  registry is written.
