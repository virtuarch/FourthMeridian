/**
 * lib/investments/reconstruction-read.ts
 *
 * A4-4 — the reconstruction READ MODEL (A4-owned, lib-only). Surfaces the
 * honesty state of each reconstructed position and the historical quantity-as-of
 * read path, WITHOUT valuation, prices, or any UI. The Investments-perspective
 * badge wiring (B4) is a later slice gated on A5-S4 and the shell conventions —
 * it consumes these DTOs; this file only produces them, so it touches no
 * components, no SpaceDashboard, no lib/data.
 *
 * Two honest surfaces:
 *   1. describeReconstruction — a PositionReconstruction summary → a name-free,
 *      user-facing honesty line + the canonical trust tier. Derived history is
 *      never described as observed; an unexplained opening is always stated.
 *   2. resolvePositionAsOf — the latest non-superseded position row ≤ a date,
 *      picked by origin precedence (OBSERVED > IMPORTED > DERIVED > USER_ASSERTED)
 *      and stamped with its trust tier (plan §3.3 / §6.1). Quantities only.
 *
 * The pure functions carry the logic (fixture-tested); the DB bindings are thin
 * reads validated on real data after merge.
 */

import { PositionOrigin, type Prisma, type PrismaClient, type ReconstructionStatus } from "@prisma/client";
import { db } from "@/lib/db";
import type { CompletenessTier } from "@/lib/perspective-engine/types";

type Client = PrismaClient | Prisma.TransactionClient;

// ── Honesty description (pure) ────────────────────────────────────────────────

/** The reconstruction summary fields the read model needs. Serialisable. */
export interface ReconstructionSummaryView {
  instrumentId:               string;
  observedCurrentQuantity:    number;
  openingQuantity:            number;
  unexplainedOpeningQuantity: number;
  earliestDefensibleDate:     string; // YYYY-MM-DD
  reconciliation:             ReconstructionStatus;
  completeness:               CompletenessTier;
  conflicted:                 boolean;
}

/** One position's honesty state, ready for a badge/label consumer (B4). */
export interface PositionHonesty extends ReconstructionSummaryView {
  symbol: string | null;
  name:   string | null;
  /** Non-negative rounded residual, or 0. */
  unexplained: number;
  hasUnexplainedOpening: boolean;
  /** User-facing, name-free honesty line. Never styles derived history as observed. */
  label: string;
}

/** Trim a share quantity for display without fabricating precision. */
function fmtQty(q: number): string {
  const r = Math.round(q * 1e4) / 1e4;
  return Number.isInteger(r) ? String(r) : String(r);
}

/**
 * Deterministic, name-free honesty line for a reconstruction summary. Conflict
 * is surfaced first (it blocks trusting the number); then the job outcome. The
 * copy is user-facing but neutral — a UI may restyle it, never downgrade its
 * honesty (derived history is never presented as an observed fact).
 */
export function describeReconstruction(s: ReconstructionSummaryView): string {
  const unexplained = Math.max(0, Math.round(s.unexplainedOpeningQuantity * 1e4) / 1e4);
  if (s.conflicted) {
    return "Sources disagree about this position's history — needs review.";
  }
  if (s.reconciliation === "FAILED") {
    return `History stops at ${s.earliestDefensibleDate}; earlier holdings can't be reconstructed from available events.`;
  }
  if (s.reconciliation === "PARTIAL" && unexplained > 0) {
    return `${fmtQty(unexplained)} shares were already held before your history begins on ${s.earliestDefensibleDate}.`;
  }
  if (s.reconciliation === "PARTIAL") {
    return `Partially reconstructed back to ${s.earliestDefensibleDate}.`;
  }
  return `Reconstructed from your transaction history back to ${s.earliestDefensibleDate}.`;
}

/** Compose the full honesty DTO from a summary + instrument display fields. */
export function toPositionHonesty(
  s: ReconstructionSummaryView,
  instrument: { symbol: string | null; name: string | null },
): PositionHonesty {
  const unexplained = Math.max(0, Math.round(s.unexplainedOpeningQuantity * 1e4) / 1e4);
  return {
    ...s,
    symbol: instrument.symbol,
    name: instrument.name,
    unexplained,
    hasUnexplainedOpening: unexplained > 0,
    label: describeReconstruction(s),
  };
}

// ── Position-as-of resolution (pure) ─────────────────────────────────────────

