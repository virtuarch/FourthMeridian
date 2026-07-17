# CCPAY-2G — Provider Evolution Review

*Architecture review only. No code, no refactor. Grounds the standing recommendation
on whether/when Fourth Meridian should introduce a `CardPaymentEvidence` (or other
canonical evidence) abstraction, across the provider set it may one day ingest:
Plaid, MX, Finicity, Akoya, CSV, manual import, future Open Banking.*

---

## The question

> Should Fourth Meridian introduce a provider-neutral `CardPaymentEvidence`
> abstraction — a canonical struct each provider adapter emits, which the
> classifier consumes — and if so, when?

## Verdict

**Not yet. Wait for provider #2.** The CCPAY-2A…2F work already delivered the
*outcome* a `CardPaymentEvidence` abstraction would deliver — provider-neutral
liability-payment classification — **without** the abstraction, by pushing the
neutral decision up into two shared authorities and keeping each provider's raw
extraction thin. Introducing the abstraction now would be designing a "neutral"
shape from a **single sample**, which is the precise mistake CCPAY-1 documented.

This is the concrete instance of a durable rule now in doctrine
([financial-semantics.md § Liability payment classification, rule 8](../../doctrine/financial-semantics.md)):
**introduce a provider-neutral abstraction from the second instance, not the first.**

---

## Where the provider landscape actually stands

Grounded in the repo/DB at the time of this review — not the enum's aspirations:

| provider | `ProviderType` reserved | real connected identities | card-payment descriptors observed |
|---|---|---|---|
| Plaid | ✅ `PLAID` | **10** | Chase + Amex only (2 issuers) |
| Wallet (BTC) | ✅ `WALLET` | 1 | n/a — synthetic labels, no card payments |
| CSV | ✅ `CSV` | 0 (0 import batches) | none in this deployment |
| Manual | ✅ `MANUAL` | 0 | none |
| Exchange / Brokerage | ✅ | 0 | n/a |
| **MX / Finicity / Akoya / TrueLayer / Tink** | **absent from the codebase** | 0 | 0 |

**There is exactly one bank aggregator (Plaid), and its card-payment evidence
comes from two issuers.** A grep for `finicity|akoya|mx|truelayer|tink` across
`lib/` + `app/` returns nothing. The "provider expansion" the abstraction would
serve does not exist yet.

## Why "one sample" is disqualifying, with evidence

CCPAY-1 measured what happens when you generalize a card-payment vocabulary from
imagination rather than a second real provider: **8 of the 12** original
`CARD_PAYMENT_DESCRIPTORS` tokens (`cardmember serv`, `credit crd autopay`,
`online payment`, …) matched **zero** of 4,334 real rows. They were authored as
guesses about Citi/Discover/Wells descriptors the platform had never connected.
CCPAY-2C pruned them to the 3 attested tokens. A `CardPaymentEvidence` schema
designed now would bake the same guesswork into a *type*, where it is far more
expensive to remove than a string in a list.

## The abstraction is not needed to be provider-neutral — the seam already is

CCPAY established a three-stage funnel that is *already* provider-neutral, without
a `CardPaymentEvidence` struct:

```
provider-specific raw extraction        →  normalized canonical evidence      →  provider-neutral classification
─────────────────────────────────────      ────────────────────────────────      ──────────────────────────────
Plaid : mapPlaidCategory (PFC → cat)        resolveLiabilityPaymentCategory        classifyFlow
        merchant_name/name descriptor       (liability + inflow + normalized       (liability + inflow + category
CSV   : mapped columns → cat + descriptor    word-boundary descriptor ⇒ Payment)    ⇒ DEBT_PAYMENT; the 2B veto)
Wallet: synthetic (no card payments)        ── one authority, all providers ──     ── descriptor-blind ──
```

- **Provider-specific, thin:** `mapPlaidCategory` (Plaid PFC), the CSV column
  mapper, `btc-sync`'s synthetic labels. Each knows only *which fields hold the
  descriptor and the provider's own taxonomy.*
- **Canonical, shared:** `resolveLiabilityPaymentCategory` (the rescue) and
  `classifyFlow` (the flow + the veto). Every ingesting path — Plaid sync, CSV
  import, preview, backfill — calls the *same* two functions. None re-implements
  either.

