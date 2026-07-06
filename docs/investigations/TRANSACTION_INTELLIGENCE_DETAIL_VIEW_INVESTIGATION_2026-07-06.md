> **INVESTIGATION ONLY — no code, schema, migration, or UI changes were made to produce this document.** For current project state see `STATUS.md` at the repository root.

# Transaction Intelligence — Detail View Investigation

**Date:** 2026-07-06
**Status:** Investigation complete — recommendation only, no implementation
**Baseline:** working tree at v2.4.5 / post-FlowType-P5, post-MC1-Phases-0–3 (STATUS checkpoint `f22de52` + subsequent MC1 Phase 3 closeout)
**Sources read:** `prisma/schema.prisma`, `lib/data/transactions.ts`, `lib/ai/assemblers/transactions.ts`, `lib/ai/types.ts`, `app/api/accounts/[id]/transactions/route.ts`, `app/api/spaces/[id]/transactions/route.ts`, `app/api/ai/chat/route.ts`, `components/dashboard/BankingClient.tsx`, `components/dashboard/AccountModal.tsx`, `components/dashboard/widgets/{RecentTransactionsPanel,SpaceTransactionsPanel}.tsx`, `components/atlas/OverlaySurface.tsx`, `lib/transactions/{merchant,merchant-rules,flow-classifier,fingerprint}.ts`, `lib/money/{convert,server-context}.ts`, `types/index.ts`, `docs/design-system/ATLAS_GLASS_MODAL_DOCTRINE.md`, `docs/investigations/TRANSACTION_METADATA_DEPTH_INVESTIGATION.md`, `docs/investigations/MERCHANT_INTELLIGENCE_{PRODUCT_ARCHITECTURE,PERSISTED_TIER_PLAN,FORMS_INVESTIGATION}_2026-07-05.md`, `docs/investigations/NEXT_INITIATIVE_AND_ROUTER_E668_INVESTIGATION_2026-07-05.md`, `docs/initiatives/flowtype/P5_CLOSEOUT_INVESTIGATION_2026-07-05.md` (headers), `docs/initiatives/mc1/*` (via STATUS ledger), `STATUS.md`, `ROADMAP.md`.
**Related prior investigations (this document builds on, does not repeat):** `TRANSACTION_METADATA_DEPTH_INVESTIGATION.md` (what Plaid sends that we discard), `TRANSACTION_HISTORY_AND_PAGE_INVESTIGATION.md`, `MERCHANT_INTELLIGENCE_PRODUCT_ARCHITECTURE_2026-07-05.md` (the correction loop this surface will host).

---

## 0. Executive summary

Fourth Meridian has **no transaction detail surface of any kind**. Every transaction row in the product — Banking list, Account modal, Dashboard recent-activity panels, Space transactions tab, Debt view — is a dead end: a non-interactive `<div>` with no `onClick`, no detail affordance, and no route (`BankingClient.tsx` `TxRow`, `SpaceTransactionsPanel`, `RecentTransactionsPanel`). The row list *is* the entire transaction experience.

Meanwhile, the row itself has quietly become the most intelligence-dense object in the schema. Since v2.4.0 the `Transaction` model gained flow semantics (`flowType`, `flowDirection`, `classificationConfidence`, `classificationReason`, `classifierVersion` — FlowType P3–P5), provider category provenance (`pfcPrimary`, `pfcDetailed`, `pfcConfidenceLevel`), a Merchant Intelligence spine (`merchantEntityId`), currency provenance (`currency` — MC1 Phase 0), import provenance (`importBatchId`, `externalTransactionId`), and a counterparty seam (`counterpartyAccountId`). Almost none of this is shown to the user anywhere. The product computes explanations and then keeps them to itself.

This investigation recommends a **Transaction Detail overlay** built as a shared component on the canonical `OverlaySurface` primitive (Atlas Glass modal doctrine), opened from every existing row list, backed by a **new canonical single-transaction detail DTO + one visibility-gated API endpoint** — because no reusable per-transaction read exists today. The surface should be conceived from day one as the **canonical inspection surface for an immutable financial fact**: v1 renders only what is already stored (which is already a lot); Merchant Intelligence, richer provider metadata, attachments, notes, AI actions, and audit history attach to it in later, independently reversible slices. The fact itself — date, amount, currency, provider identity — is never editable; everything a user can change is an *interpretation layered on top of the fact*, with provenance.

The single most important design decision: **this surface is where trust is won or lost.** The Merchant Intelligence product architecture (2026-07-05) identified "Why this category?" as the cheapest, highest-leverage trust feature in the product. The Transaction Detail view is that feature's home, and the row-level data to power a first version (`pfcPrimary`/`pfcDetailed` + `classificationReason` + `classificationConfidence`) **already exists on every classified row** — no new capture required.

