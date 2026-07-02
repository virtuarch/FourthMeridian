/**
 * scripts/audit-visibility-levels.ts
 *
 * KD-1 pre-flight audit — read-only.
 *
 * Counts SpaceAccountLink rows grouped by (visibilityLevel, status).
 * Purpose: verify that no SAL row carries the legacy `SHARED` visibility
 * value (schema comment: "legacy — maps to FULL") before the AI-context
 * transaction predicate is fixed to FULL-only.
 *
 * Code-level context (verified 2026-07-02): no current write path can produce
 * SHARED — the share route validates against [BALANCE_ONLY, FULL], and all
 * other SAL writes hardcode FULL. This script checks for legacy DATA that
 * predates those guards.
 *
 * v2.5-A Phase 4c: the WorkspaceAccountShare arm was removed with the model
 * (table dropped; scripts/phase0-seam-gates.ts Gate D verified the mirror
 * before the drop).
 *
 * Usage:
 *   npx tsx scripts/audit-visibility-levels.ts
 *
 * Uses DATABASE_URL from the environment (.env). To audit production, run
 * with the production DATABASE_URL exported (e.g. via `vercel env pull`).
 *
 * Exit codes:
 *   0 — no SHARED (or PRIVATE) rows on SpaceAccountLink; FULL-only predicate is safe
 *   1 — legacy/unexpected visibility rows found; STOP and report before migrating
 *   2 — audit could not run (connection/query failure)
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

type GroupRow = { visibilityLevel: string; status: string; n: number };

async function groupTable(model: "spaceAccountLink"): Promise<GroupRow[]> {
  // groupBy via the delegate keeps this schema-checked.
  const delegate = prisma[model] as unknown as {
    groupBy(args: {
      by: ["visibilityLevel", "status"];
      _count: { _all: true };
    }): Promise<Array<{ visibilityLevel: string; status: string; _count: { _all: number } }>>;
  };
  const rows = await delegate.groupBy({ by: ["visibilityLevel", "status"], _count: { _all: true } });
  return rows
    .map((r) => ({ visibilityLevel: r.visibilityLevel, status: r.status, n: r._count._all }))
    .sort((a, b) =>
      a.visibilityLevel.localeCompare(b.visibilityLevel) || a.status.localeCompare(b.status),
    );
}

function print(label: string, rows: GroupRow[]): void {
  console.log(`${label}:`);
  if (rows.length === 0) {
    console.log("  (no rows)");
    return;
  }
  for (const r of rows) console.log(`  ${r.visibilityLevel} / ${r.status}: ${r.n}`);
}

async function main(): Promise<void> {
  const sal = await groupTable("spaceAccountLink");

  print("SpaceAccountLink", sal);

  // FULL-only predicate is safe iff no SAL row carries a visibility value the
  // AI transaction predicate would wrongly exclude. SHARED is the legacy
  // "maps to FULL" value; PRIVATE on a link row would be a data anomaly worth
  // stopping for too. BALANCE_ONLY / SUMMARY_ONLY are expected and correctly
  // excluded by the predicate.
  const suspect = sal.filter(
    (r) => r.visibilityLevel === "SHARED" || r.visibilityLevel === "PRIVATE",
  );

  if (suspect.length > 0) {
    console.log("\nRESULT: STOP — legacy/unexpected visibility values found on SpaceAccountLink:");
    for (const r of suspect) console.log(`  ${r.visibilityLevel} / ${r.status}: ${r.n}`);
    console.log("Do not proceed with the FULL-only predicate until these rows are dispositioned.");
    process.exitCode = 1;
    return;
  }

  console.log("\nRESULT: CLEAN — no SHARED/PRIVATE rows on SpaceAccountLink. FULL-only predicate is safe.");
}

main()
  .catch((e) => {
    console.error("AUDIT FAILED:", e instanceof Error ? e.message : e);
    process.exitCode = 2;
  })
  .finally(() => prisma.$disconnect());
