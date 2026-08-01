/**
 * lib/investments/quantity-authority.ts
 *
 * V26-QUANTITY-1G — the binding that lets historical valuation consult the
 * quantity authority, and records what it said.
 *
 * ── Modes ───────────────────────────────────────────────────────────────────
 *
 *   off      the authority is never loaded and never consulted. Zero queries,
 *            zero cost, byte-identical behaviour to before this slice. THE
 *            DEFAULT, including in production, so deploying this changes
 *            nothing until someone opts in.
 *   compare  both quantities are computed; the LEGACY one is used. A comparison
 *            that changes the thing it measures is not a comparison.
 *   adopt    the authority's quantity is used wherever it is sufficiently
 *            supported, and the legacy resolver is the explicit fallback
 *            everywhere else.
 *
 * Read from `QUANTITY_AUTHORITY_MODE`. An unrecognised value is treated as
 * `off` rather than as an error: a typo in an env var must not silently enable
 * an experimental money path, and must not take the app down either.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { loadQuantityTimelines } from "./quantity-timeline";
import type { QuantityTimeline } from "./quantity-replay.core";
import {
  decideQuantity, compareQuantities, quantityToUse,
  type QuantityAuthorityMode, type ComparisonRow, type QuantityDecision,
} from "./quantity-authority-bridge.core";

type Client = PrismaClient | Prisma.TransactionClient;

export function quantityAuthorityMode(): QuantityAuthorityMode {
  const raw = process.env.QUANTITY_AUTHORITY_MODE;
  return raw === "compare" || raw === "adopt" ? raw : "off";
}

/**
 * Timelines for one valuation run, plus the ledger of every decision made
 * against them.
 *
 * The ledger is in-memory and per-context. It is never persisted: this slice
 * observes valuation, it does not add a write path to it.
 */
export interface QuantityAuthorityContext {
  mode:      QuantityAuthorityMode;
  timelines: Map<string, QuantityTimeline>;
  ledger:    ComparisonRow[];
}

export function pairKey(financialAccountId: string, instrumentId: string): string {
  return `${financialAccountId}|${instrumentId}`;
}

const OFF: QuantityAuthorityContext = { mode: "off", timelines: new Map(), ledger: [] };

/**
 * Build a context for a valuation run over `dates` and `financialAccountIds`.
 *
 * The window is the requested date span — a caller decision, as everywhere else
 * in the arc. Returns the inert context when the mode is off, so no query is
 * issued and the caller needs no branch of its own.
 */
export async function buildQuantityAuthorityContext(args: {
  client:              Client;
  dates:               readonly string[];
  financialAccountIds: readonly string[];
  mode?:               QuantityAuthorityMode;
}): Promise<QuantityAuthorityContext> {
  const mode = args.mode ?? quantityAuthorityMode();
  if (mode === "off" || args.dates.length === 0 || args.financialAccountIds.length === 0) return OFF;

  const sorted = [...new Set(args.dates)].sort();
  const results = await loadQuantityTimelines({
    financialAccountIds: [...new Set(args.financialAccountIds)],
    windowFromISO: sorted[0],
    windowToISO: sorted[sorted.length - 1],
    client: args.client,
  });

  const timelines = new Map<string, QuantityTimeline>();
  for (const r of results) {
    if (r.instrumentId === null) continue;   // cash rows carry no instrument pair
    timelines.set(pairKey(r.financialAccountId, r.instrumentId), r.timeline);
  }
  return { mode, timelines, ledger: [] };
}

/**
 * Consult the authority for one (pair, date) and record the comparison.
 *
 * Returns the quantity valuation should USE. In `compare` that is always the
 * legacy value; the authority's opinion still lands in the ledger.
 */
export function consultQuantityAuthority(args: {
  ctx:                QuantityAuthorityContext;
  dateISO:            string;
  financialAccountId: string;
  instrumentId:       string;
  legacyQuantity:     number | null;
}): { quantity: number | null; usedAuthority: boolean; decision: QuantityDecision } {
  const { ctx } = args;
  if (ctx.mode === "off") {
    const decision: QuantityDecision = {
      source: "LEGACY", reason: "AUTHORITY_DISABLED",
      detail: "QUANTITY_AUTHORITY_MODE is off",
    };
    return { quantity: args.legacyQuantity, usedAuthority: false, decision };
  }

  const timeline = ctx.timelines.get(pairKey(args.financialAccountId, args.instrumentId));
  const decision = decideQuantity(timeline, args.dateISO);

  ctx.ledger.push(compareQuantities({
    dateISO: args.dateISO,
    financialAccountId: args.financialAccountId,
    instrumentId: args.instrumentId,
    legacyQuantity: args.legacyQuantity,
    decision,
  }));

  const used = quantityToUse(ctx.mode, args.legacyQuantity, decision);
  return { ...used, decision };
}
