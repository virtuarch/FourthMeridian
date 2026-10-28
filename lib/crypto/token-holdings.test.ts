/**
 * lib/crypto/token-holdings.test.ts
 *
 * TOKEN HOLDINGS FOUNDATION (PR-A) — deterministic fixtures only (documented RPC
 * response shapes; no network, no database).
 *
 *     npx tsx --require ./scripts/lib/server-only-preload.cjs lib/crypto/token-holdings.test.ts
 *
 * Pinned: grouping several token accounts per mint, Token-2022, zero-balance
 * exclusion, BigInt/decimals exactness, one Instrument per token across two
 * customers, budget exhaustion skipping token capture without touching native,
 * token failure isolation, unpriced exclusion (never zero), and wallet history
 * completeness per instrument.
 */

import { readFileSync } from "fs";
import { join } from "path";
import {
  SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_ALIAS_PROVIDER, NOT_TOKEN_INSTRUMENT,
  parseSplTokenAccounts, groupSplHoldings, parseAlchemyTokenBalances, parseAlchemyTokenMetadata, erc20Holding,
  baseUnitsToWhole, splTokenAssetKey, erc20AssetKey, parseTokenAssetKey, sanitizeTokenText, tokenDisplayLabel,
} from "./token-asset";
import { fetchSolTokenHoldings, fetchErc20TokenHoldings } from "./token-rpc";
import { CRYPTO_PROVIDER } from "@/lib/investments/crypto-instrument";
import { resolveTokenInstrumentId } from "@/lib/crypto/token-instrument";
import { syncWalletTokens, WALLET_TOKEN_POSITION_SOURCE, tokenCaptureConfig } from "./wallet-token-capture";
import { composeWalletValue, type WalletCurrentValue } from "./wallet-current-value";
import { facetFromCoverage, walletHistoryComplete } from "./wallet-instrument-history";
import { fetchCoinGeckoTokenQuotes } from "@/lib/prices/providers/coingecko";
import { connectionHealth, connectionHistory, tokenHistoryLabel, formatTokenQuantity } from "@/lib/connections/connection-detail.core";
import type { InstrumentValuation } from "@/lib/investments/valuation-core";

let failures = 0, passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}
const read = (...s: string[]) => readFileSync(join(process.cwd(), ...s), "utf8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");

const OWNER = "7irKpd1C5iRtmMhVfXF2YzKnK1j1m6g9jUKu6XrqBMSN";
const USDC  = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PYUSD = "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo"; // a Token-2022 mint
const SPAM  = "SpamMint1111111111111111111111111111111111";

/** A `getTokenAccountsByOwner` jsonParsed account (Solana RPC docs shape). */
function splAccount(pubkey: string, mint: string, amount: string, decimals: number, program = "spl-token") {
  return {
    pubkey,
    account: {
      data: { program, parsed: { type: "account", info: { isNative: false, mint, owner: OWNER, state: "initialized",
        tokenAmount: { amount, decimals, uiAmount: Number(amount) / 10 ** decimals, uiAmountString: "ignored" } } }, space: 165 },
      executable: false, lamports: 2039280, owner: program === "spl-token" ? SPL_TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID, rentEpoch: 0,
    },
  };
}
const rpcOk = (value: unknown) => ({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value } });

async function main(): Promise<void> {
// ══ SOLANA: GROUPING, TOKEN-2022, ZERO EXCLUSION ══════════════════════════════
{
  const classic = rpcOk([
    splAccount("AtaUsdc1", USDC, "1500000", 6),          // 1.5 USDC (ATA)
    splAccount("AuxUsdc2", USDC, "2500001", 6),          // 2.500001 USDC (auxiliary account)
    splAccount("Empty3",   SPAM, "0", 9),                // empty account kept alive — not a position
  ]);
  const t22 = rpcOk([splAccount("Pyusd4", PYUSD, "42000000", 6, "spl-token-2022")]);
  const a = parseSplTokenAccounts(classic, SPL_TOKEN_PROGRAM_ID);
  const b = parseSplTokenAccounts(t22, TOKEN_2022_PROGRAM_ID);
  const { holdings, refusedMints } = groupSplHoldings([...a.entries, ...b.entries]);
  const usdc = holdings.find((h) => h.contract === USDC);
  check("two token accounts for one mint are SUMMED as BigInt", usdc?.rawAmount === "4000001", usdc?.rawAmount);
  check("the summed quantity is exact (4.000001)", usdc?.quantity === 4.000001, String(usdc?.quantity));
  check("every token account is kept as evidence", JSON.stringify(usdc?.tokenAccounts) === JSON.stringify(["AtaUsdc1", "AuxUsdc2"]));
  check("a zero-balance token account is NOT a position", !holdings.some((h) => h.contract === SPAM));
  const py = holdings.find((h) => h.contract === PYUSD);
  check("Token-2022 holdings are read and carry their program as evidence", py?.program === TOKEN_2022_PROGRAM_ID && py.quantity === 42);
  check("Token-2022 shares the CAIP-19 token namespace", py?.assetKey === `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:${PYUSD}`);
  check("no mint refused on coherent data", refusedMints.length === 0);
  const bad = groupSplHoldings([
    { tokenAccount: "x", mint: USDC, program: SPL_TOKEN_PROGRAM_ID, amount: BigInt(1), decimals: 6 },
    { tokenAccount: "y", mint: USDC, program: SPL_TOKEN_PROGRAM_ID, amount: BigInt(1), decimals: 9 },
  ]);
  check("accounts disagreeing about a mint's decimals are refused, not guessed", bad.refusedMints[0] === USDC && bad.holdings.length === 0);
  let threw = false;
  try { parseSplTokenAccounts({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "bad" } }, SPL_TOKEN_PROGRAM_ID); } catch { threw = true; }
  check("an RPC error member throws — never an empty wallet", threw);
  check("uiAmount (a pre-rounded float) is never read", !/uiAmount\b/.test(code(read("lib", "crypto", "token-asset.ts"))));
}

