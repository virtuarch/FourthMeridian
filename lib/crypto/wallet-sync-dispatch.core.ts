/**
 * lib/crypto/wallet-sync-dispatch.core.ts  (PERF-3 — the chain facts, without the adapters)
 *
 * THE per-chain FACTS of the wallet sync registry: how far this system can go
 * on a chain, where its current and historical values are read from, how its
 * net-worth participation is stated, and how it is valued. The predicates that
 * answer questions about those facts live here too. lib/crypto/wallet-sync-
 * dispatch.ts composes these facts with each chain's sync adapter and
 * re-exports the predicates, so its importers are unchanged.
 *
 * WHY THIS FILE EXISTS. A READ asked a FACT question — lib/crypto/wallet-
 * current-value.ts (on every /dashboard render, through lib/space/mount-
 * composition.ts) imported `usesLegacyColumnForCurrentValue` from the
 * dispatcher, and the dispatcher statically imports every chain's syncer
 * (BTC/ETH/SOL/EVM clients) and the refresh-execution envelope, whose
 * import() of lib/plaid/refresh brings the Plaid SDK (a 20.6 MB vendor chunk).
 * The bundler compiles all of it into the reading route. A fact needs facts.
 *
 * IMPORT RULE: value imports from lib/crypto/native-asset.ts only (the chain
 * identities); type-only imports otherwise. lib/crypto/wallet-chain-facts-
 * boundary.test.ts walks the closure and fails if a syncer, the dispatcher,
 * the refresh envelope or a provider SDK becomes reachable from here or from
 * the current-value read.
 */

import type { WalletChainSupport, WalletSyncOutcome, WalletValuationModel } from "./wallet-sync-dispatch";
import { BTC_NATIVE, ETH_NATIVE, SOL_NATIVE, BNB_NATIVE, AVAX_NATIVE } from "./native-asset";

// The same identities the adapters key on (btc-sync BTC_CHAIN = BTC_NATIVE.chain,
// evm-networks BNB_NETWORK.chain = BNB_NATIVE.chain, …); the boundary test
// asserts the composed registry and this table have exactly the same keys.
const BTC_CHAIN = BTC_NATIVE.chain;
const ETH_CHAIN = ETH_NATIVE.chain;
const SOL_CHAIN = SOL_NATIVE.chain;
const BNB_CHAIN = BNB_NATIVE.chain;
const AVAX_CHAIN = AVAX_NATIVE.chain;

/** Everything a chain's registration declares except its sync adapter. */
export interface WalletChainFacts {
  support: WalletChainSupport;
  netWorthParticipation: WalletSyncOutcome["netWorthParticipation"];
  /**
   * W6c — where this chain's HISTORICAL quantity comes from.
   *
   * SPINE         replayed, reconciled PositionObservations bounded by a
   *               persisted coverage licence. The only defensible answer.
   * LEGACY_COLUMN `FinancialAccount.nativeBalance` carried backward across
   *               intervals with no recorded movement. Transitional, and as of
   *               W6c no chain uses it.
   *
   * Separate from `netWorthParticipation` because they answer different
   * questions: one is about dates in the past, the other about what the account
   * surfaces show now. Bitcoin is precisely the case that forced them apart — it
   * reconstructs its history from the spine while still writing its balance
   * column for the current path.
   */
  historicalQuantityAuthority: "SPINE" | "LEGACY_COLUMN";
  /**
   * W6d — where this chain's CURRENT value is READ from.
   *
   * SPINE         the position spine, valued through the canonical dated price
   *               path, freshness-aware.
   * LEGACY_COLUMN `FinancialAccount.balance` — quantity × an undated sync-time
   *               spot. As of W6d no chain reads this.
   *
   * Deliberately NOT the same field as `netWorthParticipation`, which describes
   * what the ADAPTER WROTE. Bitcoin is exactly why: it still writes the balance
   * column (the historical materiality signal reads it, and nothing else can
   * answer "did this wallet ever hold anything"), while no canonical surface
   * reads it any more. Collapsing the two would force one of those two true
   * statements to be recorded as false.
   */
  currentValueAuthority: "SPINE" | "LEGACY_COLUMN";
  /**
   * CRYPTO-LATCH-2 — declared, not inferred. See `WalletValuationModel`. This is
   * the field that makes `outcomeRevalued` able to fail CLOSED on a chain that
   * owes a valuation and did not produce one.
   */
  valuationModel: WalletValuationModel;
}

/**
 * THE registry. A chain absent from this map is UNSUPPORTED by sync — which is a
 * stated outcome, not a fall-through.
 */
