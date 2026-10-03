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
import { refreshCurrentQuotesForChains } from "@/lib/prices/current-quotes";
import { syncEthWallet, ETH_CHAIN } from "@/lib/crypto/eth-sync";
import { syncSolWallet, SOL_CHAIN } from "@/lib/crypto/sol-sync";
import { syncEvmWallet } from "@/lib/crypto/evm-native";
import { BNB_NETWORK, AVAX_NETWORK } from "@/lib/crypto/evm-networks";
const BNB_CHAIN = BNB_NETWORK.chain;
const AVAX_CHAIN = AVAX_NETWORK.chain;
import { refreshWalletHistory, type WalletHistoryRefresh } from "./wallet-history-refresh";
import { coverageCanValue, type CryptoCloseCoverage } from "./crypto-close-coverage";
import { recordWalletSyncRefusal, recordWalletFacetSuccess } from "@/lib/accounts/wallet-connection";
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
import { WALLET_CHAIN_FACTS, SYNCABLE_CHAINS, type WalletChainFacts } from "./wallet-sync-dispatch.core";

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
 * CRYPTO-COPY-1 — THE PRODUCT-FACING SENTENCE FOR A FAILED WALLET SYNC.
 *
 * Pure, so it is testable without a provider and cannot drift from what is
 * recorded. Derived from the generic error code and the CLASSIFIED failure
 * category (`classifyFailureCategory`, the same classifier the refresh ledger's
 * verdict uses) rather than from pattern-matching the provider's prose a second
 * time — one classifier, two audiences.
 *
 * EVERY MESSAGE STATES WHAT SURVIVED. That is the point: a failed authoritative
 * quantity read writes nothing, so the previous position is still there, and a
 * user who is not told that reasonably assumes their balance was destroyed.
 */
