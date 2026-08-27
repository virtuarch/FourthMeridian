/**
 * lib/crypto/chain-movement.ts
 *
 * W-M2 — THE CANONICAL, CHAIN-AGNOSTIC SHAPE OF AN ON-CHAIN MOVEMENT.
 *
 * Pure: no Prisma, no DB, no clock, no network, no chain.
 *
 * Every native-chain historical adapter emits `ChainMovement[]` plus a
 * `ChainCoverage`, and nothing else. This module is the seam where chain
 * mechanics stop and canonical financial reasoning begins, and it is deliberately
 * narrow: it converts observations into the shape `replayQuantityTimeline`
 * already consumes, and it reconciles integers. It decides no financial meaning.
 *
 * ── A MOVEMENT IS AN OBSERVATION, NEVER A CONCLUSION ─────────────────────────
 * `ChainMovement` carries no `flowType`, no `category`, no `merchant`, no
 * counterparty TYPE, and no notion of income, spending or sale. The prior
 * architecture investigation found the Bitcoin provider layer emitting
 * `flowType: "INCOME"` — a financial classification made by a parser — and named
 * it as the defect to avoid when a second chain arrived. This is the avoidance.
 *
 * A provider says "I saw this". Only the engine says "this means that".
 *
 * ── BASE UNITS ARE INTEGERS, AND STAY INTEGERS ───────────────────────────────
 * `baseUnitsDelta` is a BigInt: satoshis, wei, lamports. Reconciliation happens
 * in base units, so it is EXACT — no tolerance, no epsilon, no float drift. The
 * single conversion to a whole-unit float happens at
 * `movementsToQuantityEvents`, because `PositionObservation.quantity` is a Float
 * and the replay engine takes numbers. That boundary is stated once, here, so
 * every future chain crosses it in the same place.
 *
 * ── COVERAGE IS A FIRST-CLASS ANSWER ─────────────────────────────────────────
 * "The provider returned 200" is not "I saw everything". `ChainCoverage` is
 * structurally identical to the replay engine's `EventStreamCompleteness` so it
 * feeds it without a translation layer, and it adds CAVEATS — the coded reasons
 * an adapter cannot claim completeness. An adapter that cannot prove it saw
 * everything must say PARTIAL, and PARTIAL with an open boundary licenses
 * nothing.
 */

import type {
  EventStreamCompleteness,
} from "@/lib/investments/quantity-replay.core";
import type {
  NormalizedQuantityEvent,
} from "@/lib/investments/quantity-event.core";
import { BLOCKING_CAVEATS } from "./position-coverage";

// ── Coverage ─────────────────────────────────────────────────────────────────

/**
 * Why an adapter cannot claim it saw everything. Coded, so a consumer can act on
 * the difference between "retry later" and "this tier will never serve it".
 */