export const WALLET_CHAIN_FACTS: Readonly<Record<string, WalletChainFacts>> = {
  [BTC_CHAIN]: {
    // The only chain with a movement ledger, a reconciliation and a licensed
    // historical carry. Also the only one still writing the legacy balance
    // column that net worth composes from.
    support: "HISTORY_SUPPORTED",
    // W6d — the adapter still WRITES the column (the historical materiality
    // signal is the only thing that can answer "did this wallet ever hold
    // anything"), and no canonical surface READS it. Both facts recorded.
    netWorthParticipation: "LEGACY_BALANCE_COLUMN",
    historicalQuantityAuthority: "SPINE",
    currentValueAuthority: "SPINE",
    valuationModel: "ADAPTER_VALUED",
  },
  [ETH_CHAIN]: {
    // ETH-H2 — PROMOTED ON REAL-WALLET ACCEPTANCE, not on the adapter existing.
    // Reconstructed from state reads alone (no trace_*, no transfer index):
    // COMPLETE coverage 2017-10-16..2026-08-27, zero caveats, 16 movements
    // reconciling at ZERO WEI, 3238 replayed days, dated prices through the
    // canonical backfill, and a refused acquisition preserving all of it.
    //
    // The promise holds for a plain EOA. A contract wallet (Safe, ERC-4337) or an
    // EOA carrying a live EIP-7702 delegation refuses PROOF_PREMISES_UNMET and
    // gains no history — an honest boundary, like Bitcoin's unattested xpub
    // basis and Solana's address-index gap, not a hidden partial answer.
    support: "HISTORY_SUPPORTED",
    netWorthParticipation: "WITHHELD_PENDING_CONVERGENCE",
    historicalQuantityAuthority: "SPINE",
    currentValueAuthority: "SPINE",
    valuationModel: "READ_TIME_VALUED",
  },
  // W-M3 — EVM networks whose native balance is acquirable AND whose canonical
  // asset has an unambiguous price identity. Both conditions are required: a
  // material position nobody can price would refuse the whole Space's crypto
  // day under the all-or-nothing rule, taking BTC and SOL down with it.
  //
  // Polygon is configured (lib/crypto/evm-networks.ts) and deliberately ABSENT
  // here: its native asset has two competing vendor identities whose prices
  // differ by ~15%, and choosing between them is a product decision this system
  // has not made. Recordable, unreadable, honest.
  [BNB_CHAIN]: {
    support: "CURRENT_POSITION_SUPPORTED",
    netWorthParticipation: "WITHHELD_PENDING_CONVERGENCE",
    historicalQuantityAuthority: "SPINE",
    currentValueAuthority: "SPINE",
    valuationModel: "READ_TIME_VALUED",
  },
  [AVAX_CHAIN]: {
    support: "CURRENT_POSITION_SUPPORTED",
    netWorthParticipation: "WITHHELD_PENDING_CONVERGENCE",
    historicalQuantityAuthority: "SPINE",
    currentValueAuthority: "SPINE",
    valuationModel: "READ_TIME_VALUED",
  },
  [SOL_CHAIN]: {
    // W-M2b — PROMOTED on real-wallet evidence, not on an adapter existing.
    // Against the live acceptance wallet: 36 signatures acquired over standard
    // RPC back to 2022, pagination reaching the beginning, 27 movements
    // reconciling to the observed balance with a residual of ZERO lamports,
    // a 13-segment replayed quantity timeline, and dated valuation that refuses
    // (UNVALUED) beyond the price provider's floor rather than reporting zero.
    //
    // Net-worth participation stays WITHHELD: this adapter writes no balance
    // column, and the wealth-history snapshot path still composes crypto from
    // `nativeBalance`. History support and net-worth participation are separate
    // promises — see `feedsLegacyWealthHistory`.
    support: "HISTORY_SUPPORTED",
    netWorthParticipation: "WITHHELD_PENDING_CONVERGENCE",
    historicalQuantityAuthority: "SPINE",
    currentValueAuthority: "SPINE",
    valuationModel: "READ_TIME_VALUED",
  },
};

/** Every chain this system can actually read, sorted. Display and diagnostics. */
export const SYNCABLE_CHAINS: readonly string[] = Object.keys(WALLET_CHAIN_FACTS).sort();

/** How far this system can go on `chain`. Unknown/absent ⇒ UNSUPPORTED. */
export function walletChainSupport(chain: string | null | undefined): WalletChainSupport {
  if (!chain) return "UNSUPPORTED";
  return WALLET_CHAIN_FACTS[chain.trim().toUpperCase()]?.support ?? "UNSUPPORTED";
}

