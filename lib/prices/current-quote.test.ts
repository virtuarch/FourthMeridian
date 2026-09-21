/**
 * lib/prices/current-quote.test.ts — CURRENT crypto valuation authority.
 *
 * 2026-09-21: every wallet's "current" value was quantity × YESTERDAY's close,
 * labelled LIVE by the quantity's clock — measured $927.43 low on 0.24060252 BTC.
 * This file pins the contract that replaced it (lib/prices/current-quote.core.ts):
 * current value = quantity × today's quote, with TWO clocks; the last close is a
 * named fallback, never current; quotes never reach dated history.
 *
 * Executable: the real `loadWalletCurrentValues` runs over in-memory Prisma
 * delegates (the DB URL is pointed at an unreachable clone-named address before
 * @/lib/db loads, so a missed stub fails fast and never reaches a database).
 * Runs under scripts/run-tests.ts. No network, no DB.
 */

process.env.DATABASE_URL = "postgresql://stub@127.0.0.1:1/fintracker_unit_stub";
process.env.INVESTMENT_OBSERVATIONS_ENABLED = "true";

process.on("unhandledRejection", (err) => {
  if ((err as { constructor?: { name?: string } })?.constructor?.name === "PrismaClientInitializationError") return;
  console.error("unexpected unhandled rejection:", err);
  process.exit(1);
});

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passes++;
  else { failures++; console.log(`[FAIL] ${name}`); if (detail) console.log(`        ${detail}`); }
}

const CHAINS = ["BTC", "ETH", "SOL", "BNB", "AVAX"] as const;
const COIN = { BTC: "bitcoin", ETH: "ethereum", SOL: "solana", BNB: "binancecoin", AVAX: "avalanche-2" } as const;
const QTY  = { BTC: 0.24060252, ETH: 0.000831130959461847, SOL: 0.751600602, BNB: 1.5, AVAX: 12.25 } as const;
const CLOSE = { BTC: 81_197.32632288539, ETH: 2_638.7, SOL: 110.96, BNB: 580.1, AVAX: 24.5 } as const;
const SPOT  = { BTC: 85_052, ETH: 2_730.59, SOL: 117.56, BNB: 601.2, AVAX: 25.9 } as const;

