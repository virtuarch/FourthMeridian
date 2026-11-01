/**
 * lib/crypto/spl-history.ts
 *
 * SPL TOKEN HISTORY — fetch, walk, decide, commit. The proof rules live in
 * spl-history.core.ts; read that first.
 *
 * ONE STEP, run inside the SOL history backfill (sol-history-backfill.store.ts)
 * AFTER the native run, on the SAME deadline, request budget, rate limiter and
 * request meter — so it spends the shared Alchemy budget (ApiUsageCounter,
 * ALCHEMY/solana) exactly as native SOL does, and never past what the caller
 * allotted:
 *
 *   1. ANCHOR     getTokenAccountsByOwner, classic SPL + Token-2022 (2 calls):
 *                 every current token account and its raw amount — the
 *                 independent statement each replay must end on.
 *   2. CHECK      Token-2022 mints: getAccountInfo (jsonParsed), once per mint,
 *                 remembered — balance-changing extensions are refused.
 *   3. DISCOVER   (WALK source only) the wallet's own transactions, paged
 *                 backward, for token accounts it owned and has since closed.
 *   4. WALK       per token account, priced mints first: new activity above
 *                 its top (`until`), then older history below its bottom,
 *                 until its creation — continuity-proven, chunk by chunk.
 *   5. DECIDE     per mint (core `decideMint`), and COMMIT the mint's licensed
 *                 rows + coverage in ONE transaction with the checkpoint.
 *
 * The state lives in the SOL checkpoint's `tokens` member (Connection.cursor),
 * written by compare-and-swap like every native commit — no migration. Stopping
 * is always safe: what was committed is proven; what was not is re-fetched.
 *
 * `headOnly` (a wallet sync while the background worker carries history) runs
 * 1, 2, the head half of 4 and 5 — never the expensive backward walks.
 */

import { parseSplTokenAccounts, baseUnitsToWhole, SOLANA_TOKEN_PROGRAMS } from "./token-asset";
import {
  extendBackward, extendForward, orderSameSlot, SolProofDataError, SOL_BACKFILL_CURSOR_KIND,
  type SolTxPoint, type SolBackfillCheckpoint,
} from "./sol-history-backfill.core";
import { SolTransportError, CheckpointConflictError, type SolRpcCall } from "./sol-history-backfill";
import {
  HEAD_MISMATCH_LIMIT, MAX_DAYS_PER_ACCOUNT, MAX_PENDING_DISCOVERED, MAX_STAGED_DAYS_TOTAL, REASON_CAVEAT, SPL_CONTINUITY_SOURCE,
  deadMints, demoteToWalk, frozenNewcomers, frozenPremise, nativeWatchIntact, overflowCount, overflowedMints, premiseReason, resetAccount, retryableReason, rewriteFrom, splWorkOwed, stagedDays,
  ABSENT, accountWalked, continueDecision, coverageForDecision, currentByAddress, decideMint, discoverOwnedTokenAccounts,
  discoveryComplete, endOfDayKeys, freshSplState, inventoryCompleteOf, matchesAnchor, mergeDays,
  mergeDiscovered, mintDailyRaw, mintExtensionVerdict, needsExtensionCheck, orderMints, ownedMintsIn, parseSplState, tokenPointFromTransaction,
  trimDays, currentStateKey, SPL_PRICE_RUN_SEVERITY,
  type DiscoveredTokenAccount, type SplPriceRunStatus, type MintDecision, type SplAccountState, type SplUnsupportedReason, type SplHistoryState, type SplMintState, type SplTxView,
} from "./spl-history.core";
import type { ChainCoverage } from "./chain-movement";

const SIGNATURE_PAGE_SIZE = 1000;
const TX_CACHE_MAX = 2000;

export interface SplMintWrite {
  mint: string;
  decimals: number;
  program: string | null;
  /** First licence (or a refusal): every DERIVED row of this source for the instrument goes. */
  replaceAll: boolean;
  /** Rows rewritten in [deleteFromISO, deleteToISO]. */
  deleteFromISO: string | null;
  deleteToISO: string | null;
  /** A licence whose start moved later: rows before this date are withdrawn. */
  deleteBeforeISO?: string | null;
  rows: Array<{ dateISO: string; quantity: number }>;
  coverage: ChainCoverage;
}

export interface SplCommit {
  /** The cursor this run last read or wrote — compare-and-swap. */
  expectedCursor: string;
  nextCursor: string;
  mint?: SplMintWrite;
}

export interface SplHistoryStore {
  readCursor(): Promise<string | null>;
  /** One transaction. Throws CheckpointConflictError when the cursor is not `expectedCursor`. */
  commit(c: SplCommit): Promise<void>;
  /** Mints with a market price (current quote ever priced, or any stored price) — work-order input only. */
  pricedMints(mints: readonly string[]): Promise<Set<string>>;
  /**
   * Historical USD closes for a mint whose licence was just committed
   * (lib/prices/token-history-prices.ts). Optional: absent ⇒ no price acquisition.
   */
  acquirePrices?(m: { mint: string; decimals: number; program: string | null; fromISO: string; toISO: string }): Promise<{
    inserted: number; earliestISO: string | null;
    /** The shared path's status; "BUDGET" stops pricing for this run. */
    status?: string;
    /** The first-time quote probe's step (spl-history-prices.ts); "REFUSED" ⇒ ALLOWANCE_EXHAUSTED. */
    probe?: string;
  }>;
}

export interface SplRunDeps {
  call: SolRpcCall;
  deadlineMs: number;
  now: () => number;
  /** Requests sent so far on the shared meter (the native run's included). */
  sent: () => number;
  /** Requests this step may send. Undefined ⇒ bounded by the deadline only. */
  requestBudget?: number;
  concurrency?: number;
}

