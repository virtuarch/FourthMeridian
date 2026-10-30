/**
 * lib/crypto/erc20-history.core.ts
 *
 * PURE. ERC-20 HISTORICAL token balances, reconstructed from transfer evidence
 * and VERIFIED against the chain before anything is licensed.
 *
 * ── THE EVIDENCE ────────────────────────────────────────────────────────────
 * `alchemy_getAssetTransfers` (category ["erc20"]), once with
 * fromAddress = wallet and once with toAddress = wallet, ascending by block,
 * paginated by pageKey, with metadata (block timestamps). Amounts come from
 * `rawContract.value` (hex base units) and decimals from `rawContract.decimal`
 * — the float `value` is never read. A mint is a transfer from 0x0 and a burn a
 * transfer to 0x0; both are ordinary transfers here. Transfers are grouped by
 * lowercase contract and summed per UTC day as BigInt.
 *
 * Each unique transfer is counted ONCE from its own from/to: delta =
 * (to = wallet ? +v : 0) − (from = wallet ? v : 0). The `from` query therefore
 * already accounts for a self-transfer (delta 0), and the `to` query skips
 * transfers whose sender is the wallet. Duplicates (same uniqueId) within a
 * step are dropped; order inside a day is irrelevant to an end-of-day sum.
 *
 * ── THE HONESTY MECHANISM: VERIFIED ANCHORS ─────────────────────────────────
 * Transfer events are what a token CHOOSES to emit. A rebasing token (balance
 * grows with no event), a fee-on-transfer token that logs the pre-fee amount,
 * or a contract that credits balances at genesis without an event all produce a
 * replay that looks perfectly plausible and is wrong. So no token is licensed on
 * the strength of its events alone. Its replay is reconciled against on-chain
 * `balanceOf(wallet)` via `eth_call` at historical blocks (the endpoint is an
 * archive node):
 *
 *   OPENING   the block before the first transfer — must be exactly 0;
 *   MONTH     the last block with activity in a bounded sample of active months
 *             (evenly spread, first and last included);
 *   HEAD      the scan's finalized head — must equal the replay's end balance.
 *
 * Every anchor must match EXACTLY (base units). Any mismatch ⇒ the token is
 * UNSUPPORTED at once (an exact value is deterministic evidence). A revert or a
 * non-standard return is INCONCLUSIVE on its own — a node can say "reverted" /
 * "out of gas" transiently — so it is retried on later steps, spaced
 * (`ERC20_CALL_RETRY_MS`), and refuses the token only after
 * `ERC20_CALL_FAILURE_LIMIT` consecutive inconclusive verifications. Refused ⇒ the token is UNSUPPORTED with a reason, no daily rows
 * are written for it (its current OBSERVED balance from capture stays the only
 * fact), and its evidence count is kept. Only a token whose every anchor matches
 * is VERIFIED: PositionCoverage COMPLETE over [first-transfer day, head day] and
 * daily DERIVED rows.
 *
 * Sampling is the stated limit: a mismatch strictly between two matching
 * anchors that cancels before the next one would not be seen. The anchors that
 * are checked are exact, and the head is re-checked on every extension. A
 * licence whose month anchors were SAMPLED (more active months than anchors)
 * carries the `TOKEN_ANCHORS_SAMPLED` caveat on its COMPLETE coverage, so the
 * limit is in the data, not only here.
 *
 * ── WHERE THE STATE LIVES ───────────────────────────────────────────────────
 * One per-wallet section (`Erc20HistorySection`), durable, compare-and-swapped
 * with the rows: inside the native ETH history checkpoint as `tokens` when one
 * exists on `Connection.historyCheckpoint`, otherwise a standalone
 * `kind: "erc20-history"` document in the same column (readErc20Section /
 * withErc20Section). Native fields are never read or changed by this module, and
 * native code paths carry `tokens` through untouched. No migration.
 */

import type { ChainCoverage, ChainCoverageCaveat } from "./chain-movement";
import { parseCheckpoint as parseEthCheckpoint, type EthBackfillCheckpoint } from "./eth-history-backfill.core";
import { baseUnitsToWhole, isValidDecimals, parseHexAmount } from "./token-asset";

/** PositionCoverage.source for a verified token licence. */
export const ERC20_HISTORY_SOURCE = "alchemy:erc20-transfers+balanceOf-anchors";
/** PositionObservation.source on every DERIVED token row this reconstruction owns. */
export const ERC20_RECONSTRUCTION_SOURCE = "erc20-reconstruction";
/** Stamped on every DERIVED token row; bumped by hand when the same evidence would write different rows. */
export const ERC20_RECONSTRUCTION_VERSION = 1;

export const ERC20_HISTORY_KIND = "erc20-history";
export const ERC20_HISTORY_VERSION = 1;

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
/** `balanceOf(address)` selector. */
export const BALANCE_OF_SELECTOR = "0x70a08231";

const ZERO = BigInt(0);

// ── Retry, backoff, recovery (the SPL conventions: spl-history.core) ────────