export type ChainCoverageCaveat =
  /**
   * THE SOLANA ADDRESS-LOOKUP-TABLE HAZARD, and the reason this type exists.
   *
   * `getSignaturesForAddress` indexes only accounts present in a transaction's
   * STATIC `accountKeys`. Accounts loaded through an Address Lookup Table appear
   * in `meta.loadedAddresses` instead, and such transactions are NOT returned
   * for that address (solana-labs/solana#35484). Since ALTs are ubiquitous in
   * DEX/aggregator routing, a signature scan is not PROVABLY complete — and the
   * transaction most likely to be missed is precisely the one a user cares about.
   *
   * This is a protocol-level indexing property, not a provider choice, so no
   * vendor can remove it. It is generic rather than Solana-named because the
   * class — "the address index may not list every transaction that touched this
   * address" — recurs on any chain with indirect account references.
   */
  | "ADDRESS_INDEX_INCOMPLETE"
  /** The run hit its own bounded work budget. Resumable; not a provider fault. */
  | "PAGE_BUDGET_EXHAUSTED"
  /** The window predates what this endpoint retains (non-archival, or tier floor). */
  | "ARCHIVE_DEPTH_LIMIT"
  /** Rate-limited. Retryable. */
  | "PROVIDER_THROTTLED"
  /** Transport / non-2xx / RPC error member. Retryable. */
  | "PROVIDER_ERROR"
  /** A response that parsed but could not be trusted. NOT retryable as-is. */
  | "INVALID_DATA"
  /** No endpoint configured for this chain on this deployment. */
  | "NO_PROVIDER_CONFIGURED"
  /**
   * ETH-H1 — the acquisition's PREMISES do not hold for this account, so its
   * proof does not apply. Distinct from INVALID_DATA in the way that matters:
   * the provider answered correctly and the data was fine; the account is simply
   * not the kind of thing the argument is about.
   *
   * Ethereum's state-difference reconstruction is the motivating case. It rests
   * on an EOA being undebitable by anyone but itself, which is false for a
   * contract wallet (Safe, ERC-4337) and for an EOA carrying a live EIP-7702
   * delegation. Reporting that as bad data would send someone to retry a request
   * that will keep succeeding.
   */
  | "PROOF_PREMISES_UNMET";

export type ChainCoverage =
  | { kind: "COMPLETE"; fromISO: string; toISO: string; source: string }
  | {
      kind: "PARTIAL";
      coveredFromISO: string | null;
      coveredToISO:   string | null;
      caveats:        readonly ChainCoverageCaveat[];
      source:         string;
    }
  | { kind: "UNKNOWN"; caveats: readonly ChainCoverageCaveat[]; source: string };

/** Human-readable, deterministic, name-free. Used in refusal reasons. */
export function describeCoverage(c: ChainCoverage): string {
  if (c.kind === "COMPLETE") return `Complete movement history for ${c.fromISO}..${c.toISO} (${c.source}).`;
  const caveats = c.caveats.length > 0 ? c.caveats.join(", ") : "no reason recorded";
  if (c.kind === "PARTIAL") {
    const bounds = c.coveredFromISO && c.coveredToISO ? `${c.coveredFromISO}..${c.coveredToISO}` : "unbounded";
    return `Partial movement history (${bounds}) from ${c.source} — ${caveats}.`;
  }
  return `No movement history acquired from ${c.source} — ${caveats}.`;
}

/**
 * Bridge to the replay engine's own completeness vocabulary.
 *
 * The shapes are deliberately parallel, so this is a rename rather than an
 * interpretation. The one thing it must not do is round UP: a PARTIAL coverage
 * with an open boundary becomes a PARTIAL stream with an open boundary, which
 * `licensedCoverage` already refuses to turn into an interval claim.
 */
export function toEventStreamCompleteness(c: ChainCoverage): EventStreamCompleteness {
  if (c.kind === "COMPLETE") return { kind: "COMPLETE", fromISO: c.fromISO, toISO: c.toISO, source: c.source };
  if (c.kind === "PARTIAL") {
    return {
      kind: "PARTIAL",
      coveredFromISO: c.coveredFromISO,
      coveredToISO:   c.coveredToISO,
      reason:         describeCoverage(c),
    };
  }
  return { kind: "UNKNOWN", reason: describeCoverage(c) };
}

// ── Movements ────────────────────────────────────────────────────────────────

/**
 * What part a movement played MECHANICALLY. This is a fact about the chain, not
 * a financial classification: a fee is a fee because the protocol charged it, a
 * reserve deposit is one because the protocol required it. Nothing here says
 * income, spending, sale or swap.
 */
