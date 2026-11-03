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

33. **Historical value is quantity evidence × a dated price, never a carried sync-time value.** A balance read today is one number about one moment; multiplying it by an old close does not make it an old holding, it makes a plausible-looking figure for a quantity nobody established. The sequence is not negotiable and is the same for every asset: evidence of what was held, a licence that the evidence speaks for the date, then the price of that date.

34. **Absence of an observed movement is not proof of constant quantity unless coverage licenses the interval.** "We found no transaction in this window" and "no transaction occurred in this window" are different claims, and only the second licenses a carry. The first becomes the second only when something guarantees a movement would have been seen — an exhaustive scan, or arithmetic that closes against an independent balance and leaves no room for an unseen one.

35. **A provider's current-balance basis cannot silently become a historical anchor.** Where a figure's confirmed/unconfirmed basis is undocumented, anchoring a reconstruction on it imports that ambiguity into every date the replay produces. The answer is to establish the quantity independently — movements that reconcile exactly leave nothing for the ambiguity to hide in — or to refuse. Lowering the standard to keep a descriptor type supported is how an unproven number acquires a provenance it never earned.

36. **Legacy ingest fields may remain provenance without remaining read authority.** A column a provider path writes can go on being written, and stop being what any canonical read consults. Separating the two is what makes retiring an authority possible at all: the alternative is a migration that must delete storage and move every consumer in one step. What must never persist is the reverse — a field no longer written that consumers still read.

37. **What a writer WROTE and what a reader may TRUST are different facts, and one field cannot record both.** A predicate named for a write, consulted to decide a read, is correct only while the two coincide — and it fails silently on the first asset where they come apart. Bitcoin is that asset: it still writes its balance column because the historical materiality signal is the only thing that can answer "did this wallet ever hold anything", and no canonical surface reads it any more. Both statements are true, so both are recorded.

38. **An index that cannot represent a movement class will report its absence as zero, and no amount of care in the caller can detect that from the response alone.** A vendor transfer API with no withdrawal category returns an empty list for an address earning only withdrawals — a well-formed, successful, entirely wrong answer. Verify a candidate source against an INDEPENDENT observation of the same quantity before trusting its completeness, and prefer a source that observes the RESULT of a change over one that enumerates causes: the result cannot omit a category it has no name for.

39. **A proof of emptiness is stronger than a reconciliation, and where one is available it should be preferred.** Reconciliation says a missed set summing to exactly zero is not a coincidence we entertain; a proof says the omission was impossible. Where an account's own state (code, nonce, balance) makes a debit impossible without a visible trace of itself, an empty interval is deduced rather than licensed — and the cancelling-omission hazard that reconciliation dismisses probabilistically simply does not arise.

40. **A float cannot hold a base-unit quantity at every magnitude, and an anchor that round-trips through one is not the chain's number.** At 8 decimals the whole of Bitcoin's supply survives a float round-trip; at 18 decimals Ethereum's does not, and the error grows with magnitude. An anchor reconstructed by scaling a stored float therefore differs from the chain's by an amount that itself scales — and a missed movement equal to that error reconciles spuriously. Read base units from the source and never round-trip them. For the same reason a fixed absolute tolerance is the wrong shape for a high-decimal asset: the tolerance must scale with the magnitude it is judging.

41. **A canonical financial authority is not converged until every consumer capable of making the same claim reads it.** Moving the surfaces that matter most is the start of a convergence, not the end of one: the readers left behind keep answering, and now they disagree. Two values for one holding is worse than the old wrong value alone, because neither surface can be trusted without knowing which code path produced it. Enumerate the consumers structurally — by who can produce the claim, not by who was remembered — and converge them together or record precisely which remain and why.

42. **AI context is a financial consumer, and model-visible figures do not receive a weaker authority than product surfaces.** A number placed into a prompt will be quoted as fact, with none of the qualification a screen can carry and no way for the reader to tell which subsystem produced it. An assembler must therefore consume an already-authoritative value and decide no financial semantics of its own — not which asset, not legacy versus canonical, not fresh versus stale, not which price. When the screen and the model disagree, the model is the surface that will be believed.

**Providers**

