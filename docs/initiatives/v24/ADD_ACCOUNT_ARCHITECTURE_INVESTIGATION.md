# Add Account — Canonical Architecture Investigation

**Status: Investigation only. No schema, migration, API route, UI, or
application code was modified to produce this document.**

Branch: `feature/phase-2-architecture`. Baseline: `v2.4`.

---

## 0. Document control

| | |
|---|---|
| Scope | Define the canonical platform architecture for adding accounts — lifecycle, entity creation order, catalog boundaries, provider resolution, adapters, duplicates, imports, wallets, manual |
| Sources read | `PHASE_2_ARCHITECTURE_FREEZE.md`, `PHASE_2_DECISION_MATRIX.md`, `D6_PROVIDER_CATALOG_INVESTIGATION.md`, `D6_INSTITUTION_CATALOG_INVESTIGATION.md`, `D6_PROVIDER_DISCOVERY_INVESTIGATION.md`, `V24_COMPLETION_PLANNING_INVESTIGATION.md`, `prisma/schema.prisma` (full), `lib/providers/catalog.ts`, `lib/accounts/reconcile.ts` (first 60 lines + comments), `lib/imports/` directory |
| Not in scope | UI design, implementation, schema changes, migrations |
| Product rule | Users choose WHAT they want to add. Fourth Meridian chooses HOW to connect it. |

---

## 1. The canonical onboarding pipeline

Every account addition — regardless of provider — follows one pipeline. It
is the same pipeline whether the source is Plaid, a wallet address, a CSV
file, QuickBooks, a manual entry, or a future native adapter.

```
User intent
    │
    ▼
Intent Classification
    │  (which of the four branches below?)
    ├── Search for institution  ──► Institution Catalog → Provider Resolution
    ├── Import from file         ──► Provider Catalog (import branch)
    ├── Add crypto wallet         ──► Provider Catalog (wallet branch)
    └── Add manually              ──► Provider Catalog (manual branch)
    │
    ▼
Provider Resolution
    │  (Institution Catalog resolves provider slugs;
    │   Provider Catalog resolves dispatch;
    │   disabled entries filtered out)
    ▼
Launch
    │  (provider-specific UX: Plaid Link, file picker,
    │   address entry, manual form)
    ▼
Connection (when applicable)
    │  (one row per institution credential)
    │  Plaid, Wallet, future natives → Connection created
    │  CSV/Excel/QuickBooks/Manual   → no Connection row
    ▼
Account Discovery / Import
    │  (DiscoveredAccount for connection flows,
    │   ImportBatch for import flows)
    ▼
Duplicate Detection
    │  (exact match → fingerprint fallback → new account)
    ▼
FinancialAccount
    │  (created if no match; reused if duplicate detected)
    ▼
ProviderAccountIdentity
    │  (one row per provider × external account id)
    ▼
AccountConnection
    │  (links FinancialAccount ↔ Connection/PlaidItem;
    │   isCanonical = true for primary source)
    ▼
SpaceAccountLink (HOME)
    │  (exactly one HOME row per FinancialAccount,
    │   in the Space the user added from)
    ▼
Snapshot Regeneration
    │  (SpaceSnapshot for every Space that holds this account)
    ▼
Done — account visible in dashboard
```

Every provider follows this spine. The provider-specific logic is isolated
to the "Launch" step and the "Account Discovery / Import" step. All steps
before and after those are provider-agnostic.

---

## 2. Canonical lifecycle / state machine

From button click to completed account, every step and its preconditions:

