/**
 * lib/investments/historical-point-detail.ts
 *
 * V26-S3-DETAIL — THE canonical answer to "what is this chart point made of?"
 *
 * ── The rule this module exists to enforce ───────────────────────────────────
 * A breakdown that disagrees with the point it explains is worse than no
 * breakdown: it teaches the user to distrust both. So this composes ONLY the
 * authorities that produced the stored point, and then CHECKS that it did:
 *
 *   historicalHoldingsForWindow  the investment holdings — the same call, with
 *                                the same arguments, that snapshot regeneration
 *                                makes. Not a re-implementation.
 *   valueCryptoDay               the same shared crypto day valuation the
 *                                regenerator uses for the `crypto` column.
 *   classifyAccounts             the same FX path every stored total went
 *                                through. No second currency interpretation.
 *
 * and then compares Σ components against the STORED value. If they do not agree
 * within the canonical tolerance the detail is REFUSED
 * (`HISTORICAL_COMPOSITION_UNAVAILABLE`) with a diagnostic delta for logs and
 * tests. There is deliberately no "best effort" middle ground.
 *
 * ── Which total this explains ────────────────────────────────────────────────
 * The INVESTMENTS chart, whose value is `stocks + crypto` — two disjoint
 * buckets, each asset once (portfolio-series.ts). Banking cash, savings and debt
 * are NOT part of that total and are deliberately absent here; a future Net
 * Worth drill-down can reuse this evidence model, but mixing its components into
 * an Investments breakdown would produce a number the chart never showed.
 *
 * BROKERAGE cash is different and IS included: a cash position inside an
 * investment account is part of `stocks`, arrives through the same
 * PositionObservation spine as every other holding, and is one of the holdings
 * the point is made of.
 *
 * READ-ONLY. Nothing here writes.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { classifyAccounts } from "@/lib/account-classifier";
import { buildSpaceConversionContextById } from "@/lib/money/server-context";
import { historicalHoldingsForWindow } from "./historical-holdings";
import type { HeldHolding, ExcludedHolding } from "./historical-holdings.core";
import { valueCryptoDay, type CryptoDayValuation } from "@/lib/crypto/historical-crypto-valuation.core";
import { licenseConstantQuantityCarry } from "@/lib/crypto/quantity-carry.core";
import { reconcileWalletLedger } from "@/lib/crypto/ledger-completeness.core";
import { readBtcUsdWindow } from "@/lib/crypto/btc-price";
import { resolveCryptoValuationState, isCryptoAssertable } from "@/lib/snapshots/crypto-valuation-status.core";
import { SettlementState } from "@prisma/client";

type Client = PrismaClient | Prisma.TransactionClient;

/**
 * Reporting-currency tolerance for the reconciliation. One cent: the stored
 * totals are rounded currency amounts, so anything larger is a real
 * disagreement, not float noise.
 */
export const COMPOSITION_TOLERANCE = 0.01;

/** The one refusal a consumer may render. */
export const HISTORICAL_COMPOSITION_UNAVAILABLE = "HISTORICAL_COMPOSITION_UNAVAILABLE";

/** One row of the breakdown, already explained — no arithmetic left for a view. */
export interface PointComponent {
  kind:         "investment" | "crypto";
  accountId:    string;
  accountName:  string;
  instrumentId: string | null;
  symbol:       string | null;
  name:         string | null;
  assetClass:   string;
  isCash:       boolean;
  quantity:     number | null;
  /** Provenance of the quantity, as the engine graded it. */
  quantityTier: string;
  ownership:      "KNOWN" | "POSSIBLE" | null;
  ownershipSince: string | null;
  ownershipUntil: string | null;
  unitPrice:    number | null;
  priceDate:    string | null;
  priceSource:  string | null;
  priceBasis:   string | null;
  /** Reporting-currency value; null when the engine could not value it. */
  value:        number | null;
  /** Why it is unvalued / how it was valued. Never assembled by a view. */
  reason:       string;
}

/** A component that did NOT exist on the date, with a coded reason. */
export interface PointExcluded {
  accountId:    string;
  accountName:  string;
  instrumentId: string;
  symbol:       string | null;
  reasonCode:   string;
  explanation:  string;
}

export interface HistoricalPointDetail {
  dateISO: string;
  reportingCurrency: string;
  /** The value the chart displays for this date (stocks + crypto). */
  chartValue: number;
  /** Σ component values, in the reporting currency. */
  componentTotal: number;
  /** chartValue − componentTotal. */
  delta: number;
  /** True only when |delta| ≤ COMPOSITION_TOLERANCE. */
  reconciled: boolean;
  /** Set when `reconciled` is false — the ONLY thing a view may render then. */
  refusal: typeof HISTORICAL_COMPOSITION_UNAVAILABLE | null;
  /** Machine-readable cause, for logs and tests. Never user-facing prose. */
  diagnostic: string | null;
  components: PointComponent[];
  excluded:   PointExcluded[];
  /** How many holdings the engine valued. */
  valuedCount: number;
  /** How many holdings EXISTED on this date — the historical denominator. */
  heldCount: number;
  /** Whether this row's crypto component may be asserted at all. */
  cryptoAssertable: boolean;
  cryptoRefusal: CryptoDayValuation["refusal"];
  /** The snapshot's own recorded completeness tier, when it has one. */
  completenessTier: string | null;
}

