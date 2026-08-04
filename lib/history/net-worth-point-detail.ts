/**
 * lib/history/net-worth-point-detail.ts
 *
 * V27-B — the DB binding for the Net Worth historical point authority.
 *
 * It reads and it composes. Every decision it carries was made elsewhere:
 * assertability at the snapshot read boundary (Slice A), the aggregate
 * arithmetic in `computeSnapshotFields`, the reconciliation vocabulary in
 * `reconciliation.core`, and the node shape in `historical-node.core`.
 *
 * ONE read for a whole window. The node builder is pure over a single row, so
 * asking about N dates costs one query rather than N — the same batching posture
 * `getInvestmentValueForWindow` established.
 *
 * READ-ONLY. Nothing here writes.
 */

import { getRecentSnapshots } from "@/lib/data/snapshots";
import { buildNetWorthNode } from "./net-worth-node";
import type { HistoricalLensNode, HistoricalSeriesPoint } from "./historical-node.core";

/** Generous enough for an all-time window; the boundary takes the newest N rows. */
const WINDOW_ROWS = 1100;

export interface NetWorthPointDetailArgs {
  spaceId: string;
  dateISO: string;
  /** The INHERITED window. Carried onto the node untouched. */
  fromISO: string;
  toISO:   string;
  /** Populate `series` for the node's own chart. Costs nothing extra — same read. */
  includeSeries?: boolean;
}

/**
 * The Net Worth node for one date, with the window it was asked about.
 *
 * A date with no stored row is UNAVAILABLE rather than an error: "we have no
 * snapshot for that day" is an answer, and the caller renders it as one.
 */
export async function getNetWorthPointDetail(
  args: NetWorthPointDetailArgs,
): Promise<HistoricalLensNode> {
  const { spaceId, dateISO, fromISO, toISO } = args;
  const rows = await getRecentSnapshots(WINDOW_ROWS, { spaceId });
  const row = rows.find((r) => r.date === dateISO);
  const currency = rows[0]?.currency ?? "USD";

  if (!row) {
    return {
      nodeType: "lens", lens: "net-worth", id: "net-worth", label: "Net worth",
      dateISO, fromISO, toISO, currency,
      displayedValue: null, explainedValue: null, unattributedObservedAmount: null,
      reconciliation: "UNAVAILABLE", assertable: false, unavailableReason: "NO_SNAPSHOT_FOR_DATE",
      provenance: { basis: "reconstructed", tier: "unknown", supportedFromISO: null, supportedToISO: null, note: null },
      breadcrumb: [{ id: "net-worth", label: "Net worth", nodeType: "lens" }],
      components: [], drilldown: { available: false, reason: "NO_SNAPSHOT_FOR_DATE" },
      historicalCount: 0, valuedCount: 0,
      explainedAssets: null, explainedLiabilities: null,
    };
  }

  const node = buildNetWorthNode({
    snapshot: row, dateISO, fromISO, toISO,
    currency: row.currency ?? currency,
  });

  if (!args.includeSeries) return node;

  // The node's own chart, over the INHERITED window — from the same rows already
  // read. A point whose Net Worth may not be asserted is a genuine GAP
  // (`value: null`), never a zero and never a bridged line.
  const series: HistoricalSeriesPoint[] = rows
    .filter((r) => r.date >= fromISO && r.date <= toISO && r.fxMiss !== true)
    .map((r) => {
      const point = buildNetWorthNode({
        snapshot: r, dateISO: r.date, fromISO, toISO, currency: r.currency ?? currency,
      });
      return {
        dateISO: r.date,
        value: point.displayedValue,
        basis: point.provenance.basis,
        ...(point.displayedValue === null
          ? { unavailableReason: point.unavailableReason ?? "UNAVAILABLE" }
          : {}),
      };
    });

  return { ...node, series };
}
