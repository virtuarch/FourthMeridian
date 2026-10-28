/**
 * lib/crypto/spl-history.core.ts
 *
 * SPL TOKEN HISTORY — the PURE half. No db, no network, no clock.
 *
 * Owner rule (2026-10-28): "Do not fabricate historical token balances… retain
 * an explicit unsupported or partial state… Do not mark an entire wallet
 * complete when only its native asset is complete."
 *
 * ── A TOKEN BALANCE LIVES IN A TOKEN ACCOUNT, NOT IN THE WALLET ─────────────
 * A Solana wallet does not hold USDC. It OWNS one or more token accounts (an
 * associated token account, sometimes auxiliaries), each of which holds an
 * amount of ONE mint. Accounts are created (balance 0 before), closed (0 after)
 * and may be re-created at the same address. So a wallet's history for a mint
 * is the SUM, per day, of the attributed balance of every token account it ever
 * owned for that mint — and proving it means proving each of those accounts.
 *
 * ── EACH ACCOUNT PROVES ITSELF, EXACTLY AS NATIVE SOL DOES ──────────────────
 * Every transaction states the token balance of every token account it touched
 * immediately before (`meta.preTokenBalances`) and after (`postTokenBalances`),
 * positionally by `accountIndex`. An absent entry means the account was not an
 * initialised token account on that side: 0 before creation, 0 after closure.
 * For two consecutive transactions on one token account — A older, B newer —
 *
 *     post(A) === pre(B)
 *
 * holds exactly when nothing changed the account between them. That is the same
 * continuity proof native SOL uses (sol-history-backfill.core.ts), and this file
 * REUSES it: a token account's state is encoded as a string key and fed to the
 * same `extendBackward` / `extendForward` / `orderSameSlot`, which only ever
 * compare their `preLamports` / `postLamports` fields as strings. The key is
 *
 *     "<mint>:<W|X>:<raw amount>"   or   "-" (not a token account)
 *
 * W = owned by this wallet, X = owned by anyone else. Ownership is part of the
 * state: an account whose owner changes moves value into or out of the wallet
 * without the amount changing, and that is a real balance change for the wallet.
 *
 * An account is VERIFIED when
 *   · its newest proven transaction states its CURRENT on-chain state (the
 *     amount `getTokenAccountsByOwner` reports — or, for an account the wallet
 *     no longer owns or that is closed, an attributed zero), and
 *   · its backward walk reached its CREATION (the oldest listed transaction's
 *     pre-state is absent, or zero) — or stopped at a proven GAP, in which case
 *     only the stretch above the gap is proven (a later proven start).
 *
 * A MINT is COMPLETE only when token-account discovery is complete and every
 * account discovered for it is verified from creation; PARTIAL when every
 * account is verified but at least one only from a later proven start (licensed
 * from the LATEST such start); UNSUPPORTED with a plain reason when it cannot be
 * proven at all. No row is ever written outside the licensed interval.
 *
 * ── DISCOVERY, AND ITS STATED LIMIT ─────────────────────────────────────────
 * Current accounts come from `getTokenAccountsByOwner` (both programs). CLOSED
 * accounts can only be discovered from the wallet's own transaction history:
 * the `owner` field of every pre/post token balance in a transaction that lists
 * the wallet. The native SOL backfill already fetches every one of those
 * transactions; when it starts fresh with this module wired, it feeds them here
 * at no extra cost (source NATIVE). A wallet whose native history was imported
 * before this existed is re-walked once (source WALK). An account that was never
 * touched by a transaction listing the wallet — e.g. created by a third party
 * with InitializeAccount3 and later closed by a separate close authority — is
 * UNDISCOVERABLE by this method; that limit is stated, not hidden.
 *
 * ── TOKEN-2022 ──────────────────────────────────────────────────────────────
 * The proof covers the raw `amount`. Mint extensions that make the holder's
 * balance differ from `amount / 10^decimals` without a transfer (interest-
 * bearing, scaled UI amount) or move value into balances `amount` does not show
 * (confidential transfers) break the premise, so such a mint is UNSUPPORTED. An
 * extension this file does not recognise is refused the same way. Transfer
 * fees are HANDLED: the withheld fee sits in the recipient account's
 * `withheldAmount`, is never the holder's to spend, and every change to the
 * holder's `amount` is a stated delta the reconciliation proves.
 */

