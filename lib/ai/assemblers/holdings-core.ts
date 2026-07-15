/**
 * lib/ai/assemblers/holdings-core.ts
 *
 * PURE assembly for the AI 'holdings_summary' domain (P2-4). No DB, no clock, no
 * network — fixture-testable. This is the half of the holdings assembler that
 * shapes the HoldingsSummaryData payload from already-read inputs; the DB binding
 * (holdings.ts) gathers those inputs from the CANONICAL investment truth spine and
 * calls in here.
 *
 * ── The canonical cutover (P2-4) ─────────────────────────────────────────────
 * FULL-visibility position DETAIL now comes from `getCurrentPositions({spaceId})`
 * (the A10-at-today seam; visibility enforced INSIDE it — see current-positions.ts),
 * NOT from a legacy `Holding` read with the visibility branch re-implemented here.
 * The all-visibility aggregate VALUE (which legitimately includes the value of
 * BALANCE_ONLY / SUMMARY_ONLY accounts while withholding their positions) comes
 * from the canonical `getInvestmentValueAsOf({visibilityScope:"all"})` path.
 *
 * Crypto (BTC wallets) rides in through the SHARED, crypto-only transitional
 * reader `lib/investments/legacy-crypto-holdings.ts`
 * (`readLegacyCryptoWalletPositions`, walletChain-gated, FULL-detail) — the SAME
 * bridge the data Export uses (P2-5) — dropped entirely once P2-6 completes.
 *
 * CANONICAL WINS (P2-4 convergence): P2-6 now ALSO writes BTC wallet balances to
 * the PositionObservation spine, so a wallet can be present in BOTH sources. To
 * avoid double-counting, the binding (holdings.ts) excludes from the bridge any
 * custody account already represented in the canonical `getCurrentPositions` rows
 * (`excludeCanonicalCryptoAccounts`, keyed by FinancialAccount identity — NOT by
 * asset symbol). A wallet already on the spine is supplied ONCE by canonical; a
 * wallet not yet on the spine is supplied ONCE by the bridge.
 *
 * ── Privacy invariant ────────────────────────────────────────────────────────
 * This module only ever SEES FULL-visibility position rows (`fullRows`, from the
 * detail-eligible seam) and FULL crypto positions. Non-FULL accounts contribute
 * ONLY aggregate value (`allScope`) — never a symbol, name, quantity, or
 * per-position value. The hidden non-cash value is disclosed via
 * `positionsPartiallyHidden` + a dataLimits note, never leaked as detail.
 *
 * ── Concentration parity ─────────────────────────────────────────────────────
 * Concentration is computed over the FULL non-cash rows aggregated PER INSTRUMENT
 * (exactly as investments-allocation-core.ts::computeAllocation does) and run
 * through the SAME lib/investments/concentration.ts helper — so on a spine-only
 * FULL fixture the AI number and the Investments Allocation number are identical.
 * OFF-spine crypto positions ONLY are blended into the AI concentration (on-spine
 * wallets are excluded from the bridge upstream — canonical wins — so no wallet is
 * counted twice; they must not be silently dropped either, since the plain payload
 * has no separate crypto block) — a transitional divergence from the spine-only UI
 * that disappears at P2-6, and is disclosed in dataLimits.
 */

import { computeConcentration } from "@/lib/investments/concentration";
import type {
  HoldingsSummaryData,
  HoldingPosition,
} from "@/lib/ai/types";

/** The subset of a canonical CurrentPositionRow this core consumes (FULL detail). */
export interface CanonicalPositionRow {
  instrumentId:   string;
  symbol:         string | null;
  name:           string | null;
  /** reporting-currency value; null ⇒ unvalued (excluded from totals & concentration). */
  reportingValue: number | null;
  isCash:         boolean;
}

/**
 * The all-visibility aggregate from the canonical `getInvestmentValueAsOf("all")`
 * path — the ONE place a non-FULL account's value legitimately enters (value only,
 * never detail).
 */
