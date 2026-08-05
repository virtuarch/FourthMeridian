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
import { loadHoldingOwnership, holdingKey } from "./holding-ownership";
import type { HeldHolding, ExcludedHolding } from "./historical-holdings.core";
import { valueCryptoDay, type CryptoDayValuation } from "@/lib/crypto/historical-crypto-valuation.core";
import { licenseConstantQuantityCarry } from "@/lib/crypto/quantity-carry.core";
import { reconcileWalletLedger } from "@/lib/crypto/ledger-completeness.core";
import { readBtcUsdWindow } from "@/lib/crypto/btc-price";
import { resolveCryptoValuationState, isCryptoAssertable } from "@/lib/snapshots/crypto-valuation-status.core";
import { SettlementState } from "@prisma/client";
import {
  COMPUTED_TOLERANCE, observedTolerance as observedTol, round2 as round2Shared,
  type ReconciliationState,
} from "@/lib/perspective-engine/reconciliation.core";

type Client = PrismaClient | Prisma.TransactionClient;

/**
 * v2.6-A — the reconciliation vocabulary now lives in ONE pure module
 * (lib/perspective-engine/reconciliation.core.ts) because aggregate
 * authorisation needed it too, and a database binding is the wrong place to
 * declare a vocabulary. Re-exported here so every existing consumer of these
 * names is unaffected; the values and semantics are identical.
 */
export {
  COMPUTED_TOLERANCE as COMPOSITION_TOLERANCE,
  observedTolerance,
  RECONCILIATION_STATES as COMPOSITION_STATES,
  type ReconciliationState as CompositionState,
} from "@/lib/perspective-engine/reconciliation.core";

export const HISTORICAL_COMPOSITION_UNAVAILABLE = "HISTORICAL_COMPOSITION_UNAVAILABLE";
export const HISTORICAL_COMPOSITION_CONTRADICTORY = "HISTORICAL_COMPOSITION_CONTRADICTORY";

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
  /** The reconciliation outcome. `reconciled` is kept as its boolean shorthand. */
  state: ReconciliationState;
  /** True for EXACT and PARTIALLY_ATTRIBUTED — i.e. a breakdown may render. */
  reconciled: boolean;
  /**
   * V26-S4 — the part of an OBSERVED total the component evidence does not
   * allocate to any holding. Positive by construction and present ONLY in
   * PARTIALLY_ATTRIBUTED.
   *
   * It is defined as `observed total − explained assertable components` and
   * NOTHING else. It is not cash, not a gain, not a missing holding and not a
   * market move; naming it as any of those would invent an asset out of a
   * subtraction. A view may show the number and say what it is arithmetically.
   */
  unattributed: number | null;
  /** Share of the displayed total the components explain, 0..1. */
  explainedFraction: number;
  /** True when the displayed total is an OBSERVATION rather than a computation. */
  observedTotal: boolean;
  /** Set for CONTRADICTORY / UNAVAILABLE — the only thing a view may render then. */
  refusal: typeof HISTORICAL_COMPOSITION_UNAVAILABLE | typeof HISTORICAL_COMPOSITION_CONTRADICTORY | null;
  /** Machine-readable cause, for logs and tests. Never user-facing prose. */
  diagnostic: string | null;
  components: PointComponent[];
  excluded:   PointExcluded[];
  /** How many holdings the engine valued. */
  valuedCount: number;
  /** How many holdings EXISTED on this date — the historical denominator. */
  heldCount: number;
  /** V26-S4 — why every OTHER known instrument is not in the primary panel. */
  scope: HistoricalScope;
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
    state: "UNAVAILABLE", reconciled: false, unattributed: null, explainedFraction: 0,
    observedTotal: false, refusal: HISTORICAL_COMPOSITION_UNAVAILABLE, diagnostic,
    components: [], excluded: [], valuedCount: 0, heldCount: 0,
    scope: emptyScope(),
    cryptoAssertable: false, cryptoRefusal: null, completenessTier: null,
  };
}

/**
 * V26-S4 — WHY THE OTHER INSTRUMENTS ARE NOT IN THE PANEL.
 *
 * The primary panel is a photograph of one date: held-and-valued, plus
 * held-but-unavailable. Everything else is absent for a REASON, and a reader who
 * knows they once owned AMZN deserves to learn it had already been sold rather
 * than to wonder whether the engine lost it.
 *
 * Counts by category, not a wall of tickers. Only the first two contribute to
 * the denominator; that is what makes the denominator historical.
 */
