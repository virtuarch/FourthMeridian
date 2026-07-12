/**
 * lib/investments/valuation.ts
 *
 * A8-4 — the DB binding for historical investment valuation. Thin batched reads
 * feeding the pure core (valuation-core.ts); no persistence — valuation is
 * derived arithmetic over persisted facts (PositionObservation, PriceObservation,
 * FxRate), never a second fact store (A9 persists space-level projections into
 * the existing snapshot cache, not this).
 *
 * Batched by design (no per-instrument N+1):
 *   - one PositionObservation window read for the whole scope,
 *   - one PositionReconstruction read (conflict flags),
 *   - one Instrument read (currency / cash-equivalent fallback),
 *   - one PriceObservation window read (RAW_CLOSE), resolved in memory through a
 *     PriceService over the snapshot,
 *   - one request-scoped ConversionContext at the valuation date.
 *
 * Quantities come through the A4 read path (resolvePositionAsOf) — imported
 * quantities flow through it unchanged. Imported statement "market values" are
 * NOT treated as an observed price/value anchor here; only genuine
 * institutionValue / institutionPrice facts on the resolved row are anchors
 * (the A7 evidence contract for imported valuation is deferred to A7-7).
 */

import { PositionOrigin, type Prisma, type PrismaClient } from "@prisma/client";
import { PriceBasis } from "@prisma/client";
import { db } from "@/lib/db";
import { identityContext } from "@/lib/money/convert";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { buildSpaceConversionContextById } from "@/lib/money/server-context";
import { resolvePositionAsOf, type PositionRow } from "@/lib/investments/reconstruction-read";
import { priceArchive } from "@/lib/prices/archive";
import { createPriceService } from "@/lib/prices/service";
import { PRICE_MAX_STALE_DAYS, minusDaysISO } from "@/lib/prices/config";
import type { PriceArchiveReader } from "@/lib/prices/types";
import {
  valueInstrumentAsOf,
  valuePortfolioAsOf,
  type InstrumentValuation,
  type InstrumentValuationInput,
  type InvestmentValuationView,
} from "./valuation-core";

type Client = PrismaClient | Prisma.TransactionClient;

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

interface FullPositionRow extends PositionRow {
  financialAccountId:   string;
  instrumentId:         string;
  isCash:               boolean;
  currency:             string | null;
  institutionValue:     number | null;
  institutionPrice:     number | null;
  institutionPriceDate: string | null;
}

export interface GetInvestmentValueArgs {
  /** Value the whole Space's investment holdings. */
  spaceId?: string;
  /** Or a single account (its Space supplies the reporting currency + FX). */
  financialAccountId?: string;
  asOf: string; // YYYY-MM-DD
  client?: Client;
}

/**
 * Point-in-time investment valuation for a Space (or one account) as-of a date.
 * Returns the shaped portfolio view — a valued subtotal plus an explicit
 * unvalued remainder; never a partial total presented as the whole.
 */