import { isValidDecimals, parseDecimalAmount, SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "./token-asset";
import { addDaysISO, SolProofDataError, type SolTxPoint } from "./sol-history-backfill.core";
import type { ChainCoverage, ChainCoverageCaveat } from "./chain-movement";

/** `PositionObservation.source` on DERIVED token rows this path writes. */
export const SPL_HISTORY_SOURCE = "solana-rpc-spl";
/** Coverage provenance: the chain's stated token balances, verified per token account. */
export const SPL_CONTINUITY_SOURCE = "solana-rpc-spl+account-continuity";
/** `PositionObservation.completeness` — the same basis name native SOL uses. */
export const SPL_CHAIN_STATED_BASIS = "CHAIN_STATED";
export const SPL_RECONSTRUCTION_VERSION = 1;

export const SPL_STATE_KIND = "spl-history";
export const SPL_STATE_VERSION = 1;

/**
 * Token accounts tracked per wallet. A bound on checkpoint size and work, not a
 * claim: accounts beyond it are counted (`overflow`) and keep the wallet's
 * token inventory INCOMPLETE — never silently dropped from the answer.
 */
export const MAX_TRACKED_ACCOUNTS = 48;
/** Consecutive runs whose newest proven state disagreed with the chain before a mint is refused. */
export const HEAD_MISMATCH_LIMIT = 3;

/** The absent state: not an initialised token account on that side. */
export const ABSENT = "-";

export type SplUnsupportedReason =
  /** Interest-bearing / scaled-UI-amount mint: the balance moves without a transfer. */
  | "BALANCE_EXTENSION"
  /** Confidential-transfer mint: part of the balance is encrypted, outside `amount`. */
  | "CONFIDENTIAL_BALANCES"
  /** A Token-2022 extension this module does not know to be safe. */
  | "UNRECOGNISED_EXTENSION"
  /** The replay does not end at the account's current on-chain balance (an unlisted transaction). */
  | "RECONCILIATION_MISMATCH"
  /** A response that cannot be read as a token balance statement. */
  | "INVALID_DATA";

/** The stored caveat each refusal carries — the EXISTING ChainCoverage vocabulary, no new one. */
export const REASON_CAVEAT: Readonly<Record<SplUnsupportedReason, ChainCoverageCaveat>> = {
  BALANCE_EXTENSION:      "PROOF_PREMISES_UNMET",
  CONFIDENTIAL_BALANCES:  "PROOF_PREMISES_UNMET",
  UNRECOGNISED_EXTENSION: "PROOF_PREMISES_UNMET",
  RECONCILIATION_MISMATCH: "ADDRESS_INDEX_INCOMPLETE",
  INVALID_DATA:           "INVALID_DATA",
};

// ── Wire shapes ──────────────────────────────────────────────────────────────

/** The subset of `getTransaction` (json OR jsonParsed) this module reads. */
export interface SplTxView {
  slot: number;
  blockTime: number | null;
  transaction?: { message?: { accountKeys?: Array<string | { pubkey?: unknown }> } } | null;
  meta?: {
    err?: unknown;
    preTokenBalances?: unknown[] | null;
    postTokenBalances?: unknown[] | null;
    loadedAddresses?: { writable?: string[]; readonly?: string[] } | null;
  } | null;
}

/**
 * Every account key in `accountIndex` order. jsonParsed lists objects that
 * already include lookup-table addresses; json lists static strings and puts
 * the loaded ones in `meta.loadedAddresses` (writable, then readonly) — the
 * order the RPC indexes balances by (see sol-history.ts).
 */
export function accountKeysOf(tx: SplTxView): string[] {
  const raw = tx.transaction?.message?.accountKeys ?? [];
  if (raw.some((k) => typeof k === "object" && k !== null)) {
    return raw.map((k) => (typeof k === "string" ? k : typeof k?.pubkey === "string" ? k.pubkey : ""));
  }
  const loaded = tx.meta?.loadedAddresses ?? null;
  return [...(raw as string[]), ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])];
}

export interface TokenBalanceEntry {
  address: string;
  mint: string;
  /** Null only on RPCs too old to state it — such an entry cannot be attributed. */
  owner: string | null;
  program: string | null;
  amount: bigint;
  decimals: number;
}