export interface HistoricalScope {
  heldValued:         number;
  heldUnavailable:    number;
  notYetOwned:        number;
  alreadyClosed:      number;
  ownershipUncertain: number;
  excludedArtifact:   number;
  /** Per-category tickers, for the expandable detail. Never rendered by default. */
  detail: { category: string; symbol: string | null; accountName: string; explanation: string }[];
}

function emptyScope(): HistoricalScope {
  return {
    heldValued: 0, heldUnavailable: 0, notYetOwned: 0, alreadyClosed: 0,
    ownershipUncertain: 0, excludedArtifact: 0, detail: [],
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

  // ── Crypto ────────────────────────────────────────────────────────────────
  //
  // V26-S4 — A FROZEN ROW'S CRYPTO IS AN OBSERVATION, NOT A RECOMPUTATION.
  //
  // The evidence order for a frozen date (Part 1) puts exact-date observations
  // ahead of reconstruction, and for crypto the observation IS the stored
  // `crypto` column: the app recorded the wallet's value directly at capture,
  // from the live spot price of that moment. Recomputing it from the archived
  // daily close answers a different question and gives a different number —
  // measured on 2026-07-20, $15,661.85 against a recorded $15,516.70, a $145.15
  // gap that made the whole point refuse.
  //
  // Investments need no such special case: `resolvePositionAsOf` already prefers
  // an exact-date OBSERVED row, and `valueInstrumentAsOf` values it at the
  // institution's own stated value. Measured across the frozen rows, that
  // reproduces the stored `stocks` figure to the cent on six of eight dates and
  // to within $0.31 on the rest. The canonical engine was already right; only
  // crypto had no observation to prefer.
  const cryptoAccounts = accounts.filter((a) => a.type === "crypto" && a.nativeBalance != null);
  let crypto: CryptoDayValuation = { positions: [], nativeTotal: 0, positionCount: 0, licensed: false, refusal: null };
  const observedTotalRow = !snapshot.isEstimated;

  if (cryptoAccounts.length > 0 && !observedTotalRow) {
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

  // The OBSERVED crypto component for a frozen row.
  //
  // Emitted per wallet ONLY when there is exactly one — splitting a recorded
  // aggregate across several wallets by quantity share would be an invented
  // allocation, and this module invents nothing. With several wallets it is one
  // honest "Digital assets" line carrying the recorded total.
  if (cryptoAccounts.length > 0 && observedTotalRow && Math.abs(snapshot.crypto) > 0) {
    const single = cryptoAccounts.length === 1 ? cryptoAccounts[0] : null;
    const observedQty = single
      ? (await client.positionObservation.findFirst({
          where: { financialAccountId: single.id, date: { lte: new Date(`${dateISO}T00:00:00.000Z`) }, deletedAt: null, supersededById: null },
          orderBy: { date: "desc" }, select: { quantity: true },
        }))?.quantity ?? single.nativeBalance ?? null
      : null;
    components.push({
      kind: "crypto",
      accountId: single?.id ?? "digital-assets",
      accountName: single?.name ?? "Digital assets",
      instrumentId: null, symbol: single ? "BTC" : null, name: single ? "BTC" : "Digital assets",
      assetClass: "CRYPTO", isCash: false,
      quantity: observedQty, quantityTier: "observed",
      ownership: "KNOWN", ownershipSince: null, ownershipUntil: null,
      unitPrice: null, priceDate: dateISO, priceSource: null, priceBasis: null,
      value: snapshot.crypto,
      reason: `Recorded directly on ${dateISO} when this day's balances were captured.`,
    });
    crypto = { ...crypto, positionCount: cryptoAccounts.length, licensed: true, refusal: null };
  }

  // ── Historical scope: why every OTHER instrument is absent ────────────────
  const scope = emptyScope();
  for (const h of (holdings?.held ?? [])) {
    if (h.reportingValue != null) scope.heldValued++; else scope.heldUnavailable++;
  }
  for (const e of ((holdings?.excluded ?? []) as ExcludedHolding[])) {
    const i = inst.get(e.instrumentId);
    // A provider TRANSFER ARTIFACT is not a position anyone held. Plaid invents
    // an instrument per journal/transfer ("Journal to …764"), classified EQUITY
    // with no ticker; listing those beside real holdings would be noise dressed
    // as evidence.
    const artifact = !i?.tickerSymbol;
    const category = artifact ? "EXCLUDED_ARTIFACT"
      : e.reasonCode === "NOT_YET_OWNED"      ? "NOT_YET_OWNED"
      : e.reasonCode === "OWNERSHIP_CLOSED"   ? "ALREADY_CLOSED"
      : "OWNERSHIP_UNCERTAIN";
    if (category === "EXCLUDED_ARTIFACT")      scope.excludedArtifact++;
    else if (category === "NOT_YET_OWNED")     scope.notYetOwned++;
    else if (category === "ALREADY_CLOSED")    scope.alreadyClosed++;
    else                                       scope.ownershipUncertain++;
    scope.detail.push({
      category,
      symbol: i?.tickerSymbol ?? null,
      accountName: acct.get(e.financialAccountId)?.name ?? "Account",
      explanation: e.explanation,
    });
  }
  // V26-S4 — PAIRS THE VALUATION ENGINE NEVER EMITTED.
  //
  // A position with a proven ZERO quantity is dropped by the valuation binding
  // before it becomes a component, so it never reaches the holdings builder and
  // could not be categorised. That is exactly the set a reader most wants
  // explained — "where did the nine positions I sold go?" — and its absence made
  // the scope silently understate what had happened on that date.
  //
  // Resolved through the SAME ownership authority the holdings query uses, never
  // a second model: any (account, instrument) pair the accounts own evidence for
  // that did NOT appear above is categorised from its window alone.
  const seenPairs = new Set<string>([
    ...(holdings?.held ?? []).map((h) => holdingKey(h.financialAccountId, h.instrumentId)),
    ...(holdings?.excluded ?? []).map((h) => holdingKey(h.financialAccountId, h.instrumentId)),
  ]);
  // Digital-asset accounts are DELIBERATELY absent from this scan: their
  // positions are the crypto component above, and scanning them again would
  // list BTC as an unexplained absence directly beneath the BTC holding it is.
  //
  // The ceiling is the account set's own latest evidence, NOT the drilled date —
  // the same rule the holdings query follows, and for the same reason: a
  // per-date ceiling discards windows whose first evidence postdates it and
  // would report every such pair as "uncertain" when it is simply later.
  const scopeAccountIds = accounts.filter((a) => a.type !== "crypto").map((a) => a.id);
  const scopeCeiling = [dateISO, ...accounts.map((a) => a.lastUpdated?.toISOString().slice(0, 10) ?? dateISO)]
    .reduce((max, d) => (d > max ? d : max));
  const allOwnership = await loadHoldingOwnership(scopeAccountIds, scopeCeiling, client);
  const missingInstrumentIds = [...allOwnership.values()]
    .filter((o) => !seenPairs.has(holdingKey(o.financialAccountId, o.instrumentId)))
    .map((o) => o.instrumentId);
  const missingInst = missingInstrumentIds.length > 0
    ? new Map((await client.instrument.findMany({
        where: { id: { in: [...new Set(missingInstrumentIds)] } },
        select: { id: true, tickerSymbol: true },
      })).map((i) => [i.id, i]))
    : new Map<string, { id: string; tickerSymbol: string | null }>();

  for (const o of allOwnership.values()) {
    const key = holdingKey(o.financialAccountId, o.instrumentId);
    if (seenPairs.has(key)) continue;
    const ticker = missingInst.get(o.instrumentId)?.tickerSymbol ?? null;
    const closed = o.closedFromISO !== null && dateISO >= o.closedFromISO;
    const opens = o.resolution.kind === "resolved" && o.resolution.segments.length > 0
      ? o.resolution.segments[0].fromISO : null;
    const category = !ticker ? "EXCLUDED_ARTIFACT"
      : closed ? "ALREADY_CLOSED"
      : opens !== null && dateISO < opens ? "NOT_YET_OWNED"
      : "OWNERSHIP_UNCERTAIN";
    if (category === "EXCLUDED_ARTIFACT")   scope.excludedArtifact++;
    else if (category === "ALREADY_CLOSED") scope.alreadyClosed++;
    else if (category === "NOT_YET_OWNED")  scope.notYetOwned++;
    else                                    scope.ownershipUncertain++;
    scope.detail.push({
      category, symbol: ticker,
      accountName: acct.get(o.financialAccountId)?.name ?? "Account",
      explanation: closed
        ? `Not held on ${dateISO}: an observation on ${o.closedFromISO} states this position was closed.`
        : opens !== null && dateISO < opens
          ? `Not held on ${dateISO}: this position was first held on ${opens}.`
          : `Not held on ${dateISO}: no ownership evidence reaches this date.`,
    });
  }

  scope.detail.sort((a, b) => a.category.localeCompare(b.category) || (a.symbol ?? "").localeCompare(b.symbol ?? ""));

  // ── Reconciliation against the STORED point ───────────────────────────────
  //
  // V26-S4 — FOUR OUTCOMES, NOT A BOOLEAN.
  //
  // The Slice-3 rule was "match exactly or show nothing", and for a frozen row
  // that made the most recent — and most interesting — dates the least useful to
  // click. A frozen row means the app RECORDED the total directly and will not
  // overwrite it. It does not mean nothing can be said about what was in it.
  //
  //   EXACT                 components account for the total within tolerance
  //   PARTIALLY_ATTRIBUTED  components fall SHORT of an OBSERVED total; the
  //                         remainder is stated as unallocated, never as an asset
  //   CONTRADICTORY         the evidence disagrees with itself — refused outright
  //   UNAVAILABLE           too little evidence to say anything useful
  //
  // PARTIALLY_ATTRIBUTED is available ONLY for an observed total. On a
  // reconstructed row the stored figure IS this composition's own output, so a
  // shortfall is not "unattributed observation" — it means the stored row was
  // written by an older engine and is stale. Calling that a remainder would
  // dress a stale number as evidence.
  const chartValue = snapshot.stocks + (cryptoAssertable ? snapshot.crypto : 0);
  const componentTotal = components.reduce((n, c) => n + (c.value ?? 0), 0);
  const delta = round2(chartValue - componentTotal);
  const tolerance = observedTotalRow ? observedTol(chartValue) : COMPUTED_TOLERANCE;

  // ── Contradiction checks, before any friendly outcome ─────────────────────
  const contradictions: string[] = [];

  // Components EXCEEDING the total would require a NEGATIVE unattributed amount.
  if (delta < -tolerance) {
    contradictions.push(`components exceed the total by ${round2(-delta)}`);
  }
  // One holding counted twice is double counting, whatever the sum says.
  const pairSeen = new Set<string>();
  for (const c of components) {
    if (c.instrumentId == null) continue;
    const k = `${c.accountId}|${c.instrumentId}`;
    if (pairSeen.has(k)) contradictions.push(`duplicate component for ${c.symbol ?? c.instrumentId}`);
    pairSeen.add(k);
  }
  // A component valued in another currency cannot be summed into this total.
  const rowCurrency = snapshot.reportingCurrency ?? reportingCurrency;
  if (rowCurrency !== reportingCurrency) {
    contradictions.push(`row currency ${rowCurrency} differs from the Space's ${reportingCurrency}`);
  }

  let state: ReconciliationState;
  if (contradictions.length > 0) {
    state = "CONTRADICTORY";
  } else if (Math.abs(delta) <= tolerance) {
    state = "EXACT";
  } else if (observedTotalRow && delta > 0 && components.length > 0) {
    state = "PARTIALLY_ATTRIBUTED";
  } else if (components.length === 0) {
    state = "UNAVAILABLE";
  } else {
    // A reconstructed row that no longer matches its own composition: stale.
    state = "UNAVAILABLE";
  }

  const reconciled = state === "EXACT" || state === "PARTIALLY_ATTRIBUTED";
  const unattributed = state === "PARTIALLY_ATTRIBUTED" ? delta : null;
  const explainedFraction = chartValue === 0 ? (componentTotal === 0 ? 1 : 0)
    : Math.max(0, Math.min(1, componentTotal / chartValue));

  return {
    dateISO,
    reportingCurrency: rowCurrency,
    chartValue: round2(chartValue),
    componentTotal: round2(componentTotal),
    delta,
    state,
    reconciled,
    unattributed,
    explainedFraction,
    observedTotal: observedTotalRow,
    refusal: state === "CONTRADICTORY" ? HISTORICAL_COMPOSITION_CONTRADICTORY
      : state === "UNAVAILABLE" ? HISTORICAL_COMPOSITION_UNAVAILABLE : null,
    diagnostic: reconciled && state === "EXACT" ? null
      : `state=${state} components=${round2(componentTotal)} stored=${round2(chartValue)} delta=${delta} ` +
        `tolerance=${round2(tolerance)} totalIsObserved=${observedTotalRow} ` +
        `investments=${holdings?.valuedCount ?? 0}/${holdings?.heldCount ?? 0} ` +
        `cryptoLicensed=${crypto.licensed} cryptoAssertable=${cryptoAssertable}` +
        (contradictions.length ? ` contradictions=[${contradictions.join("; ")}]` : ""),
    components,
    excluded,
    valuedCount: (holdings?.valuedCount ?? 0) + (cryptoAssertable && crypto.licensed ? crypto.positionCount : 0),
    heldCount:   (holdings?.heldCount ?? 0) + crypto.positionCount,
    scope,
    cryptoAssertable,
    cryptoRefusal: crypto.refusal,
    completenessTier: snapshot.completenessTier,
  };
}

/** Reporting-currency rounding — the ONE canonical two-decimal policy. */
const round2 = round2Shared;
