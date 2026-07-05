> **INVESTIGATION ONLY — no implementation, no schema change, no code change, no doc-of-record update is made by this document.** Verified against the working tree at STATUS.md checkpoint `f22de52`. Companion to `MERCHANT_INTELLIGENCE_PERSISTED_TIER_PLAN_2026-07-05.md` (the slice plan); this document answers the *conceptual* question that plan deliberately did not: what makes Merchant Intelligence intelligent, and how far the intelligence can go without betraying the project's determinism doctrine.

# Merchant Intelligence — Forms of Intelligence — Comparative Investigation

**Date:** 2026-07-05
**Question under investigation:** What makes Merchant Intelligence genuinely intelligent rather than a giant lookup table? Which forms of intelligence should Fourth Meridian adopt, when, and can the system get progressively smarter from user activity without becoming an opaque machine-learning system?

---

## 0. Executive summary

**A lookup table answers questions it was already told the answer to. An intelligent system closes loops:** it *remembers* what it observed (memory), *applies* what it learned in one place to another (generalization), *improves* when corrected (feedback), and *knows how sure it is* (self-assessment). None of those four properties requires machine learning. All four can be built as deterministic data structures that accumulate — which is exactly the architecture Fourth Meridian's existing doctrine (write-time classifiers, persisted provenance, `classifierVersion` re-runnability, no-LLM-above-the-validator) already points at.

**Answer to the core question: yes** — via what this document calls **the ratchet architecture** (§4): probabilistic *detectors* may propose; only the deterministic *knowledge store* disposes. Every learned belief is a readable row with provenance, confidence, a version, and a rank that human correction always dominates. Learning is data accumulation in inspectable structures, never weight updates in an opaque model. The system gets smarter every day and can explain every answer it gives.

The comparative analysis (§2) evaluates nineteen approaches and sorts them into four families: **identity** (who is this counterparty), **classification** (what does spend at this counterparty mean), **behavior** (what does this counterparty do over time), and **meta** (provenance and confidence — the intelligence *about* the intelligence). The phase mapping (§3) confirms the persisted-tier plan's sequencing and adds where each later form slots.

---

## 1. Starting point — how much intelligence exists today

Verified against the tree, the current system has exactly three fragments of merchant intelligence, all shallow by design:

1. **Tier A canonical normalization** (`lib/transactions/merchant.ts`) — pure string hygiene. It has no memory: it recognizes `SQ *COFFEE BAR` and `COFFEE BAR` as the same only because a regex strips the rail prefix, not because it ever learned they co-occur.
2. **The Slice 1 curated catalog** (`lib/transactions/merchant-rules.ts`) — 15 rules + a 10-brand subscription allowlist. This *is* a lookup table, deliberately and honestly: its own header says it must not become the long-term system.
3. **A read-time recurring heuristic** (`lib/ai/assemblers/transactions.ts:420–462`) — "merchant appeared ≥2 times in the window" with an average amount. No cadence, no interval, no persistence; recomputed per request, forgotten immediately. This is the clearest example of intelligence the system *computes but throws away*.

Forward seeds already in place: `Transaction.merchantEntityId` (written, never read), persisted `pfcPrimary`/`pfcDetailed`, and the `classifierVersion` re-runnability pattern. The persisted-tier plan adds memory (`Merchant`/`MerchantAlias`), correction (`MerchantRule` + overrides), and provenance (`categorySource`). This document evaluates everything beyond that.

---

## 2. The forms of intelligence, compared

Legend for the phase column: **v2.5** = MI persisted tier window (slices M0–M6 of the companion plan) · **v2.6a** = advisor coherence window · **v2.6b** = ambient/jobs window · **Later** = post-v3.0 / multi-tenant scale · **Never** = rejected for this product.

### Family A — Identity intelligence (who is this counterparty?)

#### A1. Canonical normalization (Tier A — exists)

