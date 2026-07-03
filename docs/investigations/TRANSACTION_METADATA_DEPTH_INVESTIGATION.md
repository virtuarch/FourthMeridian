> **INVESTIGATION ONLY — no code, schema, migration, or UI changes were made to produce this document.** For current project state see `STATUS.md` at the repository root.

# Transaction Metadata Depth Investigation (Transaction Detail Drawer)

**Date:** 2026-07-02
**Branch:** `feature/phase-2-architecture`
**Baseline:** v2.4.0
**Status:** Investigation complete — recommendation only, no implementation
**Related but separate scope:** `docs/investigations/TRANSACTION_FLOW_CLASSIFICATION_INVESTIGATION.md`. This document is about *storing more of what Plaid tells us*; that one is about *deriving economic meaning*. The two are deliberately kept apart (see §9).

---

## 1. Executive summary

Fourth Meridian currently keeps **seven** meaningful facts about each transaction — merchant, description, date, amount, pending, a single collapsed category, and the Plaid transaction id — out of roughly **thirty** distinct fields Plaid hands us on every `/transactions/sync` payload. Everything else Plaid returns is read once (if at all), used transiently, and thrown away. A Transaction Detail Drawer that aims to "show everything useful and trustworthy we know" therefore has almost nothing to show today beyond what the row list already displays.

The gap is not that Plaid withholds data — it is that `syncTransactions.ts` consumes only six fields and derives one enum from a seventh (`lib/plaid/syncTransactions.ts:220–226`), and the `Transaction` model has no columns for the rest (`prisma/schema.prisma:1168–1211`). Rich, drawer-worthy fields Plaid already provides — authorized date, payment channel, location, counterparties, merchant logo/website, currency, the pending↔posted link, and the full `personal_finance_category` (primary + detailed + confidence) — are all currently discarded.

**Recommendation:** capture a **normalized set of promoted columns** for the fields the drawer will filter, sort, or lean on (and that a future `flowType` classifier needs), **plus an optional curated raw-metadata JSON blob** for full-fidelity display — but with sensitive financial identifiers (counterparty account/routing numbers, ACH payer/payee identifiers, account-owner names) **deny-listed before persistence**, never stored wholesale. The drawer is the deepest detail surface in the product and must be gated by the **same FULL-only visibility predicate** that already governs row-level detail (`lib/ai/visibility.ts`), failing closed for BALANCE_ONLY / SUMMARY_ONLY accounts. This is additive and low-risk, but it is **new capability and new PII surface**, so it belongs in **v2.5**, not the v2.4.5 stabilization gate — with the single note that persisting `personal_finance_category.detailed` is the one field that overlaps with the flowType work and is worth capturing at the first opportunity.

---

## 2. Current storage map

### 2.1 Fields Plaid sends us (per transaction)

Confirmed against the Plaid SDK type (`node_modules/plaid/dist/api.d.ts`, `interface Transaction` and its nested `Location`, `PaymentMeta`, `PersonalFinanceCategory`, `TransactionCounterparty`):

`account_id`, `amount`, `iso_currency_code`, `unofficial_currency_code`, `category[]`, `category_id`, `check_number`, `date`, `location{address, city, region, postal_code, country, lat, lon, store_number}`, `name`, `merchant_name`, `original_description`, `payment_meta{reference_number, ppd_id, payee, by_order_of, payer, payment_method, payment_processor, reason}`, `pending`, `pending_transaction_id`, `account_owner`, `transaction_id`, `transaction_type`, `logo_url`, `website`, `authorized_date`, `authorized_datetime`, `datetime`, `payment_channel`, `personal_finance_category{primary, detailed, confidence_level}`, `personal_finance_category_icon_url`, `business_finance_category`, `transaction_code`, `counterparties[]{name, entity_id, type, website, logo_url, confidence_level, account_numbers}`, `merchant_entity_id`.

### 2.2 What we actually consume

`syncTransactions.ts:220–226` reads exactly:

| Plaid field | Handling | Persisted as |
|---|---|---|
| `transaction_id` | stored | `Transaction.plaidTransactionId` |
| `name` | stored | `Transaction.description` |
| `merchant_name ?? name` | stored | `Transaction.merchant` |
| `date` | stored | `Transaction.date` |
| `amount` | **sign-flipped** (`-txn.amount`), stored | `Transaction.amount` |
| `pending` | stored | `Transaction.pending` |
| `personal_finance_category` / `category` | passed to `mapPlaidCategory`, **only the derived enum kept** | `Transaction.category` |