---

## 1. Current transaction model — full field inventory

### 1.1 `Transaction` (prisma/schema.prisma:1176–1257)

Classification legend: **D** = display now (v1, data already stored) · **L** = useful later (display once a dependency lands, or behind a disclosure) · **I** = internal only (may appear in an admin/support view, never in the user surface) · **N** = should never be user-visible.

| Field | Type | Notes | Class |
|---|---|---|---|
| `id` | String cuid | Row identity; used for deep links, never rendered as a value | I |
| `accountId` | String? | Legacy `Account` FK; exactly one of this / `financialAccountId` is set; reads normalize both to one `accountId` | I |
| `financialAccountId` | String? | Canonical FK; resolved to account display data, never shown raw | I |
| `date` | DateTime @db.Date | Posted date | **D** |
| `merchant` | String | Cleaned merchant name (`merchant_name ?? name` at sync) | **D** |
| `description` | String? | Raw bank descriptor (Plaid `name`) — the "what my statement actually says" line | **D** |
| `category` | TransactionCategory | Collapsed 16-value enum | **D** |
| `amount` | Float | Signed; positive = money in (sign-flipped from Plaid at sync) | **D** |
| `pending` | Boolean | | **D** |
| `currency` | String? | MC1 Phase 0 provenance stamp; null = pre-provenance residue ("denomination never recorded", NOT "USD") | **D** |
| `flowType` | FlowType? | Single semantic authority post-P5 | **D** |
| `flowDirection` | FlowDirection? | INFLOW / OUTFLOW / INTERNAL / UNKNOWN | **D** |
| `classificationConfidence` | Float? | 0–1 classifier confidence | **L** (disclosure) |
| `classificationReason` | FlowClassificationReason? | Stable, auditable reason enum — the raw material of "Why?" | **L** (disclosure, humanized) |
| `classifierVersion` | Int? | Backfill/idempotency gate | I |
| `pfcPrimary` / `pfcDetailed` | String? | Raw Plaid personal_finance_category — provider hint, not FM semantics | **L** (provenance explainer) |
| `pfcConfidenceLevel` | String? | Plaid's own confidence | **L** (disclosure) |
| `merchantEntityId` | String? | Stable Plaid merchant key — the forward seed for the `Merchant` table (MI M4) | I |
| `plaidTransactionId` | String? @unique | Dedup key | I |
| `externalTransactionId` | String? | Import-file row id (D2 Step 4D) | I |
| `importBatchId` | String? | FK → ImportBatch; enables "imported from `chase.csv` on July 3" provenance | **L** (via resolved ImportBatch) |
| `deletedAt` | DateTime? | Import-rollback soft delete; a deleted row must never render at all | N |
| `counterpartyAccountId` | String? | Best-effort "other side" when it is an owned account (KD-18 seam) | **L** (resolved to account name: "Transfer to Chase Savings") |
| `createdAt` | DateTime | "First seen by Fourth Meridian" — honest technical metadata | **L** (technical section) |
| `updatedAt` | DateTime | Row-write bookkeeping | I |

### 1.2 Related models that can enrich the surface

**`FinancialAccount` (schema:689)** — the canonical account context. Display now: resolved account name (**resolution order `displayName ?? officialName ?? plaidName ?? name`**, per the schema comment), `institution`, `mask`, `type`. Useful later: `balanceLastUpdatedAt` (freshness provenance), `debtSubtype` + `DebtProfile` (due-date context for DEBT_PAYMENT rows). Internal: `plaidAccountId`, `syncStatus`, owner FKs. Never: nothing on this model itself, but the *visibility rules that govern it* are load-bearing (§1.3).

**`Account` (legacy, schema:639)** — still a live FK for legacy/seed rows; reads normalize it away. The detail surface must accept either parent but should render through one resolved shape. Contributes: name, institution, type. No new feature work should target this model (its own header says so); the detail DTO is a chance to bury the dual-FK seam behind one field, permanently.

**`Connection` / `PlaidItem` / `AccountConnection` / `ProviderAccountIdentity`** — the provider/credential layer. Useful later: institution name + connection health (`status`, `lastSyncedAt`) as a "data source" line in technical metadata ("Synced via Chase · Plaid · last sync 2h ago"). Never: `PlaidItem.encryptedToken`, `Connection.credential`, sync `cursor`, `errorCode` internals.

**`ImportBatch` (schema:1290)** — real provenance for imported rows: `source` (CSV/EXCEL/QUICKBOOKS), `originalFilename`, `completedAt`, counts. Useful later as the provenance line for `importBatchId` rows. Internal: `errorSummary`, `resolvedColumnMapping`, `mappingProfileId`.

