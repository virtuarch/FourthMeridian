/**
 * lib/platform/stall-projection.test.ts
 *
 * PRE-BETA-OPS-CLOSE Phase 1 — stalled-item derivation
 * (house pattern: standalone tsx, DB-free):
 *
 *   npx tsx lib/platform/stall-projection.test.ts
 *
 * The five fixtures the initiative specified, plus the semantic that the whole
 * projection turns on: ATTEMPTS ARE DISTINCT SYNC RUNS, NOT ROWS. One failed
 * attempt that could not persist twelve transactions is 1 attempt / 12
 * unpersisted — reporting "12 retries" would overstate the system's effort by an
 * order of magnitude and send an operator hunting a problem that isn't there.
 */

import { projectItemStall, formatStallDuration, describeStall, type StallIssueRow } from "./stall-projection";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const NOW = new Date("2026-07-22T18:00:00Z");
const at = (iso: string) => new Date(iso);

/** A cursor-blocking failure row, as Phase 1 of the cursor-safety slice writes it. */
const blocking = (runId: string, createdAt: string, resolved = false): StallIssueRow => ({
  kind: "UPSERT_ERROR", provider: "PLAID", resolved, createdAt: at(createdAt),
  detail: { stage: "transaction-persist", runId, cursorBlocking: true, merchant: "X" },
});
/** A pre-cursor-safety transaction failure: no runId, no cursorBlocking stamp. */
const legacy = (createdAt: string): StallIssueRow => ({
  kind: "UPSERT_ERROR", provider: "PLAID", resolved: false, createdAt: at(createdAt),
  detail: { merchant: "X", amount: 10 },
});
const INCOMPLETE = at("2026-07-19T14:02:00Z");

// ── Fixture A — one failed attempt, four failed rows ────────────────────────
console.log("A. One attempt, four unpersisted rows");
{
  const s = projectItemStall({
    syncIncompleteAt: INCOMPLETE, now: NOW,
    issues: ["a", "b", "c", "d"].map(() => blocking("run_1", "2026-07-19T14:02:00Z")),
  });
  check("attempts = 1 (ONE run, not four rows)", s.attempts === 1, `${s.attempts}`);
  check("unpersistedCount = 4", s.unpersistedCount === 4, `${s.unpersistedCount}`);
  check("stalled", s.stalled === true);
  check("attempts ≠ unpersistedCount — the counts are distinct facts",
    s.attempts !== s.unpersistedCount);
}

// ── Fixture B — three failed runs, two rows each ────────────────────────────
console.log("B. Three attempts, two rows each");
{
  const s = projectItemStall({
    syncIncompleteAt: INCOMPLETE, now: NOW,
    issues: [
      blocking("run_1", "2026-07-19T14:02:00Z"), blocking("run_1", "2026-07-19T14:02:01Z"),
      blocking("run_2", "2026-07-20T06:00:00Z"), blocking("run_2", "2026-07-20T06:00:01Z"),
      blocking("run_3", "2026-07-21T06:00:00Z"), blocking("run_3", "2026-07-21T06:00:01Z"),
    ],
  });
  check("attempts = 3", s.attempts === 3, `${s.attempts}`);
  check("unpersistedCount = 6", s.unpersistedCount === 6, `${s.unpersistedCount}`);
  check("stalledSince = the EARLIEST failure", s.stalledSince?.toISOString() === "2026-07-19T14:02:00.000Z");
  check("latestFailure = the LATEST failure", s.latestFailure?.toISOString() === "2026-07-21T06:00:01.000Z");
  check("duration measured from the stall's start, not its latest event",
    s.stalledForMs === NOW.getTime() - at("2026-07-19T14:02:00Z").getTime());
  check("renders as 3d 3h", formatStallDuration(s.stalledForMs ?? 0) === "3d 3h", formatStallDuration(s.stalledForMs ?? 0));
}

// ── Fixture C — recovered ───────────────────────────────────────────────────
console.log("C. Recovered issue is not an active stall");
{
  const s = projectItemStall({
    syncIncompleteAt: null, now: NOW,
    issues: [blocking("run_1", "2026-07-19T14:02:00Z", true), blocking("run_1", "2026-07-19T14:02:01Z", true)],
  });
  check("not stalled", s.stalled === false);
  check("resolved rows contribute no attempts", s.attempts === 0, `${s.attempts}`);
  check("resolved rows contribute no unpersisted count", s.unpersistedCount === 0);
  check("no duration", s.stalledForMs === null);

  // Even if the item is somehow still marked incomplete, resolved rows are not a
  // persistence stall — recovery is proven by the cursor advancing.
  const lingering = projectItemStall({
    syncIncompleteAt: INCOMPLETE, now: NOW,
    issues: [blocking("run_1", "2026-07-19T14:02:00Z", true)],
  });
  check("resolved rows never resurrect a stall", lingering.stalled === false);
}

