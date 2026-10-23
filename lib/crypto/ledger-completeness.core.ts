/**
 * lib/crypto/ledger-completeness.core.ts
 *
 * V26-S1-BTC — CAN THIS WALLET'S MOVEMENT LEDGER ACCOUNT FOR ITS OWN BALANCE?
 *
 * Pure: no Prisma, no DB, no clock, no network.
 *
 * ── The one question this module answers ─────────────────────────────────────
 * A self-custodied wallet is the only asset in this system whose history is
 * ARITHMETICALLY CHECKABLE against an independent authority. The chain states
 * the balance; the chain also states every movement that produced it. So:
 *
 *     Σ(signed native movements)  ==  observed native balance
 *
 * must hold identically. It is not a heuristic, not a tolerance-driven
 * approximation of a broker's books, and not a statement about our model — it
 * is a property of the ledger. If it fails, we are missing movements.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * Nothing checked it. `fetchAddressTxsRaw` issued one unpaginated request, so
 * the live wallet imported 25 of its 28 confirmed transactions and the resulting
 * ledger fell short of its own balance by 0.02028507 BTC — 8.4% of the wallet.
 * Every downstream consumer treated that truncated list as complete:
 * `licenseConstantQuantityCarry` searched it for blocking events and found none,
 * because the events it needed to find had never been imported.
 *
 * The pagination repair (btc-explorer.ts) removes the known cause. This module
 * removes the CLASS: a movement set that cannot account for the balance is not
 * evidence, whatever produced the shortfall — an unpaginated fetch, an exhausted
 * page budget, an undiscovered xpub branch, a provider outage mid-import, or a
 * chain we have not learned to read yet.
 *
 * ── Why it is DERIVED, never persisted ───────────────────────────────────────
 * Completeness is a property of the data as it stands RIGHT NOW. A stored flag
 * would be a claim about a past import that the next sync silently invalidates
 * — the exact failure mode `cryptoValuationStatus` was designed around, but
 * inverted: there, staleness could wrongly REFUSE; here, staleness would wrongly
 * BLESS. A recomputed answer cannot go stale, and it costs one SUM.
 *
 * ── What a refusal means ─────────────────────────────────────────────────────
 * Not "the wallet is broken". It means "this ledger cannot license a claim about
 * another date". The wallet's CURRENT balance is still observed and still true;
 * only history is withheld. That is the same shape as every other refusal in
 * this engine: unknown is preferable to a confident wrong number.
 *
 * Nothing here names a chain, a provider, an account or a user.
 */

/**
 * Native-unit tolerance for the reconciliation — THE DEFAULT, not the only one.
 *
 * W-M0: this was the sole tolerance, and it is one satoshi. That is correct for
 * an 8-decimal asset and wrong for every other: a lamport is 1e-9 (so a SOL
 * ledger short by up to ten lamports would read as complete) and a wei is 1e-18
 * (below what float64 can even distinguish). The tolerance is therefore a
 * PROPERTY OF THE ASSET and is now supplied per call by
 * `ledgerEpsilonFor(asset)` in lib/crypto/native-asset.ts.
 *
 * It remains exported and remains the default so that every caller that does
 * not yet name an asset behaves EXACTLY as it did — the BTC path is unchanged
 * to the bit.
 */
export const LEDGER_EPSILON = 1e-8; // 1 satoshi — the smallest representable BTC unit

export type LedgerRefusal =
  /** No observed balance to reconcile against. */
  | "NO_OBSERVED_BALANCE"
  /** The wallet holds a balance and we hold no movements at all. */
  | "NO_MOVEMENTS"
  /** Movements exist but do not sum to the observed balance. */
  | "LEDGER_SHORTFALL"
  /**
   * W-M1b — THIS CHAIN'S ADAPTER DOES NOT IMPORT A MOVEMENT LEDGER AT ALL.
   *
   * Distinct from NO_MOVEMENTS, and the distinction is the whole reason this
   * value exists. NO_MOVEMENTS says "a ledger was consulted and was empty",
   * which for Bitcoin is a real defect: the chain states every movement, the
   * importer should have them, and their absence means something went wrong.
   * NOT_APPLICABLE says "no ledger was consulted, because this adapter acquires
   * a balance and nothing else". Nothing went wrong; the question was never
   * asked.
   *
   * Collapsing the two would be dishonest in both directions — it would file a
   * balance-only chain as a broken Bitcoin wallet, and it would give a genuinely
   * broken Bitcoin wallet somewhere to hide.
   */
  | "NOT_APPLICABLE";

export interface LedgerReconciliationInput {
  /**
   * The wallet's observed balance in its NATIVE asset's whole units, or null
   * when none is known. This is the independent authority; the movements are
   * what must explain it. Which asset that is, is the binding's business — this
   * module only requires that the balance and the movements denominate the SAME
   * one (see `epsilon`, which is that asset's base unit).
   */
  observedBalance: number | null;
  /**
   * Signed native deltas for THIS wallet, already scoped and filtered by the
   * binding: this account only, native-denominated, POSTED, not deleted.
   * Inflows positive; outflows and fees negative. Order is irrelevant.
   *
   * Passing numbers rather than rows keeps this module free of any schema type
   * and makes the filtering predicates a documented responsibility of the
   * binding, exactly as quantity-carry.core.ts does with its dates.
   */
  movements: readonly number[];
  /**
   * W-M0 — the native-unit tolerance for THIS asset, from
   * `ledgerEpsilonFor(asset)`. Omitted ⇒ `LEDGER_EPSILON` (one satoshi), so
   * every pre-W-M0 caller is byte-identical.
   *
   * The binding supplies it for the same reason it supplies the movements: this
   * module names no chain and must not acquire one. A non-finite or
   * non-positive value is ignored in favour of the default — a broken tolerance
   * must never widen a comparison into silently passing.
   */
  epsilon?: number;
}

