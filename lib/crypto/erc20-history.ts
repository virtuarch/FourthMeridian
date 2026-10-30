/**
 * lib/crypto/erc20-history.ts
 *
 * One bounded, resumable step of a wallet's ERC-20 HISTORY (decisions and
 * state: erc20-history.core.ts). Never throws: a provider failure is a coded
 * failure on the section; scan progress already committed survives it.
 *
 *   SCAN      once per UTC day: pin the finalized head, then page the wallet's
 *             ERC-20 transfers since the last scanned block — `from` query, then
 *             `to` query — into the section's segment buffer. Committed (CAS) at
 *             the end of the scan phase, so a later step resumes at its pageKey.
 *   VERIFY    when no segment is open: for up to `maxTokensPerStep` contracts
 *             owing verification, priced tokens first, read `balanceOf` at the
 *             anchors (core `anchorPlan`) and judge them EXACTLY. A token whose
 *             anchors all match is VERIFIED: its rows (DERIVED, own source) and
 *             COMPLETE coverage are written; one that does not is UNSUPPORTED:
 *             its rows (if any) are deleted and UNKNOWN coverage with the
 *             reason is written. Rows, coverage, the regeneration marker and the
 *             section CAS commit in ONE transaction.
 *
 * Every call is counted into `deps.eth.meter` (the shared Alchemy ledger) and
 * the step stops BEFORE a call that would exceed `requestBudget` — throttle
 * retries included: each call's retries are bounded by what is left (S3).
 * The native ETH coverage, rows and checkpoint fields are never read or written here.
 *
 * FAILURE HANDLING (S1/S5 — the SPL conventions): a failed step bumps the
 * section's `failures` (a throttle does not); after ERC20_BACKOFF_AFTER the
 * wallet runs at most once a day; a scan stuck on one page restarts its
 * segment from fromBlock after ERC20_SEGMENT_RESTART_AFTER; an unreadable
 * transfer refuses its own contract only; a revert / non-standard balanceOf is
 * inconclusive and refuses a token only after ERC20_CALL_FAILURE_LIMIT spaced
 * verifications. An exact mismatch still refutes on the first read.
 */

import type { ChainCoverage } from "./chain-movement";
import { finalizedHead, blockTimeToDateISO, EthThrottleError, type EthHistoryDeps } from "./eth-history";
import { meterTotal } from "@/lib/usage/provider-budget.core";
import { fetchErc20TransfersPage, readBalancesAt } from "./erc20-history-rpc";
import {
  readErc20Section, withErc20Section, emptySection, applyTransfers, closeSegment, anchorPlan, judgeAnchors,
  derivedRows, rowsFromISO, markPersisted, markUnsupported, orderForVerification, replayConsistent, unsupportedCoverage,
  anchorsSampled, noteInconclusive, verifiedCoverage, ERC20_SEGMENT_RESTART_AFTER,
  type Erc20HistorySection, type Erc20UnsupportedReason, type Erc20DerivedRow, type TokenPriority, type Erc20HistoryConfig,
} from "./erc20-history.core";

export class Erc20CheckpointConflictError extends Error {
  constructor() { super("ERC-20 history checkpoint changed underneath this run"); }
}

/** A token the CURRENT capture (PR-A) knows for this account. */
export interface KnownToken {
  instrumentId: string;
  decimals: number;
  /** A market price exists for it (the Connections price-presence rule). */
  priced: boolean;
  /** The first day capture observed it. */
  firstObservedISO: string;
  /** Its latest observed quantity is > 0. */
  held: boolean;
}

/** One token's persisted outcome this step. */
export type Erc20TokenWrite =
  | { kind: "VERIFIED"; instrumentId: string; contract: string; replaceFromISO: string; rows: Erc20DerivedRow[]; coverage: ChainCoverage & { kind: "COMPLETE" } }
  | { kind: "UNSUPPORTED"; instrumentId: string; contract: string; coverage: ChainCoverage; reason: Erc20UnsupportedReason };