// ── Fixture D — legacy rows without runId ───────────────────────────────────
console.log("D. Legacy rows are reported separately, never counted as attempts");
{
  const s = projectItemStall({
    syncIncompleteAt: INCOMPLETE, now: NOW,
    issues: [legacy("2026-07-10T00:00:00Z"), legacy("2026-07-11T00:00:00Z"), blocking("run_9", "2026-07-21T00:00:00Z")],
  });
  check("legacyFailureCount = 2", s.legacyFailureCount === 2, `${s.legacyFailureCount}`);
  check("attempts = 1 — legacy rows are NOT folded in", s.attempts === 1, `${s.attempts}`);
  check("unpersistedCount = 1 — only cursor-blocking rows", s.unpersistedCount === 1, `${s.unpersistedCount}`);
  check("stalledSince ignores legacy rows", s.stalledSince?.toISOString() === "2026-07-21T00:00:00.000Z");

  // Legacy rows ALONE are not a persistence stall (their attempt depth is
  // unknowable), but they are still surfaced so they are not lost.
  const legacyOnly = projectItemStall({
    syncIncompleteAt: INCOMPLETE, now: NOW,
    issues: [legacy("2026-07-10T00:00:00Z")],
  });
  check("legacy-only ⇒ not reported as a measured stall", legacyOnly.stalled === false);
  check("legacy-only ⇒ still counted honestly", legacyOnly.legacyFailureCount === 1);
}

// ── Fixture E — sync-incomplete with NO cursor-blocking issue ───────────────
console.log("E. syncIncompleteAt with no cursor-blocking issue — no fabricated incident");
{
  const s = projectItemStall({ syncIncompleteAt: INCOMPLETE, now: NOW, issues: [] });
  check("not reported as a persistence stall", s.stalled === false);
  check("no invented attempts", s.attempts === 0);
  check("no invented unpersisted count", s.unpersistedCount === 0);
  check("no invented start time", s.stalledSince === null);

  // Nor does an unrelated unresolved issue (e.g. an investment repair) qualify.
  const unrelated = projectItemStall({
    syncIncompleteAt: INCOMPLETE, now: NOW,
    issues: [{ kind: "UPSERT_ERROR", provider: "PLAID", resolved: false, createdAt: at("2026-07-20T00:00:00Z"),
               detail: { stage: "opening-position-repair" } }],
  });
  check("an investment-repair failure is not a transaction stall", unrelated.stalled === false);
  check("...and is not counted as a legacy transaction failure either",
    unrelated.legacyFailureCount === 0, `${unrelated.legacyFailureCount}`);
}

// ── The three states must stay distinct ─────────────────────────────────────
console.log("F. Normal / stalled / recovered are three different things");
{
  const normal    = projectItemStall({ syncIncompleteAt: null, now: NOW, issues: [] });
  const stalled   = projectItemStall({ syncIncompleteAt: INCOMPLETE, now: NOW, issues: [blocking("r1", "2026-07-19T14:02:00Z")] });
  const recovered = projectItemStall({ syncIncompleteAt: null, now: NOW, issues: [blocking("r1", "2026-07-19T14:02:00Z", true)] });

  check("normal is not stalled", normal.stalled === false);
  check("stalled IS stalled", stalled.stalled === true);
  check("recovered is not stalled", recovered.stalled === false);
  check("normal copy says syncing normally", describeStall(normal, "Chase") === "Chase — syncing normally");
  check("stalled copy names duration, attempts AND unpersisted separately",
    /stalled 3d 3h · 1 failed attempt · 1 transaction unpersisted/.test(describeStall(stalled, "Chase")),
    describeStall(stalled, "Chase"));
}

// ── Duration formatting ─────────────────────────────────────────────────────
console.log("G. Duration never rounds up");
{
  check("<1m", formatStallDuration(30_000) === "<1m");
  check("8m", formatStallDuration(8 * 60_000) === "8m");
  check("2h 15m", formatStallDuration((2 * 60 + 15) * 60_000) === "2h 15m");
  check("3h exactly", formatStallDuration(3 * 3_600_000) === "3h");
  check("3d 4h", formatStallDuration((3 * 24 + 4) * 3_600_000) === "3d 4h");
  check("2d 23h is never shown as 3d", formatStallDuration((2 * 24 + 23) * 3_600_000) === "2d 23h");
}

console.log(failures === 0
  ? "\n✅ stall-projection: all checks passed"
  : `\n❌ stall-projection: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
