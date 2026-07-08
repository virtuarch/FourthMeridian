> **INVESTIGATION ONLY — no code, no schema, no migration, no STATUS.md change was made to produce this document.** For current project state see `STATUS.md`.

# Merchant Intelligence — Merchant Identity Semantics Investigation

**Date:** 2026-07-07
**Question:** What does a `Merchant` row *represent* in Fourth Meridian — legal entity, brand, processor, or economic counterparty — and what boundary rules follow (alias vs merchant vs service, rails, merges, provenance)?
**Trigger:** The M6-era WGU incident: four raw descriptor groups (`Western Governors Un`, `NBS-WGU*SERVICE FEE`, `Western Governors University`, `NBSWGUSERVICE FEE 08LINCOLN`) resolved to four `Merchant` rows and were unified by explicit USER correction (`scripts/merge-wgu-merchants.ts`). That merge was correct under the current doctrine but exposed that the doctrine defines *how* identity resolves (conservatively, deterministically) without ever defining *what* the identity IS.
**Prior art (verified in-tree):** `MERCHANT_INTELLIGENCE_PRODUCT_ARCHITECTURE_2026-07-05.md` (three-layer merchant object) · `MERCHANT_INTELLIGENCE_PERSISTED_TIER_PLAN_2026-07-05.md` (minting guards, resolution order) · `MERCHANT_INTELLIGENCE_READINESS_INVESTIGATION_2026-07-07.md` · `MERCHANT_INTELLIGENCE_LAYER_INVESTIGATION.md` §6 (global/user-specific/rail classification) · `MI1_M0_RATIFICATION_2026-07-07.md` · `lib/transactions/{merchant,merchant-resolver,merchant-rules,merchant-corrections,merchant-write,merchant-backfill}.ts` · `prisma/schema.prisma` (Merchant/MerchantAlias/MerchantRule).

---

## 0. Executive summary

**A Merchant is the consumer-recognizable counterparty brand — the answer a user would give to "who did you pay?"** It is not the legal entity (invisible in bank data, wrong granularity), not the payment processor (a rail, stripped by design), and not the corporate parent (a future graph edge, never a merge). Operationally it is *the identity granularity at which the user corrects*: the M5 correction loop is not just the merge mechanism, it is the **arbiter of what counts as one merchant**.