43. **A provider's capability must be DECLARED, not assumed.** A hardcoded public endpoint is a dependency the system cannot see, cannot monitor and did not choose; a configured one is a dependency it can. Where a chain still relies on an undeclared public service, that is a debt with an exit condition, never a pattern to copy.
44. **Provider consolidation is an operational preference, never an epistemic one.** Preferring one vendor across chains buys one credential and one bill. It buys no capability: each chain and each evidence class is still earned separately, and a vendor's convenient interpreted endpoint never becomes the truth model just because it is already paid for.
45. **A reconciliation licenses coverage up to the OBSERVATION it closed against, not to the last movement seen.** A quiet wallet's newest movement may be months before the balance that reconciles to it; bounding the licence at the movement leaves the gap unknown and reconstructs nothing. A movement inside that gap would have broken the arithmetic, so the arithmetic closing is the proof the gap is empty. This strengthens a claim on evidence, and it remains an upgrade only.

**Capability**

46. **Historical capability is not complete until canonical historical evidence reaches the consumer that makes the historical financial claim.** Acquisition, reconstruction and valuation succeeding in isolation is not the same as a chart being right. If a consumer still paints a current quantity backward, or omits an earned historical position, `HISTORY_SUPPORTED` is not operationally complete for that consumer — however clean the adapter is. The chain is: acquisition → reconstruction → valuation → **consumer**.
47. **PRODUCT support, CURRENT-POSITION support and HISTORY support are three independent questions.** Which chains a user may add is a product decision; whether a balance can be read and whether a history can be reconstructed are each earned by evidence. A chain is routinely offerable while both capabilities are withheld, and offering it must never be read as claiming either.
48. **`CURRENT_POSITION_SUPPORTED` does not imply `HISTORY_SUPPORTED`.** They are different promises.

49. **Current-position evidence licenses a point observation only. It does not license historical carry.** Reading a balance today proves one thing about one date. It is not a smaller version of history, and promoting a chain to `CURRENT_POSITION_SUPPORTED` grants no permission to place that quantity on any earlier date — not by carrying it backward, not by treating the account's creation as its start, not by letting a historical consumer fall back to the current balance when the spine has no row. Before an asset's first observation the correct historical answer is *unknown*, which contributes nothing and claims nothing. This is the rule that makes it safe to turn a chain's balance reading on long before its history is earned: the two capabilities cannot leak into each other.
50. **`HISTORY_SUPPORTED` does not imply NET-WORTH PARTICIPATION.** A chain may hold a fully reconstructed, reconciled quantity timeline on the position spine and still be invisible to a net-worth path that composes from a legacy balance column. Gate each on the property that actually decides it, never on the other.
51. **A network is promoted to `HISTORY_SUPPORTED` only after its historical acquisition, replay, coverage/refusal and dated-valuation acceptance tests pass — on a real wallet, not a fixture.** Having an adapter is not having history, and neither is having a provider.

---

## Current capability state

| Network | State | Notes |
|---|---|---|
| Bitcoin | `HISTORY_SUPPORTED` | Movement ledger in `Transaction` (transitional shape). **W6c** retired the constant-quantity carry: history is replayed from POSTED native movements against an OBSERVED anchor, reconciled at zero satoshi and bounded by a persisted `COMPLETE` coverage licence. **W6d** moved its CURRENT value onto the same spine, valued through the canonical dated close. The adapter still WRITES `balance`/`nativeBalance` — the historical materiality signal reads the latter — but no canonical surface reads either. |
| Ethereum | **`HISTORY_SUPPORTED`** | Native balance via the shared EVM adapter; history reconstructed from STATE READS ALONE — no `trace_*` (tier-refused), no transfer index (measured empirically incomplete). The licence is a deduction, not a reconciliation: `code == "0x" ∧ nonce(a) == nonce(b) ∧ balance(a) == balance(b)` proves the interval empty, because an EOA cannot be debited by anyone but itself. Real-wallet acceptance: COMPLETE 2017-10-16..2026-08-27, zero caveats, 16 movements reconciling at **zero wei**, 3238 replayed days. **Plain EOAs only** — a contract wallet (Safe, ERC-4337) or a live EIP-7702 delegation refuses `PROOF_PREMISES_UNMET` and gains no history. Dated pricing is bounded by the vendor's rolling 365-day window; earlier days are NO_PRICE, never zero. |
| Solana | **`HISTORY_SUPPORTED`** | Acquisition, zero-residual reconciliation, replay and dated valuation proven on a real wallet. Writes no balance column; current and historical value both come from the spine. |
| BNB Chain | `CURRENT_POSITION_SUPPORTED` | Native BNB via the shared EVM adapter; real balance acquired at exact wei. No history. |
| Avalanche C-Chain | `CURRENT_POSITION_SUPPORTED` | Native AVAX via the same adapter. No history. |
| Polygon | `UNSUPPORTED` (offerable) | **Stopped on an unresolved pricing identity, not on engineering.** Chain identity, asset identity and the adapter are all in place and the balance reads correctly; the price feed carries two coins for this asset (`matic-network`, `polygon-ecosystem-token`) whose quotes diverge materially. Choosing one arbitrarily would price a real holding wrongly, so the chain is not registered for sync and MATIC/POL is deliberately absent from the price mapping. Recordable only. |
| Everything else | `UNSUPPORTED` | Custody recordable where offered; chain unreadable. |

