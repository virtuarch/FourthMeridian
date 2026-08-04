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

import {
  buildQuantityAuthorityContext, consultQuantityAuthority,
} from "@/lib/investments/quantity-authority";
import type { ComparisonRow } from "@/lib/investments/quantity-authority-bridge.core";
import type { CompletenessTier } from "@/lib/perspective-engine/types";
import { PositionOrigin, type Prisma, type PrismaClient, type ReconstructionStatus } from "@prisma/client";
import { PriceBasis } from "@prisma/client";
import { db } from "@/lib/db";
import { identityContext } from "@/lib/money/convert";
import { DEFAULT_DISPLAY_CURRENCY } from "@/lib/currency";
import { buildSpaceConversionContextById } from "@/lib/money/server-context";
import { resolvePositionAsOf, type PositionRow } from "@/lib/investments/reconstruction-read";
import { DIGITAL_ASSET_ACCOUNT_TYPES } from "@/lib/account-classifier";
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
  resolveHeldQuantity,
  isReconstructionResidue,
  reconstructionResidueReason,
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
  /**
   * V26-INVESTMENTS-HISTORY — the reconstruction's OWN verdict on whether it
   * closed its books for this pair. Optional so existing fixture callers still
   * type-check; absent is read as "not COMPLETE", which is the conservative
   * direction (see isReconstructionResidue — silence is not evidence).
   */
  reconciliation?:    ReconstructionStatus | null;
}

/**
 * The PositionReconstruction fields the valuation pipeline reads. Shared by all
 * three read sites (historical window, single date, current positions) so the
 * residue guard can never see a different verdict depending on the entry point.
 */
export const RECONSTRUCTION_VALUATION_SELECT = {
  financialAccountId: true, instrumentId: true, conflicted: true, reconciliation: true,
} as const;

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
  /**
   * Net-worth INVESTMENT-BUCKET scope. When true, crypto / digital-asset accounts
   * (canonical `DIGITAL_ASSET_ACCOUNT_TYPES`) contribute NO positions to this
   * valuation — their value belongs in `totalDigitalAssets`, not `totalInvestments`
   * (the `classifyAccounts` partition). A caller that assigns `valuedSubtotal` to
   * `totalInvestments` (the A9 snapshot regeneration) MUST set this, or a crypto
   * position on the shared PositionObservation spine (P2-6) is double-counted —
   * once here and again in the separate digital-asset total. Default false, so the
   * holdings-display callers (AI holdings, A10 Investments Time Machine,
   * getCurrentPositions) are unchanged and still surface crypto positions.
   */
  excludeDigitalAssetAccounts?: boolean;
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

  // Net-worth investment-bucket scope: crypto / digital-asset accounts are valued
  // in totalDigitalAssets, never here, so a crypto position on the shared spine
  // (P2-6) is not double-counted into totalInvestments. Applied as a relation
  // filter on the position read (localized to this consumer), so the shared
  // scope resolver — used by the holdings-display callers — is untouched.
  const digitalAssetFilter = args.excludeDigitalAssetAccounts === true
    ? { financialAccount: { type: { notIn: [...DIGITAL_ASSET_ACCOUNT_TYPES] } } }
    : {};

  // ── Batched reads — historical WINDOW (every observation ≤ asOf) ───────────
  const [posRows, reconRows] = await Promise.all([
    client.positionObservation.findMany({
      where: {
        financialAccountId: { in: accountIds },
        supersededById: null,
        deletedAt: null,
        ...digitalAssetFilter,
        // holdConstant needs the EARLIEST observation too (which may be after
        // asOf), so it can hold that quantity backward when nothing covers asOf.
        ...(holdConstant ? {} : { date: { lte: asOfDate } }),
      },
      select: POSITION_VALUATION_SELECT,
    }),
    client.positionReconstruction.findMany({
      where: { financialAccountId: { in: accountIds } },
      select: RECONSTRUCTION_VALUATION_SELECT,
    }),
  ]);

  return valuePositionRows({ client, asOf, contextSpaceId, reportingCurrency, holdConstant, posRows, reconRows });
}

export interface GetInvestmentValueWindowArgs {
  spaceId?: string;
  financialAccountId?: string;
  /** The exact set of dates to value (YYYY-MM-DD). Deduped + sorted internally. */
  dates: readonly string[];
  client?: Client;
  holdConstantBeforeEarliest?: boolean;
  visibilityScope?: InvestmentVisibilityScope;
  /** V26-QUANTITY-1G — receives the quantity-authority decision ledger. */
  authorityLedgerOut?: ComparisonRow[];
  excludeDigitalAssetAccounts?: boolean;
}