export type ChainMovementRole =
  /** A value transfer in or out of an owned account. */
  | "TRANSFER"
  /** Protocol fee, charged whether or not the transaction succeeded. */
  | "FEE"
  /**
   * A balance change the PROTOCOL requires in order to keep an account alive:
   * Solana's rent-exempt deposit and its reclamation, an XRP account reserve, a
   * Cardano min-ADA UTXO floor. Named for what it is across chains rather than
   * for one chain's word for it — this type is canonical, and a canonical type
   * that speaks Solana would be the leak this whole layer exists to prevent.
   *
   * It is a real quantity change and must reconcile like any other. It is not an
   * economic transfer and must never be counted as spending.
   */
  | "PROTOCOL_RESERVE"
  /** Protocol reward (staking, inflation). Present for completeness; unused in W-M2. */
  | "REWARD";

/** How well the movement's instant is known. */
export type ChainTimeBasis =
  /** A real block/ledger timestamp the chain states. */
  | "BLOCK_TIME"
  /** An estimate the chain labels as such (Solana's blockTime is validator-estimated). */
  | "VALIDATOR_ESTIMATE"
  /** No instant available — day precision only. */
  | "DATE_ONLY";

/**
 * ONE signed base-unit change to ONE owned account, for ONE asset, in ONE
 * chain event. The atom.
 *
 * A single event may produce several of these (a transfer plus its fee; a
 * multi-asset program interaction). They share `eventId`, which is the chain's
 * own content-addressed identity — a Solana signature, a Bitcoin txid, an
 * Ethereum transaction hash — so an event's parts can always be reassembled
 * without a synthesised group key.
 */
export interface ChainMovement {
  /** CAIP-2 network reference, from the asset descriptor. */
  networkId:       string;
  /** Content-addressed chain identity: signature / txid / txHash. */
  eventId:         string;
  /** Distinguishes several movements sharing one eventId. Stable, not chronological. */
  movementKey:     string;
  /** CAIP-19 identity of the asset that moved. Never a ticker. */
  assetKey:        string;
  /** The owned address this delta belongs to. */
  ownedAddress:    string;
  /** SIGNED base units. Inflow positive, outflow and fees negative. EXACT. */
  baseUnitsDelta:  bigint;
  role:            ChainMovementRole;
  /** ISO instant when the chain says this happened. Null ⇒ date-only. */
  occurredAtISO:   string | null;
  /** The calendar date (UTC) the movement belongs to. Always present. */
  dateISO:         string;
  timeBasis:       ChainTimeBasis;
  /** Did the chain event FAIL? A failed event still charges its fee. */
  failed:          boolean;
  /**
   * Raw counterparty addresses the chain stated, if any. ADDRESSES ONLY — no
   * names, no labels, no entity resolution. A label is a hint; this is evidence.
   */
  counterparties:  readonly string[];
  /** Ledger position (slot / block height), for deterministic ordering. */
  sequence:        number | null;
  /** Which adapter/provider observed it. Provenance, never logic. */
  source:          string;
}

// ── Reconciliation, in exact integers ────────────────────────────────────────

export interface BaseUnitReconciliation {
  /** True only when Σ deltas equals the observed balance EXACTLY. */
  reconciles:     boolean;
  movementTotal:  bigint;
  /** observed − Σ. Zero when it reconciles. */
  residual:       bigint;
  movementCount:  number;
  reason:         string;
}

/**
 * Do these movements account for the observed balance?
 *
 * EXACT — both sides are integers in the asset's base unit, so there is no
 * tolerance and no epsilon. That is strictly stronger than the float
 * reconciliation `reconcileWalletLedger` performs on whole units, and it is
 * available here only because the acquisition layer kept base units integral all
 * the way through. Where a caller must express the answer in whole units, the
 * asset's `ledgerEpsilonFor` tolerance still applies to THAT comparison; it does
 * not weaken this one.
 *
 * A shortfall is not a defect report — it is a refusal to license history. The
 * observed CURRENT balance remains true either way.
 */
