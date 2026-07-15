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
  resolveSpaceInvestmentAccountIds,
  resolveSingleAccountScope,
  type InvestmentVisibilityScope,
} from "./account-scope";
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

/**
 * The PositionObservation fields the valuation pipeline reads. Shared by the
 * historical window read (getInvestmentValueAsOf) and the cheap latest-per-pair
 * read (getCurrentPositions), so both feed `valuePositionRows` the SAME shape and
 * can never diverge on which columns valuation consumes.
 */
export const POSITION_VALUATION_SELECT = {
  financialAccountId: true, instrumentId: true, date: true, quantity: true,
  origin: true, completeness: true, isCash: true, currency: true,
  institutionValue: true, institutionPrice: true, institutionPriceAsOf: true,
} as const;

/** One PositionObservation row as read for valuation (POSITION_VALUATION_SELECT shape). */
export interface ObservationValuationRow {
  financialAccountId:   string;
  instrumentId:         string;
  date:                 Date;
  quantity:             number;
  origin:               PositionOrigin;
  completeness:         string | null;
  isCash:               boolean;
  currency:             string | null;
  institutionValue:     number | null;
  institutionPrice:     number | null;
  institutionPriceAsOf: Date | null;
}

/** Reconstruction conflict flags for the scoped accounts. */
export interface ReconstructionConflictRow {
  financialAccountId: string;
  instrumentId:       string;
  conflicted:         boolean;
}

export interface GetInvestmentValueArgs {
  /** Value the whole Space's investment holdings. */
  spaceId?: string;
  /** Or a single account (its Space supplies the reporting currency + FX). */
  financialAccountId?: string;
  asOf: string; // YYYY-MM-DD
  client?: Client;
  /**
   * A9 constant-quantity fallback. When a holding has NO position observation on
   * or before `asOf` (e.g. a just-connected investment account whose provider
   * returned holdings but no transaction history, so A4 reconstructed nothing),
   * value it at the EARLIEST observed quantity held constant backward × that
   * day's price, instead of excluding it. A labeled `estimated` value — the price
   * is real, only the quantity is an assumption; never fabricated. Default false,
   * so point-in-time callers keep the strict "not held before it existed" answer.
   */
  holdConstantBeforeEarliest?: boolean;
  /**
   * KD-21a — which SpaceAccountLinks contribute positions when scoped by a Space.
   * "all" (DEFAULT) values every ACTIVE linked account, so wealth-total callers
   * (A9 snapshot regeneration) still count a BALANCE_ONLY-shared account's value
   * toward Space wealth. "detailEligible" restricts to FULL-visibility links (the
   * canonical detail predicate), so member-facing reads never expose the
   * positions of a BALANCE_ONLY / SUMMARY_ONLY account. See account-scope.ts.
   */
  visibilityScope?: InvestmentVisibilityScope;
}

/**
 * Point-in-time investment valuation for a Space (or one account) as-of a date.
 * Returns the shaped portfolio view — a valued subtotal plus an explicit
 * unvalued remainder; never a partial total presented as the whole.
 */
export async function getInvestmentValueAsOf(args: GetInvestmentValueArgs): Promise<InvestmentValuationView> {
  const client = args.client ?? db;
  const { asOf } = args;
  const holdConstant = args.holdConstantBeforeEarliest === true;
  const asOfDate = new Date(`${asOf}T00:00:00.000Z`);

  // ── Scope: the account set (visibility-filtered per KD-21a) + reporting ccy ─
  const visibilityScope: InvestmentVisibilityScope = args.visibilityScope ?? "all";
  const { accountIds, contextSpaceId, reportingCurrency } =
    await resolveInvestmentScopeAndCurrency(client, args, visibilityScope);

  if (accountIds.length === 0) {
    return valuePortfolioAsOf([], asOf, reportingCurrency);
  }

  // ── Batched reads — historical WINDOW (every observation ≤ asOf) ───────────
  const [posRows, reconRows] = await Promise.all([
    client.positionObservation.findMany({
      where: {
        financialAccountId: { in: accountIds },
        supersededById: null,
        deletedAt: null,
        // holdConstant needs the EARLIEST observation too (which may be after
        // asOf), so it can hold that quantity backward when nothing covers asOf.
        ...(holdConstant ? {} : { date: { lte: asOfDate } }),
      },
      select: POSITION_VALUATION_SELECT,
    }),
    client.positionReconstruction.findMany({
      where: { financialAccountId: { in: accountIds } },
      select: { financialAccountId: true, instrumentId: true, conflicted: true },
    }),
  ]);

  return valuePositionRows({ client, asOf, contextSpaceId, reportingCurrency, holdConstant, posRows, reconRows });
}

