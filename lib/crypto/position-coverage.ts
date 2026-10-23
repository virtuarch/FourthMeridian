/**
 * lib/crypto/position-coverage.ts
 *
 * W6b — COVERAGE IS A LICENCE, AND A ROW IS NOT ONE.
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 * `ChainCoverage` (./chain-movement.ts) already decides whether an acquisition
 * may claim it saw everything and over which interval. It was computed at sync
 * time, used to drive the replay, returned to the caller — and then discarded.
 * Nothing survived except the rows the replay happened to write.
 *
 * So every later question about temporal licence was answered by row presence:
 * "a row exists on or before this date, therefore its quantity may represent
 * this date". W6 bounded that carry at the first and last row, which was an
 * improvement and still the wrong authority. It only looked right because this
 * replay writes one row per licensed day — an implementation detail. A sparse
 * representation with a licensed interval is equally valid and would have been
 * mis-resolved in both directions: refused inside coverage, permitted outside it.
 *
 * The architecture this restores:
 *
 *     evidence + coverage → as-of quantity        (not: daily rows → coverage)
 *
 * ── Two independent questions ───────────────────────────────────────────────
 * A resolver must answer BOTH before it may return a number:
 *
 *   1. What is the latest defensible quantity on or before this date?  (rows)
 *   2. Is that quantity licensed to REPRESENT this date?               (coverage)
 *
 * Neither implies the other. A row can exist beyond the licensed edge — a
 * current OBSERVED balance sitting months after the last reconstructed day is
 * exactly that — and coverage can license an interval the rows describe only
 * sparsely.
 *
 * ── No second vocabulary ────────────────────────────────────────────────────
 * This module persists and reads the EXISTING `ChainCoverage` union. It invents
 * no kinds, no bounds and no caveats of its own, and it makes no acquisition
 * decisions: whoever computed the coverage owns what it says.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import type { ChainCoverage, ChainCoverageCaveat } from "./chain-movement";

type Client = PrismaClient | Prisma.TransactionClient;

/** The STORED vocabulary — exactly the `ChainCoverage` discriminants. */
export const COVERAGE_KINDS = ["COMPLETE", "PARTIAL", "UNKNOWN"] as const;
export type CoverageKind = (typeof COVERAGE_KINDS)[number];

/** Write-time guard, mirroring `isCompletenessTier` / `isCryptoValuationStatus`. */
export function isCoverageKind(value: unknown): value is CoverageKind {
  return typeof value === "string" && (COVERAGE_KINDS as readonly string[]).includes(value);
}

/**
 * Caveats that make an interval UNLICENSABLE however well the arithmetic closes.
 *
 * The same list `licenseCoverageByReconciliation` refuses to upgrade past, for
 * the same reason: a run that knows it stopped early — budget exhausted, archive
 * floor reached, provider refused — cannot have its silence read as evidence of
 * absence. Kept here as the single exported constant so the acquisition-time
 * upgrade and the read-time licence can never disagree about which caveats bite.
 */
export const BLOCKING_CAVEATS: readonly ChainCoverageCaveat[] = [
  "PAGE_BUDGET_EXHAUSTED",
  "ARCHIVE_DEPTH_LIMIT",
  "PROVIDER_THROTTLED",
  "PROVIDER_ERROR",
  "INVALID_DATA",
  "NO_PROVIDER_CONFIGURED",
];

/** Does this coverage carry a caveat that forbids licensing any interval? */
export function hasBlockingCaveat(coverage: ChainCoverage): boolean {
  if (coverage.kind === "COMPLETE") return false;
  return coverage.caveats.some((c) => BLOCKING_CAVEATS.includes(c));
}

/**
 * The interval this coverage licenses, or null when it licenses nothing.
 *
 * UNKNOWN licenses nothing — that is what it means. PARTIAL licenses only what
 * it proved, and an OPEN edge (`null`) is unproven, not unbounded: a coverage
 * that cannot say where it started may not be carried backward from wherever
 * its first row happens to sit.
 */
export function licensedInterval(coverage: ChainCoverage): { fromISO: string; toISO: string } | null {
  if (hasBlockingCaveat(coverage)) return null;
  if (coverage.kind === "COMPLETE") return { fromISO: coverage.fromISO, toISO: coverage.toISO };
  if (coverage.kind === "PARTIAL") {
    if (coverage.coveredFromISO === null || coverage.coveredToISO === null) return null;
    return { fromISO: coverage.coveredFromISO, toISO: coverage.coveredToISO };
  }
  return null;
}

/**
 * Why a date has no licensed quantity. Distinguishing these is the point: they
 * are three different answers a consumer must be able to tell apart, and none
 * of them is zero.
 */
export type LicenceRefusal =
  /** Earlier than any licensed interval — the wallet is not placed here at all. */
  | "BEFORE_FIRST_DEFENSIBLE_ANCHOR"
  /** Later than the licensed edge. The wallet exists; this date is not proven. */
  | "BEYOND_LICENSED_COVERAGE"
  /** Coverage exists but licenses nothing — UNKNOWN, or a blocking caveat. */
  | "COVERAGE_UNLICENSED"
  /** No coverage record at all. Row presence alone may never stand in for one. */
  | "NO_COVERAGE_RECORD";

export interface LicensedQuantity {
  /** Native units, or null when nothing is licensed. NULL IS UNKNOWN — never 0. */
  quantity: number | null;
  /** The date of the evidence actually used, when one was. */
  evidenceDateISO: string | null;
  /** Null when a quantity was licensed; otherwise why not. */
  refusal: LicenceRefusal | null;
}