**`Space` (schema:363)** — contributes `reportingCurrency` (MC1 Phase 3, authoritative for every converted figure the surface shows) and the membership/visibility context. Not displayed as such; it *frames* the display.

**`FlowType` / `FlowDirection` / `FlowClassificationReason` enums (schema:1130–1161)** — display vocabulary. The read cutover (P5) is complete: these are live semantics, not aspirational columns.

**Merchant-related, existing only** — there is **no persisted Merchant model yet**. What exists: `Transaction.merchantEntityId` (stored, unused), `normalizeMerchant()` (`lib/transactions/merchant.ts` — pure canonicalKey/canonicalName), and the curated global rules catalog (`lib/transactions/merchant-rules.ts`, Slice 1). This means a v1 detail surface can already compute "other transactions at this merchant" at read time (canonicalKey match, same predicate-guarded query) without any MI schema.

**Snapshot relationships** — none. `SpaceSnapshot` has no transaction FK in either direction; transactions feed snapshot *backfill* computation (`lib/snapshots/backfill.ts`) but no row-level link exists or is needed. The detail surface has no snapshot section. Internal only.

**Holding links** — none. `Holding` and `Transaction` are unrelated; investment transactions carry the ticker **in the `merchant` field** (see `getInvestmentTransactions()` mapping `ticker: r.merchant`). A future investment-detail variant could join on symbol, but no FK exists. Useful later, low priority.

**Audit history** — `AuditLog` exists (append-only, space-scoped, `action` + `metadata`), but **no transaction-related audit actions are written today**. The MI persisted-tier plan already commits category corrections to write audit entries (from→to in metadata). The detail surface's Audit section is therefore entirely future — but the substrate exists and requires no schema change.

**AI references** — none at row level. `AiAdvice` is Space-scoped with no transaction FK. The AI context assembler is deliberately summary-only (`transactions_summary`; raw rows never enter context outside bounded drilldowns). One notable gap: the chat drilldown DTO (`DrilldownTransaction`, `lib/ai/types.ts:483`) **carries no transaction `id`** — the AI can show a user a row but cannot link to it. Adding `id` to that DTO is the cheapest AI↔detail-surface bridge available (§8).

### 1.3 The non-negotiable visibility invariant

Every transaction read in the product is gated by the KD-15/KD-1 predicate: rows are visible only through the legacy `account.spaceId` path or an ACTIVE `SpaceAccountLink` whose `visibilityLevel` is in `TRANSACTION_DETAIL_VISIBILITY` (currently FULL only), AND `Transaction.deletedAt: null`, AND (current path) `financialAccount.deletedAt: null`. The detail endpoint is the *deepest* detail surface in the product and must reuse this exact predicate — the metadata-depth investigation already reached the same conclusion. **Fails closed:** a BALANCE_ONLY / SUMMARY_ONLY share must 404/empty, never leak. Any enrichment joined onto the row (merchant profile, import filename, counterparty account name) inherits the same gate — a counterparty account the viewer cannot see must render as "another account," not by name.

---

## 2. Existing reads — where transactions are queried today

| Surface | Read path | Shape returned |
|---|---|---|
| **Banking page** | `app/(shell)/dashboard/banking/page.tsx` → `getTransactions()` (`lib/data/transactions.ts`) | `types/index.ts` `Transaction[]` |
| **Dashboard widgets** | `app/(shell)/dashboard/page.tsx` → `DashboardClient` → `RecentTransactionsPanel`, `SpaceTransactionsPanel` | same `Transaction[]` |
| **Credit/Debt page** | `getDebtTransactions()` → `DebtClient`, `lib/debt.ts` rollups | same `Transaction[]` |
| **Investments page** | `getInvestmentTransactions()` | `InvestmentTransaction[]` (ticker-in-merchant) |
| **Account modal** | `AccountModal` → `GET /api/accounts/[id]/transactions` | **its own inline mapping** (duplicates the DTO by hand; also one of the 3 remaining legacy-`Account` read sites flagged as open v2.5 debt) |
| **Space transactions tab** | `GET /api/spaces/[id]/transactions` → `getTransactions({spaceId})` | `Transaction[]` |
| **AI assembler** | `lib/ai/assemblers/transactions.ts` (`transactions_summary` domain) | aggregates only; `DrilldownTransaction` for bounded evidence (no `id`) |
| **Chat** | `app/api/ai/chat/route.ts` — drilldown detection + `getDebtTransactions()` for the KD-18 per-liability rollup | serialized text blocks |
| **Perspective engine** | `lib/perspective-engine/` lenses read **accounts/holdings, not transaction rows** (only test files mention transactions) | n/a |
| **Search** | client-side only — `BankingClient` / `SpaceTransactionsPanel` filter the already-fetched array. No server search API exists | n/a |
| **Write/maintenance paths** (not reads for display) | `lib/plaid/refresh.ts`/`syncTransactions`, `lib/imports/csv.ts`, `lib/accounts/reconcile.ts`, `lib/snapshots/backfill.ts`, `lib/transactions/fingerprint.ts`, `app/api/admin/plaid/diagnostics` | — |

