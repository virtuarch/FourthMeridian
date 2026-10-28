/**
 * lib/crypto/sol-backfill-revaluation.test.ts
 *
 * PR #107 review fix 1 — the worker's "revalue this other wallet" flag.
 * It is written under the other wallet's sync lock when free, with the
 * checkpoint CAS retried once; a flag that still cannot be written is counted
 * and RE-DERIVED next run from persisted state (valued-from before the Spaces'
 * earliest snapshot), at most once per price floor. Deterministic fakes only.
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/crypto/sol-backfill-revaluation.test.ts
 */

import { solHistoryBackfill, type SolBackfillJobDeps } from "@/jobs/sol-history-backfill";
import { workerConfig } from "@/lib/crypto/sol-backfill-worker.core";
import { emptyCheckpoint, serializeCheckpoint, parseCheckpoint, type SolBackfillCheckpoint } from "@/lib/crypto/sol-history-backfill.core";
import type { SolBackfillStore } from "@/lib/crypto/sol-history-backfill";
import type { PriceGapRun, RevaluationOwed } from "@/lib/prices/price-gap";

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const DAY = "2026-10-28";
const ADDR = "7irKphsVxEfU8wtDhVgCyq7nQXUo9Q13ivUevk8qBMSN";
const complete = (id: string, over: Partial<SolBackfillCheckpoint> = {}) => serializeCheckpoint({
  ...emptyCheckpoint(id, ADDR, `${DAY}T00:00:00Z`), reachedBeginning: true, completedAtISO: `${DAY}T00:00:00Z`,
  licensedFromISO: "2024-01-01", licensedToISO: DAY, ...over,
});
const importing = (id: string) => serializeCheckpoint({ ...emptyCheckpoint(id, ADDR, `${DAY}T00:00:00Z`), licensedFromISO: "2024-06-01", licensedToISO: DAY });

function world(cursors: Record<string, string | null>, o: {
  busy?: string[]; casLoses?: Record<string, number>; gaps?: PriceGapRun; owed?: RevaluationOwed[];
} = {}) {
  let t = Date.parse(`${DAY}T10:00:00Z`);
  const locks = new Map<string, number>();
  const log: string[] = [];
  const casLoses = { ...(o.casLoses ?? {}) };
  const store = (id: string): SolBackfillStore => ({
    async readCursor() { return cursors[id] ?? null; },
    async anchor() { return null; },
    async commit(c) {
      if ((casLoses[id] ?? 0) > 0) { casLoses[id]--; throw new Error("cas"); } // a concurrent sync advanced it
      if (c.expectedCursor !== cursors[id]) throw new Error("cas");
      cursors[id] = c.nextCursor;
    },
  });
  const deps: SolBackfillJobDeps = {
    now: () => t, sleep: async (ms) => { t += ms; }, wakeStartedAt: async () => null,
    wallets: async () => Object.keys(cursors).map((id) => ({ accountId: id, connectionId: `c-${id}`, address: ADDR, cursor: cursors[id] })),
    claimLock: async (c, s) => { if (o.busy?.includes(c) || locks.has(c)) { log.push(`lock-busy:${c}`); return false; } locks.set(c, s); log.push(`lock:${c}`); return true; },
    renewLock: async (c, f, to) => { if (locks.get(c) !== f) return false; locks.set(c, to); return true; },
    releaseLock: async (c, s) => { if (locks.get(c) === s) { locks.delete(c); log.push(`release:${c}`); } },
    reconstruct: async ({ accountId }) => {
      t += 2_000; log.push(`run:${accountId}`);
      return { accountId, ok: true, derivedRowsWritten: 3, mode: "INCREMENTAL", impactedFromISO: "2026-10-01",
        backfill: { status: { state: "IMPORTING" } as never, progressed: true, rowsWritten: 3, impactedFromISO: "2026-10-01", signaturesProcessed: 10, pagesFetched: 1, stoppedBecause: "BUDGET", failure: null } };
    },
    store: async (id) => store(id),
    regenerationEnabled: () => true,
    regenerate: async (id, from) => { log.push(`regen:${id}:${from}`); },
    acquirePriceGaps: async () => o.gaps ?? { decisions: [], acquired: 0, inserted: 0, failures: 0, instruments: [], newlyPricedFromISO: null },
    revaluationOwed: async (ids) => (o.owed ?? []).filter((x) => ids.includes(x.accountId)),
  };
  return { deps, log, cursors, locks };
}
const cfg = { ...workerConfig({ SOL_BACKFILL_ENABLED: "true" }), jobBudgetMs: 240_000 };
const filled: PriceGapRun = { decisions: [], acquired: 1, inserted: 300, failures: 0, instruments: [{ instrumentId: "SOL", earliestBeforeISO: "2026-09-27", earliestAfterISO: "2025-10-28" }], newlyPricedFromISO: "2025-10-28" };