/** The minimum a caller must supply per dated observation. */
export interface CoverageResolvableRow {
  dateISO:  string;
  quantity: number;
}

/**
 * THE resolver: evidence + coverage → as-of quantity.
 *
 * `rows` need not be dense. Inside a licensed interval the latest row on or
 * before the date is carried forward, because the coverage — not the row
 * spacing — is what says nothing happened in between. Outside the interval no
 * row licenses anything, however close it sits.
 *
 * Deliberately pure and deliberately NOT a position-precedence authority: the
 * caller resolves origin precedence (`resolvePositionAsOf`) and hands the winner
 * per date, or hands raw rows for a single origin. This decides licence only.
 */
export function resolveLicensedQuantityAsOf(
  rows: readonly CoverageResolvableRow[],
  coverage: ChainCoverage | null,
  asOfISO: string,
): LicensedQuantity {
  if (coverage === null) {
    return { quantity: null, evidenceDateISO: null, refusal: "NO_COVERAGE_RECORD" };
  }
  const interval = licensedInterval(coverage);
  if (interval === null) {
    return { quantity: null, evidenceDateISO: null, refusal: "COVERAGE_UNLICENSED" };
  }
  if (asOfISO < interval.fromISO) {
    return { quantity: null, evidenceDateISO: null, refusal: "BEFORE_FIRST_DEFENSIBLE_ANCHOR" };
  }
  if (asOfISO > interval.toISO) {
    return { quantity: null, evidenceDateISO: null, refusal: "BEYOND_LICENSED_COVERAGE" };
  }

  // Inside the licence. Carry the latest evidence on or before the date — never
  // the nearest overall, which would let a later observation reach backward.
  let best: CoverageResolvableRow | null = null;
  for (const r of rows) {
    if (r.dateISO > asOfISO) continue;
    if (best === null || r.dateISO > best.dateISO) best = r;
  }
  if (best === null) {
    // Licensed, but no evidence reaches the date. The licence says nothing
    // happened; it does not say what was held before anything was recorded.
    return { quantity: null, evidenceDateISO: null, refusal: "BEFORE_FIRST_DEFENSIBLE_ANCHOR" };
  }
  return { quantity: best.quantity, evidenceDateISO: best.dateISO, refusal: null };
}

// ── Persistence ──────────────────────────────────────────────────────────────

const isoOf = (d: Date): string => d.toISOString().slice(0, 10);
const dateOf = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

/** Write the coverage an acquisition computed. One live row per position. */
export async function persistPositionCoverage(
  client: Client,
  financialAccountId: string,
  instrumentId: string,
  coverage: ChainCoverage,
): Promise<void> {
  if (!isCoverageKind(coverage.kind)) {
    throw new Error(`refusing to persist an unknown coverage kind: ${String(coverage.kind)}`);
  }
  const interval = coverage.kind === "COMPLETE"
    ? { fromISO: coverage.fromISO, toISO: coverage.toISO }
    : coverage.kind === "PARTIAL"
      ? { fromISO: coverage.coveredFromISO, toISO: coverage.coveredToISO }
      : { fromISO: null, toISO: null };
  const caveats = coverage.kind === "COMPLETE" ? [] : [...coverage.caveats];

  const data = {
    kind:            coverage.kind,
    coveredFromDate: interval.fromISO ? dateOf(interval.fromISO) : null,
    coveredToDate:   interval.toISO ? dateOf(interval.toISO) : null,
    caveats,
    source:          coverage.source,
    computedAt:      new Date(),
  };

  await client.positionCoverage.upsert({
    where:  { financialAccountId_instrumentId: { financialAccountId, instrumentId } },
    create: { financialAccountId, instrumentId, ...data },
    update: data,
  });
}

/** Read the persisted coverage back into the canonical union, keyed by account. */
export async function loadPositionCoverage(
  client: Client,
  financialAccountIds: readonly string[],
): Promise<Map<string, ChainCoverage>> {
  const out = new Map<string, ChainCoverage>();
  if (financialAccountIds.length === 0) return out;

  const rows = await client.positionCoverage.findMany({
    where:  { financialAccountId: { in: [...financialAccountIds] } },
    select: {
      financialAccountId: true, kind: true, coveredFromDate: true,
      coveredToDate: true, caveats: true, source: true,
    },
  });

  for (const r of rows) {
    const caveats = r.caveats as ChainCoverageCaveat[];
    if (r.kind === "COMPLETE" && r.coveredFromDate && r.coveredToDate) {
      out.set(r.financialAccountId, {
        kind: "COMPLETE", fromISO: isoOf(r.coveredFromDate), toISO: isoOf(r.coveredToDate), source: r.source,
      });
      continue;
    }
    if (r.kind === "PARTIAL") {
      out.set(r.financialAccountId, {
        kind: "PARTIAL",
        coveredFromISO: r.coveredFromDate ? isoOf(r.coveredFromDate) : null,
        coveredToISO:   r.coveredToDate ? isoOf(r.coveredToDate) : null,
        caveats, source: r.source,
      });
      continue;
    }
    // UNKNOWN, and anything that failed its own COMPLETE invariant — a COMPLETE
    // row without both bounds is not a licence, so it degrades rather than
    // being trusted on the strength of its label.
    out.set(r.financialAccountId, { kind: "UNKNOWN", caveats, source: r.source });
  }
  return out;
}
