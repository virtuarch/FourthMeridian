/**
 * lib/prices/current-quotes.ts — the CURRENT crypto quote store (server).
 *
 * The pure contract is lib/prices/current-quote.core.ts; read it first.
 *
 * ── Representation ───────────────────────────────────────────────────────────
 * A quote is a `PriceObservation` row with `basis: INTRADAY` — the basis the
 * schema already reserved "within-session price" for. It lives in the same
 * table as the closes but on a basis NO historical reader requests: every dated
 * valuation reads RAW_CLOSE (valuation.ts, crypto-price-window.ts,
 * regenerate-history), so a quote cannot leak into reconstruction.
 *
 * One row per (instrument, UTC market date, INTRADAY) — the table's existing
 * uniqueness — holding the LATEST quote of that day. Writes are MONOTONIC: an
 * older quote never overwrites a newer one, whichever sync lands last.
 *
 * ⚠️ For INTRADAY rows `fetchedAt` records the PROVIDER's attested instant
 * (CoinGecko `last_updated_at`), not our fetch time. A quote without its instant
 * is not a price, the row has no other instant column, and adding one is a
 * migration of the canonical database this slice may not make. The meaning is
 * stated here, at the only writer, and on the schema field.
 *
 * This module deliberately does NOT go through `priceArchive.append`, whose
 * closed-date guard (`assertClosedDateISO`) is correct for closes and stays
 * exactly as strict: quotes get their own narrow writer, not a weakened guard.
 */