export interface HistoricalPointDetailArgs {
  spaceId: string;
  dateISO: string;
  client?: Client;
}

/** A date with no stored row cannot be explained — there is no point to explain. */
function noPoint(dateISO: string, reportingCurrency: string, diagnostic: string): HistoricalPointDetail {
  return {
    dateISO, reportingCurrency, chartValue: 0, componentTotal: 0, delta: 0,
    reconciled: false, refusal: HISTORICAL_COMPOSITION_UNAVAILABLE, diagnostic,
    components: [], excluded: [], valuedCount: 0, heldCount: 0,
    cryptoAssertable: false, cryptoRefusal: null, completenessTier: null,
  };
}

/**
 * Explain one historical Investments chart point.
 *
 * Every number returned comes from the authority that produced the stored row.
 * The reconciliation is not a formality: it is the only thing standing between a
 * user and a breakdown that quietly disagrees with the line above it.
 */
export async function getHistoricalPointDetail(
  args: HistoricalPointDetailArgs,
): Promise<HistoricalPointDetail> {
  const client = args.client ?? db;
  const { spaceId, dateISO } = args;

  const space = await client.space.findUnique({
    where: { id: spaceId }, select: { reportingCurrency: true },
  });
  const reportingCurrency = space?.reportingCurrency ?? "USD";

  const snapshot = await client.spaceSnapshot.findUnique({
    where:  { spaceId_date: { spaceId, date: new Date(`${dateISO}T00:00:00.000Z`) } },
    select: {
      stocks: true, crypto: true, isEstimated: true, completenessTier: true, date: true,
      cryptoValuationStatus: true, reportingCurrency: true,
    },
  });
  if (!snapshot) return noPoint(dateISO, reportingCurrency, `no stored snapshot for ${dateISO}`);

  // V26-CRYPTO-STATUS — may this row's crypto be asserted at all? Read from the
  // canonical interpreter; never re-derived from a price floor here.
  const cryptoState = resolveCryptoValuationState({
    isEstimated: snapshot.isEstimated,
    crypto: snapshot.crypto,
    cryptoValuationStatus: snapshot.cryptoValuationStatus,
  });
  const cryptoAssertable = isCryptoAssertable(cryptoState);

  // ── Investments: the SAME call regeneration makes, with the same arguments ──
  const holdingsByDate = await historicalHoldingsForWindow({
    spaceId, dates: [dateISO], client,
    holdConstantBeforeEarliest: true,
    excludeDigitalAssetAccounts: true,
    // No ceiling passed — DERIVED, so this resolves the identical windows the
    // regenerator did. Passing `dateISO` here silently lost every holding whose
    // first direct evidence postdates the drilled date.
  });
  const holdings = holdingsByDate.get(dateISO);

  // ── Display identity for the held instruments ─────────────────────────────
  const instrumentIds = [...new Set([
    ...(holdings?.held ?? []).map((h) => h.instrumentId),
    ...(holdings?.excluded ?? []).map((h) => h.instrumentId),
  ])];
  const [instruments, accounts] = await Promise.all([
    client.instrument.findMany({
      where: { id: { in: instrumentIds } },
      select: { id: true, tickerSymbol: true, name: true, assetClass: true, isCashEquivalent: true },
    }),
    client.financialAccount.findMany({
      where: { spaceAccountLinks: { some: { spaceId, revokedAt: null } }, deletedAt: null },
      // `lastUpdated` is the date `nativeBalance` was OBSERVED — the anchor the
      // constant-quantity carry is licensed FROM. The regenerator uses exactly
      // this field; using anything else (a clock, "today") would silently
      // license a different interval.
      select: { id: true, name: true, type: true, nativeBalance: true, lastUpdated: true },
    }),
  ]);
  const inst = new Map(instruments.map((i) => [i.id, i]));
  const acct = new Map(accounts.map((a) => [a.id, a]));

  const components: PointComponent[] = [];
  for (const h of (holdings?.held ?? []) as HeldHolding[]) {
    const i = inst.get(h.instrumentId);
    components.push({
      kind: "investment",
      accountId:   h.financialAccountId,
      accountName: acct.get(h.financialAccountId)?.name ?? "Account",
      instrumentId: h.instrumentId,
      symbol: i?.tickerSymbol ?? null,
      name:   i?.name ?? null,
      assetClass: i?.assetClass ?? "UNKNOWN",
      isCash: i?.isCashEquivalent === true,
      quantity: h.quantity,
      quantityTier: h.tier,
      ownership: h.ownership,
      ownershipSince: h.ownershipFromISO,
      ownershipUntil: h.ownershipToISO,
      // The unit price is recoverable from the valuation the engine already did;
      // a view must never divide value by quantity to get one.
      unitPrice: h.reportingValue != null && h.quantity ? h.reportingValue / h.quantity : null,
      priceDate: null, priceSource: null, priceBasis: null,
      value: h.reportingValue,
      reason: h.reason,
    });
  }

  const excluded: PointExcluded[] = ((holdings?.excluded ?? []) as ExcludedHolding[]).map((e) => ({
    accountId:   e.financialAccountId,
    accountName: acct.get(e.financialAccountId)?.name ?? "Account",
    instrumentId: e.instrumentId,
    symbol: inst.get(e.instrumentId)?.tickerSymbol ?? null,
    reasonCode: e.reasonCode,
    explanation: e.explanation,
  }));

  // ── Crypto: the SAME shared day valuation the regenerator uses ─────────────
  const cryptoAccounts = accounts.filter((a) => a.type === "crypto" && a.nativeBalance != null);
  let crypto: CryptoDayValuation = { positions: [], nativeTotal: 0, positionCount: 0, licensed: false, refusal: null };
  if (cryptoAccounts.length > 0) {
    const btcAt = await readBtcUsdWindow(dateISO, dateISO);
    const movementRows = await client.transaction.findMany({
      where: {
        financialAccountId: { in: cryptoAccounts.map((a) => a.id) },
        currency: "BTC", deletedAt: null, settlementState: SettlementState.POSTED,
      },
      select: { financialAccountId: true, date: true, amount: true },
    });
    const licensed = cryptoAccounts.every((a) => {
      const mine = movementRows.filter((r) => r.financialAccountId === a.id);
      const ledger = reconcileWalletLedger({
        observedBalance: a.nativeBalance ?? null, movements: mine.map((r) => r.amount),
      });
      return licenseConstantQuantityCarry({
        targetISO: dateISO,
        anchorISO: a.lastUpdated ? a.lastUpdated.toISOString().slice(0, 10) : null,
        eventDatesISO: mine.map((r) => r.date.toISOString().slice(0, 10)),
        ledgerComplete: ledger.complete,
      }).licensed;
    });
    crypto = valueCryptoDay({
      accounts: cryptoAccounts.map((a) => ({
        financialAccountId: a.id, name: a.name, nativeBalance: a.nativeBalance, symbol: "BTC",
      })),
      unitPrice: btcAt(dateISO),
      quantityLicensed: licensed,
    });
  }

  // FX through the SAME path every stored total used.
  const ctx = await buildSpaceConversionContextById(spaceId, { currencies: ["USD"], dates: [dateISO] });
  for (const p of crypto.positions) {
    const converted = classifyAccounts(
      [{ type: "crypto", balance: p.nativeValue, currency: "USD" }], ctx, dateISO,
    ).totalDigitalAssets;
    components.push({
      kind: "crypto",
      accountId: p.financialAccountId, accountName: p.accountName,
      instrumentId: null, symbol: p.symbol, name: p.symbol,
      assetClass: "CRYPTO", isCash: false,
      quantity: p.quantity, quantityTier: "estimated",
      ownership: "KNOWN", ownershipSince: null, ownershipUntil: null,
      unitPrice: p.unitPrice, priceDate: dateISO, priceSource: "coingecko", priceBasis: "RAW_CLOSE",
      value: cryptoAssertable ? converted : null,
      reason: cryptoAssertable
        ? `Valued at the ${dateISO} close on a constant-quantity carry licensed by a reconciled wallet ledger.`
        : "This day's crypto valuation may not be asserted.",
    });
  }

  // ── Reconciliation against the STORED point ───────────────────────────────
  const chartValue = snapshot.stocks + (cryptoAssertable ? snapshot.crypto : 0);
  const componentTotal = components.reduce((n, c) => n + (c.value ?? 0), 0);
  const delta = round2(chartValue - componentTotal);
  const reconciled = Math.abs(delta) <= COMPOSITION_TOLERANCE;

  return {
    dateISO,
    reportingCurrency: snapshot.reportingCurrency ?? reportingCurrency,
    chartValue: round2(chartValue),
    componentTotal: round2(componentTotal),
    delta,
    reconciled,
    refusal: reconciled ? null : HISTORICAL_COMPOSITION_UNAVAILABLE,
    diagnostic: reconciled ? null
      : `component total ${round2(componentTotal)} != stored ${round2(chartValue)} (delta ${delta}); ` +
        `investments=${holdings?.valuedCount ?? 0}/${holdings?.heldCount ?? 0} ` +
        `cryptoLicensed=${crypto.licensed} cryptoAssertable=${cryptoAssertable} ` +
        // A FROZEN row is an immutable observation of what balances said that
        // day — the reconstruction engine did not produce it and cannot explain
        // it. That is an expected refusal, not an engine divergence, and it must
        // be distinguishable from one in a log.
        `cause=${snapshot.isEstimated ? "ENGINE_DIVERGENCE" : "FROZEN_OBSERVED_ROW"}`,
    components,
    excluded,
    valuedCount: (holdings?.valuedCount ?? 0) + (cryptoAssertable ? crypto.positionCount : 0),
    heldCount:   (holdings?.heldCount ?? 0) + crypto.positionCount,
    cryptoAssertable,
    cryptoRefusal: crypto.refusal,
    completenessTier: snapshot.completenessTier,
  };
}

/** Reporting-currency rounding — the repository's canonical two-decimal money policy. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
