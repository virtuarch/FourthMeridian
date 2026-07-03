> **INVESTIGATION ONLY — no code, schema, migration, or UI changes were made to produce this document.** For current project state see `STATUS.md` at the repository root.

# Merchant Normalization Evolution Investigation

**Date:** 2026-07-03
**Branch:** `feature/v2.5-spaces-completion`
**Baseline:** v2.5 (v2.4.5 tagged; c1 merchant-normalization test suite landed)
**Status:** Investigation complete — architecture recommendation only. No implementation.
**Scope guard:** Investigation only. No Atlas, Liquid, Brief, SpaceDashboard, or visual-component work. No UI, no schema, no code.

**Reads on:**
- `lib/transactions/merchant.ts` (`normalizeMerchant` — Tier A, the c1 subject)
- `lib/transactions/fingerprint.ts` (`normalizeMerchantKey` — the *second*, competing normalizer)
- `lib/ai/assemblers/transactions.ts` (the only current consumer of `normalizeMerchant`)
- `lib/plaid/syncTransactions.ts` (what provider metadata is captured vs. discarded)
- `docs/investigations/FLOWTYPE_FOUNDATION_INVESTIGATION.md`, `TRANSACTION_METADATA_DEPTH_INVESTIGATION.md` (the parallel v2.5/v2.5.5 data-model work)

---

## 1. Executive summary