/**
 * One side's token balances, keyed by account address. `uiTokenAmount.amount`
 * (the raw base-unit STRING) is the only amount read — `uiAmount` is a float the
 * RPC pre-computes and, for Token-2022 scaled mints, not even `amount/10^d`.
 * Malformed entries are counted with the address they name (when one can be read).
 */
export function tokenBalancesOf(tx: SplTxView, side: "pre" | "post"): { byAddress: Map<string, TokenBalanceEntry>; malformed: string[]; malformedUnknown: number } {
  const keys = accountKeysOf(tx);
  const list = (side === "pre" ? tx.meta?.preTokenBalances : tx.meta?.postTokenBalances) ?? [];
  const byAddress = new Map<string, TokenBalanceEntry>();
  const malformed: string[] = [];
  let malformedUnknown = 0;
  for (const raw of Array.isArray(list) ? list : []) {
    const e = raw as { accountIndex?: unknown; mint?: unknown; owner?: unknown; programId?: unknown; uiTokenAmount?: { amount?: unknown; decimals?: unknown } };
    const idx = typeof e?.accountIndex === "number" && Number.isInteger(e.accountIndex) ? e.accountIndex : -1;
    const address = idx >= 0 && idx < keys.length && keys[idx] ? keys[idx] : null;
    const amount = parseDecimalAmount(e?.uiTokenAmount?.amount);
    const decimals = e?.uiTokenAmount?.decimals;
    if (!address || typeof e.mint !== "string" || !e.mint || amount === null || !isValidDecimals(decimals)) {
      if (address) malformed.push(address); else malformedUnknown++;
      continue;
    }
    byAddress.set(address, {
      address, mint: e.mint, amount, decimals,
      owner: typeof e.owner === "string" && e.owner ? e.owner : null,
      program: typeof e.programId === "string" && e.programId ? e.programId : null,
    });
  }
  return { byAddress, malformed, malformedUnknown };
}

// ── Discovery ────────────────────────────────────────────────────────────────

export interface DiscoveredTokenAccount { address: string; mint: string; program: string | null; decimals: number }

/**
 * Token accounts this transaction states as OWNED BY THE WALLET, on either
 * side. This is how a closed account is found: its closing transaction's
 * pre-balance names the wallet as owner. Malformed entries are skipped (a
 * discovery hint, never a proof — the account's own walk is the proof).
 */
export function discoverOwnedTokenAccounts(tx: SplTxView, wallet: string): DiscoveredTokenAccount[] {
  const out = new Map<string, DiscoveredTokenAccount>();
  for (const side of ["pre", "post"] as const) {
    for (const e of tokenBalancesOf(tx, side).byAddress.values()) {
      if (e.owner !== wallet) continue;
      const k = `${e.address}|${e.mint}`;
      if (!out.has(k)) out.set(k, { address: e.address, mint: e.mint, program: e.program, decimals: e.decimals });
    }
  }
  return [...out.values()];
}

// ── One token account's state, as a continuity key ───────────────────────────

export function stateKey(e: TokenBalanceEntry | null, wallet: string): string {
  if (!e) return ABSENT;
  return `${e.mint}:${e.owner === wallet ? "W" : "X"}:${e.amount.toString()}`;
}

/** The state `getTokenAccountsByOwner` reports for a current account (owned by the wallet by definition). */
export function currentStateKey(mint: string, amount: bigint): string {
  return `${mint}:W:${amount.toString()}`;
}

/** The wallet's attributed raw amount of `mint` in a state key (0 for absent, other owner, other mint). */
export function attributedRaw(key: string, mint: string): bigint {
  if (key === ABSENT) return BigInt(0);
  const i = key.lastIndexOf(":");
  const j = key.lastIndexOf(":", i - 1);
  if (i < 0 || j < 0) return BigInt(0);
  if (key.slice(0, j) !== mint || key.slice(j + 1, i) !== "W") return BigInt(0);
  return BigInt(key.slice(i + 1));
}

/** True when a state carries nothing for the wallet (absent, another owner, or zero). */
export function isAttributedZero(key: string): boolean {
  if (key === ABSENT) return true;
  const i = key.lastIndexOf(":");
  const j = key.lastIndexOf(":", i - 1);
  return key.slice(j + 1, i) !== "W" || key.slice(i + 1) === "0";
}