export interface SplRunOutcome {
  stoppedBecause: "DONE" | "BUDGET" | "FAILURE" | "CONFLICT" | "SKIPPED";
  skipped?: string;
  rowsWritten: number;
  impactedFromISO: string | null;
  mintsCommitted: Array<{ mint: string; status: "COMPLETE" | "PARTIAL" | "UNSUPPORTED" }>;
  /** Mints sent back to be rebuilt from full evidence (their staged days could not compute a rewrite). */
  rebuilt: string[];
  signaturesProcessed: number;
  requests: number;
  pricesInserted: number;
  /**
   * Re-review F4 (SPL ≡ ERC-20) — how historical price acquisition ended: COMPLETE;
   * ALLOWANCE_EXHAUSTED when a never-priced (sold) mint needed a first-time quote
   * probe and the durable probe allowance was 0 (it stays NOT_VALUED_YET for a
   * later run); or BUDGET_STOPPED when the shared CoinGecko token share ran out
   * (the remaining committed mints were not priced this run); or STEP_FAILED when
   * the price/probe step threw for a mint (swallowed, the run continues). Worst wins. Never
   * silent: the job reports it as a PARTIAL outcome.
   */
  prices: { status: SplPriceRunStatus; reason: string | null; mintsSkipped: number };
  inventoryComplete: boolean;
  failure: { code: string; detail: string } | null;
}

export { SPL_PRICE_RUN_SEVERITY, type SplPriceRunStatus };

// ── Transport helpers ────────────────────────────────────────────────────────

interface SigRow { signature: string; slot: number; blockTime: number | null }

async function signaturePage(call: SolRpcCall, address: string, opts: { before?: string | null; until?: string | null }): Promise<SigRow[]> {
  const p: Record<string, unknown> = { limit: SIGNATURE_PAGE_SIZE, commitment: "finalized" };
  if (opts.before) p.before = opts.before;
  if (opts.until) p.until = opts.until;
  const r = await call("getSignaturesForAddress", [address, p]);
  if (!Array.isArray(r)) throw new SolTransportError("INVALID_DATA", "getSignaturesForAddress did not return an array");
  return r as SigRow[];
}