/** A candidate position row for as-of resolution. */
export interface PositionRow {
  date:         string;         // YYYY-MM-DD
  quantity:     number;
  origin:       PositionOrigin;
  completeness: string | null;  // canonical tier on DERIVED rows; null otherwise
}

export interface PositionAsOf {
  quantity: number | null;      // null ⇒ no row covers this date (incomplete)
  date:     string | null;      // the resolved row's date
  origin:   PositionOrigin | null;
  tier:     CompletenessTier;   // worst-honest tier for the resolved row
}

/** Origin precedence for "what did the account hold on date D" (plan §3.3). */
const ORIGIN_RANK: Record<PositionOrigin, number> = {
  OBSERVED: 0,
  IMPORTED: 1,
  DERIVED: 2,
  USER_ASSERTED: 3,
};

function tierForRow(row: PositionRow): CompletenessTier {
  switch (row.origin) {
    case PositionOrigin.OBSERVED:
    case PositionOrigin.IMPORTED:
    case PositionOrigin.USER_ASSERTED:
      return "observed";
    case PositionOrigin.DERIVED:
      // A DERIVED reconstruction row carries its own canonical tier.
      return row.completeness === "incomplete" ? "incomplete" : "derived";
    default:
      return "unknown";
  }
}

/**
 * The position quantity as-of a date: the latest non-superseded row on or before
 * `asOf`, choosing the strongest origin on a tie (OBSERVED > IMPORTED > DERIVED >
 * USER_ASSERTED). No row ≤ asOf ⇒ incomplete (a gap, never a fabricated 0). Pure.
 */
export function resolvePositionAsOf(rows: PositionRow[], asOf: string): PositionAsOf {
  let best: PositionRow | null = null;
  for (const row of rows) {
    if (row.date > asOf) continue;
    if (
      best === null ||
      row.date > best.date ||
      (row.date === best.date && ORIGIN_RANK[row.origin] < ORIGIN_RANK[best.origin])
    ) {
      best = row;
    }
  }
  if (!best) return { quantity: null, date: null, origin: null, tier: "incomplete" };
  return { quantity: best.quantity, date: best.date, origin: best.origin, tier: tierForRow(best) };
}

// ── DB bindings (thin reads) ─────────────────────────────────────────────────

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Every reconstructed position for an account, as honesty DTOs. Read-only over
 * A4's own PositionReconstruction summaries + the Instrument display fields.
 * Visibility is inherited via financialAccountId (the account is already gated
 * upstream); this read introduces no new visibility surface.
 */
export async function getPositionReconstructions(
  financialAccountId: string,
  client: Client = db,
): Promise<PositionHonesty[]> {
  const rows = await client.positionReconstruction.findMany({
    where:   { financialAccountId },
    include: { instrument: { select: { tickerSymbol: true, name: true } } },
    orderBy: { instrumentId: "asc" },
  });
  return rows.map((r) =>
    toPositionHonesty(
      {
        instrumentId: r.instrumentId,
        observedCurrentQuantity: r.observedCurrentQuantity,
        openingQuantity: r.openingQuantity,
        unexplainedOpeningQuantity: r.unexplainedOpeningQuantity,
        earliestDefensibleDate: ymd(r.earliestDefensibleDate),
        reconciliation: r.reconciliation,
        completeness: (r.completeness as CompletenessTier),
        conflicted: r.conflicted,
      },
      { symbol: r.instrument.tickerSymbol, name: r.instrument.name },
    ),
  );
}

/**
 * The reconstructed/observed quantity of one position as-of a date. Reads all
 * non-superseded PositionObservation rows for the (account, instrument) up to
 * `asOf` and resolves the strongest. Quantities only — no valuation.
 */
export async function getPositionQuantityAsOf(
  financialAccountId: string,
  instrumentId: string,
  asOf: string,
  client: Client = db,
): Promise<PositionAsOf> {
  const rows = await client.positionObservation.findMany({
    // A7-1 — exclude rolled-back imported rows (deletedAt set) from as-of
    // resolution; existing rows have deletedAt null, so behavior is unchanged
    // until an import is rolled back.
    where:   { financialAccountId, instrumentId, supersededById: null, deletedAt: null, date: { lte: new Date(`${asOf}T00:00:00.000Z`) } },
    select:  { date: true, quantity: true, origin: true, completeness: true },
  });
  return resolvePositionAsOf(
    rows.map((r) => ({ date: ymd(r.date), quantity: r.quantity, origin: r.origin, completeness: r.completeness })),
    asOf,
  );
}