```
STATE: [No account]
    │
    │  TRIGGER: User clicks "Add Account"
    ▼
STATE: [Intent classification]
    │  UI presents four choices. User selects one.
    │  No entities created yet.
    ▼
STATE: [Provider resolution complete]
    │  Institution Catalog looked up (if institution flow).
    │  Provider Catalog entry retrieved.
    │  dispatch value known.
    │  No entities created yet.
    ▼
STATE: [Launch underway]
    │  Provider-specific UX running (Plaid Link modal, file picker, etc.).
    │  No entities created yet — nothing is committed until the launch
    │  completes successfully.
    ▼
STATE: [Launch success — raw provider data received]
    │  Plaid: access token + account list returned by onSuccess.
    │  Wallet: chain + address confirmed by user.
    │  Import: file parsed, rows validated.
    │  Manual: form submitted.
    │
    │  ENTITY CREATION BEGINS HERE.
    ▼
STATE: [Connection created] (Plaid, Wallet, future natives only)
    │  One Connection row per institution credential.
    │  If a Connection already exists for this
    │  (userId, provider, externalConnectionId), reuse it (Update Mode).
    │  Import and Manual flows: no Connection row.
    ▼
STATE: [Accounts discovered / imported]
    │  Connection flows: DiscoveredAccount rows created (one per provider
    │  account returned). Status = PENDING.
    │  Import flows: ImportBatch created; transactions parsed.
    ▼
STATE: [Duplicate detection complete] (per account / per ImportBatch)
    │  Exact match → existing FinancialAccount reused.
    │  Fingerprint match → existing FinancialAccount reused, stale rows
    │  merged (mergeArchivedDuplicateIntoCanonical), DuplicateAccountCandidate
    │  audit row written.
    │  No match → new FinancialAccount created.
    ▼
STATE: [FinancialAccount exists]
    │  New or reused. Canonical values (balance, type, institution, mask)
    │  written/updated from provider data.
    ▼
STATE: [ProviderAccountIdentity written]
    │  One row per (financialAccountId, provider, externalAccountId).
    │  connectionId FK populated if a Connection row exists.
    ▼
STATE: [AccountConnection written]
    │  Links FinancialAccount ↔ Connection (or PlaidItem during legacy era).
    │  isCanonical = true.
    │  connectedByUserId = requesting user.
    ▼
STATE: [SpaceAccountLink (HOME) written]
    │  Exactly one HOME row per FinancialAccount, in the Space the user
    │  added from. (computeLinkKind ensures uniqueness.)
    │  If account was already in this Space: status reactivated, kind
    │  confirmed HOME.
    ▼
STATE: [Snapshots regenerated]
    │  SpaceSnapshot recalculated for every Space that holds this account
    │  via SpaceAccountLink (HOME or SHARED).
    ▼
STATE: [Account complete — visible in dashboard]
```

---

## 3. Investigation findings

### 3.1 — Institution Catalog: where it begins and ends

**Begins:** The user selects "Search for your bank, brokerage, or exchange"
and types a name. Institution Catalog owns the search surface.

**What it contains:**
- For general search: wraps Plaid's `/institutions/search` API on-demand.
  Fourth Meridian does not own or cache Plaid's 12,000+ institution list.
- For featured institutions with native adapters (future): a small,
  code-defined list in `lib/institutions/featured.ts`.
- Institution identity: slug (FM's stable ID), displayName, logoUrl,
  institutionType.
- Provider resolution list: ranked array of Provider Catalog slugs that can
  connect to this institution.

**Ends:** After returning a ranked list of available providers for the
selected institution. Institution Catalog's job is done at this point. It
does not know how any provider works, and it does not participate in any
step after provider resolution.

**Currently:** Not built for v2.4. The slug naming convention
(`coinbase-native`, not `coinbase`) is the only v2.4 prerequisite, already
adopted in `lib/providers/catalog.ts`.

---

### 3.2 — Provider Catalog: where it begins and ends

**Begins:** Provider resolution hands off a provider slug. Provider Catalog
returns the corresponding `ProviderCatalogEntry` with its `dispatch` value.

**What it contains (current, live):**
`lib/providers/catalog.ts` — 9 entries, code-defined, static.

| slug | dispatch kind | enabled |
|---|---|---|
| `plaid` | `connection / PLAID` | true |
| `wallet` | `connection / WALLET` | true |
| `csv` | `import / CSV` | true |
| `excel` | `import / EXCEL` | true |
| `quickbooks` | `import / QUICKBOOKS` | true |
| `manual` | `manual` | true |
| `coinbase-native` | `connection / EXCHANGE` | false |
| `schwab-native` | `connection / BROKERAGE` | false |
| `kraken-native` | `connection / EXCHANGE` | false |

**Ends:** After returning the `dispatch` value to the launch-decision layer.
Provider Catalog does not know which institution was selected, does not
participate in account creation, and is never imported by adapters or API
routes.

**One-way dependency rule (binding):** `lib/providers/catalog.ts` may only
be imported by UI/launch-decision code and Institution Catalog resolution
logic. It must never be imported by `lib/plaid/*`, `lib/imports/*`, any
adapter, or any API route other than one whose job is explicitly "which
provider should the user pick."

---

### 3.3 — Provider Resolution: where it belongs

Provider resolution is a two-step lookup:

1. **Institution Catalog** receives the user's selected institution. Returns
   a ranked list of provider slugs (e.g. `["plaid"]` for Chase,
   `["coinbase-native", "csv"]` for Coinbase today).

2. **Provider Catalog** receives each slug. Returns the `ProviderCatalogEntry`
   (filtering out `enabled: false` entries at resolution time, not at
   catalog-definition time).

Resolution is synchronous, local, and pure — no DB queries, no network calls
for the Provider Catalog step. The Institution Catalog step may call
Plaid's `/institutions/search` for general search (a network call, but
not a DB write).

