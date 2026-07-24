/**
 * lib/transactions/duplicate-repair.ts  (DF-5)
 *
 * Pure planner for the controlled repair of reconnect-created duplicate
 * transactions — the 6-Amazon-rows production incident (see DF-4 /
 * TRANSACTION_IDENTITY_DOCTRINE.md). No DB, no I/O: the script shell
 * (scripts/repair-amazon-duplicates.ts) supplies the rows and performs the
 * soft-delete under --apply.
 *
 * Doctrine: repair only AFTER the write-path invariant is proven (DF-4);
 * preserve evidence (SOFT-delete, never hard-delete); narrowly scope to the
 * proven lineage; ABORT if the observed state differs from the investigation.
 *
 * The keeper per duplicate group is the OLDEST row (earliest createdAt) — the
 * first-ingested copy (for the Amazon incident this is also the correctly
 * enriched "GENERAL_MERCHANDISE" row; the later un-enriched OTHER_OTHER re-pull
 * copies are retired).
 */

export interface RepairRow {
  id: string;
  financialAccountId: string;
  date: string;        // YYYY-MM-DD
  amount: number;
  description: string | null;
  pending: boolean;
  createdAt: string;   // ISO
}

export interface RepairGroup {
  key: string;
  financialAccountId: string;
  date: string;
  amount: number;
  keepId: string;
  retireIds: string[];
  rowCount: number;
}

export interface RepairPlan {
  groups: RepairGroup[];
  keepIds: string[];
  retireIds: string[];
  activeCount: number;
  groupCount: number;
  duplicateGroupCount: number; // groups with >1 active row
}

function groupKey(r: RepairRow): string {
  return [r.financialAccountId, r.date, r.amount, (r.description ?? "").trim().toUpperCase(), r.pending].join("|");
}

/**
 * Group the supplied ACTIVE rows by canonical lineage
 * (account, date, amount, raw descriptor, pending); within each group keep the
 * oldest and mark the rest for retirement. Pure and deterministic.
 */
export function planDuplicateRepair(rows: RepairRow[]): RepairPlan {
  const byKey = new Map<string, RepairRow[]>();
  for (const r of rows) {
    const k = groupKey(r);
    (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(r);
  }
  const groups: RepairGroup[] = [];
  for (const [key, groupRows] of byKey) {
    const sorted = [...groupRows].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const keep = sorted[0];
    groups.push({
      key,
      financialAccountId: keep.financialAccountId,
      date: keep.date,
      amount: keep.amount,
      keepId: keep.id,
      retireIds: sorted.slice(1).map((r) => r.id),
      rowCount: sorted.length,
    });
  }
  groups.sort((a, b) => a.date.localeCompare(b.date) || a.amount - b.amount);
  const retireIds = groups.flatMap((g) => g.retireIds);
  return {
    groups,
    keepIds: groups.map((g) => g.keepId),
    retireIds,
    activeCount: rows.length,
    groupCount: groups.length,
    duplicateGroupCount: groups.filter((g) => g.rowCount > 1).length,
  };
}

/** The proven lineage of the production incident — the ONLY rows this repair targets. */
export const AMAZON_INCIDENT = {
  descriptor: "AMAZON MARKETPLACE NAMZN.COM/BILL",
  // (date, amount) of the two real purchases; the repair query is scoped to these.
  purchases: [
    { date: "2026-07-19", amount: -62.11 },
    { date: "2026-07-21", amount: -39.29 },
  ],
  expected: { activeCount: 6, groupCount: 2, retireCount: 4 },
} as const;

export type ShapeCheck =
  | { verdict: "REPAIR"; reason: string }
  | { verdict: "NOOP"; reason: string }
  | { verdict: "ABORT"; reason: string };

/**
 * Compare the observed plan to the proven incident shape and decide what a
 * writer is allowed to do. NOOP = already at the clean 2-row state (idempotent);
 * REPAIR = exactly the proven 6→2 shape; ABORT = anything else (never improvise).
 */
export function checkAmazonIncidentShape(plan: RepairPlan): ShapeCheck {
  const e = AMAZON_INCIDENT.expected;
  if (plan.duplicateGroupCount === 0) {
    return { verdict: "NOOP", reason: `no duplicate groups (found ${plan.activeCount} active row(s), each unique) — already repaired or not present` };
  }
  if (plan.activeCount === e.activeCount && plan.groupCount === e.groupCount && plan.retireIds.length === e.retireCount) {
    return { verdict: "REPAIR", reason: `matches the proven incident: ${e.activeCount} active → keep ${plan.keepIds.length}, retire ${plan.retireIds.length}` };
  }
  return {
    verdict: "ABORT",
    reason: `observed state (active=${plan.activeCount}, groups=${plan.groupCount}, retire=${plan.retireIds.length}) differs from the investigation (active=${e.activeCount}, groups=${e.groupCount}, retire=${e.retireCount}) — aborting rather than improvising`,
  };
}