export function reconcileMovementsAgainstBalance(
  movements: readonly ChainMovement[],
  observedBaseUnits: bigint | null,
): BaseUnitReconciliation {
  let total = BigInt(0);
  for (const m of movements) total += m.baseUnitsDelta;

  if (observedBaseUnits === null) {
    return {
      reconciles: false, movementTotal: total, residual: BigInt(0), movementCount: movements.length,
      reason: "No observed balance to reconcile the acquired movements against.",
    };
  }
  const residual = observedBaseUnits - total;
  if (residual === BigInt(0)) {
    return {
      reconciles: true, movementTotal: total, residual, movementCount: movements.length,
      reason: `${movements.length} acquired movement(s) account for the observed balance of ${observedBaseUnits} base units exactly.`,
    };
  }
  return {
    reconciles: false, movementTotal: total, residual, movementCount: movements.length,
    reason:
      `${movements.length} acquired movement(s) sum to ${total} base units but the observed balance is ` +
      `${observedBaseUnits} — a residual of ${residual}. The acquired history cannot account for the ` +
      "balance, so it cannot license a quantity on any other date.",
  };
}

/**
 * ARITHMETIC MAY LICENSE WHAT A SCAN CANNOT PROVE.
 *
 * An address-index scan can never establish COMPLETE by itself (see
 * ADDRESS_INDEX_INCOMPLETE). But if every acquired movement sums EXACTLY to an
 * independently observed balance, then any movement the scan missed must have
 * summed to zero — and a set of missed movements summing to exactly zero across
 * an arbitrary window is not a coincidence this system needs to entertain.
 *
 * So reconciliation UPGRADES coverage, and only upgrades it: PARTIAL becomes
 * COMPLETE when the arithmetic closes and the covered interval is bounded. A
 * failed reconciliation never downgrades a COMPLETE claim into a lie, and never
 * upgrades anything.
 *
 * This is the one place a coverage claim may strengthen, and it strengthens on
 * EVIDENCE (an independent balance) rather than on the absence of an error.
 *
 * ── THE LICENCE RUNS TO THE BALANCE, NOT TO THE LAST MOVEMENT ────────────────
 * `observedAtISO` is WHEN the balance being reconciled against was observed, and
 * when supplied it becomes the upper bound of the licensed interval.
 *
 * This matters more than it sounds. An adapter's `coveredToISO` is the date of
 * the newest movement it SAW — which for a quiet wallet can be months before
 * today. Left there, the interval between the last movement and the observation
 * reads as unknown, the replay cannot connect its anchor backward across it, and
 * a wallet with a perfect zero-lamport reconciliation reconstructs no history at
 * all. That is the real behaviour observed on the first production acceptance
 * corpus: a four-year history, residual zero, and a timeline of nothing but
 * RELATIVE segments.
 *
 * The extension is the SAME argument the upgrade already rests on, applied to
 * the other end of the interval. A movement inside that gap would have changed
 * the balance, so Σ(movements) would NOT equal the balance observed at the end
 * of it. The arithmetic closing IS the proof that the gap is empty — quietness
 * is not being mistaken for evidence; the balance is the evidence.
 *
 * It remains an UPGRADE ONLY: without a reconciliation, or with any blocking
 * caveat, nothing is extended and nothing is claimed.
 */
export function licenseCoverageByReconciliation(
  coverage: ChainCoverage,
  recon: BaseUnitReconciliation,
  observedAtISO?: string,
): ChainCoverage {
  if (!recon.reconciles) return coverage;
  if (coverage.kind !== "PARTIAL") return coverage;
  if (coverage.coveredFromISO === null || coverage.coveredToISO === null) return coverage;
  // A budget-exhausted or depth-limited run is NOT licensed by arithmetic: it
  // knows it stopped early, and a balance that happens to reconcile over a
  // truncated window says nothing about the window that was never asked for.
  // W6b — ONE list, shared with the READ-TIME licence (position-coverage.ts).
  // Acquisition-time upgrade and read-time licence must never disagree about
  // which caveats bite; two copies of this list would eventually differ.
  if (coverage.caveats.some((c) => BLOCKING_CAVEATS.includes(c))) return coverage;

  // The upper bound runs to the observation the arithmetic closed against, when
  // the caller states one and it is later than the newest movement seen.
  const toISO =
    observedAtISO && observedAtISO > coverage.coveredToISO ? observedAtISO : coverage.coveredToISO;

  return {
    kind:    "COMPLETE",
    fromISO: coverage.coveredFromISO,
    toISO,
    source:  `${coverage.source}+balance-reconciliation`,
  };
}

