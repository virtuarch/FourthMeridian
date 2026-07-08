> **INVESTIGATION ONLY — no code, no schema, no migrations, no STATUS.md changes were made to produce this document.** For current project state see `STATUS.md` at the repository root.

# Coarse Transaction Location Metadata — Pre-FI0 Investigation

**Date:** 2026-07-08
**Status:** Investigation complete — recommendation only, no implementation.
**Question:** Should coarse, provider-supplied merchant-location metadata (`merchantLocationCity/Region/Country`, possibly postal code and source) be added to `Transaction` as a future-safe attribute — without creating a Location Intelligence module?
**Constraints (accepted as binding):** no precise coordinates absent overwhelming justification · no home/work inference · no behavioral location tracking · no Location Intelligence module · no LLM-derived location facts · no schema implementation here.
**Predecessors:** `TRANSACTION_METADATA_DEPTH_INVESTIGATION.md` (pre-7A; proposed capturing location columns *including lat/lon* — **partially superseded, see §1.4**) · `TRANSACTION_INTELLIGENCE_FACT_LAYER_INVESTIGATION_2026-07-07.md` §7A (the Metadata Capture Doctrine) · `FINANCIAL_INTELLIGENCE_ARCHITECTURE_INVESTIGATION_2026-07-08.md` §4.7 (Location module rejected) · `INTELLIGENCE_BOUNDARY_DEFINITION_INVESTIGATION_2026-07-08.md` (Location on the never-exist list; taxonomy this document applies).
**Sources:** `lib/transactions/plaid-flow-input.ts` (capture boundary + deny-list comment) · `lib/transactions/transaction-facts.ts` (TI2 fact builder) · `lib/imports/csv.ts` (`HEADER_ALIASES`) · `lib/transactions/detail-sections.ts` (drawer sections) · `prisma/schema.prisma` (Transaction, Merchant, MerchantAlias) · Plaid SDK payload shape as verified in the metadata-depth investigation against `node_modules/plaid/dist/api.d.ts`.

---

## 0. Executive summary

**Recommendation: HOLD schema; ratify the boundary.** Do not add location columns to `Transaction` now. Instead, FI0 should amend the 7A doctrine with a **three-band location taxonomy** (coarse-capturable / default-deny / never) so that when a real consumer is ratified, capture is a slice, not a debate. The decisive facts:

1. **Nothing consumes location today and nothing ratified needs it.** No surface (drawer, Brief, AI, dashboards, search) reads or displays location; the drawer's section builder has no location row; the AI context has no location dimension. Capturing it now fails 7A's guiding rule verbatim: *"Do not capture metadata because it might be useful someday."*
2. **The irreproducibility argument — the one force that could override rule 1 — does not apply.** Unlike LLM token costs or job-run history, un-captured location is *not destroyed*: Plaid retains it and it is recoverable by re-fetch (cursor reset or `/transactions/get` backfill) at the moment a consumer is ratified. Location is deferrable at low cost; telemetry was not. The MC1 "capture first" lesson therefore does not apply here.
3. **The current implemented deny-list is stricter than the 7A prose, and that gap must be resolved at FI0 either way.** 7A's text deny-lists *"precise location"*; the shipped TI2A capture boundary deny-lists **all** location (`plaid-flow-input.ts`: *"…and all location — is NEVER read… the safest control is to never touch those fields"*). Adding even coarse fields later is a **doctrine amendment**, not a column add — this investigation drafts that amendment (§4.3) so FI0 can ratify it without re-investigation.
4. **The cheapest version of the main use case already exists.** "International activity" — the most plausible near-term location-flavored consumer — is substantially covered by TI2's `fxApplied` facet plus currency mismatch, with zero location capture.

