/**
 * lib/investments/position-capture.ts
 *
 * Append-only investment position capture (Slice A1). Dark-write: records one
 * OBSERVED PositionObservation per (account, instrument) for a capture date,
 * from the RAW Plaid holdings payload — INCLUDING cash and no-ticker securities
 * the current-state Holding writer skips. `Holding` is untouched.
 *
 * Behavior:
 *  - Same-day re-capture updates the same observation row (same date — honest),
 *    never a duplicate (idempotent via the composite unique key).
 *  - Prior-day observations are NEVER deleted or rewritten.
 *  - Disappearance rule: an instrument previously observed in the account but
 *    absent from the (complete) current payload gets an explicit quantity:0
 *    OBSERVED row. Only ever called AFTER a successful holdings fetch, so a
 *    partial/failed fetch can never manufacture a false zero.
 *
 * Gated behind INVESTMENT_OBSERVATIONS_ENABLED — callers must check
 * investmentObservationsEnabled() first. Best-effort/non-fatal by contract:
 * callers wrap this in try/catch (the writeBtcHolding precedent).
 */

import type { Holding as PlaidHolding, Security } from "plaid";
import { PositionOrigin, type Prisma, type PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { resolveInstrumentForPlaidSecurity, PLAID_PROVIDER } from "@/lib/investments/instrument-resolver";
import { captureBrokerageCash, type ReconHolding, type ReconciliationStatus } from "@/lib/investments/brokerage-cash";
import { captureSecurityPrices, securityPriceCapturesEnabled } from "@/lib/prices/capture";

/** Kill switch — absent/false ⇒ no Instrument/PositionObservation writes at all. */
export function investmentObservationsEnabled(): boolean {
  return process.env.INVESTMENT_OBSERVATIONS_ENABLED === "true";
}

type Client = PrismaClient | Prisma.TransactionClient;

/** Parse a Plaid date-only string ("YYYY-MM-DD") into a UTC Date, or null. */
export function parsePlaidDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(`${s.slice(0, 10)}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Is this security brokerage cash / a cash-equivalent position? */
export function isCashSecurity(sec: Pick<Security, "is_cash_equivalent" | "type">): boolean {
  return sec.is_cash_equivalent === true || (sec.type ?? "").toLowerCase() === "cash";
}

/** Observed valuation facts for a holding — nulls preserved (never fabricated). */
export interface ObservedFacts {
  quantity:             number;
  institutionPrice:     number | null;
  institutionValue:     number | null;
  institutionPriceAsOf: Date | null;
  costBasis:            number | null;
  vestedQuantity:       number | null;
  currency:             string | null;
  isCash:               boolean;
}

/** Pure mapping of a raw Plaid holding+security to observed facts. */
export function mapHoldingToObservedFacts(holding: PlaidHolding, sec: Security): ObservedFacts {
  return {
    quantity:             holding.quantity,
    institutionPrice:     holding.institution_price ?? null,
    institutionValue:     holding.institution_value ?? null,
    institutionPriceAsOf: parsePlaidDate(holding.institution_price_as_of),
    costBasis:            holding.cost_basis ?? null,
    vestedQuantity:       holding.vested_quantity ?? null,
    currency:
      holding.iso_currency_code ??
      holding.unofficial_currency_code ??
      sec.iso_currency_code ??
      sec.unofficial_currency_code ??
      null,
    isCash: isCashSecurity(sec),
  };
}

/** Instruments observed before but absent now (disappearance → zero). Pure. */
export function computeDisappearedInstrumentIds(
  priorInstrumentIds: Iterable<string>,
  currentInstrumentIds: Iterable<string>,
): string[] {
  const current = new Set(currentInstrumentIds);
  const out: string[] = [];
  for (const id of new Set(priorInstrumentIds)) if (!current.has(id)) out.push(id);
  return out;
}

export interface CaptureResult {
  observed:       number; // holdings captured (incl. cash / no-ticker)
  disappeared:    number; // zero-quantity rows appended
  instrumentsNew: number;
  conflicts:      number;
  /** Derived brokerage-cash reconciliation outcome, when balance context is supplied. */
  brokerageCash?: { status: ReconciliationStatus; written: boolean; residual: number | null; derivedCash: number };
  /** A8-2 — same-day close-price capture outcome (present only when SECURITY_PRICES_ENABLED). */
  securityPrices?: { attempted: number; inserted: number; skipped: number };
}

export interface CaptureParams {
  financialAccountId: string;
  /** RAW, unfiltered Plaid holdings for THIS account (incl. cash / no-ticker). */
  plaidHoldings: PlaidHolding[];
  /** security_id → Security map from the same holdingsGet payload. */
  securitiesById: Record<string, Security>;
  /** Observation (capture) date — the refresh date; NOT a fabricated history date. */
  date: Date;
  client?: Client;
  /**
   * Optional account-balance context for derived brokerage-cash reconciliation
   * (runs AFTER position capture, from the SAME refresh payload so inputs are
   * contemporaneous). Omit to skip reconciliation. `payloadComplete` is
   * `is_investments_fallback_item !== true`.
   */
  accountBalance?:  number | null;
  accountCurrency?: string | null;
  balanceAsOf?:     Date | null;
  payloadComplete?: boolean;
}

/**
 * Capture observations for one account. Assumes the caller only invokes this
 * after a SUCCESSFUL holdings fetch (so the payload is complete enough to treat
 * a disappearance as an observation).
 */
export async function capturePositionObservations(params: CaptureParams): Promise<CaptureResult> {
  const client = params.client ?? db;
  const date = normalizeDate(params.date);
  const result: CaptureResult = { observed: 0, disappeared: 0, instrumentsNew: 0, conflicts: 0 };
  const currentInstrumentIds = new Set<string>();
  // A8-2 — resolved instrumentId → its Security, for same-day close-price capture
  // after the loop. Populated regardless of the flag (cheap); the write is gated.
  const securityByInstrument = new Map<string, Security>();

  for (const holding of params.plaidHoldings) {
    const sec = params.securitiesById[holding.security_id];
    if (!sec) continue; // cannot resolve identity without the security record

    const resolved = await resolveInstrumentForPlaidSecurity(sec, {
      client,
      financialAccountId: params.financialAccountId,
    });
    if (resolved.created) result.instrumentsNew++;
    if (resolved.conflict) result.conflicts++;
    currentInstrumentIds.add(resolved.instrumentId);
    securityByInstrument.set(resolved.instrumentId, sec);

    const facts = mapHoldingToObservedFacts(holding, sec);
    await upsertObservation(client, params.financialAccountId, resolved.instrumentId, date, facts);
    result.observed++;
  }

  // Disappearance: instruments previously observed (via Plaid) in this account
  // but absent from today's complete payload → explicit zero. Never touches
  // prior-day rows; appends/updates only today's observation.
  const priorObserved = await client.positionObservation.findMany({
    // A7-1 — a rolled-back imported anchor must not keep an instrument "alive"
    // for disappearance detection; existing rows have deletedAt null, so this is
    // a no-op until an import is rolled back.
    where: { financialAccountId: params.financialAccountId, origin: PositionOrigin.OBSERVED, source: PLAID_PROVIDER, deletedAt: null },
    select: { instrumentId: true },
    distinct: ["instrumentId"],
  });
  const disappeared = computeDisappearedInstrumentIds(
    priorObserved.map((p) => p.instrumentId),
    currentInstrumentIds,
  );
  for (const instrumentId of disappeared) {
    await upsertObservation(client, params.financialAccountId, instrumentId, date, {
      quantity: 0, institutionPrice: null, institutionValue: 0, institutionPriceAsOf: null,
      costBasis: null, vestedQuantity: null, currency: null, isCash: false,
    });
    result.disappeared++;
  }

  // Derived brokerage-cash reconciliation — only when balance context is supplied
  // (both writers pass it). Runs AFTER position capture, from the same payload.
  if (params.accountBalance !== undefined) {
    const reconHoldings: ReconHolding[] = params.plaidHoldings.map((h) => {
      const sec = params.securitiesById[h.security_id];
      return {
        isCash:           sec ? isCashSecurity(sec) : false,
        institutionValue: h.institution_value ?? null,
        quantity:         h.quantity ?? null,
        institutionPrice: h.institution_price ?? null,
        currency:         h.iso_currency_code ?? sec?.iso_currency_code ?? null,
        priceAsOf:        parsePlaidDate(h.institution_price_as_of),
      };
    });
    const cash = await captureBrokerageCash({
      financialAccountId: params.financialAccountId,
      date: params.date,
      client,
      input: {
        accountBalance:  params.accountBalance,
        accountCurrency: params.accountCurrency ?? null,
        balanceAsOf:     params.balanceAsOf ?? null,
        holdings:        reconHoldings,
        payloadComplete: params.payloadComplete ?? true,
        captureDate:     params.date,
      },
    });
    result.brokerageCash = { status: cash.status, written: cash.written, residual: cash.residual, derivedCash: cash.derivedCash };
  }

  // A8-2 — same-day security close-price capture from THIS payload's securities
  // (basis RAW_CLOSE, source "plaid", dated by close_price_as_of). Flag-gated
  // (SECURITY_PRICES_ENABLED) and best-effort/non-fatal: a price-archive failure
  // never fails observation capture. Writes go through the price archive (its
  // own global-db path), independent of the observation write above.
  if (securityPriceCapturesEnabled() && securityByInstrument.size > 0) {
    try {
      result.securityPrices = await captureSecurityPrices({
        securities: [...securityByInstrument].map(([instrumentId, security]) => ({ instrumentId, security })),
        now: params.date,
      });
    } catch (priceErr) {
      console.warn(`[position-capture] security price capture failed (non-fatal): ${priceErr instanceof Error ? priceErr.message : priceErr}`);
    }
  }

  return result;
}

async function upsertObservation(
  client: Client,
  financialAccountId: string,
  instrumentId: string,
  date: Date,
  facts: ObservedFacts,
): Promise<void> {
  const data = {
    quantity:             facts.quantity,
    institutionPrice:     facts.institutionPrice,
    institutionValue:     facts.institutionValue,
    institutionPriceAsOf: facts.institutionPriceAsOf,
    costBasis:            facts.costBasis,
    vestedQuantity:       facts.vestedQuantity,
    currency:             facts.currency,
    isCash:               facts.isCash,
  };
  await client.positionObservation.upsert({
    where: {
      financialAccountId_instrumentId_date_origin_source: {
        financialAccountId, instrumentId, date, origin: PositionOrigin.OBSERVED, source: PLAID_PROVIDER,
      },
    },
    create: { financialAccountId, instrumentId, date, origin: PositionOrigin.OBSERVED, source: PLAID_PROVIDER, ...data },
    update: data,
  });
}

/** Truncate to UTC date (00:00:00) so all of a day's captures share one key. */
function normalizeDate(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