**Product surface** (which chains a user may add) is a separate, narrower list — see `lib/crypto/product-chains.ts`. Removing a chain from it hides an option; it deletes no canonical machinery and makes no claim about capability.

---

## History acquisition, token history and valuation coverage (as built)

This section records how the doctrine above is realised today for the networks that hold history. Every claim carries a status marker: **IMPLEMENTED** (with the code path or PR that proves it), **DECIDED BUT NOT IMPLEMENTED**, **PROPOSED**, or **DEPRECATED**. Which environments have the workers switched on is release state and lives in [`/STATUS.md`](../../STATUS.md), not here.

### The autonomous history worker

**IMPLEMENTED** — `jobs/sol-history-backfill.ts` (the job keeps its original name; it now carries every chain). Pure decisions live in `lib/crypto/sol-backfill-worker.core.ts`, `lib/crypto/btc-backfill-worker.core.ts`, `lib/crypto/eth-history-backfill.core.ts` and `lib/crypto/history-worker-schedule.core.ts`.

- **One writer.** The `JobRun` claim guarantees one instance; each wallet is processed under its own sync lock, and checkpoints are compare-and-swapped (`Connection.historyCheckpoint`, migration `20261028120000_connection_history_checkpoint`). **IMPLEMENTED.**
- **Fair.** Wallets that have never started go first, then least-recently-progressed; each wallet gets at most a per-wallet wall-clock budget per run, so one backlog cannot starve another. Chains with work run in a rotating order (the leader changes every run) and each phase gets a fair share of what is left, so every chain with eligible work starts a step within three runs. **IMPLEMENTED** (`orderCandidates`, `history-worker-schedule.core.ts`).
- **Bounded.** A whole-job wall clock, a per-wallet budget, a global request rate (one token bucket per run) and a **durable daily request cap** read from the shared provider ledger (`ApiUsageCounter`). A bad env value falls back to the default, never to "unlimited". **IMPLEMENTED** (`workerConfig`).
- **Shared provider budgets.** Solana and Ethereum spend the same Alchemy key and therefore the same daily cap (`SOL_BACKFILL_DAILY_REQUEST_CAP`); Bitcoin uses keyless Esplora with its own cap (`BTC_BACKFILL_DAILY_REQUEST_CAP`). Current token-holding capture defaults to the same Alchemy cap. **IMPLEMENTED** (`jobs/sol-history-backfill.ts`, `lib/crypto/wallet-token-capture.ts`, `lib/platform/wallet-history-recovery.core.ts`).
- **Off by default, per chain.** All flags are strict opt-ins read from the environment:

  | Work | Runs when | Source |
  |---|---|---|
  | Solana native history | `SOL_BACKFILL_ENABLED=true` | `sol-backfill-worker.core.ts` |
  | Bitcoin history | the SOL flag is on **and** `BTC_BACKFILL_ENABLED` is not `false` | `btc-history-backfill.ts` |
  | Ethereum full rebuild handed to the worker | SOL flag **and** `ETH_BACKFILL_ENABLED=true` (otherwise syncs rebuild inline) | `eth-history-backfill.core.ts` |
  | SPL / Token-2022 history | `SPL_HISTORY_ENABLED=true` | `spl-history.store.ts` |
  | ERC-20 history | SOL **and** ETH flags **and** `ERC20_HISTORY_ENABLED=true` | `erc20-history.core.ts` |

  Snapshot growth additionally needs `WEALTH_REGENERATION_ENABLED` (the snapshot regeneration switch, not a history worker). **IMPLEMENTED.**
