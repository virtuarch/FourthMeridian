> **INVESTIGATION + PRODUCT ARCHITECTURE ONLY — no implementation, no schema change, no migration, no code, no UI, and no roadmap-doc change is made by this document.** Verified against the working tree at STATUS.md checkpoint `f22de52`. Technical inputs: `MERCHANT_INTELLIGENCE_PERSISTED_TIER_PLAN_2026-07-05.md` (the slice plan — schema, precedence, clobber matrix) and `MERCHANT_INTELLIGENCE_FORMS_INVESTIGATION_2026-07-05.md` (the ratchet architecture and forms comparison). This document reasons from the **product** perspective and does not re-derive what those two establish; where it constrains them further, it says so explicitly. MC1 Phase 0 is running separately; nothing here starts before it lands.

# Merchant Intelligence — Product Architecture Investigation

**Date:** 2026-07-05
**Standing constraints (restated as product invariants, honored throughout):** MC1 Phase 0 lands before MI implementation · FlowType stays the single semantic authority · every category rewrite recomputes flow · Space-specific categorization never mutates shared Transaction rows · everything the system "knows" is a readable row with provenance.

---

## 0. Executive summary

The product question underneath Merchant Intelligence is not "how do we categorize transactions better." It is: **when a user looks at a line in their ledger, do they trust it — and when they don't, can they fix it in one gesture and have the fix stick forever?** Everything else (dictionaries, rules, cadence, promotion) is machinery in service of that moment of trust.

This investigation defines the Merchant as a **three-layer product object** (§1): global identity facts, the user's private *relationship* with the merchant, and per-Space context — three layers because they have three different owners, three different privacy boundaries, and three different stores. It walks the learning loop as a product narrative (§2), designs the correction experience as the product's single most important interaction and maps every gesture to exactly what it writes (§3), defines the promotion pipeline that turns private corrections into global knowledge without moving private data (§4), fixes the AI doctrine in product terms (§5), describes the five-year multi-region end state (§6), and closes with a now-vs-later recommendation that confirms and product-frames the persisted-tier slice plan (§7).

One product decision proposed here goes beyond the prior docs: **"Why this category?" (the provenance explainer) should be treated as a v2.5 MVP feature, not deferred polish** — it is the cheapest trust feature the architecture makes possible (three rows to read, zero inference), and it is the visible proof that Fourth Meridian is not a black box, which is the product's core differentiator against every ML-categorization competitor.

---

## 1. What does a Merchant know?

### 1.1 The three-layer Merchant object

A "Merchant," as the product should conceive it, is not one record — it is three layers with different owners:

| Layer | Owner | Store | Example content |
|---|---|---|---|
| **Identity** — facts about the merchant itself, true for everyone | the deployment (eventually: the global catalog + editorial function) | `Merchant`, `MerchantAlias`, future enrichment/graph | "This is Netflix. These 9 descriptors are Netflix. Netflix is a subscription business. netflix.com. US-origin, global." |
| **Relationship** — facts about *this user and* the merchant | the user, privately | `MerchantRule` (USER), row overrides, future cadence/behavior records | "I've paid Netflix 22× monthly, ~$15.49, since 2024. It renews around the 12th. I categorize it Subscriptions. I renamed the descriptor blob to 'Netflix'." |
| **Context** — how a particular Space frames the merchant | the Space (admins) | `MerchantRule` (SPACE) as a **read-time overlay**, never a row write | "In the business Space, Amazon is Supplies. In the family Space, it's Shopping." |

This split is the product answer to several hard questions at once: it is why a Space rule can't corrupt a partner's view (context is a lens, not a mutation), why corrections survive provider re-syncs (relationship outranks identity in the clobber matrix), and why promotion is possible without privacy leakage (only the identity layer ever moves between users — §4).

### 1.2 Field-by-field placement

Every field the product could want, sorted by tier. "v2.5 required" matches the persisted-tier plan's M1–M6; nothing here expands that scope.