/** Consecutive failed steps after which a wallet runs at most once per `ERC20_BACKOFF_MS`. */
export const ERC20_BACKOFF_AFTER = 3;
export const ERC20_BACKOFF_MS = 24 * 60 * 60 * 1000;
/** Consecutive SCAN failures with an open pageKey after which the segment restarts from its fromBlock. */
export const ERC20_SEGMENT_RESTART_AFTER = 2;
/** Restarts of one segment before it is left to the backoff (re-review F3: a restart is not a cure). */
export const ERC20_SEGMENT_RESTART_LIMIT = 2;
/** Consecutive inconclusive (revert / non-standard) verifications before a token is refused (SPL: HEAD_MISMATCH_LIMIT). */
export const ERC20_CALL_FAILURE_LIMIT = 3;
/** An inconclusive token is not re-asked before this — a transient node fault gets time to clear. */
export const ERC20_CALL_RETRY_MS = 6 * 60 * 60 * 1000;

// ── Reasons ─────────────────────────────────────────────────────────────────

export type Erc20UnsupportedReason =
  /** On-chain balance ABOVE the replay at an anchor: balance changed without Transfer events. */
  | "REBASING_OR_NONSTANDARD"
  /** On-chain balance BELOW the replay at an anchor: transfers overstate what arrived. */
  | "FEE_ON_TRANSFER_OR_NONSTANDARD"
  /** A balance before the first recorded transfer (genesis credit without an event, or the replay ran negative). */
  | "OPENING_BALANCE_UNEXPLAINED"
  /** balanceOf reverted or returned a non-standard value. */
  | "BALANCE_CALL_FAILED"
  /** No decimals from the transfers or the token's metadata — no quantity can be stated. */
  | "DECIMALS_UNKNOWN"
  /** A transfer of this contract could not be read exactly (its sum would be silently wrong). */
  | "TRANSFER_UNREADABLE"
  /** A balance was observed but no transfer records it. */
  | "NO_TRANSFER_RECORDS";

/** The coverage caveat each reason is persisted as (UNKNOWN coverage — licenses nothing). */
export const REASON_CAVEAT: Readonly<Record<Erc20UnsupportedReason, ChainCoverageCaveat>> = {
  REBASING_OR_NONSTANDARD:        "TOKEN_REBASING_OR_NONSTANDARD",
  FEE_ON_TRANSFER_OR_NONSTANDARD: "TOKEN_FEE_ON_TRANSFER_OR_NONSTANDARD",
  OPENING_BALANCE_UNEXPLAINED:    "TOKEN_OPENING_BALANCE_UNEXPLAINED",
  BALANCE_CALL_FAILED:            "TOKEN_BALANCE_CALL_FAILED",
  DECIMALS_UNKNOWN:               "TOKEN_DECIMALS_UNKNOWN",
  TRANSFER_UNREADABLE:            "TOKEN_TRANSFER_UNREADABLE",
  NO_TRANSFER_RECORDS:            "TOKEN_NO_TRANSFER_RECORDS",
};

/** The reason a persisted token coverage carries, or null. */
export function unsupportedReasonOf(coverage: ChainCoverage | null | undefined): Erc20UnsupportedReason | null {
  if (!coverage || coverage.kind === "COMPLETE") return null;
  for (const [reason, caveat] of Object.entries(REASON_CAVEAT) as Array<[Erc20UnsupportedReason, ChainCoverageCaveat]>) {
    if (coverage.caveats.includes(caveat)) return reason;
  }
  return null;
}

/** The customer's words for a reason — plain, no jargon beyond what names the class. */
export function unsupportedReasonText(reason: Erc20UnsupportedReason | null | undefined): string {
  switch (reason) {
    case "REBASING_OR_NONSTANDARD":        return "its balance changes without transfer records (a rebasing or non-standard token)";
    case "FEE_ON_TRANSFER_OR_NONSTANDARD": return "its transfers don’t add up to its on-chain balance (a fee-on-transfer or non-standard token)";
    case "OPENING_BALANCE_UNEXPLAINED":    return "it held a balance before its first recorded transfer";
    case "BALANCE_CALL_FAILED":            return "its contract didn’t answer standard balance checks";
    case "DECIMALS_UNKNOWN":               return "its decimal places couldn’t be read";
    case "TRANSFER_UNREADABLE":            return "one of its transfer records couldn’t be read exactly";
    case "NO_TRANSFER_RECORDS":            return "no transfer records explain its balance";
    default:                               return "its history didn’t match the chain";
  }
}

/** The UNKNOWN coverage an unsupported token is persisted with. */
export function unsupportedCoverage(reason: Erc20UnsupportedReason): ChainCoverage {
  return { kind: "UNKNOWN", caveats: [REASON_CAVEAT[reason]], source: ERC20_HISTORY_SOURCE };
}

// ── Transfers ───────────────────────────────────────────────────────────────

export interface Erc20Transfer {
  contract: string;
  blockNum: number;
  logIndex: number;
  uniqueId: string;
  from: string;
  to: string;
  raw: bigint;
  decimals: number | null;
  dateISO: string;
}

const ADDR = /^0x[0-9a-fA-F]{40}$/;

/**
 * Parse one `alchemy_getAssetTransfers` result. THROWS on an error member or a
 * malformed envelope, and on a transfer whose CONTRACT cannot be read (it
 * cannot be attributed to any token). A transfer of a readable contract that
 * cannot be summed exactly is never skipped silently: that contract is
 * returned in `refused` (S1 — it alone is refused, TRANSFER_UNREADABLE, and
 * the rest of the wallet's tokens proceed) and none of its transfers on the
 * page are kept.
 */