/**
 * HIST-1C — batch point-in-time valuation across MANY dates from ONE position
 * read + ONE price window + ONE FX context, returning dateISO → the same shaped
 * view getInvestmentValueAsOf produces per date. This is a pure execution-strategy
 * optimization: for each requested date the number is byte-identical to calling
 * getInvestmentValueAsOf({ asOf: date, ...sameArgs }) — it collapses the N×date
 * DB round-trips (position + price + instrument + FX per day) into O(1) reads,
 * without a second valuation authority or any changed reconstruction/honesty
 * semantics (every date flows through the same per-day core, valuePositionRows-
 * OverDates). Digital-asset exclusion, hold-constant, and visibility scope carry
 * through exactly as in the single-date entry point.
 *
 * The position window is read once (≤ max(dates), or ALL when holdConstant needs
 * the earliest observation); resolvePositionAsOf clips each day to its own ≤-date
 * subset, so the shared window cannot leak a later row into an earlier day.
 */
export async function getInvestmentValueForWindow(
  args: GetInvestmentValueWindowArgs,
): Promise<Map<string, InvestmentValuationView>> {
  const client = args.client ?? db;
  const holdConstant = args.holdConstantBeforeEarliest === true;
  const visibilityScope: InvestmentVisibilityScope = args.visibilityScope ?? "all";

  const dates = [...new Set(args.dates)].sort();
  const out = new Map<string, InvestmentValuationView>();
  if (dates.length === 0) return out;

  const { accountIds, contextSpaceId, reportingCurrency } =
    await resolveInvestmentScopeAndCurrency(client, args, visibilityScope);

  // No in-scope accounts → each date is an empty portfolio view (parity with the
  // single-date early return in getInvestmentValueAsOf).
  if (accountIds.length === 0) {
    for (const d of dates) out.set(d, valuePortfolioAsOf([], d, reportingCurrency));
    return out;
  }

  const digitalAssetFilter = args.excludeDigitalAssetAccounts === true
    ? { financialAccount: { type: { notIn: [...DIGITAL_ASSET_ACCOUNT_TYPES] } } }
    : {};

  // One historical WINDOW read for the whole date span (every observation ≤ the
  // latest requested date; ALL observations when holdConstant needs the earliest).
  const maxDateObj = new Date(`${dates[dates.length - 1]}T00:00:00.000Z`);
  const [posRows, reconRows] = await Promise.all([
    client.positionObservation.findMany({
      where: {
        financialAccountId: { in: accountIds },
        supersededById: null,
        deletedAt: null,
        ...digitalAssetFilter,
        ...(holdConstant ? {} : { date: { lte: maxDateObj } }),
      },
      select: POSITION_VALUATION_SELECT,
    }),
    client.positionReconstruction.findMany({
      where: { financialAccountId: { in: accountIds } },
      select: RECONSTRUCTION_VALUATION_SELECT,
    }),
  ]);

  return valuePositionRowsOverDates({
    client, dates, contextSpaceId, reportingCurrency, holdConstant, posRows, reconRows,
    authorityLedgerOut: args.authorityLedgerOut,
  });
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
 * The valuation pipeline over ALREADY-FETCHED position rows for ONE date: group
 * by (account, instrument), resolve each as-of (A4 origin precedence), attach the
 * price window + FX context, and value through valuation-core. This is THE
 * single valuation path — getInvestmentValueAsOf (historical window) and
 * getCurrentPositions (cheap latest-per-pair) both call it with the identical
 * `posRows` shape, so they can differ ONLY in how the rows were read, never in
 * how they are valued. Reuse, not a second engine.
 *
 * Thin wrapper over the multi-date core (valuePositionRowsOverDates) with a
 * single-date list — the per-day valuation logic lives in exactly one place, so
 * the window batch (HIST-1C) and the single read produce byte-identical views.
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
  const byDate = await valuePositionRowsOverDates({
    client: args.client,
    dates: [args.asOf],
    contextSpaceId: args.contextSpaceId,
    reportingCurrency: args.reportingCurrency,
    holdConstant: args.holdConstant,
    posRows: args.posRows,
    reconRows: args.reconRows,
  });
  // valuePortfolioAsOf always returns a view for a requested date (empty when no
  // holdings), so this is defined; the fallback keeps the function total-typed.
  return byDate.get(args.asOf) ?? valuePortfolioAsOf([], args.asOf, args.reportingCurrency);
}