**Does a reusable transaction DTO exist?** Partially. `types/index.ts` `Transaction` is a real, deliberately Prisma-free client DTO, and it already carries `currency` + the five flow fields. But: (a) the **mapping to it is copy-pasted four times** (three functions in `lib/data/transactions.ts` + the inline map in `/api/accounts/[id]/transactions`); (b) it is a **list-row DTO**, not a detail DTO — it omits everything a detail surface needs (pfc fields, merchantEntityId indirection, import provenance, counterparty, createdAt, resolved account context); (c) **no single-transaction read exists anywhere** — there is no `getTransactionById`, no `GET /api/transactions/[id]`.

**Recommendation:** introduce two things in one slice:

1. `serializeTransactionRow(row)` — extract the existing four-way-duplicated list mapping into one function in `lib/data/transactions.ts` (or `lib/transactions/serialize.ts`). Pure refactor, byte-identical output, kills the drift risk (the AccountModal copy already drifted: it omits `currency`).
2. `TransactionDetail` DTO + `getTransactionDetail(id, spaceCtx)` + `GET /api/transactions/[id]` — a superset of the row DTO adding: resolved account context (`{ id, name, institution, mask, type }` via the displayName resolution order), flow explanation block (`reason`, `confidence`, humanization left to the client), provider provenance block (`pfcPrimary/Detailed/ConfidenceLevel`, source: plaid | import | manual, import filename/date when applicable), counterparty (resolved, visibility-gated), and MC1 conversion (`native`, `reporting`, `estimated`, rate metadata — §7). The endpoint applies the §1.3 predicate as a *row-scoped* `findFirst` (id AND the same OR-visibility where-clause), returning 404 on any miss — indistinguishable for "doesn't exist" vs "not yours."

---

## 3. Surface architecture — modal, drawer, page, or route interception?

**Recommendation: a shared component rendered on `OverlaySurface` (the canonical Atlas Glass overlay primitive), presented at the `dialog` intent in v1 with a designed growth path to the `workspace` intent. Not a full page, not route interception, not a new bespoke drawer.**

Justification against the current architecture:

- **The app already ruled on this.** The Atlas Glass Modal Doctrine (docs/design-system/) exists precisely because eight bespoke overlay recipes diverged; `OverlaySurface` is the sanctioned primitive (portal, scrim, focus trap, esc, body-lock, z-tokens, mobile bottom-sheet/full-screen behavior) and the modal family is already migrating onto it (`AccountModal`, `RemoveAccountModal`, `AddWalletModal`, etc. import it today). A ninth bespoke recipe would be a regression against standing doctrine.
- **The canonical-inspection pattern in this app is the overlay, not the page.** Account inspection (`AccountModal`), KPI detail (`GlassModal` family), timeline (`TimelineModal`), briefing (`BriefModal`) are all overlays over a persistent Space-scoped shell. Transactions are inspected *from a filtered list the user just built* (account selection, category filter, date preset, search); a full page navigation would destroy that context and the user's scroll/filter state. The doctrine's intent taxonomy explicitly names detail overlays as `dialog` and large tool-like surfaces as `workspace` — the detail view starts as the former and becomes the latter as MI/AI sections accrete.
- **Route interception has zero precedent here.** The codebase contains no intercepted routes and no parallel `@modal` slots (verified: no `(.)`/`@` route directories). Route interception buys shareable URLs at the cost of adopting a routing pattern the team has never operated, with known dev-mode router friction already documented in this repo (E668 investigation). Deep-linking is real value — but it is available more cheaply as a **`?tx=<id>` search param** read by the shell (the Banking page already uses a `preselectedId` prop pattern for account preselection — the identical mechanism). That gives AI chat, the Daily Brief, and future notifications a stable link target without touching the routing architecture. Ship the overlay first; add the search-param sync as its own tiny slice.
- **A full page remains a possible v3+ complement** (a `transactions/[id]` page that renders the same shared component full-bleed, for very deep MI/audit content), which is exactly why the recommendation is *shared component first, presentation second*: `TransactionDetail` (content) must not know whether it lives in an overlay or a page. The doctrine's `workspace` intent already goes near-full-screen, so the pressure for a real page may never materialize.