`resolveLiabilityPaymentCategory`'s evidence input (`{ accountType, debtSubtype,
amount, merchant, description }`) **is** the canonical card-payment evidence — it
is just passed as arguments rather than named as a struct. A `CardPaymentEvidence`
type would rename this, not add capability.

## What belongs where — the adapter/canonical boundary (for when #2 arrives)

The review's most reusable output: a clean division that a second provider slots
into without touching the classifier.

| concern | layer | today |
|---|---|---|
| which fields carry the descriptor | **provider adapter** | Plaid `merchant_name`/`name`; CSV columns; wallet synthetic |
| provider taxonomy → attestation | **provider adapter** | `mapPlaidCategory` (PFC); `transaction_code: "bill payment"` is captured, unused |
| `subtype` → is-a-revolving-card | **provider adapter** | **discarded today** — `mapAccountType` collapses Plaid subtype to `debt` (a known gap, DEC-adjacent) |
| descriptor normalization + matching | **canonical** | `normalizeDescriptor` + word-boundary, provider-neutral |
| liability + inflow + attestation ⇒ Payment | **canonical** | `resolveLiabilityPaymentCategory` |
| liability outflow ⇒ never DEBT_PAYMENT | **canonical** | `debtPaymentUnlessLiabilityOutflow` (the 2B veto) |

A second aggregator (MX/Finicity/Akoya) becomes: a new adapter that maps *its*
taxonomy to attestation and points at *its* descriptor fields — then calls the
same canonical two functions. That is the sibling-adapter pattern the existing
`plaid-transfer-evidence.ts` header already prescribes for `TransferEvidence`:
*"Adding another provider … means writing a SIBLING adapter that emits
[the neutral evidence]."*

## Options, graded (from CCPAY-1 PART 9, updated to the post-2F reality)

| | correctness | FP risk | provider-neutral | maintainability | status |
|---|---|---|---|---|---|
| A normalize punctuation only | B | A− | D | A | subsumed by 2C |
| B normalize + expand tokens | B− | **D** (measured) | D | D | rejected |
| C evidence classifier (tier+sign+PFC+descriptor) | **A** | **A** | **B+** | **A** | **shipped (2A–2F)** |
| D C + owned-counterpart pairing | A | A | B+ | C | rejected — 0/4334 rows have a counterpart |
| E provider adapters emit `CardPaymentEvidence` | A | A | **A** | A | **premature — this review** |
| **F** C now → E when provider #2 lands | **A** | **A** | A− | **A** | **← the chosen path** |

Option F is not a compromise; it is the correct sequencing. C (done) already
scores A on correctness and false-positive risk. E's only marginal gain over C is
a named struct — worth building **once there is a second emitter to prove the
shape**, and premature until then.

## Trigger conditions — build `CardPaymentEvidence` when ANY holds

Not on a calendar; on evidence. Revisit E when:

1. **A second bank aggregator connects** (MX / Finicity / Akoya / an Open-Banking
   provider) **and** its card-payment descriptors or payment taxonomy differ
   structurally from Plaid's — i.e. the adapter/canonical boundary above starts
   to strain because the canonical side needs a provider-shaped field. *The
   second real emitter is what reveals the true neutral shape.*
2. **A provider supplies structured card-payment metadata** the descriptor path
   cannot capture — e.g. Plaid `transaction_code: "bill payment"` (captured today,
   unused) or an issuer's explicit payment flag. A struct earns its keep when
   there are typed fields to carry, not just a descriptor string.
3. **CSV/manual imports become load-bearing** — if evidence-poor providers (no
   PFC, no subtype) become common, the descriptor becomes the *primary* signal for
   a real population, and formalizing that evidence is worth the type.

Until one holds, the descriptor allowlist stays what CCPAY-1 concluded it is: the
**adapter fallback for evidence-poor sources**, never the primary authority.
Structural signals (account tier, sign, PFC family) are primary; the descriptor
rescues only the `Other` residue those signals miss.

## What NOT to do (anti-patterns this review forecloses)

- **Do not** design the `CardPaymentEvidence` schema against Plaid alone. One
  emitter cannot reveal which fields are provider-specific vs neutral.
- **Do not** add speculative descriptor tokens for unseen issuers (the 8-of-12
  lesson). Add a token when a real row proves it.
- **Do not** fetch `original_description` speculatively to "enrich" evidence — it
  is not even requested today; add it only if a trigger condition needs it.
- **Do not** promote the descriptor allowlist to a primary authority. It is a
  fallback; the structural evidence is primary.

## Relationship to other work

- **DEC / account subtype:** the single most valuable *structural* enrichment is
  persisting the provider `subtype` (Plaid already sends `credit card`; it is
  discarded at `mapAccountType`). That is a structural signal, not an evidence
  abstraction, and it strengthens the canonical classifier for **every** provider
  without a `CardPaymentEvidence` type. It should precede E, not follow it.
- **FU-1 (btc-sync):** the wallet provider authors flow facts by hand. Converging
  it is the one place a *canonical* evidence input would help today — but that is a
  crypto-flow concern, not card-payment, and is tracked separately in
  [CCPAY_FOLLOW_UPS.md](./CCPAY_FOLLOW_UPS.md).

## One-line standing recommendation

**Ship nothing here. Keep provider adapters thin and the canonical classifier
descriptor-blind; introduce `CardPaymentEvidence` only when a second emitter
exists to prove its shape — and copy the `TransferEvidence` sibling-adapter
pattern when you do.**