**v2.5 required (identity + relationship minimum):**

| Field | Layer | Why now |
|---|---|---|
| Canonical name (`displayName`) | Identity | The ledger stops showing `SQ *BLUE BOTTLE #442` |
| Canonical key + Plaid entity id | Identity | The identity spine; already seeded by `merchantEntityId` |
| Aliases (observed + user-attached) | Identity | One fix applies everywhere — the generalization primitive |
| Category (resolved per precedence, stamped with `categorySource`/`categoryRuleId`) | Relationship-dominant | The core symptom being fixed. Note the product truth: **category is not a property of the Merchant — it is a property of the user's relationship with the merchant**, with global/provider tiers as defaults. `Merchant.defaultCategory` stays informational, never a resolver input |
| Provenance (who set this, and why) | Meta, all layers | The trust substrate; powers "Why this category?" (§3.6) |
| Confidence (on inferred values, as the flow classifier already does) | Meta | Pattern adopted now so v2.6b consumers can gate on it |

**v2.6 useful (intelligence):**

| Field | Layer | Notes |
|---|---|---|
| Recurring likelihood + cadence (interval, tolerance, next-expected, typical amount) | Relationship | v2.6b flagship (persisted cadence records replacing the throwaway read-time heuristic). Always a scored claim, never a fact |
| Subscription likelihood | Identity ("is a subscription *business*") × Relationship ("recurs *for me*") | The PlayStation trap requires both dimensions; conflating them is the known failure |
| Parent company / brand family | Identity | Start as a single `parentMerchantId` self-relation (Uber Eats→Uber); full graph later |
| Country/region + locale tag | Identity | Already metadata on Slice-1 rules; becomes load-bearing when regional catalogs exist |
| Business-vs-personal context | Context | This is precisely what the SPACE overlay expresses — a business Space's rules ARE the business context. No new field; wiring the overlay is the feature |
| Notes / history | Relationship | User-private free text + the correction history (already derivable from AuditLog + provenance) |

**Later enrichment:**

| Field | Notes |
|---|---|
| Logo, website, industry/MCC | Presentation enrichment; needs a fetch/licensing pipeline and a visibility review (enrichment for a BALANCE_ONLY-shared account must fail closed). Plaid already sends `logo_url`/`website` — capture-at-sync is cheap when a slice touches the sync path anyway, *display* is the deferred part |
| Known currencies | Emergent from MC1, not stored on the Merchant: once Phase 2 lands, "currencies I've paid this merchant in" is a query over stamped rows. Don't duplicate it as a field |
| Tax relevance | Jurisdiction-dependent and adjacent to tax *advice*. Later, business-Spaces-first, expressed as category→tax-treatment mapping per jurisdiction (a reference table), never as per-merchant advice. Ships with disclaimers and probably professional review |
| Merchant knowledge graph (beyond parent) | When brand-level rollups become a real product surface |

**Never / too risky:**

- **Person counterparties as Merchants.** Zelle/Venmo/payroll names are people, not merchants — the PII minting guards exist for this. P2P intelligence, if ever, is a different product with different consent.
- **Counterparty account/routing identifiers** anywhere in the merchant layer (standing deny-list).
- **Scraped/unlicensed enrichment** (logos, corporate data) — legal exposure for a finance product; license or skip.
- **A global "what other users pay here" field.** Amounts never cross the user boundary, aggregated or not — even where k-anonymity might technically permit it, the product should not want it. Merchant facts move; money facts don't.
- **Auto-inferred tax deductibility presented as fact** — advice territory; see legal/financial caveat norms.

---

## 2. How does a Merchant become smarter?

The learning loop, told as the product story it is — one merchant, eighteen months, every step a readable row:

1. **A raw transaction appears** (day 0). `GATHERN RIYADH 4453` syncs; Plaid sends no useful PFC, no entity id. Identity resolution finds no alias, no canonical-key match → guarded mint: a new `Merchant` row, displayName "Gathern", one observed alias. Category resolves through the chain → Slice-1 regional rule fires → `Travel`, `categorySource=GLOBAL_RULE`. FlowType classifies SPENDING downstream. *The system knew this one because a maintainer once did.*
2. **A harder one appears.** `POS 7724 ALNAHDI PHARM` — no rule, no PFC → `Other`, `categorySource=PROVIDER`, honest and visibly unresolved. *The system knows that it doesn't know: null-adjacent states are product states, not failures.*
3. **The user corrects** (week 2). One gesture: Medical, apply to all from this merchant. Writes: a USER `MerchantRule`, re-resolution of that merchant's past rows (each stamped `USER_RULE` + ruleId, flow recomputed), AuditLog entry. *One correction fixed history and future simultaneously.*
4. **An alias is learned** (month 2). A differently-formatted descriptor from the same pharmacy chain shows as a separate merchant; the user attaches it ("this is also Al Nahdi"). One `MerchantAlias` row; both streams now converge on one Merchant, and the existing rule covers the new stream with zero extra effort. *Corrections compound.*
5. **Behavior is observed** (month 6, v2.6b). The cadence detector — a versioned batch job — finds 6 charges at ~30-day intervals at stable amounts for the user's gym and writes a cadence record with confidence 0.86. The Brief starts saying "renews around the 3rd." *The claim cites its evidence: 6 observations, listed.*
6. **Confidence improves as evidence accrues** (month 9). Two more on-schedule charges lift the recomputable evidence-function score to 0.93; a skipped month decays it and the Brief goes quiet instead of guessing. *Self-assessment is visible behavior.*
7. **A candidate is promoted** (multi-tenant future). Forty-one distinct users have corrected Al Nahdi to Medical. The k-anonymous aggregate — merchant key, target category, distinct-user count, nothing else — enters the editorial queue; a curator accepts; the MENA catalog release r112 ships the rule. *Knowledge moved; no user's data did.*
8. **Every future user benefits** (day 0 for them). A new user in Jeddah syncs their first month and Al Nahdi lands as Medical, `categorySource=GLOBAL_RULE`, catalog r112 — traceable to the release, which is traceable to the review, which is traceable to an anonymous count. *The loop closed.*

**Why this is not opaque ML:** at every numbered step, the thing that changed is a row (`Merchant`, alias, rule, cadence record, catalog release) that a human can read, and the thing that decided is either a deterministic resolver, a versioned re-runnable detector, or a person. Nothing updated a weight; nothing is unexplainable; "why?" is always answerable by walking provenance backwards — which is exactly the ratchet constitution (forms investigation §4.2) operating as product behavior.

---

## 3. The user correction experience

### 3.1 Design principles

The correction surface is the product's most important interaction: it is simultaneously the user's control over their own ledger *and* the system's only training signal. Principles: **one gesture, immediate effect** (no "pending recategorization"); **scope is explicit but defaulted** (the sheet offers once/all/future/Space, with "all from this merchant" the sensible default for merchant-identity corrections and "just this one" for one-off anomalies); **corrections are visibly sticky** (a badge distinguishes "you set this" from "auto"); **everything is undoable**; **the system can always explain itself.**

### 3.2 The correction sheet (future flow, from the transaction row)

Tapping a transaction's category/merchant opens one sheet with two sections — *what* ("this is actually…": category picker; merchant identity: "this is also <existing merchant>" / rename) and *where it applies* (this transaction only · all past + future from this merchant · future only · only in this Space [when overlay ships]). Beneath, always: **"Why did Fourth Meridian pick this?"** (§3.6) and, where a correction exists, **Undo**.

### 3.3 The writes matrix — what each gesture persists