async function main() {
  const core = await import("./current-quote.core");
  const { fetchCoinGeckoCurrentQuotes } = await import("./providers/coingecko");
  const { db } = await import("@/lib/db");
  const { refreshCurrentQuotesForChains, writeCurrentQuotes } = await import("./current-quotes");
  const { loadWalletCurrentValues } = await import("@/lib/crypto/wallet-current-value");
  const { valuePositionRowsOverDates } = await import("@/lib/investments/valuation");

  const NOW = new Date("2026-09-21T13:40:00Z");
  const TODAY = "2026-09-21";

  // ── 1. Parsing: every chain, and every way a quote can be malformed ────────
  {
    const body: Record<string, unknown> = {};
    for (const c of CHAINS) body[COIN[c]] = { usd: SPOT[c], last_updated_at: Math.floor(NOW.getTime() / 1000) - 30 };
    const { quotes, rejected } = core.parseSimplePriceQuotes(body, COIN, NOW);
    for (const c of CHAINS) {
      const q = quotes.find((x) => x.symbol === c);
      check(`parse ${c}: price and provider instant kept exactly`, !!q && q.priceUsd === SPOT[c] && q.quotedAt.getTime() === NOW.getTime() - 30_000);
    }
    check("parse: nothing rejected on a clean body", rejected.length === 0);

    const bad = core.parseSimplePriceQuotes({
      bitcoin:  { usd: 85_000 },                                   // no timestamp
      ethereum: { usd: 2_700, last_updated_at: "yesterday" },      // malformed timestamp
      solana:   { usd: -1, last_updated_at: 1_789_997_000 },       // invalid price
      binancecoin: { usd: 600, last_updated_at: Math.floor(NOW.getTime() / 1000) + 3600 }, // future
    }, COIN, NOW);
    const why = (s: string) => bad.rejected.find((r) => r.symbol === s)?.reason ?? "";
    check("reject: missing last_updated_at", /missing or malformed/.test(why("BTC")));
    check("reject: malformed last_updated_at", /missing or malformed/.test(why("ETH")));
    check("reject: non-positive price (provider convention: positive-finite or refused)", /invalid price/.test(why("SOL")));
    check("reject: a quote from the future", /future/.test(why("BNB")));
    check("reject: absent coin is named, not guessed", /absent/.test(why("AVAX")));
    check("reject: no quote survives from a bad body", bad.quotes.length === 0);
  }

  // ── 2. Freshness: derived band, two clocks, day grain ─────────────────────
  {
    check("CURRENT band = one WALLET refresh period (6 h from the policy default)", core.CURRENT_QUOTE_MAX_AGE_MS === 6 * 3_600_000);
    const fresh = core.quoteProvenance(new Date(NOW.getTime() - 60_000), NOW);
    const edge  = core.quoteProvenance(new Date(NOW.getTime() - core.CURRENT_QUOTE_MAX_AGE_MS), NOW);
    const old   = core.quoteProvenance(new Date(NOW.getTime() - core.CURRENT_QUOTE_MAX_AGE_MS - 1), NOW);
    check("a minute-old quote is CURRENT", fresh.freshness === "CURRENT" && fresh.basis === "CURRENT_QUOTE");
    check("exactly one period old is still CURRENT", edge.freshness === "CURRENT");
    check("one ms past the period is DELAYED — never presented as current", old.freshness === "DELAYED");
    check("the last close is its own basis and never current",
      core.closeProvenance("2026-09-20").freshness === "LAST_CLOSE" && core.closeProvenance("2026-09-20").basis === "LAST_CLOSE");
    check("a quote serves TODAY only", core.quoteServesAsOf(new Date("2026-09-21T00:05:00Z"), TODAY, NOW));
    check("…not a past date, even if the quote is from that day", !core.quoteServesAsOf(new Date("2026-09-20T23:59:00Z"), "2026-09-20", NOW));
    check("…and yesterday's quote does not serve today", !core.quoteServesAsOf(new Date("2026-09-20T23:59:00Z"), TODAY, NOW));
    check("describe CURRENT", core.describePriceProvenance(fresh) === "Price as of 13:39 UTC", core.describePriceProvenance(fresh));
    check("describe DELAYED", /^Price delayed · as of /.test(core.describePriceProvenance(old)));
    check("describe LAST_CLOSE", core.describePriceProvenance(core.closeProvenance("2026-09-20")) === "At Sep 20 close");
    check("headline: all current ⇒ oldest instant", core.summarizeCryptoPricing([fresh, core.quoteProvenance(new Date("2026-09-21T13:30:00Z"), NOW)]) === "Crypto at 13:30 UTC prices");
    check("headline: ANY close ⇒ the total is not current (weakest basis wins)",
      core.summarizeCryptoPricing([fresh, core.closeProvenance("2026-09-20")]) === "Crypto at Sep 20 close");
    check("headline: a delayed quote is disclosed", /^Crypto prices delayed/.test(core.summarizeCryptoPricing([fresh, old]) ?? ""));
    check("headline: nothing priced ⇒ no claim", core.summarizeCryptoPricing([null, undefined]) === null);
  }

  // ── 3. CoinGecko transport: same key, same ids, typed failures ────────────
  {
    let seenUrl = ""; let seenKey = "";
    const ok = async (url: string, init: { headers: Record<string, string> }) => {
      seenUrl = url; seenKey = init.headers["x-cg-demo-api-key"];
      return { ok: true, status: 200, json: async () => ({ bitcoin: { usd: SPOT.BTC, last_updated_at: 1_789_997_190 } }) };
    };
    const r = await fetchCoinGeckoCurrentQuotes(["BTC", "MATIC"], { apiKey: "k", fetchImpl: ok, now: NOW });
    check("transport: /simple/price with the vendor instant requested",
      /\/simple\/price\?ids=bitcoin&vs_currencies=usd&include_last_updated_at=true$/.test(seenUrl) && seenKey === "k", seenUrl);
    check("transport: an asset with no coin id (MATIC) is refused by name", r.rejected.some((x) => x.symbol === "MATIC"));
    check("transport: BTC quote returned", r.quotes[0]?.priceUsd === SPOT.BTC);
    const nokey = await fetchCoinGeckoCurrentQuotes(["BTC"], { apiKey: "", fetchImpl: ok });
    check("transport: no key ⇒ NOT configured (dark no-op), not an error", nokey.configured === false);
    let e429: unknown;
    try { await fetchCoinGeckoCurrentQuotes(["BTC"], { apiKey: "k", fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) }) }); } catch (e) { e429 = e; }
    check("transport: 429 ⇒ THROTTLED (existing classification)", (e429 as { code?: string })?.code === "THROTTLED");
  }

  // ── In-memory store for the DB-touching halves ────────────────────────────
  type PriceRow = { instrumentId: string; date: Date; basis: string; price: number; currency: string; fetchedAt: Date; source: string };
  const prices: PriceRow[] = [];
  const inst = (c: string) => `inst-${c}`;
  const accounts = CHAINS.map((c) => ({ id: `acc-${c}`, walletChain: c, lastUpdated: new Date("2026-09-21T13:16:00Z") }));
  const d = db as unknown as Record<string, unknown>;
  const { nativeAssetForChain } = await import("@/lib/crypto/native-asset");
  const chainByAssetKey = new Map(CHAINS.map((c) => [nativeAssetForChain(c)!.assetKey, c]));
  d.instrumentAlias = { findUnique: async (a: { where: { provider_externalId: { externalId: string } } }) => {
    const c = chainByAssetKey.get(a.where.provider_externalId.externalId);
    return c ? { instrumentId: inst(c) } : null; } };
  d.instrument = {
    findFirst: async (a: { where: { tickerSymbol: string } }) => ({ id: inst(a.where.tickerSymbol) }),
    findMany:  async (a: { where: { id: { in: string[] } } }) => a.where.id.in.map((id) => ({ id, currency: "USD", isCashEquivalent: false })),
  };
  d.positionObservation = {
    groupBy:  async () => CHAINS.map((c) => ({ financialAccountId: `acc-${c}`, instrumentId: inst(c), _max: { date: new Date("2026-09-19T00:00:00Z") } })),
    findMany: async () => CHAINS.map((c) => ({
      financialAccountId: `acc-${c}`, instrumentId: inst(c), date: new Date("2026-09-19T00:00:00Z"), quantity: QTY[c],
      origin: "OBSERVED", completeness: null, isCash: false, currency: "USD", institutionValue: null, institutionPrice: null, institutionPriceAsOf: null,
    })),
  };
  d.positionReconstruction = { findMany: async () => [] };
  d.priceObservation = {
    findMany: async (a: { where: { instrumentId: { in: string[] }; basis: string; date: Date | { gte: Date; lte: Date } } }) => {
      const w = a.where;
      return prices.filter((p) => w.instrumentId.in.includes(p.instrumentId) && p.basis === w.basis && (
        w.date instanceof Date ? p.date.getTime() === w.date.getTime() : p.date >= w.date.gte && p.date <= w.date.lte));
    },
    findUnique: async (a: { where: { instrumentId_date_basis: { instrumentId: string; date: Date; basis: string } } }) => {
      const k = a.where.instrumentId_date_basis;
      return prices.find((p) => p.instrumentId === k.instrumentId && p.basis === k.basis && p.date.getTime() === k.date.getTime()) ?? null;
    },
    upsert: async (a: { where: { instrumentId_date_basis: { instrumentId: string; date: Date; basis: string } }; create: PriceRow; update: Partial<PriceRow> }) => {
      const k = a.where.instrumentId_date_basis;
      const row = prices.find((p) => p.instrumentId === k.instrumentId && p.basis === k.basis && p.date.getTime() === k.date.getTime());
      if (row) Object.assign(row, a.update); else prices.push({ ...a.create });
      return {};
    },
  };
  for (const c of CHAINS) prices.push({ instrumentId: inst(c), date: new Date("2026-09-20T00:00:00Z"), basis: "RAW_CLOSE", price: CLOSE[c], currency: "USD", fetchedAt: new Date("2026-09-21T06:30:00Z"), source: "coingecko" });

  // ── 4. No quote yet ⇒ LAST_CLOSE, named, never current ─────────────────────
  {
    const m = await loadWalletCurrentValues(accounts, { now: NOW, asOf: TODAY });
    for (const c of CHAINS) {
      const v = m.get(`acc-${c}`)!;
      check(`${c} with no quote: valued at the 09-20 close, basis LAST_CLOSE`,
        v.price?.basis === "LAST_CLOSE" && v.price.asOf === "2026-09-20" && v.price.freshness === "LAST_CLOSE"
          && Math.abs((v.value ?? 0) - QTY[c] * CLOSE[c]) < 1e-9, JSON.stringify(v.price));
      check(`${c} with no quote: the QUANTITY clock is unchanged and independent (LIVE)`, v.freshness === "LIVE");
    }
  }

  // ── 5. Refresh writes INTRADAY quotes; values move to the quote ───────────
  const fakeFetch: typeof fetchCoinGeckoCurrentQuotes = async (symbols) => ({
    configured: true, rejected: [],
    quotes: symbols.map((s) => ({ symbol: s, priceUsd: SPOT[s as keyof typeof SPOT], quotedAt: new Date("2026-09-21T13:38:30Z") })),
  });
  {
    const out = await refreshCurrentQuotesForChains([...CHAINS], { client: db, fetchQuotes: fakeFetch, now: NOW });
    check("refresh: REFRESHED for all five native assets, all changed",
      out.status === "REFRESHED" && out.instrumentIds.length === 5 && out.changedInstrumentIds.length === 5, JSON.stringify(out));
    const intraday = prices.filter((p) => p.basis === "INTRADAY");
    check("refresh: stored under INTRADAY, dated the quote's UTC day, fetchedAt = provider instant",
      intraday.length === 5 && intraday.every((p) => p.date.toISOString().startsWith(TODAY) && p.fetchedAt.toISOString() === "2026-09-21T13:38:30.000Z"));
    check("refresh: NO RAW_CLOSE row touched or added", prices.filter((p) => p.basis === "RAW_CLOSE").length === 5
      && prices.filter((p) => p.basis === "RAW_CLOSE").every((p) => p.date.toISOString().startsWith("2026-09-20")));

    const m = await loadWalletCurrentValues(accounts, { now: NOW, asOf: TODAY });
    for (const c of CHAINS) {
      const v = m.get(`acc-${c}`)!;
      check(`${c}: CURRENT value = quantity × today's quote, provenance CURRENT_QUOTE @ provider instant`,
        v.price?.basis === "CURRENT_QUOTE" && v.price.freshness === "CURRENT" && v.price.asOf === "2026-09-21T13:38:30.000Z"
          && Math.abs((v.value ?? 0) - QTY[c] * SPOT[c]) < 1e-9, `${v.value} vs ${QTY[c] * SPOT[c]} ${JSON.stringify(v.price)}`);
    }
    const btc = m.get("acc-BTC")!;
    check("BTC: the spot is materially different from the close and the value moved by exactly qty × Δ",
      Math.abs((btc.value! - QTY.BTC * CLOSE.BTC) - QTY.BTC * (SPOT.BTC - CLOSE.BTC)) < 1e-9 && btc.value! - QTY.BTC * CLOSE.BTC > 900);
    check("BTC: quantity clock (13:16) and price clock (13:38:30) are separate facts",
      btc.observedAt?.toISOString() === "2026-09-21T13:16:00.000Z" && btc.price?.asOf === "2026-09-21T13:38:30.000Z");
    check("precision: value is unrounded quantity × price (no money rounding inside the read model)",
      btc.value === QTY.BTC * SPOT.BTC, String(btc.value));
  }

  // ── 6. Stale quote ⇒ DELAYED, still today's quote, never CURRENT ──────────
  {
    const later = new Date("2026-09-21T20:00:00Z"); // 6h21m after the quote
    const m = await loadWalletCurrentValues(accounts, { now: later, asOf: TODAY });
    const v = m.get("acc-ETH")!;
    check("stale quote: DELAYED, value still from today's quote (not silently yesterday's close)",
      v.price?.freshness === "DELAYED" && v.price.basis === "CURRENT_QUOTE" && Math.abs(v.value! - QTY.ETH * SPOT.ETH) < 1e-12);
  }

  // ── 7. Monotonic: an older quote never overwrites a newer one ─────────────
  {
    const changed = await writeCurrentQuotes([{ symbol: "BTC", priceUsd: 70_000, quotedAt: new Date("2026-09-21T09:00:00Z"), instrumentId: inst("BTC") }], db);
    const row = prices.find((p) => p.basis === "INTRADAY" && p.instrumentId === inst("BTC"))!;
    check("monotonic: an older quote is ignored", changed.length === 0 && row.price === SPOT.BTC);
    const same = await writeCurrentQuotes([{ symbol: "BTC", priceUsd: SPOT.BTC, quotedAt: new Date("2026-09-21T13:45:00Z"), instrumentId: inst("BTC") }], db);
    check("monotonic: a newer quote at the same price advances the instant but is not a 'change'", same.length === 0 && row.fetchedAt.toISOString() === "2026-09-21T13:45:00.000Z");
  }

  // ── 8. Past dates: quotes are invisible; dated history is RAW_CLOSE only ──
  {
    const m = await loadWalletCurrentValues(accounts, { now: NOW, asOf: "2026-09-20" });
    const v = m.get("acc-BTC")!;
    check("past asOf: never priced from a quote (RAW_CLOSE of that day)",
      v.price?.basis === "LAST_CLOSE" && v.price.asOf === "2026-09-20" && Math.abs(v.value! - QTY.BTC * CLOSE.BTC) < 1e-9);
    const q = { dateISO: TODAY, byInstrument: new Map([[inst("BTC"), { price: SPOT.BTC, currency: "USD" }]]) };
    const base = { client: db, contextSpaceId: null, reportingCurrency: "USD", holdConstant: false, posRows: [], reconRows: [] } as const;
    let multi: unknown; let past: unknown;
    try { await valuePositionRowsOverDates({ ...base, dates: ["2026-09-20", TODAY], currentQuotes: q }); } catch (e) { multi = e; }
    try { await valuePositionRowsOverDates({ ...base, dates: ["2026-09-20"], currentQuotes: q }); } catch (e) { past = e; }
    check("guard: quotes handed to a MULTI-date valuation (every reconstruction) throw", multi instanceof Error && /refused/.test(multi.message));
    check("guard: quotes handed to a different date throw", past instanceof Error && /refused/.test(past.message));
  }

  // ── 9. Provider failure / not configured are outcomes, not throws ─────────
  {
    const down = await refreshCurrentQuotesForChains(["BTC"], { client: db, fetchQuotes: async () => { throw new Error("coingecko: HTTP 503 for current quotes"); } });
    check("provider down ⇒ UNAVAILABLE with the reason (the value then falls back, labelled)", down.status === "UNAVAILABLE" && /503/.test(down.reason));
    const dark = await refreshCurrentQuotesForChains(["BTC"], { client: db, fetchQuotes: async () => ({ configured: false, quotes: [], rejected: [] }) });
    check("no key ⇒ NOT_CONFIGURED (a SKIPPED stage, not a failure)", dark.status === "NOT_CONFIGURED");
  }

  console.log(`\ncurrent-quote: ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error("current-quote test crashed:", e); process.exit(1); });
