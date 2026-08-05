# Financial Truth — The Transfer Resolution Authority

**Architecture proposal. No implementation, no schema, no migration, no repair, no mutation.**
Evidence base: `V27-INVESTIGATION-TRANSFER-TRUTH-EVIDENCE-ARCHITECTURE.md` plus one further
read-only projection pass (counts before and after identical: 4,447 / 4,402 / 35).

---

## 0. The thesis

The current authority is *correct* and *incomplete*, and those are different problems with
different fixes.

It is correct: measured against 132 legs of provider-issued ground truth, it makes **zero
errors**. Every alternative that raises recall by optimizing — greedy nearest, min-cost
bipartite matching — introduces 7–8 wrong pairings. That correctness is the asset. Nothing
in this proposal trades it away.

It is incomplete for three reasons that have nothing to do with matching quality:

1. It **measures the wrong population** — 306 non-transfer rows and 65 liability charges
   are admitted and can never resolve.
2. It has **no vocabulary for a completed external movement** — a Zelle payment to a named
   person is fully understood and reported as `UNRESOLVED_TRANSFER`.
3. It **reads none of the identifier evidence already in the database** — and, more
   importantly, it resolves each leg against the *whole* corpus at once rather than letting
   settled facts remove competitors.

The projected end state, measured by replaying the proposed ladder over the live corpus:

| | today | proposed | proposed, **all identifier evidence disabled** |
|---|---|---|---|
| legs admitted | 671 | **598** | 598 |
| persistable counterparty | **234 (34.9%)** | **396 (66.2%)** | **352 (58.9%)** |
| terminal external / cash | 0 (as such) | **199 (33.3%)** | 199 (33.3%) |
| genuinely unresolved | 252 movement-unresolved | **1** | **21 (3.5%)** |

> The third column is the one that matters for a product serving millions of users.
> **73% of the gain (+118 legs) comes from provider-agnostic structural changes**;
> only 27% (+44 legs) comes from identifier evidence Chase happens to expose.
> The architecture does not depend on Chase.

---

## 1. Reconciling the investigation findings

| finding | verdict | why |
|---|---|---|
| **Unresolved population is inflated by admitted non-transfers** | **Architectural.** Canonical. | `isTransferCandidate` admits `flowType === null`, which means *"never classified"*, not *"possibly a transfer"*. That is a category error in the predicate, not a property of this dataset. Any deployment with an unclassified backlog, a CSV import, or a new provider whose classifier has not run will exhibit it. |
| **Liability outflows are admitted as transfer legs** | **Architectural.** Canonical. | A charge on a card is structurally never a transfer leg — the flow classifier already encodes this (`debtPaymentUnlessLiabilityOutflow`) and the maturity ladder already has no leaf for it. The admission gate simply disagrees with two authorities that are already right. |
| **Provider correlation IDs resolve deterministically** | **Architectural (the abstraction), dataset-specific (the pattern).** | The *concept* — a provider asserting that two rows are one movement — is universal and belongs in the evidence ladder as a first-class rung. The *regex* `transaction#:\s*\d{6,}` is Chase's. §3 and §4 separate these so the pattern lives in a provider adapter and the rung does not. |
| **Account certainty and leg certainty are conflated** | **Architectural.** Canonical, and the purest of the findings. | `resolveDestinationEvidence` demotes on `live.length > 1` even when every candidate is on one account, returning `accountId: null` while `candidateAccountIds.length === 1`. The level's own name then asserts something the level's own data contradicts. 75 legs, $103,000. This is a logic defect visible by reading, not a measurement. |
| **Many unresolved rows are external transfers** | **Architectural.** Canonical. | `deriveTransferDisposition` already has `EXTERNAL_BANK_TRANSFER` and `PAYMENT_APP_MOVEMENT`; `TransferMaturity` — the vocabulary that actually classifies — has neither. Two vocabularies exist and only the weaker one is wired in. Same shape as the read-boundary divergence V27-TRUTH-2 removed, one level up. |
| **Graph chain inference produced nothing trustworthy** | **Architectural conclusion, dataset-confirmed.** Do not build it. | The arrival→departure histogram *rises* to a peak at 27–28 days (0–7d: 136, 8–14d: 108, 15–28d: 221). That is anti-causal — the statement cycle, not forwarding. Combined with density 0.143 and a single hub, there is no topology for a chain to live in. |
| **Global optimization is worse than the local rule** | **Architectural.** A permanent constraint. | Min-cost matching: 8 wrong. Greedy: 7 wrong. Current: 0. The reconciliation literature assumes a *closed book*; 210 of 671 legs have no counterpart in the corpus at all. This is a property of personal finance, not of one dataset. |
| **Stratified (day-0-first) matching is free recall** | **Architectural.** Canonical. | 116/132 correct vs 72, **0 wrong, 0 conflicts**. Pure reordering of an existing predicate. |
| Zero FX, zero batching, zero split transfers | **Dataset-specific.** Do not build for them. | Absence of evidence in a two-institution corpus is not evidence of absence — but it is sufficient reason not to build tolerance models now. Revisit when a corpus contains them. |
| Amount collisions ($1,000 × 154) | **Dataset-flavoured, architecturally universal.** | The specific amount is this user's. The *phenomenon* — recurring round-number transfers destroying the discriminating power of (amount, date) — is universal, and is why the ladder must be evidence-tiered rather than tolerance-tuned. |
| `pendingTransactionRef` at 61/4,050 | **Dataset-specific coverage, architecturally important.** | Low coverage here; the field is a *lifecycle* link, not a counterparty link (§4.5). Its scarcity is why it cannot be the only provider-link rung. |

---

## 2. Canonical transfer candidate population

### 2.1 The definition

> A row is a **transfer candidate** when some evidence asserts that value *moved*, rather
> than that value was *consumed or produced*.

Three conditions, all required:

1. **Classified.** A classifier has run and produced a `flowType`. `null` is not a
   hypothesis; it is the absence of one.
2. **Structurally capable of being a leg.** The row's own account and sign do not
   themselves settle the question. A liability *outflow* is a charge; it is excluded here,
   not resolved later.
3. **Transfer-shaped by evidence.** A transfer provider family, a Transfer/Payment
   category, or an attested rail / form / venue axis.

### 2.2 What each population is, and where it goes

