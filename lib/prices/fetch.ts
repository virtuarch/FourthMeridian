/**
 * lib/prices/fetch.ts
 *
 * A8-3A — fetch orchestration (clone of lib/fx/fetch.ts). Pure orchestration, NO
 * persistence: callers (scripts/backfill-security-prices.ts, jobs/fetch-security-
 * prices.ts) store the result via priceArchive.writeBatch — this module never
 * touches the database.
 *
 * V26-PRICE-PROVIDER-UNIFICATION — routing is by DECLARED CAPABILITY, not by
 * position. The registry resolves exactly ONE provider for an instrument
 * (resolveProviderForInstrument) and this module asks only that one. The former
 * contract walked the list and took the first adapter that returned usable data,
 * which made routing an accident of registration order and let a vendor hiccup
 * silently substitute a different source — invisible afterwards, since
 * PriceObservation records `source` but never why.
 *
 * The trade-off is deliberate and worth stating: cross-adapter FAILOVER IS GONE.
 * An adapter that errors no longer hands off to another; the window simply
 * yields no rows and coverage still reports the dates as missing, so the next
 * run retries. Nothing is fabricated and nothing is silently re-sourced. Today
 * the capable sets are disjoint (equities/ETFs vs crypto), so no instrument had
 * a second provider to fall back to in any case.
 *
 * Contract:
 *   - One instrument + one basis + one CLOSED-date window per call.
 *   - Resolve ONE provider from declared capability; ask only that provider.
 *   - No capable provider → source null, noted. A REMOVED adapter therefore
 *     produces a stated unsupported outcome, never an accidental hand-off.
 *   - Two capable providers → source null, noted as ambiguous. A configuration
 *     defect is reported, not resolved by position.
 *   - Adapter failure (throw, bad shape, off-window/off-instrument/off-basis row,
 *     non-positive price) → the whole batch is discarded and noted. Partial
 *     answers are never merged.
 *   - An adapter legitimately returning [] (no data for this instrument/window,
 *     e.g. a delisted tail) is "no data", not a failure — continue.
 *   - Deterministic: same registry + same adapter responses → same result.
 *   - NEVER interpolates: absent trading days simply do not appear.
 */

import { assertISODate } from "./config";
import { resolveProviderForInstrument } from "./registry";
import { classifyThrown, type ProviderOutcome } from "./provider-errors";
import type { PriceFetchRequest, PriceRegistry, PriceResult } from "./types";

export interface InstrumentFetchResult {
  instrumentId: string;
  basis:   PriceFetchRequest["basis"];
  fromISO: string;
  toISO:   string;
  /** Winning adapter, or null when no adapter produced data for this window. */
  source:  string | null;
  /**
   * V26-PRICE-4 — the classified outcome. `source === null` alone cannot tell a
   * throttled run from a delisted tail, and those need opposite responses.
   */
  outcome: ProviderOutcome;
  /** Validated rows from the winning adapter ([] when source is null). */
  rows:    PriceResult[];
  /** Per-adapter notes in registry order (skips + failures), for progress output. */
  notes:   string[];
}

/** Batch validation: every row on-instrument, on-basis, in-window, positive-finite. */
function validateBatch(rows: PriceResult[], req: PriceFetchRequest): void {
  for (const r of rows) {
    assertISODate(r.dateISO);
    if (r.instrumentId !== req.instrumentId) throw new Error(`off-instrument row ${r.instrumentId}`);
    if (r.basis !== req.basis) throw new Error(`off-basis row ${r.basis} (want ${req.basis})`);
    if (r.dateISO < req.fromISO || r.dateISO > req.toISO) throw new Error(`off-window row ${r.dateISO}`);
    if (!Number.isFinite(r.price) || r.price <= 0) throw new Error(`invalid price for ${r.dateISO}`);
    if (!r.currency) throw new Error(`missing currency for ${r.dateISO}`);
  }
}

/**
 * Fetch one instrument's closed daily closes over [fromISO, toISO] on one basis
 * through the registry's failover chain. No persistence — the caller writes the
 * returned rows via the archive.
 */
export async function fetchInstrumentWindow(
  req: PriceFetchRequest,
  registry: PriceRegistry,
): Promise<InstrumentFetchResult> {
  assertISODate(req.fromISO);
  assertISODate(req.toISO);
  const base: Omit<InstrumentFetchResult, "source" | "rows" | "notes" | "outcome"> = {
    instrumentId: req.instrumentId, basis: req.basis, fromISO: req.fromISO, toISO: req.toISO,
  };
  const notes: string[] = [];

  const resolution = resolveProviderForInstrument(registry, {
    assetClass:     req.assetClass,
    providerSymbol: req.providerSymbol,
    basis:          req.basis,
  });

  if (resolution.kind === "unsupported") {
    notes.push(
      `no capable provider for assetClass=${req.assetClass} symbol="${req.providerSymbol}" ` +
      `basis=${req.basis} (considered: ${resolution.sourcesConsidered.join(", ") || "none registered"})`,
    );
    return { ...base, source: null, outcome: "UNSUPPORTED", rows: [], notes };
  }
  if (resolution.kind === "ambiguous") {
    // Reported, never resolved by position — see the header.
    notes.push(
      `AMBIGUOUS ROUTING — ${resolution.sources.join(", ")} all declare capability for ` +
      `assetClass=${req.assetClass} symbol="${req.providerSymbol}"; refusing to guess`,
    );
    return { ...base, source: null, outcome: "UNSUPPORTED", rows: [], notes };
  }

  const adapter = resolution.adapter;

  let rows: PriceResult[];
  try {
    rows = await adapter.fetchDailyCloses(req);
  } catch (e) {
    const outcome = classifyThrown(e);
    notes.push(`${adapter.source}: ${outcome} — ${e instanceof Error ? e.message : String(e)}`);
    return { ...base, source: null, outcome, rows: [], notes };
  }

  if (rows.length === 0) {
    // An empty answer is EXPLICABLE when the window predates what this vendor
    // can serve, and suspicious when it does not. Collapsing both into "no data"
    // hides a vendor that has quietly stopped answering.
    const outcome: ProviderOutcome = req.toISO < adapter.historicalDepth ? "NO_DATA" : "EMPTY_RESPONSE";
    notes.push(`${adapter.source}: ${outcome} for ${req.instrumentId} in [${req.fromISO}, ${req.toISO}]` +
      (outcome === "NO_DATA" ? ` (before depth ${adapter.historicalDepth})` : ""));
    return { ...base, source: null, outcome, rows: [], notes };
  }

  try {
    validateBatch(rows, req);
  } catch (e) {
    notes.push(`${adapter.source}: INVALID_DATA — ${e instanceof Error ? e.message : String(e)}`);
    return { ...base, source: null, outcome: "INVALID_DATA", rows: [], notes };
  }

  return { ...base, source: adapter.source, outcome: "OK", rows, notes };
}
