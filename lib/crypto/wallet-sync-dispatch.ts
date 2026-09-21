/**
 * lib/crypto/wallet-sync-dispatch.ts
 *
 * W-M1d — WHICH ADAPTER SERVES THIS WALLET, AND HOW FAR DOES IT GO?
 *
 * One registry, keyed by `FinancialAccount.walletChain`, mapping a chain to the
 * adapter that syncs it and to what that adapter can honestly claim. Routes call
 * `syncWalletByChain`; nothing above this file names a chain or an adapter.
 *
 * ── Why a registry rather than three `if` branches at each call site ─────────
 * Because there are FOUR call sites (wallet create, wallet re-add, wallet
 * restore, manual sync) and they had already drifted: three of them ran
 * `if (chain === BTC_CHAIN)` twice — once for the sync and once for the wealth
 * history — and the sync route rejected everything else with a message naming
 * Bitcoin. Adding two chains that way means eight new branches and four new
 * chances for a route to forget one. A registry makes "which chains can sync"
 * a single fact and makes forgetting structurally impossible.
 *
 * ── SUPPORT IS A CLAIM, AND IT IS GRADED ────────────────────────────────────
 * `WalletChainSupport` is the honest answer to "what does this system know about
 * this chain", and the three levels are genuinely different promises:
 *
 *   HISTORY_SUPPORTED           balance, movement ledger, reconciliation, and a
 *                               licensed historical quantity. Today: BTC ONLY.
 *   CURRENT_POSITION_SUPPORTED  a canonical CURRENT position, valued at the
 *                               dated close. No movement ledger, so no history
 *                               and no net-worth participation. ETH, SOL.
 *   UNSUPPORTED                 custody may be RECORDED, but nothing can read
 *                               the chain. MATIC, AVAX, DOT, ADA, XRP, OTHER.
 *
 * A chain is promoted to HISTORY_SUPPORTED only when historical acquisition and
 * reconstruction are PROVEN — never because an adapter exists. Recording custody
 * and being able to value it are different capabilities, and the wallet route
 * deliberately accepts more chains than this registry serves: a user may record
 * a Cardano wallet, and this system will honestly say it cannot read it rather
 * than pretend it holds nothing.
 *
 * ── The dispatcher does NOT unify the adapters' internals ───────────────────
 * Each adapter keeps its own result shape, its own staged failures, and its own
 * provider semantics — that is the point of an adapter. What is unified is the
 * OUTCOME a route needs: did it work, what should the caller be told, and may
 * this chain's history be regenerated. Chain-specific detail rides along in
 * `raw` for logging, never for branching.
 */

import { syncBtcWallet, BTC_CHAIN, type BtcTransactionImportOutcome, type BtcValuationOutcome } from "@/lib/crypto/btc-sync";
import { syncEthWallet, ETH_CHAIN } from "@/lib/crypto/eth-sync";
import { syncSolWallet, SOL_CHAIN } from "@/lib/crypto/sol-sync";
import { syncEvmWallet } from "@/lib/crypto/evm-native";
import { BNB_NETWORK, AVAX_NETWORK } from "@/lib/crypto/evm-networks";
const BNB_CHAIN = BNB_NETWORK.chain;
const AVAX_CHAIN = AVAX_NETWORK.chain;
import { refreshWalletHistory, type WalletHistoryRefresh } from "./wallet-history-refresh";
import { recordWalletSyncRefusal } from "@/lib/accounts/wallet-connection";
// PLATFORM OPS OBSERVABILITY — every wallet sync is now an EXECUTION in the one
// refresh ledger (RefreshExecution), exactly like a Plaid refresh: a start row,
// the adapter's run as a PROVIDER stage, the history refresh as a DERIVED
// stage, one completion write carrying duration, status and verdict. Before
// this, a manual or scheduled wallet refresh left no run, no trigger, no
// duration and no status anywhere — a failure survived only as a SyncIssue.
// The envelope is best-effort and never alters control flow: this function
// keeps its never-throw contract and its result shape byte-for-byte.
import { runFullRefresh } from "@/lib/plaid/refresh-execution";
import { classifyFailureCategory } from "@/lib/plaid/refresh-verdict.core";
import type { RefreshTrigger, RefreshStageRecorder } from "@/lib/plaid/refresh-execution-types";
import { currentJobRun } from "@/lib/jobs/run";