- **How it works:** pure function strips rail prefixes, noise tokens, casing → stable `canonicalKey`. **Data:** the descriptor string alone. **Deterministic?** Fully. **Privacy:** none beyond the row itself — no cross-row data. **Scalability:** perfect (O(1), no state). **Maintenance:** low — occasional new rail prefix added by PR. **Failure modes:** under-merge by design (`UBER TRIP HELP.UBER.COM` vs `UBER *EATS` stay split); can never over-merge two merchants, which is why it is the safe *fallback*, not the system. **Phase:** shipped; evolves but is never replaced (evolution investigation §8).

#### A2. Plaid `merchant_entity_id` (provider identity)

- **How it works:** Plaid runs its own (probabilistic, on their side) entity resolution and hands the result over as a stable id. Fourth Meridian consumes it as a deterministic fact. **Data:** already captured on every synced row since P2/P3. **Deterministic?** Deterministic *for us* — the probabilism is outsourced to the provider, which is the cheapest possible way to buy entity resolution. **Privacy:** none new; the id describes the merchant, not the user. **Scalability:** excellent for Plaid-sourced rows; zero for CSV/manual/other providers — this is its cap. **Maintenance:** none. **Failure modes:** coverage gaps (Plaid omits it for many long-tail/regional merchants — exactly the merchants that caused the `Other` symptom); provider lock-in if treated as the *only* identity spine rather than the preferred one. **Phase:** v2.5 (persisted-tier M4 resolution order: entityId → alias → canonicalKey).

#### A3. Merchant identity resolution (Tier B dictionary)

- **How it works:** persisted `Merchant` row keyed by entityId or canonicalKey; every transaction gets a `merchantId`. This is where identity stops being recomputed and starts being *remembered*. **Data:** the dictionary itself + the row streams. **Deterministic?** Fully — exact-key resolution only. **Privacy:** the first real exposure: dictionary rows minted from descriptors can embed person names (Zelle/Venmo/payroll) — hence the minting guards in the companion plan (§3.2): entityId-or-spend-flow only, PII deny-list. **Scalability:** linear and cheap; the dictionary grows with distinct merchants, not with transactions. **Maintenance:** low-moderate — merge/split tooling eventually needed for mis-minted rows. **Failure modes:** key drift (if `normalizeMerchant` rules change, old keys strand — mitigate by versioning the normalizer like the flow classifier); stale display names. **Phase:** v2.5 (M4).

#### A4. Alias learning (via user correction)