**Architecturally:** Provider resolution belongs in a future
`lib/institutions/resolve.ts` module that imports both catalogs and applies
the priority-ranked, filter-by-enabled logic. It does not exist yet and is
not a v2.4 implementation item.

---

### 3.4 — What "Launch" represents architecturally

Launch is the boundary between provider-agnostic pipeline logic and
provider-specific UX. It is the only step in the pipeline that varies
by provider.

| dispatch.kind | Launch |
|---|---|
| `connection / PLAID` | Open Plaid Link modal (existing `PlaidContext` flow) |
| `connection / WALLET` | Open wallet address entry modal (existing `AddWalletModal`) |
| `connection / EXCHANGE` | Open future Coinbase/Kraken auth flow (not yet built) |
| `connection / BROKERAGE` | Open future Schwab auth flow (not yet built) |
| `import / CSV` | Open file picker → CSV pipeline |
| `import / EXCEL` | Open file picker → Excel pipeline |
| `import / QUICKBOOKS` | Open QuickBooks connect flow → QB pipeline |
| `manual` | Open manual account form |

**Architecturally:** Launch is the point where the Provider Catalog's
`dispatch` value resolves to a concrete flow. The pipeline resumes after
the launch completes successfully (user returns with a token, a file, or
a confirmed address). If the user cancels launch, no entities are created
and the pipeline terminates cleanly.

**Nothing is created before Launch completes.** This is the key invariant.
No Connection, no FinancialAccount, no ImportBatch — nothing committed until
the launch returns success.

---

### 3.5 — Where adapters fit

Adapters live below the pipeline. They are never called by the catalog
or by the pipeline's orchestration layer — they are called by the specific
API routes that handle each provider's post-launch response.

```
Pipeline orchestration (provider-agnostic)
    └── Launch (provider-specific UX)
            └── [user completes Plaid Link / uploads file / enters address]
    └── Post-launch handler (API route, provider-specific)
            └── Adapter (lib/providers/{provider}/adapter.ts)
                    └── Provider Adapter interface (future, branch 3)
```

Current live adapters:
- `lib/providers/plaid/adapter.ts` — thin re-export of `refreshItem` /
  `syncTransactions`, identity marker `provider: ProviderType.PLAID`.
- Import pipeline (`lib/imports/pipeline.ts`, `csv.ts`, `excel.ts`,
  `lib/imports/provider-capabilities.ts`) — the de facto import adapter.

**What adapters must implement (future `ProviderAdapter` interface,
branch 3):**

```ts
interface ProviderAdapter {
  discoverAccounts(connection: Connection): Promise<DiscoveredAccountDTO[]>;
  syncActivity(connection: Connection): Promise<SyncResultDTO>;
  normalizeProviderData(raw: unknown): NormalizedAccountDTO;
}
```

**Binding rule:** Canonical tables (`FinancialAccount`, `Transaction`,
`Holding`) must never gain provider-specific columns. Provider-specific
metadata lives in `AccountConnection`, `ProviderAccountIdentity`, or detail
tables — never on the canonical row itself.

---

### 3.6 — When Connection should exist

A `Connection` row represents **one institution credential** — the persistent,
re-usable authentication with a single institution on behalf of one user.

| Flow | Connection? | Reason |
|---|---|---|
| Plaid | Yes — one per (user, institution) | Plaid access token is a persistent credential |
| Wallet (watch-only) | Yes | xpub/descriptor is a persistent watch credential |
| Future native (Coinbase, Schwab) | Yes | OAuth token is a persistent credential |
| CSV / Excel / QuickBooks import | No | No persistent credential; `ImportBatch.connectionId` is nullable seam for future wiring |
| Manual | No | No credential at all |

**Dedup rule for Connection:** A new Plaid Link flow for an institution where
the user already has an active `Connection` must use Plaid Link's Update
Mode rather than creating a fresh Connection. This is the fix for the current
`PlaidItem` duplication gap (§5.3 of the Architecture Freeze) and is a
behavior change in `exchange-token/route.ts` that must be part of branch 3.

**During the legacy era (now):** `PlaidItem` is still the credential store.
`Connection` exists in the schema but has no application writes. The
pipeline currently treats `PlaidItem` as the Connection-equivalent.

---

### 3.7 — When FinancialAccount should be created

`FinancialAccount` is created **after** duplicate detection confirms no
existing row should be reused.

Creation order within a single add-account transaction:

1. Duplicate detection runs (exact match → fingerprint match → no match).
2. If a match exists: use the existing `FinancialAccount`. Update canonical
   values (balance, `lastUpdated`) from provider data.
3. If no match: create a new `FinancialAccount` with:
   - `ownerType` = `USER` (personal add) or `SPACE` (Space-connected account)
   - `ownerUserId` / `ownerSpaceId` as appropriate
   - `createdByUserId` = requesting user (D11 — always set, non-nullable intent)
   - Canonical values from provider data
   - `deletedAt` null (active)

**FinancialAccount is the platform's canonical "one row per real-world account"
invariant.** Every other entity (ProviderAccountIdentity, AccountConnection,
SpaceAccountLink, SpaceSnapshot) attaches to it. It must never be hard-deleted.

---

### 3.8 — When ProviderAccountIdentity should be created

`ProviderAccountIdentity` is created **after** `FinancialAccount` exists —
either the found-or-created row.

One row per `(financialAccountId, provider, externalAccountId)`. The
constraint is per-financial-account, not globally unique, because the same
wallet address (same `externalAccountId`) can legitimately belong to
different users' `FinancialAccount` rows (different private interpretations
of the same public address — established by D2 Step 1D).

`connectionId` FK is populated if a `Connection` row exists for this flow.
During the legacy era, `connectionId` is null for Plaid rows (Connection is
not yet written by application code); these will be backfilled when branch 3
runs.

Current status: dual-written for PLAID (from `exchange-token/route.ts`) and
WALLET. Not yet read by any application code — write-only until a future
read-cutover step within branch 3.

---

### 3.9 — When AccountConnection should be created

`AccountConnection` is created **after** `FinancialAccount` exists.

It links a `FinancialAccount` to its credential source. One row per
`(financialAccount, source)`, with `isCanonical = true` for the authoritative
balance source. Supports multiple connections to one `FinancialAccount` (e.g.
two users both holding Plaid access to a joint account — each gets their own
`AccountConnection` row, one marked `isCanonical`).

During the legacy era: `plaidItemDbId` FK is set (not `connectionId`). When
branch 3's `Connection` model is populated, `connectionId` FK is set instead
(or dual-written). The evolution path is: add nullable `connectionId` FK,
dual-write, drop `plaidItemDbId` once `PlaidItem` retires.

For import flows: `AccountConnection` is not created. The `ImportBatch`
carries the provenance.

For wallet and manual flows: `AccountConnection` is created with `walletAddress`
populated (wallet) or both FKs null (manual — relies on `FinancialAccount`
itself as the sole identity record).

---

### 3.10 — When SpaceAccountLink should be created

`SpaceAccountLink` (HOME kind) is created **after** `AccountConnection`
exists, in the same request.

Rules:
- Exactly one `HOME` row per `FinancialAccount`. `computeLinkKind()` ensures
  this; the `manual/route.ts` race condition that previously violated this
  invariant was resolved in D3 Stage A.
- The HOME Space is the Space the user was in when they clicked "Add Account."
  For personal accounts added outside a Space context, HOME is the user's
  personal Space.
- If the account already has a `SpaceAccountLink` row for this Space:
  reactivate its status (`ACTIVE`) rather than creating a duplicate.
- The `@@unique([spaceId, financialAccountId])` constraint enforces no
  duplicate rows.

`SpaceAccountLink` is the canonical read/write model as of D3 Stage B
completion. `WorkspaceAccountShare` is retained temporarily during the bake
period before Stage C (table removal), which is intentionally deferred.

---

### 3.11 — When snapshots should regenerate

Snapshot regeneration happens **after** `SpaceAccountLink` is created —
synchronously, within the same request, for every Space that holds the
newly-created or updated account.

Current mechanism: `lib/snapshots/regenerate.ts`, called inline from
`exchange-token/route.ts` and similar post-import handlers. Not a scheduled
job — regeneration is event-driven, triggered by account creation or update.

Trigger rules:
- New account added to a Space (HOME or SHARED link) → regenerate that
  Space's snapshot.
- Account balance updated (sync) → regenerate all Spaces that hold this
  account via SpaceAccountLink.
- Account archived → regenerate all Spaces that held it.

`SpaceSnapshot` is a derived table (pre-aggregated net worth rollup). It
is safe to recompute and discard; it is never the source of truth.

---

### 3.12 — Where duplicate detection belongs

Duplicate detection belongs in **`lib/accounts/reconcile.ts`**, which already
implements two tiers:

**Tier 1 — Exact match:** `plaidAccountId` (globally `@unique`) or
`walletAddress` lookup. If found, return the existing `FinancialAccount`
and update it.