| Gesture | Transaction row | MerchantAlias | MerchantRule | Space overlay | AuditLog | Promotion signal (future) |
|---|---|---|---|---|---|---|
| **Change category, this transaction only** | ✅ category + `categorySource=USER_OVERRIDE`, flow recomputed via the rewrite helper | — | — | — | ✅ from→to, actor, rowId | ✅ implicit (the override row IS the signal) |
| **Change category, all from this merchant (past + future)** | ✅ each re-resolved past row: category + `USER_RULE` + ruleId, flow recomputed; rows the user individually overrode untouched (rank guard) | — | ✅ create/update USER rule | — | ✅ rule created + N rows re-resolved | ✅ the rule row |
| **Future only** | — (past untouched) | — | ✅ USER rule (write-path only; no re-resolution) | — | ✅ | ✅ |
| **Only in this Space** (deferred slice) | ❌ **never** — the standing constraint | — | ✅ SPACE rule | ✅ applied at read time in that Space's views | ✅ | ✅ (Space-context signals promote separately, if ever) |
| **"This is also <merchant X>"** (identity attach) | merchantId re-pointed on matching rows (identity, not category — no flow impact) | ✅ alias row, `source=USER` | — (X's existing rules now cover these rows automatically) | — | ✅ | ✅ (alias co-occurrence evidence) |
| **Rename merchant** | — | — | — | — | ✅ | — |
| **Undo a row override** | ✅ re-resolved through the **automatic chain** (provider + rules), stamped with whatever tier fires — *not* a blind restore of the prior value, which may itself have been stale | — | — | — | ✅ | signal retracted |
| **Undo / delete a rule** | ✅ rows stamped with that ruleId re-resolved through the automatic chain; `USER_OVERRIDE` rows untouched | — | ✅ soft-delete (`active=false`, deletedAt) | — | ✅ | signal retracted |

Two product notes on this matrix:

- **Rename needs a scope decision.** "This is really Blue Bottle" is identity correction (alias attach — supported v2.5). "Call this one 'Gym'" is cosmetic preference. In today's single-user deployment, writing `Merchant.displayName` is harmless; in a multi-tenant world it edits a *global* identity row. Recommendation: v2.5 ships identity-attach only; cosmetic rename waits for a user-scoped display-label field (recorded in §7 deferred) so we never teach users a gesture that later has to change meaning.
- **No separate "promotion event" table is needed yet.** Every user rule and override *already is* the promotion evidence, carrying merchant, target, actor, and timestamp with provenance. The pipeline (§4) aggregates what exists. Decision recorded so nobody builds an event stream prematurely.

### 3.4 Undo semantics (product contract)

Undo means "return this to what the system would say on its own today," not "restore yesterday's value." This is deliberate: the automatic chain may have improved since the correction was made (new catalog release, better PFC), and re-resolving through it is both more honest and provenance-clean. The AuditLog preserves the full history for anyone who wants archaeology.

### 3.5 Sync-safety as a product promise

The clobber matrix (persisted-tier plan §3.8) surfaces to the user as a one-line promise worth putting in the UI copy: **"Your corrections are never overwritten by a bank sync."** This promise is the emotional core of the feature; the matrix is merely its implementation.

### 3.6 "Why did Fourth Meridian pick this?" — the provenance explainer

Reads three things — `categorySource`/`categoryRuleId`, the persisted `pfcPrimary`/`pfcDetailed`, and (when relevant) the matched rule/alias — and renders a deterministic explanation:

> *Subscriptions — because you set a rule for **Anthropic** on May 3.*
> *Travel — matched Fourth Meridian's built-in rule for **Careem**.*
> *Dining — your bank's network classified this as Food & Drink.*
> *Other — we couldn't identify this merchant yet. Fix it once and it stays fixed.*

Zero inference, three-hop lookup, and the `Other` case doubles as the correction call-to-action. **Recommendation: pull this into the v2.5 MVP** (it rides M5's surface with trivial marginal cost). An LLM may later *phrase* the sentence; the facts in it come from rows only (§5).

---

## 4. From one user to the system — the promotion pipeline

Six stages, with the privacy boundary drawn between 2 and 3:

1. **Private by default.** Every override, rule, and alias is user-scoped data. It affects no one else and never leaves the user's deployment/region. This is the permanent default, not a launch limitation.
2. **Signal accrual (automatic, local).** The evidence *is* the existing rows (§3.3). Nothing extra is collected.
3. **Candidate formation (automatic, aggregate — the boundary crossing).** A periodic job computes, per (merchant identity × target category × locale): distinct-user correction count and agreement ratio. A candidate forms only when **k ≥ threshold distinct users** (k tuned per region, never below a floor like 25) *and* agreement is strong (e.g. ≥80% choosing the same target). What crosses the boundary: merchant key/entityId, target category, counts, locale. What never crosses: user ids, amounts, dates, raw descriptors that fail the PII deny-list (a descriptor embedding a person's name or account fragment disqualifies the alias from candidacy entirely — safety over coverage).
4. **Editorial review (human).** A curator sees the candidate queue with aggregate evidence and public information about the merchant. Accept → a versioned catalog change (code-catalog PR or dictionary fact) with the candidate id recorded as its provenance. Reject → recorded, with reason, so the same candidate doesn't re-queue forever. Review is not a bottleneck to apologize for; it is the mechanism that makes step 5 trustworthy. **Abuse and mislabeling risk lives here:** popularity is not correctness (a plausible-looking mass error — or, adversarially, coordinated mislabeling once accounts are cheap — must survive a human who can check that "Al Nahdi" is in fact a pharmacy). Additional dampers: k-floors, agreement ratios, per-merchant rate limits, and staged rollout (ship to a region cohort, watch the correction-rate metric, then widen).
5. **Catalog release (versioned, regional).** Global facts ship in locale-tagged releases (`global r83`, `MENA r112`) — a US user never inherits a rule that is only true in Riyadh, and vice versa. Release notes are the changelog of the system's knowledge.
6. **Benefit + measurement.** New syncs resolve through the updated catalog with `categorySource=GLOBAL_RULE` traceable to the release. The health metric closes the loop: **the correction rate for promoted merchants must fall.** A promotion that *increases* corrections is auto-flagged for review.

**Rollback of bad promotions:** revert the versioned release; re-resolve rows stamped `GLOBAL_RULE` + that release's rules through the corrected chain (flow recomputed via the rewrite contract, as always). The rank guard makes this safe by construction — rollback can never touch a row a user has personally corrected, so a bad promotion is embarrassing but never destructive. This symmetry (promotions and rollbacks are both just catalog versions + rank-gated re-resolution) is why the pipeline can be operated confidently.

---

## 5. The role of AI

### 5.1 Doctrine (restating the ratchet as product policy)

**AI proposes. Humans approve. Persisted knowledge stores facts. Deterministic systems consume facts. AI never silently writes truth.** This is the merchant-layer instance of the house rule already governing the chat pipeline (no LLM above the validator): model output is never a trusted fact source; it becomes real only by human ratification, at which point it is a row with provenance like any other — and the provenance says a model proposed it.

### 5.2 Appropriate AI uses

| Use | Where it sits | Why it's safe |
|---|---|---|
| Suggesting a merchant name for an unresolved descriptor ("probably Espresso House — a Swedish café chain") | Correction sheet suggestion / ratification-gate candidate | Displayed as a suggestion; persisted only on user accept (becomes an alias row, `source=USER`, with model-proposed noted in audit) |
| Suggesting aliases ("these 3 unresolved descriptors look like your existing merchant Al Nahdi") | Same gate | Same contract |
| Ranking correction-sheet options (most-likely category first) | Presentation ordering only | Ordering a list writes nothing |
| Phrasing the provenance explainer in natural language | Above deterministic facts | Facts come from rows; the model only renders prose — and the existing output validator applies |
| Flagging *possible* recurring merchants for the deterministic cadence detector to verify | Detector triage | The persisted cadence claim comes from the versioned deterministic detector, never from the model |
| Summarizing merchant behavior in chat/Brief ("you've spent 20% more at restaurants…") | Existing AI surface, downstream of stored facts | Already governed by the assembler + validator pipeline |
| Editorial triage of promotion candidates (drafting evidence summaries for the curator) | Curation tooling, below the human | The curator decides; the model clerks |

### 5.3 Inappropriate AI uses (hard product rules)

- **Silent recategorization** — a model changing `category` on any row, ever, with any confidence. Violates the rewrite contract's spirit and the trust promise of §3.5 in one stroke.
- **Unverified global merchant creation** — model-minted Merchant/catalog entries without ratification. One hallucinated merchant in the global catalog poisons every user and, worse, the promotion pipeline's credibility.
- **Hidden model-only memory** — any merchant knowledge living in fine-tunes, embeddings, or conversation memory rather than rows. If it isn't a row, the system doesn't know it; if the model "remembers" it anyway, that is a defect, not a feature.
- **PII egress without gating** — descriptors sent to external models must pass the same deny-list as minting; person-name transfer descriptors never leave the deployment.
- **Confidence theater** — model-emitted "confidence" numbers presented alongside the deterministic evidence-function scores. One confidence vocabulary, recomputable, or none.

---

## 6. World-class Merchant Intelligence — the five-year picture

Assume Fourth Meridian in 2031: personal and business users across the US, Spain and wider Europe, Saudi Arabia, the UAE, Kuwait, Panama; multiple aggregators (Plaid, EU open-banking, MENA providers), manual imports, brokerages, crypto exchanges.

**The global merchant knowledge base.** One provider-neutral registry: identity spine of provider entity ids (a table, not a column, by then) + canonical keys + alias sets + the brand graph (parent/franchise/processor edges — so "Amazon including Whole Foods and AWS" is a traversal, and Square is known as a rail, not ten thousand cafés). Every fact versioned, provenance-complete, regionally partitioned. The registry is the company's compounding asset — built from editorial curation, licensed reference data, provider signals, and the k-anonymous promotion stream, in that order of trust.

**Regional catalogs as first-class citizens.** The KSA catalog knows mada rails, STC Pay, Al Nahdi, Jarir, Tamimi, and SADAD biller patterns; the UAE catalog knows Careem/Noon/Salik/DEWA; Kuwait knows KNET descriptor formats; Spain knows Bizum P2P conventions (person-rail, never minted) and SEPA creditor-reference idioms; Panama knows Yappy and its USD-denominated bank formats. "Global" merchants (Netflix, Uber, Amazon) live once with regional alias sets. Catalog releases ship per region on independent cadences, curated by people who know the region.

**Multilingual normalization.** Tier A grows script- and locale-aware: Arabic descriptor normalization (including transliteration variants of the same merchant), Spanish accents/abbreviations, mixed-script MENA descriptors — as *versioned normalizer profiles* per locale, so a normalization improvement re-runs over history diffably, exactly like a classifier version bump. The conservative-merge doctrine survives translation: under-merge in every language, over-merge in none.

**Provider-neutral entity resolution.** A merchant seen through Plaid in the US, an open-banking aggregator in Madrid, a MENA provider in Riyadh, and a CSV import resolves to one registry identity. Provider taxonomies (PFC and its EU/MENA equivalents) all enter the precedence chain as ranked provider signals below user tiers — the chain's shape never changed, it just gained members. Brokerages and exchanges resolve to *venues* (an exchange is a counterparty-venue, not a spend merchant; crypto counterparties follow the MC1 crypto-as-asset doctrine and never masquerade as cash merchants).

**Business and personal contexts, materialized.** The Space overlay grown up: a business Space carries a business rule-set (Amazon→Supplies, meals→client-entertainment where jurisdiction cares), per-jurisdiction category→tax-treatment reference tables (KSA VAT/Zakat framing, Spanish autónomo categories, US Schedule C buckets) rendered as *information with provenance, never advice*, and export paths an accountant accepts. Same rows, different lens — the three-layer object of §1.1 paying off at scale.

**Recurring/subscription intelligence as the daily product.** Currency-aware cadence (an FX wobble is disclosed as FX, not a price hike — MC1's dividend), renewal forecasts across the user's whole subscription portfolio, price-increase and lapsed-biller and never-seen-merchant signals — every ambient claim citing its observation count and confidence, every threshold user-tunable, quiet by default.

**Explainable confidence + user-owned corrections, everywhere.** Every number the system shows can answer "why," in the user's language, in three hops. Corrections are portable (exportable with the user's data, GDPR-grade erasure provably cascading — including retraction of their contribution to aggregate counts). The k-anonymous promotion pipeline runs per region with regional editorial review.

**AI-assisted, never AI-owned.** By 2031 models triage the entire unresolved long tail, draft candidate evidence, converse about merchant behavior in Arabic and Spanish — and still cannot write one fact without ratification. The pitch that wins in every one of these markets, consumer and business alike: *Fourth Meridian's intelligence is the kind you can audit.*

---

## 7. Build now vs later — product-oriented recommendation

Confirms the persisted-tier slice plan (M0–M6) and frames it by user-visible value; adds one MVP promotion (§3.6) and names what each later window unlocks.

### v2.5 MVP — "Correct it once, it stays fixed, and the system can explain itself"

Gate: MC1 Phase 0 landed; then M0–M6 as planned. User-visible outcome: real categories instead of `Other` (enum expansion + PFC bucket rescue + catalog), merchant names instead of descriptor debris (dictionary), one-gesture correction with once/all/future scopes (overrides + USER rules), corrections that provably survive syncs, the "auto vs you-set-this" badge, **and the provenance explainer (§3.6) — promoted into the MVP by this investigation.** Everything else in this document depends on the data v2.5 starts accumulating; every week of delay is uncollected evidence.

### v2.6 — "The system starts noticing things" 

**v2.6a (advisor window):** Space overlay wired (business-vs-personal context — the read-time lens, with its KD-19 privacy proof); rules-management surface (a user's rules stop being invisible policy); AI chat consumes resolved merchants + explains provenance conversationally (M6 read-cutover consumers).
**v2.6b (ambient window):** persisted cadence detection replacing the throwaway heuristic (needs D5 jobs + the Float→Decimal plan); confidence becomes load-bearing (Brief/ambient gate on it); deterministic-grade alias auto-discovery (entityId co-occurrence — auto-acceptable because provable); first ambient merchant signals (renewal reminders, price-change flags), conservative thresholds, quiet by default.

### Later enrichment

Presentation enrichment (logos/websites — capture may ride earlier sync-path slices; display waits for the visibility review); `parentMerchantId` self-relation → brand rollups; LLM-assisted resolution behind the ratification gate (long-tail leverage, PII-gated); fuzzy suggestions in the correction sheet; multilingual normalizer profiles; jurisdictional tax-treatment reference tables; the promotion pipeline *mechanism* (multi-tenant prerequisite — but its *evidence* accumulates from v2.5 day one, which is the point).

### Explicitly deferred / never

Deferred with named triggers: cosmetic per-user merchant rename (wait for a user-scoped label field — §3.3); Space-signal promotion; offline clustering as curation tooling (multi-tenant scale); full knowledge graph (a real brand-rollup consumer). Never: silent fuzzy/ML resolution on the write path; person-counterparty merchants; cross-user amount visibility in any form; model-owned memory; silent AI recategorization (§5.3).

---

*End of investigation. No implementation, schema, migration, code, UI, or roadmap-doc change was made. Suggested next step: fold §3.6's MVP promotion and §3.3's rename-scope decision into the MI M0 ratification list alongside the items already queued there.*