export interface AllScopeAggregate {
  /** Σ reportingValue over VALUED components, ALL visibility levels (spine). */
  valuedSubtotal: number;
  /** Σ reportingValue over VALUED cash components, ALL visibility levels (spine). */
  cashValue:      number;
  /** any component's FX was estimated (walked-back / missing rate). */
  anyFxEstimated: boolean;
  /** any component present at all (spine has investment observations in scope). */
  hasAny:         boolean;
}

/**
 * The TRANSITIONAL crypto compatibility input (from readLegacyCryptoWalletPositions,
 * FULL-visibility, walletChain-gated). All monetary fields already converted into
 * the reporting currency. FULL-only by construction — non-FULL wallet detail AND
 * value are not read (the canonical bridge is FULL-detail; a rare non-FULL shared
 * wallet's value is simply absent until P2-6, never leaked).
 */
export interface CryptoHoldingsInput {
  /** total FULL crypto value (reporting currency). */
  total:    number;
  /** non-cash FULL crypto value. */
  invested: number;
  /** cash FULL crypto value (normally 0 — crypto is not cash). */
  cash:     number;
  /** FULL, non-cash crypto positions, aggregated by symbol. */
  fullPositions: ReadonlyArray<{ symbol: string; name: string; value: number }>;
  /** any crypto value conversion was estimated. */
  anyEstimated:  boolean;
  /** any crypto holding present at all. */
  hasAny:        boolean;
}

/**
 * CANONICAL WINS — exclude legacy-bridge crypto positions whose custody account is
 * ALREADY represented on the canonical position spine. The dedup boundary is the
 * FinancialAccount (custody) identity, NOT the asset symbol: two DIFFERENT BTC
 * wallets both remain valid positions, but the SAME wallet can never be counted
 * from both `getCurrentPositions` and the legacy Holding bridge. Pure; the caller
 * (holdings.ts) supplies the canonical account-id set from getCurrentPositions().rows.
 */
export function excludeCanonicalCryptoAccounts<T extends { financialAccountId: string }>(
  bridgePositions:     readonly T[],
  canonicalAccountIds: ReadonlySet<string>,
): T[] {
  return bridgePositions.filter((p) => !canonicalAccountIds.has(p.financialAccountId));
}

const EPS = 1e-6;

/** Maximum number of top positions surfaced in the context payload. */
export const HOLDINGS_TOP_N = 10;

/** The base guardrails: what this value-only summary deliberately does not answer. */
function baseDataLimits(): string[] {
  return [
    // Cost basis is captured on the spine but deliberately NOT surfaced here;
    // gains/returns are out of scope for this value-based summary.
    "Cost basis is not surfaced here — unrealized/realized gains are not computed.",
    "No returns or performance metrics in this summary.",
    "Asset-class and sector breakdown are not included in this summary.",
  ];
}

/**
 * Shape the HoldingsSummaryData payload from canonical inputs. PURE.
 * Returns null when there is nothing to report (no spine positions and no crypto).
 */