**Tier 2 — Fingerprint fallback:** `resolveAccountByFingerprint` — matches
on `(institutionId OR institution) + mask + type + (officialName OR plaidName OR name)`,
case-insensitive, trimmed. Handles Plaid's documented `account_id` reissue
behavior on reconnect. Picks one canonical row (most transaction history,
oldest on ties), merges all stale matches into it via
`mergeArchivedDuplicateIntoCanonical`, and writes a `DuplicateAccountCandidate`
row with `status = CONFIRMED_DUPLICATE` as an audit trail (D1 behavior,
confirmed from schema comments as now implemented).

**What does NOT belong in duplicate detection:**
- Any provider-specific logic. The fingerprint engine is provider-agnostic;
  it does not know how accounts arrived.
- Any user-visible blocking step for automatic merges. Automatic merging
  is the correct behavior for reconnects; the `DuplicateAccountCandidate`
  row provides audit visibility, not a gate.

**Future (DiscoveredAccount staging, branch 3):** When `DiscoveredAccount`
is introduced, duplicate detection will run against `DiscoveredAccount`
rows before promoting them to `FinancialAccount`. The reconciliation engine
is extended, not replaced.

---

### 3.13 — How imports attach to existing FinancialAccounts

Imports are not institution-discovery flows — they are history-extension
flows. The user chooses a file format AND an existing `FinancialAccount` to
attach the import to.

The pipeline:

1. User selects "Import from file" → picks format (CSV/Excel/QuickBooks).
2. User selects **which existing account** to import into (or opts to create
   a new one — an optional flow that creates a `FinancialAccount` first, then
   proceeds).
3. `ImportBatch` created: `financialAccountId` FK set, `source` set,
   `connectionId` null (for now; future seam).
4. Transactions parsed, deduplicated via fingerprint, written with
   `financialAccountId`.
5. Account's `balance` and `lastUpdated` optionally refreshed if the import
   includes a balance row.
6. `SpaceSnapshot` regenerated for all Spaces holding this account.

**Key architectural point:** imports do not create `Connection` rows, do not
create `ProviderAccountIdentity` rows (for the initial v2.4 import path),
and do not go through the institution-discovery branch of the pipeline. They
attach directly to `FinancialAccount`.

The `ImportBatch.connectionId` nullable FK is a forward seam for when a
future flow (e.g. recurring scheduled QuickBooks sync via a Connection) needs
to link an import batch to a persistent credential. It is not populated today.

---

### 3.14 — How hybrid onboarding fits (connect first, import history later)

Hybrid onboarding = user connects via Plaid first (gets live sync), then
supplements with an import of historical data from before the connection date.

The pipeline supports this natively because `FinancialAccount` is the central
entity. Both the connection and the import attach to the same
`FinancialAccount` row:

- `AccountConnection` records the Plaid link (live sync source).
- `ImportBatch` records the historical import (one-time history extension).
- Both write `Transaction` rows with `financialAccountId` set.
- Transaction fingerprinting (`D2_STEP4C`) prevents duplicates at the
  row level even if the import and the live sync overlap in date range.

No new entities or fields are needed for hybrid onboarding. The architecture
already models it. What is needed: a UI flow that presents "Add historical
transactions to this connected account" as an action on an existing account,
not as a new account creation. That is a product/UI concern, not an
architectural one.

---

### 3.15 — How wallets fit

Wallets are a connection-type flow with no institution discovery.

```
Add Account → "Add crypto wallet"
    → Provider Catalog: slug "wallet", dispatch { kind: "connection", providerType: WALLET }
    → Launch: AddWalletModal (chain + address entry)
    → Connection row: provider = WALLET, credential = xpub/descriptor (watch-only)
    → Account discovery: on-chain balance lookup (future adapter) or manual entry
    → Duplicate detection: walletAddress exact match per owner
    → FinancialAccount: type = crypto, institution = chain name
    → ProviderAccountIdentity: provider = WALLET, externalAccountId = address
    → AccountConnection: walletAddress populated
    → SpaceAccountLink (HOME)
    → SpaceSnapshot regeneration
```

**Key differences from bank connections:**
- No institution search; the user enters the address directly.
- Duplicate detection is per-owner (wallet addresses are public; two
  different users can both watch the same address — each gets their own
  `FinancialAccount`).
- No Plaid involved at any step.
- `Connection.credential` stores the xpub/descriptor watch string (encrypted
  via HKDF-derived key, D14). Private keys are never stored.

---

### 3.16 — How manual accounts fit

Manual accounts are the minimal path — no credential, no import, no
institution discovery.

