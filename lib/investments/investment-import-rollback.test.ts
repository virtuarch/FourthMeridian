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
 * RLS-C-S8 — AND THAT EVERY COUNT IT REPORTS IS AUDIBLE WHEN IT IS WRONG.
 *
 * Under a tenant role an UPDATE refused by a USING policy returns `{ count: 0 }`
 * with no error and no log. All four writes here are `updateMany` and all four
 * counts are shown to the USER, so a refused rollback used to render as a
 * successful one that "rolled back 0 events", and a partial as an unqualified
 * success. The cases below pin all three readings apart — refused, partial, and
 * genuinely-nothing-to-do — because the third is INDISTINGUISHABLE from the first
 * by the count alone and a guard that conflated them would make every second
 * rollback of the same batch an incident.
 *
 *   npx tsx lib/investments/investment-import-rollback.test.ts
 */

import { rollbackInvestmentBatchRows } from "./investment-import-rollback";
import { PartialBulkWriteError } from "@/lib/db/conditional-write";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

interface Row { [k: string]: unknown }

/**
 * `softDeleteCount` / `pointerCount` default to "every eligible row was written",
 * which is what a healthy authority does. Setting them LOWER is how a policy
 * refusal or a partial write is reproduced — the only two levers needed, because
 * the guard compares written against observed and nothing else.
 */
interface Seed {
  batchEvents: Row[];
  batchObs: Row[];
  supersededEvents: number;
  supersededObs: number;
  eventsSoftDeleted?: number;
  obsSoftDeleted?: number;
  eventPointersCleared?: number;
  obsPointersCleared?: number;
}

function makeTx(seed: Seed) {
  const unsupersedeTargets: string[] = [];
  const softDeleted = { events: false, obs: false };
  const liveEvents = seed.batchEvents.filter((r) => r.deletedAt == null).length;
  const liveObs = seed.batchObs.filter((r) => r.deletedAt == null).length;
  const tx = {
    investmentEvent: {
      findMany: async () => seed.batchEvents,
      // The guard's observation of the pointer set, taken through this same client.
      count: async () => seed.supersededEvents,
      updateMany: async ({ where }: { where: Row }) => {
        if ("importBatchId" in where) {
          softDeleted.events = true;
          return { count: seed.eventsSoftDeleted ?? liveEvents };
        }
        if ("supersededById" in where) {
          unsupersedeTargets.push(...(((where.supersededById as Row).in as string[]) ?? []));
          return { count: seed.eventPointersCleared ?? seed.supersededEvents };
        }
        return { count: 0 };
      },
    },
    positionObservation: {
      findMany: async () => seed.batchObs,
      count: async () => seed.supersededObs,
      updateMany: async ({ where }: { where: Row }) => {
        if ("importBatchId" in where) {
          softDeleted.obs = true;
          return { count: seed.obsSoftDeleted ?? liveObs };
        }
        if ("supersededById" in where) return { count: seed.obsPointersCleared ?? seed.supersededObs };
        return { count: 0 };
      },
    },
  };
  return { tx, unsupersedeTargets, softDeleted };
}

const NOW = new Date("2026-07-12T00:00:00Z");

async function expectThrow(fn: () => Promise<unknown>): Promise<unknown> {
  try { await fn(); return null; } catch (e) { return e; }
}