// ── Movement → canonical quantity event ──────────────────────────────────────

/**
 * Whole units from base units, EXACTLY where float64 permits.
 *
 * Integer and fractional parts are split before conversion so the whole-unit
 * side never loses precision to the divisor. The same routine every adapter's
 * `weiToEth` / `lamportsToSol` uses, stated once for the canonical boundary.
 */
export function baseUnitsToWhole(baseUnits: bigint, decimals: number): number {
  const divisor = BigInt(10) ** BigInt(decimals);
  const whole = baseUnits / divisor;
  const rem   = baseUnits % divisor;
  return Number(whole) + Number(rem) / Number(divisor);
}

/**
 * Convert chain movements into the canonical quantity events the EXISTING replay
 * engine consumes. This is the whole of the crypto → replay bridge.
 *
 * WHY EVERY MOVEMENT IS REPLAYABLE: a fee, a rent deposit and a transfer all
 * change the native quantity held, and the replay engine reconstructs QUANTITY.
 * The distinctions between them are financial-meaning questions asked later, by
 * a different authority, on the same rows. Dropping fees here would make the
 * replay disagree with the balance it must reconcile against.
 *
 * ORDERING: `occurredAtISO` is passed through when the chain states an instant,
 * which makes same-day ordering KNOWN rather than tie-broken — a real advantage
 * over a date-only ledger. `deterministicKey` falls back to (sequence, eventId,
 * movementKey), which is reproducible and explicitly NOT a chronology claim.
 */
export function movementsToQuantityEvents(
  movements: readonly ChainMovement[],
  ctx: { accountId: string; instrumentId: string; decimals: number },
): NormalizedQuantityEvent[] {
  return movements.map((m) => {
    const delta = baseUnitsToWhole(m.baseUnitsDelta, ctx.decimals);
    const finite = Number.isFinite(delta);
    return {
      eventId:         `${m.eventId}:${m.movementKey}`,
      accountId:       ctx.accountId,
      instrumentId:    ctx.instrumentId,
      sourceType:      m.role,
      // The provider's value verbatim, for reconciliation and debugging. Base
      // units do not fit a Float at scale, so the whole-unit figure is what is
      // preserved here; the exact integer lives on the movement itself.
      sourceQuantity:  finite ? delta : null,
      normalizedDelta: finite ? delta : null,
      ratio:           null,
      dateISO:         m.dateISO,
      order: {
        effectiveDateTimeISO: m.occurredAtISO,
        deterministicKey:     `${String(m.sequence ?? 0).padStart(20, "0")}:${m.eventId}:${m.movementKey}`,
        certainty:            m.occurredAtISO ? "KNOWN" : "TIE_BROKEN",
      },
      status:          finite ? "REPLAYABLE" : "INVALID",
      reason:          finite ? null : "NON_FINITE_QUANTITY",
      provenance:      m.source,
      externalEventId: m.eventId,
    };
  });
}

// ── Disposition: what the chain PROVES about a movement's direction ──────────

/**
 * The ONLY dispositions a raw chain movement supports.
 *
 * This is deliberately a very short list, and everything a user would call the
 * event — sold, spent, gifted, deposited at an exchange, swapped — is absent.
 * The chain proves that quantity left custody. It does not prove where it went
 * in any economic sense, because the economic act settles somewhere the chain
 * cannot see.
 */