export async function getInvestmentValueAsOf(args: GetInvestmentValueArgs): Promise<InvestmentValuationView> {
  const client = args.client ?? db;
  const { asOf } = args;
  const asOfDate = new Date(`${asOf}T00:00:00.000Z`);

  // ── Scope: the account set ────────────────────────────────────────────────
  let accountIds: string[];
  let contextSpaceId: string | null = args.spaceId ?? null;
  if (args.financialAccountId) {
    accountIds = [args.financialAccountId];
    if (!contextSpaceId) {
      const link = await client.spaceAccountLink.findFirst({
        where: { financialAccountId: args.financialAccountId, status: "ACTIVE" },
        select: { spaceId: true },
      });
      contextSpaceId = link?.spaceId ?? null;
    }
  } else if (args.spaceId) {
    const links = await client.spaceAccountLink.findMany({
      where: { spaceId: args.spaceId, status: "ACTIVE", financialAccount: { deletedAt: null } },
      select: { financialAccountId: true },
    });
    accountIds = [...new Set(links.map((l) => l.financialAccountId))];
  } else {
    throw new Error("[valuation] getInvestmentValueAsOf requires spaceId or financialAccountId");
  }

  const reportingCurrency = (await resolveReportingCurrency(client, contextSpaceId));

  if (accountIds.length === 0) {
    return valuePortfolioAsOf([], asOf, reportingCurrency);
  }

  // ── Batched reads ─────────────────────────────────────────────────────────
  const [posRows, reconRows] = await Promise.all([
    client.positionObservation.findMany({
      where: {
        financialAccountId: { in: accountIds },
        supersededById: null,
        deletedAt: null,
        date: { lte: asOfDate },
      },
      select: {
        financialAccountId: true, instrumentId: true, date: true, quantity: true,
        origin: true, completeness: true, isCash: true, currency: true,
        institutionValue: true, institutionPrice: true, institutionPriceAsOf: true,
      },
    }),
    client.positionReconstruction.findMany({
      where: { financialAccountId: { in: accountIds } },
      select: { financialAccountId: true, instrumentId: true, conflicted: true },
    }),
  ]);

  // Group full rows by (account|instrument).
  const byPair = new Map<string, FullPositionRow[]>();
  const instrumentIds = new Set<string>();
  for (const r of posRows) {
    instrumentIds.add(r.instrumentId);
    const key = `${r.financialAccountId}|${r.instrumentId}`;
    const row: FullPositionRow = {
      financialAccountId: r.financialAccountId,
      instrumentId: r.instrumentId,
      date: ymd(r.date),
      quantity: r.quantity,
      origin: r.origin,
      completeness: r.completeness,
      isCash: r.isCash,
      currency: r.currency,
      institutionValue: r.institutionValue,
      institutionPrice: r.institutionPrice,
      institutionPriceDate: r.institutionPriceAsOf ? ymd(r.institutionPriceAsOf) : null,
    };
    (byPair.get(key) ?? byPair.set(key, []).get(key)!).push(row);
  }

  const conflictByPair = new Map<string, boolean>();
  for (const r of reconRows) conflictByPair.set(`${r.financialAccountId}|${r.instrumentId}`, r.conflicted);

  // Instrument currency / cash fallback.
  const instruments = await client.instrument.findMany({
    where: { id: { in: [...instrumentIds] } },
    select: { id: true, currency: true, isCashEquivalent: true },
  });
  const instrumentMeta = new Map(instruments.map((i) => [i.id, { currency: i.currency, isCash: i.isCashEquivalent === true }]));

  // ── Price window (RAW_CLOSE), resolved in memory ──────────────────────────
  const floorISO = minusDaysISO(asOf, PRICE_MAX_STALE_DAYS);
  const priceWindow = (await priceArchive.readRange?.([...instrumentIds], PriceBasis.RAW_CLOSE, floorISO, asOf)) ?? [];
  const priceService = createPriceService(memoryPriceReader(priceWindow));

  // ── Resolve each holding, then value ──────────────────────────────────────
  const inputs: Array<{ input: InstrumentValuationInput; nonCash: boolean }> = [];
  for (const [key, rows] of byPair) {
    const [financialAccountId, instrumentId] = key.split("|");
    const resolved = resolvePositionAsOf(rows, asOf);
    // Not held at asOf (no covering row, or an explicit closed-zero) → excluded.
    if (resolved.quantity == null || resolved.quantity === 0) continue;

    const resolvedRow = pickResolvedRow(rows, resolved.date, resolved.origin);
    const meta = instrumentMeta.get(instrumentId);
    const isCash = resolvedRow?.isCash ?? meta?.isCash ?? false;
    const nativeCurrency = resolvedRow?.currency ?? meta?.currency ?? null;

    inputs.push({
      nonCash: !isCash,
      input: {
        instrumentId,
        accountId: financialAccountId,
        quantity: resolved.quantity,
        quantityDate: resolved.date,
        quantityTier: resolved.tier,
        isCash,
        nativeCurrency,
        institutionValue: resolvedRow?.institutionValue ?? null,
        institutionPrice: resolvedRow?.institutionPrice ?? null,
        institutionPriceDate: resolvedRow?.institutionPriceDate ?? null,
        price: null, // filled below for non-cash without an institution anchor
        conflicted: conflictByPair.get(key) ?? false,
      },
    });
  }

  // Market-price lookups only where needed (non-cash, no institution anchor).
  for (const item of inputs) {
    const { input } = item;
    if (item.nonCash && input.institutionValue == null && input.institutionPrice == null) {
      input.price = await priceService.getPriceAsOf(input.instrumentId, asOf, PriceBasis.RAW_CLOSE);
    }
  }

  // ── FX context at the valuation date, then value ──────────────────────────
  const currencies = [...new Set(inputs.map((i) => i.input.nativeCurrency).filter((c): c is string => !!c))];
  const ctx = contextSpaceId
    ? await buildSpaceConversionContextById(contextSpaceId, { currencies, dates: [asOf] })
    : identityContext(reportingCurrency);

  const components: InstrumentValuation[] = inputs.map(({ input }) => valueInstrumentAsOf(input, asOf, ctx));
  return valuePortfolioAsOf(components, asOf, ctx.target);
}

/** The Space's reporting currency (context target), or the default when unscoped. */
async function resolveReportingCurrency(client: Client, spaceId: string | null): Promise<string> {
  if (!spaceId) return DEFAULT_DISPLAY_CURRENCY;
  const space = await client.space.findUnique({ where: { id: spaceId }, select: { reportingCurrency: true } });
  return space?.reportingCurrency ?? DEFAULT_DISPLAY_CURRENCY;
}

/** Pick the resolved row's full facts deterministically (institution facts preferred). */
function pickResolvedRow(rows: FullPositionRow[], date: string | null, origin: PositionOrigin | null): FullPositionRow | null {
  if (date == null || origin == null) return null;
  const matches = rows
    .filter((r) => r.date === date && r.origin === origin)
    .sort((a, b) => (b.institutionValue ?? -Infinity) - (a.institutionValue ?? -Infinity));
  return matches[0] ?? null;
}

/** An in-memory PriceArchiveReader over a preloaded RAW_CLOSE window (same walk-back semantics). */
function memoryPriceReader(window: { instrumentId: string; dateISO: string; price: number; currency: string }[]): PriceArchiveReader {
  const byInstrument = new Map<string, { dateISO: string; price: number; currency: string }[]>();
  for (const r of window) {
    const list = byInstrument.get(r.instrumentId) ?? byInstrument.set(r.instrumentId, []).get(r.instrumentId)!;
    list.push({ dateISO: r.dateISO, price: r.price, currency: r.currency });
  }
  for (const list of byInstrument.values()) list.sort((a, b) => b.dateISO.localeCompare(a.dateISO)); // desc

  return {
    async readLatestOnOrBefore(instrumentId, basis, dateISO, maxStaleDays) {
      if (basis !== PriceBasis.RAW_CLOSE) return null; // only RAW_CLOSE was preloaded
      const floor = minusDaysISO(dateISO, maxStaleDays);
      const list = byInstrument.get(instrumentId) ?? [];
      for (const r of list) {
        if (r.dateISO <= dateISO && r.dateISO >= floor) return r; // list is date-desc
      }
      return null;
    },
  };
}