| population | in the candidate corpus? | terminal home |
|---|---|---|
| **Internal transfer** (owned → owned) | ✅ | the resolution ladder, §8 |
| **External transfer** (owned → not owned) | ✅ | a **terminal external leaf**, §6 |
| **Cash movement** (form change) | ✅ | `CASH_MOVEMENT` — already terminal, already correct |
| **Debt payment** | ✅ | resolved by the own-account rule *before* the ladder; unchanged |
| **Investment transfer** | ✅ | resolved by destination type, or `EXTERNAL_VENUE_UNCONNECTED` |
| **Liability outflow (a charge)** | ❌ | the spending classifier already owns it |
| **Income / spending / fees / interest / refunds** | ❌ | never entered; unchanged |
| **Unclassified rows** (`flowType === null`, `classifierVersion === null`) | ❌ | a **classification backlog**, reported as such |
| **Demo / seed data** | ❌ *by the same rule* | excluded because unclassified, **not** by an owner allow-list |

> ⚠️ **Seed data must be excluded by a principled predicate, never by an owner ID or an
> institution name.** In this corpus all 352 seed rows are `flowType === null,
> classifierVersion === null` — they are excluded *because they are unclassified*, which is
> a rule that generalizes to a real user's import backlog. A hard-coded exclusion would
> generalize to nothing and would silently hide real data on the day seed rows get
> classified.

### 2.3 Measured effect of admission alone

| | rows |
|---|---|
| candidates today (whole corpus) | 1,023 |
| candidates today (real owner) | 671 |
| **candidates under the canonical definition** | **598** |
| removed: unclassified (seed + backlog) | 352 |
| removed: liability charges | 65 |
| removed: classified but not transfer-shaped | 8 |

Admission is not only a metric fix. **Removing 65 liability charges removes 65 false
competitors** from every other leg's candidate set, which is why the resolution tiers
downstream perform better than they do today on the same evidence. Correct admission
*causes* correct resolution.

### 2.4 The metric

Two denominators, never one:

- **Movement-unresolved** — the movement has no name. Target: → ~0.
- **Counterparty-unresolved** — the movement is named, the account is not.

And `CASH_MOVEMENT`, `ISSUER_CREDIT` and every external leaf are **resolved**. Today 63 cash
rows and 8 issuer credits are counted as failures; they are finished facts.

---

## 3. The provider-neutral evidence hierarchy

The organising principle: **evidence is ranked by who asserted it and what they asserted
about**, never by how convenient it is.

```
  ┌─ E1  PROVIDER-ASSERTED IDENTITY ──────────────── deterministic · persistable
  │      the provider states that two rows are one movement,
  │      or that this row's counterparty is that account
  ├─ E2  STRUCTURAL DETERMINISM ──────────────────── deterministic · persistable
  │      the corpus admits exactly one consistent pairing
  ├─ E3  SCOPING EVIDENCE ────────────────────────── narrows only · never resolves
  │      removes candidates; may promote E2 by removing competitors
  ├─ E4  CLASS EVIDENCE ──────────────────────────── names the movement · not the account
  │      the destination TYPE is known even when the account is not
  ├─ E5  TERMINAL EVIDENCE ───────────────────────── a complete answer with no account
  │      form change, external party, unconnected venue
  └─ E6  ABSENCE ─────────────────────────────────── honest residue
```

### 3.1 Where each named source belongs

| source | rung | asserted by | persistable | notes |
|---|---|---|---|---|
| Provider **transfer id** (a native transfer object, e.g. Plaid Transfer / RTP end-to-end id) | **E1** | provider | ✅ | Does not exist in this corpus. Highest rung reserved for it. |
| **Correlation id in a description** | **E1** | provider (unstructured channel) | ✅ | §4. Same assertion, weaker channel — needs validation the structured form would not. |
| **`pendingTransactionRef`** | **E1, different scope** | provider | ✅ *for lifecycle, not counterparty* | §4.5. Links a row to its own earlier self. Not a counterparty link. |
| **Institution-generated transfer id** (ACH trace, wire IMAD/OMAD, Zelle confirmation) | **E1** if it appears on both legs; **E3** if only on one | institution | ✅ / ❌ | An id on one leg only is a *reference*, not a *link*. |
| **Counterparty mask** | **E1** | provider | ✅ **when unambiguous** | An identifier, not a name. Must abstain on collision. |
| **Mutual deterministic opposite leg** | **E2** | Fourth Meridian | ✅ | The current authority. Unchanged in substance, stratified in order. |
| **Ownership** | **precondition** | Fourth Meridian | — | Never evidence; a boundary. Already correct doctrine. |
| **Account type** | **E4** | Fourth Meridian | ❌ | Names the movement; never the account. |
| **Amount** | **E2 input** | provider | ❌ alone | Entropy 5.38 bits over 608 rows; $1,000 appears 154×. |
| **Timing** | **E2 input** | provider | ❌ alone | 123 of 164 contested legs have an exact **same-day** rival. |
| **Descriptor — as an identifier** | **E1** | provider | ✅ | mask, correlation id, trace number |
| **Descriptor — as a name** | **E3** | provider | ❌ **never** | Measured: institution-name routing resolves **0** legs on its own; it cuts 28 multi-account sets to 1. Names scope, identifiers resolve. |
| **Rail / form / venue** | **E5** | provider adapter | ❌ | Already the right shape. Produces terminal leaves. |
| **Balance gap** | **support only** | Fourth Meridian | ❌ **never** | Existing doctrine ("a gap is not a transaction") is right and stays. A gap is also not independent of the transactions that produced it, so it cannot arbitrate between two same-day equal-amount candidates. |
| **Future provider metadata** | adapter decides its rung | provider | per rung | New providers write a stage-1 adapter, as `plaid-transfer-evidence.ts` already establishes. The ladder is untouched. |

### 3.2 Graceful degradation is the design requirement, not a fallback

A provider exposing nothing above E2 must still produce a correct, useful answer. Measured
on the live corpus with **every E1 source disabled**:

| | E1 enabled | **E1 disabled** |
|---|---|---|
| persistable counterparty | 396 (66.2%) | **352 (58.9%)** |
| terminal external / cash | 199 | 199 |
| type-certain only | 2 | 26 |
| unresolved | 1 | **21 (3.5%)** |

Degradation is graceful and *measured*, not asserted. The floor is still a large
improvement on today's 234.

> ⚠️ **Tier ordering creates a cascade dependency and this is the proposal's main
> structural risk.** Each E1 claim removes two legs from every other leg's candidate set,
> which is precisely why E2 performs better after E1 runs. The corollary is that *one wrong
> E1 claim can cause a downstream mis-pairing that would not otherwise occur*. Mitigation
> is in §12.3: E1 must be validated per-claim, not trusted per-source, and must abstain
> rather than guess.

