/**
 * lib/investments/investment-import-rollback.test.ts
 *
 * A7-5 — the investment rollback helper, over a fake transaction client. Proves:
 * the batch's live InvestmentEvent + PositionObservation rows are soft-deleted;
 * any live row superseded by a row in this batch is un-superseded (pointer
 * cleared over exactly the batch's row ids); per-table counts and the affected
 * (instruments, cash) scope for repair are reported. Banking (TRANSACTIONS)
 * rollback is byte-identical by construction — the route only calls this for
 * INVESTMENT_HISTORY batches (a route-level kind gate, not exercised here).
 *
 *   npx tsx lib/investments/investment-import-rollback.test.ts
 */

import { rollbackInvestmentBatchRows } from "./investment-import-rollback";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

interface Row { [k: string]: unknown }
function makeTx(seed: { batchEvents: Row[]; batchObs: Row[]; supersededEvents: number; supersededObs: number }) {
  const unsupersedeTargets: string[] = [];
  const softDeleted = { events: false, obs: false };
  const tx = {
    investmentEvent: {
      findMany: async () => seed.batchEvents,
      updateMany: async ({ where }: { where: Row }) => {
        if ("importBatchId" in where) { softDeleted.events = true; return { count: seed.batchEvents.length }; }
        if ("supersededById" in where) { unsupersedeTargets.push(...(((where.supersededById as Row).in as string[]) ?? [])); return { count: seed.supersededEvents }; }
        return { count: 0 };
      },
    },
    positionObservation: {
      findMany: async () => seed.batchObs,
      updateMany: async ({ where }: { where: Row }) => {
        if ("importBatchId" in where) { softDeleted.obs = true; return { count: seed.batchObs.length }; }
        if ("supersededById" in where) return { count: seed.supersededObs };
        return { count: 0 };
      },
    },
  };
  return { tx, unsupersedeTargets, softDeleted };
}

async function main(): Promise<void> {
  console.log("rollbackInvestmentBatchRows");
  const { tx, unsupersedeTargets, softDeleted } = makeTx({
    batchEvents: [{ id: "e1", instrumentId: "iA" }, { id: "e2", instrumentId: null }], // e2 is a cash-only event
    batchObs: [{ id: "o1", instrumentId: "iB" }],
    supersededEvents: 1,
    supersededObs: 1,
  });
  const res = await rollbackInvestmentBatchRows(tx as never, "batch_1", new Date("2026-07-12T00:00:00Z"));

  check("live events soft-deleted (count)", softDeleted.events && res.eventsDeleted === 2);
  check("live observations soft-deleted (count)", softDeleted.obs && res.observationsDeleted === 1);
  check("supersession pointers cleared over the batch's row ids", res.pointersCleared === 2 && ["e1", "e2", "o1"].every((id) => unsupersedeTargets.includes(id)));
  check("affected instruments deduped, cash-only event flags affectedCash", JSON.stringify(res.affectedInstrumentIds.sort()) === JSON.stringify(["iA", "iB"]) && res.affectedCash === true);

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nAll investment-import-rollback checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