/** One run's transaction fetcher: jsonParsed, v0-aware, deduplicated by signature within the run. */
function txFetcher(call: SolRpcCall) {
  const cache = new Map<string, SplTxView>();
  return async (signature: string): Promise<SplTxView> => {
    const hit = cache.get(signature);
    if (hit) return hit;
    const r = await call("getTransaction", [signature, { commitment: "finalized", encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
    if (!r || typeof r !== "object") throw new SolTransportError("INVALID_DATA", `getTransaction(${signature}) returned no transaction`);
    if (cache.size >= TX_CACHE_MAX) cache.delete(cache.keys().next().value as string);
    cache.set(signature, r as SplTxView);
    return r as SplTxView;
  };
}

/** In-order prefix of transactions fetched before the stop condition or the first failure. */
async function fetchInOrder(
  get: (sig: string) => Promise<SplTxView>, sigs: readonly SigRow[], ctx: { concurrency: number; stop: () => boolean; room?: () => number },
): Promise<{ txs: SplTxView[]; error: SolTransportError | null; stoppedForBudget: boolean }> {
  const txs: SplTxView[] = [];
  let pool = Math.max(1, ctx.concurrency);
  for (let i = 0; i < sigs.length; ) {
    if (ctx.stop()) return { txs, error: null, stoppedForBudget: true };
    // Never send a batch wider than the request allowance left (no overshoot).
    const width = Math.min(pool, Math.max(1, Math.floor(ctx.room?.() ?? pool)));
    const batch = sigs.slice(i, i + width);
    const settled = await Promise.allSettled(batch.map((s) => get(s.signature)));
    for (const s of settled) {
      if (s.status === "rejected") {
        const e = s.reason;
        if (e instanceof SolTransportError && e.code === "PROVIDER_THROTTLED" && pool > 1) { pool = 1; break; }
        return { txs, error: e instanceof SolTransportError ? e : new SolTransportError("PROVIDER_ERROR", String(e)), stoppedForBudget: false };
      }
      txs.push(s.value);
    }
    i = txs.length;
  }
  return { txs, error: null, stoppedForBudget: false };
}

// ── The step ─────────────────────────────────────────────────────────────────

/**
 * Run one bounded SPL token-history step for an owner whose native SOL
 * checkpoint already exists. Never throws for provider or data failures — they
 * are outcomes, and native SOL is never affected by them.
 */
export async function runSplTokenHistory(
  args: {
    owner: string;
    store: SplHistoryStore;
    headOnly?: boolean;
    /** Token accounts the native run saw the wallet own (its transaction hook). */
    discovered?: readonly DiscoveredTokenAccount[];
    /**
     * Kept for the caller's signature. A token state is only ever started as
     * NATIVE by the native hook (annotateWithDiscoveries), which watched the
     * native commit; one this step starts itself is always a WALK.
     */
    freshSource?: "NATIVE" | "WALK";
  },
  deps: SplRunDeps,
): Promise<SplRunOutcome> {
  const owner = args.owner;
  const now = deps.now;
  const todayISO = new Date(now()).toISOString().slice(0, 10);
  const sent0 = deps.sent();
  const concurrency = deps.concurrency ?? 4;
  const outcome: SplRunOutcome = {
    stoppedBecause: "DONE", rowsWritten: 0, impactedFromISO: null, mintsCommitted: [], rebuilt: [],
    signaturesProcessed: 0, requests: 0, pricesInserted: 0, prices: { status: "COMPLETE", reason: null, mintsSkipped: 0 }, inventoryComplete: false, failure: null,
  };
  const done = (why: SplRunOutcome["stoppedBecause"]) => { outcome.stoppedBecause = why; outcome.requests = deps.sent() - sent0; return outcome; };
  const overBudget = () => now() >= deps.deadlineMs || (deps.requestBudget !== undefined && deps.sent() - sent0 >= deps.requestBudget);
  const room = () => (deps.requestBudget === undefined ? Number.POSITIVE_INFINITY : deps.requestBudget - (deps.sent() - sent0));
  const impacted = (d: string) => { if (outcome.impactedFromISO === null || d < outcome.impactedFromISO) outcome.impactedFromISO = d; };

  let raw = await args.store.readCursor();
  let native: (SolBackfillCheckpoint & { tokens?: unknown }) | null = null;
  try { native = raw ? JSON.parse(raw) : null; } catch { native = null; }
  if (!raw || !native || native.kind !== SOL_BACKFILL_CURSOR_KIND) { outcome.skipped = "no native SOL checkpoint yet"; return done("SKIPPED"); }
  if (!native.top) { outcome.skipped = "native SOL history has not proven its first transaction yet"; return done("SKIPPED"); }

  // A state first made HERE is always a WALK from the native ends as they are
  // now: only the hook (annotateWithDiscoveries), watching native commit by
  // commit, may start one as NATIVE.
  let state: SplHistoryState = parseSplState(native.tokens) ?? freshSplState("WALK", native);
  // A stretch of native history the discovery hook did not watch (the flag was
  // off) cannot vouch for discovery: NATIVE becomes a WALK, a WALK starts over.
  if (!nativeWatchIntact(state, native)) state = demoteToWalk(state, native);
  let priced = new Set<string>();
  let pricesBudgetStopped = false;
  const isPriced = (m: string) => priced.has(m);
  const accountsBefore = state.accounts.length;
  /** Did this run change the state beyond the last cursor it committed (e.g. a merge of finds)? */
  const mergedChanged = (st: SplHistoryState) => JSON.stringify(st) !== JSON.stringify((parseSplState((JSON.parse(raw!) as { tokens?: unknown }).tokens)));

  /** Persist `next` (and a mint's rows) by CAS from the cursor this step last read or wrote. */
  const commit = async (next: SplHistoryState, mint?: SplMintWrite) => {
    const nextNative = { ...native!, tokens: next };
    const nextRaw = JSON.stringify(nextNative);
    await args.store.commit({ expectedCursor: raw!, nextCursor: nextRaw, mint });
    raw = nextRaw; native = nextNative; state = next;
  };
  const bumpBackoff = (st: SplHistoryState): SplHistoryState =>
    ({ ...st, backoff: { count: (st.backoff?.count ?? 0) + 1, lastAtISO: new Date(now()).toISOString() } });
  const fail = async (code: string, detail: string) => {
    outcome.failure = { code, detail: detail.slice(0, 300) };
    // A run that committed progress, or a transient throttle, is not "unproductive".
    const madeProgress = outcome.signaturesProcessed > 0 || outcome.mintsCommitted.length > 0 || outcome.rebuilt.length > 0;
    const next = madeProgress ? { ...state, backoff: { count: 0, lastAtISO: null } }
      : code === "PROVIDER_THROTTLED" ? state : bumpBackoff(state);
    try { await commit({ ...next, lastRunAtISO: new Date(now()).toISOString() }); } catch { /* the proven state is already committed */ }
    return done("FAILURE");
  };

  const call = deps.call;
  const getTx = txFetcher(call);

  try {
    if (overBudget()) return done("BUDGET");

    // ── 1. ANCHOR ──────────────────────────────────────────────────────────
    const currentEntries: Array<{ tokenAccount: string; mint: string; program: string; amount: bigint; decimals: number }> = [];
    const unreadableMints = new Set<string>();
    let anchorReliable = true;
    for (const programId of SOLANA_TOKEN_PROGRAMS) {
      const r = await call("getTokenAccountsByOwner", [owner, { programId }, { encoding: "jsonParsed", commitment: "finalized" }]);
      let parsed;
      try { parsed = parseSplTokenAccounts({ result: r }, programId); }
      catch (e) { return await fail("INVALID_DATA", e instanceof Error ? e.message : String(e)); }
      currentEntries.push(...parsed.entries);
      for (const m of parsed.rejectedMints) unreadableMints.add(m);
      if (parsed.rejected > parsed.rejectedMints.length) anchorReliable = false; // an unreadable entry could be any account
    }
    const current = currentByAddress(currentEntries);
    const currentFor = (address: string) => current.get(address) ?? null;
    const hinted = [...(state.pendingDiscovered ?? []), ...(args.discovered ?? [])];
    priced = await args.store.pricedMints([...new Set([...state.mints.map((m) => m.mint), ...currentEntries.map((e) => e.mint), ...hinted.map((h) => h.mint)])]).catch(() => new Set<string>());
    // Every find placed in ONE priced-first merge (current accounts + the native hook's finds).
    state = mergeDiscovered({ ...state, pendingDiscovered: [] }, [
      ...currentEntries.map((e) => ({ address: e.tokenAccount, mint: e.mint, program: e.program, decimals: e.decimals })),
      ...hinted,
    ], isPriced);
    /** Can this account's current state be read from the anchor? */
    const anchorable = (a: SplAccountState) => anchorReliable && !a.mints.some((m) => unreadableMints.has(m));

    // ── 2. TOKEN-2022 CHECK ────────────────────────────────────────────────
    for (const m of orderMints(state.mints, isPriced)) {
      if (!needsExtensionCheck(m) || overBudget()) continue;
      const r = await call("getAccountInfo", [m.mint, { encoding: "jsonParsed", commitment: "finalized" }]);
      try {
        const verdict = mintExtensionVerdict(r);
        state = { ...state, mints: state.mints.map((x) => (x.mint === m.mint ? { ...x, extension: verdict } : x)) };
      } catch { /* unreadable: stays unchecked (PENDING), retried next run — never assumed safe */ }
    }

    // ── 3. DISCOVER (WALK source) ──────────────────────────────────────────
    if (!args.headOnly && state.discovery.source === "WALK" && !state.discovery.walkDone && !native.gap) {
      while (!state.discovery.walkDone) {
        if (overBudget()) { await commit(state); return done("BUDGET"); }
        const page = await signaturePage(call, owner, { before: state.discovery.walkBefore });
        const fetched = await fetchInOrder(getTx, page, { concurrency, stop: overBudget, room });
        const found: DiscoveredTokenAccount[] = [];
        for (const tx of fetched.txs) found.push(...discoverOwnedTokenAccounts(tx, owner));
        // Mints first seen in the walk are priced before they compete for slots.
        const unseen = [...new Set(found.map((f) => f.mint))].filter((x) => !priced.has(x) && !state.mints.some((y) => y.mint === x));
        if (unseen.length) {
          const more = await args.store.pricedMints(unseen).catch(() => new Set<string>());
          priced = new Set([...priced, ...more]);
        }
        // Discovery is a HINT, so a partially read page still contributes its
        // accounts — but the cursor advances only past a page read whole.
        let next = mergeDiscovered(state, found, isPriced);
        const whole = fetched.txs.length === page.length && !fetched.error;
        if (whole) {
          next = { ...next, discovery: { ...next.discovery,
            walkBefore: page.length ? page[page.length - 1].signature : next.discovery.walkBefore,
            walkDone: page.length < SIGNATURE_PAGE_SIZE,
            walkSignatures: next.discovery.walkSignatures + page.length } };
        }
        await commit(next);
        outcome.signaturesProcessed += fetched.txs.length;
        if (fetched.error) return await fail(fetched.error.code, fetched.error.message);
        if (!whole) return done("BUDGET");
      }
    }

    // ── 4. WALK each token account, priced mints first ─────────────────────
    const verified = new Set<string>();
    /** Record (durably, with the account) the earliest day whose staged state changed. */
    const dirty = (x: SplAccountState, d: string): SplAccountState => (x.dirtyFromISO && x.dirtyFromISO <= d ? x : { ...x, dirtyFromISO: d });
    const setAccount = (a: SplAccountState) => { state = { ...state, accounts: state.accounts.map((x) => (x.address === a.address ? a : x)) }; };
    const visited = new Set<string>();
    let stoppedForBudget = false;

    for (const m of orderMints(state.mints, isPriced)) {
      const dead = deadMints(state);
      // A final verdict owes no requests — except a FROZEN licence's later
      // accounts, walked to learn whether the licence still stands.
      const onlyNewcomers = dead.has(m.mint);
      const addrs = onlyNewcomers
        ? frozenNewcomers(m, state.accounts).filter((a) => !a.failure && !accountWalked(a)).map((a) => a.address)
        : state.accounts.filter((a) => a.mints.includes(m.mint)).map((a) => a.address);
      for (const addr of addrs) {
        if (visited.has(addr)) continue;
        visited.add(addr);
        let a = state.accounts.find((x) => x.address === addr)!;
        if (a.failure || (!onlyNewcomers && a.mints.every((x) => dead.has(x)))) continue;
        if (overBudget()) { stoppedForBudget = true; break; }

        // 4a. HEAD — activity newer than the proven top.
        let headComplete = true;
        if (a.top) {
          const top0: SolTxPoint = a.top;
          const newer: SigRow[] = [];
          for (let before: string | null = null; ; ) {
            if (overBudget()) { headComplete = false; break; }
            const page = await signaturePage(call, addr, { before, until: top0.signature });
            newer.push(...page);
            if (page.length < SIGNATURE_PAGE_SIZE) break;
            before = page[page.length - 1].signature;
          }
          const oldestFirst = headComplete ? newer.reverse().filter((r) => r.slot > top0.slot) : [];
          const fetched = await fetchInOrder(getTx, oldestFirst, { concurrency, stop: overBudget, room });
          if (fetched.txs.length < oldestFirst.length) headComplete = false;
          let pts: SolTxPoint[] = [];
          try {
            pts = fetched.txs.map((tx, i) => tokenPointFromTransaction(tx, oldestFirst[i].signature, addr, owner)).filter((p): p is SolTxPoint => p !== null);
          } catch (e) {
            if (!(e instanceof SolProofDataError)) throw e;
            a = { ...a, failure: "INVALID_DATA" }; setAccount(a); await commit(state); continue;
          }
          // Never take PART of a slot: within a slot the provider's order is not an execution order.
          if (!headComplete && fetched.txs.length < oldestFirst.length && fetched.txs.length > 0) {
            const cutSlot = oldestFirst[fetched.txs.length].slot;
            pts = pts.filter((p) => p.slot !== cutSlot);
          }
          const ordered = orderSameSlot(pts, top0.postLamports, "forward");
          const ext = extendForward(top0, ordered);
          outcome.signaturesProcessed += fetched.txs.length;
          if (ext.kind === "GAP") {
            // A transaction the index did not list, ABOVE what was proven: nothing newer can be verified.
            a = { ...a, failure: "RECONCILIATION_MISMATCH" }; setAccount(a); await commit(state); continue;
          }
          if (ext.points.length > 0) {
            a = capDays(dirty({ ...a, mints: ownedMintsIn(ext.points, a.mints), top: ext.points[ext.points.length - 1], days: mergeDays(a.days, endOfDayKeys(ext.points), "new"), signatures: a.signatures + ext.points.length }, ext.points[0].dateISO));
          }
          if (fetched.error) { setAccount(a); await commit(state); return await fail(fetched.error.code, fetched.error.message); }
          if (headComplete && anchorable(a)) {
            if (matchesAnchor(a.top!.postLamports, currentFor(addr))) {
              a = { ...a, verifiedAtISO: todayISO, headMismatches: 0 }; verified.add(addr);
            } else {
              a = { ...a, headMismatches: a.headMismatches + 1 };
            }
          }
          setAccount(a);
          if (ext.points.length > 0 || a.failure || a.headMismatches > 0) await commit(state);
          if (!headComplete) { stoppedForBudget = true; break; }
        }

        // 4b. HISTORY — older than the proven bottom, back to creation. Held
        // (not walked) while the checkpoint already stages its bound of days.
        while (!args.headOnly && !accountWalked(a) && !a.failure && stagedDays(state) < MAX_STAGED_DAYS_TOTAL) {
          if (overBudget()) { stoppedForBudget = true; break; }
          const listed = await signaturePage(call, addr, { before: a.pageBefore ?? a.bottom?.signature ?? null });
          const fullPage = listed.length === SIGNATURE_PAGE_SIZE;
          const page = a.bottom ? listed.filter((r) => r.slot < a.bottom!.slot) : listed;
          const fetched = await fetchInOrder(getTx, page, { concurrency, stop: overBudget, room });
          outcome.signaturesProcessed += fetched.txs.length;
          let pts: Array<{ p: SolTxPoint | null; slot: number }>;
          try {
            pts = fetched.txs.map((tx, i) => ({ p: tokenPointFromTransaction(tx, page[i].signature, addr, owner), slot: page[i].slot }));
          } catch (e) {
            if (!(e instanceof SolProofDataError)) throw e;
            a = { ...a, failure: "INVALID_DATA" }; setAccount(a); await commit(state); break;
          }
          // Defer a slot that may continue on the next page, and one cut short.
          const deferred = new Set<number>();
          if (fullPage && page.length > 0) deferred.add(page[page.length - 1].slot);
          if (fetched.txs.length < page.length) deferred.add(page[fetched.txs.length].slot);
          if (page.length > 0 && page.every((r) => deferred.has(r.slot)) && fetched.txs.length === page.length) deferred.clear();
          const kept = pts.filter((x) => !deferred.has(x.slot)).map((x) => x.p).filter((p): p is SolTxPoint => p !== null);
          const cur = currentFor(addr);
          const edge = a.bottom ? a.bottom.preLamports : cur ? currentStateKey(cur.mint, cur.amount) : null;
          const points = orderSameSlot(kept, edge, "backward");
          const pageDone = fetched.txs.length === page.length && !fetched.error && !fetched.stoppedForBudget;

          // A fresh account's newest proven state must be its CURRENT state (the anchor).
          if (!a.top && points.length > 0) {
            if (!anchorable(a)) break; // cannot verify this run; retried
            if (!matchesAnchor(points[0].postLamports, cur)) {
              a = { ...a, headMismatches: a.headMismatches + 1 };
              setAccount(a); await commit(state); break;
            }
          }
          if (!a.top && points.length === 0 && pageDone && !fullPage) {
            // No listed activity at all. Proven only if it carries nothing for the wallet now.
            if (!anchorable(a)) break;
            a = matchesAnchor(ABSENT, cur) && (!cur || cur.amount === BigInt(0))
              ? { ...a, creation: true, verifiedAtISO: todayISO, headMismatches: 0 }
              : { ...a, failure: "RECONCILIATION_MISMATCH" };
            if (!a.failure) verified.add(addr);
            setAccount(a); await commit(state); break;
          }

          // The next page lists BEFORE the oldest signature this page FETCHED and
          // kept — never one it listed but did not read (a budget stop), and never
          // into a deferred slot, so that slot is listed again whole.
          const nextPageBefore = (): string | null => {
            const keptRow = page.slice(0, fetched.txs.length).reverse().find((r) => !deferred.has(r.slot));
            if (keptRow) return keptRow.signature;
            return pageDone && listed.length ? listed[listed.length - 1].signature : a.pageBefore;
          };
          const ext = extendBackward(a.bottom, points);
          const reachedBeginning = pageDone && ext.kind === "OK" && !fullPage;
          if (ext.points.length > 0 || reachedBeginning || ext.kind === "GAP") {
            const wasFresh = !a.top;
            const newBottom = ext.points.length ? ext.points[ext.points.length - 1] : a.bottom;
            const top = a.top ?? ext.points[0] ?? null;
            const chainOrder = [...ext.points].reverse();
            const mints = ownedMintsIn(chainOrder, a.mints);
            let creation = a.creation;
            let provenFromISO = a.provenFromISO;
            if (ext.kind === "GAP" && newBottom) provenFromISO = newBottom.dateISO;
            else if (reachedBeginning && newBottom) {
              // Creation: the oldest listed transaction starts from no token account, or from zero.
              const pre = newBottom.preLamports;
              if (pre === ABSENT || pre.endsWith(":0")) creation = true;
              else provenFromISO = newBottom.dateISO; // existed with a balance before anything listed
            }
            a = capDays({
              ...a, mints, top, bottom: newBottom, creation, provenFromISO,
              days: mergeDays(a.days, endOfDayKeys(chainOrder), "existing"),
              pageBefore: nextPageBefore(),
              signatures: a.signatures + ext.points.length,
              ...(wasFresh && top ? { verifiedAtISO: todayISO, headMismatches: 0 } : {}),
            });
            if (wasFresh && top) verified.add(addr);
            if (chainOrder.length && !a.failure) a = dirty(a, chainOrder[0].dateISO);
            setAccount(a);
            await commit(state);
          } else if (!pageDone && fetched.txs.length === 0 && !fetched.error) {
            stoppedForBudget = true; break;
          } else if (listed.length > 0) {
            a = { ...a, pageBefore: nextPageBefore() };
            setAccount(a); await commit(state);
          }
          if (fetched.error) return await fail(fetched.error.code, fetched.error.message);
          if (fetched.stoppedForBudget) { stoppedForBudget = true; break; }
        }
        if (stoppedForBudget) break;
      }
      if (stoppedForBudget) break;
    }

    // Accounts not visited this run (budget) cannot be verified this run; their mints wait.

    // ── 5. DECIDE + COMMIT per mint ────────────────────────────────────────
    const discDone = discoveryComplete(state, native);
    /** Accounts whose every mint has a final verdict keep nothing staged (bounded checkpoint). */
    const clearDead = (st: SplHistoryState): SplAccountState[] => {
      const frozen = new Set(st.mints.filter((x) => x.frozen).map((x) => x.mint));
      const dead = new Set([...deadMints(st)].filter((x) => !frozen.has(x))); // a frozen licence's accounts are still checked
      return st.accounts.map((a) => (a.mints.length > 0 && a.mints.every((x) => dead.has(x)) && (a.days.length || a.dirtyFromISO) ? { ...a, days: [], dirtyFromISO: null } : a));
    };
    for (const m0 of orderMints(state.mints, isPriced)) {
      const m = state.mints.find((x) => x.mint === m0.mint)!;
      // Refusals are final, except a head mismatch (re-checked every run).
      if (m.status === "UNSUPPORTED" && !retryableReason(m.reason)) continue;
      const mine = state.accounts.filter((a) => a.mints.includes(m.mint));
      // A FROZEN licence is re-checked against its premise on EVERY run (an
      // untracked or later account withdraws it); otherwise it stays exactly as
      // proven — unless frozen for a head mismatch alone, which a later match thaws.
      const premise = frozenPremise(m, mine, overflowedMints(state));
      const withdrawFrozen = premise !== null && premise !== "HOLD";
      if (m.frozen && !withdrawFrozen && !(retryableReason(m.frozen) && !mine.some((a) => a.failure !== null))) continue;
      const base: SplMintState = m.frozen ? { ...m, status: m.frozenFrom ?? "PARTIAL" } : m;
      let d: MintDecision = withdrawFrozen
        ? { status: "UNSUPPORTED", reason: premise as SplUnsupportedReason, fromISO: null, toISO: null }
        : decideMint(base, mine, { discoveryComplete: discDone, verifiedThisRun: verified, todayISO, overflowed: overflowedMints(state) });
      d = continueDecision(base, d);
      if (d.status === "PENDING") continue;
      const committed = base.licensedToISO !== null && (base.status === "COMPLETE" || base.status === "PARTIAL");
      if (d.status === "UNSUPPORTED") {
        const reason = d.reason!;
        if (committed) {
          // A committed licence whose failure is about EXTENDING it (an account
          // it was computed from stopped verifying) is FROZEN: kept as proven
          // through its last day, persisted PARTIAL, never read as complete. A
          // failure that breaks its PREMISE — a refused extension, an untracked
          // account, or an account that joined later (its earlier balances are
          // unknown) — WITHDRAWS it below: those rows were never proven.
          const culprits = mine.filter((a) => a.failure !== null || (a.headMismatches >= HEAD_MISMATCH_LIMIT && !verified.has(a.address)));
          const licensed = new Set(m.licensedAccounts ?? []);
          if (!withdrawFrozen && !premiseReason(reason) && culprits.length > 0 && culprits.every((a) => licensed.has(a.address))) {
            if (m.frozen === reason) continue; // already said
            const frozen: SplMintState = { ...m, status: "PARTIAL", frozen: reason, frozenFrom: m.frozen ? m.frozenFrom ?? "PARTIAL" : (m.status as "COMPLETE" | "PARTIAL") };
            const next = { ...state, mints: state.mints.map((x) => (x.mint === m.mint ? frozen : x)) };
            await commit({ ...next, accounts: clearDead(next) }, {
              mint: m.mint, decimals: m.decimals, program: m.program, replaceAll: false, deleteFromISO: null, deleteToISO: null, rows: [],
              coverage: { kind: "PARTIAL", coveredFromISO: m.licensedFromISO, coveredToISO: m.licensedToISO, caveats: [REASON_CAVEAT[reason]], source: SPL_CONTINUITY_SOURCE },
            });
            outcome.mintsCommitted.push({ mint: m.mint, status: "PARTIAL" });
            continue;
          }
        } else if (m.status === "UNSUPPORTED" && m.reason === reason) continue; // already said
        const coverage = coverageForDecision(d)!;
        const refused: SplMintState = { ...m, status: "UNSUPPORTED", reason, licensedFromISO: null, licensedToISO: null,
          frozen: null, frozenFrom: null, licensedAccounts: null };
        const next = { ...state, mints: state.mints.map((x) => (x.mint === m.mint ? refused : x)) };
        await commit({ ...next, accounts: clearDead(next) },
          { mint: m.mint, decimals: m.decimals, program: m.program, replaceAll: true, deleteFromISO: null, deleteToISO: null, rows: [], coverage });
        outcome.mintsCommitted.push({ mint: m.mint, status: "UNSUPPORTED" });
        if (committed && base.licensedFromISO) impacted(base.licensedFromISO); // withdrawn rows change those days
        continue;
      }
      const fromISO = d.fromISO!;
      const toISO = d.toISO!;
      // Days to (re)write: everything on a first licence; otherwise from the
      // earliest day any of its accounts changed since it last committed (held
      // durably on the account), or the day after the old edge.
      const changed = mine.map((a) => a.dirtyFromISO).filter((x): x is string => !!x).sort()[0] ?? null;
      const afterOld = committed ? addDay(base.licensedToISO!) : fromISO;
      let spanFrom = committed ? [changed, afterOld].filter((x): x is string => !!x).sort()[0] : fromISO;
      if (spanFrom < fromISO) spanFrom = fromISO;
      // NEVER from a trimmed list: an account trimmed at an earlier commit is
      // exact only from its trim point. Either the rewrite can start there
      // (nothing that changed could alter the proven rows before it), or the
      // mint is REBUILT from full evidence — its accounts walked again from
      // nothing — and a committed licence is withdrawn meanwhile (its rows
      // may lack the newly found account), never overwritten with short sums.
      const exactFrom = rewriteFrom(m.mint, mine, spanFrom, committed);
      if (exactFrom === null) {
        const resetAddrs = new Set(mine.map((a) => a.address));
        const resetMints = new Set(mine.flatMap((a) => a.mints));
        const dead = deadMints(state);
        const pending = (x: SplMintState): SplMintState => ({ ...x, status: "PENDING", reason: null, licensedFromISO: null, licensedToISO: null,
          frozen: null, frozenFrom: null, licensedAccounts: null });
        await commit({
          ...state,
          accounts: state.accounts.map((a) => (resetAddrs.has(a.address) ? resetAccount(a) : a)),
          mints: state.mints.map((x) => (x.mint === m.mint || (resetMints.has(x.mint) && !dead.has(x.mint)) ? pending(x) : x)),
        }, committed ? {
          mint: m.mint, decimals: m.decimals, program: m.program, replaceAll: true, deleteFromISO: null, deleteToISO: null, rows: [],
          coverage: { kind: "UNKNOWN", caveats: ["PAGE_BUDGET_EXHAUSTED"], source: SPL_CONTINUITY_SOURCE },
        } : undefined);
        outcome.rebuilt.push(m.mint);
        if (committed && base.licensedFromISO) impacted(base.licensedFromISO);
        continue;
      }
      spanFrom = exactFrom;
      const startMoved = committed && fromISO !== base.licensedFromISO;
      if (committed && spanFrom > toISO && !startMoved && d.status === base.status && !m.frozen) continue; // nothing new
      const raws = spanFrom <= toISO ? mintDailyRaw(mine, m.mint, spanFrom, toISO) : [];
      const rows = raws.map((r) => ({ dateISO: r.dateISO, quantity: baseUnitsToWhole(r.raw, m.decimals) }));
      const coverage = coverageForDecision(d)!;
      const nextMint: SplMintState = { ...m, status: d.status, reason: null, licensedFromISO: fromISO, licensedToISO: toISO,
        frozen: null, frozenFrom: null, licensedAccounts: mine.map((a) => a.address) };
      const after = { ...state, mints: state.mints.map((x) => (x.mint === m.mint ? nextMint : x)) };
      // Once every mint of an account is committed (or refused for good), the
      // account keeps only what can carry into new days — and remembers, as
      // `trimmedFromISO`, from when its staged days are still exact.
      const dead = deadMints(after);
      // A mint frozen for a retryable reason may thaw and must then rewrite from
      // its old edge: its accounts are NOT settled (never trimmed, dirty kept).
      const settled = new Set(after.mints.filter((x) => (dead.has(x.mint) && !x.frozen)
        || (!x.frozen && x.licensedToISO && (x.status === "COMPLETE" || x.status === "PARTIAL"))
        || (x.frozen && !retryableReason(x.frozen))).map((x) => x.mint));
      const accounts = after.accounts.map((a) => {
        if (!a.mints.includes(m.mint) || !a.mints.every((x) => settled.has(x))) return a;
        const kept = trimDays(a.days, toISO);
        return { ...a, days: kept, dirtyFromISO: null, trimmedFromISO: kept.length < a.days.length ? kept[0]?.[0] ?? toISO : a.trimmedFromISO ?? null };
      });
      await commit({ ...after, accounts }, {
        mint: m.mint, decimals: m.decimals, program: m.program,
        replaceAll: !committed, deleteFromISO: committed && spanFrom <= toISO ? spanFrom : null, deleteToISO: committed && spanFrom <= toISO ? toISO : null,
        deleteBeforeISO: startMoved ? fromISO : null, rows, coverage,
      });
      outcome.mintsCommitted.push({ mint: m.mint, status: d.status });
      if (rows.length > 0) { outcome.rowsWritten += rows.length; impacted(rows[0].dateISO); }
      if (startMoved) impacted(base.licensedFromISO!);
      // Historical prices for the mint over its licence (bounded, shared, never invented).
      // EVERY licensed mint is handed over, not only the priced ones: a mint sold
      // before capture has no quote marker, and the store's first-time probe
      // (spl-history-prices.ts) decides — a mint with a marker is never probed.
      if (args.store.acquirePrices && pricesBudgetStopped) {
        outcome.prices.mintsSkipped++; // the token share is spent: not asked again this run (said, never silent)
      } else if (args.store.acquirePrices) {
        const markPrices = (status: SplPriceRunStatus, reason: string) => {
          if (SPL_PRICE_RUN_SEVERITY[status] > SPL_PRICE_RUN_SEVERITY[outcome.prices.status]) { outcome.prices.status = status; outcome.prices.reason = reason; }
        };
        try {
          const p = await args.store.acquirePrices({ mint: m.mint, decimals: m.decimals, program: m.program, fromISO, toISO });
          outcome.pricesInserted += p.inserted;
          if (p.inserted > 0 && p.earliestISO) impacted(p.earliestISO < fromISO ? fromISO : p.earliestISO);
          if (p.probe === "REFUSED") {
            outcome.prices.mintsSkipped++;
            markPrices("ALLOWANCE_EXHAUSTED", "quote-probe allowance exhausted; never-priced SPL mint(s) left NOT_VALUED_YET for a later run");
          }
          if (p.status === "BUDGET") {
            if (p.probe !== "REFUSED") outcome.prices.mintsSkipped++;
            pricesBudgetStopped = true; // a flag, not the status: a worse STEP_FAILED must not re-open spending
            markPrices("BUDGET_STOPPED", "CoinGecko token budget reached; remaining SPL mints not priced this run");
          }
        } catch (e) {
          // Retried on the next commit or tail; never fails the step — but never silent either.
          outcome.prices.mintsSkipped++;
          markPrices("STEP_FAILED", `SPL price/probe step failed; mint(s) not priced this run: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
        }
      }
    }

    const inv = inventoryCompleteOf(state, discDone);
    // BACKOFF: a run that owed work and moved nothing counts toward the worker's
    // daily backoff (an unreadable anchor, an uncheckable mint…); progress resets it.
    const progressed = outcome.signaturesProcessed > 0 || outcome.mintsCommitted.length > 0 || outcome.rebuilt.length > 0 || state.accounts.length > accountsBefore;
    const owed = splWorkOwed(state, { reachedBeginning: native.reachedBeginning, gap: native.gap, top: native.top, bottom: native.bottom });
    const prevBackoff = state.backoff ?? { count: 0, lastAtISO: null };
    const backoff = progressed || !owed ? { count: 0, lastAtISO: null } : { count: prevBackoff.count + 1, lastAtISO: new Date(now()).toISOString() };
    // A merge of queued / current finds is persisted even on a quiet run (else it is redone every wake).
    const merged = mergedChanged(state);
    if (merged || inv !== state.inventoryComplete || state.lastRunAtISO?.slice(0, 10) !== todayISO || backoff.count !== prevBackoff.count) {
      await commit({ ...state, inventoryComplete: inv, lastRunAtISO: new Date(now()).toISOString(), backoff });
    }
    outcome.inventoryComplete = inv;
    return done(stoppedForBudget ? "BUDGET" : "DONE");
  } catch (e) {
    if (e instanceof CheckpointConflictError) { outcome.failure = { code: "CHECKPOINT_CONFLICT", detail: e.message }; return done("CONFLICT"); }
    if (e instanceof SolTransportError) return await fail(e.code, e.message);
    if (e instanceof SolProofDataError) return await fail("INVALID_DATA", e.message);
    throw e;
  }
}

/** Bound one account's staged days: beyond the bound it is refused, and stages nothing. */
function capDays(a: SplAccountState): SplAccountState {
  if (a.days.length <= MAX_DAYS_PER_ACCOUNT) return a;
  // Never refused for activity: keep the NEWEST days and prove the account from
  // the first one kept (a later proven start — its mint reads PARTIAL with
  // PAGE_BUDGET_EXHAUSTED). Each kept day's end state is exact, so rows from it are.
  const days = a.days.slice(a.days.length - MAX_DAYS_PER_ACCOUNT);
  const from = days[0][0];
  return { ...a, days, creation: false, capped: true,
    provenFromISO: a.provenFromISO && a.provenFromISO > from ? a.provenFromISO : from,
    dirtyFromISO: a.dirtyFromISO && a.dirtyFromISO < from ? from : a.dirtyFromISO };
}

function addDay(iso: string): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

/**
 * The native run's transaction hook: collects token accounts the wallet owned
 * from every transaction the native backfill fetches (json encoding carries
 * pre/postTokenBalances too), so a fresh wallet's discovery costs nothing extra.
 */
export function createSplDiscoveryCollector(owner: string) {
  const found = new Map<string, DiscoveredTokenAccount>();
  return {
    observe(_signature: string, tx: unknown) {
      try {
        for (const d of discoverOwnedTokenAccounts(tx as SplTxView, owner)) {
          const k = `${d.address}|${d.mint}`;
          if (!found.has(k)) found.set(k, d);
        }
      } catch { /* a hint — never fails the native run */ }
    },
    all(): DiscoveredTokenAccount[] { return [...found.values()]; },
  };
}

/**
 * Fold the collector's finds into a native checkpoint about to be committed
 * (the native run's `annotateCheckpoint` hook), so discovery is durable at the
 * same commit that makes the native cursor move past those transactions.
 *
 * The finds are QUEUED (`pendingDiscovered`, bounded — past the bound the state
 * is saturated and no mint may read COMPLETE), not placed: placing needs the
 * priced-first order, which only the token step knows. And the commit's native
 * top/bottom are recorded as WATCHED (both sources): a later native move this
 * hook did not see breaks the watch (`nativeWatchIntact`) and discovery is
 * redone. `demote` (the caller found the watch already broken before this run)
 * makes that fallback here, at the first commit of the run.
 */
export function annotateWithDiscoveries(
  cp: SolBackfillCheckpoint & { tokens?: unknown },
  found: readonly DiscoveredTokenAccount[],
  freshSource: "NATIVE" | "WALK",
  opts: { demote?: boolean } = {},
): SolBackfillCheckpoint {
  // A state the hook starts is watched from this very commit.
  let state = parseSplState(cp.tokens) ?? freshSplState(freshSource, cp);
  if (opts.demote) state = demoteToWalk(state, cp);
  const tracked = new Set(state.accounts.flatMap((a) => a.mints.map((m) => `${a.address}|${m}`)));
  for (const [a, m] of state.overflowed ?? []) tracked.add(`${a}|${m}`); // already remembered: never re-queued
  const oMints = new Set(state.overflowMints ?? []);
  const pending = [...(state.pendingDiscovered ?? [])];
  const seen = new Set(pending.map((d) => `${d.address}|${d.mint}`));
  let full = false;
  for (const d of found) {
    const k = `${d.address}|${d.mint}`;
    if (tracked.has(k) || seen.has(k) || oMints.has(d.mint)) continue; // an overflowed mint is held already
    if (pending.length >= MAX_PENDING_DISCOVERED) { full = true; break; }
    pending.push(d); seen.add(k);
  }
  // No room to queue every find for priced-first placing: nothing is refused —
  // discovery falls back to a WALK (it merges priced-first, page by page, and
  // re-finds what was not queued). Discovery is not complete until it is done.
  if (full) state = demoteToWalk(state, cp);
  const saturated = state.overflowSaturated ?? false;
  const discovery = { ...state.discovery, watchedTop: cp.top?.signature ?? null, watchedBottom: cp.bottom?.signature ?? null };
  return { ...cp, tokens: { ...state, discovery, pendingDiscovered: pending, overflowMints: [...oMints], overflowSaturated: saturated,
    overflow: overflowCount(state.overflowed ?? [], oMints.size, saturated) } } as SolBackfillCheckpoint;
}
