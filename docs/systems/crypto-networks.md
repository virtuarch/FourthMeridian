# Doctrine — Crypto Networks

*Governs how ANY blockchain network becomes a supported asset in Fourth Meridian: identity, acquisition, position, pricing, history, how a failure is represented, and the boundary between what a chain proves and what a person asserts. Origin: the P2-6 crypto position spine, the V26 multi-network architecture investigation, and the W-M0 → W-M2 native-wallet arc.*

Bitcoin, Ethereum and Solana are the networks implemented today, and they appear below **only as examples**. Nothing in this document is per-chain doctrine. It governs Cardano, XRP, Dogecoin, Litecoin, Avalanche, Polkadot and every network after them, and the test of a new adapter is whether it can satisfy this contract without changing anything canonical.

**See also:** [investments.md](./investments.md) (the shared position spine and valuation), [historical-data.md](./historical-data.md) (observed vs. derived vs. estimated), [money-and-fx.md](./money-and-fx.md) (a crypto asset is priced, not converted), and the source investigation in [`plans/v2.6-INVESTIGATION-MULTI-NETWORK-CRYPTO-ARCHITECTURE.md`](../plans/v2.6-INVESTIGATION-MULTI-NETWORK-CRYPTO-ARCHITECTURE.md).

---

## The shape of the whole thing

```
CHAIN ADAPTER            chain-specific, isolated, replaceable
   ↓
canonical asset identity      assetKey (CAIP-19)
   ↓
canonical movement            ChainMovement + ChainCoverage
   ↓
PositionObservation           the ONE position spine
   ↓
dated PriceObservation        the ONE price archive
   ↓
valuation                     quantity × dated close
   ↓
financial consumers           holdings · export · AI · net worth
```

**Inside the adapter:** address formats, base units, RPC and provider behaviour, transaction encodings, pagination, finality models, chain quirks.

**Outside the adapter, and never inside it:** asset identity, positions, historical reconstruction, valuation, refusal semantics, and every question about what a movement *means* financially.

Adding a native network is a new adapter plus registrations. It is never a new portfolio architecture.

---

## CANONICAL CRYPTO ASSET LIFECYCLE

Ten stages, in this order. A network occupies exactly one point on this path, and skipping a stage is not permitted — each one is the evidence the next one consumes.

### 1 · Canonical identity

Establish the network and the asset before writing a single balance.

- Identity is **`assetKey`**, a CAIP-19 asset identifier naming the chain and then the asset on it (`bip122:<genesis>/slip44:0`, `eip155:1/slip44:60`, `solana:<genesis>/slip44:501`). The chain reference is a truncated genesis hash — a fact about the network, not a name anyone assigned.
- The ticker is **display and denomination only**. It is `Instrument.tickerSymbol`, which the schema documents as *"Display / weak identity — never the canonical primary key"* and deliberately does not make unique.
- One canonical `Instrument` per asset, keyed by an `InstrumentAlias(provider="crypto", externalId=assetKey)`. The alias `@@unique([provider, externalId])` is what makes a second identity for one asset structurally impossible.
- Legacy ticker-based adoption of a pre-existing `Instrument` is permitted **only** for a closed, historical grandfather set. It is never opened for a new asset.

### 2 · Current acquisition

The adapter reads the native balance in **integer base units** — satoshis, wei, lamports.