/**
 * Does the newest proven state equal the account's CURRENT on-chain state?
 * `current` is the amount `getTokenAccountsByOwner` reports for the address, or
 * null when it is not listed — closed, or no longer the wallet's — in which case
 * the newest state must carry nothing for the wallet.
 */
export function matchesAnchor(postKey: string, current: { mint: string; amount: bigint } | null): boolean {
  return current ? postKey === currentStateKey(current.mint, current.amount) : isAttributedZero(postKey);
}

/**
 * One transaction reduced to one token account's before/after state, in the
 * SolTxPoint shape the continuity proof walks (`preLamports`/`postLamports`
 * carry STATE KEYS here — the proof compares them as strings and nothing else).
 * Null when the account is not one of the transaction's keys.
 */
export function tokenPointFromTransaction(tx: SplTxView, signature: string, account: string, wallet: string): SolTxPoint | null {
  if (!tx.meta) throw new SolProofDataError(`transaction ${signature}: no meta`);
  if (tx.blockTime === null || !Number.isFinite(tx.blockTime)) {
    throw new SolProofDataError(`transaction ${signature}: no blockTime, so it cannot be dated`);
  }
  if (!accountKeysOf(tx).includes(account)) return null;
  const pre = tokenBalancesOf(tx, "pre");
  const post = tokenBalancesOf(tx, "post");
  // An unreadable entry for THIS account, or one that cannot be placed at all,
  // could be this account: never read it as absent.
  if (pre.malformed.includes(account) || post.malformed.includes(account) || pre.malformedUnknown > 0 || post.malformedUnknown > 0) {
    throw new SolProofDataError(`transaction ${signature}: unreadable token balance`);
  }
  const preE = pre.byAddress.get(account) ?? null;
  const postE = post.byAddress.get(account) ?? null;
  for (const e of [preE, postE]) {
    if (e && e.owner === null) throw new SolProofDataError(`transaction ${signature}: token balance without an owner`);
  }
  return {
    signature, slot: tx.slot, blockTime: tx.blockTime,
    dateISO: new Date(tx.blockTime * 1000).toISOString().slice(0, 10),
    preLamports: stateKey(preE, wallet), postLamports: stateKey(postE, wallet),
  };
}

/** Mints the WALLET held in these points' states, in first-seen order (an account's mint list). */
export function ownedMintsIn(points: readonly SolTxPoint[], into: readonly string[] = []): string[] {
  const out = [...into];
  for (const p of points) for (const k of [p.preLamports, p.postLamports]) {
    const m = mintOfKey(k);
    if (m && !out.includes(m) && k.slice(m.length + 1, m.length + 2) === "W") out.push(m);
  }
  return out;
}

/** Mints a state key names (for an account's mint list). */
export function mintOfKey(key: string): string | null {
  if (key === ABSENT) return null;
  const i = key.lastIndexOf(":");
  const j = key.lastIndexOf(":", i - 1);
  return j > 0 ? key.slice(0, j) : null;
}

// ── Days ─────────────────────────────────────────────────────────────────────

/**
 * End-of-day state per day that HAD a transaction, from points in proven chain
 * order (oldest first; never re-sorted — same-slot order is the proof's).
 */