/** What a step reads and writes. Injectable: every path is testable without a database. */
export interface Erc20HistoryStore {
  walletAddress: string;
  readCursor(): Promise<string | null>;
  /** Compare-and-swap the checkpoint alone (scan progress, failures). */
  casCursor(expected: string | null, next: string): Promise<boolean>;
  /** Tokens current capture knows on this account, by lowercase contract. */
  knownTokens(): Promise<Map<string, KnownToken>>;
  /** The canonical instrument for a token seen only in transfers (created when absent). */
  resolveInstrument(contract: string, decimals: number): Promise<string>;
  /**
   * Rows + coverage for every write, and the checkpoint CAS, in ONE
   * transaction. Throws Erc20CheckpointConflictError when the CAS loses (all rolls back).
   */
  commit(args: { expectedCursor: string | null; nextCursor: string; writes: Erc20TokenWrite[] }): Promise<void>;
}

export interface Erc20HistoryStepDeps {
  config: Pick<Erc20HistoryConfig, "maxPagesPerStep" | "maxTokensPerStep" | "maxMonthAnchors" | "maxContracts">;
  /** Alchemy calls this step may send (the shared allowance and the per-step bound, whichever is lower). */
  requestBudget: number;
  /** Do not start another page or token after this instant. */
  deadlineMs?: number;
  now?: () => number;
  /** Transport, meter, backoff. `meter` counts every call. */
  eth?: EthHistoryDeps;
}