---

## 4. Correlation IDs

### 4.1 What was measured

132 rows · 66 distinct ids · **every group of exactly size 2** · all 66 cross-account,
opposite-sign, equal-amount, same-owner, same-currency, **0-day gap** · **0 contradictions**
with the current authority (it independently agrees on 72 of the 132) · 60 legs newly
resolvable · **0 errors**.

### 4.2 Canonical extraction

Extraction belongs in a **stage-1 provider adapter**, exactly where
`plaid-transfer-evidence.ts` already lives, and emits provider-neutral evidence:

```
  provider row  ──▶  [ institution-scoped extractor ]  ──▶  CounterpartyLinkEvidence
                       Chase:  transaction#: <digits>
                       (others: their own patterns, or none)
```

The canonical layer must never learn a pattern. Adding an institution is adding an
extractor; the ladder, the validator and every consumer are untouched. An institution with
no pattern yields no evidence and no error — the same contract the existing adapter uses
for `plaid:no_signal`.

### 4.3 Normalization

The raw provider string must **not** be the join key. Normalize to:

```
  linkKey = truncate( hash( institutionId ‖ ":" ‖ extractorId ‖ ":" ‖ rawId ) )
```

Three properties, each load-bearing:

- **Institution-scoped** — Chase reference `30039468383` and some other bank's identical
  numeral can never collide into one group.
- **Extractor-scoped** — two patterns within one institution stay in separate namespaces,
  so a new extractor cannot retroactively merge old groups.
- **Opaque** — the key preserves the join and destroys the ability to recover a bank
  reference number. See §4.6.

### 4.4 Validation — a link is a claim, and claims are checked

A correlation id is evidence from an *unstructured channel*. A structured provider field
carries the provider's guarantee; a substring of a descriptor does not. Every group must
therefore satisfy, and be **discarded entirely** if it does not:

1. **Cardinality = 2.** Three rows sharing a key is not a movement; it is a pattern
   collision. (Measured: 66/66 groups were exactly 2.)
2. **Cross-account.**
3. **Same owner.**
4. **Same currency.**
5. **Opposite sign.**
6. **Equal magnitude** within the existing epsilon.
7. **Within the settlement window.** (Measured: all 66 at 0 days.)
8. **Neither leg superseded.**

Note what this validation is *not*: it is not a scoring function and it does not weaken on
failure. A group that fails any check produces **no evidence at all** and falls through to
E2 — it never produces a weaker claim. This is the same "unknown over incorrect" discipline
the evidence contract already states.

A standing probe should assert the invariant that made this trustworthy: **a correlation-id
pairing must never contradict an independently-derived `ACCOUNT_CERTAIN` pairing.** Today
that holds on 72 of 72 overlapping legs. The day it stops holding, one of the two
authorities is wrong and the product must find out from a test, not from a user.

### 4.5 First-class, or one signal inside a provider-link abstraction?

**Neither, as posed — and the framing is the important part.**

`CounterpartyEvidence.PROVIDER_LINK` is currently documented as *"a provider link
(pendingTransactionRef / counterparty id)"*. Those two things answer different questions:

| | `pendingTransactionRef` | correlation id |
|---|---|---|
| links | a row to **its own earlier self** | **two different accounts'** rows |
| scope | intra-account, temporal | inter-account, relational |
| answers | *is this the same event?* | *is this the other side?* |
| owned by | **event identity (L8)** | the transfer authority |
| coverage here | 61 / 4,050 rows | 132 rows, 66 pairs |

Conflating them means an L8 lifecycle fact and a counterparty fact share one enum member,
so no consumer can tell which question was answered. The proposal:

> One abstraction, **`ProviderAssertedIdentity`**, with an explicit `scope`:
> **`SELF`** (lifecycle — `pendingTransactionRef`, owned by L8) and
> **`COUNTERPARTY`** (relational — correlation ids, native transfer ids, ACH traces
> appearing on both legs).
>
> Correlation ids are **first-class within the `COUNTERPARTY` scope**, ranked *below* a
> native structured provider transfer id and *above* structural matching. They are not
> peers of `pendingTransactionRef`; they are its sibling under a shared parent.

This also resolves an ordering question cleanly: `SELF`-scope evidence must be applied
before `COUNTERPARTY`-scope evidence, because supersession determines which rows are even
eligible to be legs.

### 4.6 Privacy boundaries

**No existing privacy rule is relaxed. Two are tightened.**

The `plaid-flow-input.ts` deny-list (`payment_meta.{ppd_id, reference_number, payer, payee,
by_order_of}`, `counterparties[].account_numbers`, `account_owner`, location) **stays
exactly as it is.** This proposal never reads a denied field.

Extraction operates only on `Transaction.description` — a column already stored, already
rendered in the UI, already present in AI payloads. Reading a substring of it introduces no
new exposure. Constraints on what may be *derived* from it:

1. **The raw id is never persisted** — only the opaque `linkKey` (§4.3). This is strictly
   more private than the status quo, in which `transaction#: 30039468383` sits in a
   plaintext column.
