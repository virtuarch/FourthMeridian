/**
 * lib/transactions/duplicate-repair.test.ts  (DF-5)
 *
 * Pure guards for the duplicate-repair planner. Standalone tsx script: exits 0/1.
 * NO DB. Proves: the proven 6→2 Amazon shape plans exactly 2 keepers + 4
 * retirees (oldest kept per lineage); an already-clean 2-row state is a NO-OP;
 * any other state ABORTS; cross-lineage rows never merge.
 */

import { planDuplicateRepair, checkAmazonIncidentShape, type RepairRow } from "@/lib/transactions/duplicate-repair";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const ACCT = "cmrwidufw000htzzmqbll6i31"; // Amex Platinum
function row(id: string, amount: number, date: string, createdAt: string): RepairRow {
  return { id, financialAccountId: ACCT, date, amount, description: "AMAZON MARKETPLACE NAMZN.COM/BILL", pending: false, createdAt };
}

// The exact production incident (3 re-pull passes per purchase).
const incidentRows: RepairRow[] = [
  row("a243sw", -62.11, "2026-07-19", "2026-07-22T20:02:11.290Z"),
  row("1usw3i", -62.11, "2026-07-19", "2026-07-22T20:47:25.194Z"),
  row("ymdg83", -62.11, "2026-07-19", "2026-07-22T21:21:05.067Z"),
  row("eq6vlq", -39.29, "2026-07-21", "2026-07-22T20:02:11.228Z"),
  row("6qgm0j", -39.29, "2026-07-21", "2026-07-22T20:47:25.123Z"),
  row("ndyl0x", -39.29, "2026-07-21", "2026-07-22T21:21:04.989Z"),
];

function main(): void {
  // ── The incident: 6 → keep 2 (oldest per lineage), retire 4. ──
  {
    const plan = planDuplicateRepair(incidentRows);
    check("incident: 6 active, 2 lineages, both duplicated", plan.activeCount === 6 && plan.groupCount === 2 && plan.duplicateGroupCount === 2);
    check("incident: keeps the OLDEST row per lineage", plan.keepIds.sort().join(",") === ["a243sw", "eq6vlq"].sort().join(","));
    check("incident: retires exactly the 4 later re-pull copies", plan.retireIds.sort().join(",") === ["1usw3i", "ymdg83", "6qgm0j", "ndyl0x"].sort().join(","));
    check("incident: shape check → REPAIR", checkAmazonIncidentShape(plan).verdict === "REPAIR");
  }

  // ── Already repaired (2 rows, 1 per lineage) → NO-OP (idempotent). ──
  {
    const clean = [row("a243sw", -62.11, "2026-07-19", "2026-07-22T20:02:11.290Z"), row("eq6vlq", -39.29, "2026-07-21", "2026-07-22T20:02:11.228Z")];
    const plan = planDuplicateRepair(clean);
    check("already-repaired: 0 duplicate groups", plan.duplicateGroupCount === 0 && plan.retireIds.length === 0);
    check("already-repaired: shape check → NOOP (idempotent)", checkAmazonIncidentShape(plan).verdict === "NOOP");
  }

  // ── Any other state → ABORT (never improvise). ──
  {
    const weird = [...incidentRows, row("extra", -62.11, "2026-07-19", "2026-07-22T22:00:00.000Z")]; // 7 rows
    check("unexpected state (7 rows) → ABORT", checkAmazonIncidentShape(planDuplicateRepair(weird)).verdict === "ABORT");
    const partial = incidentRows.slice(0, 4); // 4 rows — not the proven 6
    check("partial state (4 rows) → ABORT", checkAmazonIncidentShape(planDuplicateRepair(partial)).verdict === "ABORT");
  }

  // ── Cross-lineage never merges (different amount/date). ──
  {
    const plan = planDuplicateRepair(incidentRows);
    const g62 = plan.groups.find((g) => g.amount === -62.11)!;
    const g39 = plan.groups.find((g) => g.amount === -39.29)!;
    check("cross-lineage: $62.11 and $39.29 stay separate groups", !g62.retireIds.includes("ndyl0x") && !g39.retireIds.includes("ymdg83"));
  }

  console.log(failures === 0 ? "\nAll duplicate-repair guards passed." : `\n${failures} guard(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