/** Can this chain be synced at all? */
export function isSyncableChain(chain: string | null | undefined): boolean {
  return walletChainSupport(chain) !== "UNSUPPORTED";
}

/**
 * Does this chain feed the LEGACY wealth-history regeneration path?
 *
 * ── W6c — BITCOIN LEFT. THIS PREDICATE IS NOW EMPTY, AND THAT IS THE POINT ──
 * Bitcoin was the last chain whose HISTORICAL quantity came from
 * `FinancialAccount.nativeBalance` carried backward. It now earns a replayed,
 * reconciled timeline on the position spine with a persisted coverage licence,
 * exactly as Solana does, so no chain answers true here any more.
 *
 * The predicate is KEPT rather than deleted, and deliberately: it is the seam
 * that lets a chain be introduced with a legacy ingest path before it earns a
 * reconstruction, and deleting it would mean the next such chain has nowhere to
 * say so. Its emptiness is asserted by a test, so re-populating it is a
 * deliberate act rather than a drift.
 *
 * DELETION CONDITION: when the wallet net-worth convergence moves CURRENT
 * composition onto the spine too, `LEGACY_BALANCE_COLUMN` loses its last
 * meaning and this predicate goes with it.
 *
 * ── This is the HISTORICAL question only ────────────────────────────────────
 * `netWorthParticipation` still says where a chain's CURRENT value comes from,
 * and Bitcoin still writes its balance column for that. Historical authority and
 * current authority are separate questions (W6b invariant 32), so they are now
 * separate fields.
 *
 * ── W-M2b — THIS IS NOT THE SAME QUESTION AS "HAS HISTORY" ──────────────────
 * It used to be `support === "HISTORY_SUPPORTED"`, and while Bitcoin was the
 * only chain with history the two coincided. They have now come apart, and
 * conflating them would be wrong in a way that costs real work.
 *
 * The wealth-history regenerator composes crypto from
 * `FinancialAccount.nativeBalance` × a dated close. A chain that writes that
 * column feeds it; a chain that does not is invisible to it no matter how much
 * history it has. Solana has a fully reconstructed, reconciled quantity
 * timeline — on the POSITION SPINE, as DERIVED observations — and writes no
 * balance column by design, so regenerating for it would walk an entire Space
 * to compute nothing.
 *
 * So the gate is the net-worth participation, which is exactly the property
 * that decides it. When the wallet net-worth convergence moves that path onto
 * the position spine, this predicate and the distinction both disappear.
 */
/**
 * Does this chain READ its CURRENT value from the legacy balance column?
 *
 * W6c split this question out of `feedsLegacyWealthHistory`; W6d answered it.
 * No chain reads the column any more, so — like the historical predicate above —
 * this is now empty, and its emptiness is asserted rather than assumed.
 *
 * It was called `writesLegacyBalanceColumn` until W6d, and the rename is the
 * point: it was being used to decide what a READER may trust while being named
 * after what a WRITER does. Those came apart the moment Bitcoin kept writing the
 * column and stopped reading it, and a predicate whose name disagrees with its
 * use is how the next reader reintroduces the bug.
 *
 * DELETION CONDITION: when every linked wallet carries at least one OBSERVED
 * PositionObservation, the NO_OBSERVATION fallback in `lib/data/accounts.ts`
 * becomes unreachable, `LEGACY_COLUMN` loses its last member, and this predicate
 * goes with it.
 */
export function usesLegacyColumnForCurrentValue(chain: string | null | undefined): boolean {
  if (!chain) return false;
  return WALLET_CHAIN_FACTS[chain.trim().toUpperCase()]?.currentValueAuthority === "LEGACY_COLUMN";
}

export function feedsLegacyWealthHistory(chain: string | null | undefined): boolean {
  if (!chain) return false;
  return WALLET_CHAIN_FACTS[chain.trim().toUpperCase()]?.historicalQuantityAuthority === "LEGACY_COLUMN";
}

/**
 * Has this chain's HISTORY been proven — acquisition, reconciliation, replay and
 * dated valuation, on real evidence?
 *
 * Retained as the capability question. It is deliberately NOT the regeneration
 * gate any more (see `feedsLegacyWealthHistory`).
 */
export function chainSupportsHistory(chain: string | null | undefined): boolean {
  return walletChainSupport(chain) === "HISTORY_SUPPORTED";
}