async function main(): Promise<void> {
  console.log("rollbackInvestmentBatchRows");
  {
    const { tx, unsupersedeTargets, softDeleted } = makeTx({
      batchEvents: [{ id: "e1", instrumentId: "iA" }, { id: "e2", instrumentId: null }], // e2 is a cash-only event
      batchObs: [{ id: "o1", instrumentId: "iB" }],
      supersededEvents: 1,
      supersededObs: 1,
    });
    const res = await rollbackInvestmentBatchRows(tx as never, "batch_1", NOW);

    check("live events soft-deleted (count)", softDeleted.events && res.eventsDeleted === 2);
    check("live observations soft-deleted (count)", softDeleted.obs && res.observationsDeleted === 1);
    check("supersession pointers cleared over the batch's row ids", res.pointersCleared === 2 && ["e1", "e2", "o1"].every((id) => unsupersedeTargets.includes(id)));
    check("affected instruments deduped, cash-only event flags affectedCash", JSON.stringify(res.affectedInstrumentIds.sort()) === JSON.stringify(["iA", "iB"]) && res.affectedCash === true);
  }

  // ── RLS-C-S8 — the three readings of a short count, kept apart ─────────────
  console.log("\na REFUSED soft-delete is not 'rolled back 0 events'");
  {
    const { tx } = makeTx({
      batchEvents: [{ id: "e1", instrumentId: "iA" }, { id: "e2", instrumentId: "iA" }],
      batchObs: [], supersededEvents: 0, supersededObs: 0,
      eventsSoftDeleted: 0,                       // the policy refused all of them
    });
    const err = await expectThrow(() => rollbackInvestmentBatchRows(tx as never, "batch_1", NOW));
    check("it raises instead of returning a successful-looking zero", err instanceof PartialBulkWriteError);
    check("the error names the table and both counts",
      err instanceof PartialBulkWriteError && err.table === "InvestmentEvent" && err.observed === 2 && err.written === 0);
  }

  console.log("\na PARTIAL soft-delete is not success — this is the case that looks healthiest");
  {
    const { tx } = makeTx({
      batchEvents: [{ id: "e1", instrumentId: "iA" }, { id: "e2", instrumentId: "iA" }, { id: "e3", instrumentId: "iA" }],
      batchObs: [], supersededEvents: 0, supersededObs: 0,
      eventsSoftDeleted: 1,                       // 1 of 3 — a plausible number
    });
    const err = await expectThrow(() => rollbackInvestmentBatchRows(tx as never, "batch_1", NOW));
    check("1 of 3 raises", err instanceof PartialBulkWriteError);
    check("…and says how short it fell",
      err instanceof PartialBulkWriteError && err.observed === 3 && err.written === 1);
  }

  console.log("\na PARTIAL observation soft-delete raises on its own table, not the event one");
  {
    const { tx } = makeTx({
      batchEvents: [{ id: "e1", instrumentId: "iA" }],
      batchObs: [{ id: "o1", instrumentId: "iB" }, { id: "o2", instrumentId: "iB" }],
      supersededEvents: 0, supersededObs: 0,
      obsSoftDeleted: 1,
    });
    const err = await expectThrow(() => rollbackInvestmentBatchRows(tx as never, "batch_1", NOW));
    check("the shortfall is attributed to PositionObservation",
      err instanceof PartialBulkWriteError && err.table === "PositionObservation");
  }

  console.log("\na SECOND rollback of an already-rolled-back batch writes zero and is SILENT");
  {
    // Every row already carries deletedAt, so zero rows were ever eligible. If
    // the guard compared against the whole batch instead of its LIVE rows, this
    // perfectly ordinary idempotent re-run would raise.
    const already = new Date("2026-07-01T00:00:00Z");
    const { tx } = makeTx({
      batchEvents: [{ id: "e1", instrumentId: "iA", deletedAt: already }, { id: "e2", instrumentId: "iA", deletedAt: already }],
      batchObs: [{ id: "o1", instrumentId: "iB", deletedAt: already }],
      supersededEvents: 0, supersededObs: 0,
      eventsSoftDeleted: 0, obsSoftDeleted: 0,
    });
    const err = await expectThrow(() => rollbackInvestmentBatchRows(tx as never, "batch_1", NOW));
    check("idempotence is not an incident", err === null, err instanceof Error ? err.message : "");
  }

  console.log("\na REFUSED un-supersession is audible — the pointer that was never cleared");
  {
    // The nastiest of the four, because the row it abandons is a USER_ASSERTED
    // opening that stays permanently superseded by evidence that no longer
    // exists, and the reported "0 pointers cleared" reads as "none needed it".
    const { tx } = makeTx({
      batchEvents: [{ id: "e1", instrumentId: "iA" }],
      batchObs: [], supersededEvents: 2, supersededObs: 0,
      eventPointersCleared: 0,
    });
    const err = await expectThrow(() => rollbackInvestmentBatchRows(tx as never, "batch_1", NOW));
    check("it raises rather than reporting 0 pointers cleared", err instanceof PartialBulkWriteError);
    check("the scope names the superseded set, not the batch's own rows",
      err instanceof PartialBulkWriteError && /superseded/.test(err.scope));
  }

  console.log("\nthe guard carries no row ids into its message");
  {
    const { tx } = makeTx({
      batchEvents: [{ id: "ev_cuid_0000000000000001", instrumentId: "iA" }],
      batchObs: [], supersededEvents: 0, supersededObs: 0, eventsSoftDeleted: 0,
    });
    const err = await expectThrow(() => rollbackInvestmentBatchRows(tx as never, "batch_7", NOW));
    check("neither the batch id nor a row id appears in the error",
      err instanceof Error && !/batch_7/.test(err.message) && !/ev_cuid/.test(err.message), (err as Error)?.message);
  }

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nAll investment-import-rollback checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