### 2.3 What the `Transaction` model stores

`prisma/schema.prisma:1168–1211`: `id`, `accountId?` / `financialAccountId?`, `date`, `merchant`, `description?`, `category`, `amount`, `pending`, `plaidTransactionId?`, `importBatchId?`, `externalTransactionId?`, `deletedAt?`, `createdAt`, `updatedAt`.

**No column exists for:** currency, authorized date/time, transaction datetime, payment channel, location (any sub-field), lat/lon, counterparties, merchant/entity id, logo/website, pending-transaction link, account owner, check number, original description, payment_meta, the raw PFC primary/detailed/confidence, or any raw provider blob.

---

## 3. Missing metadata map

Grouped by the drawer's likely display sections. "Value" = why it matters for a detail drawer.

**Identity & merchant**
- `merchant_entity_id` — stable merchant id; dedup, logos, "all transactions at this merchant."
- `logo_url`, `website` — merchant branding in the drawer header.
- `original_description` / `name` — the raw bank descriptor (we keep `name` as `description`; `original_description` is separate and rawer).
- `personal_finance_category_icon_url` — category glyph.

**Amounts**
- `iso_currency_code` / `unofficial_currency_code` — **currently unmodeled; the app implicitly assumes one currency.** Real correctness gap, not just cosmetics.

**Timing**
- `authorized_date` — when the purchase was authorized vs. posted; users recognize this date.
- `authorized_datetime`, `datetime` — intraday precision where the institution supports it.
- `pending_transaction_id` — links a posted row back to the pending row it replaced; enables "this was pending on <date>."

**Classification (raw)**
- `personal_finance_category.primary` / `.detailed` / `.confidence_level` — the full taxonomy we currently collapse to one enum and discard. Directly reusable by the drawer *and* the future flowType classifier (§9).

**Channel**
- `payment_channel` (`online` / `in store` / `other`) — strong signal, near-always present.

**Location**
- `location.city` / `.region` / `.postal_code` / `.country` — where it happened.
- `location.lat` / `.lon` — map pin.
- `location.address` / `.store_number` — precise venue.

**Counterparties**
- `counterparties[]` — merchants, payment processors, financial institutions involved, each with `name` / `type` / `logo_url` / `website` / `confidence_level`. Rich for card purchases.
- `counterparties[].account_numbers` — **sensitive** (see §7); recommend never persisting.

**Account / institution context**
- `account_owner` — name on the account (**sensitive**, usually null).
- Institution / account name / mask / owner — *already available* via the joined `FinancialAccount`; no new capture needed, just join in the drawer query.

**Lower value / niche**
- `check_number`, `transaction_type`, `transaction_code`, `category_id`, `payment_meta.*`, `business_finance_category` — mostly transfer/wire/ACH niche or legacy; capture only inside a curated raw blob if at all.

---

## 4. Reliability assessment (reliable vs. often null)

Based on Plaid's documented population behavior for real (non-Sandbox) credentials. Sandbox returns sparse synthetic data for all of these (see `TRANSACTION_HISTORY_AND_PAGE_INVESTIGATION.md` §2–3), so **dev observation will understate real coverage**.

| Reliability | Fields |
|---|---|
| **Near-always present** | `transaction_id`, `account_id`, `amount`, `iso_currency_code`, `date`, `name`, `pending`, `payment_channel`, `personal_finance_category.primary` / `.detailed` (PFC-enabled items), `personal_finance_category.confidence_level` |
| **Usually present on card / merchant activity, null elsewhere** | `merchant_name` (null for payroll, transfers, many bills), `merchant_entity_id`, `logo_url`, `website`, `authorized_date`, `counterparties[]` |
| **Frequently null / institution-dependent** | `location.city`/`region`/`postal_code`/`country` (better for card-present), `authorized_datetime` / `datetime` (only intraday-capable institutions), `original_description`, `pending_transaction_id` (set only when a pending txn posts) |
| **Usually null / niche** | `location.lat`/`lon`, `location.address`/`store_number`, `account_owner`, `check_number`, `payment_meta.*`, `unofficial_currency_code`, `transaction_code` |