```
Add Account → "Add manually"
    → Provider Catalog: slug "manual", dispatch { kind: "manual" }
    → Launch: manual account form (name, type, balance, institution)
    → No Connection row
    → No account discovery / duplicate detection (user-confirmed new account)
    → FinancialAccount: created from form data
    → No ProviderAccountIdentity (no external identity to record)
    → AccountConnection: created with both FKs null (manual provenance marker)
    → SpaceAccountLink (HOME)
    → SpaceSnapshot regeneration
```

Manual accounts are the lowest-fidelity path. They have no sync mechanism,
no recurring update, and no reconciliation logic. They are updated manually
by the user.

**Architectural note:** Should a manual account ever be connected to a
provider later (user finds their bank is supported), the flow is: create a
new Connection → run provider's account discovery → fingerprint-match to the
existing manual `FinancialAccount` → merge history → update
`AccountConnection` to point at the Connection. The reconciliation engine
handles this without a new code path.

---

### 3.17 — Which parts are provider-specific vs. provider-agnostic

**Provider-agnostic (same for all providers):**
- Intent classification
- Duplicate detection (reconcile.ts)
- FinancialAccount creation/update
- ProviderAccountIdentity creation
- AccountConnection creation
- SpaceAccountLink (HOME) creation
- SpaceSnapshot regeneration