- **Completion is the backfill's own verdict** — beginning reached, head verified, continuity proven — never "the job succeeded". **IMPLEMENTED.**
- **Job outcome vs job status.** A price run that stops short (`BUDGET_STOPPED`, `ALLOWANCE_EXHAUSTED`, `TOKEN_LIMIT`, `STEP_FAILED`, for SPL and ERC-20 alike) sets `JobRun.summary.outcome = "PARTIAL"` with one `partialReasons` entry per stop; `JobRun.status` stays `succeeded`, because a budget stop is not a failure. A run refused by the platform (for example the billable gate) records `outcome: "SKIPPED"` with a `skipReason`. The summary carries counts and meters only — no ids, addresses or balances. **IMPLEMENTED** (`solBackfillJobOutcome`, `lib/jobs/health.ts`). Showing PARTIAL runs as "completed with limits" in the Platform Ops Jobs view is **PROPOSED** (handed to the Platform Ops owner; not built).
- **Cadence.** Operator-tunable between 1 and 24 hours (`job_cadence_hours_sol-history-backfill`). **IMPLEMENTED** (`lib/jobs/cadence-policy.test.ts` pins it).
- **Operator recovery.** Platform Ops → Providers → Fleet diagnostics → Connections → History recovery → **Resume history** runs one bounded pass for a wallet. It is refused when the chain's worker flag is off, when the shared daily cap is exhausted, or when the import is not in an eligible state; it never deletes rows, licences or checkpoints, and it records the audit action `WALLET_HISTORY_RESUMED`. **IMPLEMENTED** (PR #116, path after PR #135; `app/api/platform/platform-ops/connections/[id]/history-resume/route.ts`, `components/platform/widgets/WalletHistoryRecoveryPanel.tsx`).
- **Rollback.** Unset the flags: workers stop at the next wake and checkpoints persist, so re-enabling resumes rather than restarts (except where noted for SPL below). The checkpoint migration is additive. **IMPLEMENTED** (behaviour of the flag gates above).

### Per-chain acquisition and completeness