/** How far this system can go on a given chain. See the header. */
export type WalletChainSupport =
  | "HISTORY_SUPPORTED"
  | "CURRENT_POSITION_SUPPORTED"
  | "UNSUPPORTED";

/**
 * W-M2a — THE GENERIC, CHAIN-AGNOSTIC REASON A WALLET SYNC DID NOT COMPLETE.
 *
 * Recorded on `Connection.errorCode`, which is what the Connections surface
 * derives its state from. Each code names a DIFFERENT response, which is the
 * only reason they are separate: configure something, correct an address, wait
 * and retry, or look at why a read succeeded and a write did not.
 *
 * Deliberately not per-chain. "This deployment cannot reach the chain" is the
 * same operational fact for Solana, Ethereum and every network after them; the
 * chain is already on the account. A per-chain code set would multiply with the
 * chain list and teach the UI to branch on chains rather than on states.
 */
export type WalletSyncErrorCode =
  /** No provider endpoint is configured for this chain on this deployment. */
  | "PROVIDER_NOT_CONFIGURED"
  /** The stored address is not well-formed for its chain. Permanent until edited. */
  | "INVALID_WALLET_ADDRESS"
  /** The chain could not be read this run — transport, rate limit, bad response. */
  | "BALANCE_UNAVAILABLE"
  /** The balance was read but the canonical position could not be recorded. */
  | "POSITION_CAPTURE_UNAVAILABLE"
  /** No adapter serves this chain. */
  | "CHAIN_UNSUPPORTED"
  /** An adapter threw despite its never-throw contract. */
  | "ADAPTER_ERROR";

/**
 * Map an adapter's own failure stage onto the generic code. Pure, so the mapping
 * is testable without a database and cannot drift from what is recorded.
 *
 * An unrecognised stage yields BALANCE_UNAVAILABLE rather than nothing: a
 * refusal whose stage this function has not learned yet is still a refusal, and
 * defaulting to "no code" would put the connection straight back into the
 * silence that made a terminal failure look like progress.
 */
export function walletSyncErrorCode(stage: string | undefined): WalletSyncErrorCode {
  switch (stage) {
    case "config":            return "PROVIDER_NOT_CONFIGURED";
    case "address":           return "INVALID_WALLET_ADDRESS";
    case "capture":           return "POSITION_CAPTURE_UNAVAILABLE";
    case "unsupported-chain": return "CHAIN_UNSUPPORTED";
    case "adapter-error":     return "ADAPTER_ERROR";
    default:                  return "BALANCE_UNAVAILABLE";
  }
}

/**
 * PLATFORM OPS OBSERVABILITY — how a wallet sync was initiated, in the refresh
 * ledger's trigger vocabulary. A caller that knows (the manual route: MANUAL)
 * says so; one that does not gets the ambient JobRun's answer: a cron sweep
 * records CRON, an operator's Run Now records OPERATOR, a script ADMIN, and
 * code running under no job at all — a customer action such as adding or
 * restoring a wallet — records MANUAL.
 */
export interface WalletSyncContext {
  trigger?: RefreshTrigger;
}

export function walletRefreshTrigger(explicit?: RefreshTrigger): RefreshTrigger {
  if (explicit) return explicit;
  const job = currentJobRun();
  if (!job) return "MANUAL";
  switch (job.trigger) {
    case "cron":   return "CRON";
    case "manual": return "OPERATOR";
    case "script": return "ADMIN";
    default:       return "MANUAL";
  }
}