If later ratified, the smallest correct shape is **three additive nullable columns on `Transaction`** (`merchantLocationCity`, `merchantLocationRegion`, `merchantLocationCountry` — ISO-normalized country, provider-string city/region), forward-only, FULL-visibility-gated, excluded from AI context by default, and excluded from telemetry always. Postal code: default-deny. Source column: hold until a second writer exists. This is an **attribute of Records, not Intelligence** — the boundary investigation's classification is unchanged (§6).

---

## 1. Current state

### 1.1 What Plaid sends and what Fourth Meridian does with it

Plaid's transaction payload includes `location {address, city, region, postal_code, country, lat, lon, store_number}` (verified against the SDK types by the metadata-depth investigation). **Today every one of these is dropped — deliberately.** The TI2A-approved capture boundary (`buildPlaidFlowInput` → `CapturedPlaidMetadata`) enumerates its captured fields explicitly (`paymentChannel`, `authorizedDate`, `pendingTransactionRef`, `transactionCode`, `paymentMetaMethod`, `checkNumber`, PFC fields, `merchantEntityId`, deny-list-filtered counterparties) and its header comment names location in the deny-list: *"account_numbers, counterparties.phone_number, payment_meta.{payer,payee,by_order_of,ppd_id,reference_number}, account_owner, **and all location** — is NEVER read."* The control is capture-boundary-level: the fields are never touched, so nothing downstream can leak them.

### 1.2 The rest of the pipeline and the model

- **`Transaction` model:** no location columns of any kind. The TI2 fact columns (`paymentChannel`, `paymentMethod`, `settlementState`, `authorizedAt`, `counterpartyType`, `fxApplied`) are present as schema; location is not among them.
- **CSV/Excel imports:** no location concept. `HEADER_ALIASES` resolves date/description/amount/debit/credit-class columns only; no city/country alias exists, and no import dialect populates anything location-like.
- **Merchant identity (MI):** nothing location-like. `Merchant` enrichment columns are `website`/`logoUrl`/`enrichmentSource`/`enrichmentConfidence`/`enrichedAt`; `MerchantAlias` is a descriptor-key memory (`aliasKey`, `sample`, `source`). Merchant identity is deliberately *brand-level* ("the consumer-recognizable counterparty brand") — venue-level identity was never in its doctrine.
- **Consumers:** the transaction drawer's section builder (`detail-sections.ts`: summary, account, transactionIntelligence, relationshipIntelligence, provenance, reporting) emits no location fact row. Daily Brief, AI assemblers/serializer, dashboards, and search neither expose nor request location. **No current surface needs it.**

### 1.3 The one adjacent capability that exists

TI2's `fxApplied` facet (row currency ≠ account currency) is a shipped-schema, capture-approved signal that covers the bulk of "did this happen abroad / in another currency" without any location data. Any future cross-border consumer should be measured against what `fxApplied` + `currency` already answer before location capture is justified.

### 1.4 Documentary conflict to resolve at FI0

The repo contains **three inconsistent statements** about location:

| Source | Position |
|---|---|
| `TRANSACTION_METADATA_DEPTH_INVESTIGATION.md` (pre-7A) | Proposed promoting `locationCity/Region/PostalCode/Country/Lat/Lon` to columns, with a map pin from lat/lon in the drawer |
| 7A doctrine prose (TI fact-layer investigation, ratified) | Deny-lists *"precise location"* — silent on coarse |
| Shipped TI2A capture code (`plaid-flow-input.ts`) | Deny-lists **all** location |

Chronology makes the code the current authority (7A + TI2A superseded the metadata-depth wishlist), but the prose/code gap is real: a future engineer reading only §7A could believe coarse city capture is already permitted. **FI0 should mark the metadata-depth location recommendation superseded and ratify the explicit three-band taxonomy (§4.3), whichever way the capture decision goes.**

---

## 2. The Plaid payload, examined