/**
 * Resolve the scoped account set + reporting currency for an investment read.
 * Shared by getInvestmentValueAsOf (window) and getCurrentPositions (latest), so
 * scope + visibility (KD-21a) are resolved in exactly one place.
 */
export async function resolveInvestmentScopeAndCurrency(
  client: Client,
  args: { spaceId?: string; financialAccountId?: string },
  visibilityScope: InvestmentVisibilityScope,
): Promise<{ accountIds: string[]; contextSpaceId: string | null; reportingCurrency: string }> {
  let accountIds: string[];
  let contextSpaceId: string | null = args.spaceId ?? null;
  if (args.financialAccountId) {
    const s = await resolveSingleAccountScope(client, args.financialAccountId, contextSpaceId, visibilityScope);
    accountIds = s.accountIds;
    contextSpaceId = s.spaceId;
  } else if (args.spaceId) {
    accountIds = await resolveSpaceInvestmentAccountIds(client, args.spaceId, visibilityScope);
  } else {
    throw new Error("[valuation] resolveInvestmentScopeAndCurrency requires spaceId or financialAccountId");
  }
  const reportingCurrency = await resolveReportingCurrency(client, contextSpaceId);
  return { accountIds, contextSpaceId, reportingCurrency };
}

/**
 * The valuation pipeline over ALREADY-FETCHED position rows: group by
 * (account, instrument), resolve each as-of (A4 origin precedence), attach the
 * price window + FX context, and value through valuation-core. This is THE
 * single valuation path — getInvestmentValueAsOf (historical window) and
 * getCurrentPositions (cheap latest-per-pair) both call it with the identical
 * `posRows` shape, so they can differ ONLY in how the rows were read, never in
 * how they are valued. Reuse, not a second engine.
 */
export async function valuePositionRows(args: {
  client:            Client;
  asOf:              string;
  contextSpaceId:    string | null;
  reportingCurrency: string;
  holdConstant:      boolean;
  posRows:           readonly ObservationValuationRow[];
  reconRows:         readonly ReconstructionConflictRow[];
}): Promise<InvestmentValuationView> {
  const { client, asOf, contextSpaceId, reportingCurrency, holdConstant, posRows, reconRows } = args;

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
    let quantity      = resolved.quantity;
    let quantityDate  = resolved.date;
    let quantityTier  = resolved.tier;
    let resolvedRow   = pickResolvedRow(rows, resolved.date, resolved.origin);
    let heldConstant  = false;

    // Constant-quantity fallback (holdConstant): nothing covers asOf → hold the
    // EARLIEST observed quantity backward as a labeled estimate (price is real).
    if ((quantity == null || quantity === 0) && holdConstant && rows.length > 0) {
      const earliest = rows.reduce((min, r) => (r.date < min.date ? r : min), rows[0]);
      if (earliest.quantity > 0) {
        quantity     = earliest.quantity;
        quantityDate = earliest.date;
        quantityTier = "estimated";
        resolvedRow  = earliest;
        heldConstant = true;
      }
    }

    // Not held at asOf (no covering row, or an explicit closed-zero) → excluded.
    if (quantity == null || quantity === 0) continue;
    const meta = instrumentMeta.get(instrumentId);
    const isCash = resolvedRow?.isCash ?? meta?.isCash ?? false;
    const nativeCurrency = resolvedRow?.currency ?? meta?.currency ?? null;

    inputs.push({
      nonCash: !isCash,
      input: {
        instrumentId,
        accountId: financialAccountId,
        quantity,
        quantityDate,
        quantityTier,
        isCash,
        nativeCurrency,
        // When holding quantity constant BACKWARD (the fallback above fired, so
        // asOf predates the earliest observation), that observation's institution
        // price/value pertains to ITS date — carrying it here would short-circuit
        // valueInstrumentAsOf's Precedence 1 and value every past day at the
        // CURRENT value. Drop the institution anchor so non-cash positions fall
        // through to the real RAW_CLOSE market price at asOf ("price is real",
        // above); cash still resolves via its unit-price branch.
        institutionValue: heldConstant ? null : (resolvedRow?.institutionValue ?? null),
        institutionPrice: heldConstant ? null : (resolvedRow?.institutionPrice ?? null),
        institutionPriceDate: heldConstant ? null : (resolvedRow?.institutionPriceDate ?? null),
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