export type MovementDisposition =
  /** Quantity entered an owned account from outside the user's own wallets. */
  | "EXTERNAL_INFLOW"
  /** Quantity left custody. ALL the chain says. Not a sale, spend or gift. */
  | "EXTERNAL_OUTFLOW"
  /**
   * Both sides resolve to wallets this user canonically owns. KNOWN, because
   * ownership is a fact this system holds — not a label, not a guess.
   */
  | "INTERNAL_TRANSFER"
  /** Protocol fee. */
  | "FEE"
  /** A protocol-required balance change, not an economic transfer. */
  | "PROTOCOL_RESERVE"
  /**
   * The event moved more than one asset, or its parts do not describe a simple
   * transfer. Faithfully stored, uninterpreted. It changes composition and
   * nothing else — it is not a swap, not income, not spending.
   */
  | "UNCLASSIFIED_PROGRAM_INTERACTION";

/**
 * What does the chain prove about this movement's direction?
 *
 * `ownedAddresses` is the set of addresses this user canonically owns, resolved
 * from `ProviderAccountIdentity` — evidence this system holds, not a heuristic.
 * That is the ONLY input that may upgrade an outflow to INTERNAL_TRANSFER.
 *
 * `multiAsset` is stated by the caller because only the adapter can see whether
 * the event touched other assets; a native-only view of a swap looks exactly
 * like a transfer, and calling it one would be the invention this refuses.
 *
 * EXPLICITLY NOT INPUTS: exchange address lists, address labels, amount
 * heuristics, round-number detection, timing. An exchange-looking address is a
 * hint for a human, never a financial fact.
 */
export function resolveMovementDisposition(
  m: ChainMovement,
  ctx: { ownedAddresses: ReadonlySet<string>; multiAsset?: boolean },
): MovementDisposition {
  if (m.role === "FEE")              return "FEE";
  if (m.role === "PROTOCOL_RESERVE") return "PROTOCOL_RESERVE";
  if (ctx.multiAsset)    return "UNCLASSIFIED_PROGRAM_INTERACTION";

  const counterpartiesAllOwned =
    m.counterparties.length > 0 && m.counterparties.every((a) => ctx.ownedAddresses.has(a));
  if (counterpartiesAllOwned) return "INTERNAL_TRANSFER";

  return m.baseUnitsDelta >= BigInt(0) ? "EXTERNAL_INFLOW" : "EXTERNAL_OUTFLOW";
}

/**
 * THE USER-ATTESTATION CONTRACT — declared here, deliberately NOT persisted.
 *
 * When a user says "the 80 SOL that left on 10 March was a sale for $9,400",
 * that is real evidence with a named author, and it is exactly the shape
 * `PositionOrigin.USER_ASSERTED` and the debt-payment attestation already use:
 * a person asserts, the assertion is recorded as an assertion, and no inference
 * engine is involved.
 *
 * It is a TYPE here and nothing more, because persisting it needs a decision
 * this slice does not own: which table holds it, whether it is amendable, who
 * may make it in a shared Space, and what it does to cash flow. Building any of
 * that would be smuggling a product decision into a reconstruction slice. The
 * contract is written down so the eventual implementation has a shape to satisfy
 * rather than inventing one.
 *
 * UNTIL THEN: an outflow with no attestation stays EXTERNAL_OUTFLOW, and no
 * proceeds figure exists anywhere. That is the honest state, not a gap.
 */
export interface MovementAttestation {
  /** The chain event this attestation is ABOUT. Never invented. */
  eventId:        string;
  movementKey:    string;
  /** What the user says happened. Their claim, labelled as theirs. */
  assertedAs:     "SALE" | "PURCHASE" | "GIFT_SENT" | "GIFT_RECEIVED" | "SELF_TRANSFER";
  /** Proceeds/cost in the asserted currency. Null when the user did not say. */
  assertedAmount: number | null;
  assertedCurrency: string | null;
  /** WHO asserted it and WHEN — an assertion without an author is a guess. */
  assertedByUserId: string;
  assertedAtISO:    string;
  /** Free-text note the user supplied. Never parsed for meaning. */
  note:             string | null;
}