/** The unified outcome a ROUTE needs. Adapters keep their own richer results. */
export interface WalletSyncOutcome {
  accountId: string;
  chain:     string;
  support:   WalletChainSupport;
  ok:        boolean;
  syncStatus?: "synced" | "pending";
  /** Which step failed, in the adapter's own vocabulary. */
  stage?:    string;
  /** Operator/user-facing explanation. Always present on failure. */
  reason?:   string;
  /**
   * Does this chain's asset contribute to NET WORTH today?
   *
   * BTC does, through the legacy `FinancialAccount.balance` column. ETH and SOL
   * deliberately do not: their adapters write no balance column, so their value
   * lives only on the dated position spine until the wallet net-worth
   * convergence lands. Surfaced here so a route never has to infer it.
   */
  netWorthParticipation: "LEGACY_BALANCE_COLUMN" | "WITHHELD_PENDING_CONVERGENCE" | "NONE";
  /** W-M2a — the generic code recorded on the Connection. Present on failure. */
  errorCode?: WalletSyncErrorCode;
  /** The adapter's own result, for logging. NEVER branched on by a caller. */
  raw?: unknown;
  /**
   * W6f — what the post-sync history refresh did, when the chain has one.
   * Absent for a chain with no reconstruction and for a failed sync.
   */
  historyRefresh?: WalletHistoryRefresh;
  /**
   * The adapter's HISTORICAL transaction import, when the chain has one (BTC).
   * Reported separately because it is separate: an `ok` sync whose import FAILED
   * wrote the current position and valuation and kept the previous history —
   * partial freshness, which the refresh ledger records as PARTIAL and the UI
   * can say out loud. Absent for chains without an import and for failed syncs.
   */
  transactionImport?:
    | { status: "IMPORTED"; written: number }
    | { status: "FAILED"; reason: string };
  /**
   * The valuation of the quantity an `ok` sync observed (BTC). UNAVAILABLE ⇒ the
   * position is current and unpriced: a PARTIAL run, never a failed one and
   * never a clean one.
   */
  valuation?:
    | { status: "PRICED" }
    | { status: "UNAVAILABLE"; reason: string };
}

interface ChainAdapter {
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
  sync(accountId: string): Promise<{
    ok: boolean; syncStatus?: "synced" | "pending"; stage?: string; reason?: string;
    transactionImport?: BtcTransactionImportOutcome;
    valuation?: BtcValuationOutcome;
  }>;
}

/**
 * THE registry. A chain absent from this map is UNSUPPORTED by sync — which is a
 * stated outcome, not a fall-through.
 */
const ADAPTERS: Readonly<Record<string, ChainAdapter>> = {
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
    sync: (id) => syncBtcWallet(id),
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
    sync: (id) => syncEthWallet(id),
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
    sync: (id) => syncEvmWallet(id, BNB_NETWORK),
  },
  [AVAX_CHAIN]: {
    support: "CURRENT_POSITION_SUPPORTED",
    netWorthParticipation: "WITHHELD_PENDING_CONVERGENCE",
    historicalQuantityAuthority: "SPINE",
    currentValueAuthority: "SPINE",
    sync: (id) => syncEvmWallet(id, AVAX_NETWORK),
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
    sync: (id) => syncSolWallet(id),
  },
};

/** Every chain this system can actually read, sorted. Display and diagnostics. */
export const SYNCABLE_CHAINS: readonly string[] = Object.keys(ADAPTERS).sort();

/** How far this system can go on `chain`. Unknown/absent ⇒ UNSUPPORTED. */
export function walletChainSupport(chain: string | null | undefined): WalletChainSupport {
  if (!chain) return "UNSUPPORTED";
  return ADAPTERS[chain.trim().toUpperCase()]?.support ?? "UNSUPPORTED";
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
  return ADAPTERS[chain.trim().toUpperCase()]?.currentValueAuthority === "LEGACY_COLUMN";
}