---

## 4. Information architecture — sections, v1 vs later

Ordered top-to-bottom as rendered. The organizing principle: **the fact first, the interpretation second, the machinery last — and every interpreted value can answer "why?"**

| Section | Contents | Phase |
|---|---|---|
| **Overview (header)** | Merchant display name, amount (signed, colored by direction), native + reporting currency (§7), date, pending chip, category chip, account line (institution · name · mask) | **v1** |
| **Flow** | FlowType + direction chips; "Why?" disclosure → humanized `classificationReason` + confidence (§6) | **v1** (disclosure content v1-lite) |
| **Account** | Resolved account card, tap-through to `AccountModal`/account surface; counterparty line when `counterpartyAccountId` resolves and is visible ("Transfer to → Chase Savings") | **v1** (counterparty line when populated) |
| **Technical metadata** | Collapsed by default: raw descriptor (`description`), first seen (`createdAt`), source ("Plaid · Chase", "Imported from chase.csv · Jul 3", "Manual"), external/plaid id **presence** not value | **v1** (collapsed) |
| **Provider metadata** | Collapsed: Plaid PFC primary/detailed + Plaid confidence, labeled explicitly as "provider's opinion, not Fourth Meridian's" | **v1-lite** (fields exist); grows with metadata-depth capture (payment channel, authorized date, location) — **later, gated on that separate capture decision** |
| **Related transactions** | "More at this merchant" — read-time `canonicalKey` match (exists today), superseded by Merchant `id` match post-MI-M4 | **v2** (cheap, but not v1 — keep v1 read-only single-row) |
| **Merchant** | Merchant profile block (§5) | **MI-gated** (M4/M5) |
| **Timeline** | Pending→posted linkage, authorized vs posted dates | **later** — requires capturing `pending_transaction_id` / `authorized_date` (metadata-depth investigation), not stored today |
| **Location** | Map/address | **later** — nothing stored; capture decision + PII review first |
| **Notes** | User-private free text | **later** — no schema; new model (§9) |
| **Attachments** | Receipts/files | **later** — no schema, no storage substrate in the app today; largest new infra item |
| **AI** | Contextual actions (§8) | **later** |
| **Audit history** | Correction/override history for THIS row | **MI-gated** — first real writers are MI corrections |

v1 is deliberately **read-only and stored-data-only**: Overview, Flow, Account, collapsed Technical + Provider metadata. That alone surfaces roughly a dozen facts the product currently computes and hides, with zero new capture, zero writes, and zero new privacy surface beyond the existing predicate.

---

## 5. Merchant Intelligence compatibility

Assume the MI persisted tier (M1–M6) exists: `Merchant` + `MerchantAlias` (identity), `MerchantRule` + row overrides with `categorySource` provenance (relationship), Space-scoped rules as read-time overlay (context).

How the surface changes:

- **The header stops being a string.** `merchant` (string) resolves through `merchantEntityId`/alias → a `Merchant` entity: canonical display name, eventually logo/website. The raw descriptor demotes to the Technical section permanently ("Your statement says: `SQ *BLUE BOTTLE #442`").
- **The Merchant section becomes the relationship view:** aliases observed for this merchant, "you've transacted here N times since …, typically ~$X" (relationship-layer facts), user's rename, active rules that touch this merchant, cadence claims when v2.6b lands (always shown as scored claims, never facts — per the MI product architecture).
- **The correction gesture lives here.** The MI forms investigation designs the one-gesture correction ("this is X → apply to this transaction / always for this merchant / in this Space"); this modal is its primary host. Every gesture maps to exactly one documented write (row override with `categorySource=USER_OVERRIDE`, or a `MerchantRule`), each of which recomputes flow (the category-rewrite invalidation contract) and writes an AuditLog entry — which is what eventually populates this surface's own Audit section.
- **"Why this category?"** graduates from the v1-lite flow disclosure to the full provenance explainer: resolved category + `categorySource` + the rule/override that set it + the provider's original opinion. Three rows to read, zero inference — flagged by the MI product architecture as a v2.5 MVP-class trust feature.
- **Merchant confidence** — identity-resolution confidence (alias matched vs entity-id matched vs minted) surfaces in the Merchant section's disclosure, mirroring the flow-confidence pattern so the product has ONE confidence idiom.

**Should the modal become the primary MI entry point?** **Yes — for corrections and provenance; no — not the only merchant surface.** The correction moment is inherently transactional: the user is looking at a row they distrust. That makes this modal the natural (and recommended primary) entry point for the learning loop. But merchant-level browsing ("all my subscriptions", "everything at Amazon across accounts") wants a merchant-centric surface later; the modal's Merchant section should link out to it when it exists. Design the Merchant section as an embedded, reusable `MerchantSummary` component so the future merchant page is composition, not duplication.