export function parseAssetTransfers(result: unknown): { transfers: Erc20Transfer[]; pageKey: string | null; refused: string[] } {
  const r = result as { transfers?: unknown; pageKey?: unknown } | null;
  if (!r || typeof r !== "object" || !Array.isArray(r.transfers)) throw new Error("unexpected alchemy_getAssetTransfers result (missing transfers)");
  const transfers: Erc20Transfer[] = [];
  const refused = new Set<string>();
  for (const t of r.transfers as Array<Record<string, unknown>>) {
    const rc = (t?.rawContract ?? {}) as { value?: unknown; address?: unknown; decimal?: unknown };
    const contract = typeof rc.address === "string" && ADDR.test(rc.address) ? rc.address.toLowerCase() : null;
    const raw = rc.value === "0x" ? ZERO : parseHexAmount(rc.value);
    const blockNum = typeof t?.blockNum === "string" && /^0x[0-9a-fA-F]+$/.test(t.blockNum) ? Number(BigInt(t.blockNum)) : null;
    const uniqueId = typeof t?.uniqueId === "string" && t.uniqueId ? t.uniqueId : null;
    const from = typeof t?.from === "string" && ADDR.test(t.from) ? t.from.toLowerCase() : null;
    const to = typeof t?.to === "string" && ADDR.test(t.to) ? t.to.toLowerCase() : null;
    const ts = (t?.metadata as { blockTimestamp?: unknown } | undefined)?.blockTimestamp;
    const tsMs = typeof ts === "string" ? Date.parse(ts) : NaN;
    if (!contract) throw new Error(`unreadable ERC-20 transfer in alchemy_getAssetTransfers (${typeof uniqueId === "string" ? uniqueId : "no id"}): no contract`);
    if (raw === null || blockNum === null || !Number.isSafeInteger(blockNum) || !uniqueId || !from || !to || !Number.isFinite(tsMs)) {
      refused.add(contract);
      continue;
    }
    const dec = typeof rc.decimal === "string" && /^0x[0-9a-fA-F]{1,4}$/.test(rc.decimal) ? Number(BigInt(rc.decimal)) : null;
    const m = /:log:(\d+)$/.exec(uniqueId);
    transfers.push({
      contract, blockNum, logIndex: m ? Number(m[1]) : 0, uniqueId, from, to, raw,
      decimals: dec !== null && isValidDecimals(dec) ? dec : null,
      dateISO: new Date(tsMs).toISOString().slice(0, 10),
    });
  }
  const pk = r.pageKey;
  return { transfers: transfers.filter((t) => !refused.has(t.contract)), pageKey: typeof pk === "string" && pk ? pk : null, refused: [...refused].sort() };
}

/** Deterministic order: block, then log index, then id. */
export function sortTransfers(ts: readonly Erc20Transfer[]): Erc20Transfer[] {
  return [...ts].sort((a, b) => a.blockNum - b.blockNum || a.logIndex - b.logIndex || a.uniqueId.localeCompare(b.uniqueId));
}

// ── The per-wallet section ──────────────────────────────────────────────────

/** One UTC day's net movement of one token. `delta` is a signed base-unit integer string. */
export interface DayBucket { d: string; delta: string; lastBlock: number }

export type Erc20ContractState = "PENDING" | "VERIFIED" | "UNSUPPORTED";

export interface Erc20ContractHistory {
  /** From the transfers' rawContract.decimal (null when none carried it). */
  decimals: number | null;
  firstBlock: number;
  firstDayISO: string;
  /** Unique transfers seen (the evidence count, kept whatever the outcome). */
  transfers: number;
  /** Balance before the first bucket in `days` (base units). 0 until a first verification persists rows. */
  baseRaw: string;
  /** Movements not yet persisted as rows, by day, ascending. */
  days: DayBucket[];
  state: Erc20ContractState;
  reason: Erc20UnsupportedReason | null;
  /** The head block the replay was last verified at (null = never verified). */
  verifiedToBlock: number | null;
  /** Last day rows were written through (null = never). */
  persistedThroughISO: string | null;
  /** The instrument the coverage row was written for (once decided). */
  instrumentId: string | null;
  /** Consecutive inconclusive verifications (revert / non-standard), and when the last was. */
  callFailures?: number;
  callFailureAtISO?: string | null;
  /** Its month anchors were ever sampled (more active months than anchors) — sticky. */
  sampled?: boolean;
  /** Refused by evidence the scan could not read (decided at the next verification, rows included). */
  refusedReason?: Erc20UnsupportedReason | null;
}

/** An in-progress scan over (scannedToBlock, toBlock]: the `from` query, then the `to` query. */
export interface Erc20ScanSegment {
  fromBlock: number;
  toBlock: number;
  toISO: string;
  direction: "from" | "to";
  pageKey: string | null;
  pages: number;
  /** Movements of this segment, by contract, not yet merged. */
  buffer: Record<string, { decimals: number | null; firstBlock: number; firstDayISO: string; transfers: number; days: DayBucket[] }>;
  /** Contracts with an unreadable transfer in this segment (refused at close). */
  refused?: string[];
  /**
   * F3 — after a restart: the pages already read before it. Re-reading them is
   * NOT progress (it never resets `failures`); only reading past them, or
   * closing the segment, is.
   */
  replayToPages?: number;
}