export function feedsLegacyWealthHistory(chain: string | null | undefined): boolean {
  if (!chain) return false;
  return ADAPTERS[chain.trim().toUpperCase()]?.historicalQuantityAuthority === "LEGACY_COLUMN";
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

/**
 * Did this run produce NEW VALUATION evidence — the input snapshot and wealth
 * regeneration rebuild from? An `ok` BTC run whose close was unavailable wrote a
 * fresh quantity to the spine but left the legacy USD pair and clock untouched;
 * regenerating from it would re-publish the last priced figure as today's. One
 * predicate, used by the manual route and the scheduled sweep alike.
 */
export function outcomeRevalued(outcome: Pick<WalletSyncOutcome, "ok" | "valuation">): boolean {
  return outcome.ok && outcome.valuation?.status !== "UNAVAILABLE";
}

/**
 * Sync one wallet through its chain's adapter.
 *
 * Never throws: every adapter already carries a never-throw contract, and an
 * unexpected throw is caught here so one chain's defect cannot break a route
 * that serves three.
 *
 * An UNSUPPORTED chain is refused with a reason naming the chain and what IS
 * supported — never a generic failure, and never a silent success that would
 * leave the account looking synced while nothing was read.
 */
export async function syncWalletByChain(
  accountId: string,
  chain: string | null | undefined,
  context: WalletSyncContext = {},
): Promise<WalletSyncOutcome> {
  const key = chain?.trim().toUpperCase() ?? "";
  const adapter = ADAPTERS[key];

  if (!adapter) {
    await recordWalletSyncRefusal({ financialAccountId: accountId, errorCode: "CHAIN_UNSUPPORTED" });
    return {
      accountId,
      chain: key || "(none)",
      support: "UNSUPPORTED",
      ok: false,
      stage: "unsupported-chain",
      errorCode: "CHAIN_UNSUPPORTED",
      reason:
        `Fourth Meridian cannot read ${key || "this"} wallets yet. ` +
        `Balance sync is available for ${SYNCABLE_CHAINS.join(", ")}. ` +
        "The wallet stays recorded and visible; only its balance is unavailable.",
      netWorthParticipation: "NONE",
    };
  }

  // PLATFORM OPS OBSERVABILITY — the adapter run and the history refresh are
  // recorded as stages of ONE execution. The runner below never throws (every
  // branch returns an outcome), so runFullRefresh never rethrows and the
  // never-throw contract of this function is preserved by construction.
  const runner = async ({ recorder }: { recorder: RefreshStageRecorder }): Promise<WalletSyncOutcome> => {
  try {
    recorder.begin("WALLET_SYNC", "PROVIDER");
    const result = await adapter.sync(accountId);
    if (result.ok) recorder.succeed("WALLET_SYNC");
    else recorder.fail("WALLET_SYNC", new Error(result.reason ?? `wallet sync failed at ${result.stage ?? "unknown"} stage`));
    // THE HISTORICAL IMPORT IS ITS OWN STAGE. It ran inside the adapter call, so
    // it is recorded with the adapter's own clock. A FAILED import on an `ok`
    // sync makes the execution PARTIAL: the position and valuation advanced, the
    // transaction history did not. Before this, a mempool.space outage spent the
    // full timeout inside a WALLET_SYNC recorded as a clean SUCCEEDED, and the
    // only trace was a console warning.
    // VALUATION likewise: the quantity is current whether or not a close exists.
    const valuation = result.valuation;
    if (valuation) {
      recorder.recordMeasured("VALUATION", "DERIVED", valuation.status === "PRICED"
        ? { ok: true, startedAt: valuation.startedAt, durationMs: valuation.durationMs, facts: { coveredAccountIds: [accountId] } }
        : { ok: false, startedAt: valuation.startedAt, durationMs: valuation.durationMs, err: new Error(valuation.reason) });
    }
    const txImport = result.transactionImport;
    if (txImport) {
      recorder.recordMeasured("TRANSACTIONS", "PROVIDER", txImport.status === "IMPORTED"
        ? { ok: true, startedAt: txImport.startedAt, durationMs: txImport.durationMs,
            facts: { recordsRead: txImport.fetched, recordsWritten: txImport.written, recordsChanged: txImport.written, coveredAccountIds: [accountId] } }
        : { ok: false, startedAt: txImport.startedAt, durationMs: txImport.durationMs, err: new Error(txImport.reason) });
    }
    // W-M2a — A REFUSAL MUST REACH THE CONNECTION, NOT ONLY THE INCIDENT LOG.
    //
    // Every adapter already records a SyncIssue. None of them (outside BTC's
    // xpub branch) told `Connection.errorCode`, which is the field the
    // Connections surface actually derives state from — so a terminal refusal
    // left the connection saying nothing, and "nothing" was read as "still
    // working". Recorded HERE so every chain gets it from one place, and
    // conditionally so an adapter's own more specific diagnosis always wins.
    const errorCode = result.ok ? undefined : walletSyncErrorCode(result.stage);
    if (errorCode) await recordWalletSyncRefusal({ financialAccountId: accountId, errorCode });

    // ── W6f — A SUCCESSFUL SYNC REFRESHES THE HISTORY IT JUST CHANGED ────────
    //
    // The adapter has read the balance and imported whatever movements are new.
    // Until this call existed, that was where a sync stopped: the reconstructed
    // timeline and its coverage licence were whatever the last MANUAL run left
    // behind, and both reconstructions had zero production callers. A wallet
    // could receive a hundred BTC and the year chart would go on drawing the old
    // quantity — correctly labelled, coverage-licensed, and stale.
    //
    // Only on `ok`: a sync that could not read the chain has no new evidence to
    // reconstruct from, and re-running against a failed acquisition is how a
    // provider outage turns into a narrower history.
    //
    // Never fatal. The reconstruction refuses before it opens a write
    // transaction, so a refusal leaves the previous rows and licence exactly
    // where they were, and the balance this sync DID read is still reported.
    if (result.ok) recorder.begin("HISTORY_BACKFILL", "DERIVED");
    const historyRefresh = result.ok ? await refreshWalletHistory(accountId, key) : null;
    if (historyRefresh && !historyRefresh.refreshed && historyRefresh.reason) {
      console.log(`[wallet-sync] ${key} history not refreshed for ${accountId}: ${historyRefresh.reason}`);
    }
    recordHistoryStage(recorder, historyRefresh);
    return {
      accountId,
      chain: key,
      support: adapter.support,
      ok: result.ok,
      syncStatus: result.syncStatus,
      stage: result.stage,
      reason: result.reason,
      errorCode,
      // A FAILED sync contributes nothing to net worth whatever the chain
      // normally does — reporting the chain's usual participation on a run that
      // wrote nothing would overstate what the row now contains.
      netWorthParticipation: result.ok ? adapter.netWorthParticipation : "NONE",
      // W6f — so the caller can bound its snapshot regeneration to the window
      // whose evidence actually moved, instead of guessing or rebuilding all.
      historyRefresh: historyRefresh ?? undefined,
      transactionImport: txImport
        ? (txImport.status === "IMPORTED"
            ? { status: "IMPORTED", written: txImport.written }
            : { status: "FAILED", reason: txImport.reason })
        : undefined,
      valuation: valuation
        ? (valuation.status === "PRICED" ? { status: "PRICED" } : { status: "UNAVAILABLE", reason: valuation.reason })
        : undefined,
      raw: result,
    };
  } catch (e) {
    // Defensive: every adapter promises not to throw. If one does, the route
    // must still answer honestly rather than 500.
    const reason = e instanceof Error ? e.message : String(e);
    console.warn(`[wallet-sync] ${key} adapter threw for ${accountId} (contract violation):`, reason);
    recorder.failOpen(e);
    await recordWalletSyncRefusal({ financialAccountId: accountId, errorCode: "ADAPTER_ERROR" });
    return {
      accountId, chain: key, support: adapter.support, ok: false,
      stage: "adapter-error", reason, errorCode: "ADAPTER_ERROR",
      netWorthParticipation: "NONE",
    };
  }
  };

  return runFullRefresh<WalletSyncOutcome>(
    {
      source: { kind: "WALLET", ref: accountId, network: key },
      trigger: walletRefreshTrigger(context.trigger),
      profile: "WALLET_SYNC",
    },
    {
      refresh: runner,
      // The adapter names its own failed stage ("balance", "price", "capture",
      // …) and the dispatcher's generic code classifies it — both facts this
      // envelope cannot read off a stage record, so they are contributed here.
      verdict: ({ result }) =>
        result && !result.ok
          ? {
              failureStage: result.stage,
              failureCategory: classifyFailureCategory({ code: result.errorCode, message: result.reason }),
            }
          : undefined,
    },
  );
}

/**
 * The history refresh as a DERIVED stage. What it PROVES about canonical
 * history rows is reported as counts, so the execution's outcome can be
 * derived rather than asserted:
 *   refreshed, NO_CHANGE mode  → the reconstruction verified nothing moved (0/0)
 *   refreshed, rows written    → UPDATED (the writer's own count)
 *   refreshed, count unknown   → succeeded with no count (outcome stays unknown)
 *   not refreshed              → SKIPPED / NOT_APPLICABLE (no reconstruction for
 *                                the chain, or the reconstruction refused —
 *                                nothing was written, nothing is claimed)
 */
function recordHistoryStage(recorder: RefreshStageRecorder, h: WalletHistoryRefresh | null): void {
  if (!h) return;
  if (!h.refreshed) {
    recorder.skip("HISTORY_BACKFILL", "DERIVED", "NOT_APPLICABLE");
    return;
  }
  if (h.mode === "NO_CHANGE") {
    recorder.succeed("HISTORY_BACKFILL", { recordsWritten: 0, recordsChanged: 0 });
    return;
  }
  recorder.succeed(
    "HISTORY_BACKFILL",
    h.rowsWritten == null ? undefined : { recordsWritten: h.rowsWritten, recordsChanged: h.rowsWritten },
  );
}