export function walletSyncUserMessage(
  errorCode: WalletSyncErrorCode | undefined,
  reason: string | undefined,
  chain: string,
): string {
  switch (errorCode) {
    case "PROVIDER_NOT_CONFIGURED":
      return `Fourth Meridian is not configured to read ${chain} right now. Your recorded position is unchanged.`;
    case "INVALID_WALLET_ADDRESS":
      return "This wallet's address isn't valid for its chain, so it can't be read. Edit the address to fix it.";
    case "CHAIN_UNSUPPORTED":
      return `Fourth Meridian cannot read ${chain} wallets yet. The wallet stays recorded; only its balance is unavailable.`;
    case "POSITION_CAPTURE_UNAVAILABLE":
      return "The balance was read but couldn't be recorded, so nothing was changed. Try again shortly.";
    case "BALANCE_UNAVAILABLE": {
      // The abort that produced "This operation was aborted" classifies here.
      const category = classifyFailureCategory({ code: errorCode, message: reason });
      if (category === "PROVIDER_TIMEOUT") {
        return "Balance provider timed out. Existing position was kept.";
      }
      if (category === "PROVIDER_RATE_LIMITED") {
        return "The balance provider is rate-limiting us right now. Existing position was kept.";
      }
      if (category === "PROVIDER_AUTH") {
        return "The balance provider rejected our credentials. Existing position was kept.";
      }
      return `${chain} couldn't be read right now. Existing position was kept.`;
    }
    case "ADAPTER_ERROR":
    default:
      return "This wallet couldn't be refreshed right now. Existing position was kept.";
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
  /**
   * CRYPTO-COPY-1 — THE PRODUCT-FACING SENTENCE, on failure.
   *
   * `reason` is PROVIDER/IMPLEMENTATION language and stays exactly as it is: it
   * is the operator's evidence and it reaches SyncIssue, Connection.errorCode
   * and the refresh ledger unchanged. But it also reached the Refresh button
   * verbatim, so on 2026-10-01 the user was told
   *
   *     "network error: This operation was aborted"
   *
   * which is undici's `AbortError.message` describing the SERVER's own 10 s
   * timeout — and which reads as "your internet failed". The browser's network
   * was fine; there is no client-side timeout on this request at all.
   *
   * This field is the same fact in product language, derived from the classified
   * category so the two can never disagree. Absent on success.
   */
  userMessage?: string;
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
  /**
   * The chain's native-asset CURRENT quote, refreshed after an `ok` read.
   * REFRESHED carries the instruments whose quote CHANGED, so the caller can
   * regenerate today's snapshot for EVERY wallet holding them — a quote is
   * shared, and a Space the sync did not touch must not keep a value priced at
   * the previous one. Absent on a failed sync.
   */
  currentQuote?:
    | { status: "REFRESHED"; quotedAt: string; changedInstrumentIds: string[] }
    | { status: "UNAVAILABLE"; reason: string }
    | { status: "NOT_CONFIGURED" };
  /**
   * CRYPTO-LATCH-2 — HOW THIS CHAIN IS VALUED, STATED RATHER THAN INFERRED.
   *
   * Stamped from the registry so `outcomeRevalued` can be a pure predicate that
   * does not have to guess what an ABSENT `valuation` field means. Before this,
   * it guessed — and guessed wrong-but-useful (see `outcomeRevalued`).
   */
  valuationModel: WalletValuationModel;
  /**
   * CRYPTO-LATCH-1 — RAW_CLOSE archive maintenance, when the archive was short
   * and this run repaired it. Absent when nothing was needed.
   */
  closeCoverage?: CryptoCloseCoverage;
}

/**
 * WHERE A CHAIN'S VALUATION HAPPENS — and therefore what "this run produced new
 * valuation evidence" means for it.
 *
 * ADAPTER_VALUED    the adapter itself prices the quantity it just read and
 *                   reports a `valuation` outcome, because it writes a stored
 *                   USD figure that can be stale independently of the quantity.
 *                   Today: BTC (the legacy `balance` column).
 * READ_TIME_VALUED  the adapter stores QUANTITY ONLY and the value is derived
 *                   whenever someone reads it, from the spine and the dated
 *                   archive. There is no adapter valuation to succeed or fail,
 *                   so a successful quantity read IS new valuation evidence.
 *                   Today: ETH, SOL, BNB, AVAX.
 *
 * The distinction already existed in the code; it was simply never written
 * down, which is what let `outcomeRevalued` depend on an accident.
 */
export type WalletValuationModel = "ADAPTER_VALUED" | "READ_TIME_VALUED";

interface ChainAdapter extends WalletChainFacts {
  sync(accountId: string): Promise<{
    ok: boolean; syncStatus?: "synced" | "pending"; stage?: string; reason?: string;
    transactionImport?: BtcTransactionImportOutcome;
    valuation?: BtcValuationOutcome;
    closeCoverage?: CryptoCloseCoverage;
  }>;
}

/**
 * THE registry: each chain's FACTS (lib/crypto/wallet-sync-dispatch.core.ts —
 * the single authority for support, authorities, participation and valuation
 * model) composed with its sync adapter. A chain absent from this map is
 * UNSUPPORTED by sync — which is a stated outcome, not a fall-through.
 */
const SYNC_ADAPTERS: Readonly<Record<string, ChainAdapter["sync"]>> = {
  [BTC_CHAIN]: (id) => syncBtcWallet(id),
  [ETH_CHAIN]: (id) => syncEthWallet(id),
  [BNB_CHAIN]: (id) => syncEvmWallet(id, BNB_NETWORK),
  [AVAX_CHAIN]: (id) => syncEvmWallet(id, AVAX_NETWORK),
  [SOL_CHAIN]: (id) => syncSolWallet(id),
};

const ADAPTERS: Readonly<Record<string, ChainAdapter>> = Object.fromEntries(
  Object.entries(WALLET_CHAIN_FACTS).map(([chain, facts]) => [chain, { ...facts, sync: SYNC_ADAPTERS[chain] }]),
);

/**
 * The chains that have a sync adapter, sorted. Must equal SYNCABLE_CHAINS (the
 * chains that have facts) — lib/crypto/wallet-chain-facts-boundary.test.ts
 * asserts it, so a fact without an adapter (or the reverse) cannot ship.
 */
export const REGISTERED_ADAPTER_CHAINS: readonly string[] = Object.keys(SYNC_ADAPTERS).sort();

// PERF-3 — the fact predicates live with the facts (wallet-sync-dispatch.core.ts)
// so a READ can ask them without compiling every adapter; re-exported here so
// every existing importer is unchanged.
export {
  SYNCABLE_CHAINS, walletChainSupport, isSyncableChain,
  usesLegacyColumnForCurrentValue, feedsLegacyWealthHistory, chainSupportsHistory,
} from "./wallet-sync-dispatch.core";

/**
 * Did this run produce NEW VALUATION evidence — the input snapshot and wealth
 * regeneration rebuild from? An `ok` BTC run whose close was unavailable wrote a
 * fresh quantity to the spine but left the legacy USD pair and clock untouched;
 * regenerating from it would re-publish the last priced figure as today's. One
 * predicate, used by the manual route and the scheduled sweep alike.
 *
 * ── CRYPTO-LATCH-2 — the accident this removes ──────────────────────────────
 * This used to read `outcome.valuation?.status !== "UNAVAILABLE"`, so a chain
 * that reports NO valuation at all satisfied it through `undefined !==
 * "UNAVAILABLE"`. That was accidental, and on 2026-10-01 it was LOAD-BEARING:
 * it was the only reason a Solana sync regenerated wealth history, which was
 * the only thing that refilled the RAW_CLOSE archive, which was the only way
 * Bitcoin's valuation ever recovered. A BTC-only holder had no such accident
 * and stayed latched forever.
 *
 * Two things were wrong with depending on it. It made a correct-looking tidy-up
 * ("only regenerate when we actually revalued") silently weld the latch shut,
 * and it made the predicate answer "yes, revalued" for a run that valued
 * nothing. The meaning is now DECLARED per chain (`valuationModel`), and the
 * archive maintenance that Bitcoin's recovery depends on no longer rides on
 * another chain's sync at all (CRYPTO-LATCH-1), so nothing load-bearing is
 * left resting on an absent field.
 */
export function outcomeRevalued(
  outcome: Pick<WalletSyncOutcome, "ok" | "valuation" | "valuationModel">,
): boolean {
  if (!outcome.ok) return false;
  switch (outcome.valuationModel) {
    // The adapter OWES a valuation, so only a stated PRICED counts. An absent
    // valuation on a chain that should have produced one is a defect, and this
    // now fails CLOSED on it instead of reading it as success.
    case "ADAPTER_VALUED":   return outcome.valuation?.status === "PRICED";
    // The value is derived at READ time from the spine and the dated archive, so
    // there is no adapter valuation to succeed or fail and a successful quantity
    // read genuinely IS new valuation evidence. Stated, not inferred.
    case "READ_TIME_VALUED": return true;
  }
}

/** Did this run CHANGE the chain's stored current quote? */
export function outcomeRequoted(outcome: Pick<WalletSyncOutcome, "currentQuote">): boolean {
  return outcome.currentQuote?.status === "REFRESHED" && outcome.currentQuote.changedInstrumentIds.length > 0;
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
      // An unsupported chain has no valuation model of its own; READ_TIME_VALUED
      // is inert here because `ok:false` already short-circuits the predicate.
      valuationModel: "READ_TIME_VALUED",
      userMessage: walletSyncUserMessage("CHAIN_UNSUPPORTED", undefined, key || "this chain"),
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
    // CRYPTO-LATCH-1 — ARCHIVE MAINTENANCE IS ITS OWN STAGE, recorded only on
    // the runs where the archive was short. It ran INSIDE the adapter's price
    // authority (it is a prerequisite of valuation, not a consequence of it), so
    // it is recorded with the adapter's own clock, before VALUATION, in the
    // order the work actually happened.
    const coverage = result.closeCoverage;
    if (coverage) {
      const facts = { recordsWritten: coverage.inserted, recordsChanged: coverage.inserted, coveredAccountIds: [accountId] };
      const measured = { startedAt: coverage.startedAt ?? new Date(), durationMs: coverage.durationMs ?? 0 };
      recorder.recordMeasured("PRICE_ARCHIVE", "PROVIDER", coverageCanValue(coverage)
        ? { ok: true, ...measured, facts }
        : { ok: false, ...measured, err: new Error(coverage.reason ?? `price archive ${coverage.status}`) });
    }
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
    // CURRENT QUOTE — after a successful read, the chain's native asset is
    // re-quoted so today's value is priced at the market, not yesterday's close.
    // Recorded as its own PROVIDER stage with its own clock; never gating.
    // ── CRYPTO-PARALLEL-1 — TWO INDEPENDENT NON-GATING STAGES, CONCURRENTLY ──
    //
    // The quote and the history reconstruction share nothing. Different
    // authority (CoinGecko vs the chain's own RPC/explorer), different output
    // (an INTRADAY PriceObservation vs DERIVED position rows), and neither reads
    // the other. Running them in series made the refresh take their SUM for no
    // reason: 8 124 ms + 253 ms on the incident's BTC run, 1 465 ms + 44 123 ms
    // on the Solana one.
    //
    // WHY THIS IS SAFE, not merely faster:
    //   · Both are gated on `result.ok` exactly as before, so NOTHING runs
    //     earlier relative to success than it used to.
    //   · Both are already non-gating: neither can change `ok`.
    //   · They cannot collide in the price archive. The quote writes INTRADAY;
    //     the reconstruction reads RAW_CLOSE. Basis isolation (lib/prices/archive)
    //     makes that a structural guarantee, not a timing accident.
    //   · Each carries its OWN measured clock, so stage timings stay truthful
    //     whichever finishes first.
    //   · FAILURE IS ISOLATED PER PROMISE: a rejection in one must not discard
    //     the other's completed result, which a bare Promise.all would do.
    //   · THE RECORDING ORDER IS FIXED below — quote, then history — so the
    //     ledger and the returned outcome do NOT depend on completion order.
    //
    // HISTORY_BACKFILL is opened before the work because `recorder.succeed`
    // takes its start clock from the open stage. CURRENT_QUOTE uses
    // `recordMeasured`, which never touches that open slot, so the two cannot
    // interleave in the recorder.
    if (result.ok) recorder.begin("HISTORY_BACKFILL", "DERIVED");
    const [quote, historyRefresh] = await Promise.all([
      result.ok
        ? refreshCurrentQuotesForChains([key]).catch((e) => {
            console.warn(`[wallet-sync] ${key} current-quote threw for ${accountId} (non-fatal):`, e instanceof Error ? e.message : e);
            return null;
          })
        : Promise.resolve(null),
      result.ok
        ? refreshWalletHistory(accountId, key).catch((e) => {
            // Contract says it never throws; if it does, the adapter's success
            // must still stand.
            console.warn(`[wallet-sync] ${key} history refresh threw for ${accountId} (contract violation):`, e instanceof Error ? e.message : e);
            return null;
          })
        : Promise.resolve(null),
    ]);

    if (quote) {
      if (quote.status === "NOT_CONFIGURED") recorder.skip("CURRENT_QUOTE", "PROVIDER", "NOT_APPLICABLE");
      else recorder.recordMeasured("CURRENT_QUOTE", "PROVIDER", quote.status === "REFRESHED"
        ? { ok: true, startedAt: quote.startedAt, durationMs: quote.durationMs, facts: { recordsRead: quote.instrumentIds.length, recordsWritten: quote.changedInstrumentIds.length, recordsChanged: quote.changedInstrumentIds.length } }
        : { ok: false, startedAt: quote.startedAt, durationMs: quote.durationMs, err: new Error(quote.reason) });
    }

    if (historyRefresh && !historyRefresh.refreshed && historyRefresh.reason) {
      console.log(`[wallet-sync] ${key} history not refreshed for ${accountId}: ${historyRefresh.reason}`);
    }
    // `begin` was called when result.ok, so the stage MUST be closed on that
    // same condition. A null here with an ok result means the never-throw
    // contract was violated above — record it as FAILED rather than leaving the
    // stage open for `failOpen` to mislabel later.
    if (result.ok && historyRefresh === null) {
      recorder.fail("HISTORY_BACKFILL", new Error("history refresh threw (contract violation)"));
    } else {
      recordHistoryStage(recorder, historyRefresh);
    }

    // ── CRYPTO-FRESHNESS-1 — PER-FACET SUCCESS CLOCKS ────────────────────────
    //
    // Recorded HERE because this is the one place that holds BOTH outcomes, and
    // recorded SEPARATELY because they are separate facts: a run whose import
    // aborted but whose reconstruction succeeded must advance exactly one clock.
    //
    // The alternative — what the card used to do — was to read
    // `Connection.lastSyncedAt` (a BALANCE clock) for both, which is how a
    // failed import came to render as "Transactions: Updated today".
    //
    // Each is passed only on success, so a failure leaves the previous
    // successful clock untouched rather than aging it or faking it.
    const txSucceeded      = txImport?.status === "IMPORTED";
    const historySucceeded = historyRefresh?.refreshed === true;
    if (txSucceeded || historySucceeded) {
      const at = new Date();
      await recordWalletFacetSuccess({
        financialAccountId: accountId,
        ...(txSucceeded      ? { transactionsSyncedAt: at } : {}),
        ...(historySucceeded ? { historyRebuiltAt: at }     : {}),
      });
    }
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
      // CRYPTO-LATCH-2 — declared by the registry, so `outcomeRevalued` never
      // has to infer what an absent `valuation` field means.
      valuationModel: adapter.valuationModel,
      ...(coverage ? { closeCoverage: coverage } : {}),
      // CRYPTO-COPY-1 — on failure only. `reason` keeps the provider's own text
      // for the operator; this is the same fact for the person who pressed
      // Refresh. Both travel, neither replaces the other.
      ...(result.ok ? {} : { userMessage: walletSyncUserMessage(errorCode, result.reason, key) }),
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
      currentQuote: quote
        ? (quote.status === "REFRESHED" ? { status: "REFRESHED", quotedAt: quote.quotedAt.toISOString(), changedInstrumentIds: quote.changedInstrumentIds }
          : quote.status === "UNAVAILABLE" ? { status: "UNAVAILABLE", reason: quote.reason }
          : { status: "NOT_CONFIGURED" })
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
      valuationModel: adapter.valuationModel,
      userMessage: walletSyncUserMessage("ADAPTER_ERROR", reason, key),
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