- Base units stay integers through parsing, validation and reconciliation. Conversion to a whole-unit float happens exactly once, at the canonical boundary, because `PositionObservation.quantity` is a `Float`.
- Where the wire format is a JSON number rather than a string (Solana's u64 lamports), the raw response **text** is parsed, because `JSON.parse` rounds beyond 2^53 before any code of ours runs.
- Provider choice is configuration. A deployment with no endpoint is **dark**: it says so and acquires nothing.

### 3 · Canonical current position

The balance is written through the shared position writer as a `PositionObservation` — quantity only, no institution price, no invented cost basis, a zero balance recorded as an explicit `quantity: 0` closure row.

There is **no chain-specific portfolio read model**. Holdings, export and the AI context read the same seam for a wallet as for a brokerage account.

### 4 · Dated pricing

Register the canonical asset with the shared price architecture: provider mapping, capability routing, the insert-only price archive. Both current and historical valuation read **licensed dated evidence** from that one archive.

No chain gets a private path to the price archive. The last time one did, it became a second acquisition pipeline that bypassed the registry entirely.

### 5 · Route activation

Expose the adapter through the chain capability registry. Capability is explicit and graded:

| State | Promise |
|---|---|
| `UNSUPPORTED` | Custody may be **recorded**; the chain cannot be read. |
| `CURRENT_POSITION_SUPPORTED` | A canonical current position, valued at the dated close. No movement history. |
| `HISTORY_SUPPORTED` | All of the above, plus acquired movements, reconciliation, and reconstructed historical quantity. |

Recording custody and being able to read a chain are **different capabilities**. A user may record a wallet on a network this system cannot read, and the honest answer is "we cannot read it" — never a balance of zero.

### 6 · Historical movement acquisition

Acquire actual chain evidence: explicit pagination, explicit finality, explicit provenance, explicit coverage.

- Ingest at the chain's **finalized** commitment. A balance that can still be rolled back is not a balance.
- A run is **bounded and resumable**. Stopping early is recorded, never hidden.
- The adapter emits `ChainMovement[]` — signed integer base-unit deltas with chain event identity — and `ChainCoverage`. It emits no financial classification of any kind.

### 7 · Historical quantity reconstruction

Convert movements into canonical `NormalizedQuantityEvent`s and replay them through the **one** quantity engine (`replayQuantityTimeline`).

- Reconstruction requires **chain movements plus a defensible anchor plus licensed coverage**. Any one missing means the interval is refused.
- Backward reconstruction is permitted only where it is **mathematically forced** — inverting an affine map from a later observed anchor across a licensed event stream.
- A replay may never anchor on its own output. `DERIVED` rows are excluded from anchoring, or a reconstruction would compound its own error invisibly.
- Results enter the spine as `PositionObservation(origin: DERIVED)`, delete-and-replace scoped to that origin and source. `OBSERVED` rows are never touched, and origin precedence (`OBSERVED > IMPORTED > DERIVED > USER_ASSERTED`) means derived history can never outrank an observation on a shared date.

### 8 · Historical valuation

Replayed quantity on a date × the canonical price licensed for **that** date.

Missing quantity evidence stays missing. Missing price evidence stays missing. Neither becomes zero, and neither is substituted from the other's neighbours beyond the archive's own stated walk-back.

### 9 · Financial consumers / net-worth convergence

Consumers read the canonical position and valuation authorities.

**No new chain may introduce a parallel `FinancialAccount.balance` valuation authority.** Where a legacy chain still writes that column, it is transitional and carries a recorded migration condition; a new chain's value lives on the dated position spine and nowhere else. Until net-worth convergence lands, a new chain's net-worth participation is explicitly **withheld** — stated in the sync result and documented at the write site, never faked by writing a spot value into a scalar column.

### 10 · Higher-level semantics

Sale, income, spending, swap, exchange deposit, gift — none of these is derivable from a raw chain movement. They require evidence beyond the chain, and where that evidence is a person's statement it is recorded as **`USER_ASSERTED`**, with an author and a timestamp, and is never blended into observed fact.

---

## Doctrine invariants

These are binding. Each one exists because violating it produced, or would produce, a confident wrong number.

**Identity**

1. **Asset identity is not ticker identity.** A ticker is chosen by whoever mints the asset, is not unique, and for tokens is attacker-controlled. Anyone can deploy a token called `SOL`.
2. **Adding a native network requires a new adapter and registrations — not a new portfolio architecture.** If a chain needs canonical changes, the canonical model is wrong, not the chain.
3. **Tokens may require additional identity and schema machinery**, but must ultimately feed the same position, replay and valuation spine. There is no second portfolio for tokens.

4. **Network identity, asset identity and display symbol are three separate authorities, and one of them changing does not move the other two.** A chain's identity is where it runs (`eip155:137`). An asset's identity is what it is (`slip44:966` — the native coin of that chain). A display symbol is what humans currently call it, and it is the only one of the three anybody may rename. When Polygon's ticker went MATIC → POL, none of that was a new chain and none of it was a new economic asset: the same coin on the same network acquired a new name. Migrating the asset key to chase a ticker would have manufactured a second identity for one holding, split its price history and double-counted it. So the key stays, the symbol moves, and the product's chain code — which is a *chain* identifier — is allowed to differ from the symbol it now displays.

**The adapter boundary**

5. **Chain-specific mechanics stay in adapters** — address formats, base units, RPC behaviour, transaction encodings, finality, pagination.
6. **Canonical financial meaning never lives in an adapter.** A provider says "I saw this"; only the engine says "this means that". An adapter that emits a `flowType` has already broken this.
7. **A provider's DTO never crosses the adapter boundary.** A vendor's parsed interpretation of "what a swap is" may be an accelerator, never the truth shape, and must be re-derived against raw chain evidence before it is trusted.

**Arithmetic**

8. **Base-unit arithmetic is exact at acquisition.** Integers in, integers through reconciliation, one conversion at the canonical boundary. Reconciliation in base units needs no tolerance at all.
9. **Tolerances are properties of the asset.** One satoshi is not one lamport is not one wei.

**Time and evidence**

10. **A current balance is an observation, not historical evidence.** It states what is true now and nothing about any other date.
11. **Never paint today's quantity backward through time.** Historical quantity requires movements plus a defensible anchor plus licensed coverage.
12. **Absence never becomes zero.** Uncovered time carries a coded reason and no value.
13. **Missing provider history is not an empty history.** An unconfigured or unreachable archive means unknown, not nothing.
14. **Missing price is not zero value.** An unpriced position is held, counted and unvalued.
15. **Spot price is not historical price.** Historical valuation reads the dated archive, never a live quote.
16. **A successful provider response is not a complete event stream.** Completeness is a claim that must be licensed by evidence — an address index that may omit indirectly-referenced transactions cannot license it, and arithmetic reconciliation against an independent balance can.

**Meaning**

17. **A chain transaction is not automatically a sale, spend or income event.** The chain proves quantity left custody. Where it went economically settles somewhere the chain cannot see.
18. **Exchange-looking addresses are hints, not financial facts.** Address labels never silently become semantics.
19. **User-attested semantics are explicitly distinguished from observed facts**, carry an author, and are never blended into evidence.

**Representation**

20. **A refused, unavailable, unknown or failed acquisition state must never be represented to a consumer as active synchronization or completed evidence.** In-progress requires POSITIVE evidence that work is outstanding — a resumable checkpoint, a running job — never the mere absence of a success or of a recorded error. An account existing, an identity existing, an address count above zero, a chain being set, and a sync not having succeeded yet are all compatible with nothing running at all.
21. **A refusal must reach the authority the consumer reads.** Recording it somewhere else — an incident log, a return value, a server log — leaves that authority silent, and silence is what gets misread as progress.
22. **Never offer a retry that cannot succeed.** Where a failure is terminal until something outside the surface changes, say so instead of presenting an action that will fail identically.

23. **A WITHHELD value must never be published as zero, and a column that cannot express withheld must not be the authority for one.** `FinancialAccount.balance` is `NOT NULL DEFAULT 0`. Every chain since W-M1c deliberately declines to write it — the correct call, since it holds an undated sync-time figure — so the column answered *withheld* with the number `0`, and the account read path published that as money: a Solana wallet holding a provider-confirmed 0.751600602 SOL rendered `$0.00` on every account surface while the Investments workspace, reading the position spine, valued it correctly. Two chains of custody for one number, disagreeing, with the wrong one in front of the user. Where an authority cannot represent absence, the consumer must source the fact from one that can, and the shape it reads must carry the DISTINCTION — valued, held-but-unpriceable and never-observed are three different answers, and only the first is a number. This is invariants 11 and 13 arriving at the presentation layer, where getting it wrong costs the most.

24. **An unknown historical quantity is not a zero, and must not be filtered out as if it were one.** The two arrive at the same place — an account contributing nothing to a day's total — by opposite routes: one because it is evidenced to have held nothing, the other because no evidence reaches the date at all. A quantity resolver that answers `null` and a consumer that reads `quantity ?? 0` will silently agree that they are the same fact. They are not, and the day that results asserts a total with a material constituent missing from it.

25. **A numeric aggregate must not imply completeness when a material constituent is unknown.** Dropping the unknown component and publishing the sum of the rest is the most dangerous available answer, because it is indistinguishable from a correct one. Where an aggregate cannot be completed it must be refused — not annotated, not partially stated, not substituted with the known subtotal under the total's name. A subtotal presented where a total is expected is a wrong number with a footnote.

26. **A historical consumer must read the evidence authority appropriate to the asset; legacy storage is not a universal fallback.** `FinancialAccount.balance` and `.nativeBalance` are one asset class's authority, not a default for every asset that lacks one. Falling back to them for an asset they were never written for does not produce a worse estimate — it produces a fabricated one, and because those columns are `NOT NULL DEFAULT 0` the fabrication is always the specific value that means "nothing here".

27. **Consumer completeness is part of evidence correctness.** Acquisition, reconstruction and valuation being right is not the same as the answer being right. A refusal that reaches no consumer is a refusal that did not happen, and a consumer that requires a number will invent one unless the contract it reads can express absence. Whether the surface can SAY "unknown" is therefore a property of the evidence chain, not a presentation detail downstream of it.

28. **Observation existence and coverage authority are independent facts, and a row is not a licence.** That a dated observation exists says what was seen; it does not say which dates that reading may speak for. Where an implementation happens to write one row per licensed day the two look equivalent, and code written against that coincidence silently encodes the representation as the rule — refusing dates inside its own proven coverage when the representation is sparse, and licensing dates outside it whenever a stray row lands there. The licence must be recorded as its own fact and consulted as one.

29. **Forward carry requires an explicit temporal licence.** Carrying a quantity from its evidence date to a later date is a claim that nothing changed in between, and that claim needs a source: a proven interval, or an arithmetic reconciliation that closes over it. "No contradicting record was found" is not such a source — absence of a movement is only evidence of absence where something guaranteed a movement would have been seen.

30. **A current observation has a freshness horizon, and last-known is not a synonym for current.** A reading confirms the provider's answer at the moment it was taken; how long that answer may be presented as the present state is a separate, explicit decision. A surface that shows a week-old reading as today's balance is not imprecise, it is wrong about a different question than the one it answered. Last-known remains valuable and must be shown as last-known.

31. **Zero requires the same freshness and evidence authority as any other quantity.** It is the easiest value to arrive at by accident and the most consequential to state: "this wallet holds nothing" and "this wallet was drained" are material claims. A stale confirmed zero is a stale reading, not a fresh confirmation of an empty wallet, and every rule that would gate a non-zero figure gates zero identically.

32. **Current evidence does not extend historical coverage, and historical coverage does not prove current freshness.** They answer different questions — what was held then, and what is held now — and neither authority may be derived from the other. That the same quantity appears in both is a coincidence of a quiet wallet, never a reason to let one stand in for the other.

**Providers**

33. **A provider's capability must be DECLARED, not assumed.** A hardcoded public endpoint is a dependency the system cannot see, cannot monitor and did not choose; a configured one is a dependency it can. Where a chain still relies on an undeclared public service, that is a debt with an exit condition, never a pattern to copy.
34. **Provider consolidation is an operational preference, never an epistemic one.** Preferring one vendor across chains buys one credential and one bill. It buys no capability: each chain and each evidence class is still earned separately, and a vendor's convenient interpreted endpoint never becomes the truth model just because it is already paid for.
35. **A reconciliation licenses coverage up to the OBSERVATION it closed against, not to the last movement seen.** A quiet wallet's newest movement may be months before the balance that reconciles to it; bounding the licence at the movement leaves the gap unknown and reconstructs nothing. A movement inside that gap would have broken the arithmetic, so the arithmetic closing is the proof the gap is empty. This strengthens a claim on evidence, and it remains an upgrade only.

**Capability**

36. **Historical capability is not complete until canonical historical evidence reaches the consumer that makes the historical financial claim.** Acquisition, reconstruction and valuation succeeding in isolation is not the same as a chart being right. If a consumer still paints a current quantity backward, or omits an earned historical position, `HISTORY_SUPPORTED` is not operationally complete for that consumer — however clean the adapter is. The chain is: acquisition → reconstruction → valuation → **consumer**.
37. **PRODUCT support, CURRENT-POSITION support and HISTORY support are three independent questions.** Which chains a user may add is a product decision; whether a balance can be read and whether a history can be reconstructed are each earned by evidence. A chain is routinely offerable while both capabilities are withheld, and offering it must never be read as claiming either.
38. **`CURRENT_POSITION_SUPPORTED` does not imply `HISTORY_SUPPORTED`.** They are different promises.

39. **Current-position evidence licenses a point observation only. It does not license historical carry.** Reading a balance today proves one thing about one date. It is not a smaller version of history, and promoting a chain to `CURRENT_POSITION_SUPPORTED` grants no permission to place that quantity on any earlier date — not by carrying it backward, not by treating the account's creation as its start, not by letting a historical consumer fall back to the current balance when the spine has no row. Before an asset's first observation the correct historical answer is *unknown*, which contributes nothing and claims nothing. This is the rule that makes it safe to turn a chain's balance reading on long before its history is earned: the two capabilities cannot leak into each other.
40. **`HISTORY_SUPPORTED` does not imply NET-WORTH PARTICIPATION.** A chain may hold a fully reconstructed, reconciled quantity timeline on the position spine and still be invisible to a net-worth path that composes from a legacy balance column. Gate each on the property that actually decides it, never on the other.
41. **A network is promoted to `HISTORY_SUPPORTED` only after its historical acquisition, replay, coverage/refusal and dated-valuation acceptance tests pass — on a real wallet, not a fixture.** Having an adapter is not having history, and neither is having a provider.

---

## Current capability state

| Network | State | Notes |
|---|---|---|
| Bitcoin | `HISTORY_SUPPORTED` | Movement ledger in `Transaction` (transitional); constant-quantity carry, not replay. |
| Ethereum | `CURRENT_POSITION_SUPPORTED` | Native balance only, via the shared EVM adapter. Historical acquisition needs an address index plus internal value transfers — no standard JSON-RPC method provides either. |
| Solana | **`HISTORY_SUPPORTED`** | Acquisition, zero-residual reconciliation, replay and dated valuation proven on a real wallet. Net-worth participation still **withheld** (writes no balance column). |
| BNB Chain | `CURRENT_POSITION_SUPPORTED` | Native BNB via the shared EVM adapter; real balance acquired at exact wei. No history. |
| Avalanche C-Chain | `CURRENT_POSITION_SUPPORTED` | Native AVAX via the same adapter. No history. |
| Polygon | `UNSUPPORTED` (offerable) | **Stopped on an unresolved pricing identity, not on engineering.** Chain identity, asset identity and the adapter are all in place and the balance reads correctly; the price feed carries two coins for this asset (`matic-network`, `polygon-ecosystem-token`) whose quotes diverge materially. Choosing one arbitrarily would price a real holding wrongly, so the chain is not registered for sync and MATIC/POL is deliberately absent from the price mapping. Recordable only. |
| Everything else | `UNSUPPORTED` | Custody recordable where offered; chain unreadable. |

**Product surface** (which chains a user may add) is a separate, narrower list — see `lib/crypto/product-chains.ts`. Removing a chain from it hides an option; it deletes no canonical machinery and makes no claim about capability.

---

## Transitional architecture, with stated exit conditions

Two things below are known to be wrong-shaped and are carried deliberately. Both have a written exit.

**Chain movements in `Transaction`.** `Transaction.merchant` and `.category` are NOT NULL, so writing a chain movement into that model *requires* inventing a merchant name and an income/spend category for an event that has neither. Bitcoin does this today. **Exit:** a dedicated canonical crypto-movement table with integer base units and chain event identity; Bitcoin's movements migrate onto it and no chain movement carries a fabricated merchant again. Until then, a new chain's reconstruction persists its *result* (positions) rather than its movements, so it fabricates nothing.

**`FinancialAccount.balance` as a crypto value authority.** Bitcoin writes a USD figure computed from an undated sync-time spot quote, and net worth composes from that column. **Exit:** the wallet net-worth convergence, which moves net worth onto the dated position spine and gives `SpaceSnapshot` a way to express *withheld* rather than a `NOT NULL DEFAULT 0` zero. New chains do not write the column at all.