**Provider-specific (varies by provider):**
- Institution discovery (Plaid: API search; featured: code list; wallet/import: none)
- Launch UX (Plaid Link modal, file picker, address form, QB connect)
- Post-launch data normalization (adapter's `normalizeProviderData`)
- Credential storage format (`Connection.credential` contents)
- Account discovery (adapter's `discoverAccounts` — provider returns different shapes)
- Sync mechanism (adapter's `syncActivity` — incremental cursor, polling, webhook)

**The adapters are the only provider-specific code that the pipeline ever
touches.** Everything above and below them is shared.

---

## 4. Canonical lifecycle diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          ADD ACCOUNT PIPELINE                               │
│                    (one pipeline; all providers follow it)                  │
└─────────────────────────────────────────────────────────────────────────────┘

USER INTENT
───────────
  "Add Account"
       │
       ▼
  ┌─────────────────────────────────┐
  │        Intent Classification    │  NO entities created
  │                                 │
  │  ┌─ Search bank / brokerage ───►│─► Institution Catalog
  │  │                              │         │
  │  ├─ Import from file           ─┼────┐    │ provider slugs
  │  │                              │    │    ▼
  │  ├─ Add crypto wallet          ─┼────┤  Provider Catalog
  │  │                              │    │  (dispatch lookup)
  │  └─ Add manually               ─┼────┘    │
  │                                 │         │ dispatch value
  └─────────────────────────────────┘         ▼

PROVIDER RESOLUTION (institution flow only)
──────────────────────────────────────────
  Ranked provider list → filter enabled → best available
  (synchronous, in-memory, no DB write)

LAUNCH (provider-specific UX)
─────────────────────────────
  Plaid → Plaid Link modal
  Wallet → address entry
  Import → file picker + pipeline
  Manual → manual form
  [user completes or cancels — if cancel: pipeline terminates, no writes]

╔══════════════════════════════════════════════════════════════════════════╗
║  ENTITY CREATION BEGINS HERE (only after successful launch)              ║
╚══════════════════════════════════════════════════════════════════════════╝

  ┌──────────────────────────────────────────────────────────────────────┐
  │ Connection (Plaid, Wallet, future natives only)                       │
  │  • 1 row per (userId, provider, externalConnectionId)                │
  │  • If exists → reuse (Update Mode); if new → create                  │
  │  • credential encrypted (HKDF-derived key, D14)                      │
  │  • Import + Manual: NO Connection row                                 │
  └──────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │ Account Discovery / Import                                            │
  │  Connection flows:  DiscoveredAccount rows (status=PENDING)          │
  │  Import flows:      ImportBatch + transaction parsing                │
  │  Manual:            direct form data                                  │
  └──────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │ Duplicate Detection (lib/accounts/reconcile.ts)                      │
  │  Tier 1: exact match (plaidAccountId, walletAddress)                 │
  │  Tier 2: fingerprint fallback (institution + mask + type + name)     │
  │  Result: existing FinancialAccount (reuse) OR new (create)           │
  │  On merge: DuplicateAccountCandidate row written (audit log)         │
  └──────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │ FinancialAccount                                                      │
  │  • ownerType / ownerUserId / ownerSpaceId                            │
  │  • createdByUserId (D11 — always set)                                │
  │  • canonical values from provider data                               │
  │  • never hard-deleted                                                 │
  └──────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │ ProviderAccountIdentity (connection flows only)                       │
  │  • 1 row per (financialAccountId, provider, externalAccountId)       │
  │  • connectionId FK when Connection exists                            │
  │  • per-owner uniqueness (not global) — D2 Step 1D                   │
  └──────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │ AccountConnection                                                     │
  │  • links FinancialAccount ↔ Connection (or PlaidItem, legacy era)    │
  │  • isCanonical = true (primary balance source)                       │
  │  • connectedByUserId = requesting user                               │
  │  • multiple connections per account supported                        │
  └──────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │ SpaceAccountLink (HOME kind)                                          │
  │  • exactly 1 HOME row per FinancialAccount                           │
  │  • Space = the Space user added from (or personal Space)             │
  │  • reactivate if row exists; create if new                           │
  │  • @@unique([spaceId, financialAccountId]) enforced                  │
  └──────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │ SpaceSnapshot regeneration                                            │
  │  • inline, event-driven (not scheduled)                              │
  │  • all Spaces holding this account via SpaceAccountLink              │
  │  • derived table — safe to recompute                                 │
  └──────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                   Account visible in dashboard
```

---

## 5. Architectural risks

**Risk 1 (Resolved) — D3 HOME race condition**
The `manual/route.ts` `Promise.all` race that could produce multiple HOME rows
for the same `FinancialAccount` was resolved in D3 Stage A. Every
account-creation path now writes `SpaceAccountLink` sequentially. The invariant
(exactly one HOME per `FinancialAccount`) is enforced in code, not just by
convention.

**Risk 2 (High) — Connection dedup depends on Plaid Update Mode (not yet
built)**
The `Connection` table's `@@unique([userId, provider, externalConnectionId])`
dedup only works if `exchange-token/route.ts` detects an existing Connection
for the same institution and invokes Plaid Link in Update Mode rather than
always starting fresh. This behavior change is not yet implemented. Until it
is, reconnects will create duplicate `Connection` rows (the same gap that
exists today for `PlaidItem`). This must be named explicitly as a dependency
in branch 3's design doc.

**Risk 3 (Medium) — No staging step between discovery and account creation
(current state)**
Today there is no `DiscoveredAccount` table. Plaid accounts go directly from
the `onSuccess` callback to `FinancialAccount` creation in the same request.
This means there is no opportunity for the user to review, rename, or dismiss
discovered accounts before they appear in the dashboard. `DiscoveredAccount`
(branch 3) introduces this staging step. Until it lands, every Plaid account
discovered is immediately imported — including accounts the user may not want.

**Risk 4 (Medium) — Snapshot regeneration is synchronous and inline**
`lib/snapshots/regenerate.ts` is called in the same API request as account
creation. For users with many Spaces or complex portfolios, this can add
meaningful latency to the add-account response. Acceptable for v2.4, but
should be flagged before the first public release at scale: moving snapshot
regeneration to a background job is the eventual path.

**Risk 5 (Medium) — Plaid institution_id drift**
`PlaidItem.institutionId` and `FinancialAccount.institutionId` store Plaid's
`institution_id` values. Plaid occasionally retires and replaces these IDs.
If Institution Catalog entries are ever linked by `plaidInstitutionId` in a
DB-backed tier, retired IDs would orphan those entries. Mitigation: FM slug
is the primary key; `plaidInstitutionId` is a nullable cross-reference, not
an identifier. Already noted in `D6_INSTITUTION_CATALOG_INVESTIGATION.md`.

**Risk 6 (Medium) — Imports attaching to wrong FinancialAccount**
When a user imports a CSV and selects "which account is this for?" from a
dropdown, there is no provider-level validation that the selected account
matches the data in the file. A user could attach a Chase CSV to a Robinhood
account. The import will succeed. The only guard is transaction fingerprinting,
which will write those transactions to whichever account was selected.
Mitigation: future institution auto-detection from CSV headers (already noted
in `D2_STEP4D1_CSV_IMPORT_MVP_INVESTIGATION.md`) reduces this risk. Not an
architectural fix — a UX-quality fix.

**Risk 7 (Low) — Provider Catalog slug stability**
Slugs defined in `lib/providers/catalog.ts` will be referenced by future
`SpaceTemplate` rows and `AuditLog` entries. Renaming a slug is a data
migration event, not a cosmetic edit. Treat slug changes the same way Prisma
treats enum value renames — as a migration event. Already documented in the
module header.

**Risk 8 (Low) — Institution Catalog / Provider Catalog namespace collision**
Provider Catalog slugs name integration methods (`coinbase-native`). Institution
Catalog slugs name institutions (`coinbase`). The `-native` suffix convention
is already adopted in `lib/providers/catalog.ts`. Must be enforced as a
naming rule when Institution Catalog is built.

---

## 6. Recommended implementation order

The pipeline is already partially built. Work falls into three tiers:

### Tier 1 — Already live (no action needed)
- `lib/providers/catalog.ts` (D6 Slice 1) — Provider Catalog ✅
- `lib/accounts/reconcile.ts` — duplicate detection (both tiers) ✅
- `lib/accounts/space-account-link.ts` — SpaceAccountLink canonical read/write ✅
- `lib/encryption/` — HKDF key derivation (D14) ✅
- Import pipeline (CSV, Excel, QuickBooks) — D2 Steps 4D1–4D4 ✅
- `lib/snapshots/regenerate.ts` — inline snapshot regeneration ✅
- D3 Stage A — HOME race fix, `accounts/[id]/route.ts` auth read migrated ✅
- D3 Stages B1–B4 — all 12 write paths cut over to SpaceAccountLink ✅
- `WorkspaceAccountShare` bake period in progress; Stage C (table removal) intentionally deferred ✅

### Tier 2 — Open work, approved direction, defined slices

| # | Item | Branch | Prerequisite | Risk |
|---|---|---|---|---|
| 1 | D3 Stage C — freeze amendment + `WorkspaceAccountShare` table removal | `feature/space-account-link-migration` | Bake period clear | Medium |
| 2 | `Connection` model wiring (Plaid Update Mode + `connectionId` dual-write on `AccountConnection`) | `feature/provider-adapter-layer` | D3 Stage B ✅ | Medium |
| 3 | Generic `ProviderAdapter` interface + `DiscoveredAccount` staging | `feature/provider-adapter-layer` | Connection wiring | Medium |
| 4 | D6 Slice 2 — wire one read-only Provider Catalog consumer | Standalone | Slice 1 ✅ | Low |

### Tier 3 — Deferred, clear triggers

| Item | Trigger |
|---|---|
| Institution Catalog (search UI + Plaid proxy) | Add Account UI redesign scoped as a product initiative |
| Provider resolution UI ("Available through: Native · Plaid") | Same scope as Institution Catalog |
| DB-backed Institution Catalog entries | First native adapter (Coinbase/Schwab) shipping |
| `DiscoveredAccount` review step in Add Account flow | After `DiscoveredAccount` staging (Tier 2 item 5) |
| Background snapshot regeneration (job, not inline) | Scale pressure from production traffic |
| `feature/published-account-view` | `SpaceAccountLink` fully canonical; public Space concept |

---

## 7. The one-pipeline rule (binding)

Every future connection method — any new native provider, any new import
format, any future marketplace integration — must enter the platform through
this pipeline. No shortcut paths that create `FinancialAccount` rows without
going through duplicate detection, `SpaceAccountLink`, and snapshot
regeneration are permitted. The pipeline is not optional plumbing; it is
the platform's data integrity guarantee.

Concretely:
- No API route may create a `FinancialAccount` without calling or
  functionally replicating `lib/accounts/reconcile.ts`.
- No API route may create a `FinancialAccount` without also creating a
  `SpaceAccountLink` (HOME kind) in the same transaction.
- No API route may create a `SpaceAccountLink` without triggering snapshot
  regeneration for all affected Spaces.

These three invariants can be enforced by shared pipeline middleware once
the pipeline is fully explicit. Until that middleware exists, they are
enforced by code review.

---

## 8. Stop point

This document is the complete deliverable. No schema, migration, route, UI,
or documentation file was modified.

**Architectural verdicts:**

- **The pipeline spine is canonical and already substantially built.** The
  entity creation order is fixed: Connection → Account Discovery →
  Duplicate Detection → FinancialAccount → ProviderAccountIdentity →
  AccountConnection → SpaceAccountLink (HOME) → SpaceSnapshot.
- **Institution Catalog and Provider Catalog are confirmed as separate,
  complementary layers.** Institution Catalog is user-facing and not yet
  built. Provider Catalog is internal, code-defined, and live.
- **Provider Resolution belongs in a future `lib/institutions/resolve.ts`
  module.** It does not exist yet and is not a v2.4 item.
- **Adapters are below the pipeline, never inside it.** The catalog never
  imports adapters; adapters never import the catalog.
- **The two highest-risk open items are Plaid Update Mode for Connection dedup
  and the missing DiscoveredAccount staging step.** Both are named, bounded,
  and owned by `feature/provider-adapter-layer`. The D3 HOME race condition
  and all Stage B write-retirement work are complete; Stage C (table removal)
  is intentionally deferred for the bake period.
