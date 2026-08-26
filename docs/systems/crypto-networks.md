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

**The adapter boundary**

4. **Chain-specific mechanics stay in adapters** — address formats, base units, RPC behaviour, transaction encodings, finality, pagination.
5. **Canonical financial meaning never lives in an adapter.** A provider says "I saw this"; only the engine says "this means that". An adapter that emits a `flowType` has already broken this.
6. **A provider's DTO never crosses the adapter boundary.** A vendor's parsed interpretation of "what a swap is" may be an accelerator, never the truth shape, and must be re-derived against raw chain evidence before it is trusted.

**Arithmetic**

7. **Base-unit arithmetic is exact at acquisition.** Integers in, integers through reconciliation, one conversion at the canonical boundary. Reconciliation in base units needs no tolerance at all.
8. **Tolerances are properties of the asset.** One satoshi is not one lamport is not one wei.

**Time and evidence**

9. **A current balance is an observation, not historical evidence.** It states what is true now and nothing about any other date.
10. **Never paint today's quantity backward through time.** Historical quantity requires movements plus a defensible anchor plus licensed coverage.
11. **Absence never becomes zero.** Uncovered time carries a coded reason and no value.
12. **Missing provider history is not an empty history.** An unconfigured or unreachable archive means unknown, not nothing.
13. **Missing price is not zero value.** An unpriced position is held, counted and unvalued.
14. **Spot price is not historical price.** Historical valuation reads the dated archive, never a live quote.
15. **A successful provider response is not a complete event stream.** Completeness is a claim that must be licensed by evidence — an address index that may omit indirectly-referenced transactions cannot license it, and arithmetic reconciliation against an independent balance can.

**Meaning**

16. **A chain transaction is not automatically a sale, spend or income event.** The chain proves quantity left custody. Where it went economically settles somewhere the chain cannot see.
17. **Exchange-looking addresses are hints, not financial facts.** Address labels never silently become semantics.
18. **User-attested semantics are explicitly distinguished from observed facts**, carry an author, and are never blended into evidence.

**Representation**

19. **A refused, unavailable, unknown or failed acquisition state must never be represented to a consumer as active synchronization or completed evidence.** In-progress requires POSITIVE evidence that work is outstanding — a resumable checkpoint, a running job — never the mere absence of a success or of a recorded error. An account existing, an identity existing, an address count above zero, a chain being set, and a sync not having succeeded yet are all compatible with nothing running at all.
20. **A refusal must reach the authority the consumer reads.** Recording it somewhere else — an incident log, a return value, a server log — leaves that authority silent, and silence is what gets misread as progress.
21. **Never offer a retry that cannot succeed.** Where a failure is terminal until something outside the surface changes, say so instead of presenting an action that will fail identically.

**Providers**

22. **A provider's capability must be DECLARED, not assumed.** A hardcoded public endpoint is a dependency the system cannot see, cannot monitor and did not choose; a configured one is a dependency it can. Where a chain still relies on an undeclared public service, that is a debt with an exit condition, never a pattern to copy.
23. **Provider consolidation is an operational preference, never an epistemic one.** Preferring one vendor across chains buys one credential and one bill. It buys no capability: each chain and each evidence class is still earned separately, and a vendor's convenient interpreted endpoint never becomes the truth model just because it is already paid for.
24. **A reconciliation licenses coverage up to the OBSERVATION it closed against, not to the last movement seen.** A quiet wallet's newest movement may be months before the balance that reconciles to it; bounding the licence at the movement leaves the gap unknown and reconstructs nothing. A movement inside that gap would have broken the arithmetic, so the arithmetic closing is the proof the gap is empty. This strengthens a claim on evidence, and it remains an upgrade only.

**Capability**

25. **`CURRENT_POSITION_SUPPORTED` does not imply `HISTORY_SUPPORTED`.** They are different promises.
26. **`HISTORY_SUPPORTED` does not imply NET-WORTH PARTICIPATION.** A chain may hold a fully reconstructed, reconciled quantity timeline on the position spine and still be invisible to a net-worth path that composes from a legacy balance column. Gate each on the property that actually decides it, never on the other.
27. **A network is promoted to `HISTORY_SUPPORTED` only after its historical acquisition, replay, coverage/refusal and dated-valuation acceptance tests pass — on a real wallet, not a fixture.** Having an adapter is not having history, and neither is having a provider.

---

## Current capability state

| Network | State | Notes |
|---|---|---|
| Bitcoin | `HISTORY_SUPPORTED` | Movement ledger in `Transaction` (transitional); constant-quantity carry, not replay. |
| Ethereum | `CURRENT_POSITION_SUPPORTED` | Native balance only. Historical acquisition needs an address index plus internal value transfers — no standard JSON-RPC method provides either. |
| Solana | **`HISTORY_SUPPORTED`** | Acquisition, zero-residual reconciliation, replay and dated valuation proven on a real wallet. Net-worth participation still **withheld** (writes no balance column). |
| Everything else | `UNSUPPORTED` | Custody recordable; chain unreadable. |

---

## Transitional architecture, with stated exit conditions

Two things below are known to be wrong-shaped and are carried deliberately. Both have a written exit.

**Chain movements in `Transaction`.** `Transaction.merchant` and `.category` are NOT NULL, so writing a chain movement into that model *requires* inventing a merchant name and an income/spend category for an event that has neither. Bitcoin does this today. **Exit:** a dedicated canonical crypto-movement table with integer base units and chain event identity; Bitcoin's movements migrate onto it and no chain movement carries a fabricated merchant again. Until then, a new chain's reconstruction persists its *result* (positions) rather than its movements, so it fabricates nothing.

**`FinancialAccount.balance` as a crypto value authority.** Bitcoin writes a USD figure computed from an undated sync-time spot quote, and net worth composes from that column. **Exit:** the wallet net-worth convergence, which moves net worth onto the dated position spine and gives `SpaceSnapshot` a way to express *withheld* rather than a `NOT NULL DEFAULT 0` zero. New chains do not write the column at all.