| Chain | Acquisition | Completeness | Status |
|---|---|---|---|
| Bitcoin | Resumable backfill (`lib/crypto/btc-history-backfill.ts`), keyless Esplora, own token bucket and cap. | Replayed from posted native movements against an observed anchor, reconciled at zero satoshi, bounded by a persisted `COMPLETE` licence (see the capability table above). | **IMPLEMENTED** |
| Solana (native) | Resumable signature walk via Alchemy (`lib/crypto/sol-history-backfill*.ts`). | Zero-residual reconciliation; the backfill reports COMPLETE only when beginning, head and continuity are proven. | **IMPLEMENTED** |
| Ethereum (native) | State-read proof walk (`lib/crypto/eth-history.ts`), bounded probe budget per step, resumes at the proof's boundary; rows are written once, when the whole proof closes and reconciles. | Deductive interval licence (`code == "0x" ∧ nonce and balance unchanged`). | **IMPLEMENTED** |
| Ethereum — early origin | At a proven boundary B the remainder `[lo, B]` is closed in one step when the address is proven **key-derived** by a receipt it signed (K), the state at B is empty (G), and one extra probe shows `lo` unchanged from B (P). The key proof is bound to this address, the Ethereum network and the writer's normalisation. Receive-only and counterfactual smart-wallet addresses fall back to the full walk. | Same licence as the walk; the shortcut only saves probes. | **IMPLEMENTED** (PR #126, PR #143; `acquireEthHistory`, `originProvenAtBlock` diagnostic) |
| Ethereum — fast path | An index (`alchemy_getAssetTransfers`) only decides *where* to probe; every movement is still built from state deltas and every interval is still closed by the same deductive predicate, so a wrong or incomplete index costs probes, never truth. On by default; `ETH_HISTORY_FAST_PATH=false` restores the plain walk. | Unchanged. | **IMPLEMENTED** (PR #178; `ethFastPathEnabled`) |
| SPL / Token-2022 | Token-account history staged per account inside the Solana worker (`lib/crypto/spl-history*.ts`). | Per mint: COMPLETE, PARTIAL, PENDING or UNSUPPORTED with a reason. | **IMPLEMENTED** (PR #120, flag-gated) |
| ERC-20 | Token history pass inside the worker (`lib/crypto/erc20-history*.ts`). | Per token, same vocabulary. | **IMPLEMENTED** (PR #122, flag-gated) |

**Known limits that stay** (all **IMPLEMENTED** as described, i.e. these are current behaviour, not plans):

- **SPL staging caps.** An account keeps at most its newest 750 staged days (`MAX_DAYS_PER_ACCOUNT`), proven from the first kept day; the mint then reads PARTIAL and older days are not recoverable. A mint whose accounts together need more than 6,000 staged days (`MAX_STAGED_DAYS_TOTAL`) stays PENDING and is never shown complete.
- **SPL flag toggles.** Any off→on toggle of token history forces a full re-walk, which costs requests.
- **SPL licence withdrawal fails closed.** If a later account cannot prove it held zero of a frozen mint, the whole licence is withdrawn — this can remove rows that were correct.
- **Spam-farmed Solana wallets.** A full discovery queue resets the token walk, so a spam-farmed wallet's first backfill can spend its small token request allowance (low severity).
- **ETH endpoint-only pruning.** The walk's pruning test compares interval endpoints only, so a counterfactual CREATE2 address funded and swept inside one transaction could be missed while coverage reads COMPLETE. Rare, low severity, predates the early origin; tracked as a defect, no fix designed.

### Valuation coverage: one model for native assets, ERC-20 and SPL

**DECIDED** (owner ruling, 2026-10-30) and **IMPLEMENTED** (PR #122, with SPL sharing the same code; stored-row re-stamping in `7a09f55` inside #122; clear-stamp in PR #183).

1. **Three facts, tracked separately.**
   - *Balance-history completeness* ignores prices: a missing price never makes a balance import incomplete. **IMPLEMENTED** — `walletHistoryComplete` (`lib/crypto/wallet-instrument-history.ts`); the Connections "limited" history state is driven by balances only.
   - *Price coverage* is per token, from `RAW_CLOSE` rows only; an `INTRADAY` quote never extends historical coverage. **IMPLEMENTED** — `ReconstructedTokenFacts.closesToISO` (`lib/crypto/token-valuation.core.ts`).
   - *Valuation / chart coverage* is decided per day. **IMPLEMENTED** — see the day rule.
2. **Day rule.** A day's crypto component is valued only if every held, non-excluded token has a price dated that day or the day before (one earlier price never covers later days). Otherwise the day's crypto component is refused or stamped `unavailable` — never $0, and never decided by what the wallet holds today. Native assets follow the same rule: a wallet emptied today with an unpriced past holding is refused rather than written as $0. **IMPLEMENTED** — `tokenDayMissingRequiredPrice` / `cryptoTokenDayDecision` (`lib/crypto/token-valuation.core.ts`) consumed by `regenerateDay` (`lib/snapshots/regenerate-history.ts`).
3. **Stored rows are re-stamped.** One pure per-day persistence decision stamps a changed verdict onto an existing *estimated* row even when no value changes, lets a row earn `supported` back when its prices arrive, and clears a stale stamp when a real recompute finds no material crypto. Frozen (observed) rows and days with no stored row are never stamped. **IMPLEMENTED** — `planDayPersistence` (`lib/snapshots/regeneration-candidates.core.ts`).
4. **Per-token coverage states** (`ReconstructedTokenValuation`): `VALUED`; `VALUED_WITH_GAPS` (interior held days no close serves — those days are unavailable); `VALUED_UNTIL_EARLIER` (closes stop inside the held period); `VALUED_FROM_LATER` (closes start inside the held period); `NO_MARKET` (vendor says unlisted or thin — a legitimate unpriced holding, disclosed and limiting); `NOT_VALUED_YET` (no held day priced for any other reason); `EXCLUDED`; `NEVER_HELD` (zero balance throughout — not a holding, ignored). Every state except `VALUED`, `EXCLUDED` and `NEVER_HELD` limits valuation and is disclosed. **IMPLEMENTED** — `reconstructedTokenValuation`; Connections copy in `lib/connections/valuation-coverage*.ts`.
5. **Disclosure copy** follows the ruling: "Balance history verified through [date]" · "Valuation available from [date]" · "Older holdings exist but lack historical prices". Charts start at the earliest date with both balance and price coverage; interior unpriced days are partial or unavailable. **IMPLEMENTED** (`lib/connections/valuation-coverage.core.ts`, `lib/connections/connection-detail.core.ts`). Never permitted: $0 for an unknown price, silent omission, an earlier price used as coverage for later dates, or complete valuation inferred from balance completeness alone.
6. **"No market price" is not spam.** A verified non-zero holding without a price makes its dates partial or unavailable. A held token is excluded **only** on an explicit classification with a source recorded on its alias (`metadata.exclusion = { kind: SPAM | NON_ECONOMIC | EXCLUDED, source, atISO }`); excluded tokens stay visible and are counted separately. **IMPLEMENTED** as a reader (`tokenValuationExclusion`). **No writer exists**, so today no held token is ever excluded and spam-farmed wallets show honest but noisy "partial" valuation. Which sources may write a classification (operator decision with a reason, curated list, or vendor spam flag) is an open **owner decision**; the first writer must also restrict the accepted `source` values — **DECIDED BUT NOT IMPLEMENTED**.
7. **Stale token quantity.** A token whose latest quantity observation is stale contributes nothing and does not block the day. Existing behaviour; it does not arise inside verified token history, which writes a row for every held day. **IMPLEMENTED.**

### First-time quote probes for sold tokens

**IMPLEMENTED** — `lib/crypto/token-history-probe.ts` (chain-neutral, PR #144), used by `lib/crypto/erc20-history-prices.ts` (PR #122) and `lib/crypto/spl-history-prices.ts` (PR #144).

A token that was held but never quoted (typically sold before capture began) gets one first-time quote through the current-quote path, so its historical closes can be fetched.

- Durable per-UTC-day cap per chain: `ERC20_HISTORY_PROBE_DAILY_CAP` / `SPL_HISTORY_PROBE_DAILY_CAP` (default 20, clamped 0–1,000), counted in `ApiUsageCounter` under `ERC20_HISTORY` / `SPL_HISTORY`, metric `coingecko-probe`, unit `attempts`.
- A held-token reserve: probes leave a fraction of the CoinGecko token share untouched for held-token quotes and history closes (`*_HISTORY_PROBE_HELD_RESERVE`, default 0.5, 0–1).
- A token is re-asked at most every 7 days (`TOKEN_PROBE_RETRY_MS`). Never-held tokens are skipped. An unreadable usage ledger means **no** probe (unknown ⇒ allowance 0). Thin or unlisted tokens become `NO_MARKET`, never excluded.
- A swallowed price-step failure reports `STEP_FAILED`, which makes the job outcome PARTIAL.

Known limits (current behaviour): the allowance read and the attempt record are not atomic, so concurrent runs can overshoot a cap by the number of runs in flight; the SPL and ERC-20 reserves are separate settings, and setting either to 0 lets that chain's probes spend into the held-quote share; closes fetched right after a probe bypass the reserve (small, bounded by the cap); expect a steady trickle of SPL probes, because wallets close spam token accounts to reclaim rent, which makes those mints genuinely held.

### Wallet refresh: price-archive maintenance and per-facet freshness

These rules came out of the 2026-10-01 crypto refresh incident (evidence: see `docs/archive/evidence/incidents/`). The operator tool for older price gaps is the [crypto refresh repair runbook](../operations/runbooks/crypto-refresh-repair.md).

- **Price-archive maintenance is a prerequisite of valuation, not a consequence of it.** Current crypto valuation reads `RAW_CLOSE` closes with a 7-day walk-back. The close authority repairs its own archive on a miss and re-reads, and the scheduled crypto sweep maintains every held asset's closes **before** it touches any wallet — so a failed valuation can no longer close the gate on its own repair (the "latch"). **IMPLEMENTED** — CRYPTO-LATCH-1 in `lib/crypto/crypto-close-coverage.ts`, `lib/crypto/btc-sync.ts`, `jobs/sync-crypto.ts`.
- **Revaluation is declared, not inferred.** Whether a wallet sync revalued is declared by the chain registry's valuation model, so a chain without a valuation field cannot accidentally read as revalued. **IMPLEMENTED** — CRYPTO-LATCH-2 in `lib/crypto/wallet-sync-dispatch*.ts`.
- **Each freshness facet reads its own authority.** Current position (newest `PositionObservation`), transaction history (`Connection.transactionsSyncedAt`), derived history (`Connection.historyRebuiltAt`) and balance read (`Connection.lastSyncedAt`) are separate clocks. `null` means never successfully established and renders as silence; no facet falls back to another's clock. The two columns were added with no backfill on purpose: inventing a success date would be the dishonesty the repair removed. **IMPLEMENTED** — CRYPTO-FRESHNESS-1, migration `20261001120000_connection_facet_freshness`, `lib/connections/intelligence.ts`, `lib/connections/space-data.ts`, `components/connections/ConnectionCard.tsx`.
- **Quote and history stages run concurrently.** The intraday quote and the history reconstruction share nothing; both are gated on the sync's success exactly as before and neither can change it, so they run in parallel instead of in series. **IMPLEMENTED** — CRYPTO-PARALLEL-1 in `lib/crypto/wallet-sync-dispatch.ts`.
- **Failure copy leads with the user message**, keeping the provider's own text as the reason. **IMPLEMENTED** — CRYPTO-COPY-1 in `components/dashboard/SyncWalletButton.tsx`, `lib/crypto/wallet-sync-dispatch.ts`.
- **Timeouts and retries were deliberately left unchanged** by the repair. **IMPLEMENTED** (no change).

### Production activation (release procedure)

**DECIDED** (closeout, 2026-10-30); execution is release state owned by Session 1 and recorded in STATUS.md.

1. Apply `20261028120000_connection_history_checkpoint` (additive) before the code that reads it is promoted, through the guarded migration procedure ([database-safety.md](../operations/database-safety.md)).
2. Enable workers one at a time with explicit daily caps and a soak window between each: `SOL_BACKFILL_ENABLED` → `BTC_BACKFILL_ENABLED` → `ETH_BACKFILL_ENABLED` → `SPL_HISTORY_ENABLED` / `ERC20_HISTORY_ENABLED`. `WEALTH_REGENERATION_ENABLED` must be on for snapshot growth.
3. Provider terms are owner decisions: the Alchemy plan must cover the shared SOL+ETH daily cap, and CoinGecko's tier (history depth, attribution and storage terms) must be confirmed or upgraded.
4. Rollback: unset the flags (workers stop at the next wake, checkpoints persist), then redeploy the previous deployment if needed; the migration stays.

### Open follow-ups

All **PROPOSED** (not designed or not built):

- **Merge-aware membership guard.** A duplicate-merge loser's link is treated as "left the Space", so earlier days stay blocked; after a merge the loser's history lives on the winner, so those days could be regenerated. Needs the amendment system or a merge-aware guard. Today's behaviour fails closed (never wrong, can shorten the backfill). See [historical-data.md](./historical-data.md#regeneration-membership-guard).
- **Platform Ops "completed with limits"** display for PARTIAL history-worker runs.
- **Token exclusion writer** with an owner-approved source allow-list (item 6 above).
- **SPL deferred items:** stale rows for sibling mints after a rebuild; the recovery pass runs without the discovery hook; a checkpoint version bump orphans token state; checkpoint size (roughly 0.6–0.8 MB).
- **Test gaps:** the regeneration call-site wiring is pinned by an exact source match rather than a behavioural run; the SPL store adapter dropping `status` is untested at the database adapter.
- **ETH endpoint-only pruning gap** (above).

---

## Transitional architecture, with stated exit conditions

Two things below are known to be wrong-shaped and are carried deliberately. Both have a written exit.

**Chain movements in `Transaction`.** `Transaction.merchant` and `.category` are NOT NULL, so writing a chain movement into that model *requires* inventing a merchant name and an income/spend category for an event that has neither. Bitcoin does this today. **Exit:** a dedicated canonical crypto-movement table with integer base units and chain event identity; Bitcoin's movements migrate onto it and no chain movement carries a fabricated merchant again. Until then, a new chain's reconstruction persists its *result* (positions) rather than its movements, so it fabricates nothing.

**`FinancialAccount.balance` as a crypto value authority.** Bitcoin writes a USD figure computed from an undated sync-time spot quote, and net worth composes from that column. **Exit:** the wallet net-worth convergence, which moves net worth onto the dated position spine and gives `SpaceSnapshot` a way to express *withheld* rather than a `NOT NULL DEFAULT 0` zero. New chains do not write the column at all.