// ══ BIGINT / DECIMALS EXACTNESS ═══════════════════════════════════════════════
{
  check("10^18 base units at 18 decimals is exactly 1", baseUnitsToWhole(BigInt("1000000000000000000"), 18) === 1);
  const huge = "123456789012345678901234567890"; // > 2^53 base units
  const parsed = parseAlchemyTokenBalances({ jsonrpc: "2.0", id: 1, result: { address: "0x1", tokenBalances: [
    { contractAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", tokenBalance: "0x" + BigInt(huge).toString(16).padStart(64, "0") },
  ] } });
  const h = erc20Holding(parsed.entries[0], { decimals: 18, symbol: "BIG", name: null });
  check("a raw amount beyond 2^53 survives losslessly as the decimal string", h?.rawAmount === huge, h?.rawAmount);
  check("its whole part is exact (123456789012)", Math.floor(h!.quantity) === 123456789012, String(h?.quantity));
  check("0 decimals is an integer count", baseUnitsToWhole(BigInt(7), 0) === 7);
  let threw = false;
  try { baseUnitsToWhole(BigInt(1), 255); } catch { threw = true; }
  check("absurd decimals are refused, not rounded", threw);
  check("ERC-20 identity is the LOWERCASE contract", erc20AssetKey("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48") === "eip155:1/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
  check("token keys parse back; native keys are not tokens",
    parseTokenAssetKey(splTokenAssetKey(USDC))?.contract === USDC && parseTokenAssetKey("eip155:1/slip44:60") === null);
}

// ══ ERC-20: ZERO EXCLUSION, UNREADABLE ≠ ZERO, PAGINATION, METADATA ═══════════
{
  const page1 = { jsonrpc: "2.0", id: 1, result: { address: "0xabc", pageKey: "pk2", tokenBalances: [
    { contractAddress: "0x1111111111111111111111111111111111111111", tokenBalance: "0x" + "0".repeat(64) },               // zero
    { contractAddress: "0x2222222222222222222222222222222222222222", tokenBalance: "0x" + (BigInt(5) * BigInt(10) ** BigInt(6)).toString(16).padStart(64, "0") },
  ] } };
  const page2 = { jsonrpc: "2.0", id: 1, result: { address: "0xabc", tokenBalances: [
    { contractAddress: "0x3333333333333333333333333333333333333333", tokenBalance: null, error: "execution reverted" },
  ] } };
  const meta = { jsonrpc: "2.0", id: 1, result: { decimals: 6, symbol: "US‮DC", name: "USD Coin", logo: null } };
  const sent: string[] = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    const req = JSON.parse(init.body) as { method: string; params: unknown[] };
    sent.push(req.method);
    const body = req.method === "alchemy_getTokenBalances" ? (req.params[2] ? page2 : page1) : meta;
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
  const meter: Record<string, number> = {};
  {
    const e = await fetchErc20TokenHoldings("0xabc", { rpcUrl: "http://fixture", fetchImpl, meter, callBudget: 10 },
      { maxPages: 3, knownMetadata: async () => new Map() });
    check("zero ERC-20 balances are not positions", e.holdings.length === 1 && e.holdings[0].contract === "0x2222222222222222222222222222222222222222");
    check("an errored balance is UNSTATED (never zero) and makes the enumeration incomplete",
      e.unstated.some((u) => u.contract === "0x3333333333333333333333333333333333333333") && e.complete === false);
    check("pageKey pagination is followed", sent.filter((m) => m === "alchemy_getTokenBalances").length === 2);
    check("metadata is fetched only for NON-ZERO contracts", sent.filter((m) => m === "alchemy_getTokenMetadata").length === 1);
    check("every request is metered by method",
      meter.alchemy_getTokenBalances === 2 && meter.alchemy_getTokenMetadata === 1 && e.calls === 3);
    check("attacker-controlled symbol text is sanitised (bidi override stripped)", e.holdings[0].symbol === "USDC", String(e.holdings[0].symbol));
  }
  sent.length = 0;
  const m2: Record<string, number> = {};
  const known = await fetchErc20TokenHoldings("0xabc", { rpcUrl: "http://fixture", fetchImpl, meter: m2, callBudget: 10 },
    { maxPages: 3, knownMetadata: async () => new Map([["0x2222222222222222222222222222222222222222", { decimals: 6, symbol: "USDC", name: "USD Coin" }]]) });
  check("a repeat sync spends NO metadata call for a contract whose decimals are known",
    !sent.includes("alchemy_getTokenMetadata") && known.holdings[0].quantity === 5);
  const m3: Record<string, number> = {};
  const capped = await fetchErc20TokenHoldings("0xabc", { rpcUrl: "http://fixture", fetchImpl, meter: m3, callBudget: 1 },
    { maxPages: 3, knownMetadata: async () => new Map() }).catch((e: Error) => e);
  check("the call budget is a HARD ceiling (second page not sent)", capped instanceof Error && m3.alchemy_getTokenBalances === 1);
  check("metadata parse refuses unusable decimals", parseAlchemyTokenMetadata({ jsonrpc: "2.0", id: 1, result: { decimals: null } }).decimals === null);
  check("a long name is bounded", (sanitizeTokenText("x".repeat(500), 64) ?? "").length === 64);
  check("display falls back to the shortened mint", tokenDisplayLabel({ symbol: null, contract: USDC }) === "EPjF…Dt1v");
}

// ══ SOLANA TRANSPORT: TWO PROGRAMS, TWO METERED CALLS ═════════════════════════
{
  const programs: string[] = [];
  const fetchImpl = (async (_u: string, init: { body: string }) => {
    const req = JSON.parse(init.body) as { params: [string, { programId: string }, { encoding: string }] };
    programs.push(req.params[1].programId);
    const body = req.params[1].programId === SPL_TOKEN_PROGRAM_ID
      ? rpcOk([splAccount("Ata1", USDC, "1000000", 6)]) : rpcOk([splAccount("P1", PYUSD, "1", 6, "spl-token-2022")]);
    check("jsonParsed encoding is requested", req.params[2].encoding === "jsonParsed");
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
  const meter: Record<string, number> = {};
  const e = await fetchSolTokenHoldings(OWNER, { rpcUrl: "http://fixture", fetchImpl, meter, callBudget: 2 });
  check("BOTH token programs are queried (classic + Token-2022)", JSON.stringify(programs) === JSON.stringify([SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]));
  check("exactly 2 metered calls per SOL capture", meter.getTokenAccountsByOwner === 2 && e.calls === 2 && e.complete);
}

// ══ IN-MEMORY CLIENT (fixture) ═════════════════════════════════════════════════
type Row = Record<string, unknown>;
function fakeClient() {
  const instruments: Row[] = [];
  const aliases: Row[] = [];
  const positions: Row[] = [];
  const prices: Row[] = [];
  const calls = { tickerLookups: 0, writes: 0 };
  let id = 0;
  const matchPos = (r: Row, w: Row): boolean => {
    for (const [k, v] of Object.entries(w)) {
      if (k === "OR") { if (!(v as Row[]).some((o) => matchPos(r, o))) return false; continue; }
      if (k === "date" && v && typeof v === "object" && !(v instanceof Date)) {
        const d = (r.date as Date).getTime();
        if ("lte" in (v as Row) && d > ((v as Row).lte as Date).getTime()) return false;
        if ("lt" in (v as Row) && d >= ((v as Row).lt as Date).getTime()) return false;
        continue;
      }
      if (v instanceof Date) { if ((r[k] as Date).getTime() !== v.getTime()) return false; continue; }
      if (r[k] !== v) return false;
    }
    return true;
  };
  const client = {
    instrument: {
      findFirst: async () => { calls.tickerLookups++; return null; },
      create: async ({ data }: { data: Row & { aliases: { create: Row } } }) => {
        const inst = { id: `inst_${++id}`, ...data }; delete (inst as Row).aliases;
        instruments.push(inst);
        if (aliases.some((a) => a.provider === data.aliases.create.provider && a.externalId === data.aliases.create.externalId)) throw new Error("unique");
        aliases.push({ instrumentId: inst.id, ...data.aliases.create });
        calls.writes++;
        return { id: inst.id };
      },
    },
    instrumentAlias: {
      findUnique: async ({ where }: { where: { provider_externalId: { provider: string; externalId: string } } }) =>
        aliases.find((a) => a.provider === where.provider_externalId.provider && a.externalId === where.provider_externalId.externalId) ?? null,
      findMany: async ({ where }: { where: { provider: string; externalId?: { in: string[] }; instrumentId?: { in: string[] } } }) =>
        aliases.filter((a) => a.provider === where.provider
          && (!where.externalId || where.externalId.in.includes(a.externalId as string))
          && (!where.instrumentId || where.instrumentId.in.includes(a.instrumentId as string))),
      update: async ({ where, data }: { where: { provider_externalId: { externalId: string } }; data: Row }) => {
        const a = aliases.find((x) => x.externalId === where.provider_externalId.externalId)!; Object.assign(a, data); return a;
      },
    },
    positionObservation: {
      upsert: async ({ where, create, update }: { where: { financialAccountId_instrumentId_date_origin_source: Row }; create: Row; update: Row }) => {
        const k = where.financialAccountId_instrumentId_date_origin_source;
        const ex = positions.find((p) => matchPos(p, k));
        calls.writes++;
        if (ex) Object.assign(ex, update); else positions.push({ ...create, supersededById: null, deletedAt: null });
      },
      groupBy: async ({ where }: { where: Row }) => {
        const by = new Map<string, Date>();
        for (const p of positions.filter((p) => matchPos(p, where))) {
          const k = p.instrumentId as string; const d = p.date as Date;
          if (!by.has(k) || by.get(k)!.getTime() < d.getTime()) by.set(k, d);
        }
        return [...by].map(([instrumentId, d]) => ({ instrumentId, _max: { date: d } }));
      },
      findMany: async ({ where }: { where: Row }) => positions.filter((p) => matchPos(p, where)),
    },
    priceObservation: {
      findUnique: async () => null,
      upsert: async ({ create }: { create: Row }) => { prices.push(create); calls.writes++; },
    },
  };
  return { client, instruments, aliases, positions, prices, calls };
}

// ══ ONE INSTRUMENT PER TOKEN ACROSS CUSTOMERS; NEVER BY TICKER ════════════════
{
  check("the token alias namespace IS the crypto namespace (no second vocabulary)", TOKEN_ALIAS_PROVIDER === CRYPTO_PROVIDER);
  const f = fakeClient();
  const spec = { assetKey: splTokenAssetKey(USDC), standard: "SPL" as const, contract: USDC, decimals: 6, symbol: "USDC", name: "USD Coin" };
  const a = await resolveTokenInstrumentId(spec, { client: f.client as never });   // customer A's wallet
  const b = await resolveTokenInstrumentId(spec, { client: f.client as never });   // customer B's wallet
  check("two customers holding one mint resolve to ONE Instrument", a === b && f.instruments.length === 1);
  check("a token Instrument carries NO ticker (no ticker-routed price path can reach it)", f.instruments[0].tickerSymbol === null);
  check("token identity never looks up an instrument by ticker", f.calls.tickerLookups === 0);
  const spoof = await resolveTokenInstrumentId({ ...spec, assetKey: erc20AssetKey("0x" + "9".repeat(40)), standard: "ERC20", contract: "0x" + "9".repeat(40), symbol: "USDC" }, { client: f.client as never });
  check("same ticker, different contract ⇒ a DIFFERENT instrument", spoof !== a && f.instruments.length === 2);
}

// ══ CAPTURE: BUDGET, ISOLATION, POSITIONS, CLOSURE ════════════════════════════
const cfg = { ...tokenCaptureConfig({}), maxQuotedTokens: 0 };
const solFetch = (value: unknown[]) => (async (_u: string, init: { body: string }) => {
  const req = JSON.parse(init.body) as { params: [string, { programId: string }] };
  return { ok: true, status: 200, json: async () => rpcOk(req.params[1].programId === SPL_TOKEN_PROGRAM_ID ? value : []) } as unknown as Response;
}) as unknown as typeof fetch;
{
  const f = fakeClient();
  let fetched = 0;
  const out = await syncWalletTokens({ client: f.client as never, accountId: "acct_sol", chain: "SOL", address: OWNER, deps: {
    rpcUrl: "http://fixture", observationsEnabled: true, config: cfg, dailyCap: 1000,
    usageToday: async () => ({ solana: 900, other: 100 }),            // budget fully spent today
    fetchImpl: (async () => { fetched++; throw new Error("must not be called"); }) as unknown as typeof fetch,
    recordUsage: async () => {},
  } });
  check("budget exhausted ⇒ token capture SKIPPED, stated as such", out.status === "SKIPPED" && out.skipReason === "BUDGET_EXHAUSTED");
  check("budget exhausted ⇒ no provider request sent, nothing written", fetched === 0 && f.calls.writes === 0);
  const unknown = await syncWalletTokens({ client: f.client as never, accountId: "acct_sol", chain: "SOL", address: OWNER, deps: {
    rpcUrl: "http://fixture", observationsEnabled: true, config: cfg, usageToday: async () => null, recordUsage: async () => {},
  } });
  check("an unreadable budget is not 'plenty' ⇒ SKIPPED BUDGET_UNKNOWN", unknown.skipReason === "BUDGET_UNKNOWN");
}
{
  const f = fakeClient();
  const recorded: Array<Record<string, number>> = [];
  const out = await syncWalletTokens({ client: f.client as never, accountId: "acct_sol", chain: "SOL", address: OWNER, deps: {
    rpcUrl: "http://fixture", observationsEnabled: true, config: cfg, dailyCap: 1000, usageToday: async () => ({ solana: 0, other: 0 }),
    fetchImpl: (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch,
    recordUsage: async (_n, m) => { recorded.push({ ...m }); },
  } });
  check("a token provider failure is an OUTCOME (FAILED), never a throw", out.status === "FAILED" && /ECONNRESET/.test(out.reason ?? ""));
  check("a failed token capture writes nothing", f.calls.writes === 0);
  check("the failed request was still metered into the shared budget", recorded.length === 1 && recorded[0].getTokenAccountsByOwner === 1);
}
{
  const f = fakeClient();
  const day1 = new Date("2026-10-28T12:00:00Z");
  const deps = { rpcUrl: "http://fixture", observationsEnabled: true, config: cfg, dailyCap: 1000,
    usageToday: async () => ({ solana: 0, other: 0 }), recordUsage: async () => {} };
  const out = await syncWalletTokens({ client: f.client as never, accountId: "acct_sol", chain: "SOL", address: OWNER, deps: {
    ...deps, now: day1, fetchImpl: solFetch([splAccount("Ata1", USDC, "1500000", 6), splAccount("Ata2", USDC, "500000", 6)]) } });
  check("captured: one OBSERVED token position per (account, token, day)",
    out.status === "CAPTURED" && f.positions.length === 1 && f.positions[0].source === WALLET_TOKEN_POSITION_SOURCE && f.positions[0].quantity === 2);
  check("the token row is quantity-only (no invented price/value/cost basis)",
    f.positions[0].institutionPrice === null && f.positions[0].institutionValue === null && f.positions[0].costBasis === null);
  check("the outcome carries the lossless raw amount", out.tokens[0].rawAmount === "2000000" && out.tokens[0].decimals === 6);
  check("2 Alchemy calls metered for a SOL capture", out.providerCalls === 2);
  const day2 = new Date("2026-10-29T12:00:00Z");
  const out2 = await syncWalletTokens({ client: f.client as never, accountId: "acct_sol", chain: "SOL", address: OWNER, deps: {
    ...deps, now: day2, fetchImpl: solFetch([]) } });
  const closure = f.positions.find((p) => (p.date as Date).toISOString().startsWith("2026-10-29"));
  check("a token no longer listed after a COMPLETE enumeration is CLOSED with an explicit 0", out2.closedInstrumentIds.length === 1 && closure?.quantity === 0);
}
{
  const f = fakeClient();
  const deps = { rpcUrl: "http://fixture", observationsEnabled: true, config: cfg, dailyCap: 1000,
    usageToday: async () => ({ solana: 0, other: 0 }), recordUsage: async () => {} };
  await syncWalletTokens({ client: f.client as never, accountId: "a", chain: "SOL", address: OWNER, deps: {
    ...deps, now: new Date("2026-10-28T00:00:00Z"), fetchImpl: solFetch([splAccount("Ata1", USDC, "1", 6)]) } });
  const incomplete = await syncWalletTokens({ client: f.client as never, accountId: "a", chain: "SOL", address: OWNER, deps: {
    ...deps, now: new Date("2026-10-29T00:00:00Z"),
    fetchImpl: solFetch([{ pubkey: "garbage", account: { data: { parsed: { info: { mint: USDC, tokenAmount: { amount: "1.5", decimals: 6 } } } } } }]) } });
  check("an INCOMPLETE enumeration closes nothing (a page we could not read is not evidence a token is gone)",
    incomplete.complete === false && incomplete.closedInstrumentIds.length === 0 && f.positions.length === 1);
  const gate = await syncWalletTokens({ client: f.client as never, accountId: "a", chain: "SOL", address: OWNER, deps: { ...deps, observationsEnabled: false } });
  check("observation gate off ⇒ SKIPPED GATE_OFF", gate.skipReason === "GATE_OFF");
  const btc = await syncWalletTokens({ client: f.client as never, accountId: "a", chain: "BTC", address: "bc1q", deps });
  check("a chain without tokens here is NOT_SUPPORTED", btc.skipReason === "NOT_SUPPORTED");
}

// ══ NATIVE SYNC IS UNTOUCHED BY THE TOKEN FACET (source pins) ═════════════════
{
  for (const file of ["sol-sync.ts", "evm-native.ts"]) {
    const src = code(read("lib", "crypto", file));
    const tokenAt = src.indexOf("syncWalletTokens(");
    check(`${file}: token capture runs only AFTER the lifecycle write and spine alignment`,
      tokenAt > src.indexOf('syncStatus: "synced", lastUpdated: new Date()') && tokenAt > src.indexOf("alignWalletProviderSpine({"));
    check(`${file}: token capture is wrapped so a defect cannot fail the native sync`,
      /try \{\s*tokenHoldings = await syncWalletTokens\(/.test(src));
    check(`${file}: the success return is still unconditional ok:true after token capture`,
      src.lastIndexOf("ok: true") > tokenAt || src.lastIndexOf("ok:                    true") > tokenAt);
  }
  const cap = code(read("lib", "crypto", "wallet-token-capture.ts"));
  check("token capture never records a SyncIssue or touches Connection state",
    !/recordSyncIssue|recordWalletSyncRefusal|errorCode/.test(cap));
  check("token capture never writes PositionCoverage (history not reconstructed ⇒ nothing licensed)",
    !/persistPositionCoverage|positionCoverage\./.test(cap));
  check("token capture never writes a balance column", !/financialAccount\.update|nativeBalance|balance:/.test(cap));
  check("token capture takes its client explicitly (no defaulted authority)", !/from "@\/lib\/db"/.test(cap) && !/\?\?\s*db\b/.test(cap));
}

// ══ VALUATION HONESTY: UNPRICED TOKENS EXCLUDED, NEVER ZERO ═══════════════════
{
  const seed: WalletCurrentValue = {
    accountId: "w", chain: "SOL", assetKey: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/slip44:501", symbol: "SOL",
    quantity: null, value: null, state: "NO_OBSERVATION", asOf: "2026-10-28", priceDate: null, price: null,
    observedAt: new Date("2026-10-28T10:00:00Z"), freshness: "LIVE", tokens: [],
  };
  const comp = (instrumentId: string, quantity: number, reportingValue: number | null, priceDate: string | null): InstrumentValuation => ({
    instrumentId, accountId: "w", quantity, nativePrice: null, nativeValue: reportingValue, reportingValue, currency: "USD", reportingCurrency: "USD",
    quantityTier: "observed" as never, priceTier: "observed" as never, fxTier: "observed" as never, overallTier: "observed" as never,
    basisUsed: "raw-close", priceDate, staleDays: 0, reason: "", conflicted: false,
  });
  const tokenBy = new Map([
    ["inst_usdc", { assetKey: splTokenAssetKey(USDC), label: "USDC" }],
    ["inst_spam", { assetKey: splTokenAssetKey(SPAM), label: "Spam…1111" }],
  ]);
  const args = { seed, tokenByInstrument: tokenBy, servingQuotes: new Map(), asOf: "2026-10-28", now: new Date("2026-10-28T12:00:00Z"),
    freshness: { observedAt: seed.observedAt, band: "LIVE" as const } };
  const v = composeWalletValue({ ...args, components: [comp("inst_sol", 2, 300, "2026-10-27"), comp("inst_usdc", 10, 10, "2026-10-28"), comp("inst_spam", 1e6, null, null)] });
  check("a priced token is ADDED to the wallet total", v.value === 310, String(v.value));
  const spam = v.tokens.find((t) => t.label.startsWith("Spam"));
  check("an unpriced token is EXCLUDED from the total and carried as UNPRICED with value null (never 0)",
    spam?.state === "UNPRICED" && spam.value === null && spam.quantity === 1e6);
  check("the wallet stays VALUED — an unlisted airdrop does not black out a priced native balance", v.state === "VALUED");
  check("the native quantity and price date are the NATIVE asset's, untouched by tokens", v.quantity === 2 && v.priceDate === "2026-10-27");
  const nativeOnly = composeWalletValue({ ...args, components: [comp("inst_sol", 2, 300, "2026-10-27")] });
  check("no tokens ⇒ byte-identical single-asset result", nativeOnly.value === 300 && nativeOnly.quantity === 2 && nativeOnly.tokens.length === 0);
  const nativeUnpriced = composeWalletValue({ ...args, components: [comp("inst_sol", 2, null, null), comp("inst_usdc", 10, 10, "2026-10-28")] });
  check("an unpriced NATIVE asset still makes the wallet NO_PRICE (unchanged rule) — tokens cannot paper over it",
    nativeUnpriced.state === "NO_PRICE" && nativeUnpriced.value === null);
  const tokensOnly = composeWalletValue({ ...args, components: [comp("inst_usdc", 10, 10, "2026-10-28")] });
  check("tokens without a native observation do not become the wallet's value", tokensOnly.value === null && tokensOnly.state === "NO_OBSERVATION" && tokensOnly.tokens.length === 1);

  const closed = composeWalletValue({ ...args, components: [comp("inst_sol", 2, 300, "2026-10-27"), comp("inst_usdc", 0, 0, "2026-10-28")] });
  check("a CLOSED token (latest observation 0) is not listed as a holding", closed.tokens.length === 0 && closed.value === 300);

  // refreshCurrentTokenQuotes: only listed contracts are written; nothing is written for an unlisted one.
  {
    const { refreshCurrentTokenQuotes } = await import("@/lib/prices/current-quotes");
    const f = fakeClient();
    const qNow = new Date("2026-10-28T12:00:00Z");
    const out = await refreshCurrentTokenQuotes([
      { instrumentId: "inst_usdc", assetKey: splTokenAssetKey(USDC), platform: "solana", contract: USDC },
      { instrumentId: "inst_spam", assetKey: splTokenAssetKey(SPAM), platform: "solana", contract: SPAM },
    ], { client: f.client as never, now: qNow, fetchTokenQuotes: async (_p, toks) => ({ configured: true,
      quotes: [{ symbol: toks[0].key, priceUsd: 1, quotedAt: new Date(qNow.getTime() - 60_000) }],
      rejected: [{ symbol: toks[1].key, reason: "absent from response" }] }) });
    check("only the listed token gets an INTRADAY quote row", f.prices.length === 1 && f.prices[0].instrumentId === "inst_usdc" && f.prices[0].basis === "INTRADAY");
    check("the unlisted token is reported UNPRICED, with no price row (never 0)",
      out.status === "REFRESHED" && (out.unpricedAssetKeys ?? []).includes(splTokenAssetKey(SPAM)) && !f.prices.some((p) => p.instrumentId === "inst_spam"));
  }

  // CoinGecko contract quotes: an unlisted contract is REJECTED, a zero price is REJECTED.
  const now = new Date("2026-10-28T12:00:00Z");
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({
    [USDC]: { usd: 0.9998, last_updated_at: Math.floor(now.getTime() / 1000) - 60 },
    [PYUSD]: { usd: 0, last_updated_at: Math.floor(now.getTime() / 1000) - 60 },
  }) });
  const meter: Record<string, number> = {};
  const q = await fetchCoinGeckoTokenQuotes("solana", [
    { key: splTokenAssetKey(USDC), contract: USDC }, { key: splTokenAssetKey(PYUSD), contract: PYUSD }, { key: splTokenAssetKey(SPAM), contract: SPAM },
  ], { apiKey: "fixture", fetchImpl, now, batchSize: 3, meter });
  check("a listed contract is quoted, keyed by assetKey", q.quotes.length === 1 && q.quotes[0].symbol === splTokenAssetKey(USDC));
  check("an unlisted contract (spam) is rejected — UNPRICED, never 0", q.rejected.some((r) => r.symbol === splTokenAssetKey(SPAM)));
  check("a zero price is rejected, not stored", q.rejected.some((r) => r.symbol === splTokenAssetKey(PYUSD)));
  check("contract quote requests are metered", meter["simple/token_price:solana"] === 1);
}

// ══ WALLET HISTORY COMPLETENESS IS PER INSTRUMENT ═════════════════════════════
{
  const complete = { kind: "COMPLETE" as const, fromISO: "2022-01-01", toISO: "2026-10-28", source: "fixture" };
  const nativeDone = { instrumentId: "inst_sol", assetKey: null, label: "SOL", ...facetFromCoverage(complete) };
  check("no coverage record ⇒ NOT_RECONSTRUCTED (never complete)", facetFromCoverage(null).state === "NOT_RECONSTRUCTED");
  check("a COMPLETE coverage ⇒ RECONSTRUCTED with its interval", nativeDone.state === "RECONSTRUCTED" && nativeDone.licensedFromISO === "2022-01-01");
  check("a blocking caveat ⇒ UNLICENSED",
    facetFromCoverage({ kind: "PARTIAL", coveredFromISO: "2022-01-01", coveredToISO: "2026-01-01", caveats: ["PAGE_BUDGET_EXHAUSTED"], source: "x" }).state === "UNLICENSED");
  const token = { instrumentId: "inst_usdc", assetKey: splTokenAssetKey(USDC), label: "USDC", standard: "SPL" as const, contract: USDC,
    quantity: 4, held: true, firstObservedISO: "2026-10-28", lastObservedISO: "2026-10-28", priceStatus: "MARKET_PRICE" as const, ...facetFromCoverage(null) };
  check("native complete + a token NOT reconstructed ⇒ the WALLET is NOT complete",
    walletHistoryComplete({ chain: "SOL", native: nativeDone, tokens: [token] }) === false);
  check("native complete + no tokens recorded on a token-bearing chain ⇒ still NOT complete (pre-capture tokens are unknown)",
    walletHistoryComplete({ chain: "SOL", native: nativeDone, tokens: [] }) === false);
  check("Bitcoin (no tokens here): native complete ⇒ wallet complete", walletHistoryComplete({ chain: "BTC", native: nativeDone, tokens: [] }) === true);
}

// ══ CONNECTIONS DRAWER: DATA-DRIVEN TOKEN FACETS ══════════════════════════════
{
  const conn = { id: "c", provider: "WALLET", state: "active" } as never;
  const tokens = [{ label: "USDC", standard: "SPL" as const, quantity: 4.000001, priceStatus: "MARKET_PRICE" as const,
    historyState: "NOT_RECONSTRUCTED" as const, firstObservedISO: "2026-10-28", lastObservedISO: "2026-10-28" },
  { label: "Spam…1111", standard: "SPL" as const, quantity: 1e6, priceStatus: "NO_MARKET_PRICE" as const,
    historyState: "NOT_RECONSTRUCTED" as const, firstObservedISO: "2026-10-28", lastObservedISO: "2026-10-28" }];
  const intel = { positionObservedAt: "2026-10-28T10:00:00Z", valuationIsReadTime: true,
    walletHistory: { supported: true, licensed: true, licensedFromISO: "2022-01-01", licensedToISO: "2026-10-28", activityFromISO: "2022-01-01",
      priceFromISO: "2025-10-28", chart: { fromISO: "2025-10-28", toISO: "2026-10-28", days: 366, continuous: true }, chain: "SOL", tokens, walletComplete: false } } as never;
  const health = connectionHealth(conn, intel, new Date("2026-10-28T12:00:00Z"));
  const line = health.lines.find((l) => l.key === "tokens");
  check("the token health line is data-driven (count + honest scope)", line?.text === "2 SPL tokens · current balance only, history not reconstructed yet", line?.text);
  check("native verified + tokens not reconstructed ⇒ the headline is LIMITED, never plain ready",
    health.headline === "Current holdings ready; some history is limited" && health.tone === "neutral", health.headline);
  const hist = connectionHistory(conn, intel, [{ id: "a", name: "w", type: "crypto", chain: "SOL" } as never]);
  check("History keeps native and token facets SEPARATE", hist.blockchain?.label === "Native SOL" && hist.tokenFacets?.length === 2);
  check("each token facet is honest, absolute-dated copy",
    hist.tokenFacets?.[0].text === "History not reconstructed yet — current balance only, recorded since Oct 28, 2026", hist.tokenFacets?.[0].text);
  check("the old hardcoded per-chain token limitation is gone", !/SPL token balances are not reconstructed yet/.test(read("lib", "connections", "connection-detail.core.ts")));
  check("no tokens recorded ⇒ said as such, not 'not reconstructed'", tokenHistoryLabel("SOL", []) === "No SPL token balances recorded");
  check("a network without token capture says so", tokenHistoryLabel("AVAX", undefined) === "Tokens aren’t tracked on this network yet");
  check("a dust quantity is never rendered as a false zero", formatTokenQuantity(1e-9) === "< 0.000001");
}

// ══ NATIVE-ONLY READERS EXCLUDE TOKENS (a USDC row is never read as SOL) ══════
{
  check("the exclusion is a NOT EXISTS over the token alias (keeps every non-token row)",
    JSON.stringify(NOT_TOKEN_INSTRUMENT).includes('"NOT":{"aliases":{"some"'));
  const regen = code(read("lib", "snapshots", "regenerate-history.ts"));
  check("historical wealth composition excludes token rows", /date: \{ lte: fromISO\(toDate\) \},\s*instrument: NOT_TOKEN_INSTRUMENT,/.test(regen));
  check("the native coverage licence excludes token coverage", /instrument: NOT_TOKEN_INSTRUMENT \}/.test(code(read("lib", "crypto", "position-coverage.ts"))));
  check("a token never blocks the history planner's price floor", /NOT_TOKEN_INSTRUMENT/.test(code(read("lib", "snapshots", "historical-work-window.ts"))));
  check("the chart-ready native instrument excludes token coverage", /instrument: NOT_TOKEN_INSTRUMENT/.test(code(read("lib", "connections", "space-data.ts"))));
}

}

main().then(() => {
  console.log(`\ntoken-holdings: ${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}).catch((e) => { console.error(e); process.exit(1); });