async function main() {
  console.log("flag under the holder's own lock");
  {
    // a is importing (it runs and fills the gap); h is a COMPLETE holder (not in this run's work list).
    const w = world({ a: importing("a"), h: complete("h") }, { gaps: filled });
    const s = await solHistoryBackfill({ config: cfg, deps: w.deps });
    const h = parseCheckpoint(w.cursors.h, "h", ADDR);
    check("the holder is flagged pending from max(licence, new floor), with the floor marker", h?.snapshotPendingFromISO === "2025-10-28" && h?.valuationCheckedFloorISO === "2025-10-28", w.cursors.h ?? "");
    check("…under ITS sync lock, claimed and released", w.log.includes("lock:c-h") && w.log.includes("release:c-h") && !w.locks.has("c-h"), w.log.join(","));
    check("…counted, and the job self-continues", s.holdersMarkedPending === 1 && s.holdersFlagFailed === 0 && s.deferred > 0);
  }

  console.log("lock busy: the CAS alone, retried once");
  {
    const w = world({ a: importing("a"), h: complete("h") }, { gaps: filled, busy: ["c-h"], casLoses: { h: 1 } });
    const s = await solHistoryBackfill({ config: cfg, deps: w.deps });
    check("one lost CAS is retried and the flag lands without the lock", parseCheckpoint(w.cursors.h, "h", ADDR)?.snapshotPendingFromISO === "2025-10-28" && s.holdersFlagFailed === 0, JSON.stringify(s));
  }

  console.log("both fail: counted, then re-derived from persisted state");
  {
    const w = world({ a: importing("a"), h: complete("h") }, { gaps: filled, busy: ["c-h"], casLoses: { h: 2 } });
    const s = await solHistoryBackfill({ config: cfg, deps: w.deps });
    check("lock busy + CAS lost twice ⇒ not written, counted in the summary (no ids)", !parseCheckpoint(w.cursors.h, "h", ADDR)?.snapshotPendingFromISO && s.holdersFlagFailed === 1, JSON.stringify(s));
    check("…and the job still self-continues", s.deferred > 0);

    // Next run: persisted state says h's valued-from (2025-10-28) precedes its Spaces' earliest snapshot (2026-09-27).
    const owed: RevaluationOwed[] = [{ accountId: "h", fromISO: "2025-10-28", floorISO: "2025-10-28", earliestSnapshotISO: "2026-09-27" }];
    const w2 = world({ h: w.cursors.h }, { owed });
    const s2 = await solHistoryBackfill({ config: cfg, deps: w2.deps });
    check("SELF-HEAL: the lost flag is re-derived and the holder regenerated from valued-from", s2.revaluationsRederived === 1 && w2.log.includes("regen:h:2025-10-28"), w2.log.join(","));
    check("…the floor marker is persisted and the pending flag cleared after the regeneration",
      parseCheckpoint(w2.cursors.h, "h", ADDR)?.valuationCheckedFloorISO === "2025-10-28" && !parseCheckpoint(w2.cursors.h, "h", ADDR)?.snapshotPendingFromISO, w2.cursors.h ?? "");

    // Snapshots still cannot reach (e.g. another unpriced holding in the Space): owed stays true — but never loops.
    const w3 = world({ h: w2.cursors.h }, { owed });
    const s3 = await solHistoryBackfill({ config: cfg, deps: w3.deps });
    check("…once per floor: the same owed state under the same floor is NOT re-flagged", s3.revaluationsRederived === 0 && !w3.log.some((x) => x.startsWith("regen:")) && s3.stoppedBecause === "NO_WORK", JSON.stringify(s3));
    const w4 = world({ h: w2.cursors.h }, { owed: [{ ...owed[0], floorISO: "2025-06-01", fromISO: "2025-06-01" }] });
    const s4 = await solHistoryBackfill({ config: cfg, deps: w4.deps });
    check("…a NEW floor is acted on again", s4.revaluationsRederived === 1 && w4.log.includes("regen:h:2025-06-01"));
  }

  if (failures > 0) { console.error(`\nsol-backfill-revaluation: ${failures} failed.`); process.exit(1); }
  console.log("\nsol-backfill-revaluation: all checks passed.");
}
main().catch((e) => { console.error(e); process.exit(1); });