export interface LedgerReconciliation {
  /** True only when the movements account for the balance within `epsilon`. */
  complete:        boolean;
  /** Σ movements. 0 when there are none — which is a sum, not an absence. */
  movementTotal:   number;
  /** observedBalance − movementTotal. Null when there is no balance to compare. */
  residual:        number | null;
  movementCount:   number;
  /** Present only when `complete` is false. */
  refusal:         LedgerRefusal | null;
  /** Deterministic, name-free explanation. Always populated. */
  reason:          string;
}

/**
 * W-M1b — THE STATE OF A WALLET WHOSE CHAIN HAS NO IMPORTED LEDGER.
 *
 * A balance-only adapter (native ETH, native SOL) observes a quantity and
 * imports no movements. It must not call `reconcileWalletLedger`: that function
 * answers "do the movements explain the balance", and asking it about a wallet
 * with no movements yields NO_MOVEMENTS — a REFUSAL that reads as a defect.
 * There is no defect. There is no ledger.
 *
 * `complete` is FALSE, and deliberately so. Ledger completeness is what licenses
 * a historical quantity CARRY (see quantity-carry.core.ts), and a wallet whose
 * movements are unknown cannot license a claim about any other date — that is
 * exactly as true when the movements were never imported as when they were
 * imported short. What changes is the REASON, which is what reaches the user
 * and what an operator triages on.
 *
 * The sync LIFECYCLE reads this differently, and that is the point of separating
 * them: a balance-only chain may reach "synced" on a successful acquisition,
 * because for that chain a complete sync genuinely is a balance. It does not
 * pretend a reconciliation occurred.
 */
export function ledgerNotApplicable(observedBalance: number | null): LedgerReconciliation {
  return {
    complete:      false,
    movementTotal: 0,
    residual:      null,
    movementCount: 0,
    refusal:       "NOT_APPLICABLE",
    reason:
      "This chain's adapter acquires a balance only and imports no movement ledger, " +
      "so there is nothing to reconcile the balance against. The observed balance " +
      `${observedBalance === null ? "is unknown" : `of ${observedBalance} is current`}; ` +
      "no historical quantity can be derived from it.",
  };
}

/**
 * Reconcile a wallet's movement ledger against its observed balance.
 *
 * Total and deterministic; never throws. A non-finite balance or a non-finite
 * movement is treated as a shortfall rather than propagated as NaN — an
 * unusable number must not silently become a passing comparison (Postgres
 * `NaN = NaN` is TRUE, and this codebase has been bitten by exactly that).
 */
export function reconcileWalletLedger(input: LedgerReconciliationInput): LedgerReconciliation {
  const { observedBalance, movements } = input;
  const movementCount = movements.length;
  // A tolerance that is itself unusable is not a tolerance. Fall back to the
  // default rather than compare against NaN (which makes every `>` false and
  // would bless any shortfall) or against a negative (which refuses everything).
  const epsilon =
    input.epsilon !== undefined && Number.isFinite(input.epsilon) && input.epsilon > 0
      ? input.epsilon
      : LEDGER_EPSILON;

  let movementTotal = 0;
  let anyNonFinite = false;
  for (const m of movements) {
    if (!Number.isFinite(m)) { anyNonFinite = true; continue; }
    movementTotal += m;
  }

  if (observedBalance === null || !Number.isFinite(observedBalance)) {
    return {
      complete: false, movementTotal, residual: null, movementCount,
      refusal: "NO_OBSERVED_BALANCE",
      reason: "No observed native balance to reconcile the movement ledger against.",
    };
  }

  const residual = observedBalance - movementTotal;

  // A wallet holding nothing, with no movements, reconciles trivially and
  // honestly: 0 == 0. Only a wallet that HOLDS something while we hold no
  // movements is a refusal.
  if (movementCount === 0 && Math.abs(observedBalance) > epsilon) {
    return {
      complete: false, movementTotal, residual, movementCount,
      refusal: "NO_MOVEMENTS",
      reason: `The wallet holds ${observedBalance} but no movements are recorded, so no historical quantity can be derived.`,
    };
  }

  if (anyNonFinite || Math.abs(residual) > epsilon) {
    return {
      complete: false, movementTotal, residual, movementCount,
      refusal: "LEDGER_SHORTFALL",
      reason:
        `${movementCount} recorded movement(s) sum to ${movementTotal} but the observed balance is ` +
        `${observedBalance} — a residual of ${residual}. The movement ledger is incomplete, so it ` +
        `cannot license a quantity on any other date.`,
    };
  }

  return {
    complete: true, movementTotal, residual, movementCount,
    refusal: null,
    reason: `${movementCount} recorded movement(s) account for the observed balance of ${observedBalance}.`,
  };
}
