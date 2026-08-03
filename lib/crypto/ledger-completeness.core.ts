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

/** Native-unit tolerance for the reconciliation. */
export const LEDGER_EPSILON = 1e-8; // 1 satoshi — the smallest representable BTC unit

export type LedgerRefusal =
  /** No observed balance to reconcile against. */
  | "NO_OBSERVED_BALANCE"
  /** The wallet holds a balance and we hold no movements at all. */
  | "NO_MOVEMENTS"
  /** Movements exist but do not sum to the observed balance. */
  | "LEDGER_SHORTFALL";

export interface LedgerReconciliationInput {
  /**
   * The wallet's observed native balance (BTC), or null when none is known.
   * This is the independent authority; the movements are what must explain it.
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
}

export interface LedgerReconciliation {
  /** True only when the movements account for the balance within LEDGER_EPSILON. */
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
  if (movementCount === 0 && Math.abs(observedBalance) > LEDGER_EPSILON) {
    return {
      complete: false, movementTotal, residual, movementCount,
      refusal: "NO_MOVEMENTS",
      reason: `The wallet holds ${observedBalance} but no movements are recorded, so no historical quantity can be derived.`,
    };
  }

  if (anyNonFinite || Math.abs(residual) > LEDGER_EPSILON) {
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