Two boundary rules follow. **The who/what rule:** Merchant answers *who*; category, service, product, and fee-ness answer *what*. A raw descriptor becomes an alias when collapsing it loses no *what*-information the system currently expresses at merchant granularity; when it does (the WGU service-fee case, `Apple.com/bill`'s hidden services), the descriptor's *what*-content is preserved by the immutable raw `Transaction.merchant` and deferred to future service/receipt/cadence layers — never solved by splitting *who*. **The rail rule:** payment rails are transport, not counterparty — strip prefix rails (SQ\*/TST\*/PAYPAL\*), treat merchant-of-record aggregators (Apple, Amazon, Google) as the merchant themselves, and never mint from P2P rails (the ratified PII guard).

The current architecture already embodies most of this; what it lacks is the stated definition, a sanctioned merge path for historical unification (the WGU script should be generalized, not repeated), identity-level provenance, and a ratified rule that **cadence detection must not key on `merchantId` alone** (over-merged identity would otherwise destroy subscription intelligence). No new MI architecture is proposed; §9 recommends four bounded roadmap amendments.

---

## 1. Proposed definition of Merchant (deliverable 1)

> **A `Merchant` row represents the consumer-facing brand acting as the stable economic counterparty of a transaction, at the granularity a user would recognize, name, and correct.**

Unpacking each rejected alternative:

| Candidate | Verdict | Why |
|---|---|---|
| **Legal entity** | No | Bank descriptors never carry it ("Google LLC" vs "Google Ireland Ltd" is invisible and irrelevant to a personal ledger); no data source exists; wrong granularity for corrections ("Alphabet Inc." is nobody's answer to "who did you pay?"). |
| **Payment processor / rail** | No | Rails identify transport, not counterparty. `merchant.ts` already strips prefix rails by design; a rail-as-merchant row (a "Square" merchant holding every SQ\* charge) would be an identity lie. Exception: a rail company acting as an actual counterparty (a PayPal account fee) IS a merchant for that row. |
| **Corporate parent / brand family** | No | YouTube belongs under "YouTube," not "Google" — the parent relationship is real but is a *graph edge* (future `parentMerchantId`-class enrichment), never a merge. Collapsing to parents destroys the granularity cadence and subscription intelligence require (§7). |
| **Economic counterparty (brand-level)** | **Yes** | Matches Plaid's `merchant_entity_id` granularity (the one persisted provider identity), matches the user's mental model, matches what every consuming surface renders, and is the level at which corrections are expressible. |

**The correction loop is the arbiter.** Where descriptor data is ambiguous about granularity, the tiebreaker is: *at what level would the user state a correction?* "This is WGU" — yes. "This is Nelnet Business Solutions processing for WGU" — no. This makes the definition operational rather than philosophical, and it is why the USER alias re-point (M5 `pointAlias`) is the only sanctioned identity-changing write.

**Corollary — the who/what rule.** Merchant identity answers **who**. Everything else a descriptor encodes — product (YouTube TV), charge type (SERVICE FEE), channel (MKTP), fulfillment (a specific store #) — is **what**, and belongs to category, to the immutable raw descriptor, or to future service/receipt/cadence layers. No *what*-distinction ever justifies splitting a *who*; no *who*-merge is ever allowed to destroy the *what*-evidence (which is why `Transaction.merchant` is never rewritten — already an MI invariant).

---

## 2. Worked examples (deliverable 2)

| Case | Merchant | Reasoning |
|---|---|---|
| **WGU** (`Western Governors Un`, `Western Governors University`) | One Merchant: **Western Governors University** | Same counterparty; `…Un` is provider truncation. Pure alias case — resolved by the 2026-07-07 USER merge. |
| **`NBS-WGU*SERVICE FEE` / `NBSWGUSERVICE FEE 08LINCOLN`** | **Western Governors University** (as merged), with an honest caveat | NBS (Nelnet Business Solutions) is the tuition-payment rail; the economic counterparty is WGU. The descriptor's fee-ness is a *what*-fact. **Known cost of the merge (flagged, accepted):** `MerchantRule` is one-rule-per-merchant-per-owner, so a future `WGU → Education` USER rule would also categorize the service-fee rows Education. Near-term mitigation: per-row `USER_OVERRIDE` on the (rare, small) fee rows. The durable fix is a charge-type seam (§9.3), not an identity split — the raw descriptors preserve the evidence to re-derive fee rows at any time. |
| **YouTube Premium / YouTube TV** | One Merchant: **YouTube**. Not Google; not two merchants | YouTube is the brand a user names. Premium vs TV is *product* — must survive for Subscription Intelligence (two distinct cadences, prices, renewal dates under one merchant), which it does via the raw descriptors and per-descriptor cadence keys (§7). Google is the parent — graph edge, never a merge (§1). |
| **`Apple.com/bill`** | **Apple** | Apple is merchant of record for iCloud/App Store/Music charges; the card's counterparty genuinely is Apple. The underlying service is unrecoverable from the descriptor — that is Receipt Intelligence's job (Apple emails itemized receipts). Do not attempt service inference from amount patterns in MI. |
| **`PAYPAL *NETFLIX`** | **Netflix** | Prefix rail — `merchant.ts` already strips `PAYPAL *`, so this alias-resolves to the same canonical key as `NETFLIX.COM`. The rail fact ("paid via PayPal") survives in the raw descriptor and alias `sample` for a future payment-method receipt fact. PayPal itself is a Merchant only when it is the counterparty (PayPal fee, PayPal balance top-up). |
| **SQ merchants** (`SQ *BLUE BOTTLE #442`) | **Blue Bottle** (the underlying business) | Square is transport. Store `#442` is noise (stripped). City/state tokens are deliberately kept (conservative doctrine) — two single-word merchants in different cities stay split until a human merges them. |
| **Amazon Marketplace** (`AMZN MKTP`) vs `AMAZON.COM` | **Amazon** — but only by USER correction, not automatically | Amazon is merchant of record for marketplace sales; the third-party seller is a sub-counterparty only a receipt can reveal. `merchant.ts` deliberately refuses to strip brand aggregators (`AMZN MKTP`, `GOOGLE *`), so these mint separately and stay split until a human says otherwise — correct default. The MKTP/retail distinction is *channel*, preserved in raw descriptors for receipt-level use. |
| **`GOOGLE *` family** (`GOOGLE *YouTubePremium`, `GOOGLE *Fi`, `GOOGLE *CLOUD`) | **Separate merchants per branded service** (YouTube, Google Fi, Google Cloud) | The aggregator prefix hides genuinely different services with different cadences. This is the sharpest illustration of why parent-collapse is banned: one "Google" merchant would make "your YouTube Premium renewed" impossible to say. Where the suffix names the service, the service brand is the merchant. |

---

## 3. Alias vs merchant vs service/product boundary (deliverable 3)

**A raw descriptor becomes a `MerchantAlias` when all three hold:**

1. **Same who.** It denotes the same economic counterparty as the target Merchant (truncations, rail-prefixed variants, TLD variants, processor formatting).
2. **No expressible what-loss.** Collapsing it does not destroy a distinction the system currently expresses at merchant granularity. Today the only merchant-granular expression is the USER `MerchantRule` category — so the test is concrete: *would the target merchant's rows want two different standing categories?* If yes (WGU tuition vs service fee), the merge is still identity-correct but carries the known rule-granularity cost; the user accepts it explicitly (USER-source alias) or defers the merge.
3. **Deterministic key.** The mapping is exact-key (`aliasKey` unique; ambiguity refused, never ranked) — already schema-enforced.

**A descriptor's content becomes a service/product/receipt fact — not an alias, not a merchant — when** it encodes *what* rather than *who*: product names (Premium/TV), charge types (SERVICE FEE, ANNUAL FEE), channels (MKTP), item-level anything. MI's obligation is only to **preserve the evidence**: raw `Transaction.merchant` immutable (invariant holds — no writer rewrites it), one raw `sample` per alias, `merchantEntityId` persisted. Extraction of *what*-facts belongs to future layers (§7); MI must never pre-empt them by encoding *what* into identity.

**Practical routing table:**

| Descriptor situation | Route |
|---|---|
| Truncation / formatting variant of a known merchant | Alias (auto at write-time only via exact canonical-key match; else USER correction) |
| Rail prefix + known merchant | Prefix strip already aliases it structurally |
| Aggregator descriptor naming a service (`GOOGLE *Fi`) | Merchant = the service brand |
| Aggregator descriptor hiding the service (`Apple.com/bill`) | Merchant = merchant of record; service → Receipt Intelligence |
| Descriptor encoding charge type (`…SERVICE FEE`) | Alias to the counterparty; charge type → raw descriptor / future charge-type seam (§9.3) |
| P2P / transfer / payroll descriptor | No merchant at all (minting guard — flow-gated, ratified) |

---

## 4. Payment rails (deliverable 5 of the prompt, taken early — it feeds merges)

Three rail classes, three treatments:

1. **Prefix rails — strip, resolve the remainder.** Square (`SQ *`), Toast (`TST*`), PayPal (`PAYPAL *`/`PP *`), Paymentus, POS/ACH/CHECKCARD descriptors. Already implemented in `merchant.ts` `LEADING_PREFIXES`; the underlying merchant is the identity. Additions to the allowlist require the existing bar: the prefix must identify transport *only* (which is why `GOOGLE *`/`AMZN MKTP` are excluded).
2. **Merchant-of-record aggregators — the aggregator IS the merchant.** Apple Billing, Amazon Marketplace, Google Payments (when the suffix does not name a service), Stripe when it appears bare. The cardholder's counterparty is genuinely the aggregator; the hidden sub-merchant is receipt-layer knowledge. Never strip; never guess the sub-merchant from amounts.
3. **P2P rails — never mint.** Zelle/Venmo/PayPal-personal/payroll descriptors embed person names; the ratified minting guard (auto-mint only with `plaidEntityId` or spend-family flow) is the PII fence and must survive every future slice unchanged.

Stripe deserves one note: its descriptors usually surface the actual merchant (`STRIPE: ACME` or acquirer formatting), so it mostly behaves as class 1 with no explicit prefix entry needed; add a prefix only if real data shows a stable `STRIPE*` form.

---

## 5. Merge rules (deliverable 4)

Merges are **corrections, not detections**. The safe-merge contract, generalizing what `merge-wgu-merchants.ts` did:

1. **Human-confirmed, always.** No fuzzy/ML/auto merge in MI, ever (ratified non-goal). The only automatic identity join permitted is what already exists: exact `aliasKey`, exact `plaidEntityId`, exact `canonicalKey`.
2. **Survivor selection is explicit.** The survivor is the row whose `displayName` best matches the brand answer to "who did you pay?" — typically the least-truncated, non-rail form.
3. **Identity columns only.** A merge writes `MerchantAlias.merchantId` (+ `source: USER` — a merge is a teach), `Transaction.merchantId`, `MerchantRule.merchantId` (move or fold), `Merchant.plaidEntityId` (transfer if survivor lacks one), then deletes empty duplicates. It never touches raw descriptors, `category` values, `categorySource`, `flowType`, or `pfc*` — zero desync surface by construction.
4. **Rule reconciliation is defined, not incidental.** Duplicate's rules move to the survivor; on owner/scope conflict, transactions referencing the losing rule re-point to the surviving rule before deletion (provenance links never SetNull'd by a merge).
5. **Atomic and idempotent.** One `$transaction`; re-run finds nothing.
6. **Alias memory is never destroyed.** Every alias of every duplicate re-points to the survivor — a merge must increase what the system remembers, never shrink it.
7. **Auditable.** When PO1's event grammar exists, a merge emits an identity-correction event (who, survivor, absorbed keys, counts). Until then the script's printed verification counts are the record (§8 gap).

**Un-merge:** not currently supported and should stay out of scope; the mitigation is rule 1 (merges are human, deliberate, and rare). The raw descriptors make a manual re-split possible in principle (re-mint + re-point by descriptor group), which is another reason rule 3's "never rewrite descriptors" is load-bearing.

---

## 6. Risk cases where auto-merge is dangerous (deliverable 5)

Named so no future slice "improves" resolution into any of them:

1. **Person names.** Zelle/Venmo/payroll — merging or even minting these builds a PII graph. Covered by the minting guard; any future fuzzy matcher would reopen it.
2. **Parent-brand collapse.** Merging all `GOOGLE *`/`APPLE *` descriptors into Google/Apple destroys per-service cadence — subscription intelligence's raw material. Parent linkage is an edge, not a merge (§1).
3. **Truncation-driven prefix matching.** `Western Governors Un` invites "merge on prefix similarity" — which would also merge `Western Governors Union` if one existed. Truncations are aliases only by human say-so or shared `plaidEntityId`.
4. **Single-token generics.** "Shell" (fuel brand) vs a local "Shell" boutique; "Delta" (airline/faucets/dental). Short canonical keys are the highest-collision class; the conservative normalizer keeps city tokens precisely to keep these split.
5. **Franchise vs corporate.** Two `MCDONALD'S #xxxx` in different cities are one brand (safe to merge) but two `JOE'S PIZZA` in different cities are probably two businesses. Descriptor text cannot distinguish these classes — humans can.
6. **Rail-strip collisions.** Stripping `SQ *`/`PAYPAL *` can make two genuinely different merchants collide on one canonical key (`SQ *JOE'S` in two cities). The alias-refusal semantics (unique `aliasKey`, second mapping refused) is the guard; never weaken it to "last write wins."
7. **Marketplace flattening.** Treating every `AMZN MKTP` seller as needing extraction into separate merchants (over-splitting), or conversely merging `AMZN MKTP` into a seller merchant a receipt once revealed (over-merging). Both wrong: merchant of record stands until Receipt Intelligence exists.
8. **Charge-type-blind merges.** The WGU lesson: merging descriptors that encode different standing charge types under a merchant with a USER category rule silently miscategorizes one class. Not a reason to refuse the merge — a reason the merge is human-confirmed with the cost stated.

---

## 7. What MI must preserve for future intelligence layers (deliverable of prompt Q7)

| Future layer | What it will need | MI obligation (mostly already met) |
|---|---|---|
| **Transaction Intelligence (TI P2+)** | "Why this merchant/category?" provenance in three hops | `categorySource`, `categoryRuleId`, alias `source`, `enrichmentSource/-Confidence` — all persisted. Gap: *identity* provenance (who/what minted or merged a Merchant) — §8. |
| **Receipt Intelligence** (no repo footprint yet) | Merchant-of-record vs underlying seller/service distinction; payment-method facts | Raw descriptor immutability (holds); alias `sample` (holds); never encode sub-merchant guesses into identity (§4.2). |
| **Subscription / Cadence Intelligence (v2.6b)** | Distinct cadences that share one merchant (YouTube Premium vs TV; PlayStation sub vs one-off) | **The one rule that must be ratified now: cadence keys on `(merchantId, descriptor-family, amount-band)` — never `merchantId` alone.** Identity unification is lossy at exactly the granularity cadence needs; the raw descriptor column is what makes the finer key possible. This is a doctrine line, not a schema change. |
| **Ambient Intelligence / briefs** | Stable display names, alias memory so "Netflix renewed" survives descriptor drift | `Merchant.displayName` + alias ratchet (holds). |
| **Promotion pipeline (global catalog growth)** | Which USER aliases/rules recur across users, without moving private data | Alias `source` + `createdAt` (holds); identity-correction events (§8) would strengthen the aggregate signal. |

---

## 8. Confidence and provenance for identity decisions (deliverable of prompt Q9)

**Exists today:** category provenance is complete (`CategorySource` + `RESOLUTION_CONFIDENCE` tiers, USER=1.0 dominating); alias provenance is complete (`MerchantAliasSource` PLAID/IMPORT/USER — USER is the only re-pointable source); enrichment provenance is complete (`enrichmentSource/-Confidence/enrichedAt`, never-overwrite-higher-source).

**Gaps (ranked, none urgent):**

1. **Merchant rows carry no identity provenance.** Nothing records whether a Merchant was minted from a `plaidEntityId` (high confidence — provider-verified identity), from a bare canonical key (medium — string-derived), or shaped by a human merge (highest). A future additive pair (`identitySource` enum + timestamp, mirroring the enrichment columns' shape) would let TI's explainer answer "why is this called Western Governors University?" It should ride the next MI schema slice, not a new one.
2. **Identity corrections leave no audit trail.** An alias re-point overwrites the previous `merchantId` in place; a merge deletes rows. The platform has an append-only audit log and PO1 will define the event grammar — identity-correction events (re-point, merge) should be coined when M5's override/rule events are (readiness investigation already sequences PO1 P0 before M5 for exactly this reason).
3. **Implicit confidence semantics should be stated, not schema'd:** `plaidEntityId` match > USER merge/alias > exact canonical key > guarded mint. This ordering already governs `lookupExisting`; writing it down (this document) is sufficient until a consumer needs a number.

---

## 9. Recommended roadmap changes (deliverable 6)

All bounded; none change MI's architecture; none are authorized by this document.

1. **Ratify the Merchant definition (§1) and the who/what rule into MI doctrine** — a one-paragraph addition to the next MI decision record, so future slices (and future merge requests) argue from a stated definition instead of re-deriving one.
2. **Generalize the WGU merge script into the sanctioned merge utility** (`scripts/merge-merchants.ts --survivor=<key> --absorb=<key>…`, dry-run default), encoding §5's contract. The M5 alias re-point deliberately does not unify history; without a sanctioned tool, the next duplicate cluster gets an ad-hoc script. Small slice, no schema.
3. **Decide the charge-type seam before Subscription Intelligence.** The WGU service-fee case shows one-rule-per-merchant is occasionally too coarse. Options when the need recurs: descriptor-scoped rules (a `MerchantRule.aliasKey?` narrowing), or accepting per-row overrides indefinitely. Decision gate only — no build now; the raw descriptors keep both options open.
4. **Ratify the cadence-key doctrine (§7)** into the v2.6b entry gates: cadence detection keys on merchant × descriptor-family × amount-band, never merchant alone.
5. **Add identity provenance columns + identity-correction audit events** to the next natural schema slice / PO1 event-coining moment respectively (§8.1–8.2). Additive, cheap, and the TI explainer will want them.

---

## 10. Final recommendation (deliverable 7)

**Adopt the definition: a Merchant is the consumer-recognizable counterparty brand, at correction granularity.** The existing MI architecture needs no structural change to honor it — the conservative normalizer, exact-key resolution, refusal-on-ambiguity, flow-gated minting, USER-only re-pointing, and immutable raw descriptors are all consequences this investigation merely makes explicit. The WGU merge was semantically correct (NBS is a rail; WGU is the counterparty) and its one real cost — merchant-level rule granularity vs charge-type descriptors — is a known, bounded limitation with a per-row mitigation and a named future seam, not a reason to split identity.

Hold the line on the three prohibitions this definition implies: **no parent-brand merges, no fuzzy/auto merging, no encoding of *what*-facts (products, fees, channels) into *who*-identity.** Preserve evidence over inference everywhere (raw descriptors immutable, alias samples kept, entity ids persisted), because every future intelligence layer — TI's explainer, Receipt's sub-merchant recovery, Subscription's per-service cadence — is downstream of that evidence and none of it can be re-fetched. The five §9 amendments are the entire recommended delta; the smallest of them (writing the definition down) is the one that prevents the next WGU-shaped debate from starting from zero.