- **How it works:** when a user says "this descriptor is also Amazon," a `MerchantAlias` row binds that descriptor key to the merchant forever. One correction, permanent effect, zero inference. **Data:** user actions. **Deterministic?** Fully — human-ratified fact. **Privacy:** alias rows are deployment-global in the current design; a user-attached alias derived from a personal descriptor could leak context in a future multi-tenant world — flagged for §5 (alias rows need an origin scope before multi-tenancy). **Scalability:** scales with user effort — the honest cap of all ratified learning. **Maintenance:** near zero. **Failure modes:** a wrong user attachment poisons the mapping for every consumer — needs an undo path (alias rows are deletable; `@unique` on aliasKey means no ambiguity ever). **Phase:** v2.5–v2.6a (rides M5's correction UI).

#### A5. Automatic alias discovery

- **How it works:** batch job proposes aliases the user never stated: descriptors sharing a `merchant_entity_id` but producing different canonical keys (provable, deterministic evidence); descriptors that co-occur with identical amounts/cadence at high similarity (probabilistic evidence). **Data:** full transaction history. **Deterministic?** Two grades: entityId-co-occurrence discovery is *deterministic and safe to auto-accept*; similarity-based discovery is *probabilistic and must only propose*. **Privacy:** same as A3. **Scalability:** good — batch, incremental. **Maintenance:** the probabilistic thresholds need tuning. **Failure modes:** the classic over-merge (two franchise locations of different owners; "DELTA" airline vs "DELTA" dental) — catastrophic for trust in a finance app, which is why auto-accept is restricted to the provable grade. **Phase:** deterministic grade v2.6b (it's a batch job — needs the D5 substrate); probabilistic grade Later, behind the ratification gate (§4).

#### A6. Fuzzy matching

- **How it works:** edit-distance / token-set similarity (Levenshtein, Jaro-Winkler, trigram) resolves near-miss descriptors to existing merchants at query or write time. **Data:** dictionary + candidate string. **Deterministic?** The *algorithm* is deterministic but the *decision* is threshold-probabilistic — 0.87 similar is a guess wearing a number. **Privacy:** none new. **Scalability:** needs indexing (pg_trgm) beyond a few thousand merchants; fine at FM's scale. **Maintenance:** perpetual threshold tension. **Failure modes:** the over-merge problem in its purest form; financial descriptors are adversarially similar ("CITGO"/"CITI", "ALDI"/"AUDI"). **Verdict:** never as a silent write-path resolver; acceptable only as a *suggestion generator* ("did you mean...?" in the correction UI, or candidate ranking for the ratification gate). **Phase:** Later, suggestion-only.

#### A7. Merchant clustering

- **How it works:** unsupervised grouping of descriptors by string features + behavioral co-occurrence to find "probably the same merchant" clusters without labels. **Data:** full history, ideally cross-user. **Deterministic?** No — genuinely probabilistic/ML. **Privacy:** cross-user clustering means one user's data shapes another's groupings — requires aggregation with k-anonymity floors. **Scalability:** the whole point is scale — it only pays off with many users' long tails. **Maintenance:** high — model lifecycle, drift, evaluation sets. **Failure modes:** opaque merges nobody can explain — precisely the failure the core question asks to avoid. **Verdict:** as an offline *curation aid* for the maintainer (candidate lists for catalog promotion), never as a runtime resolver. **Phase:** Later (multi-tenant only), offline-only.

### Family B — Classification intelligence (what does this merchant mean?)

#### B1. Deterministic merchant rules (global catalog — exists)

- **How it works:** curated code catalog, ordered, first-match-wins, spend-categories-only. **Data:** maintainer knowledge. **Deterministic?** Fully. **Privacy:** none — it ships in the binary. **Scalability:** the known cap — it scales with curation effort and can never cover the long tail; that is why it must stay small and why the persisted tiers exist. **Maintenance:** the "no dumping ground" rule is a permanent editorial cost. **Failure modes:** token collisions as it grows (the `uber eats`-before-`uber` ordering problem compounds); staleness (brands change business models). **Phase:** shipped; grows conservatively forever.

#### B2. User corrections (row-level overrides)

- **How it works:** the user fixes one row; `categorySource=USER_OVERRIDE` makes it permanent and rank-protected. **Data:** one click. **Deterministic?** Fully. **Privacy:** none — user's own data. **Scalability:** per-row, so alone it doesn't scale — its value is as the *input* to everything downstream (rules, promotion, evaluation). **Maintenance:** zero. **Failure modes:** users are sometimes wrong; the design accepts that (their ledger, their truth) — the real failure would be silent clobbering by a sync, which the clobber matrix exists to prevent. **Phase:** v2.5 (M5). **This is the single most important intelligence primitive in the whole system** — every learning loop in §4 starts here.

#### B3. User-specific intelligence (personal rules)

- **How it works:** "apply to all from this merchant" promotes a correction to a persisted USER-scope `MerchantRule`; write path honors it for that user's rows thereafter. **Data:** corrections. **Deterministic?** Fully. **Privacy:** strictly user-scoped rows — clean. **Scalability:** per-user linear; a user with 50 rules costs nothing. **Maintenance:** zero for FM; the user gardens their own rules. **Failure modes:** rule staleness when a merchant's meaning changes for the user; a rules-management surface is eventually needed or old rules become invisible policy. **Phase:** v2.5 (M5).

#### B4. Space-specific intelligence

- **How it works:** a Space recategorizes a merchant for its own context (business Space: Amazon→Supplies) as a **read-time overlay**, never a row write, because rows are shared across Spaces. **Data:** Space-admin corrections. **Deterministic?** Fully. **Privacy:** the subtle one — the overlay applies inside KD-19-guarded read paths; a Space rule must never reveal that a *non-shared* account also buys from that merchant. Needs its own privacy proof. **Scalability:** fine. **Maintenance:** low. **Failure modes:** figure divergence between Space views and owner views is *by design* but will confuse the AI validator if the assembler isn't overlay-aware — the read cutover must carry the overlay or numbers won't reconcile. **Phase:** v2.6a at the earliest (schema'd in v2.5 per the companion plan, deliberately unwired).

#### B5. Deployment-global intelligence

- **How it works:** facts true for everyone (Uber is Travel; this entityId is Netflix) live once, benefit everyone. Today: the code catalog + the future global Merchant dictionary. **Deterministic?** Yes. **Privacy:** the boundary question — global facts must be *about merchants*, never about users; anything minted from user data must pass the §4 promotion gate. **Scalability:** the best there is — O(1) per fact for all users. **Maintenance:** editorial. **Failure modes:** regional wrongness (a "global" fact that's only true in the US) — the locale tag exists for this. **Phase:** shipped (code) / v2.5 (dictionary).

#### B6. Merchant promotion into the global catalog

- **How it works:** aggregate signal ("N distinct users corrected merchant X to category Y") generates a *candidate*; a maintainer reviews; acceptance becomes a code-catalog PR or a global dictionary fact. The learning loop's top stage. **Data:** cross-user correction statistics. **Deterministic?** The aggregation is; the acceptance is human editorial judgment — deliberately. **Privacy:** the crux: promotion statistics must be k-anonymous (floor of N≥k distinct users, no descriptor payloads that embed personal context, strip amounts). Single-deployment today makes this moot (one user), which is exactly why the *mechanism* can wait while the *data* (corrections with provenance) accumulates from v2.5. **Scalability:** excellent. **Maintenance:** an ongoing editorial function — §5 argues this becomes a real curation role at scale. **Failure modes:** popularity ≠ correctness (many users miscategorizing the same merchant promotes the error); mitigate with review, not thresholds alone. **Phase:** Later (needs multiple users to mean anything); design the provenance so nothing blocks it (done — `categorySource`/`categoryRuleId` carry the evidence).

### Family C — Behavioral intelligence (what does this merchant do over time?)

#### C1. Recurring pattern recognition (cadence detection)

- **How it works:** time-series analysis per merchant per account: interval regularity (28–31d monthly, 7d weekly, 365d annual), amount stability, phase prediction → persisted cadence record `{merchantId, interval, tolerance, typicalAmount, lastSeen, nextExpected, confidence}`. Solves the PlayStation/Prime-Video trap the merchant-name rule structurally cannot (same merchant, subscription *sometimes*). **Data:** ≥3–4 observations per stream; the dictionary (identity must be stable first — cadence over unstable identity is noise). **Deterministic?** The detector is a deterministic algorithm over history, re-runnable and versionable (`cadenceDetectorVersion`, same pattern as `classifierVersion`) — but its *output is a confidence-scored inference*, not a fact. Store it as a claim with confidence, never as truth. **Privacy:** per-user by construction (my Netflix cadence is mine). **Scalability:** batch job, linear in history — needs the D5 scheduler substrate. **Maintenance:** moderate — tolerance tuning, annual-cadence cold starts. **Failure modes:** variable-amount recurrences (utilities) read as non-recurring; FX wobble reads as price change (the MC1 §6.3 interaction — cadence must compare within currency); paused subscriptions read as lapsed. **Phase:** v2.6b — it is the flagship *input* to ambient intelligence (renewal reminders, "your Netflix went up," lapsed-biller alerts) and the Daily Brief, and it depends on M4 identity + D5 jobs. This is the highest-value form of intelligence on the whole list.

#### C2. Behavioral learning (profiles beyond cadence)

- **How it works:** persisted per-merchant-per-user aggregates: first/last seen, frequency, typical amount band, trend, "never seen before" novelty flags → anomaly and price-change signals. **Data:** history + dictionary. **Deterministic?** Same grade as C1 — deterministic detectors emitting confidence-scored claims. **Privacy:** per-user; the aggregates are exactly the kind of derived-figure persistence the ordering audit says needs the Float→Decimal plan first. **Scalability:** fine, batch. **Maintenance:** moderate. **Failure modes:** false anomaly alarms erode trust fast (alert fatigue is the product killer for ambient features); thresholds must start conservative. **Phase:** v2.6b, after C1 proves the substrate.

### Family D — Semantic and assisted intelligence

#### D1. Merchant knowledge graphs

- **How it works:** merchants become nodes with typed edges: `subsidiary_of` (Uber Eats→Uber), `same_brand_as`, `payment_processor_for` (Square→thousands of cafés), `franchise_of`, plus reference attributes (MCC, industry, region). Queries traverse: "how much do I spend with Amazon *including* Whole Foods and AWS?" **Data:** curated reference data + provider hints (Plaid `counterparties[]` already carries processor-vs-merchant typing that is currently discarded). **Deterministic?** The graph is data; traversal is deterministic; *building* it is editorial or imported. **Privacy:** none if the graph holds only merchant facts. **Scalability:** the graph is small (thousands of nodes) even at scale. **Maintenance:** high if hand-curated; realistic path is licensing/importing reference data. **Failure modes:** stale corporate structures; double-counting via cyclic edges; over-engineering — a `parentMerchantId` self-relation covers 80% of the value for 5% of the machinery. **Phase:** Later, starting as the single self-relation (which could ride any post-M4 slice cheaply), full graph only when a real consumer (brand-level rollups) exists.

#### D2. AI-assisted merchant resolution

- **How it works:** an LLM proposes what deterministic layers couldn't: "`POS 4829 STHLM KUNGSGATAN` is probably Espresso House, a Swedish café chain — confidence 0.7." **Data:** the descriptor (+ optionally locale). **Deterministic?** No — and unlike C1/C2 it is not even re-runnable-stable (model updates change answers). **Privacy:** the serious one — descriptors sent to an external model can contain PII (person names in transfers, employer names). Requires the same deny-list gating as minting, or on-prem/local inference. **Scalability:** costs per call; cache aggressively. **Maintenance:** prompt/model lifecycle. **Failure modes:** confident hallucination (invents a plausible merchant that doesn't exist); the doctrine risk — FM's AI architecture rule is *no LLM above the validator*, i.e., LLM output is never a trusted fact source. **Verdict:** compatible with doctrine only as a **proposal generator whose output enters the ratification gate like any other probabilistic detector** — an LLM suggestion becomes real only when a human accepts it (creating a deterministic alias/rule row) or when it merely *ranks* choices a human is shown. Never a silent write path. **Phase:** Later (v2.6b+ at the earliest, after the gate exists); high leverage for the regional long tail where no catalog will ever reach.

### Family E — Meta-intelligence (intelligence about the intelligence)

#### E1. Provenance

- **How it works:** every belief records who/what produced it (`categorySource`, `categoryRuleId`, alias `source`, future `cadenceDetectorVersion`). **Deterministic?** It's bookkeeping — fully. **Privacy:** none. **Scalability/maintenance:** trivial. **Failure modes:** the only one is *not having it* — every other form of intelligence in this document is unsafe to operate without it (re-runs clobber corrections, nobody can debug a wrong answer, promotion has no evidence). **Phase:** v2.5 (M1) — correctly sequenced first in the companion plan. Provenance is to intelligence what MC1 Phase 0 is to currency: the thing that cannot be reconstructed later.

#### E2. Confidence scoring

- **How it works:** every *inferred* belief carries 0–1 confidence (the flow classifier already does this: `classificationConfidence`); consumers gate on it — the Brief mentions a renewal only above 0.8, the AI discloses uncertainty below 0.5, the UI never shows raw scores. Ratified facts (overrides, user aliases) are confidence-1.0 by definition. **Deterministic?** Yes — confidence here is a *deterministic function of evidence* (e.g., cadence: observation count × interval regularity × amount stability), not a model's softmax. That distinction is what keeps it explainable: the score can be recomputed and justified. **Privacy:** none. **Maintenance:** the formulas need occasional recalibration. **Failure modes:** miscalibration (0.9 that's right 60% of the time) silently poisons every downstream gate; needs periodic evaluation against corrections (which — again — provenance makes possible). **Phase:** v2.5 pattern-adoption (flow already has it); becomes load-bearing at v2.6b when ambient consumers gate on it.

### 2.1 Summary table

| # | Form | Det./Prob. | Privacy weight | Scales by | Maint. | Phase |
|---|---|---|---|---|---|---|
| A1 | Canonical normalization | Det. | none | — (stateless) | low | shipped |
| A2 | Plaid entity id | Det. (for us) | none | provider coverage | none | v2.5 M4 |
| A3 | Identity dictionary | Det. | minting guards | distinct merchants | low-mod | v2.5 M4 |
| A4 | Alias learning (user) | Det. | scope at multi-tenant | user effort | ~0 | v2.5 M5 |
| A5 | Auto alias discovery | Det. grade / Prob. grade | as A3 | history | mod | v2.6b / Later |
| A6 | Fuzzy matching | Prob. decision | none | index size | perpetual | Later, suggest-only |
| A7 | Clustering | Prob./ML | cross-user | user count | high | Later, offline-only |
| B1 | Global code catalog | Det. | none | curation | editorial | shipped |
| B2 | User corrections | Det. | none | per-row | 0 | v2.5 M5 |
| B3 | User rules | Det. | none | per-user | 0 | v2.5 M5 |
| B4 | Space overlay rules | Det. | KD-19 proof needed | per-Space | low | v2.6a+ |
| B5 | Deployment-global facts | Det. | merchant-facts-only boundary | O(1)/fact | editorial | shipped/v2.5 |
| B6 | Promotion loop | Det. aggregation + human accept | k-anonymity | user count | editorial | Later (mechanism), v2.5 (evidence) |
| C1 | Cadence detection | Det. detector, scored claim | per-user | history + D5 jobs | mod | v2.6b |
| C2 | Behavioral profiles | Det. detector, scored claim | per-user; Decimal plan | history | mod | v2.6b |
| D1 | Knowledge graph | Det. data | none | small graph | high (curation) | Later (self-relation early) |
| D2 | LLM-assisted resolution | Prob., non-stable | PII egress | long tail | prompt lifecycle | Later, gate-only |
| E1 | Provenance | Det. | none | trivial | trivial | v2.5 M1 |
| E2 | Confidence scoring | Det. function of evidence | none | trivial | recalibration | v2.5 pattern → v2.6b load-bearing |

---

## 3. What separates intelligence from a lookup table

The table-vs-intelligence line is not *whether data is stored in tables* — everything above is tables. It is whether the system exhibits four loop-closing properties:

1. **Memory** — observations persist and compound (A3 dictionary, C1 cadence records) instead of being recomputed and discarded (today's read-time recurring heuristic — §1.3 — is the anti-pattern: intelligence computed and thrown away per request).
2. **Generalization** — one fact improves many answers: one alias fixes every past and future row from that descriptor; one user rule reclassifies a whole merchant history; one promoted catalog entry fixes it for every user. A lookup table maps one key to one value; intelligence propagates.
3. **Feedback** — the system's errors are its training data: corrections (B2) don't just fix rows, they generate rules (B3), aliases (A4), promotion candidates (B6), and calibration evidence for confidence formulas (E2). A lookup table doesn't change when it's wrong.
4. **Self-assessment** — the system distinguishes what it *knows* (ratified, confidence 1.0) from what it *infers* (scored claims) from what it *doesn't know* (null provenance, `Other`, `UNKNOWN` flow) — and its consumers behave differently in each regime. A lookup table has exactly one epistemic state.

The Slice-1 catalog has property 0 of 4 — the correct starting stop-gap, and the reason it must not grow. The v2.5 persisted tier delivers 1–3 in embryo. v2.6b (cadence + ambient) is where 1–4 all operate at once, which is why that window — not any single table — is when Merchant Intelligence becomes *intelligent*.

---

## 4. The core architectural question

**Can Fourth Meridian become progressively smarter from user activity without becoming an opaque machine-learning system? Yes — with one architectural commitment: probabilistic components may propose; only the deterministic knowledge store disposes.**

### 4.1 The ratchet architecture

```
                         ┌──────────────────────────────────────────────┐
   observation streams   │  DETECTORS (versioned, re-runnable, scored)  │
   ───────────────────►  │  · cadence detector          (deterministic) │
   sync rows, imports,   │  · alias discovery, det. grade(deterministic)│
   corrections, entity   │  · alias discovery, sim. grade(probabilistic)│
   ids, PFC signals      │  · fuzzy suggester            (probabilistic)│
                         │  · LLM resolver               (probabilistic)│
                         └───────────────┬──────────────────────────────┘
                                         │ CLAIMS: {belief, evidence,
                                         │ confidence, detectorVersion}
                                         ▼
                         ┌──────────────────────────────────────────────┐
                         │  RATIFICATION GATE                           │
                         │  · provable + reversible + low-stakes        │
                         │      → auto-accept (recorded as such)        │
                         │  · everything else → human accepts/rejects   │
                         │    (or the claim is only ever *displayed     │
                         │     as a suggestion*, never persisted)       │
                         └───────────────┬──────────────────────────────┘
                                         │ accepted claims become ROWS
                                         ▼
                         ┌──────────────────────────────────────────────┐
                         │  KNOWLEDGE STORE (deterministic, inspectable)│
                         │  Merchant · MerchantAlias · MerchantRule ·   │
                         │  categorySource/ruleId · cadence records ·   │
                         │  every row: provenance + rank + confidence   │
                         └───────────────┬──────────────────────────────┘
                                         │ exact-key reads only
                                         ▼
                          write path · AI assembler · Brief · ambient
                          signals · UI badges  (consumers never infer)
```

### 4.2 The six invariants that keep it transparent

1. **Everything the system believes is a row you can read.** No belief lives in weights, embeddings, or caches. "Why is this categorized Travel?" is answered by `categorySource` + `categoryRuleId` + the rule row — a three-hop lookup, always.
2. **Every belief has provenance and a rank, and human correction dominates every automatic tier.** The clobber matrix is the constitution: no learning process, however smart, outranks a person about their own ledger.
3. **Detectors are versioned, deterministic-given-inputs, and re-runnable** (the `classifierVersion` pattern generalized). A better cadence detector re-runs over history and produces *diffable* changes — the same property that made FlowType P4/P5 safe. LLM proposals, which fail this stability test, are therefore confined to suggestion surfaces and gate candidacy.
4. **Confidence is a stated function of evidence, not model output.** Scores can be recomputed, audited, and recalibrated against the correction stream.
5. **Probabilistic output is quarantined at the type level.** Claims and knowledge are different tables; nothing in a read path ever consumes an unratified claim as if it were a fact. (Suggestion UIs consume claims *as claims*, visibly.)
6. **Aggregate learning across users is evidence-gated and k-anonymous** (B6): correction statistics flow up; personal data never does.

### 4.3 Why this gets *progressively* smarter

Each user action ratchets the system one notch, and notches compound across layers: a correction (fixes a row) → a rule (fixes a merchant for that user) → an alias (fixes identity for everyone) → a promotion candidate (fixes the category for everyone) → calibration data (makes every future confidence score honester). Meanwhile the detectors get better *inputs* over time (longer histories, cleaner identity) without themselves changing — and when a detector *is* improved, versioned re-runs upgrade the whole ledger diffably. The system's intelligence grows monotonically with use, yet at any moment its complete state of belief is a `pg_dump` — the precise opposite of opaque.

What this architecture *gives up*, honestly: cold-start magic (a brand-new user's long tail stays `Other` until providers, catalog, or the user teach it), unsupervised discovery of surprising patterns, and headline "AI-powered" categorization accuracy on day one. Those are the costs of explainability, and for a finance product whose AI layer already commits to provenance-first prompting and output validation, they are the right costs.

---

## 5. World-class Merchant Intelligence, five years out

Assume Fourth Meridian in 2031 serves users across the US, Europe, the Middle East, and beyond, on multiple providers (Plaid, open-banking aggregators in the EU/UK, regional providers in MENA, brokerages, exchanges, CSV). What world-class looks like — as an extension of the ratchet, not a replacement:

**1. A federated identity spine, provider-neutral.** The `Merchant` dictionary becomes a graph-backed registry: `providerEntityIds` as a table (Plaid, Tink/TrueLayer-class ids, regional providers), the `parentMerchantId` self-relation grown into the D1 brand graph, and licensed reference data (MCC, LEI where applicable) merged as *attested* facts with their own provenance rank. No single provider's id is the spine; the registry is.

**2. Locale-native, not translated.** The Slice-1 `locale` tag matures into first-class regional catalogs: a MENA catalog where Careem/Gathern/Ajmal are as mainstream as Uber/Sephora are in the US one; Arabic/French/German descriptor normalization in Tier A (today's regexes are Latin-script US-bank idioms); region-aware taxonomy mapping (EU providers ship their own category schemes — they enter the precedence chain exactly where Plaid PFC does today, as ranked provider signals). The category enum's regional adequacy gets revisited with real data (Zakat, VAT-refund, and EU-transit patterns don't exist in a US-derived vocabulary).

**3. The promotion loop as an editorial institution.** With real user mass, B6 runs continuously: k-anonymous correction aggregates generate ranked candidate queues per region; a curation function (human, tooled, eventually assisted by offline clustering A7 and LLM triage D2 — both below the gate) reviews and ships weekly catalog releases, versioned like the classifier. The global catalog stops being a file a maintainer edits and becomes a governed, measurable artifact — with published coverage metrics: % of spend rows non-`Other`, % with resolved identity, median corrections-per-user-per-month (falling = the system is learning), confidence calibration curves.

**4. Behavioral intelligence as the product surface.** Cadence and behavioral profiles (C1/C2), currency-aware via MC1 (a price change is only a price change *within* a currency; an FX wobble is disclosed as such), power the ambient layer: renewal forecasts, price-increase detection across a user's whole subscription portfolio, novel-merchant and duplicate-charge flags, and Brief lines that cite stored facts the validator can reconcile. Every ambient claim carries user-visible provenance ("based on 14 monthly charges since 2029").

**5. Privacy as an architectural export, not a policy.** Per-region data residency for descriptor-bearing rows; the knowledge store cleanly split into *global merchant facts* (shippable everywhere) and *personal observations* (never leave the user's region/deployment); PII deny-listing at every mint and every egress (including LLM calls, which by then run against models that never retain inputs — or locally); GDPR-grade erasure that provably cascades (delete the user → their observations, rules, aliases-of-personal-origin, and their contribution to aggregates go too — the k-anonymity floor makes the last tractable). The ratchet's "everything is a row" invariant is what makes all of this auditable.

**6. Still not an opaque ML system.** Five years of scale changes the detectors (better algorithms, more languages, licensed data, offline ML as curation tooling) but not the constitution: proposals below the gate, facts above it, human corrections at the top rank, every answer three hops from its evidence. World-class here does not mean "a model that knows merchants"; it means **the largest continuously-verified, provenance-complete merchant knowledge base in consumer finance — one that every user can interrogate and correct, in their own language, and that gets measurably smarter every week without anyone having to trust a black box.**

---

## 6. Recommendations (no action taken by this document)

1. Proceed with the persisted-tier plan unchanged — this investigation independently re-confirms its sequencing (provenance → vocabulary → identity → correction) as the minimal substrate every intelligent form above requires.
2. Adopt the **ratchet constitution** (§4.2's six invariants) as a decision record at MI M0, so later slices (cadence, discovery, LLM assistance) inherit it as doctrine rather than re-litigating it.
3. Stop discarding computed intelligence: schedule the read-time recurring heuristic's replacement by persisted cadence records (C1) as the flagship v2.6b MI item, dependent on M4 identity + D5 jobs + the Float→Decimal plan.
4. Reject silent fuzzy matching and runtime clustering permanently; admit them only as suggestion generators and offline curation aids.
5. Record the multi-tenant privacy preconditions now (alias origin scoping, k-anonymous promotion, PII egress gating for any future LLM assistance) so nothing shipped in v2.5 has to be unshipped at scale.

---

*End of investigation. No implementation, schema, code, migration, or roadmap change was made.*