import "server-only";
import { PriceBasis, type Prisma, type PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { lookupCryptoInstrumentId } from "@/lib/crypto/crypto-price-window";
import { nativeAssetForChain } from "@/lib/crypto/native-asset";
import { fetchCoinGeckoCurrentQuotes, fetchCoinGeckoTokenQuotes } from "@/lib/prices/providers/coingecko";
import { quoteDateISO, type CurrentQuote } from "@/lib/prices/current-quote.core";
import { coinGeckoBudgetConfig, defaultCoinGeckoBudget, type CoinGeckoBudget } from "@/lib/prices/coingecko-budget";

type Client = PrismaClient | Prisma.TransactionClient;

export const CURRENT_QUOTE_SOURCE = "coingecko:simple_price";

/** A stored quote, bound to its instrument. */
export interface StoredQuote {
  instrumentId: string;
  priceUsd:     number;
  quotedAt:     Date;
}

/**
 * Persist validated quotes as INTRADAY rows. Returns the instruments whose
 * stored quote CHANGED (the input to snapshot regeneration: a value moved).
 */
export async function writeCurrentQuotes(
  bound: ReadonlyArray<CurrentQuote & { instrumentId: string }>,
  client: Client = db,
  source: string = CURRENT_QUOTE_SOURCE,
): Promise<string[]> {
  const changed: string[] = [];
  for (const q of bound) {
    const date = new Date(`${quoteDateISO(q.quotedAt)}T00:00:00.000Z`);
    const key = { instrumentId_date_basis: { instrumentId: q.instrumentId, date, basis: PriceBasis.INTRADAY } };
    const existing = await client.priceObservation.findUnique({ where: key, select: { fetchedAt: true, price: true } });
    // MONOTONIC: never replace a newer quote with an older one.
    if (existing && existing.fetchedAt.getTime() >= q.quotedAt.getTime()) continue;
    await client.priceObservation.upsert({
      where:  key,
      create: { instrumentId: q.instrumentId, date, basis: PriceBasis.INTRADAY, price: q.priceUsd, currency: "USD", source, fetchedAt: q.quotedAt },
      update: { price: q.priceUsd, source, fetchedAt: q.quotedAt },
    });
    if (!existing || existing.price !== q.priceUsd) changed.push(q.instrumentId);
  }
  return changed;
}

/**
 * Today's stored quote per instrument (UTC market date = `todayISO`). An
 * instrument with no quote for today is ABSENT — the caller values it at the
 * last close and says so; nothing here substitutes.
 */
export async function readQuotesForDate(
  instrumentIds: readonly string[],
  todayISO: string,
  client: Client = db,
): Promise<Map<string, StoredQuote>> {
  const out = new Map<string, StoredQuote>();
  if (instrumentIds.length === 0) return out;
  const rows = await client.priceObservation.findMany({
    where:  { instrumentId: { in: [...instrumentIds] }, basis: PriceBasis.INTRADAY, date: new Date(`${todayISO}T00:00:00.000Z`), currency: "USD" },
    select: { instrumentId: true, price: true, fetchedAt: true },
  });
  for (const r of rows) out.set(r.instrumentId, { instrumentId: r.instrumentId, priceUsd: r.price, quotedAt: r.fetchedAt });
  return out;
}

export type QuoteRefreshOutcome =
  | { status: "REFRESHED"; instrumentIds: string[]; changedInstrumentIds: string[]; quotedAt: Date; startedAt: Date; durationMs: number }
  | { status: "UNAVAILABLE"; reason: string; startedAt: Date; durationMs: number }
  | { status: "NOT_CONFIGURED"; startedAt: Date; durationMs: number };

/**
 * Fetch and persist the current quote for each chain's NATIVE asset. Never
 * throws: a provider failure is an outcome (the value then falls back to the
 * last close, labelled), recorded by the caller as a stage.
 */
export async function refreshCurrentQuotesForChains(
  chains: readonly string[],
  opts: { client?: Client; fetchQuotes?: typeof fetchCoinGeckoCurrentQuotes; now?: Date; budget?: CoinGeckoBudget } = {},
): Promise<QuoteRefreshOutcome> {
  const startedAt = new Date();
  const t0 = Date.now();
  const client = opts.client ?? db;
  const done = <T extends object>(o: T) => ({ ...o, startedAt, durationMs: Date.now() - t0 });
  try {
    const assets = [...new Map(chains.map((c) => nativeAssetForChain(c)).filter((a): a is NonNullable<typeof a> => a !== null).map((a) => [a.assetKey, a])).values()];
    if (assets.length === 0) return done({ status: "UNAVAILABLE" as const, reason: "no native asset for these chains" });

    // Review fix 1 — the native quote spends the SAME shared CoinGecko budget:
    // read before spend (unreadable ⇒ nothing spent), paced, metered.
    if (!opts.fetchQuotes && !process.env.COINGECKO_API_KEY?.trim()) return done({ status: "NOT_CONFIGURED" as const });
    // Re-review fix 1 — DEDUPE: when every one of these assets already has an
    // INTRADAY quote younger than COINGECKO_NATIVE_QUOTE_FRESH_MINUTES (another
    // wallet's sync just paid for it), nothing is fetched. The stored quote is
    // the current one; reported as REFRESHED with nothing changed.
    const now = opts.now ?? new Date();
    const freshMs = coinGeckoBudgetConfig().nativeQuoteFreshMinutes * 60_000;
    if (freshMs > 0) {
      const ids = (await Promise.all(assets.map((a) => lookupCryptoInstrumentId(a, client)))).filter((x): x is string => !!x);
      if (ids.length === assets.length) {
        const today = new Date(`${quoteDateISO(now)}T00:00:00.000Z`);
        const rows = await client.priceObservation.findMany({
          where: { instrumentId: { in: ids }, basis: PriceBasis.INTRADAY, date: { gte: today, lte: today } },
          select: { instrumentId: true, fetchedAt: true },
        });
        const freshest = new Map<string, Date>();
        for (const r of rows) { const p = freshest.get(r.instrumentId); if (!p || p < r.fetchedAt) freshest.set(r.instrumentId, r.fetchedAt); }
        if (ids.every((id) => { const f = freshest.get(id); return f !== undefined && now.getTime() - f.getTime() < freshMs; })) {
          const quotedAt = new Date(Math.min(...ids.map((id) => freshest.get(id)!.getTime())));
          return done({ status: "REFRESHED" as const, instrumentIds: ids, changedInstrumentIds: [], quotedAt });
        }
      }
    }

    const budget = opts.budget ?? defaultCoinGeckoBudget(client);
    // Native may use everything left today; tokens are capped at their share,
    // so this always has headroom tokens cannot take.
    const remaining = await budget.remaining("native");
    if (remaining === null) return done({ status: "UNAVAILABLE" as const, reason: "CoinGecko budget unreadable — nothing spent" });
    if (remaining < 1) return done({ status: "UNAVAILABLE" as const, reason: "CoinGecko daily budget reached" });
    const meter: Record<string, number> = {};
    await budget.pace();
    let fetched: Awaited<ReturnType<typeof fetchCoinGeckoCurrentQuotes>>;
    try { fetched = await (opts.fetchQuotes ?? fetchCoinGeckoCurrentQuotes)(assets.map((a) => a.symbol), { now, meter }); }
    finally { await budget.record(meter); }
    if (!fetched.configured) return done({ status: "NOT_CONFIGURED" as const });

    const bound: Array<CurrentQuote & { instrumentId: string }> = [];
    const unbound: string[] = [];
    for (const q of fetched.quotes) {
      const asset = assets.find((a) => a.symbol.toUpperCase() === q.symbol.toUpperCase());
      const instrumentId = asset ? await lookupCryptoInstrumentId(asset, client) : null;
      if (instrumentId) bound.push({ ...q, instrumentId });
      else unbound.push(q.symbol);
    }
    const problems = [...fetched.rejected.map((r) => `${r.symbol}: ${r.reason}`), ...unbound.map((s) => `${s}: no canonical instrument`)];
    if (bound.length === 0) return done({ status: "UNAVAILABLE" as const, reason: problems.join("; ") || "no quote returned" });

    const changedInstrumentIds = await writeCurrentQuotes(bound, client);
    const quotedAt = new Date(Math.min(...bound.map((b) => b.quotedAt.getTime())));
    return done({ status: "REFRESHED" as const, instrumentIds: bound.map((b) => b.instrumentId), changedInstrumentIds, quotedAt });
  } catch (e) {
    return done({ status: "UNAVAILABLE" as const, reason: e instanceof Error ? e.message : String(e) });
  }
}

/** One token instrument to quote, by the contract/mint that is its identity. */
export interface TokenQuoteTarget {
  instrumentId: string;
  assetKey:     string;
  platform:     "solana" | "ethereum";
  contract:     string;
}

/** The PriceObservation.source stamped on contract-addressed token quotes. */
export const TOKEN_QUOTE_SOURCE = "coingecko:simple_token_price";

/**
 * The durable per-token quote marker, kept on the token's InstrumentAlias
 * metadata (shared across customers, no migration): when it was last asked for,
 * what the vendor said, and when it last priced. It drives the unlisted/thin
 * retry window and the least-recently-attempted rotation.
 */
export interface TokenQuoteMarker {
  attemptedAt: string;
  /** UNKNOWN = the vendor answered nothing usable (e.g. an empty `{}`): rotates, never suppresses. */
  outcome:     "PRICED" | "UNLISTED" | "THIN" | "INVALID" | "UNKNOWN";
  pricedAt?:   string;
}

export function readTokenQuoteMarker(metadata: unknown): TokenQuoteMarker | null {
  const q = (metadata as { quote?: Partial<TokenQuoteMarker> } | null)?.quote;
  if (!q || typeof q.attemptedAt !== "string" || !["PRICED", "UNLISTED", "THIN", "INVALID", "UNKNOWN"].includes(q.outcome ?? "")) return null;
  return { attemptedAt: q.attemptedAt, outcome: q.outcome as TokenQuoteMarker["outcome"], ...(typeof q.pricedAt === "string" ? { pricedAt: q.pricedAt } : {}) };
}

/**
 * PURE — which targets to ask for, in what order (review fixes 1b/1c/2):
 *   · skip a token with a stored INTRADAY quote fresher than `freshHours`
 *     (another customer's sync already paid for it);
 *   · skip a token the vendor did not list / listed thin within `retryHours`;
 *   · previously PRICED tokens first, then the rest by least-recently attempted
 *     (never attempted first), then assetKey — so a real token rotates in and is
 *     never permanently starved by a wallet full of spam.
 */
export function planTokenQuotes(
  targets: readonly TokenQuoteTarget[],
  facts: { markers: ReadonlyMap<string, TokenQuoteMarker>; freshQuoteAt: ReadonlyMap<string, Date> },
  now: Date,
  cfg: { freshHours: number; retryHours: number; maxTokens: number },
): { ask: TokenQuoteTarget[]; skippedFresh: string[]; skippedUnlisted: string[] } {
  const skippedFresh: string[] = [];
  const skippedUnlisted: string[] = [];
  const candidates: TokenQuoteTarget[] = [];
  for (const t of targets) {
    const q = facts.freshQuoteAt.get(t.instrumentId);
    if (q && now.getTime() - q.getTime() < cfg.freshHours * 3_600_000) { skippedFresh.push(t.assetKey); continue; }
    const m = facts.markers.get(t.assetKey);
    if (m && (m.outcome === "UNLISTED" || m.outcome === "THIN" || m.outcome === "INVALID")
        && now.getTime() - Date.parse(m.attemptedAt) < cfg.retryHours * 3_600_000) { skippedUnlisted.push(t.assetKey); continue; }
    candidates.push(t);
  }
  const priced = (t: TokenQuoteTarget) => (facts.markers.get(t.assetKey)?.pricedAt ? 0 : 1);
  const attempted = (t: TokenQuoteTarget) => facts.markers.get(t.assetKey)?.attemptedAt ?? "";
  candidates.sort((a, b) => priced(a) - priced(b) || attempted(a).localeCompare(attempted(b)) || a.assetKey.localeCompare(b.assetKey));
  return { ask: candidates.slice(0, Math.max(0, cfg.maxTokens)), skippedFresh, skippedUnlisted };
}

export type TokenQuoteOutcome = QuoteRefreshOutcome & {
  unpricedAssetKeys?: string[];
  thinAssetKeys?: string[];
  skippedFresh?: number;
  skippedUnlisted?: number;
  calls?: number;
  stopped?: string;
};

/**
 * TOKEN HOLDINGS FOUNDATION (PR-A) — fetch and persist CURRENT quotes for token
 * instruments, by contract, through the same INTRADAY writer the native quotes
 * use. Guarded by the shared COINGECKO budget (read before spend; unreadable ⇒
 * nothing spent), deduped across customers, unlisted contracts remembered,
 * rotated fairly, paced, partial on failure, and price-sanity floored.
 *
 * Never throws. A token the vendor does not list, or lists thin, is simply not
 * quoted — it stays UNPRICED, excluded from wallet totals, never valued at zero.
 * `client` is REQUIRED.
 */
export async function refreshCurrentTokenQuotes(
  targets: readonly TokenQuoteTarget[],
  opts: {
    client: Client;
    budget?: CoinGeckoBudget;
    fetchTokenQuotes?: typeof fetchCoinGeckoTokenQuotes;
    now?: Date;
    maxTokens?: number;
    deadlineMs?: number;
    env?: Record<string, string | undefined>;
  },
): Promise<TokenQuoteOutcome> {
  const startedAt = new Date();
  const t0 = Date.now();
  const done = <T extends object>(o: T) => ({ ...o, startedAt, durationMs: Date.now() - t0 });
  const now = opts.now ?? new Date();
  const cfg = coinGeckoBudgetConfig(opts.env);
  try {
    if (targets.length === 0) return done({ status: "UNAVAILABLE" as const, reason: "no token instruments to quote" });
    if (!opts.fetchTokenQuotes && !process.env.COINGECKO_API_KEY?.trim()) return done({ status: "NOT_CONFIGURED" as const });
    const client = opts.client;

    // Facts for the plan: the durable markers and any fresh stored quote.
    const aliasRows = await client.instrumentAlias.findMany({
      where:  { provider: "crypto", externalId: { in: targets.map((t) => t.assetKey) } },
      select: { externalId: true, metadata: true },
    });
    const metaByKey = new Map(aliasRows.map((a) => [a.externalId, a.metadata]));
    const markers = new Map<string, TokenQuoteMarker>();
    for (const [k, m] of metaByKey) { const q = readTokenQuoteMarker(m); if (q) markers.set(k, q); }
    const recent = await client.priceObservation.findMany({
      where:  { instrumentId: { in: targets.map((t) => t.instrumentId) }, basis: PriceBasis.INTRADAY,
                date: { gte: new Date(`${quoteDateISO(new Date(now.getTime() - 86_400_000))}T00:00:00.000Z`) } },
      select: { instrumentId: true, fetchedAt: true },
    });
    const freshQuoteAt = new Map<string, Date>();
    for (const r of recent) { const p = freshQuoteAt.get(r.instrumentId); if (!p || p < r.fetchedAt) freshQuoteAt.set(r.instrumentId, r.fetchedAt); }

    const plan = planTokenQuotes(targets, { markers, freshQuoteAt }, now,
      { freshHours: cfg.tokenQuoteFreshHours, retryHours: cfg.unlistedRetryHours, maxTokens: opts.maxTokens ?? 10 });
    const skipped = { skippedFresh: plan.skippedFresh.length, skippedUnlisted: plan.skippedUnlisted.length };
    if (plan.ask.length === 0) return done({ status: "UNAVAILABLE" as const, reason: "nothing to quote (fresh or recently unlisted)", ...skipped, calls: 0 });

    // READ BEFORE SPEND. Unreadable ⇒ spend nothing.
    const budget = opts.budget ?? defaultCoinGeckoBudget(client);
    const remaining = await budget.remaining("token");
    if (remaining === null) return done({ status: "UNAVAILABLE" as const, reason: "CoinGecko budget unreadable — nothing spent", ...skipped, calls: 0 });
    if (remaining < 1) return done({ status: "UNAVAILABLE" as const, reason: `CoinGecko daily budget reached (${cfg.dailyCallCap} calls)`, ...skipped, calls: 0 });

    const fetchFn = opts.fetchTokenQuotes ?? fetchCoinGeckoTokenQuotes;
    // Re-review fix 2 — a WALL-TIME bound on token quoting inside one sync
    // (pacing included); tokens not reached rotate to later syncs.
    const deadline = Date.now() + (opts.deadlineMs ?? cfg.tokenQuoteDeadlineMs);
    const meter: Record<string, number> = {};
    const bound: Array<CurrentQuote & { instrumentId: string }> = [];
    const unpriced: string[] = [];
    const thin: string[] = [];
    const outcomeByKey = new Map<string, TokenQuoteMarker["outcome"]>();
    let configured = false;
    let stopped: string | undefined;
    let left = remaining;
    try {
      for (const platform of ["solana", "ethereum"] as const) {
        const group = plan.ask.filter((t) => t.platform === platform);
        if (group.length === 0 || left < 1 || stopped) continue;
        const before = Object.values(meter).reduce((a, b) => a + b, 0);
        const fetched = await fetchFn(platform, group.map((t) => ({ key: t.assetKey, contract: t.contract })), {
          now, meter, pace: budget.pace, maxCalls: left, deadlineEpochMs: deadline,
          minVolume24hUsd: cfg.minVolume24hUsd, minMarketCapUsd: cfg.minMarketCapUsd,
        });
        left -= Object.values(meter).reduce((a, b) => a + b, 0) - before;
        if (!fetched.configured) continue;
        configured = true;
        for (const q of fetched.quotes) {
          const t = group.find((g) => g.assetKey === q.symbol);
          if (t) { bound.push({ ...q, instrumentId: t.instrumentId }); outcomeByKey.set(t.assetKey, "PRICED"); }
        }
        for (const r of fetched.rejected) {
          outcomeByKey.set(r.symbol, r.kind);
          (r.kind === "THIN" ? thin : unpriced).push(r.symbol);
        }
        if (fetched.stopped) stopped = `${fetched.stopped.code}: ${fetched.stopped.message}`;
      }
    } finally {
      await budget.record(meter);
    }
    const calls = Object.values(meter).reduce((a, b) => a + b, 0);
    if (!configured) return done({ status: "NOT_CONFIGURED" as const });

    // Durable markers for what the vendor ACTUALLY answered (not for tokens never reached).
    const at = now.toISOString();
    for (const [key, outcome] of outcomeByKey) {
      const prev = markers.get(key);
      const marker: TokenQuoteMarker = { attemptedAt: at, outcome, ...(outcome === "PRICED" ? { pricedAt: at } : prev?.pricedAt ? { pricedAt: prev.pricedAt } : {}) };
      const existing = (metaByKey.get(key) ?? {}) as Record<string, unknown>;
      try {
        await client.instrumentAlias.update({
          where: { provider_externalId: { provider: "crypto", externalId: key } },
          data:  { metadata: { ...existing, quote: marker } as unknown as Prisma.InputJsonValue },
        });
      } catch { /* a marker is an optimisation; never fails the refresh */ }
    }

    const extra = { unpricedAssetKeys: unpriced, thinAssetKeys: thin, ...skipped, calls, ...(stopped ? { stopped } : {}) };
    if (bound.length === 0) return done({ status: "UNAVAILABLE" as const, reason: stopped ?? "no listed, liquid market price for these tokens", ...extra });
    const changedInstrumentIds = await writeCurrentQuotes(bound, client, TOKEN_QUOTE_SOURCE);
    const quotedAt = new Date(Math.min(...bound.map((b) => b.quotedAt.getTime())));
    return done({ status: "REFRESHED" as const, instrumentIds: bound.map((b) => b.instrumentId), changedInstrumentIds, quotedAt, ...extra });
  } catch (e) {
    return done({ status: "UNAVAILABLE" as const, reason: e instanceof Error ? e.message : String(e) });
  }
}