---

## 6. FlowType compatibility

FlowType is complete (P5) and the fields are already on the wire in the row DTO. Display doctrine:

- **FlowType + direction: show plainly, humanized** ("Spending", "Income", "Transfer", "Debt payment"…) as a first-class chip next to category. Users should absorb flow semantics passively.
- **Confidence: behind the "Why?" disclosure, qualitative first.** Render bands ("high / medium / low confidence") with the numeric value available on hover/expand. A bare `0.85` on the main surface is noise; hiding confidence entirely would betray the product's transparency doctrine.
- **Rule source / reasoning: yes, humanized, in the disclosure.** `classificationReason` is a stable enum designed for exactly this: `PLAID_PFC_DETAILED` → "Based on the bank's detailed category (`FOOD_AND_DRINK_COFFEE`)"; `ACCOUNT_TYPE_CONTEXT` → "Because this happened in a credit-card account"; `SIGN_DEFAULT_SPENDING` → "Defaulted from the amount direction — low certainty". A small pure mapping function (mirroring the classifier's own doctrine of determinism) turns each reason + the persisted pfc fields into one sentence. **This is buildable in v1 with zero new data.**
- **Manual override: not yet — and never directly on flow.** Post-P5, flow is derived (single semantic authority): users correct the *category* (MI M5), and flow recomputes through `classifyFlow` under the rewrite-invalidation contract. Exposing a direct flow override would create dual authority and desync — the exact class of bug the P5 closeout named as residual debt. The modal should therefore show "want to change this? correct the category" as the affordance, once MI editing lands.
- `classifierVersion` stays internal (support/debug only).

---

## 7. Multi-currency compatibility (MC1)

MC1 Phases 0–3 are live: rows carry a native `currency` stamp (nullable = pre-provenance residue), `Space.reportingCurrency` is authoritative, conversion is read-time and pure (`convertMoney` — never excludes, never throws, flags `estimated`), historical rows convert at their own dates (convert-then-sum, historical FX never today's rate), and the "≈ / est." quiet-marker idiom already exists (`NetWorthCard`).

Recommended presentation — **layered, native-first**:

- **Native amount is the headline.** The transaction is an immutable fact denominated in its native currency; that is what the bank statement says and what the user recognizes. `−SAR 57.50`, full size.
- **Reporting amount is the subtitle** when native ≠ Space reporting currency: `≈ $15.33` in secondary type. Omit entirely on the identity path (same currency) — no visual tax on the all-USD majority, matching the Phase 3 neutrality doctrine.
- **Estimated marker:** the existing "≈ / est." idiom appears exactly when `convertMoney` returns `estimated: true` — i.e. rate miss, or **null-residue currency** (in which case the honest rendering is the amount + "currency not recorded for this older transaction" in the disclosure, never a fabricated conversion).
- **Rate + effective date: in the disclosure, not the surface.** Expanding the converted figure reveals: "Converted at 1 USD = 3.7505 SAR, rate for 2026-06-14 (transaction date)" — sourced from the `conversion` metadata `convertMoney` already returns (rate, resolved date, walk-back distance). This is also where historical FX gets *explained*: "historical conversions always use the rate from the transaction's own date, so this figure never changes as today's rate moves." One sentence, enormous trust value, zero new data.

So: expose **Native (headline) + Converted (secondary) + Rate & effective date (disclosure)** — the full set, but layered so the default view stays simple. Simpler alternatives (converted-only) would contradict MC1's own charter (native facts are the truth; conversion is presentation).

---

## 8. AI compatibility

Current constraints that shape this: AI context is Space-scoped and summary-only; drilldowns are bounded evidence; `DrilldownTransaction` has no row `id`; there is no per-row AI feature anywhere.

| Capability | Verdict | Notes |
|---|---|---|
| **"Why was this categorized?"** | **v1 — but deterministic, not AI** | The §6 disclosure answers it from stored provenance. Do NOT spend an LLM call on what three columns already state; the MI product architecture makes the same call. AI phrasing can layer on later. |
| **"Explain this transaction"** | **later** | Legitimate LLM use once the surface exists: composes merchant, flow, cadence, account context into prose. Needs a per-row entry into the chat context — recommend a `TRANSACTIONS_RAW`-style single-row domain (the placeholder domain already exists in `lib/ai/types.ts`) gated by the same visibility predicate. |
| **"Have I spent here before?"** | **v2 as a deterministic query** (Related-transactions section, canonicalKey match); **later** as an AI-phrased answer with cadence claims (v2.6b) | |
| **"What changed?"** | **later / MI-gated** | Meaningless until there is an audit trail of changes (MI corrections). Once AuditLog rows exist for the transaction, this is deterministic first, AI-phrased second. |
| **Deep links from chat/Brief into the modal** | **early (Phase 2/3)** | Add `id` to `DrilldownTransaction` + the `?tx=` search-param target. The AI stops describing rows it cannot point at. Cheap, high leverage. |
| **AI-initiated edits** (auto-recategorize from chat) | **never directly** | AI may *propose*; writes go through the same MI correction endpoints with the same provenance (`categorySource` would need an AI-source rank below USER_OVERRIDE — an MI M0 ratification question, already in that plan's open questions). The AI never becomes an unattributed writer — "everything the system knows is a readable row with provenance." |

---

## 9. Editing philosophy

**The fact is immutable forever. Interpretation is editable with provenance. Annotation is free.**

| Layer | Fields | Policy |
|---|---|---|
| **Immutable forever** | `date`, `amount`, `currency` (native stamp), `pending` (provider-owned), `plaidTransactionId`, `externalTransactionId`, `merchantEntityId`, `pfcPrimary/Detailed/ConfidenceLevel`, `importBatchId`, provider `description`/raw descriptor, `createdAt` | These ARE the financial fact + its provenance. No endpoint should ever accept them. Corrections to genuinely wrong provider data are a provider dispute, not an edit — at most a future annotation ("user flags as erroneous") layered alongside, never a mutation. |
| **Editable interpretation** (MI-gated, provenance-stamped, flow-recomputing, audit-logged) | `category` (row override, `categorySource=USER_OVERRIDE`); merchant identity correction ("this is actually Blue Bottle" → alias/rule, per MI M5); merchant display rename (relationship-layer nickname — note: *merchant* nickname, not per-transaction; a per-row nickname is an anti-feature that fragments merchant identity) | Every write: (1) stamps who/why, (2) recomputes flow via `classifyFlow` (rewrite-invalidation contract), (3) writes AuditLog. Space-scoped recategorization is a read-time overlay, never a row mutation (shared rows serve multiple Spaces). |
| **Free annotation** (new schema, later phases) | notes/memo (one concept — recommend a single `note` field, user-private), tags, attachments/receipts | Recommend a **sidecar model** (e.g. `TransactionAnnotation`, one row per user per transaction) rather than columns on `Transaction`: keeps the fact table pure, gives annotations their own owner/privacy boundary (private to the author by default — a shared account's transaction row serves multiple viewers), and makes rollback trivial. Attachments additionally need a storage substrate (none exists in the app) — sequence last. |

Also permanently non-editable: `flowType`/`flowDirection` directly (§6 — derived, corrected only through category), and all soft-delete/versioning bookkeeping.

---

## 10. Technical roadmap — reversible slices

The proposed sequence refines the strawman: DTO first, read-only surface second, then *provenance display before MI editing* (because it needs no new writes), then MI, then annotation, then AI. Each slice is independently shippable and independently revertible; no slice mutates stored financial facts.

**Phase 1 — Canonical transaction DTO + single-row read.**
Extract `serializeTransactionRow()` (kills the 4-way mapping duplication); add `TransactionDetail` DTO, `getTransactionDetail()`, `GET /api/transactions/[id]` with the §1.3 predicate.
*Blast radius:* `lib/data/transactions.ts`, one new route; list surfaces only via the extraction refactor. *Rollback:* revert commit — no schema, no UI. *Validation:* golden test pinning byte-identical list output pre/post extraction; endpoint tests for the visibility matrix (own row / FULL share / BALANCE_ONLY share → 404 / deleted row → 404 / other Space → 404), mirroring the KD-15 tripwire suites. *Neutrality:* zero visible change; pure additive read.

**Phase 2 — Read-only detail overlay (v1 surface).**
`TransactionDetail` component on `OverlaySurface` (dialog intent); rows in `BankingClient`, `AccountModal`, `SpaceTransactionsPanel`, `RecentTransactionsPanel` become clickable. Sections: Overview, Flow (chips only), Account, collapsed Technical/Provider metadata. MC1 layered amounts (§7).
*Blast radius:* the four list components gain an `onClick`; one new component tree. *Rollback:* remove the `onClick`s — the overlay is unreachable, dead code. *Validation:* a11y via OverlaySurface's owned behavior; snapshot tests on the DTO→section mapping; manual matrix of row archetypes (pending, legacy-FK, null-currency, UNKNOWN flow, imported, investment). *Neutrality:* lists render identically; the only change is rows becoming interactive.

**Phase 3 — Provenance & explanation ("Why?" lite) + deep links.**
Humanized `classificationReason`/confidence disclosure; conversion rate disclosure; `?tx=` search-param open; add `id` to `DrilldownTransaction` so chat/Brief can link in.
*Blast radius:* content inside the overlay + one serializer field + shell search-param read. *Rollback:* per-item revert; disclosure content is presentational. *Validation:* unit-test the reason→sentence mapping exhaustively over the enum (8 values); assert the serializer change is additive (golden chat-context test exists). *Neutrality:* no query or write changes.

**Phase 4 — Merchant Intelligence integration** (gated on MI M4/M5 landing on their own track).
Merchant section (`MerchantSummary`), full "Why this category?" with `categorySource`, the correction gesture, Related-transactions upgraded from canonicalKey to Merchant id. (Related-transactions in its canonicalKey form may ship earlier as Phase 3.5 if MI slips.)
*Blast radius:* overlay + the MI endpoints it calls (owned by the MI initiative, not this one). *Rollback:* feature-flag the section; the read-only surface stands alone. *Validation:* MI's own clobber-matrix and rewrite-invalidation tests; this surface adds interaction tests only. *Neutrality:* until a user corrects something, display-only.

**Phase 5 — Annotations: notes & tags, then attachments.**
New sidecar `TransactionAnnotation` model (additive migration, per-user privacy); notes/tags UI; attachments deferred within the phase until a storage decision (provider, encryption, quotas) is made.
*Blast radius:* one new table, no existing column touched; two new endpoints. *Rollback:* drop feature flag; table is additive and side-car (fact table untouched — reversible by definition). *Validation:* privacy tests (author-only visibility across shared accounts), soft-delete behavior. *Neutrality:* rows without annotations render exactly as before.

**Phase 6 — AI actions.**
"Explain this transaction" via a single-row context domain (the reserved `TRANSACTIONS_RAW` seam), AI-phrased history once audit rows exist. AI proposals route through MI correction endpoints (§8: never an unattributed writer).
*Blast radius:* AI context builder + overlay actions. *Rollback:* remove the domain registration; deterministic surface unaffected. *Validation:* context-budget tests (the D6.3D budget work applies), visibility-predicate tests on the new domain. *Neutrality:* opt-in per interaction; no ambient writes.

**Explicitly out of scope for all phases:** metadata-depth *capture* (location, payment channel, timeline linkage — a separate schema/PII decision per `TRANSACTION_METADATA_DEPTH_INVESTIGATION.md`); any change to sync writers; any full-page route (revisit only if the workspace-intent overlay proves insufficient).

### Sequencing note against the live roadmap

The NEXT_INITIATIVE investigation (2026-07-05) queues Merchant Intelligence M1 as the next implementation initiative. Phases 1–3 here are deliberately **independent of and smaller than MI**, touch none of MI's files, and make MI *better* when it lands (the correction gesture gets a home instead of shipping into a rowless list). Phases 1–2 can therefore run before, alongside, or after MI M1–M3 without contention; Phase 4 is the explicit join point. If strict serialization is preferred, the natural insertion is Phases 1–3 after the MI entry-gate items (desync remediation) and before or during MI's schema-only slices — but that is a scheduling choice, not a dependency.

---

## 11. Summary of recommendations

1. Build the Transaction Detail experience as a **shared component on `OverlaySurface`** (dialog intent → workspace growth path); no route interception, no new page, no ninth modal recipe.
2. Create the **canonical single-transaction DTO + `GET /api/transactions/[id]`** first — nothing reusable exists — and fold the four duplicated list mappings into one serializer while there.
3. Gate the endpoint with the **existing KD-15 visibility predicate**, failing closed; every joined enrichment inherits the gate.
4. Ship v1 **read-only, from stored data only** — the flow/provenance columns the product already persists are enough to make the surface feel intelligent on day one.
5. Treat the row as an **immutable fact**: edits are provenance-stamped interpretation (category/merchant, MI-gated, flow-recomputing, audit-logged) or side-car annotation (notes/tags/attachments) — never mutation of the fact.
6. Make this surface the **primary entry point for Merchant Intelligence corrections** and the home of "Why this category?" — the product's designated trust moment.
7. Present money **native-first with layered conversion** (reporting ≈ subtitle, rate + effective date in disclosure, honest `estimated` markers), per MC1 doctrine.
8. Keep AI **deterministic-first**: provenance answers "why" without an LLM; add `id` to `DrilldownTransaction` early so AI can point at rows; AI proposals write only through attributed correction endpoints.

**End of investigation. No implementation performed.**