**Design consequence:** the drawer must treat almost every field as optional and hide empty fields gracefully — a fixed template assuming location or authorized_date will look broken most of the time. Confidence levels (`personal_finance_category.confidence_level`, `counterparties[].confidence_level`) should be surfaced so the drawer can visually distinguish "known" from "guessed."

---

## 5. Recommended schema / data model (design reference — not for merge)

**Two-tier capture: normalized columns + a curated raw blob.**

1. **Promoted, normalized columns on `Transaction`** — for fields the drawer sorts/filters on, that need to be queryable, or that the flowType classifier consumes. Candidate set (all additive, nullable):
   `isoCurrencyCode`, `authorizedDate`, `authorizedDatetime`, `datetime`, `paymentChannel`, `merchantEntityId`, `logoUrl`, `website`, `pendingTransactionId`, `pfcPrimary`, `pfcDetailed`, `pfcConfidence`, `locationCity`, `locationRegion`, `locationPostalCode`, `locationCountry`, `locationLat`, `locationLon`, `originalDescription`.
   These are canonical financial facts about the movement, provider-agnostic in meaning, so they belong on `Transaction` — consistent with the freeze doc's rule that canonical tables carry the financial fact, not provider mechanics (`PHASE_2_ARCHITECTURE_FREEZE.md §13`).

2. **A curated raw-metadata JSON column** (e.g. `providerMetadata Json?`) — for full-fidelity drawer display and future-proofing against Plaid adding fields, **built from a whitelist**, not by dumping the raw Plaid object. Store counterparties (minus `account_numbers`), category arrays, icon URLs, transaction_type, etc. Explicitly **exclude** the §7 deny-list before writing.

**Why both, not one:**
- *Normalized only* → every new drawer field or classifier signal needs a migration; can't show the long tail of niche fields.
- *Raw blob only* → nothing is queryable or indexable; can't power filters or the classifier; and an opaque blob is invisible to the field-level redaction in `lib/account-privacy.ts`, so it's a leak risk (§7). It also violates the freeze doc's "no field that needs summing/sorting/filtering hides inside an un-indexable shape" intent (`§7`, `§13`).
- *Both* → normalized columns stay indexable and feed classification; the curated blob covers the display long tail without a migration per field, while the deny-list keeps the blob safe.

**Currency is the one correctness item, not just enrichment:** `isoCurrencyCode` should be captured regardless of the drawer, because summing mixed-currency amounts (already possible today) is silently wrong.

---

## 6. Migration impact

Fully additive. All new fields are nullable columns plus one nullable JSON column; no existing column changes, no destructive migration, no query rewrites. Existing rows read back `null` for every new field and the drawer hides them.

**Backfill is the real constraint.** New/re-synced transactions populate the fields going forward, but historical rows stay bare. Backfilling requires **re-fetching from Plaid**, which the cursor model resists: once `PlaidItem.cursor` is set, `/transactions/sync` returns only deltas (`TRANSACTION_HISTORY_AND_PAGE_INVESTIGATION.md` §3). Options: (a) accept that only forward data is rich; (b) clear the cursor and re-sync (idempotent via `plaidTransactionId` + fingerprint, but heavier and interacts with the 5,000-row fetch cap, KD-7); (c) a dedicated `/transactions/get` backfill (its own scope). Recommendation: **forward-only capture first**; treat historical backfill as a separate, later decision.

No interference with D2/D3: these are new columns on a canonical table, orthogonal to the WAS→SAL cutover.

---

## 7. Privacy / security concerns of raw Plaid metadata

Storing the **entire** raw Plaid object is unsafe on a canonical, plaintext-at-rest table. Specific hazards:

- `counterparties[].account_numbers` — may carry **account/routing numbers**. Never persist.
- `payment_meta.payee` / `payer` / `by_order_of` / `ppd_id` / `reference_number` — **third-party identities and ACH identifiers**. Sensitive; exclude from the blob.
- `account_owner` — **the name on the account**. PII; exclude or restrict to owner-only display.