export function endOfDayKeys(pointsOldestFirst: readonly SolTxPoint[]): Array<[string, string]> {
  const m = new Map<string, string>();
  for (const p of pointsOldestFirst) m.set(p.dateISO, p.postLamports);
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

/**
 * Merge end-of-day keys. A BACKWARD chunk is older than what is staged: on a
 * shared boundary day the staged (newer) transaction closed the day, so
 * existing entries win. A HEAD chunk is newer: its entries win.
 */
export function mergeDays(staged: ReadonlyArray<[string, string]>, add: ReadonlyArray<[string, string]>, prefer: "existing" | "new"): Array<[string, string]> {
  const m = new Map<string, string>(staged);
  for (const [d, k] of add) if (prefer === "new" || !m.has(d)) m.set(d, k);
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

/** Keep the latest entry before `fromISO` (it carries into the range) and everything from it on. */
export function trimDays(days: ReadonlyArray<[string, string]>, fromISO: string): Array<[string, string]> {
  let carry: [string, string] | null = null;
  const out: Array<[string, string]> = [];
  for (const e of days) {
    if (e[0] < fromISO) carry = e;
    else out.push(e);
  }
  return carry ? [carry, ...out] : out;
}

/**
 * The wallet's raw amount of `mint` at the end of every day in [fromISO, toISO]:
 * the sum over its accounts of each account's attributed state on its latest
 * transaction day on or before d. An account with no transaction on or before d
 * contributes 0 — correct ONLY because the caller licenses a range no earlier
 * than every account's proven start (creation ⇒ 0 before it).
 */
export function mintDailyRaw(
  accounts: ReadonlyArray<{ days: ReadonlyArray<[string, string]> }>,
  mint: string, fromISO: string, toISO: string,
): Array<{ dateISO: string; raw: bigint }> {
  if (fromISO > toISO) return [];
  const cursors = accounts.map(() => ({ i: 0, key: ABSENT }));
  const out: Array<{ dateISO: string; raw: bigint }> = [];
  for (let d = fromISO, guard = 0; d <= toISO && guard < 10_000; d = addDaysISO(d, 1), guard++) {
    let sum = BigInt(0);
    accounts.forEach((a, n) => {
      const c = cursors[n];
      while (c.i < a.days.length && a.days[c.i][0] <= d) { c.key = a.days[c.i][1]; c.i++; }
      sum += attributedRaw(c.key, mint);
    });
    out.push({ dateISO: d, raw: sum });
  }
  return out;
}

// ── Token-2022 mint extensions ───────────────────────────────────────────────

/** Mint extensions under which the raw `amount` IS the holder's balance and every change to it is a stated delta. */
export const SAFE_MINT_EXTENSIONS: ReadonlySet<string> = new Set([
  "transferFeeConfig",      // fee withheld in withheldAmount (not the holder's); amount deltas stated
  "mintCloseAuthority", "defaultAccountState", "nonTransferable", "permanentDelegate",
  "transferHook", "metadataPointer", "tokenMetadata", "groupPointer", "groupMemberPointer",
  "tokenGroup", "tokenGroupMember", "pausableConfig", "uninitialized",
]);
const BALANCE_EXTENSIONS: ReadonlySet<string> = new Set(["interestBearingConfig", "scaledUiAmountConfig"]);
const CONFIDENTIAL_EXTENSIONS: ReadonlySet<string> = new Set(["confidentialTransferMint", "confidentialTransferFeeConfig", "confidentialMintBurn"]);

export type MintExtensionVerdict = "OK" | Extract<SplUnsupportedReason, "BALANCE_EXTENSION" | "CONFIDENTIAL_BALANCES" | "UNRECOGNISED_EXTENSION">;

/**
 * Judge a mint from its jsonParsed `getAccountInfo`. Throws on an unreadable
 * answer (the mint stays unchecked and is retried — never assumed safe).
 */
export function mintExtensionVerdict(result: unknown): MintExtensionVerdict {
  const info = (result as { value?: { data?: { parsed?: { type?: unknown; info?: { extensions?: unknown } } } } | null } | null)?.value?.data?.parsed;
  if (!info || info.type !== "mint") throw new SolProofDataError("mint account is not a parsed mint");
  const ext = info.info?.extensions;
  if (ext === undefined) return "OK";
  if (!Array.isArray(ext)) throw new SolProofDataError("mint extensions unreadable");
  const names = ext.map((e) => (e as { extension?: unknown })?.extension);
  if (names.some((n) => typeof n !== "string")) throw new SolProofDataError("mint extension unreadable");
  if (names.some((n) => BALANCE_EXTENSIONS.has(n as string))) return "BALANCE_EXTENSION";
  if (names.some((n) => CONFIDENTIAL_EXTENSIONS.has(n as string))) return "CONFIDENTIAL_BALANCES";
  if (names.some((n) => !SAFE_MINT_EXTENSIONS.has(n as string))) return "UNRECOGNISED_EXTENSION";
  return "OK";
}

// ── The persisted state (inside the SOL checkpoint on Connection.cursor) ─────

export interface SplAccountState {
  address: string;
  /** Every mint this account has held for the wallet (one, unless a keypair account was re-created for another). */
  mints: string[];
  program: string | null;
  /** Newest / oldest proven transaction (state keys in the lamport fields). */
  top: SolTxPoint | null;
  bottom: SolTxPoint | null;
  /** Backward listing cursor (a page whose transactions all sit in deferred slots is not re-read). */
  pageBefore: string | null;
  /** The walk reached the account's creation. */
  creation: boolean;
  /** Set when a continuity break stopped the walk: the first day proven above it. */
  provenFromISO: string | null;
  /** End-of-day state per day with a transaction, ascending (staged until its mints commit). */
  days: Array<[string, string]>;
  /** The last run whose current on-chain state matched `top`. */
  verifiedAtISO: string | null;
  headMismatches: number;
  failure: SplUnsupportedReason | null;
  signatures: number;
}

export type SplMintStatus = "PENDING" | "COMPLETE" | "PARTIAL" | "UNSUPPORTED";

export interface SplMintState {
  mint: string;
  decimals: number;
  program: string | null;
  status: SplMintStatus;
  reason: SplUnsupportedReason | null;
  licensedFromISO: string | null;
  licensedToISO: string | null;
  /** Token-2022 only; null = not checked yet. Classic SPL mints have no extensions. */
  extension: MintExtensionVerdict | null;
}

export interface SplHistoryState {
  kind: typeof SPL_STATE_KIND;
  v: typeof SPL_STATE_VERSION;
  discovery: {
    /** NATIVE: the native backfill fed every owner transaction from its first page. WALK: re-walked here. */
    source: "NATIVE" | "WALK";
    walkBefore: string | null;
    walkDone: boolean;
    walkSignatures: number;
  };
  accounts: SplAccountState[];
  mints: SplMintState[];
  /** Discovered accounts beyond MAX_TRACKED_ACCOUNTS — the inventory can never be complete while > 0. */
  overflow: number;
  /** Discovery complete, nothing overflowed, and every discovered mint has a terminal, licensed verdict. */
  inventoryComplete: boolean;
  lastRunAtISO: string | null;
}

export function freshSplState(source: "NATIVE" | "WALK"): SplHistoryState {
  return {
    kind: SPL_STATE_KIND, v: SPL_STATE_VERSION,
    discovery: { source, walkBefore: null, walkDone: false, walkSignatures: 0 },
    accounts: [], mints: [], overflow: 0, inventoryComplete: false, lastRunAtISO: null,
  };
}

/** Read the `tokens` member of a SOL checkpoint. Anything not this shape at this version ⇒ null (start fresh). */
export function parseSplState(raw: unknown): SplHistoryState | null {
  const s = raw as Partial<SplHistoryState> | null | undefined;
  if (!s || typeof s !== "object" || s.kind !== SPL_STATE_KIND || s.v !== SPL_STATE_VERSION) return null;
  if (!s.discovery || (s.discovery.source !== "NATIVE" && s.discovery.source !== "WALK")) return null;
  if (!Array.isArray(s.accounts) || !Array.isArray(s.mints)) return null;
  for (const a of s.accounts) {
    if (!a || typeof a.address !== "string" || !Array.isArray(a.mints) || !Array.isArray(a.days)) return null;
    if ((a.top == null) !== (a.bottom == null)) return null;
  }
  for (const m of s.mints) if (!m || typeof m.mint !== "string" || !isValidDecimals(m.decimals)) return null;
  return s as SplHistoryState;
}

function blankAccount(address: string, mint: string, program: string | null): SplAccountState {
  return {
    address, mints: [mint], program, top: null, bottom: null, pageBefore: null, creation: false,
    provenFromISO: null, days: [], verifiedAtISO: null, headMismatches: 0, failure: null, signatures: 0,
  };
}

/**
 * Fold discovered accounts (current enumeration or transaction history) into the
 * state. Idempotent. Priced mints claim the bounded account slots first; beyond
 * the bound an account is counted in `overflow`, never silently dropped.
 */
export function mergeDiscovered(
  state: SplHistoryState,
  found: readonly DiscoveredTokenAccount[],
  isPriced: (mint: string) => boolean = () => false,
): SplHistoryState {
  const accounts = state.accounts.map((a) => ({ ...a, mints: [...a.mints] }));
  const mints = state.mints.map((m) => ({ ...m }));
  const byAddr = new Map(accounts.map((a) => [a.address, a]));
  const overflowSeen = new Set<string>();
  const ordered = [...found].sort((x, y) => Number(isPriced(y.mint)) - Number(isPriced(x.mint)) || x.address.localeCompare(y.address));
  for (const f of ordered) {
    let a = byAddr.get(f.address);
    if (!a) {
      if (accounts.length >= MAX_TRACKED_ACCOUNTS) {
        overflowSeen.add(f.address);
        continue;
      }
      a = blankAccount(f.address, f.mint, f.program);
      accounts.push(a);
      byAddr.set(f.address, a);
    } else if (!a.mints.includes(f.mint)) {
      a.mints.push(f.mint);
    }
    if (!a.program && f.program) a.program = f.program;
    if (!mints.some((m) => m.mint === f.mint)) {
      mints.push({
        mint: f.mint, decimals: f.decimals, program: f.program, status: "PENDING", reason: null,
        licensedFromISO: null, licensedToISO: null,
        extension: f.program === TOKEN_2022_PROGRAM_ID ? null : "OK",
      });
    } else {
      const m = mints.find((x) => x.mint === f.mint)!;
      // A mint seen under Token-2022 must be checked even if first seen without a program id.
      if (f.program === TOKEN_2022_PROGRAM_ID && m.program !== TOKEN_2022_PROGRAM_ID) { m.program = f.program; m.extension = null; }
      else if (!m.program && f.program) m.program = f.program;
    }
  }
  // Untracked addresses are not stored, so each merge counts the ones IT could
  // not place; the state keeps the largest count seen (never back to 0 by forgetting).
  return { ...state, accounts, mints, overflow: Math.max(overflowSeen.size, state.overflow) };
}

/**
 * A decision for a mint whose licence was ALREADY committed. Its staged days
 * were trimmed at commit, so its start is the committed one — moved LATER only
 * when a newly proven gap says the earlier stretch no longer holds, and a
 * COMPLETE mint that gained a gapped account becomes PARTIAL. Never earlier.
 */
export function continueDecision(m: SplMintState, d: MintDecision): MintDecision {
  if (!m.licensedFromISO || (m.status !== "COMPLETE" && m.status !== "PARTIAL")) return d;
  if (d.status !== "COMPLETE" && d.status !== "PARTIAL") return d;
  const from = d.status === "PARTIAL" && d.fromISO && d.fromISO > m.licensedFromISO ? d.fromISO : m.licensedFromISO;
  const status: SplMintStatus = m.status === "PARTIAL" || d.status === "PARTIAL" ? "PARTIAL" : "COMPLETE";
  return { status, reason: null, fromISO: from, toISO: d.toISO };
}

/** Program of a mint, for its token-2022 check. Classic SPL needs none. */
export function needsExtensionCheck(m: SplMintState): boolean {
  return m.extension === null && m.program !== SPL_TOKEN_PROGRAM_ID;
}

/** Is token-account discovery complete? */
export function discoveryComplete(state: SplHistoryState, native: { reachedBeginning: boolean; gap: unknown | null }): boolean {
  if (native.gap) return false; // the native walk stopped: owner transactions below the gap are unlisted
  return state.discovery.source === "NATIVE" ? native.reachedBeginning : state.discovery.walkDone;
}

/** Is one account finished walking (verified or not)? */
export function accountWalked(a: SplAccountState): boolean {
  return a.failure !== null || a.creation || (a.top !== null && a.provenFromISO !== null);
}

export interface MintDecision {
  status: SplMintStatus;
  reason: SplUnsupportedReason | null;
  fromISO: string | null;
  toISO: string | null;
}

/**
 * THE per-mint verdict. `verifiedThisRun` lists accounts whose newest proven
 * state matched the chain's current state in THIS run (anchored `todayISO`).
 */
export function decideMint(
  m: SplMintState,
  accounts: readonly SplAccountState[],
  ctx: { discoveryComplete: boolean; verifiedThisRun: ReadonlySet<string>; todayISO: string },
): MintDecision {
  const pending: MintDecision = { status: "PENDING", reason: null, fromISO: null, toISO: null };
  const refuse = (reason: SplUnsupportedReason): MintDecision => ({ status: "UNSUPPORTED", reason, fromISO: null, toISO: null });
  if (m.extension && m.extension !== "OK") return refuse(m.extension);
  const mine = accounts.filter((a) => a.mints.includes(m.mint));
  const failed = mine.find((a) => a.failure !== null);
  if (failed) return refuse(failed.failure!);
  // Repeatedly disagreeing with the chain is a refusal — but a retryable one:
  // the account keeps being checked, and a later match re-decides the mint.
  if (mine.some((a) => a.headMismatches >= HEAD_MISMATCH_LIMIT && !ctx.verifiedThisRun.has(a.address))) return refuse("RECONCILIATION_MISMATCH");
  if (m.extension === null && m.program !== SPL_TOKEN_PROGRAM_ID) return pending;
  if (!ctx.discoveryComplete || mine.length === 0) return pending;
  if (!mine.every(accountWalked)) return pending;
  if (!mine.every((a) => ctx.verifiedThisRun.has(a.address))) return pending;
  const gapStarts = mine.map((a) => a.provenFromISO).filter((d): d is string => d !== null).sort();
  const firstDays = mine.map((a) => a.days[0]?.[0] ?? a.top?.dateISO ?? ctx.todayISO).sort();
  if (gapStarts.length > 0) {
    const from = gapStarts[gapStarts.length - 1];
    return { status: "PARTIAL", reason: null, fromISO: from, toISO: ctx.todayISO };
  }
  return { status: "COMPLETE", reason: null, fromISO: firstDays[0], toISO: ctx.todayISO };
}

/** The coverage a decision persists — the existing ChainCoverage union. */
export function coverageForDecision(d: MintDecision): ChainCoverage | null {
  if (d.status === "COMPLETE" && d.fromISO && d.toISO) return { kind: "COMPLETE", fromISO: d.fromISO, toISO: d.toISO, source: SPL_CONTINUITY_SOURCE };
  if (d.status === "PARTIAL" && d.fromISO && d.toISO) {
    return { kind: "PARTIAL", coveredFromISO: d.fromISO, coveredToISO: d.toISO, caveats: ["ADDRESS_INDEX_INCOMPLETE"], source: SPL_CONTINUITY_SOURCE };
  }
  if (d.status === "UNSUPPORTED" && d.reason) return { kind: "UNKNOWN", caveats: [REASON_CAVEAT[d.reason]], source: SPL_CONTINUITY_SOURCE };
  return null;
}

/** The inventory answer the wallet-level completeness rule reads. */
export function inventoryCompleteOf(state: SplHistoryState, discoveryDone: boolean): boolean {
  return discoveryDone && state.overflow === 0
    && state.mints.every((m) => m.status === "COMPLETE");
}

/**
 * Does this wallet owe token-history work the worker should run it for, even
 * when its native history is COMPLETE? Never true for work only the native
 * backfill can do (NATIVE discovery waits on it), nor for accounts beyond the
 * bound (never tracked), nor for refused mints.
 */
export function splWorkOwed(state: SplHistoryState | null, native: { reachedBeginning: boolean; gap: unknown | null; top: unknown | null }): boolean {
  if (!native.top) return false; // native first
  if (!state) return true;       // never run
  if (state.discovery.source === "WALK" && !state.discovery.walkDone && !native.gap) return true;
  const refused = new Set(state.mints.filter((m) => (m.extension && m.extension !== "OK") || (m.status === "UNSUPPORTED" && m.reason !== "RECONCILIATION_MISMATCH")).map((m) => m.mint));
  if (state.accounts.some((a) => !accountWalked(a) && a.mints.some((m) => !refused.has(m)))) return true;
  // A PENDING mint needs a run when it awaits its Token-2022 check, or when
  // everything it needs is walked and discovered — the run verifies and decides
  // it. One still waiting on the NATIVE backfill's discovery is native's work.
  const discovered = discoveryComplete(state, native);
  return state.mints.some((m) => m.status === "PENDING" && !refused.has(m.mint)
    && (needsExtensionCheck(m) || (discovered && state.accounts.filter((a) => a.mints.includes(m.mint)).every(accountWalked))));
}

/** Mints in work order: priced first (a real token is never starved by spam), then by mint. */
export function orderMints(mints: readonly SplMintState[], isPriced: (mint: string) => boolean): SplMintState[] {
  return [...mints].sort((a, b) => Number(isPriced(b.mint)) - Number(isPriced(a.mint)) || a.mint.localeCompare(b.mint));
}

/** Which accounts to anchor on: the current-state lookup by address. */
export function currentByAddress(entries: ReadonlyArray<{ tokenAccount: string; mint: string; amount: bigint }>): Map<string, { mint: string; amount: bigint }> {
  return new Map(entries.map((e) => [e.tokenAccount, { mint: e.mint, amount: e.amount }]));
}