export interface Erc20HistoryOutcome {
  stoppedBecause: "FOREIGN_CHECKPOINT" | "NOTHING_OWED" | "BUDGET" | "DONE" | "FAILED" | "CONFLICT";
  requests: number;
  pagesRead: number;
  verified: string[];
  unsupported: Array<{ contract: string; reason: Erc20UnsupportedReason }>;
  /** Contracts whose verification was inconclusive this step (revert / non-standard; retried later). */
  inconclusive: string[];
  /** Contracts still owing verification after this step. */
  pending: number;
  /** Earliest day whose token rows changed (regeneration from here), or null. */
  impactedFromISO: string | null;
  /** Instruments verified this step (newly or extended). */
  verifiedInstrumentIds: string[];
  /**
   * B1 — historical-price candidates: EVERY verified token of the wallet (this
   * step's first), held now or not — a token sold before capture began has
   * reconstructed rows but no current quote, and must still be priced.
   */
  pricingCandidates: string[];
  failure: { code: string; detail: string } | null;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const minISO = (a: string | null, b: string | null) => (a === null ? b : b === null ? a : a < b ? a : b);

export async function runErc20HistoryStep(
  args: { accountId: string; store: Erc20HistoryStore; todayISO: string },
  deps: Erc20HistoryStepDeps,
): Promise<Erc20HistoryOutcome> {
  const { accountId, store, todayISO } = args;
  const now = deps.now ?? Date.now;
  const meter = deps.eth?.meter ?? {};
  const eth: EthHistoryDeps = { ...(deps.eth ?? {}), meter };
  const before = meterTotal(meter);
  const calls = () => meterTotal(meter) - before;
  const left = () => deps.requestBudget - calls();
  const timeLeft = () => now() < (deps.deadlineMs ?? Number.POSITIVE_INFINITY);
  const nowISO = () => new Date(now()).toISOString();
  /**
   * S3 — the transport for one call of `cost` requests: its throttle retries are
   * bounded so the call, retries included, never sends past `requestBudget`.
   * Every attempt is metered; the plan already checked left() ≥ cost.
   */
  const defaultRetries = deps.eth?.throttleRetries ?? 6;
  const ethFor = (cost: number): EthHistoryDeps => ({ ...eth, throttleRetries: Math.max(0, Math.min(defaultRetries, Math.floor(left() / Math.max(1, cost)) - 1)) });
  const cfg = deps.config;
  const wallet = store.walletAddress.toLowerCase();

  const out: Erc20HistoryOutcome = {
    stoppedBecause: "DONE", requests: 0, pagesRead: 0, verified: [], unsupported: [], inconclusive: [], pending: 0,
    impactedFromISO: null, verifiedInstrumentIds: [], pricingCandidates: [], failure: null,
  };
  const finish = (stoppedBecause: Erc20HistoryOutcome["stoppedBecause"], s: Erc20HistorySection | null) => {
    out.stoppedBecause = stoppedBecause;
    out.requests = calls();
    out.pending = s ? orderForVerification(s, () => 0, now()).length : 0;
    const verifiedIds = s ? Object.values(s.contracts).filter((c) => c.state === "VERIFIED" && c.instrumentId).map((c) => c.instrumentId!).sort() : [];
    out.pricingCandidates = [...new Set([...out.verifiedInstrumentIds, ...verifiedIds])];
    return out;
  };

  let raw = await store.readCursor();
  const host = readErc20Section(raw, accountId);
  if (host.host === "FOREIGN") return finish("FOREIGN_CHECKPOINT", null);
  let sec: Erc20HistorySection = host.section ?? emptySection();
  let counted = 0;
  const withUsage = (s: Erc20HistorySection): Erc20HistorySection => {
    const n = calls();
    const prev = s.usage && s.usage.dayISO === todayISO ? s.usage.requests : 0;
    return { ...s, usage: { dayISO: todayISO, requests: prev + Math.max(0, n - counted) } };
  };
  /** CAS the section alone. False ⇒ someone else advanced it. */
  const commitSection = async (next: Erc20HistorySection): Promise<boolean> => {
    const n = calls();
    const s = withUsage(next);
    const serialized = withErc20Section(raw, accountId, s);
    if (serialized === null || !(await store.casCursor(raw, serialized))) return false;
    raw = serialized; sec = s; counted = n;
    return true;
  };
  /** A throttle is the provider's capacity, not this wallet's failure: it never counts toward the backoff. */
  const failureCode = (e: unknown, code: string) => (e instanceof EthThrottleError ? "PROVIDER_THROTTLED" : code);
  const fail = async (code: string, detail: string): Promise<Erc20HistoryOutcome> => {
    out.failure = { code, detail };
    const failures = code === "PROVIDER_THROTTLED" ? sec.failures : sec.failures + 1;
    const ok = await commitSection({ ...sec, failures, lastFailure: { code, atISO: nowISO(), detail } });
    return finish(ok ? "FAILED" : "CONFLICT", sec);
  };

  // ── SCAN ────────────────────────────────────────────────────────────────
  let scanned = false;
  if (!sec.segment && (sec.lastScanDayISO ?? "") < todayISO) {
    if (left() < 1) return finish("BUDGET", sec);
    let head: { number: number; timestampSec: bigint };
    try { head = await finalizedHead(ethFor(1)); }
    catch (e) { return fail(failureCode(e, "PROVIDER_FAILED"), `finalized head read failed: ${msg(e)}`); }
    const fromBlock = sec.scannedToBlock === null ? 0 : sec.scannedToBlock + 1;
    if (head.number < fromBlock) sec = { ...sec, lastScanDayISO: todayISO };
    else sec = { ...sec, segment: { fromBlock, toBlock: head.number, toISO: blockTimeToDateISO(head.timestampSec), direction: "from", pageKey: null, pages: 0, buffer: {} } };
    scanned = true;
  }
  // S1 recovery — a scan that keeps failing on one page (an expired pageKey, a
  // page the provider cannot serve) restarts its segment from fromBlock. The
  // buffer and pageKey were committed together, so dropping both is exact.
  if (sec.segment?.pageKey && sec.lastFailure?.code === "SCAN_FAILED" && sec.failures >= ERC20_SEGMENT_RESTART_AFTER) {
    sec = { ...sec, segment: { ...sec.segment, direction: "from", pageKey: null, pages: 0, buffer: {}, refused: [] } };
    scanned = true; // the restart is committed with whatever this step reads
  }
  const seen = new Set<string>();
  while (sec.segment) {
    if (out.pagesRead >= cfg.maxPagesPerStep || left() < 1 || !timeLeft()) break;
    const seg = sec.segment;
    let page;
    try {
      page = await fetchErc20TransfersPage({ wallet, direction: seg.direction, fromBlock: seg.fromBlock, toBlock: seg.toBlock, pageKey: seg.pageKey }, ethFor(1));
    } catch (e) {
      // Pages read so far this step are kept (the commit below records them) — and
      // they are progress, so the failure count restarts from them.
      if (out.pagesRead > 0) await commitSection({ ...sec, failures: 0, lastFailure: null, lastProgressAtISO: nowISO() });
      else if (scanned) await commitSection(sec);
      return fail(failureCode(e, "SCAN_FAILED"), `transfer scan failed: ${msg(e)}`);
    }
    out.pagesRead++;
    scanned = true;
    const applied0 = applyTransfers(seg, page.transfers, wallet, seen);
    const applied = page.refused.length ? { ...applied0, refused: [...new Set([...(seg.refused ?? []), ...page.refused])].sort() } : applied0;
    if (page.pageKey) sec = { ...sec, segment: { ...applied, pageKey: page.pageKey, pages: seg.pages + 1 } };
    else if (seg.direction === "from") sec = { ...sec, segment: { ...applied, direction: "to", pageKey: null, pages: seg.pages + 1 } };
    else sec = { ...closeSegment({ ...sec, segment: applied }, cfg.maxContracts), lastScanDayISO: todayISO };
  }
  if (scanned) {
    if (!(await commitSection({ ...sec, failures: 0, lastFailure: null, lastProgressAtISO: nowISO() }))) return finish("CONFLICT", sec);
  }
  if (sec.segment) return finish("BUDGET", sec); // the scan resumes at its pageKey next step

  // ── VERIFY ──────────────────────────────────────────────────────────────
  let known: Map<string, KnownToken>;
  try { known = await store.knownTokens(); }
  catch (e) { return fail("STORE_FAILED", `known tokens unreadable: ${msg(e)}`); }

  // An observed token no transfer records (and observed before the scanned head's day) is unsupported —
  // unless contracts were left untracked (N2): its transfers may be among them, so nothing is claimed.
  if (sec.scannedToBlock !== null && sec.scannedToISO && sec.overflow === 0) {
    const contracts = { ...sec.contracts };
    for (const [contract, k] of known) {
      if (contracts[contract] || k.firstObservedISO >= sec.scannedToISO) continue;
      contracts[contract] = {
        decimals: k.decimals, firstBlock: 0, firstDayISO: k.firstObservedISO, transfers: 0, baseRaw: "0", days: [],
        state: "PENDING", reason: null, verifiedToBlock: null, persistedThroughISO: null, instrumentId: k.instrumentId,
      };
    }
    sec = { ...sec, contracts };
  }

  const priority = (c: string): TokenPriority => { const k = known.get(c); return !k ? 2 : k.priced ? 0 : 1; };
  const order = orderForVerification(sec, priority, now());
  if (order.length === 0) return finish(scanned ? "DONE" : "NOTHING_OWED", sec);

  const headBlock = sec.scannedToBlock!;
  const headISO = sec.scannedToISO!;
  const writes: Erc20TokenWrite[] = [];
  const contracts = { ...sec.contracts };
  let impacted: string | null = null;
  let budgetStop = false;
  const decide = async (contract: string, reason: Erc20UnsupportedReason, instrumentId: string | null) => {
    const c = contracts[contract];
    const wasVerified = c.state === "VERIFIED";
    contracts[contract] = markUnsupported(c, reason, instrumentId);
    out.unsupported.push({ contract, reason });
    if (instrumentId) {
      writes.push({ kind: "UNSUPPORTED", instrumentId, contract, coverage: unsupportedCoverage(reason), reason });
      // Rows written while it was verified are deleted: the history they told is refuted.
      if (wasVerified) impacted = minISO(impacted, c.firstDayISO);
    }
  };

  let tokensDone = 0;
  for (const contract of order) {
    if (tokensDone >= cfg.maxTokensPerStep || !timeLeft()) break;
    const c = contracts[contract];
    const k = known.get(contract);
    const decimals = k?.decimals ?? c.decimals;
    let instrumentId = c.instrumentId ?? k?.instrumentId ?? null;
    if (c.refusedReason) {
      // Evidence the scan could not read: refused before any call (rows, if any, deleted).
      await decide(contract, c.refusedReason, instrumentId);
      tokensDone++;
      continue;
    }
    if (decimals === null) {
      // No quantity can be stated: refused before any call. No instrument is created for an unknown-decimals token.
      await decide(contract, "DECIMALS_UNKNOWN", instrumentId);
      tokensDone++;
      continue;
    }
    if (!instrumentId) {
      try { instrumentId = await store.resolveInstrument(contract, decimals); }
      catch (e) { return fail("STORE_FAILED", `instrument for ${contract} unresolvable: ${msg(e)}`); }
    }
    if (c.transfers === 0) { await decide(contract, "NO_TRANSFER_RECORDS", instrumentId); tokensDone++; continue; }
    if (!replayConsistent(c)) { await decide(contract, "OPENING_BALANCE_UNEXPLAINED", instrumentId); tokensDone++; continue; }
    const plan = anchorPlan(c, headBlock, cfg.maxMonthAnchors);
    if (left() < plan.length) { budgetStop = true; break; }
    let reads;
    try { reads = await readBalancesAt({ contract, wallet, blocks: plan.map((a) => a.block) }, ethFor(plan.length)); }
    catch (e) {
      // Not an answer about the token: keep what was decided, record the failure after the commit.
      out.failure = { code: e instanceof EthThrottleError ? "PROVIDER_THROTTLED" : "PROVIDER_FAILED", detail: `balance anchors for ${contract} failed: ${msg(e)}` };
      break;
    }
    tokensDone++;
    const verdict = judgeAnchors(plan, reads);
    if (!verdict.verified) {
      // S5 — a revert / non-standard answer is INCONCLUSIVE: retried later, spaced;
      // only the ERC20_CALL_FAILURE_LIMIT-th refuses (rows of a verified token stay meanwhile).
      if (verdict.reason === "BALANCE_CALL_FAILED") {
        const n = noteInconclusive(c, nowISO());
        if (!n.refuse) { contracts[contract] = n.contract; out.inconclusive.push(contract); continue; }
      }
      await decide(contract, verdict.reason, instrumentId);
      continue;
    }
    const fromISO = rowsFromISO(c);
    const rows = derivedRows(c, decimals, fromISO, headISO);
    const persisted = markPersisted(c, headBlock, headISO, instrumentId, anchorsSampled(c, headBlock, cfg.maxMonthAnchors));
    writes.push({ kind: "VERIFIED", instrumentId, contract, replaceFromISO: fromISO, rows, coverage: verifiedCoverage(persisted, headISO) });
    contracts[contract] = persisted;
    out.verified.push(contract);
    out.verifiedInstrumentIds.push(instrumentId);
    impacted = minISO(impacted, fromISO);
  }

  const next: Erc20HistorySection = {
    ...sec, contracts,
    snapshotPendingFromISO: minISO(sec.snapshotPendingFromISO, impacted),
    ...(out.failure
      // Progress (rows written) resets the count; a throttle never adds to it.
      ? { failures: writes.length > 0 ? 0 : out.failure.code === "PROVIDER_THROTTLED" ? sec.failures : sec.failures + 1,
          lastFailure: { code: out.failure.code, atISO: nowISO(), detail: out.failure.detail } }
      : { failures: 0, lastFailure: null }),
    lastProgressAtISO: writes.length ? nowISO() : sec.lastProgressAtISO,
  };
  const changed = writes.length > 0 || out.unsupported.length > 0 || out.inconclusive.length > 0 || out.failure !== null;
  if (!changed) return finish(budgetStop ? "BUDGET" : "DONE", sec);
  const final = withUsage(next);
  const serialized = withErc20Section(raw, accountId, final);
  if (serialized === null) return finish("FOREIGN_CHECKPOINT", sec);
  try {
    await store.commit({ expectedCursor: raw, nextCursor: serialized, writes });
  } catch (e) {
    if (e instanceof Erc20CheckpointConflictError) return finish("CONFLICT", sec);
    out.verified = []; out.unsupported = []; out.inconclusive = []; out.verifiedInstrumentIds = [];
    return fail("STORE_FAILED", `token history write failed: ${msg(e)}`);
  }
  raw = serialized; sec = final; counted = calls();
  out.impactedFromISO = impacted;
  return finish(out.failure ? "FAILED" : budgetStop ? "BUDGET" : "DONE", sec);
}