Three structural rules follow:
1. **Curate on write (deny-list).** The raw blob is a whitelist of display-safe fields; the three items above are stripped before persistence. What isn't stored can't leak.
2. **Never AI-visible.** Per the freeze doc's allow-list rule (`§11`), a raw provider blob is not AI-accessible; the Context Builder must never read `providerMetadata`. This mirrors how `Connection.credential` / `PlaidItem.encryptedToken` are categorically excluded.
3. **Field-level redaction can't see inside a blob.** `lib/account-privacy.ts` redacts by field; an opaque JSON column bypasses that logic, so a drawer must never serialize the blob for anything other than a fully-authorized, owner-scoped view (§8).

Note a standing tension with the freeze doc: `§7` keeps canonical financial fields plaintext *specifically so indexing works*. Some new fields (location, counterparties) are PII rather than summable numbers — they widen the plaintext breach blast radius without needing to be indexed. Worth an explicit call on whether any of them warrant app-level encryption; the pragmatic answer is to **not capture the most sensitive ones at all** (deny-list) rather than encrypt them.

---

## 8. Privacy / visibility rules for the drawer

The drawer is the **deepest** transaction-detail surface, so it inherits the strictest existing gate, not a looser one:

- **FULL-only, fail closed.** Gate the drawer with the same predicate as row detail: `TRANSACTION_DETAIL_VISIBILITY = [FULL]` (`lib/ai/visibility.ts:44`). BALANCE_ONLY and SUMMARY_ONLY accounts already don't surface rows at all (`getTransactions` filters them via KD-15, `lib/data/transactions.ts:66`), so a drawer is naturally unreachable — but the rule must be **explicit and independently enforced** on the drawer's own data path, never assumed from the list filter. Absence of a FULL grant → no drawer.
- **Owner (HOME) links are FULL by definition**; the Space's own accounts get the full drawer.
- **Consider a within-FULL sub-tier for raw identifiers.** Even a fully-authorized *member* of a shared Space arguably shouldn't see counterparty identifiers or `account_owner` for an account they don't own. A defensible stance: the richest fields (location precision, counterparties, any raw blob) render only on the **account owner's own** view, while shared FULL viewers see the safe subset (merchant, amount, date, category, channel). Flagged as a design decision, not decided here.
- **Audit reads.** A drawer open on a *shared* account is a reasonable `AuditLog` event, reusing `lib/audit-actions.ts` rather than a new log (consistent with freeze `§9.5`/`§11`).

---

## 9. Relationship to flowType

The two scopes stay separate but are mutually reinforcing, and the boundary is clean:

- **Metadata capture = "store what the provider told us"** (this document). Deterministic, no interpretation.
- **flowType = "derive economic meaning"** (the other document). Interpretation over stored facts.

The captured metadata is exactly the **evidence the classifier needs**: `personal_finance_category.detailed` (the field the prior investigation flagged as discarded at `syncTransactions.ts:110–111`), `payment_channel`, `counterparties[].type`, and `merchant_entity_id` are the signals that separate an internal transfer from a card payment from investment funding. So:

- Capturing `pfcPrimary` / `pfcDetailed` / `pfcConfidence` is the **one overlap worth pulling forward**: it un-does the lossy discard, and both the drawer and the eventual classifier read it. It can ride with either effort.
- But **do not build the classifier here.** This document only persists fields; it neither adds `flowType` nor changes how spending is computed. The classifier consumes these columns later.
- Sequencing preference: capture metadata (including detailed PFC) **before or with** the flowType work, so the classifier is built on stored evidence rather than re-derivation.

---

## 10. Minimal implementation roadmap (recommendation only — not an implementation checklist)

Each stage still requires its own impact map, rollback plan, and validation checklist before any code, per project rules.

1. **Currency capture (correctness).** Add `isoCurrencyCode`; smallest, highest-correctness increment; independent of the drawer.
2. **Normalized column capture.** Add the §5 promoted columns; populate in `syncTransactions.ts` on new/modified rows. Forward-only. Include `pfcDetailed` here (shared with flowType).
3. **Curated raw blob.** Add `providerMetadata Json?` built from a whitelist with the §7 deny-list enforced at the write site.
4. **Drawer read path + DTO** (§11) with FULL-only gating and empty-field suppression.
5. **(Later, separate)** historical backfill decision; within-FULL raw-identifier sub-tier; map rendering.

---

## 11. Transaction Detail Drawer data model (display DTO — reference only)

What the drawer would assemble per transaction, each field tagged by reliability so empties hide:

- **Header:** merchant (or `name` fallback), `logoUrl`, `website`, amount + `isoCurrencyCode`, pending badge.
- **Timing:** posted `date`; `authorizedDate`; `datetime`/`authorizedDatetime` if present; "was pending" via `pendingTransactionId`.
- **Classification:** `pfcPrimary` / `pfcDetailed` + `pfcConfidence`; current `category`; **future** `flowType` (placeholder until that lands).
- **Channel:** `paymentChannel`.
- **Location:** city / region / postal / country; optional map from `lat`/`lon`.
- **Counterparties:** name / type / logo (safe subset only — never `account_numbers`).
- **Account context:** account name, institution, mask, type — **joined from `FinancialAccount`**, no new capture.
- **Provenance:** source (Plaid / CSV / manual), last-synced, `plaidTransactionId` for support.

The DTO is assembled server-side behind the FULL gate; the safe-subset vs. full-detail split (§8) is applied before serialization.

---

## 12. Risks

- **Sandbox sparsity misleads dev.** Fields will look mostly null in Sandbox; real coverage is far higher. Don't prune fields based on Sandbox observation.
- **Raw-blob PII leak.** The central risk; mitigated only by capture-time deny-listing and never routing the blob through AI/public/shared read paths (§7).
- **Backfill cost.** Rich history requires cursor reset + re-sync (heavier Plaid calls; KD-7 fetch-cap interaction) — or forward-only, accepting bare history.
- **Plaintext PII blast radius.** New location/counterparty PII sits plaintext on a canonical table; freeze `§7` optimized that posture for summable numbers, not PII. Prefer not-capturing over encrypting.
- **Schema bloat.** ~19 columns + a JSON blob on a hot table; index only what the drawer/classifier query, not every field.
- **Visibility regression.** A drawer that reads its own path could bypass the KD-15 list filter; it must re-assert FULL-only and fail closed.
- **`Float` money.** Pre-existing; unaffected. Multi-currency makes naive cross-currency sums wrong — `isoCurrencyCode` capture is the guard.

---

## 13. Out of scope

- Building or designing the `flowType` classifier, or changing any spending/income aggregate (that is the other investigation).
- The Banking-page income-sum bug (tracked in the flow-classification investigation).
- Transfer-pair linking / double-entry.
- A Plaid webhook handler and any real-time sync trigger.
- Designing the historical-backfill mechanism (`/transactions/get`, cursor-reset UX).
- `business_finance_category`, `transaction_code`, and `payment_meta` beyond optional inclusion in the curated blob.
- Multi-currency conversion / FX display (capture the code now; convert later).
- Map provider / rendering choice for `lat`/`lon`.
- Any UI visual design — this document defines available data and its data model only.

---

## 14. Evidence index

| Claim | Source |
|---|---|
| Only 6 fields consumed + 1 derived enum | `lib/plaid/syncTransactions.ts:220–226` |
| Amount sign flip | `lib/plaid/syncTransactions.ts:218–220` |
| PFC detailed discarded at mapping | `lib/plaid/syncTransactions.ts:100–119` |
| Stored Transaction columns | `prisma/schema.prisma:1168–1211` |
| Full Plaid Transaction field surface | `node_modules/plaid/dist/api.d.ts` — `interface Transaction`, `Location`, `PaymentMeta`, `PersonalFinanceCategory`, `TransactionCounterparty` |
| FULL-only transaction-detail predicate | `lib/ai/visibility.ts:44–51` |
| BALANCE_ONLY/SUMMARY_ONLY exclude rows (KD-15) | `lib/data/transactions.ts:27–38, 66` |
| Redaction is field-level, read-time | `lib/account-privacy.ts` (per freeze `§6`) |
| Canonical tables carry financial fact, not provider mechanics; plaintext-for-indexing; AI/public allow-lists | `docs/architecture/PHASE_2_ARCHITECTURE_FREEZE.md §7, §11, §13` |
| Sandbox sparsity; cursor blocks re-fetch; KD-7 fetch cap | `docs/investigations/TRANSACTION_HISTORY_AND_PAGE_INVESTIGATION.md §2–3`; `STATUS.md §7 (KD-7)` |
| v2.4.5 stabilization-only; v2.5 new surfaces | `STATUS.md §5` |