export interface Erc20HistorySection {
  v: typeof ERC20_HISTORY_VERSION;
  /** Every transfer through this block (inclusive) is in `contracts`. Null = never scanned. */
  scannedToBlock: number | null;
  scannedToISO: string | null;
  /** UTC day of the last completed (or attempted-and-empty) scan; one scan per day. */
  lastScanDayISO: string | null;
  segment: Erc20ScanSegment | null;
  contracts: Record<string, Erc20ContractHistory>;
  /**
   * More contracts than the section tracks — the wallet can never read complete.
   * A LOWER BOUND on the distinct untracked contracts (the largest number seen
   * in one segment): it never counts the same contract twice, and is > 0
   * exactly when something was left untracked.
   */
  overflow: number;
  usage: { dayISO: string; requests: number } | null;
  snapshotPendingFromISO: string | null;
  /** Consecutive failed steps (a throttle is not counted). Drives the backoff and the segment restart. */
  failures: number;
  /** F3 — restarts of the open segment (reset when a segment closes). At ERC20_SEGMENT_RESTART_LIMIT no more. */
  segmentRestarts?: number;
  lastFailure: { code: string; atISO: string; detail?: string } | null;
  lastProgressAtISO: string | null;
}

export function emptySection(): Erc20HistorySection {
  return {
    v: ERC20_HISTORY_VERSION, scannedToBlock: null, scannedToISO: null, lastScanDayISO: null, segment: null,
    contracts: {}, overflow: 0, usage: null, snapshotPendingFromISO: null, failures: 0, lastFailure: null, lastProgressAtISO: null,
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const intOrNull = (v: unknown) => v === null || Number.isSafeInteger(v);
const SIGNED = /^-?\d+$/;
const bucketsOk = (v: unknown) => Array.isArray(v) && v.every((b) => isObj(b) && typeof b.d === "string" && typeof b.delta === "string" && SIGNED.test(b.delta) && Number.isSafeInteger(b.lastBlock));

/** Shape check. Anything malformed is "no section" — progress restarts; it is never trusted. */
export function parseSection(v: unknown): Erc20HistorySection | null {
  if (!isObj(v) || v.v !== ERC20_HISTORY_VERSION || !intOrNull(v.scannedToBlock) || !isObj(v.contracts)) return null;
  for (const c of Object.values(v.contracts)) {
    if (!isObj(c) || !Number.isSafeInteger(c.firstBlock) || typeof c.firstDayISO !== "string" || typeof c.baseRaw !== "string"
      || !/^\d+$/.test(c.baseRaw) || !bucketsOk(c.days) || !["PENDING", "VERIFIED", "UNSUPPORTED"].includes(c.state as string)
      || !intOrNull(c.verifiedToBlock)) return null;
  }
  if (v.segment !== null && v.segment !== undefined) {
    const s = v.segment;
    if (!isObj(s) || !Number.isSafeInteger(s.fromBlock) || !Number.isSafeInteger(s.toBlock) || (s.direction !== "from" && s.direction !== "to")
      || !isObj(s.buffer) || !Object.values(s.buffer).every((b) => isObj(b) && bucketsOk(b.days))) return null;
  }
  return { ...emptySection(), ...(v as unknown as Erc20HistorySection), segment: (v.segment as Erc20ScanSegment | null | undefined) ?? null };
}

// ── Where the section lives (Connection.historyCheckpoint) ──────────────────

export interface StandaloneErc20Checkpoint {
  kind: typeof ERC20_HISTORY_KIND;
  v: typeof ERC20_HISTORY_VERSION;
  chain: "ETH";
  accountId: string;
  tokens: Erc20HistorySection;
}

/** A standalone token document for this account (the column held no native ETH checkpoint). */
export function parseStandaloneErc20(raw: string | null | undefined, accountId: string): StandaloneErc20Checkpoint | null {
  if (!raw) return null;
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!isObj(v) || v.kind !== ERC20_HISTORY_KIND || v.v !== ERC20_HISTORY_VERSION || v.chain !== "ETH" || v.accountId !== accountId) return null;
  const tokens = parseSection(v.tokens);
  return { kind: ERC20_HISTORY_KIND, v: ERC20_HISTORY_VERSION, chain: "ETH", accountId, tokens: tokens ?? emptySection() };
}

export type SectionHost = "NATIVE" | "STANDALONE" | "EMPTY" | "FOREIGN";

/**
 * The token section stored for this account, and what hosts it. FOREIGN: the
 * column holds something else (another account's or another chain's value) —
 * never overwritten.
 */
export function readErc20Section(raw: string | null | undefined, accountId: string): { host: SectionHost; section: Erc20HistorySection | null } {
  if (raw === null || raw === undefined || raw === "") return { host: "EMPTY", section: null };
  const native = parseEthCheckpoint(raw, accountId);
  if (native) return { host: "NATIVE", section: parseSection((native as EthBackfillCheckpoint & { tokens?: unknown }).tokens) };
  const standalone = parseStandaloneErc20(raw, accountId);
  if (standalone) return { host: "STANDALONE", section: standalone.tokens };
  return { host: "FOREIGN", section: null };
}

/** The column value with `section` written into its host. Null when the column is FOREIGN (never overwritten). */
export function withErc20Section(raw: string | null | undefined, accountId: string, section: Erc20HistorySection): string | null {
  const { host } = readErc20Section(raw, accountId);
  if (host === "FOREIGN") return null;
  if (host === "NATIVE") {
    const v = JSON.parse(raw!) as Record<string, unknown>;
    return JSON.stringify({ ...v, tokens: section });
  }
  const doc: StandaloneErc20Checkpoint = { kind: ERC20_HISTORY_KIND, v: ERC20_HISTORY_VERSION, chain: "ETH", accountId, tokens: section };
  return JSON.stringify(doc);
}

/** The `tokens` field to carry into a NEW native checkpoint built over `raw` (enqueue replaces the document). */
export function carriedTokens(raw: string | null | undefined, accountId: string): { tokens?: Erc20HistorySection } {
  const { host, section } = readErc20Section(raw, accountId);
  return host !== "FOREIGN" && section ? { tokens: section } : {};
}

// ── Scanning ────────────────────────────────────────────────────────────────

const big = (s: string) => BigInt(s);

function addToBuckets(days: DayBucket[], d: string, delta: bigint, block: number): DayBucket[] {
  const i = days.findIndex((b) => b.d === d);
  if (i >= 0) {
    const b = days[i];
    days[i] = { d, delta: (big(b.delta) + delta).toString(), lastBlock: Math.max(b.lastBlock, block) };
  } else {
    days.push({ d, delta: delta.toString(), lastBlock: block });
    days.sort((a, b) => a.d.localeCompare(b.d));
  }
  return days;
}

/**
 * Fold one page of one direction into the segment buffer. `seen` dedupes by
 * uniqueId within the step. In the `to` direction a transfer the wallet SENT
 * was already counted (whole) by the `from` direction.
 */
export function applyTransfers(
  segment: Erc20ScanSegment, transfers: readonly Erc20Transfer[], wallet: string, seen: Set<string>,
): Erc20ScanSegment {
  const w = wallet.toLowerCase();
  const buffer = { ...segment.buffer };
  for (const t of sortTransfers(transfers)) {
    const key = `${segment.direction}|${t.uniqueId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (segment.direction === "to" && t.from === w) continue;
    if (segment.direction === "from" && t.from !== w) continue; // not this wallet's — never attributed
    if (segment.direction === "to" && t.to !== w) continue;
    const delta = (t.to === w ? t.raw : ZERO) - (t.from === w ? t.raw : ZERO);
    const prev = buffer[t.contract];
    const entry = prev
      ? { ...prev, days: prev.days.map((b) => ({ ...b })) }
      : { decimals: t.decimals, firstBlock: t.blockNum, firstDayISO: t.dateISO, transfers: 0, days: [] as DayBucket[] };
    if (entry.decimals === null && t.decimals !== null) entry.decimals = t.decimals;
    if (t.blockNum < entry.firstBlock) { entry.firstBlock = t.blockNum; entry.firstDayISO = t.dateISO; }
    entry.transfers += 1;
    addToBuckets(entry.days, t.dateISO, delta, t.blockNum);
    buffer[t.contract] = entry;
  }
  return { ...segment, buffer };
}

/**
 * Close a segment: merge its movements into the section. New contracts start
 * PENDING; a VERIFIED contract gains unpersisted days and must be re-verified
 * (its verifiedToBlock now trails the scan). An UNSUPPORTED one only counts the
 * evidence. Contracts beyond `maxContracts` are counted as overflow, not tracked.
 */
export function closeSegment(section: Erc20HistorySection, maxContracts: number): Erc20HistorySection {
  const seg = section.segment;
  if (!seg) return section;
  const contracts = { ...section.contracts };
  let untracked = 0;
  for (const [addr, b] of Object.entries(seg.buffer).sort(([a], [c]) => a.localeCompare(c))) {
    const prev = contracts[addr];
    if (!prev) {
      if (Object.keys(contracts).length >= maxContracts) { untracked++; continue; }
      contracts[addr] = {
        decimals: b.decimals, firstBlock: b.firstBlock, firstDayISO: b.firstDayISO, transfers: b.transfers,
        baseRaw: "0", days: b.days, state: "PENDING", reason: null, verifiedToBlock: null, persistedThroughISO: null, instrumentId: null,
      };
      continue;
    }
    const days = prev.state === "UNSUPPORTED" ? [] : prev.days.map((x) => ({ ...x }));
    if (prev.state !== "UNSUPPORTED") for (const x of b.days) addToBuckets(days, x.d, big(x.delta), x.lastBlock);
    contracts[addr] = { ...prev, decimals: prev.decimals ?? b.decimals, transfers: prev.transfers + b.transfers, days };
  }
  // S1 — a contract with an unreadable transfer is refused (alone); the verify phase decides it, rows included.
  for (const addr of [...new Set(seg.refused ?? [])].sort()) {
    const prev = contracts[addr];
    if (prev) {
      if (prev.state !== "UNSUPPORTED") contracts[addr] = { ...prev, refusedReason: "TRANSFER_UNREADABLE" };
      continue;
    }
    if (Object.keys(contracts).length >= maxContracts) { untracked++; continue; }
    contracts[addr] = {
      decimals: null, firstBlock: seg.fromBlock, firstDayISO: seg.toISO, transfers: 0, baseRaw: "0", days: [], state: "PENDING",
      reason: null, verifiedToBlock: null, persistedThroughISO: null, instrumentId: null, refusedReason: "TRANSFER_UNREADABLE",
    };
  }
  // N4 — a lower bound on distinct untracked contracts, never inflated by re-seeing the same ones every segment.
  const overflow = Math.max(section.overflow, untracked);
  return { ...section, contracts, overflow, segment: null, scannedToBlock: seg.toBlock, scannedToISO: seg.toISO };
}

// ── Replay + anchors ────────────────────────────────────────────────────────

/** End balance (base units) of a contract through the scan. */
export function balanceThroughScan(c: Erc20ContractHistory): bigint {
  return c.days.reduce((s, b) => s + big(b.delta), big(c.baseRaw));
}

/** The running balance never goes negative (a negative point means evidence is missing). */
export function replayConsistent(c: Erc20ContractHistory): boolean {
  let bal = big(c.baseRaw);
  for (const b of c.days) { bal += big(b.delta); if (bal < ZERO) return false; }
  return true;
}

export interface Anchor { kind: "OPENING" | "MONTH" | "HEAD"; block: number; expected: bigint }

/** Evenly spread `k` indices over [0, n) — first and last included; all when n ≤ k. */
export function spreadIndices(n: number, k: number): number[] {
  if (n <= 0 || k <= 0) return [];
  if (n <= k) return [...Array(n).keys()];
  if (k === 1) return [n - 1];
  const out = new Set<number>();
  for (let i = 0; i < k; i++) out.add(Math.round((i * (n - 1)) / (k - 1)));
  return [...out].sort((a, b) => a - b);
}

/**
 * The anchors a contract is checked at, against the scan head. A never-verified
 * contract is checked at its opening; every check includes the head; month
 * anchors sample the UNPERSISTED activity (the part not verified before).
 */
export function anchorPlan(c: Erc20ContractHistory, headBlock: number, maxMonthAnchors: number): Anchor[] {
  const anchors: Anchor[] = [];
  if (c.verifiedToBlock === null && c.firstBlock > 0) anchors.push({ kind: "OPENING", block: c.firstBlock - 1, expected: ZERO });
  const { months, bal } = monthEnds(c);
  for (const i of spreadIndices(months.length, maxMonthAnchors)) {
    if (months[i].block < headBlock) anchors.push({ kind: "MONTH", block: months[i].block, expected: months[i].balance });
  }
  anchors.push({ kind: "HEAD", block: headBlock, expected: bal });
  const seen = new Set<number>();
  return anchors.filter((a) => (seen.has(a.block) ? false : (seen.add(a.block), true)));
}

/** N1 — would this verification check only a SAMPLE of the active months (more than the anchors allow)? */
export function anchorsSampled(c: Erc20ContractHistory, headBlock: number, maxMonthAnchors: number): boolean {
  return monthEnds(c).months.filter((m) => m.block < headBlock).length > maxMonthAnchors;
}

/** Month ends of the unpersisted days: the balance after the last active day of each month, and the end balance. */
function monthEnds(c: Erc20ContractHistory): { months: Array<{ block: number; balance: bigint }>; bal: bigint } {
  const months: Array<{ block: number; balance: bigint }> = [];
  let bal = big(c.baseRaw);
  for (let i = 0; i < c.days.length; i++) {
    const b = c.days[i];
    bal += big(b.delta);
    const next = c.days[i + 1];
    if (!next || next.d.slice(0, 7) !== b.d.slice(0, 7)) {
      const lastBlockOfMonth = Math.max(...c.days.filter((x) => x.d.slice(0, 7) === b.d.slice(0, 7)).map((x) => x.lastBlock));
      months.push({ block: lastBlockOfMonth, balance: bal });
    }
  }
  return { months, bal };
}

/** One balanceOf read: a 32-byte word, no code at that block ("0x"), or a revert / non-standard answer. */
export type BalanceRead = { kind: "VALUE"; raw: bigint } | { kind: "NO_CODE" } | { kind: "REVERTED" } | { kind: "NONSTANDARD" };

/** Parse an eth_call result for balanceOf. */
export function parseBalanceOfResult(result: unknown): BalanceRead {
  if (result === "0x") return { kind: "NO_CODE" };
  if (typeof result !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(result)) return { kind: "NONSTANDARD" };
  return { kind: "VALUE", raw: BigInt(result) };
}

/** `balanceOf(wallet)` calldata. */
export function balanceOfCalldata(wallet: string): string {
  return BALANCE_OF_SELECTOR + wallet.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

/**
 * THE VERDICT. Every anchor must match exactly. The opening may also read
 * NO_CODE (the contract did not exist yet: no balance anywhere).
 */
export function judgeAnchors(anchors: readonly Anchor[], reads: readonly BalanceRead[]):
  { verified: true } | { verified: false; reason: Erc20UnsupportedReason; detail: string } {
  if (reads.length !== anchors.length) throw new Error("anchor reads do not match the plan");
  // An exact value that disagrees is deterministic evidence and wins over an
  // inconclusive read elsewhere in the plan (S5): judge every VALUE first.
  let inconclusive: { verified: false; reason: Erc20UnsupportedReason; detail: string } | null = null;
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    const r = reads[i];
    if (a.kind === "OPENING" && r.kind === "NO_CODE") continue;
    if (r.kind !== "VALUE") { inconclusive ??= { verified: false, reason: "BALANCE_CALL_FAILED", detail: `balanceOf at block ${a.block}: ${r.kind.toLowerCase()}` }; continue; }
    if (r.raw === a.expected) continue;
    if (a.kind === "OPENING") return { verified: false, reason: "OPENING_BALANCE_UNEXPLAINED", detail: `balance before the first transfer (block ${a.block}) is not zero` };
    return r.raw > a.expected
      ? { verified: false, reason: "REBASING_OR_NONSTANDARD", detail: `on-chain balance exceeds the replay at block ${a.block}` }
      : { verified: false, reason: "FEE_ON_TRANSFER_OR_NONSTANDARD", detail: `on-chain balance is below the replay at block ${a.block}` };
  }
  return inconclusive ?? { verified: true };
}

// ── Rows ────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const nextDay = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);

export interface Erc20DerivedRow { dateISO: string; quantity: number }

/**
 * End-of-day rows from `fromISO` through `headISO`. DENSE while the balance is
 * non-zero (the day-valuation rule needs a fresh row for every valued day);
 * while it is zero only the first day of each zero run (a closure — the rule
 * reads a 0 as CLOSED whatever its age). The first day is always written.
 */
export function derivedRows(c: Erc20ContractHistory, decimals: number, fromISO: string, headISO: string): Erc20DerivedRow[] {
  const byDay = new Map(c.days.map((b) => [b.d, big(b.delta)]));
  let bal = big(c.baseRaw);
  // Movements before `fromISO` among the unpersisted days are part of the opening.
  for (const b of c.days) if (b.d < fromISO) bal += big(b.delta);
  const rows: Erc20DerivedRow[] = [];
  let prevZero = false;
  for (let d = fromISO; d <= headISO; d = nextDay(d)) {
    bal += byDay.get(d) ?? ZERO;
    if (bal < ZERO) throw new Error(`negative replay balance on ${d}`);
    const zero = bal === ZERO;
    if (d === fromISO || !zero || !prevZero) rows.push({ dateISO: d, quantity: baseUnitsToWhole(bal, decimals) });
    prevZero = zero;
  }
  return rows;
}

/** The first day rows must be (re)written from: the earliest unpersisted movement, or the day after the last write. */
export function rowsFromISO(c: Erc20ContractHistory): string {
  if (c.persistedThroughISO === null) return c.firstDayISO;
  const after = c.persistedThroughISO; // the last write's head day is rewritten: later transfers that day change its end balance
  return c.days.length && c.days[0].d < after ? c.days[0].d : after;
}

/** After rows through `headISO` were persisted: fold the days into the base, keep nothing unpersisted. */
export function markPersisted(c: Erc20ContractHistory, headBlock: number, headISO: string, instrumentId: string, sampled = false): Erc20ContractHistory {
  return { ...c, baseRaw: balanceThroughScan(c).toString(), days: [], state: "VERIFIED", reason: null,
    verifiedToBlock: headBlock, persistedThroughISO: headISO, instrumentId, callFailures: 0, callFailureAtISO: null,
    sampled: c.sampled === true || sampled };
}

export function markUnsupported(c: Erc20ContractHistory, reason: Erc20UnsupportedReason, instrumentId: string | null): Erc20ContractHistory {
  return { ...c, days: [], state: "UNSUPPORTED", reason, instrumentId: instrumentId ?? c.instrumentId, refusedReason: null };
}

/** S5 — one more inconclusive verification; refuse only at `ERC20_CALL_FAILURE_LIMIT`. */
export function noteInconclusive(c: Erc20ContractHistory, atISO: string): { contract: Erc20ContractHistory; refuse: boolean } {
  const n = (c.callFailures ?? 0) + 1;
  return { contract: { ...c, callFailures: n, callFailureAtISO: atISO }, refuse: n >= ERC20_CALL_FAILURE_LIMIT };
}

/** The COMPLETE licence a verified contract is persisted with (N1: sampled anchors are said in the data). */
export function verifiedCoverage(c: Pick<Erc20ContractHistory, "firstDayISO" | "sampled">, headISO: string): ChainCoverage & { kind: "COMPLETE" } {
  return { kind: "COMPLETE", fromISO: c.firstDayISO, toISO: headISO, source: ERC20_HISTORY_SOURCE,
    ...(c.sampled ? { caveats: ["TOKEN_ANCHORS_SAMPLED"] as const } : {}) };
}

/**
 * OPERATOR RESET (S5) — a fresh section that re-derives every token from full
 * evidence on the next steps (a refused token's movements are not kept, so it
 * can only be re-judged by a rescan). The regeneration marker is carried, so
 * nothing already owed is dropped; rows are rewritten as tokens re-verify.
 */
export function resetErc20Section(s: Erc20HistorySection | null): Erc20HistorySection {
  return { ...emptySection(), snapshotPendingFromISO: s?.snapshotPendingFromISO ?? null };
}

// ── What a step owes, and in what order ─────────────────────────────────────

/**
 * Does this contract need anchors at the current scan head? A contract whose
 * last verification was inconclusive waits `ERC20_CALL_RETRY_MS` (when the
 * caller passes the clock); a refused-by-evidence one is owed at once.
 */
export function needsVerification(c: Erc20ContractHistory, scannedToBlock: number | null, nowMs?: number): boolean {
  if (c.state === "UNSUPPORTED" || scannedToBlock === null) return false;
  if (c.refusedReason) return true;
  if ((c.callFailures ?? 0) > 0 && c.callFailureAtISO && nowMs !== undefined && nowMs - Date.parse(c.callFailureAtISO) < ERC20_CALL_RETRY_MS) return false;
  return c.state === "PENDING" || (c.verifiedToBlock ?? -1) < scannedToBlock;
}

/** S1 — repeated failed steps: at most once per ERC20_BACKOFF_MS, never every wake. */
export function erc20BackedOff(section: Pick<Erc20HistorySection, "failures" | "lastFailure"> | null, nowMs: number | undefined): boolean {
  if (!section || nowMs === undefined || section.failures < ERC20_BACKOFF_AFTER || !section.lastFailure) return false;
  return nowMs - Date.parse(section.lastFailure.atISO) < ERC20_BACKOFF_MS;
}

/** Work owed by this wallet's token history today (a regeneration marker is separate). */
export function erc20WorkOwed(section: Erc20HistorySection | null, todayISO: string, nowMs?: number): boolean {
  if (!section) return true;
  if (erc20BackedOff(section, nowMs)) return false;
  if (section.segment) return true;
  if ((section.lastScanDayISO ?? "") < todayISO) return true;
  return Object.values(section.contracts).some((c) => needsVerification(c, section.scannedToBlock, nowMs));
}

/** Priority: 0 = observed token with a market price, 1 = observed unpriced, 2 = seen only in transfers. */
export type TokenPriority = 0 | 1 | 2;

/** Priced first, then observed, then transfer-only; earliest first within a tier; then by address. */
export function orderForVerification(
  section: Erc20HistorySection, priorityOf: (contract: string) => TokenPriority, nowMs?: number,
): string[] {
  return Object.entries(section.contracts)
    .filter(([, c]) => needsVerification(c, section.scannedToBlock, nowMs))
    .sort(([a, x], [b, y]) => priorityOf(a) - priorityOf(b) || x.firstBlock - y.firstBlock || a.localeCompare(b))
    .map(([a]) => a);
}

/** Requests recorded for `dayISO` on the section (0 when the day differs). */
export function sectionUsageOn(s: Pick<Erc20HistorySection, "usage"> | null, dayISO: string): number {
  return s?.usage && s.usage.dayISO === dayISO && Number.isFinite(s.usage.requests) ? s.usage.requests : 0;
}

// ── The wallet-level summary (Connections + completeness) ───────────────────

export interface Erc20HistorySummary {
  /** At least one full scan closed: every contract the wallet ever touched is known. */
  scanned: boolean;
  scannedToISO: string | null;
  contracts: number;
  verified: number;
  unsupported: number;
  pending: number;
  overflow: number;
}

export function summarizeSection(section: Erc20HistorySection | null): Erc20HistorySummary {
  const cs = section ? Object.values(section.contracts) : [];
  return {
    scanned: !!section && section.scannedToBlock !== null,
    scannedToISO: section?.scannedToISO ?? null,
    contracts: cs.length,
    verified: cs.filter((c) => c.state === "VERIFIED").length,
    unsupported: cs.filter((c) => c.state === "UNSUPPORTED").length,
    pending: cs.filter((c) => c.state === "PENDING").length,
    overflow: section?.overflow ?? 0,
  };
}

/** Every token the wallet ever touched is verified (the token half of wallet completeness). */
export function erc20HistoryComplete(s: Erc20HistorySummary): boolean {
  return s.scanned && s.overflow === 0 && s.pending === 0 && s.unsupported === 0;
}

// ── Gates and per-step bounds ───────────────────────────────────────────────

export interface Erc20HistoryConfig {
  enabled: boolean;
  /** Alchemy requests one wallet step may send (scan pages + head + anchors). */
  stepRequestBudget: number;
  /** Transfer pages (≤ 1,000 transfers each) per step. */
  maxPagesPerStep: number;
  /** Tokens verified per wallet per step. */
  maxTokensPerStep: number;
  /** Month anchors per token per verification. */
  maxMonthAnchors: number;
  /** Contracts tracked per wallet (spam bound). Beyond it the wallet can never read complete. */
  maxContracts: number;
  /** Tokens whose historical prices one pass may fetch (CoinGecko). */
  maxPriceTokensPerRun: number;
  startReserveMs: number;
}

const num = (env: Record<string, string | undefined>, k: string, d: number, min: number, max: number) => {
  const n = Number(env[k]);
  return Number.isInteger(n) && n >= min && n <= max ? n : d;
};

/**
 * Env-configured, clamped. OFF unless explicitly enabled: it rides the Ethereum
 * worker's gate (SOL_BACKFILL_ENABLED + ETH_BACKFILL_ENABLED) AND needs its own
 * `ERC20_HISTORY_ENABLED=true` — the same `=== "true"` opt-in as its siblings, so
 * no environment starts spending Alchemy / CoinGecko calls on merge or promotion.
 */
export function erc20HistoryConfig(env: Record<string, string | undefined> = process.env): Erc20HistoryConfig {
  return {
    enabled: env.SOL_BACKFILL_ENABLED === "true" && env.ETH_BACKFILL_ENABLED === "true" && env.ERC20_HISTORY_ENABLED === "true",
    stepRequestBudget:    num(env, "ERC20_HISTORY_STEP_REQUESTS", 120, 10, 2_000),
    maxPagesPerStep:      num(env, "ERC20_HISTORY_PAGES_PER_STEP", 20, 1, 200),
    maxTokensPerStep:     num(env, "ERC20_HISTORY_TOKENS_PER_STEP", 8, 1, 100),
    maxMonthAnchors:      num(env, "ERC20_HISTORY_MONTH_ANCHORS", 6, 0, 24),
    maxContracts:         num(env, "ERC20_HISTORY_MAX_CONTRACTS", 300, 1, 5_000),
    maxPriceTokensPerRun: num(env, "ERC20_HISTORY_PRICE_TOKENS_PER_RUN", 5, 0, 100),
    startReserveMs:       num(env, "ERC20_HISTORY_START_RESERVE_MS", 20_000, 2_000, 200_000),
  };
}