export function buildHoldingsSummary(args: {
  scopeHint: "full" | "brief";
  /** FULL-visibility detail rows from getCurrentPositions (visibility enforced upstream). */
  fullRows:  readonly CanonicalPositionRow[];
  allScope:  AllScopeAggregate;
  crypto:    CryptoHoldingsInput;
}): HoldingsSummaryData | null {
  const { scopeHint, fullRows, allScope, crypto } = args;

  // Domain cleanly empty — no observations in scope and no crypto.
  if (!allScope.hasAny && !crypto.hasAny) return null;

  // ── Aggregate totals (all visibility; spine value + FULL crypto value) ──────
  const allInvestedSpine = allScope.valuedSubtotal - allScope.cashValue;
  const totalPortfolioValue = allScope.valuedSubtotal + crypto.total;
  const cashValue           = allScope.cashValue + crypto.cash;
  const investedValue       = allInvestedSpine + crypto.invested;
  const totalsEstimated     = allScope.anyFxEstimated || crypto.anyEstimated;
  const cashPct = totalPortfolioValue > 0 ? cashValue / totalPortfolioValue : 0;

  // ── FULL detail → concentration ─────────────────────────────────────────────
  // Spine rows aggregate PER INSTRUMENT (VTI in two brokerages collapses to one
  // weighted position — same as the Allocation panel, giving byte-identical
  // concentration on a spine-only fixture). Off-spine crypto rides on a disjoint
  // key so it is not silently dropped (removed at P2-6).
  const byKey = new Map<string, { symbol: string | null; name: string | null; value: number }>();
  let fullSpineInvestedNonCash = 0;
  let unvaluedFullCount = 0;
  for (const r of fullRows) {
    if (r.reportingValue == null) { unvaluedFullCount++; continue; }
    if (r.isCash) continue;
    fullSpineInvestedNonCash += r.reportingValue;
    const b = byKey.get(r.instrumentId) ?? { symbol: r.symbol ?? r.name ?? null, name: r.name ?? r.symbol ?? null, value: 0 };
    b.value += r.reportingValue;
    byKey.set(r.instrumentId, b);
  }
  for (const cp of crypto.fullPositions) {
    const key = `crypto:${cp.symbol}`;
    const b = byKey.get(key) ?? { symbol: cp.symbol, name: cp.name, value: 0 };
    b.value += cp.value;
    byKey.set(key, b);
  }

  const analyzedInvestedValue = [...byKey.values()].reduce((s, p) => s + p.value, 0);

  // Concentration input: value-descending, weight relative to analyzedInvestedValue —
  // the EXACT contract computeConcentration + computeAllocation share.
  const concentrationPositions = [...byKey.values()]
    .map((p) => ({
      symbol: p.symbol,
      weight: analyzedInvestedValue > 0 ? p.value / analyzedInvestedValue : 0,
      value:  p.value,
    }))
    .sort((a, b) => b.value - a.value);
  const concentration = computeConcentration(concentrationPositions, analyzedInvestedValue);

  const rankedPositions: HoldingPosition[] = [...byKey.values()]
    .map((p): HoldingPosition => ({
      symbol: p.symbol ?? p.name ?? "—",
      name:   p.name ?? p.symbol ?? "—",
      value:  p.value,
      weight: analyzedInvestedValue > 0 ? p.value / analyzedInvestedValue : 0,
    }))
    .sort((a, b) => b.value - a.value);

  // ── Partial-visibility disclosure (non-cash spine value withheld) ───────────
  const positionsPartiallyHidden = allInvestedSpine - fullSpineInvestedNonCash > EPS;

  // ── dataLimits (honest caveats; the LLM must not infer hidden composition) ───
  const dataLimits = baseDataLimits();
  if (positionsPartiallyHidden) {
    dataLimits.push(
      "Some accounts are shared below full visibility; their individual positions " +
      "are excluded from position and concentration analysis (their value is still " +
      "counted in the totals).",
    );
  }
  if (unvaluedFullCount > 0) {
    dataLimits.push(
      `${unvaluedFullCount} position(s) could not be valued and are excluded from ` +
      "the value totals — treat the totals as a subtotal, not the whole.",
    );
  }
  if (crypto.hasAny) {
    dataLimits.push(
      "Crypto positions are included from wallet balances (value only) and are not " +
      "yet on the investment history spine.",
    );
  }

  const data: HoldingsSummaryData = {
    totalPortfolioValue,
    investedValue,
    cashValue,
    totalsEstimated,
    cashPct,
    positionCount: rankedPositions.length,
    analyzedInvestedValue,
    positionsPartiallyHidden,
    concentration,
    dataLimits,
    // topPositions omitted for the Daily Brief aggregator to keep payload lean.
    ...(scopeHint !== "brief"
      ? { topPositions: rankedPositions.slice(0, HOLDINGS_TOP_N) }
      : {}),
  };
  return data;
}