Merchant normalization today is a single pure function (`normalizeMerchant`) that turns a raw bank-feed descriptor into a `{ canonicalKey, canonicalName }` pair, used at read time by exactly one consumer (the AI transactions assembler's merchant rollup). Its own module header already anticipates the destination: it calls itself the conservative "Tier A" compute layer and explicitly defers "city/state canonicalization … to the later persisted canonical-dictionary tier (Tier B)."

The right long-term shape is a **first-class `Merchant` entity**, resolved at write time by a **classifier module** whose deterministic string layer is exactly today's `normalizeMerchant`, feeding a **persisted canonical dictionary**, enriched by **provider-supplied identity that the app already receives and currently throws away** (`merchant_entity_id`, `merchant_name`, `logo_url`, `website`, `counterparties[]`, `personal_finance_category`). This is the *same architectural template* the FlowType initiative (v2.5.5) is proposing for economic semantics: a write-time classifier → an additive persisted field → read-time consumers that stop re-deriving. Merchant identity and flow semantics are orthogonal dimensions (who the counterparty is vs. what kind of movement it is) and should evolve as parallel, non-competing layers.

**`normalizeMerchant` evolves; it is not replaced.** It becomes the deterministic *resolver of last resort* inside the classifier — the thing that produces a stable key when a provider gives no merchant id, and the fallback that keeps the dictionary honest. Nothing about first-class merchants requires rewriting it; they wrap it.

**The single most important near-term finding** is not about the future entity at all: **there are already two independent merchant normalizers in the tree** — `normalizeMerchant` (this doc's subject) and `normalizeMerchantKey` in `fingerprint.ts` (used by CSV import matching and the sync fingerprint fallback). They have different, drifting rules for "the same merchant." That is a latent KD-11-class duplication and the most valuable thing to consolidate *before* any entity work begins.

---

## 2. Current state — precisely what exists

### 2.1 Two normalizers, two contracts

| | `normalizeMerchant` (`lib/transactions/merchant.ts`) | `normalizeMerchantKey` (`lib/transactions/fingerprint.ts`) |
|---|---|---|
| **Output** | `{ canonicalKey, canonicalName }` (grouping key + display name) | a single uppercased key string |
| **Rules** | strips leading payment-rail prefixes (SQ/TST/PAYPAL/POS/ACH/CHECKCARD/…), drops store numbers / long digit runs / masked card tails, title-cases ALL-CAPS, never-empty fallback | trim + collapse whitespace + uppercase, *deliberately* strips nothing else |
| **Purpose** | merchant **rollup** for AI context ("top merchants by spend") | transaction **dedup / match** (fingerprint fallback + CSV clean-match) |
| **Consumers** | `lib/ai/assemblers/transactions.ts` (rollup only) | `lib/plaid/syncTransactions.ts` fingerprint fallback, `lib/imports/csv.ts` match path |
| **Bias** | aggressive-but-conservative (merge spellings of one merchant) | maximally conservative (must NOT merge two real transactions) |

The two biases are **intentionally opposite** — a dedup key must not over-merge, a rollup key wants to. That is a legitimate reason for two functions, but today they are two *unrelated* implementations with no shared vocabulary, so they will drift. This is the KD-11 pattern (duplicated, drifting keyword heuristics) applied to merchant identity.

### 2.2 What the provider already gives us and we discard

Per `TRANSACTION_METADATA_DEPTH_INVESTIGATION.md`, Plaid returns ~30 fields per transaction; the app persists ~7 and derives one enum from another. **Discarded today, but directly relevant to merchant identity:**

- `merchant_entity_id` — Plaid's **stable canonical merchant identifier**. This is decisive: for Plaid-sourced rows, canonical merchant identity does **not** have to be reconstructed from string normalization at all.
- `merchant_name` — Plaid's already-cleaned merchant name (vs. the raw `name` descriptor the app currently stores in `merchant`).
- `logo_url`, `website`, `personal_finance_category_icon_url` — display/enrichment.
- `counterparties[]{ name, entity_id, type, website, logo_url, confidence_level }` — richer than a single merchant, including payment processors and the true merchant behind a rail.
- `personal_finance_category{ primary, detailed, confidence_level }` — category + confidence, currently collapsed to one `TransactionCategory` enum.

The gap is not that the data is unavailable; it is that `syncTransactions.ts` reads six fields and the `Transaction` model has nowhere to put the rest. No `Merchant` model exists in `schema.prisma`.

---

## 3. Q1 — What a canonical Merchant should eventually contain

A mature `Merchant` record has four concerns. Not all belong in one phase (see §8).

**Identity (the join key):**
- `canonicalKey` — the stable grouping key (today's `normalizeMerchant` output; the fallback when no provider id exists).
- `providerEntityIds` — map of `{ provider → external merchant id }` (e.g. Plaid `merchant_entity_id`). The **preferred** identity when present; the string key is the fallback, not the primary.
- `displayName` — canonical human label (prefer `merchant_name` / curated over the raw descriptor).
- `aliases[]` — raw descriptors and alternate spellings observed to resolve to this merchant, with the rail/processor variants that produced them.

**Classification / reference data:**
- `defaultCategory` (+ confidence) — the merchant's dominant spend category, sourced from `personal_finance_category` and observed history, decoupled from any single row.
- `mcc` — merchant category code where a provider supplies it.
- `counterpartyType` — merchant vs. payment-processor vs. financial-institution vs. person (informs FlowType and rail-stripping).

**Presentation:**
- `logoUrl`, `websiteUrl`, `iconUrl` — enrichment for row lists, drawers, Brief, and AI citations. Lower sensitivity, but still gated by the FULL-only visibility predicate at the surface.

**Behavioral (derived, highest tier):**
- `recurringConfidence` / cadence — is this a subscription/recurring biller, and at what interval. Today this is recomputed heuristically at read time in the assembler (`recurringCandidates`); a Merchant entity moves it to a persisted, cross-window signal.
- `firstSeen` / `lastSeen`, observed frequency, typical amount range — the substrate for "your Netflix went up," anomaly detection, and price-change signals.
- `userOverride` — a per-user/space renamed or re-categorized merchant (user corrections are first-class, never silently overwritten by a later sync).

**Hard constraints carried from existing doctrine:**
- **PII deny-list.** Counterparty account/routing numbers, ACH payer/payee identifiers, and account-owner names are deny-listed *before persistence* (per the metadata-depth investigation). A Merchant entity must never become a back door for that data.
- **Visibility.** Any merchant field exposed on a surface obeys the same FULL-only predicate (`lib/ai/visibility.ts`) that governs transaction-level detail — merchant enrichment for a BALANCE_ONLY-shared account must fail closed.
- **Determinism.** Identity resolution stays deterministic and re-runnable (the property the whole AI pipeline depends on and that PE1/validator guard).

---

## 4. Q2 — Entity/table vs. pure string normalizer

**Both, in layers — and the pure normalizer never goes away.** The end state is a resolution stack:

1. **Tier A — pure string normalizer (today's `normalizeMerchant`).** Deterministic, no I/O, no dependency. Always present as the fallback and as the dedup/grouping primitive. This is what c1 just test-locked.
2. **Tier B — persisted canonical dictionary.** A `Merchant` row keyed by `canonicalKey` and/or `providerEntityId`, accumulating aliases, display name, category, enrichment. Resolves the "same merchant, many descriptors / many providers" problem that a pure function structurally cannot (it has no memory).
3. **Tier C — enriched entity.** Dictionary + provider enrichment (logo/website/MCC) + behavioral signals (recurring, cadence, price history) + user overrides.

A pure function alone can never carry cross-row memory, provider ids, user corrections, or enrichment — those *require* persistence. But a table without the pure function has no principled way to mint a key for a never-before-seen descriptor or a provider that supplies no id. So the mature architecture is **the function feeding the table**, not one replacing the other.

---

## 5. Q3 — How merchant normalization should interact with each surface

**FlowType (v2.5.5).** Orthogonal but mutually reinforcing. FlowType answers *what kind of movement*; Merchant answers *who the counterparty is*. They share a template (write-time classifier, persisted field, read-time consumers stop re-deriving) and should be built as parallel layers, not merged. Concretely: `counterpartyType` on a Merchant (processor vs. merchant vs. institution) *informs* rail-stripping and flow classification; and the FlowType classifier's `counterpartyAccountId` handles *owned-account* counterparties while the Merchant entity handles *external* counterparties. Neither owns the other.

**Perspective Engine (PE1).** PE1 is a deterministic, non-persistent lens layer reading through the visibility-enforced data layer. A persisted Merchant entity is exactly the kind of clean, deterministic input a "spending-by-merchant" or "recurring-commitments" lens wants. Merchant resolution stays *upstream* of PE1 (at write time); PE1 reads resolved merchants and never itself normalizes. This preserves PE1's determinism-under-injected-clock and no-direct-Prisma guarantees.

**AI (assembler + chat).** Today `normalizeMerchant` runs inside the assembler at read time to build the rollup. With Tier B/C, the assembler reads *already-resolved* merchants (stable key, canonical name, category) instead of normalizing on the fly — cheaper, consistent across turns, and it removes a re-derivation site (the same discipline KD-10/KD-11 enforced). Merchant enrichment also gives the output validator firmer ground: a merchant name/total the model cites is a stored fact, not a per-request computation. Enrichment stays behind the membership/visibility guards.

**Daily Brief (v2.6b).** The Brief is a generated surface that lights up when its data is ready (D2.x reveal contract). Merchant identity is what makes Brief lines legible and trustworthy: "Netflix +$4 vs last month," "3 new merchants this week," recurring-charge reminders. All of that needs stable cross-window merchant identity and recurring confidence — i.e. Tier C. The Brief is a *consumer*, never a producer, of merchant resolution.

**Ambient Intelligence (v2.6b).** This is where first-class merchants pay off most: signals → notifications ("your <merchant> subscription renews," "unusual charge at a never-seen merchant," "a recurring biller lapsed"). Every one of those signals is a query over persisted merchant identity + behavioral history. Ambient cannot be built on a read-time pure function; it needs Tier C memory. This confirms the phasing: entity work precedes ambient merchant signals.

**Multi-provider imports (ProviderCatalog / adapters).** Each provider names merchants differently — Plaid `merchant_name`/`merchant_entity_id`, a future exchange or brokerage, raw CSV free-text. The canonical key + `providerEntityIds` map is precisely the **cross-provider join**: the same real merchant seen through Plaid and through a CSV import resolves to one `Merchant`. Resolution belongs in a provider-neutral layer *below* the adapters' output and *above* storage, so no adapter re-implements merchant logic.

**CSV imports.** The highest-value near-term consumer and the reason to consolidate first. CSV rows have no provider merchant id — only free-text `merchant`/`description` — so they depend *entirely* on the string normalizer for identity and dedup. Today CSV uses the *other* normalizer (`normalizeMerchantKey`). Unifying the two normalizers (§2.1) directly improves CSV match quality and is a prerequisite for CSV rows joining the same Merchant dictionary as Plaid rows.

---

## 6. Q4 — Capabilities unlocked once merchants are first-class

- **Deterministic per-merchant history** across the full window, independent of the 5,000-row fetch cap re-derivation.
- **Reliable recurring / subscription detection** with cadence and confidence (persisted, not re-guessed per request) → renewal reminders, "subscriptions you forgot," lapsed-biller alerts.
- **Price-change and anomaly signals** ("Spotify went up," "first-ever charge at this merchant") — the core of Ambient merchant intelligence.
- **Cross-provider and cross-Space merchant consistency** — one merchant identity whether the row came from Plaid or a CSV, in any Space.
- **Enriched presentation** — logos/websites in row lists, the transaction drawer, the Brief, and AI answers.
- **Better categorization** — merchant-level default category (with user override) instead of per-row Plaid mapping, which also relieves KD-17-class category noise at the source.
- **Firmer AI grounding** — merchant facts become stored, citeable, validator-friendly data.
- **User corrections that stick** — rename/re-categorize a merchant once, applied everywhere and preserved across syncs.

---

## 7. Q5 — v2.5 vs. future roadmap

**v2.5 (now) — foundation and consolidation, no entity yet:**
- c1 merchant-normalization test suite ✅ (done).
- **Consolidate the two normalizers** (`normalizeMerchant` vs. `normalizeMerchantKey`) into one shared vocabulary with two explicit, documented output modes (rollup key vs. dedup key). Behavior-preserving, KD-11 pattern. This is the single most valuable merchant task available now.
- **Opportunistically capture** the already-received-but-discarded identity fields (`merchant_name`, `merchant_entity_id`, `personal_finance_category.detailed`) *if and only if* the metadata-depth / FlowType work touches the sync path anyway — the metadata-depth investigation already flags `personal_finance_category.detailed` as the one field worth capturing at first opportunity. Do not open a merchant-only schema change for this.

**v2.5.5 (FlowType window) — entity groundwork rides the semantics layer:**
- Introduce the **Tier B persisted dictionary** as a sibling to the FlowType classifier, reusing its write-time-classify → persist → read pattern. Merchant resolution and flow classification land as parallel additive fields on the same pass over the sync/import path.
- Read-time consumers (AI assembler) switch from normalizing on the fly to reading resolved merchants.

**v2.6a (AI-5) — coherence:**
- AI/Perspective consumers lean on resolved merchants for consistent multi-turn answers; no new merchant capability, just consumption.

**v2.6b (Ambient) — Tier C behavioral merchants:**
- Recurring confidence, price-change/anomaly signals, renewal reminders, merchant enrichment in the Brief and notifications. This is where first-class merchants earn their keep.

**Future / deferred (no earlier than a dedicated `MI-x`-style initiative):**
- Cross-user shared merchant dictionary, logo CDN caching, MCC reference tables, ML-assisted alias clustering. All overengineering today.

---

## 8. Q6 — Does `normalizeMerchant` evolve or get replaced?

**It evolves — cleanly — and is never thrown away.** Evidence:

- Its own header already frames it as Tier A and defers persisted canonicalization to "Tier B," so the intended growth path is *additive layering*, not replacement.
- In the mature stack it becomes the **deterministic resolver inside the classifier**: mint a `canonicalKey` for descriptors with no provider id, and provide the fallback that keeps the dictionary from depending on any single provider's ids.
- Its conservative bias (never merge two genuinely different merchants) is exactly the property a persistence tier needs from its key generator, so its contract is forward-compatible.

The only change it should undergo before the entity exists is **consolidation with `normalizeMerchantKey`** (§7 v2.5) so there is one merchant-identity vocabulary to build the dictionary on. That is a refactor of duplication, not a replacement of `normalizeMerchant`.

---

## 9. Q7 — Long-term architecture without overengineering today

```
 raw descriptor / provider payload
          │
          ▼
 ┌─────────────────────────────────────────────┐
 │ Merchant Resolution (write-time, provider-neutral)          │
 │  1. provider merchant id present?  → resolve by id          │
 │  2. else normalizeMerchant(raw)    → resolve by canonicalKey │  ◄── Tier A (today, unchanged)
 │  3. upsert Merchant, append alias, merge enrichment          │  ◄── Tier B (v2.5.5)
 └─────────────────────────────────────────────┘
          │  persists: transaction.merchantId (additive FK)
          ▼
 ┌─────────────────────────────────────────────┐
 │ Merchant entity (persisted)                                 │
 │  identity · category/MCC · enrichment · behavioral signals  │  ◄── Tier C (v2.6b)
 └─────────────────────────────────────────────┘
          │  read-time (no re-derivation)
          ▼
   AI assembler · Perspective Engine · Daily Brief · Ambient signals · UI drawer
```

**Design invariants that keep it from overengineering:**
- **Strictly additive at every step** (matches project rule "additive before subtractive"): a `merchantId` FK and a `Merchant` table alongside the existing `Transaction.merchant` string; nothing removed until every read path has cut over.
- **One classifier, one vocabulary.** Resolution lives in a single provider-neutral module; adapters and consumers never re-implement it.
- **Provider id preferred, string key as fallback** — so identity quality tracks provider richness instead of betting everything on regex.
- **Deterministic + re-runnable** — backfillable, guard-testable in the house `tsx` style, safe for the validator/PE1 determinism contracts.
- **Visibility- and PII-safe by construction** — FULL-only predicate at every surface; counterparty account identifiers deny-listed before persistence.
- **Behavioral tier last** — recurring/anomaly/price signals only after identity is stable, because they are only as trustworthy as the identity beneath them.

**What NOT to build now:** no `Merchant` table, no schema change, no enrichment fetching, no recurring-confidence persistence, no logo pipeline. The only merchant work that pays off in v2.5 is **consolidating the two existing normalizers** and letting the FlowType/metadata-depth passes opportunistically capture the identity fields the app already receives.

---

*Investigation only — stopping here per instruction. No schema, migration, route, UI, or application code was created or modified.*
