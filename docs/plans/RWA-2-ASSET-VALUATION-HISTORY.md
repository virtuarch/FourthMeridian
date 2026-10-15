# RWA-2 — Asset Valuation History (design + owner decisions)

**Date:** 2026-10-15 · **Base:** `rwa1/manual-assets` (`6bf9243` RWA-1A, `61f70bf` RWA-1B) off `v2.6` `0f07a62`
**Branch:** `rwa2/asset-valuations`, stacked on RWA-1, merged separately by the coordinator (Claude 1).
**Status:** DESIGN + DEVELOPMENT IMPLEMENTATION. The migration is authored and verified only against `npm run ci`'s throwaway Postgres. It has **not** been applied to Dev, Preview or Production; the coordinator applies it with `db:migrate:safe` after owner approval.

## 1. The owner's two modes, restated as rules

**Mode 1 — a newly added asset.**

| Input | Status |
|---|---|
| Acquisition date | optional |
| Purchase price | optional |
| "Use the purchase price as my estimate of its value on that date" | opt-in, default off |
| Current valuation date | default today |
| Current estimated value | required |

When the opt-in is on, there are two dated anchors, and the days between them get a **modeled** linear trend. Purchase price alone is never treated as a market value: it is kept on the asset's profile as a fact, and it becomes an anchor only through the opt-in.

**Mode 2 — an existing tracked asset.**

- **Append-only:** every update appends a dated valuation (effective date + recorded timestamp), and nothing is overwritten.
- **Same-day correction rule:** for one asset and one effective date, the row with the latest `recordedAt` is the anchor. Earlier rows for that date stay stored as history of the correction and are never used as anchors.

## 2. Valuation policy — one rule for every reader

The rule lives in a pure resolver, `lib/assets/valuation-series.core.ts`, which every reader uses: the per-asset chart, the AI tools and the history rebuild. For day *d* the resolver returns:

| Day *d* | Result | `basis` |
|---|---|---|
| before the acquisition date, or before the first anchor when there is no opted-in purchase anchor | not held / not valued → `null` (no value invented) | — |
| equal to an anchor date | the anchor's value | `recorded` |
| strictly between two anchors | linear interpolation in the asset's own currency | `modeled` |
| after the last anchor | the last anchor carried forward | `recorded` (carried) |

- **Today's value:** `FinancialAccount.balance` always equals the latest-effective-date anchor. A backdated correction older than the latest anchor therefore does not change today's balance.
- **Legacy assets** (created before RWA-2, with no valuation rows): the resolver treats `balance` at `lastUpdated` as the single recorded anchor. Nothing is backfilled into the table.
- **Precision:** interpolated values are rounded to whole currency units, and the UI and AI label them "modeled", never "valued".

## 3. Smallest additive schema (one migration, two tables, no column changes)

`prisma/migrations/20261015120000_rls_asset_valuations` (after the coordinator's reserved `20261015100000_plaid_item_environment`):

- **`AssetValuation`** (append-only)
  - Columns: `id`, `financialAccountId` (FK → FinancialAccount, `ON DELETE CASCADE`), `effectiveDate DATE`, `value DOUBLE PRECISION` (Float, per ADR-005), `currency`, `source` (`USER_ESTIMATE`), `recordedAt` (default now), `recordedByUserId` (FK → User, `ON DELETE SET NULL`), `note?`.
  - Index: `(financialAccountId, effectiveDate, recordedAt)`.
- **`ManualAssetProfile`** (1:1, the `DebtProfile` pattern)
  - Columns: `financialAccountId @unique` (Cascade), `acquisitionDate DATE?`, `purchasePrice?`, `purchaseCurrency?`, `purchasePriceIsStartingValue BOOLEAN DEFAULT false`, timestamps.
- **RLS** — same as the account-subtree tables:
  - ENABLE + FORCE.
  - `fm_app` CRUD policies are created with `fm_account_visible("financialAccountId")`, then altered to the visible-OR-owner predicate of `20261003000000`.
  - `fm_system_all`; `fm_backup` SELECT.
- **Registered in:**
  - `scripts/audit-account-reparenting.ts` `FK_POLICY_COVERAGE`.
  - `lib/ai/evidence-authorities.ts` (the AI reads it).

**Privacy:** RLS lets any viewer of an ACTIVE link read these rows, including a `BALANCE_ONLY` link. Valuation history would disclose more than that tier allows, so every application read is **additionally** gated to the owner or a viewer holding a **FULL** link (the detail route's rule).

## 4. Implementation slices

| Slice | Contents | Needs an owner decision first? |
|---|---|---|
| **RWA-2A** | Schema + migration. Write paths: POST takes acquisition / purchase / opt-in / valuation date; PATCH appends a dated valuation with a validated effective date (not in the future, not before acquisition). Resolver + tests. Per-asset history read (FULL-or-owner). Per-asset history chart on the Real assets card: recorded anchors solid, modeled segments dashed and labelled. AI exposure (`valuations`, `modeledHistory` descriptor, passed through `get_financial_snapshot`). | No — additive, development only |
| **RWA-2B** | The Net Worth / Assets **history** uses the same resolver: a hook in `regenerateWealthHistory` (`lib/snapshots/regenerate-history.ts:873-878`), floors from acquisition / first anchor, and a range rebuild after each valuation write. Modeled days are marked on the Net Worth chart. | **Yes — D-H1 … D-H4 below** |

## 5. Historical accounting dependencies that need a separate owner decision

- **D-H1 — frozen observed days.**
  - Every past day the daily writer already recorded is FROZEN and still holds the asset at whatever balance it had then. For an asset added today, that means it is absent from every earlier day.
  - Only the existing consent-based amendment path (`lib/snapshots/snapshot-amendment.ts`, `ACCOUNT_ADDED_RETROACTIVE`) may rewrite frozen days. That path is **Personal-Space only** and asks the user to confirm.
  - Decision: should adding or backdating a valuation offer that amendment? Or should modeled history appear only on the per-asset chart while Net Worth history stays as recorded?
- **D-H2 — `WEALTH_REGENERATION_ENABLED`.** Automatic range rebuilds are gated by this flag. Its environment state was not inspected (no environment access).
- **D-H3 — shared Spaces.** History in a shared Space is floored at the date the asset was linked into it, and amendments are refused there. Decision: should a shared Space ever show an asset's modeled history from before it was shared?
- **D-H4 — "carried forward" vs "modeled".** After the last anchor the resolver carries the value flat and calls it `recorded`. An alternative is to extrapolate a trend. Recommendation: never extrapolate.
- **D-H5 — `SnapshotAmendmentDay`** records only net worth before/after. A real-assets amendment would be auditable only at net-worth level unless a column is added (a migration).
- **D-H6 — linked liabilities.** There is no asset↔loan link today, so valuations cannot double-count a mortgage. Equity display (RWA-3) stays a separate decision.

## 6. Verification plan

- **Unit:**
  - the resolver (anchors, same-day rule, opt-in, nothing before acquisition, linear up and down, carry-forward, legacy fallback);
  - write-path pins;
  - privacy gate;
  - AI field pins.
- **Gates:**
  - `npm run ci` (applies the migration to a throwaway `postgres:16`; RLS acceptance; audits);
  - production build from the worktree.
- **Not verified:** any environment with the migration applied, or the in-browser rendering against real data. The owner's beta environments stay untouched until the coordinator applies the migration.