2. **`linkKey` is SYSTEM-only** — never in a DTO, never in the AI payload, never rendered,
   never logged. Same treatment `pendingTransactionRef` already carries ("SYSTEM: never
   AI/UI").
3. **An extracted mask is never echoed.** The *output* is a resolved `accountId`; the
   digits are consumed and discarded. A mask must never appear in a `classificationReason`
   string, which is user-visible.
4. **Extraction is not enrichment.** The extractor may recognise identifiers only. It may
   not extract names, memos, phone numbers, or counterparty text — those are the deny-list's
   subject matter and remain out of reach whatever channel they arrive through.

> ⚠️ The uncomfortable fact worth stating plainly: the privacy boundary is *already*
> crossed, in the worse direction. `SCHWAB BROKERAGE MONEYLINK PPD ID: 9005586224` and
> `Zelle payment to Mom JPM99b2i991r` are stored in `description` today and shown to the
> user. The deny-list keeps out the structured, typed, minimizable copy while the raw,
> unbounded copy is retained and displayed. Structured extraction to an opaque key is a
> **reduction** in exposure, not an increase — and a future slice that redacts identifiers
> *out* of `description` after extraction would be a further reduction. Neither requires
> touching the deny-list.

---

## 5. The missing evidence rung — `ACCOUNT_CERTAIN_LEG_AMBIGUOUS`

### 5.1 The defect

`resolveDestinationEvidence` returns `TYPE_CERTAIN_ACCOUNT_AMBIGUOUS` — with
`accountId: null` — whenever more than one leg qualifies, **including when every qualifying
leg is on the same account**. The level's name says the account is ambiguous; the level's
own `candidateAccountIds` field says it has exactly one element.

**75 legs, $103,000.** Six of them are the same shape:

```
  +2,000  Amex Platinum  "MOBILE PAYMENT - THANK YOU"
          2–3 qualifying legs, every one on Chase checking …2058
          → level says accountId: null
```

*Which* $2,000 debit paid the card is unknowable. *That it came from Chase checking* is
certain, and is being discarded.

### 5.2 The state

> **`ACCOUNT_CERTAIN_LEG_AMBIGUOUS`** — every qualifying destination leg resolves to one
> owned account. The **account** is a fact. The **leg** is not, and there is no evidence
> that would make it one.

| | `ACCOUNT_CERTAIN` | `ACCOUNT_CERTAIN_LEG_AMBIGUOUS` | `TYPE_CERTAIN_ACCOUNT_AMBIGUOUS` |
|---|---|---|---|
| destination account | known | **known** | unknown |
| destination leg | known | **unknown, permanently** | unknown |
| `accountId` persistable | ✅ | ✅ | ❌ |
| `legId` persistable | ✅ | ❌ **never** | ❌ |
| maturity leaf | from account type | from account type | from account type |
| reason for uncertainty | — | **indistinguishable identical movements** | **competing accounts** |

The distinction from `ACCOUNT_CERTAIN` is not confidence — both are certain about the
account — it is **what remains unknown and whether more evidence could ever settle it.**
`ACCOUNT_CERTAIN` knows the leg. This state knows the leg is unknowable: two identical
movements between the same two accounts in the same window are not distinguishable by any
evidence that exists or could exist, short of the provider linking them.

That last clause matters for the ladder's monotonicity: a later E1 correlation id **can**
promote this state to `ACCOUNT_CERTAIN`. It is a rung, not a dead end, and
`adoptIfMonotonic` handles the promotion without special-casing (rank rises, leaf unchanged).

### 5.3 Persistable / never persistable

**Persistable:** `counterpartyAccountId`. It is a fact, established by the same
account-level reasoning `ACCOUNT_CERTAIN` uses, and every downstream consumer — wealth
neutrality, per-liability debt attribution, cash-flow exclusion, liquidity tiering — asks
*which account*, never *which row*.

**Never persistable:** the leg id, a "most likely" leg, a leg count, a tie-break, an
ordering. Persisting any of them would assert an answer to a question with no answer.

> ⚠️ This is the one place where the proposal deliberately persists something the current
> code refuses to. The justification is precise: the current refusal is a **gate applied at
> leg level to a claim made at account level.** That exact error has been recorded before —
> `v27-l4-counterparty-repair`: *"the gate must be ACCOUNT-level not leg-level."* This is
> the same mistake, still present, in a different function.

### 5.4 UI

The distinction the interface must carry is **"we know where it went" vs "we know the
account but not which of two identical movements"** — and honestly, users care about the
first and not the second.

- Present it **identically to `ACCOUNT_CERTAIN`**: "Transfer to Chase Savings ••9516".
  The counterparty is named because it is known.
- Do **not** show an ambiguity badge in the list. There is no user decision behind it and
  no action to take; a warning would manufacture doubt about a fact.
- In the detail drawer's provenance line, state it plainly: *"Matched to Chase Savings
  ••9516. Two identical $2,000 transfers occurred in this window, so the specific
  transaction on the other side is not identified."*
- **Never offer the user a disambiguation control.** The user does not know either, and
  asking would convert a system limitation into a user obligation.

### 5.5 AI

- The assembler receives `counterpartyAccountId` and may state the counterparty as fact.
- It receives the evidence level and **must not** claim a specific opposing transaction,
  quote its id, or say "this transfer paired with that one."
- Aggregate reasoning is unaffected: totals, attribution, and neutrality all key on the
  account.
- The payload must never contain the candidate leg set. Handing the model a list of
  possibilities is an invitation to pick one.

---

## 6. External transfer terminal states

### 6.1 The principle

> An external movement is not an unresolved internal movement. It is a **different, complete
> fact**, and the ladder currently cannot say it.

`deriveTransferDisposition` already distinguishes `EXTERNAL_BANK_TRANSFER`,
`ASSET_VENUE_TRANSFER`, `PAYMENT_APP_MOVEMENT`, `CASH_MOVEMENT`. `TransferMaturity` — the
vocabulary that actually classifies — has only `CASH_MOVEMENT`. Convergence means giving
the maturity ladder the terminal leaves the disposition vocabulary already has, and then
having exactly one vocabulary.

### 6.2 The states

| terminal state | when | evidence | live | can more evidence change it? |
|---|---|---|---|---|
| **`CASH_MOVEMENT`** | form change; no destination account exists | `movementForm = CASH` | **62** | No. Terminal by construction. *(exists)* |
| **`EXTERNAL_PERSON`** | a payment-app rail with no owned counterpart | rail = `PAYMENT_APP` | **116** | No. The counterparty is a person. |
| **`EXTERNAL_DEPOSITORY`** | a depository venue, no owned counterpart | venue = `DEPOSITORY` | **1** | **Yes** — if the user connects the account. |
| **`EXTERNAL_VENUE`** | brokerage / exchange, no owned counterpart | venue = `BROKERAGE`/`EXCHANGE` | **20** | **Yes** — if the user connects the venue. |
| **`EXTERNAL_UNKNOWN`** | no owned counterpart and no attested rail/venue | absence | 0 here | Yes, in principle. The honest floor of the external branch. |

### 6.3 On wire vs ACH — deliberately **not** modelled

The brief lists wire and ACH as candidate terminal states. They should **not** be:

- They are **rails**, not destinations. The evidence contract's founding doctrine is
  *"RAIL ≠ PURPOSE — a rail says HOW, never WHY."* `WIRE` and `ACH` answer *how*; every
  other member of this enum answers *where the money went*. Mixing the axes into one enum
  is precisely the collapse the contract forbids.
- No provider in this corpus attests either. Plaid's `payment_channel` is
  `ONLINE / IN_STORE / OTHER` — not a rail. `transaction_code` and
  `payment_meta.payment_method` are captured in memory and have **no schema column**. There
  is nothing to read.
- Modelling a state no provider attests is already a standing prohibition in this
  repository (`docs/plans/V27-INVESTIGATION-PENDING-BALANCE-CURRENT-STATE.md`, doctrine 8).

If a provider later attests a rail, it belongs on the **`TransferRail` axis** — orthogonal,
alongside `PAYMENT_APP` — not as a maturity leaf. Then a movement can honestly be both
"external depository" *and* "over ACH" without either claim contaminating the other.

### 6.4 Two properties these states must have

1. **They are resolved.** Every dashboard, count, and health metric treats them as answers.
   199 legs (33.3%) move out of the failure column on day one.
2. **`EXTERNAL_DEPOSITORY` and `EXTERNAL_VENUE` are product signals, not dead ends.** They
   mean *"the other side exists and you have not connected it."* That is a connect prompt,
   and it is the only place in this design where an unresolved-shaped fact should surface to
   the user as an opportunity. `EXTERNAL_PERSON` and `CASH_MOVEMENT` must never prompt —
   there is nothing to connect.

---

## 7. What the transfer graph legitimately tells us

Chains are dead — §1 and §4 of the investigation settle it. But the graph carries real
truth that is *positional*, not *causal*, and positional facts need no chain inference.

### 7.1 Account roles, derived from edge polarity

| account | out | in | $ out | $ in | role |
|---|---|---|---|---|---|
| checking ••2058 | 342 | 52 | 344,238 | 72,280 | **FUNDING HUB** |
| savings ••9516 | 26 | 40 | 53,497 | 48,500 | conduit / reserve |
| savings ••5336 | 4 | 9 | 6,750 | 13,000 | conduit |
| checking ••0985 | 3 | 4 | 6,500 | 6,750 | conduit |
| debt ••1009 | 0 | 60 | 0 | 129,485 | **SINK** |
| debt ••0202 | 0 | 58 | 0 | 110,107 | **SINK** |

One hub with out-degree 4; every other node has out-degree ≤ 1; density 0.143; one
bidirectional pair. A **star**, not a network.

**This is a first-class product fact.** "Everything is funded from one account" is a
concentration/resilience statement a user would recognise and act on, and it requires no
inference beyond counting edges. It is also an *operational* fact: if that one account's
feed goes stale, the transfer picture for the whole household degrades — which is a
freshness-prioritisation signal the platform does not currently derive.

### 7.2 Cadence and the statement cycle

Day-of-month distribution of transfer legs: **1–10: 169 · 11–20: 155 · 21–31: 274**, with
peaks at the 10th (56) and the 24th–27th (38/46/44/33).

Recurring same-amount series (≥ 4 occurrences, one account, one amount, one direction):

| n | account | dir | amount | median gap |
|---|---|---|---|---|
| 62 | checking ••2058 | OUT | $1,000 | 13 d |
| 37 | savings ••9516 | IN | $1,000 | 15 d |
| 34 | checking ••2058 | OUT | $2,000 | 15 d |
| 20 | debt ••1009 | IN | $2,000 | 18 d |
| 12 | debt ••0202 | IN | $2,000 | 30 d |

This is the same structure viewed twice: **the graph's density is the cause of the matching
difficulty.** A user who moves $1,000 twice a month between two accounts generates 154 rows
that are pairwise indistinguishable. The cadence model does not *resolve* those rows — and
must never be used to, because "the 15th one is probably paired with the 15th one" is
exactly the manufactured certainty this design forbids. Its legitimate uses are:

- **Expectation** — a missing recurring transfer is a detectable event.
- **Projection** — forward cash-flow, which already has a home.
- **Explanation** — "this is a recurring $1,000 savings transfer" is better copy than
  "transfer".
- **Prioritisation** — resolve the hub's feed first.

> ⚠️ **Hard boundary: the graph may inform understanding and never inform resolution.**
> Cadence, role, and topology must not appear anywhere in the matching ladder. The moment a
> "usual destination" prior enters tie-breaking, the authority begins manufacturing
> certainty from habit — and the hub's destination entropy is 1.737 of a maximum 2.000,
> meaning the habit carries almost no information anyway.

---

## 8. The complete matching hierarchy

```
  ADMISSION ─────────── classified · leg-capable · transfer-shaped        598 of 1,023

  E1  PROVIDER-ASSERTED IDENTITY
      1a  native provider transfer id            (none in corpus)     ✅ persist account + leg
      1b  correlation id, validated              132  22.1%           ✅ persist account + leg
      1c  counterparty mask, unambiguous         128  21.4%           ✅ persist account + leg
                    │  each claim REMOVES both legs from every later tier
  E2  STRUCTURAL DETERMINISM
      2a  mutual uniqueness, ±0 days              92  15.4%           ✅ persist account + leg
      2b  mutual uniqueness, ±5 days              34   5.7%           ✅ persist account + leg
      2c  ACCOUNT_CERTAIN_LEG_AMBIGUOUS           10   1.7%           ✅ persist account ONLY
  E3  SCOPING  ── institution token narrows a multi-account set, then re-enter E2
  E4  CLASS
      4a  TYPE_CERTAIN_ACCOUNT_AMBIGUOUS           2   0.3%           ❌ names movement only
      4b  TYPE_AMBIGUOUS                           1   0.2%           ❌
  E5  TERMINAL
      5a  CASH_MOVEMENT                           62  10.4%           ✅ resolved, no account
      5b  EXTERNAL_PERSON                        116  19.4%           ✅ resolved, no account
      5c  EXTERNAL_VENUE                          20   3.3%           ✅ resolved, no account
      5d  EXTERNAL_DEPOSITORY                      1   0.2%           ✅ resolved, no account
      5e  EXTERNAL_UNKNOWN                         0                  ✅ resolved, no account
  E6  UNRESOLVED_TRANSFER                          0                  honest residue
```

### 8.1 Why each transition is valid, and what is gained or lost

| transition | what is gained | what is lost | why the demotion is honest |
|---|---|---|---|
| **E1a → E1b** | nothing | the provider's structural guarantee | The same assertion arrived through an unstructured channel, so it must be validated (§4.4) rather than trusted. |
| **E1b → E1c** | nothing | *bidirectionality*. A correlation id is stamped on **both** legs; a mask names **one** account from **one** side. | The mask must therefore find a unique leg on the named account before it may claim — the id needs no such search. |
| **E1c → E2a** | nothing | **the provider's assertion entirely.** From here the claim is Fourth Meridian's. | Structural uniqueness is an inference about the corpus, not a fact about the movement. It is deterministic but ours. |
| **E2a → E2b** | nothing | **simultaneity.** At ±0 the two rows agree on a date; at ±5 we assume settlement skew. | Justified only by measurement: the head of the gap histogram decays monotonically to ~6 days, then rises again on recurrence. The rise is where we stop. |
| **E2b → E2c** | nothing | **leg identity.** | Everything about *where* survives; only *which row* is lost — and it is lost permanently, not pending more evidence. Persisting the account is therefore not a degraded claim, it is a complete one about a different question. |
| **E2c → E4a** | nothing | **account identity.** | Several accounts qualify. The type still names the movement, so a true claim survives — but no id may be written. This is the existing level and it is correct. |
| **E4a → E4b** | nothing | **the movement's name.** | Candidates span types; nothing beyond "a transfer happened" is supported. |
| **E4 → E5** | **the answer.** | nothing | Not a demotion. A leg reaches E5 by having *no* owned candidates at all — so it never had an account to lose. The rail/form/venue axis then supplies a complete answer. |
| **E5 → E6** | nothing | everything | No owned candidate **and** no attested axis. The only truly honest floor. |

Two structural rules govern the whole ladder:

1. **Every tier may only ABSTAIN, never guess.** A tier that cannot decide passes the leg
   down intact. No tier ever emits a weaker version of its own claim.
2. **A claim removes its legs from all later tiers.** This is the stratification that makes
   E2a outperform an unstratified ±5 pass — and it is the source of the cascade risk in
   §12.3.

The existing vetoes are unchanged and sit **above** everything: the cash veto runs before
any candidate is considered; the own-account liability rules run before destination type;
`legsQualify` remains symmetric; monotonicity and `adoptRetraction` are untouched.

---

## 9. The projected unresolved population

Replayed over the live corpus under the proposed admission and ladder.

| outcome | legs | % | $ | classification |
|---|---|---|---|---|
| provider-linked (E1b + E1c) | **260** | 43.5 | 450,710 | **resolved — provider asserted** |
| account-certain, leg-certain (E2a + E2b) | **126** | 21.1 | 261,970 | **resolved — structural** |
| account-certain, leg-ambiguous (E2c) | **10** | 1.7 | 13,000 | **resolved (account)** |
| type-certain only (E4a) | 2 | 0.3 | 1,500 | movement named, account not |
| type-ambiguous (E4b) | 1 | 0.2 | 1,000 | **unresolved** |
| cash movement | **62** | 10.4 | 24,955 | **resolved — terminal** |
| external person | **116** | 19.4 | 24,986 | **resolved — terminal** |
| external venue | **20** | 3.3 | 12,960 | **resolved — terminal** |
| external depository | **1** | 0.2 | 27 | **resolved — terminal** |
| **genuinely unresolved** | **1** | **0.2** | 1,000 | — |

Summary: **counterparty persistable 396 (66.2%)** · terminal external/cash **199 (33.3%)** ·
unresolved **1**. Against today's 234 persistable and 252 movement-unresolved.

Investment transfers are not a row in this table by design: they are an *outcome of the
destination type*, produced by E1/E2 when the counterparty is an owned investment or crypto
account, and by `EXTERNAL_VENUE` when it is not. Splitting them out would double-count.

### 9.1 "Cannot currently know" vs "no evidence exists"

| | definition | population | trajectory |
|---|---|---|---|
| **No evidence exists — ever** | The counterparty is not an account. There is nothing to find. | `CASH_MOVEMENT` 62 · `EXTERNAL_PERSON` 116 = **178** | Permanent. Correct. Never a metric failure. |
| **No evidence exists — in this corpus** | The other side is real and is not connected. | `EXTERNAL_VENUE` 20 · `EXTERNAL_DEPOSITORY` 1 = **21** | Resolves when the user connects the institution. A **product** action, not an engineering one. |
| **Cannot currently know — permanently indistinguishable** | Two identical movements between the same pair in the same window. | `ACCOUNT_CERTAIN_LEG_AMBIGUOUS` 10 | The account is known. The leg never will be, and does not matter. |
| **Cannot currently know — pending evidence** | Candidates compete; an identifier would settle it. | E4a 2 · E4b 1 = **3** | Resolves if the institution ever exposes an identifier. |

### 9.2 Confidence in these projections

**High** for admission (a deterministic predicate over stored columns) and for the terminal
leaves (they read attested rail/form/venue axes).

**Moderate** for the resolution split, for two reasons stated plainly:

- The `1` unresolved leg is an artifact of a favourable corpus. **The defensible planning
  number is the identifier-disabled floor: 21 unresolved (3.5%) and 26 type-certain-only.**
  Any institution mix poorer than Chase's will sit between the two columns.
- Precision is verified against 132 ground-truth legs from **one user and two
  institutions**. Zero errors over 132 is strong evidence of the *rules'* correctness and
  weak evidence about the *world's* variety.

---

## 10. Generalization

### 10.1 Measured, in this corpus

| institution | transfer rows | correlation id | mask in descriptor | resolved today |
|---|---|---|---|---|
| **Chase** `ins_56` | 524 | 132 (**25%**) | 190 (**36%**) | 294 (56%) |
| **American Express** `ins_10` | 147 | **0 (0%)** | 13 (**9%**) | 60 (41%) |

Two institutions, and they already disagree completely about identifier availability. Amex
descriptors are short (mean 30 chars vs Chase's 49) and semantic — `MOBILE PAYMENT - THANK
YOU`, `Internal Transfer Credit: Savings -5336`.

### 10.2 Expected profiles

| institution | E1 native id | E1 correlation id | E1 mask | dominant rung | risk |
|---|---|---|---|---|---|
| **Chase** | — | ✅ measured | ✅ measured | E1 | none known |
| **American Express** | — | ❌ measured **0%** | ⚠️ 9% | **E2** | the reference case for degradation |
| **Schwab** | — | ⚠️ unknown | ⚠️ `MONEYLINK PPD ID` observed from the *Chase* side | E2 / E5 | the brokerage cash-sweep leg is often **not in the transaction feed at all** — `EXTERNAL_VENUE` is the correct answer, not a failure |
| **Fidelity** | — | unknown | unknown | E2 | same sweep problem |
| **Capital One** | — | unknown | unknown | E2 | assume Amex-like |
| **Wells Fargo** | — | unknown | unknown | E2 | assume Amex-like |
| **Minimal-metadata Plaid institutions** | — | ❌ | ❌ | **E2 + E5** | this is the design case; §3.2's floor is its budget |
| **Credit unions / small banks** | — | ❌ | ❌ | E2 + E5 | expect the Amex profile |
| **Crypto exchanges / on-chain** | — | ❌ | n/a | **E5** | network fees break equal-amount matching; the corpus has 1 amount-altered case, so **do not build a fee tolerance yet** |
| **Future providers** | adapter-declared | adapter-declared | adapter-declared | any | a new adapter, not a new ladder |

### 10.3 Provider-agnostic vs provider-dependent

**Provider-agnostic — the majority of the value:**
admission (a classification-state predicate), stratified matching, the
`ACCOUNT_CERTAIN_LEG_AMBIGUOUS` rung, all terminal external leaves, the two-axis metric,
every veto. Measured worth: **+118 legs of the +162 total (73%)**.

**Provider-dependent — additive, never load-bearing:**
correlation-id extraction (needs a pattern), mask extraction (needs `FinancialAccount.mask`
— populated on 10/10 Plaid accounts here but **0/25 manual and wallet accounts**),
institution scoping (needs a recognisable token). Worth **+44 legs (27%)**.

> ⚠️ **The design rule that follows: no tier below E1 may ever depend on a tier within E1
> having produced anything.** E2 must be correct on an empty E1. §3.2 verifies this by
> measurement, and it should become a standing probe — run the ladder with E1 disabled and
> assert the result is still error-free and monotonically weaker, never different in kind.

### 10.4 The generalization gaps this corpus cannot close

- **Cross-owner transfers.** `legsQualify` pairs only within one `ownerId`. Joint accounts,
  a personal + business Space, or a couple sharing a household will have real transfers that
  cross the boundary and are permanently unresolvable. This corpus has one real owner, so
  the failure mode is **unmeasured**. It is the largest known blind spot.
- **Mask collision.** Within one user: 0.45% at 10 accounts, 1.9% at 20, **4.3% at 30**.
  The rule must abstain on collision; it must never pick.
- **Correlation-id stability across re-syncs.** All 66 groups are internally consistent
  *now*. There is no observation history to prove the id does not change between syncs —
  which is an argument for L1's observation log, and a reason E1b should be re-derived at
  read time before it is ever persisted.
- **Multi-currency.** `legsQualify` requires equal currency and the corpus is entirely USD.
  A genuine cross-currency internal transfer is currently unrepresentable and would need FX
  evidence this design does not propose.

---

## 11. Relationship to L8

**Recommendation: the majority lands BEFORE L8; a well-defined minority lands INSIDE it.**

L8 = *event identity: pending↔posted as one logical event; `removed` distinguishes
withdrawal from transition.* It is the only schema slice, and the roadmap already places it
last for exactly the right reason: every other slice reduces its risk.

### 11.1 Before L8 — read-model only, no schema, independently verifiable

| slice | why it does not need L8 | measured effect |
|---|---|---|
| **Canonical admission** | a predicate over `flowType` / `classifierVersion` / account type | 1,023 → 598 candidates |
| **Two-axis metric** | reporting | 71 finished facts stop being counted as failures |
| **Terminal external leaves** | vocabulary; the rail/form/venue axes are already persisted | **199 legs (33.3%)** become resolved |
| **`ACCOUNT_CERTAIN_LEG_AMBIGUOUS`** | the candidate set is already computed and then discarded | **+75 legs, $103,000** |
| **Stratified matching** | reorders an existing predicate | +68 legs, 0 conflicts, 0 errors |
| **E1 extraction, read-time only** | parses a column that already exists | +60 (id) and +124 (mask) ground-truth-verified legs |
| **Institution scoping** | read-time filter | 28 multi-account sets cut to 1 |

None of these writes anything. All are deployment-only and instantly revertable — the same
property that made L1–L7 safe.

### 11.2 Inside L8 — genuinely blocked on event identity

| capability | why L8 is a hard prerequisite |
|---|---|
| **Persisting `linkKey` as a typed column** | An identifier belongs to the **logical event**, not to a row that L8 will merge. Persisting it on a pending row means writing it twice and reconciling later — building the very duplication L8 exists to remove. |
| **`ProviderAssertedIdentity` with `scope: SELF`** | That *is* L8. `pendingTransactionRef`'s reconciler is L8's subject matter. |
| **Real supersession in `legsQualify`** | `TransferLeg.superseded` is a **required** field that nothing currently computes — every audit and the read boundary pass `false` for every row. Correct supersession is L8. Until then, a pending leg and its posted successor can both qualify, and the mutual-uniqueness veto correctly refuses both. |
| **Persisting a counterparty against a pending leg** | Without event identity the posted successor arrives as a new row and the persisted pointer dangles. |

### 11.3 After L8

Re-deriving the whole ladder once event identity exists, and *then* deciding what to
persist. A resolution computed against pre-L8 supersession is a resolution against a corpus
that will change shape.

### 11.4 The architectural justification

Three reasons, in order of weight:

1. **The pre-L8 work makes L8 safer, not merely earlier.** Correct admission and terminal
   leaves shrink the population L8's backfill must reason about by 42%, and the two-axis
   metric gives L8 a truthful before/after measurement it does not have today.
2. **Everything before L8 is read-model and reversible.** Each slice is provable against the
   132-leg ground truth in isolation. That is the discipline that made the historical and
   pricing arcs safe, and it applies unchanged.
3. **Everything inside L8 is about *identity*, not about *matching*.** The split is not
   pragmatic sequencing; it is a clean seam. Ask of any capability: *does it need to know
   that two rows are the same event?* If yes, it is L8's. If it only needs to know that two
   rows are opposite sides of one movement, it is the transfer authority's, and it can ship
   now.

---

## 12. Tradeoffs, risks, and what could go wrong

### 12.1 Tradeoffs accepted

| we accept | to gain | why it is worth it |
|---|---|---|
| Persisting an account without a leg (E2c) | +75 legs, $103,000 | Every consumer asks *which account*. The leg is unknowable and unused. |
| Parsing an unstructured column | +260 legs of deterministic evidence | Validated per claim (§4.4); measured at 0 errors; falls through to E2 on any failure. |
| Tier ordering / cascade dependency | E2 performance after E1 removes competitors | Mitigated by §12.3. |
| A larger terminal vocabulary | 199 legs stop being false failures | The vocabulary already exists in `TransferDisposition`; this converges two vocabularies rather than inventing one. |
| More states for the UI to render | truthfulness | §5.4 collapses the presentation: only the *reason* line differs. |

### 12.2 Tradeoffs refused

Global/greedy matching (7–8 measured errors). Window widening (the histogram rises past
14 days — it manufactures cross-month pairs). Persisted probabilities. Chain inference.
Subset-sum / partial forwarding. Institution *names* as a resolver. Cadence or topology
priors in tie-breaking. Relaxing the Plaid deny-list. A `TransferChain` table.

### 12.3 Risks, ranked

| # | risk | severity | mitigation |
|---|---|---|---|
| **R1** | **Cascade error.** One wrong E1 claim removes two legs and causes a downstream E2 mis-pairing that would not otherwise occur. | **High** | Validate every E1 group against all eight §4.4 conditions and discard the whole group on any failure. Standing probe: an E1 claim must never contradict an independently-derived `ACCOUNT_CERTAIN`. Ship E1 **last** (§13), after E2 is proven, so any regression is attributable. |
| **R2** | **Regex fragility.** A descriptor format changes; extraction silently stops or, worse, starts matching the wrong token. | **High** | Extractors are versioned per institution (the `plaid-transfer/2` pattern already established). Monitor extraction *rate* per institution as an operational metric — a drop to zero is a provider change, not a quiet degradation. Cardinality-2 validation makes a wrong match almost always self-refuting. |
| **R3** | **Cross-owner blindness.** Joint accounts and business Spaces are unmeasured. | **High** | Do not change the ownership boundary in this arc. Measure it first on production data. Flag as the largest known gap. |
| **R4** | **The projection is one user, two institutions.** | **Medium** | Plan against the identifier-disabled floor (§3.2), not the headline. Instrument per-institution resolution rate from the first slice. |
| **R5** | **Admission removes something real.** A legitimate transfer that happens to be unclassified stops being a candidate. | **Medium** | It becomes a **classification backlog** item and is reported, never silently dropped. The metric must show both numbers. |
| **R6** | **Mask collision.** 4.3% at 30 accounts. | **Medium** | Abstain on collision, never pick. Standing probe on the abstention. |
| **R7** | **Correlation id unstable across syncs.** | **Medium** | Derive at read time; do not persist until L8 and an observation log can prove stability. |
| **R8** | **`EXTERNAL_*` becomes a dumping ground** — a real internal transfer mislabelled external because its leg was missing at the time. | **Medium** | These states are derived at read time and re-derived on every sync, so a late-arriving leg promotes them. The states must be *derived*, never *stamped*. |
| **R9** | **A mask or id leaks into user-visible copy** via `classificationReason`. | **Low but sharp** | §4.6 constraint 3. A source-scan probe, in the shape `read-boundary-authority.test.ts` already uses — and, per that file's recorded trap, checked against **raw** source, not `logic()`-stripped source. |

---

## 13. Rollout strategy and phased plan

Sequenced so that every phase is independently provable, measurable against the 132-leg
ground truth, and reversible. **Riskiest evidence ships last, not first** — the inverse of
the intuitive order, and deliberate: E2's improvements must be attributable before E1's
removals start changing E2's inputs.

### Phase 0 — Measurement (no behaviour change)

Two-axis reporting; per-institution resolution rate; the classification backlog surfaced as
its own number. **Establishes the denominator before anything claims to improve it.**
Nothing else in the plan is interpretable without this.

### Phase 1 — Admission

Canonical candidate definition. 1,023 → 598. Purely a predicate.
*Proof:* every excluded row falls into exactly one named exclusion class; no row silently
disappears; the backlog count and the candidate count sum to the old number.

### Phase 2 — Terminal external states

199 legs (33.3%) become resolved. Converges `TransferMaturity` onto the vocabulary
`TransferDisposition` already has.
*Proof:* zero rows change *counterparty*; only their *name* changes. A row that had an
account keeps it.

### Phase 3 — `ACCOUNT_CERTAIN_LEG_AMBIGUOUS`

+75 legs, $103,000. Read-time only; nothing persisted yet.
*Proof:* every promoted leg's candidate set has exactly one distinct `accountId`; the
account agrees with the correlation-id ground truth wherever both exist.

### Phase 4 — Stratified matching

+68 legs. Reordering only.
*Proof:* **zero conflicts with the current authority** — the strongest single guarantee in
the plan, and already measured. Any conflict fails the phase.

### Phase 5 — E1 extraction, read-time, behind a per-institution switch

Correlation ids and masks. Per institution, off by default, enabled after that
institution's extraction rate and precision are observed.
*Proof:* 0 contradictions with Phase 4's output; 100% agreement on the ground-truth set;
every group satisfies all eight validation conditions.

### Phase 6 — Institution scoping

28 candidate sets narrowed. Filter only; can never name an account alone.
*Proof:* it only ever *removes* candidates — the post-scoping candidate set is a strict
subset of the pre-scoping set, asserted by test.

### Phase 7 — Persistence (**requires L8**)

Persist `counterpartyAccountId` for E1/E2a/E2b/E2c. Persist `linkKey` as a typed,
SYSTEM-only, opaque column. Real supersession.
*Proof:* the historical arc's proven shape — read-only audit, apply only what it reports,
prove a zero-write second pass.

### 13.1 Rollout discipline

- **Every phase is read-model until Phase 7.** Deployment-only, instantly revertable.
- **Every phase re-runs the 132-leg ground-truth comparison.** Non-zero errors block.
- **Every phase reports the identifier-disabled floor alongside the headline**, so
  provider-dependence never becomes invisible.
- **No phase may reduce the count at any higher rung.** Monotonicity applies to the ladder
  as a whole, not only to individual rows.
- **Local repair does not imply production repair.** The institution mix determines
  everything in §10; production must be measured, not assumed.

---

## 14. What I could not determine

- **Whether `transaction#:` is stable across Plaid re-syncs.** No observation history
  exists. Direct argument for L1's log, and the reason E1b stays read-time until L8.
- **Whether any institution other than Chase emits a correlation id.** Two institutions;
  one does, one does not. A production sample across many `institutionId`s must size Phase 5
  before it is committed to.
- **Whether the ACH trace `000320046315336` reliably ends in the receiver's mask.** Four
  rows. Worth reading directly; far too thin to encode.
- **Cross-owner transfer behaviour.** Structurally forbidden today, entirely unmeasured.
- **Whether brokerage cash-sweep legs ever appear in a transaction feed.** If they never
  do, `EXTERNAL_VENUE` is permanently correct for them rather than a waiting room.

---

## 15. Database safety

Read-only throughout. One additional projection script, every query a `SELECT` /
`findMany`; no `create`, `update`, `delete`, `upsert` or `executeRaw` call in any
investigation or projection script. Counts before and after are identical: `Transaction`
4,447 total / 4,402 active, `FinancialAccount` 35. No schema change, no migration, no
repair, no regeneration, no commit. Scripts removed after the measurements were recorded.