**Whose location is it?** Plaid's `location` object describes **where the transaction occurred** — the merchant venue, populated chiefly for card-present transactions. It is not device telemetry and not user-location tracking in the technical sense. But the privacy analysis must be honest about the composite: *for card-present rows, venue location is user presence at a time and place.* A stream of city-stamped transactions is a travel diary regardless of the column name. "Merchant location" is the correct semantic label AND an incomplete privacy description; both facts drive the banding in §4.

**Field-by-field:**

| Plaid field | Nature | Population (real credentials) | Verdict |
|---|---|---|---|
| `location.country` | Coarse; ISO-mappable | Institution-dependent, better card-present | **Capturable band** — most stable, least identifying, most of the value (cross-border) |
| `location.region` | Coarse (state/province) | Same | **Capturable band** |
| `location.city` | Coarse-ish; free string | Same; dirty (abbreviations, ALL-CAPS, embedded in descriptors) | **Capturable band, with aggregation caveat** (§4.2) |
| `location.postal_code` | Fine-grained | Frequently null | **Default-deny** — near-address precision in low-density areas (a rural or small-town postal code can identify a single venue and, by composite, a person's routine); adds nothing for grouping that city/region don't |
| `location.address`, `location.store_number` | Precise venue | Usually null | **Never** (7A stands) |
| `location.lat`, `location.lon` | Precise coordinates | Usually null | **Never** (7A stands; the metadata-depth map-pin idea is dead) |

**Stability for persistence:** country is stable and normalizable (ISO-3166-1 alpha-2 at capture). Region is reasonably stable (free string; US states normalizable, international regions less so). City is a free provider string with real dirt — persist as-received, do **not** build a normalization layer (that is a gazetteer project, a classic rat hole; flagged in §9 risks). Sparse population is guaranteed: dev/Sandbox will understate coverage, and card-not-present rows will be mostly empty — any consumer must treat location as optional-by-default (the metadata-depth investigation's "hide empty fields gracefully" consequence applies).

---

## 3. Future providers and provider-neutrality

For GCC open-banking providers (Lean, Tarabut Gateway) and future bank APIs: transaction location is **not a reliably standardized field** across open-banking regimes — descriptors and merchant fields vary; venue-level location is largely a card-network artifact that aggregators surface unevenly. CSV/manual imports have no location dialect in the wild worth designing for. Wallet/crypto providers have no meaningful venue concept at all (an exchange's jurisdiction is account-level Context, not transaction location).

**Does a provider-neutral coarse shape make sense?** Yes — `city / region / country(ISO)` is about as provider-neutral as location gets, and if capture is ever ratified, that is the right normalized target. **But provider-neutrality is not an argument for storing it now.** With exactly one live provider, "provider-normalized columns" would be Plaid-shaped columns with aspirations — the same speculation D2's Step-5 investigation correctly rejected for the ProviderAdapter abstraction ("a generic interface before a second provider is speculation"). The provider-neutral *shape* should be recorded in the FI0 amendment (so a second provider maps into it rather than forking it); the *storage* waits for a ratified consumer. Location remains inside provider payloads — which, per §0.2, function as a recoverable archive — until then.

---

## 4. Privacy — the 7A analysis

### 4.1 Where the line is and why

The 7A security model is *"if it is never stored, it can never leak,"* with capture permitted only for (a) a shipping durable fact or (b) a minimum non-PII seed for ratified future architecture. Applying it:

- **Precise coordinates (`lat`/`lon`):** never. No product surface in a deterministic finance platform needs a map pin badly enough to hold coordinates of a user's physical movements. The "overwhelmingly justified" bar is, in this investigator's opinion, unreachable for this product.
- **Merchant street address / store number:** never. Venue-precision equals coordinate-precision for identification purposes.
- **Postal code:** default-deny. It is the classic quasi-identifier (postal code + age band + gender re-identifies large fractions of a population in the re-identification literature), offers near-address precision in low-density areas, and its grouping value is fully dominated by city/region. Admit it only if a specific ratified consumer proves need city cannot serve — none is foreseeable.
- **City / region / country:** capturable *in principle* — coarse enough that a single row identifies nothing precise — **subject to the aggregation caveat below and the consumer-gating rule.**
- **Provider-supplied vs inferred:** only provider-supplied values may ever be stored. **No inference, ever:** no home/work derivation, no commute detection, no travel-state inference, no "home radius," no geofencing, no LLM-derived location facts. Inference is where attribute becomes behavioral claim — the exact content of the rejected Location Intelligence module. A `merchantLocationCity` column that some later heuristic reads to infer "user's home city" would violate this doctrine even though the column itself is compliant; the ban must be stated at the *use* level, not just the capture level (§4.3 rule L4).

### 4.2 The aggregation caveat (the honest part)

Row-coarse is not stream-coarse. City-stamped card-present rows over months reconstruct travel history, routine, and effectively home city — no single row is sensitive; the corpus is. Consequences if capture is ever ratified: location renders under the **FULL-visibility predicate only** (and is a strong candidate for the metadata-depth §8 *within-FULL owner-only sub-tier* — a shared-Space FULL viewer arguably should not see a partner's city trail); location stays **out of AI context by default** (aggregate location narration invites travel inference by the model — banned; a specific row's city may appear only in explicit single-transaction drilldown, if ever); location **never enters telemetry** (PO1's no-content doctrine already covers this — a telemetry row carrying a city string is a KD-1-class defect); and location is **never exported to any benchmark/cohort computation** (geography as a cohort key is re-identification fuel).

### 4.3 Draft 7A amendment (for FI0 to ratify, not this document)

Replace the single "precise location" deny-list entry with three bands:

- **L1 — Coarse venue locality (`city`, `region`, `country`): conditionally capturable.** Enters class 1 (Captured → Durable Fact) only when a ratified consumer names it; provider-supplied only; forward-only; FULL-gated; excluded from AI context, telemetry, and cohort computation by default.
- **L2 — Fine locality (`postal_code`): default-deny.** Admissible only by a dedicated privacy review demonstrating a consumer city/region cannot serve.
- **L3 — Precise venue (`address`, `store_number`, `lat`, `lon`): never captured.** Unchanged.
- **L4 — Inference ban (use-level):** no stored location value may feed home/work/commute/travel/routine inference, behavioral geofencing, or any LLM-derived location claim. This rule binds consumers, not just capture.

Until FI0 ratifies this, the shipped stricter posture ("all location never read") remains the operative rule — correctly.

---

## 5. Architecture — where location would live

Evaluated per the boundary-investigation taxonomy:

| Home | Verdict | Reasoning |
|---|---|---|
| **`Transaction`** | **Correct home, when ratified** | Venue is a fact about the *event* (this purchase happened at the Seattle store), varying per row for the same merchant. It is captured provider metadata → durable attribute — exactly the TI2 column class (`paymentChannel` precedent). Prefix `merchantLocation*` is right: it asserts venue-of-merchant semantics, not user-location semantics, in the schema itself. |
| `Merchant` | **No** | A brand has no city (Starbucks is not in a city); MI identity is deliberately brand-level. A merchant-level `country` for enrichment display is conceivable but is MI-enrichment scope, not this decision. |
| `MerchantAlias` | **No** | Aliases are descriptor-key memory for identity resolution. Chain descriptors do embed venue hints ("STARBUCKS #1234 SEATTLE"), but making aliases venue-aware fragments identity — the opposite of MI's purpose. |
| Provider metadata only (no storage) | **Yes — the current and recommended state** | There is no raw-blob store (7A rejected the metadata-depth blob in favor of capture-or-never), so "stays in provider metadata" means *stays at Plaid*, recoverable by re-fetch. That is the hold position. |
| A future Location/Venue table | **No — premature by construction** | A venue entity (merchant × locality) is real modeling for store-level analytics no one has asked for. It would be the third speculative table this repo has correctly refused (ProviderAdapter, ops-Space precedents). Three nullable columns cover every named future consumer. |
| Nowhere for now | **The recommendation** | See §7. |

---

## 6. Intelligence boundary — confirmed: this is not, and must not become, Location Intelligence

By the ratified definition, intelligence is *fallible semantic derivation under sole authority*. Coarse provider-supplied locality fails the Wrongness Test in the right way: it is **declared by the provider, not derived by the system** — it can be missing or dirty, but Fourth Meridian asserts nothing when storing it. It is a **Records-tier attribute**, exactly like `currency` (MC1) or `pfcPrimary` (provider taxonomy hints): a captured dimension that consumers may group and filter by (Consumer work) and that intelligence modules may someday read as *input* (the "TI input, not a TI fact" class from the TI investigation's fact table).

**Why Location Intelligence stays rejected/deferred:** a module would need to own a family of fallible location *claims* — "user is traveling," "this is the user's home city," "commute pattern detected," "unusual location for this card." Every one is behavioral inference over the §4.2 aggregation surface: the claims are simultaneously the module's only content and the doctrine's explicit bans. A Location module with the bans applied owns an empty claim family — which is the definition of a module that should not exist.

**What future evidence would justify promotion (the honest bar):** (1) a *distinct, reusable* family of fallible location claims that at least two ratified consumers need — the only semi-plausible candidate is card-security anomaly signaling ("card-present in two countries within an hour"), which is fraud-detection territory that banks already own and Fourth Meridian has no mandate for; (2) a privacy review concluding the claims can be computed without the banned inferences — likely impossible, since anomaly baselines *are* routine models; and (3) the claims not fitting as a TI facet — note that even the cross-border case fits TI (`fxApplied`, or a future `crossBorder` boolean derived from account country vs row country) without any module. The realistic forecast: the promotion bar is never met, and that is fine. Keep Location on the never-exist list with this evidence bar recorded so the rejection is a decision with an audit trail, not a taboo.

---

## 7. Schema — proposed shape, and why to hold anyway

**If ratified later, the smallest correct shape** (recorded so ratification is a decision, not a design session):

```prisma
// Transaction — additive, nullable, no defaults (MC1/MI/TI column discipline)
merchantLocationCity    String?   // provider string, as received (no normalization layer)
merchantLocationRegion  String?   // provider string; US states arrive normalized
merchantLocationCountry String?   // ISO-3166-1 alpha-2, normalized at capture
```

Deliberate exclusions: **`merchantLocationPostalCode`** — default-deny band (§4.1), grouping value dominated by city/region; **`merchantLocationSource`** — with one writer (Plaid) a source enum is speculation, and row provenance already exists via `plaidTransactionId`; add it in the same slice as a second writer, never before; **lat/lon/address/store_number** — never band; **any new table** — §5. Capture wiring, when it happens, extends `CapturedPlaidMetadata` + the TI2 write path (the fields are all in the payload the sync path already holds), forward-only, with the historical-backfill question deferred exactly as the metadata-depth investigation deferred it (cursor-reset/`/transactions/get` is its own later decision).

**Recommendation: HOLD.** The shape above is three columns and an afternoon *whenever* a consumer is ratified — there is no economy in pre-adding it. Against holding stands only the forward-capture argument (rows synced before capture stay bare), and §0.2 defuses it: Plaid retains the data; a ratified consumer can trigger a backfill re-fetch. Meanwhile pre-adding violates 7A's guiding rule, expands plaintext PII surface on the canonical table for zero shipping value (the metadata-depth investigation's own §8 warning: prefer not-capturing over encrypting), and queues a migration behind the serialized-migration train ahead of TI2 wiring that is actually approved. **Hold schema; ratify bands.**

---

## 8. Consumers, if location is ever added

**Near-term-plausible (would justify ratification if demanded):**
- **Transaction drawer** — one optional fact row ("Seattle, WA · US") in the summary or TI section; hide-when-empty per the drawer's existing rule. The most honest first consumer.
- **Search / filters** — country (and maybe city) as a filter facet alongside TI's `paymentMethod`/`settlementState` facets.
- **Merchant detail** — "localities seen" for a merchant's transactions (display grouping, not venue modeling).
- **Cross-border spending** — a Banking/Brief line ("3 transactions outside US this month") — though `fxApplied` + currency should be tried first and may make location unnecessary for this entirely.

**Speculative (must not drive the decision):**
- **Briefs** — aggregate lines only ("spending in 2 countries"); anything phrased as *travel* ("while you were in Dubai…") is L4-banned inference wearing a friendly voice. The serializer, not just the capture layer, must respect the ban.
- **AI context** — default out (§4.2). At most, explicit single-row drilldown display, and only after a deliberate decision.
- **Tax** — foreign-transaction identification for the deferred Tax module; real but years out and largely servable by `fxApplied`.
- **Platform Operations** — at most field-population coverage counts ("location present on N% of card-present rows" — a Coverage/telemetry statistic carrying no location values). Never a city string in telemetry, ever.

---

## 9. Recommendation and record

**Current state:** all Plaid location fields deliberately dropped at the capture boundary; no column, no import dialect, no MI concept, no consumer. **Payload:** merchant-venue location, card-present-weighted, sparsely populated; country/region/city coarse and persistable, postal fine, address/coordinates precise. **Privacy boundary:** the §4.3 three-band taxonomy + use-level inference ban; single-row coarseness does not neutralize corpus-level travel reconstruction, so FULL-gating, AI-default-exclusion, and telemetry exclusion are conditions of any future capture. **Data shape:** three `merchantLocation*` nullable columns on `Transaction` (ISO country; raw provider strings otherwise); no postal, no source, no table. **Schema now?** **No — defer.** No ratified consumer, no irreproducibility pressure (provider re-fetch recovers history), and 7A's guiding rule directly on point. **Future-provider compatibility:** the recorded shape is provider-neutral; a second provider maps into it at its own capture slice; CSV gains a location dialect only if a real file format demands one. **Risks if later ratified:** plaintext PII widening on the canonical table (mitigate: capture only the three coarse fields); city-string dirt inviting a normalization project (mitigate: store-as-received doctrine, display-only); scope creep from attribute to inference (mitigate: L4 as a review-blocking rule); shared-Space over-exposure (decide the within-FULL owner-only sub-tier *before* the drawer row ships); AI narration drifting into travel language (serializer test pinning the ban, KD-18-style).

**Implementation sequence if ratified later:** **L-A** consumer ratification (name the surface; check `fxApplied` doesn't already serve it) → **L-B** 7A amendment ratified at/after FI0 (§4.3) → **L-C** capture: extend `CapturedPlaidMetadata` + sync write path, three columns, forward-only, one migration slotted behind the TI2 train → **L-D** first consumer ships (drawer row + hide-when-empty), FULL-gated, with the sub-tier decision made → **L-E** separate decisions, each own slice: historical backfill re-fetch; search facet; any Brief aggregate line (with serializer ban tests).

**FI0 doctrine reflection:** (1) adopt the three-band location taxonomy into 7A, replacing the ambiguous "precise location" entry and superseding the metadata-depth location recommendation by name; (2) record coarse venue locality as a **Records-tier attribute** in the taxonomy — grouping dimension, TI input, never a module; (3) keep Location Intelligence on the never-exist list *with the §6 promotion bar recorded*, so the rejection is auditable; (4) state the L4 use-level inference ban as a consumer-binding rule alongside the KD-18 attribution doctrine, which is its closest structural sibling.

---

**End of investigation. No implementation performed. No files modified; STATUS.md untouched. Bottom line: the fields are safe to *design*, not yet justified to *store* — ratify the boundary at FI0, hold the columns until a consumer exists.**