/**
 * HIST-1C — the valuation pipeline over ALREADY-FETCHED position rows for a SET
 * of dates, valuing every date from ONE shared prep: one grouping pass, one
 * instrument read, one RAW_CLOSE price window ([min(dates)−staleness, max(dates)]),
 * and one conversion context (all dates × currencies). Each date is then valued
 * independently against that in-memory prep, so the produced view for any date D
 * is byte-identical to a standalone single-date valuation of D:
 *   - resolvePositionAsOf ignores rows dated after D (a wider row window cannot
 *     change D's resolution);
 *   - the price reader re-applies the per-day staleness floor, so a wider price
 *     window returns the same nearest-≤-within-floor close for D;
 *   - ConversionContext.resolve is a per-(currency,date) table lookup, so a
 *     superset context returns the same rate for D.
 * No second valuation authority — this is the single per-day core, hoisted once.
 */
export async function valuePositionRowsOverDates(args: {
  client:            Client;
  dates:             readonly string[];
  contextSpaceId:    string | null;
  reportingCurrency: string;
  holdConstant:      boolean;
  posRows:           readonly ObservationValuationRow[];
  reconRows:         readonly ReconstructionConflictRow[];
  /**
   * V26-QUANTITY-1G — receives the decision ledger when the quantity authority
   * is consulted. Optional and inert when `QUANTITY_AUTHORITY_MODE` is off.
   */
  authorityLedgerOut?: ComparisonRow[];
}): Promise<Map<string, InvestmentValuationView>> {
  const { client, contextSpaceId, reportingCurrency, holdConstant, posRows, reconRows } = args;

  const out = new Map<string, InvestmentValuationView>();
  const dates = [...new Set(args.dates)].sort();
  if (dates.length === 0) return out;

  // ── Shared prep, built ONCE for every requested date ───────────────────────
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
  /** V26-INVESTMENTS-HISTORY — the reconstruction's verdict, per (account, instrument). */
  const reconciliationByPair = new Map<string, string | null>();
  for (const r of reconRows) {
    const k = `${r.financialAccountId}|${r.instrumentId}`;
    conflictByPair.set(k, r.conflicted);
    reconciliationByPair.set(k, r.reconciliation ?? null);
  }

  // Instrument currency / cash fallback.
  const instruments = await client.instrument.findMany({
    where: { id: { in: [...instrumentIds] } },
    select: { id: true, currency: true, isCashEquivalent: true },
  });
  const instrumentMeta = new Map(instruments.map((i) => [i.id, { currency: i.currency, isCash: i.isCashEquivalent === true }]));

  // ── Price window (RAW_CLOSE), resolved in memory over the WHOLE date span ──
  // Floor from the earliest requested date; the price reader re-applies its own
  // per-day staleness floor, so a wider preloaded window is a strict superset of
  // any single day's [D−staleness, D] and yields identical resolutions.
  const minDate = dates[0];
  const maxDate = dates[dates.length - 1];
  const floorISO = minusDaysISO(minDate, PRICE_MAX_STALE_DAYS);
  const priceWindow = (await priceArchive.readRange?.([...instrumentIds], PriceBasis.RAW_CLOSE, floorISO, maxDate)) ?? [];
  const priceService = createPriceService(memoryPriceReader(priceWindow));

  // ── One conversion context spanning every date × every native currency ─────
  // The currency union is derived from the position rows + instrument meta (a
  // superset of any single day's resolved native currencies); resolve() is a
  // per-(currency,date) lookup, so the superset never changes a per-date rate.
  const currencySet = new Set<string>();
  for (const rows of byPair.values()) for (const r of rows) if (r.currency) currencySet.add(r.currency);
  for (const meta of instrumentMeta.values()) if (meta.currency) currencySet.add(meta.currency);
  const ctx = contextSpaceId
    ? await buildSpaceConversionContextById(contextSpaceId, { currencies: [...currencySet], dates })
    : identityContext(reportingCurrency);

  // ── V26-QUANTITY-1G — the quantity authority, when opted in ───────────────
  // Built once for the whole date span. `off` returns an inert context without
  // issuing a query, so this costs nothing unless someone asked for it.
  const authorityCtx = await buildQuantityAuthorityContext({
    client,
    dates,
    financialAccountIds: [...new Set(posRows.map((r) => r.financialAccountId))],
  });

  // ── Value each requested date independently against the shared prep ────────
  for (const asOf of dates) {
    const inputs: Array<{ input: InstrumentValuationInput; nonCash: boolean }> = [];
    /** Components the authority refused — unvalued, never absent. */
    const excluded: Array<{
      instrumentId: string; accountId: string;
      quantity: number | null; quantityTier: CompletenessTier; reason: string;
    }> = [];
    for (const [key, rows] of byPair) {
      const [financialAccountId, instrumentId] = key.split("|");
      const resolved = resolvePositionAsOf(rows, asOf);
      // V26-QUANTITY-1A — the constant-quantity fallback is decided by ONE pure
      // authority (valuation-core.resolveHeldQuantity), which distinguishes "no
      // observation covers this date" (null — may hold constant) from "an
      // observation proves this position was closed" (0 — never may). Previously
      // both entered the fallback, so every sold position was resurrected at its
      // earliest quantity on every later date.
      // V26-S4 — THE BACKWARD CARRY MAY NOT LEAN ON A WALK THAT DID NOT CLOSE.
      //
      // `resolveHeldQuantity` carries the EARLIEST row backward when nothing
      // covers the date. Since S1 that earliest row is normally the walk's
      // OPENING ANCHOR — its own statement of what was held before its first
      // event — so the carry is the reconstruction speaking, and is licensed.
      //
      // It is NOT licensed when the walk FAILED or its sources CONFLICT. There
      // the earliest row is whatever the replay reached before it stopped, and
      // projecting it into prehistory dresses a stop in the clothes of an
      // answer. TQQQ is the worked example: while its split had no terms its
      // walk stopped at 2025-11-20 holding 20 shares, and a carry would have
      // spread today's post-split count across every earlier date.
      //
      // Refusing here leaves the component unresolved, which the caller already
      // treats as not-held — never a fabricated quantity, never a fabricated
      // ownership (ownership is decided elsewhere and is not consulted here).
      const pairReconciliation = reconciliationByPair.get(key) ?? null;
      const carryLicensed = pairReconciliation !== "FAILED" && !(conflictByPair.get(key) ?? false);
      const held = resolveHeldQuantity(resolved, rows, holdConstant && carryLicensed);
      // V26-QUANTITY-1G — consult the authority. In `compare` this records what
      // it would have said and returns the legacy value unchanged; only `adopt`
      // lets it move money, and only where the timeline is absolute, covered,
      // and its ordering evidenced rather than tie-broken. Every other date
      // falls back to `resolveHeldQuantity` WITH a recorded reason.
      const consulted = consultQuantityAuthority({
        ctx: authorityCtx, dateISO: asOf,
        financialAccountId, instrumentId, legacyQuantity: held.quantity,
      });
      const quantity     = consulted.quantity;
      const quantityDate = consulted.usedAuthority ? asOf : held.date;
      // An adopted quantity is the authority's own evidence grade: an observed
      // anchor is observed, a replayed interval is derived from observed events.
      // Carrying the legacy tier would mislabel it.
      const quantityTier = consulted.usedAuthority
        ? (consulted.decision.source === "AUTHORITY" && consulted.decision.basis === "OBSERVED_ANCHOR"
            ? "observed" : "derived")
        : held.tier;
      // The backward carry is a LEGACY concept, retained for the quantity tier.
      // It no longer gates the institution anchor — that is date-gated below,
      // independently of where the quantity came from.
      const heldConstant = consulted.usedAuthority ? false : held.heldConstant;
      void heldConstant;
      const resolvedRow  = held.sourceRow ?? pickResolvedRow(rows, resolved.date, resolved.origin);

      // V26-INVESTMENTS-HISTORY — an EXCLUDED component must stay visible.
      //
      // Dropping it here removed it from the total AND from completeness
      // accounting, so an opening built from 8 supported positions while 12
      // were omitted reported `unvalued 0 · tier estimated` — LESS doubt than
      // before, on less evidence. A component the authority will not support is
      // unvalued, not absent, and it carries the authority's own reason so the
      // omission is inspectable rather than inferable.
      if (consulted.excluded) {
        excluded.push({
          instrumentId, accountId: financialAccountId,
          quantity: held.quantity, quantityTier: held.tier,
          reason: consulted.decision.source === "LEGACY"
            ? `Quantity unsupported (${consulted.decision.reason}): ${consulted.decision.detail}`
            : "Quantity unsupported by the quantity authority.",
        });
        continue;
      }

      // V26-INVESTMENTS-HISTORY — RECONSTRUCTION RESIDUE IS NOT A SHORT POSITION.
      //
      // A DERIVED negative quantity from a reconstruction that could not close
      // its own books (PARTIAL / FAILED / no summary) is the backward replay
      // running out of history, not evidence of a short. Valuing it multiplied
      // an unexplained opening by a real market price and booked the product as
      // portfolio value — locally, six positions on one Schwab account turned
      // ~$3.4k of unknown history into ~−$3.4k of asserted value.
      //
      // Refused as UNVALUED-with-a-reason through the same `excluded` path a
      // refused authority quantity takes: the component keeps its instrument,
      // account, quantity and evidence tier, stays out of the subtotal, and
      // degrades the portfolio's completeness — never clamped to zero, never
      // dropped. The reconstruction's own verdict is the authority here; this
      // binding only stops ignoring it.
      //
      // Scoped to the legacy resolver deliberately: when the quantity authority
      // ADOPTS a value it owns its own evidence grade and exclusion path, so
      // second-guessing it here would be a different decision in a second place.
      const reconciliation = reconciliationByPair.get(key) ?? null;
      if (
        !consulted.usedAuthority &&
        isReconstructionResidue({
          quantity,
          origin: resolvedRow?.origin ?? resolved.origin ?? null,
          reconciliation,
        })
      ) {
        excluded.push({
          instrumentId, accountId: financialAccountId,
          quantity, quantityTier,
          reason: reconstructionResidueReason(quantity, reconciliation),
        });
        continue;
      }

      // Not held at asOf (no covering row, or an explicit closed-zero) → excluded.
      // This is a KNOWN ZERO, categorically different from the case above: the
      // evidence says the position was not held, rather than saying nothing.
      if (quantity == null || quantity === 0) continue;
      const anchorPertainsToAsOf = resolvedRow?.date === asOf;
      const meta = instrumentMeta.get(instrumentId);
      // V26-S3-CASH — CASH-EQUIVALENCE IS A PROPERTY OF THE INSTRUMENT.
      //
      // This was `resolvedRow?.isCash ?? meta?.isCash ?? false`, and `??` only
      // falls through null/undefined — never `false`. Since `isCash` is a
      // NOT NULL column defaulting to false, ANY row that omitted it (every
      // DERIVED reconstruction row until this slice) permanently out-voted the
      // instrument, and a dollar balance was sent to a market-price lookup.
      //
      // The rule, stated once: an Instrument marked `isCashEquivalent` IS cash,
      // whatever a row's column happens to hold — that flag is the instrument's
      // financial identity and a per-row default cannot revoke it. A row may
      // still ASSERT cash for an instrument not so marked (a provider stating
      // something about one specific holding), so the two are OR'd rather than
      // the instrument simply winning.
      //
      // Deliberately NOT a blanket "treat false as absent": `false` stays
      // meaningful everywhere it is a real statement — a wallet position, an
      // equity holding, a security whose provider flag says non-cash. Only the
      // instrument's own cash identity can override it, and only in one
      // direction.
      const isCash = meta?.isCash === true || resolvedRow?.isCash === true;
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
          // V26-INVESTMENTS-HISTORY — the institution anchor belongs to the DATE
          // OF THE ROW THAT SUPPLIED IT, and to no other date.
          //
          // Passing it through on any other day short-circuits
          // valueInstrumentAsOf's Precedence 1 and values that day at the
          // anchor's price. With observations that begin in July, a 2026-01-01
          // valuation was priced at the 2026-07-17 close — a look-forward of
          // seven months. The previous gate keyed on `heldConstant`, which only
          // covered the legacy backward-carry, so the same hole reopened the
          // moment quantity came from anywhere else.
          //
          // The rule is therefore independent of quantity provenance: same date
          // or nothing. When it is nothing, the component falls through to the
          // canonical RAW_CLOSE lookup on or before asOf, and is left unvalued
          // with a reason when no such price exists.
          institutionValue: anchorPertainsToAsOf ? (resolvedRow?.institutionValue ?? null) : null,
          institutionPrice: anchorPertainsToAsOf ? (resolvedRow?.institutionPrice ?? null) : null,
          institutionPriceDate: anchorPertainsToAsOf ? (resolvedRow?.institutionPriceDate ?? null) : null,
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

    const components: InstrumentValuation[] = inputs.map(({ input }) => valueInstrumentAsOf(input, asOf, ctx));
    // Refused components enter the view as UNVALUED: `reportingValue: null`
    // keeps them out of the subtotal while `valuePortfolioAsOf` counts them and
    // degrades the tier through `worstTier`.
    for (const e of excluded) {
      components.push({
        instrumentId: e.instrumentId, accountId: e.accountId, quantity: e.quantity,
        nativePrice: null, nativeValue: null, reportingValue: null,
        currency: null, reportingCurrency: ctx.target,
        quantityTier: e.quantityTier, priceTier: "unknown", fxTier: "unknown",
        overallTier: "unknown", basisUsed: null,
        priceDate: null, staleDays: null, reason: e.reason, conflicted: false,
      });
    }
    out.set(asOf, valuePortfolioAsOf(components, asOf, ctx.target));
  }

  if (args.authorityLedgerOut) args.authorityLedgerOut.push(...authorityCtx.ledger);

  return out;
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
