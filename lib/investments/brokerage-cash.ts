/**
 * lib/investments/brokerage-cash.ts
 *
 * Derived brokerage-cash reconciliation (Investment Observation follow-up).
 *
 * Some investment accounts hold uninvested cash that Plaid does NOT return as
 * an explicit cash holding, yet the account balance exceeds the summed non-cash
 * positions. The residual is *possible* brokerage cash — but it must never be
 * labeled OBSERVED (Plaid did not report it). This module derives it only when
 * the evidence supports it, and refuses otherwise ("did the data earn this?").
 *
 *   account balance − Σ non-cash holding value − Σ observed cash = residual
 *
 * The core `reconcileBrokerageCash` is PURE (no Prisma). The DB binding
 * `captureBrokerageCash` writes a DERIVED PositionObservation only for the
 * DERIVED/ESTIMATED outcomes, reusing the Instrument/PositionObservation
 * foundation (origin: DERIVED; completeness distinguishes clean vs estimated).
 * No new schema — PositionOrigin.DERIVED and PositionObservation.completeness
 * already exist.
 */

import { PositionOrigin, type Prisma, type PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";

export const DERIVED_CASH_SOURCE = "account-balance-residual";
/** Provider namespace for the synthetic per-currency cash Instrument alias. */
const DERIVED_CASH_PROVIDER = "internal";

/** Default monetary tolerance (account currency units) — residuals within this reconcile to zero. */
export const DEFAULT_CASH_TOLERANCE = 1.0;
/** Prices older than this many days vs the capture date downgrade DERIVED → ESTIMATED. */
export const DEFAULT_STALE_DAYS = 4;

export type ReconciliationStatus =
  | "OBSERVED_CASH_PRESENT" // Plaid returned explicit cash — keep it, never derive
  | "DERIVED"               // clean positive residual from provider values
  | "ESTIMATED"             // positive residual but from weaker inputs (computed/stale)
  | "ZERO"                  // reconciles within tolerance — no synthetic cash
  | "NEGATIVE_RESIDUAL"     // balance < positions — margin/debit/stale; never positive cash
  | "INCOMPLETE"            // missing values / incomplete payload / no balance
  | "CURRENCY_MISMATCH";    // unlike currencies without a same-date FX conversion

export interface ReconHolding {
  isCash:           boolean;
  institutionValue: number | null;
  quantity:         number | null;
  institutionPrice: number | null;
  currency:         string | null;
  priceAsOf:        Date | null;
}

export interface ReconInput {
  accountBalance:  number | null;
  accountCurrency: string | null;
  balanceAsOf:     Date | null;
  holdings:        ReconHolding[];
  /** false when Plaid flagged is_investments_fallback_item (degraded coverage). */
  payloadComplete: boolean;
  captureDate:     Date;
  tolerance?:      number;
  staleDays?:      number;
}

export interface ReconResult {
  status:       ReconciliationStatus;
  residual:     number | null;
  derivedCash:  number; // 0 unless DERIVED/ESTIMATED
  /** Row completeness for a written observation; null when nothing is written. */
  completeness: "COMPLETE" | "PARTIAL" | null;
  reason:       string;
  inputTotals:  { nonCash: number; observedCash: number; computedValues: number; missingValues: number };
}

const MS_PER_DAY = 86_400_000;

/**
 * Pure reconciliation. Valuation order per non-cash holding:
 *   1. institution_value  2. quantity × institution_price  3. otherwise incomplete.
 * An explicit cash holding is NEVER counted in the non-cash total and always
 * short-circuits to OBSERVED_CASH_PRESENT (never derive a second cash row).
 */
export function reconcileBrokerageCash(input: ReconInput): ReconResult {
  const tol = input.tolerance ?? DEFAULT_CASH_TOLERANCE;
  const staleDays = input.staleDays ?? DEFAULT_STALE_DAYS;

  let nonCash = 0;
  let observedCash = 0;
  let computedValues = 0;
  let missingValues = 0;
  let currencyMismatch = false;
  let anyStale = false;

  for (const h of input.holdings) {
    // Currency check applies to every position that contributes to the total.
    if (h.currency && input.accountCurrency && h.currency !== input.accountCurrency) {
      currencyMismatch = true;
    }
    let value = h.institutionValue;
    let wasComputed = false;
    if (value == null && h.quantity != null && h.institutionPrice != null) {
      value = h.quantity * h.institutionPrice;
      wasComputed = true;
    }
    if (value == null) { missingValues++; continue; }
    if (wasComputed) computedValues++;
    if (h.priceAsOf && (input.captureDate.getTime() - h.priceAsOf.getTime()) > staleDays * MS_PER_DAY) {
      anyStale = true;
    }
    if (h.isCash) observedCash += value; else nonCash += value;
  }

  const totals = { nonCash, observedCash, computedValues, missingValues };
  const bal = input.accountBalance;
  const residual = bal == null ? null : bal - nonCash - observedCash;

  // 1. Explicit provider cash → keep it, never derive a second cash position.
  if (observedCash > 0) {
    return { status: "OBSERVED_CASH_PRESENT", residual, derivedCash: 0, completeness: null,
      reason: "Plaid reported explicit cash; reconciliation is validation-only.", inputTotals: totals };
  }

  // No provider cash — evaluate the derive path.
  if (currencyMismatch) {
    return { status: "CURRENCY_MISMATCH", residual, derivedCash: 0, completeness: null,
      reason: "Holdings span currencies unlike the account currency without a same-date FX conversion.", inputTotals: totals };
  }
  if (bal == null || missingValues > 0 || !input.payloadComplete) {
    return { status: "INCOMPLETE", residual, derivedCash: 0, completeness: null,
      reason: bal == null ? "No account balance available." : missingValues > 0
        ? `${missingValues} holding(s) missing a usable value.` : "Holdings payload incomplete (provider fallback).",
      inputTotals: totals };
  }
  if (residual != null && Math.abs(residual) <= tol) {
    return { status: "ZERO", residual, derivedCash: 0, completeness: null,
      reason: "Account reconciles within tolerance; no residual cash.", inputTotals: totals };
  }
  if (residual != null && residual < 0) {
    return { status: "NEGATIVE_RESIDUAL", residual, derivedCash: 0, completeness: null,
      reason: "Balance below summed positions — possible margin/debit or stale prices; no positive cash created.", inputTotals: totals };
  }

  // Positive residual above tolerance → derive cash. Weaker inputs → ESTIMATED.
  const estimated = computedValues > 0 || anyStale;
  return {
    status: estimated ? "ESTIMATED" : "DERIVED",
    residual,
    derivedCash: residual!,
    completeness: estimated ? "PARTIAL" : "COMPLETE",
    reason: estimated
      ? `Residual ${residual!.toFixed(2)} derived cash — weaker inputs (${computedValues} computed value(s)${anyStale ? ", stale price(s)" : ""}).`
      : `Residual ${residual!.toFixed(2)} derived cash from provider values.`,
    inputTotals: totals,
  };
}

// ─── DB binding ───────────────────────────────────────────────────────────────

type Client = PrismaClient | Prisma.TransactionClient;

/** Resolve (or create) the deployment-global synthetic cash Instrument for a currency. */
async function resolveDerivedCashInstrument(client: Client, currency: string): Promise<string> {
  const externalId = `cash:${currency}`;
  const alias = await client.instrumentAlias.findUnique({
    where: { provider_externalId: { provider: DERIVED_CASH_PROVIDER, externalId } },
    select: { instrumentId: true },
  });
  if (alias) return alias.instrumentId;
  const inst = await client.instrument.create({
    data: {
      tickerSymbol: `CUR:${currency}`, name: `${currency} cash`,
      assetClass: "CASH", currency, isCashEquivalent: true,
      aliases: { create: { provider: DERIVED_CASH_PROVIDER, externalId, metadata: { synthetic: true, kind: "derived-cash" } } },
    },
    select: { id: true },
  });
  return inst.id;
}

export interface CaptureBrokerageCashParams {
  financialAccountId: string;
  input: ReconInput;
  date: Date;
  client?: Client;
}

export interface CaptureBrokerageCashResult extends ReconResult {
  written: boolean;
}

/**
 * Run reconciliation for one account and persist a DERIVED cash observation only
 * when earned. Idempotent per (account, cash-instrument, date, DERIVED,
 * account-balance-residual). Never writes for OBSERVED/ZERO/NEGATIVE/INCOMPLETE/
 * CURRENCY_MISMATCH; the caller is expected to invoke this only after a
 * successful holdings capture, and to treat any throw as non-fatal.
 */
export async function captureBrokerageCash(params: CaptureBrokerageCashParams): Promise<CaptureBrokerageCashResult> {
  const client = params.client ?? db;
  const result = reconcileBrokerageCash(params.input);

  if (result.status !== "DERIVED" && result.status !== "ESTIMATED") {
    // Surface non-trivial unresolved residuals for diagnostics — never hidden,
    // never turned into cash.
    if (result.status === "NEGATIVE_RESIDUAL" || (result.status === "INCOMPLETE" && result.residual != null && Math.abs(result.residual) > (params.input.tolerance ?? DEFAULT_CASH_TOLERANCE))) {
      console.warn(`[brokerage-cash] ${result.status} for account ${params.financialAccountId} — residual=${result.residual?.toFixed(2)} (${result.reason})`);
    }
    return { ...result, written: false };
  }

  const currency = params.input.accountCurrency ?? "USD";
  const date = normalizeDate(params.date);
  const instrumentId = await resolveDerivedCashInstrument(client, currency);

  const data = {
    quantity: result.derivedCash, institutionPrice: 1, institutionValue: result.derivedCash,
    currency, isCash: true, completeness: result.completeness,
    evidenceRefs: { reason: result.reason, residual: result.residual, inputTotals: result.inputTotals } as Prisma.InputJsonValue,
  };
  await client.positionObservation.upsert({
    where: {
      financialAccountId_instrumentId_date_origin_source: {
        financialAccountId: params.financialAccountId, instrumentId, date,
        origin: PositionOrigin.DERIVED, source: DERIVED_CASH_SOURCE,
      },
    },
    create: { financialAccountId: params.financialAccountId, instrumentId, date, origin: PositionOrigin.DERIVED, source: DERIVED_CASH_SOURCE, ...data },
    update: data,
  });

  return { ...result, written: true };
}

function normalizeDate(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
