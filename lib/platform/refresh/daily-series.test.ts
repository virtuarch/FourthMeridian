/**
 * lib/platform/refresh/daily-series.test.ts  (UX-P1 · D8)
 *
 * Behaviour guards for the Refresh Daily Series. Standalone tsx (house
 * pattern):
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/refresh/daily-series.test.ts
 *
 * Every assertion runs over INJECTED in-memory facts — no database. Pinned:
 *   • BUCKETING — by the UTC day of startedAt (an execution at 23:59Z and one
 *     at 00:00Z the next day land on different days; local time never leaks);
 *   • ZERO DAYS — every day of the window is present; a closed day with no
 *     rows is a true zero and is `settled`; today is unsettled; a day holding
 *     an open execution is unsettled;
 *   • THE CAP — when the fact cap is hit, days older than the oldest loaded row
 *     are OMITTED (not zero), the oldest loaded day is unsettled, `floor` is
 *     true and the envelope is not deterministic with the cap as its reason;
 *   • VOCABULARY — unknown statuses / kinds count in `total` only; admission
 *     denials are counted from the typed reason, never from the status;
 *   • WINDOW — wider than 30 days is clamped at the old end and stated; the
 *     default window is the shared one; an empty scope fails closed;
 *   • REPRODUCIBILITY — the core is byte-stable under input shuffling.
 */

import {
  buildRefreshDailySeries,
  utcDaysBetween,
} from "@/lib/platform/refresh/projections-core";
import {
  DAILY_SERIES_MAX_WINDOW_DAYS,
  MAX_FACT_ROWS,
  getRefreshDailySeries,
  type RefreshProjectionReaders,
} from "@/lib/platform/refresh/projections";
import type { ExecutionFact } from "@/lib/platform/refresh/types";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
process.on("unhandledRejection", (err) => {
  if ((err as { constructor?: { name?: string } })?.constructor?.name === "PrismaClientInitializationError") return;
  console.error("  ✗ unexpected:", err);
  process.exit(1);
});

const D = (iso: string) => new Date(iso);

let seq = 0;
function execution(over: Partial<ExecutionFact> = {}): ExecutionFact {
  seq += 1;
  return {
    id: `exec${seq}`,
    runId: `run${seq}`,
    plaidItemId: "item1",
    trigger: "CRON",
    profile: "FULL_REFRESH",
    startedAt: D("2026-07-10T06:00:00.000Z"),
    completedAt: D("2026-07-10T06:00:12.000Z"),
    durationMs: 12_000,
    overallStatus: "SUCCEEDED",
    parentJobRunId: null,
    errorSummary: null,
    deploymentSha: null,
    admissionReason: null,
    sourceKind: "PLAID_ITEM",
    sourceRef: null,
    network: null,
    failureStage: null,
    failureCategory: null,
    outcome: null,
    ...over,
  };
}

function fakeReaders(over: Partial<RefreshProjectionReaders> = {}): RefreshProjectionReaders {
  return {
    now: D("2026-07-20T10:00:00.000Z"),
    executions: async () => [execution()],
    endpoints: async () => [],
    providerCalls: async () => [],
    coverage: async () => [],
    execution: async () => null,
    lastSucceededByKind: async () => null,
    ...over,
  };
}

function shuffle<T>(xs: readonly T[]): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = (i * 7919 + 13) % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

async function main() {
  console.log("utcDaysBetween");
  {
    check("inclusive, ascending", utcDaysBetween("2026-07-08", "2026-07-10").join(",") === "2026-07-08,2026-07-09,2026-07-10");
    check("a single day", utcDaysBetween("2026-07-10", "2026-07-10").length === 1);
    check("from after to is empty, never negative", utcDaysBetween("2026-07-11", "2026-07-10").length === 0);
    check("crosses a month boundary", utcDaysBetween("2026-07-30", "2026-08-02").join(",") === "2026-07-30,2026-07-31,2026-08-01,2026-08-02");
  }

  console.log("core · bucketing by UTC day of startedAt");
  {
    const rows = [
      execution({ startedAt: D("2026-07-09T23:59:59.000Z"), completedAt: D("2026-07-10T00:00:05.000Z") }),
      execution({ startedAt: D("2026-07-10T00:00:00.000Z") }),
      execution({ startedAt: D("2026-07-10T12:00:00.000Z"), overallStatus: "FAILED", failureStage: "BALANCES" }),
      execution({ startedAt: D("2026-07-10T13:00:00.000Z"), overallStatus: "SKIPPED", admissionReason: "COOLDOWN", sourceKind: "WALLET", network: "BTC", plaidItemId: null }),
      execution({ startedAt: D("2026-07-10T14:00:00.000Z"), overallStatus: "MYSTERY", sourceKind: "EXOTIC" }),
    ];
    const s = buildRefreshDailySeries(rows, { from: "2026-07-08", to: "2026-07-11" }, { todayISO: "2026-07-20", capHit: false });
    check("every day of the window is present", s.days.map((d) => d.day).join(",") === "2026-07-08,2026-07-09,2026-07-10,2026-07-11");
    const d09 = s.days[1];
    const d10 = s.days[2];
    check("23:59:59Z lands on its own day (completion the next day does not move it)", d09.total === 1);
    check("00:00:00Z lands on the next day", d10.total === 4);
    check("byStatus names the five statuses and counts them", d10.byStatus.SUCCEEDED === 1 && d10.byStatus.FAILED === 1 && d10.byStatus.SKIPPED === 1 && d10.byStatus.RUNNING === 0 && d10.byStatus.PARTIAL === 0);
    check("an unknown status counts in total but has no named column", d10.total === 4 && Object.keys(d10.byStatus).length === 5);
    check("bySourceKind counts the two named kinds", d10.bySourceKind.PLAID_ITEM === 2 && d10.bySourceKind.WALLET === 1);
    check("an unknown source kind counts in total only", Object.keys(d10.bySourceKind).length === 2);
    check("admission denial is read from the typed reason", d10.admissionDenied === 1);
    check("a closed day with no rows is a true zero", s.days[0].total === 0 && s.days[0].byStatus.FAILED === 0);
    check("...and it is settled (the ledger is the authority)", s.days[0].settled === true);
    check("a closed day with rows and no open execution is settled", d10.settled === true);
    check("executions is the loaded row count", s.executions === 5);
    check("no cap ⇒ not a floor", s.floor === false);
    check("tier observed", s.tier === "observed");
    check("byStatus key order is the vocabulary's order", Object.keys(d10.byStatus).join(",") === "SUCCEEDED,PARTIAL,FAILED,SKIPPED,RUNNING");
  }

  console.log("core · settledness");
  {
    const rows = [
      execution({ startedAt: D("2026-07-10T06:00:00.000Z"), overallStatus: "RUNNING", completedAt: null, durationMs: null }),
      execution({ startedAt: D("2026-07-11T06:00:00.000Z") }),
    ];
    const s = buildRefreshDailySeries(rows, { from: "2026-07-10", to: "2026-07-12" }, { todayISO: "2026-07-12", capHit: false });
    check("a closed day holding a RUNNING execution is unsettled", s.days[0].settled === false && s.days[0].byStatus.RUNNING === 1);
    check("a closed day with only completed rows is settled", s.days[1].settled === true);
    check("today is unsettled even with no rows", s.days[2].day === "2026-07-12" && s.days[2].settled === false && s.days[2].total === 0);
    const halfWritten = buildRefreshDailySeries(
      [execution({ startedAt: D("2026-07-10T06:00:00.000Z"), completedAt: null, overallStatus: "SUCCEEDED" })],
      { from: "2026-07-10", to: "2026-07-10" }, { todayISO: "2026-07-12", capHit: false });
    check("a null completedAt counts as open even if the status says otherwise (the canonical rule)", halfWritten.days[0].settled === false);
  }

  console.log("core · the fact cap");
  {
    const rows = [
      execution({ startedAt: D("2026-07-10T06:00:00.000Z") }),
      execution({ startedAt: D("2026-07-11T06:00:00.000Z") }),
      execution({ startedAt: D("2026-07-12T06:00:00.000Z") }),
    ];
    const s = buildRefreshDailySeries(rows, { from: "2026-07-08", to: "2026-07-12" }, { todayISO: "2026-07-20", capHit: true });
    check("days older than the oldest loaded row are OMITTED, not zero", s.days.map((d) => d.day).join(",") === "2026-07-10,2026-07-11,2026-07-12");
    check("the oldest loaded day is unsettled (partially loaded)", s.days[0].settled === false);
    check("newer fully-loaded closed days stay settled", s.days[1].settled === true && s.days[2].settled === true);
    check("floor is declared", s.floor === true);
    const none = buildRefreshDailySeries([], { from: "2026-07-08", to: "2026-07-10" }, { todayISO: "2026-07-20", capHit: false });
    check("no rows at all ⇒ every day present as a settled zero", none.days.length === 3 && none.days.every((d) => d.total === 0 && d.settled));
    check("no rows at all ⇒ tier unknown (nothing was observed)", none.tier === "unknown");
  }

  console.log("core · reproducibility");
  {
    const rows = Array.from({ length: 40 }, (_, i) =>
      execution({
        startedAt: D(`2026-07-${String(1 + (i % 10)).padStart(2, "0")}T${String(i % 24).padStart(2, "0")}:00:00.000Z`),
        overallStatus: ["SUCCEEDED", "FAILED", "PARTIAL", "SKIPPED"][i % 4],
        sourceKind: i % 3 === 0 ? "WALLET" : "PLAID_ITEM",
        admissionReason: i % 4 === 3 ? "COOLDOWN" : null,
      }),
    );
    const a = JSON.stringify(buildRefreshDailySeries(rows, { from: "2026-07-01", to: "2026-07-10" }, { todayISO: "2026-07-20", capHit: false }));
    const b = JSON.stringify(buildRefreshDailySeries(shuffle(rows), { from: "2026-07-01", to: "2026-07-10" }, { todayISO: "2026-07-20", capHit: false }));
    check("byte-identical under input shuffling", a === b);
    const parsed = JSON.parse(a) as { days: { total: number }[] };
    check("totals conserve the rows", parsed.days.reduce((n, d) => n + d.total, 0) === 40);
  }

  console.log("projection · envelope + window");
  {
    const closed = await getRefreshDailySeries({ from: "2026-07-01", to: "2026-07-10" }, { readers: fakeReaders() });
    check("closed window, no open execution ⇒ deterministic", closed.envelope.deterministic === true);
    check("window is echoed", closed.envelope.window.from === "2026-07-01" && closed.envelope.window.to === "2026-07-10");
    check("ten days", closed.windowDays === 10 && closed.days.length === 10);
    check("checkedAt is the read instant", closed.envelope.checkedAt === "2026-07-20T10:00:00.000Z");
    check("maxWindowDays is the ceiling", closed.maxWindowDays === DAILY_SERIES_MAX_WINDOW_DAYS && DAILY_SERIES_MAX_WINDOW_DAYS === 30);
    check("notes name the UTC bucketing", closed.notes.some((n) => /UTC day/.test(n)));
    check("notes state that cooldown refusals write no row", closed.notes.some((n) => /429/.test(n) && /no execution row/.test(n)));
    check("notes state the true-zero rule", closed.notes.some((n) => /true zero/.test(n)));

    const open = await getRefreshDailySeries({ from: "2026-07-15", to: "2026-07-20" }, { readers: fakeReaders() });
    check("window ending today ⇒ not deterministic, with the reason", open.envelope.deterministic === false && /open/.test(open.envelope.indeterminacyReason ?? ""));
    check("today is present and unsettled", open.days[open.days.length - 1].day === "2026-07-20" && open.days[open.days.length - 1].settled === false);

    const dflt = await getRefreshDailySeries({}, { readers: fakeReaders() });
    check("default window ends today and uses the shared 14-day default", dflt.envelope.window.to === "2026-07-20" && dflt.envelope.window.from === "2026-07-06");

    let seen: { from: Date; to: Date } | null = null;
    const wide = await getRefreshDailySeries(
      { from: "2026-05-01", to: "2026-07-10" },
      { readers: fakeReaders({ executions: async (from, to) => { seen = { from, to }; return []; } }) },
    );
    check("wider than 30 days is clamped at the OLD end", wide.envelope.window.from === "2026-06-11" && wide.envelope.window.to === "2026-07-10" && wide.days.length === 30);
    check("the clamp is stated in notes with the requested start", wide.notes.some((n) => /clamped/.test(n) && /2026-05-01/.test(n)));
    check("the reader was asked for the clamped window only", seen !== null && (seen as { from: Date }).from.toISOString() === "2026-06-11T00:00:00.000Z");

    const exactly30 = await getRefreshDailySeries({ from: "2026-06-11", to: "2026-07-10" }, { readers: fakeReaders({ executions: async () => [] }) });
    check("exactly 30 days is not clamped", exactly30.days.length === 30 && !exactly30.notes.some((n) => /clamped/.test(n)));

    const inverted = await getRefreshDailySeries({ from: "2026-07-12", to: "2026-07-10" }, { readers: fakeReaders({ executions: async () => [] }) });
    check("from after to collapses to the single end day and says so", inverted.days.length === 1 && inverted.notes.some((n) => /after its end/.test(n)));
  }

  console.log("projection · the cap");
  {
    const many = Array.from({ length: MAX_FACT_ROWS }, (_, i) =>
      execution({ startedAt: D(`2026-07-${String(5 + (i % 6)).padStart(2, "0")}T06:00:00.000Z`) }),
    );
    const capped = await getRefreshDailySeries({ from: "2026-07-01", to: "2026-07-10" }, { readers: fakeReaders({ executions: async () => many }) });
    check("cap reached ⇒ floor", capped.floor === true);
    check("cap reached ⇒ not deterministic", capped.envelope.deterministic === false);
    check("the reason names the cap", /fact cap/.test(capped.envelope.indeterminacyReason ?? "") && new RegExp(String(MAX_FACT_ROWS)).test(capped.envelope.indeterminacyReason ?? ""));
    check("days older than the oldest loaded row are omitted", capped.days[0].day === "2026-07-05" && capped.days.length === 6);
    check("the oldest loaded day is unsettled", capped.days[0].settled === false);
  }

  console.log("projection · scope fails closed");
  {
    let asked = false;
    const scoped = await getRefreshDailySeries(
      { from: "2026-07-01", to: "2026-07-10", plaidItemIds: [] },
      { readers: fakeReaders({ executions: async () => { asked = true; return [execution()]; } }) },
    );
    check("an empty scope reads nothing", asked === false && scoped.executions === 0);
    check("...and still emits the window's days as zeros (nothing in scope ran)", scoped.days.length === 10 && scoped.days.every((d) => d.total === 0));
    check("...with tier unknown", scoped.tier === "unknown");
  }

  if (failures > 0) {
    console.error(`\ndaily-series.test: ${failures} failure(s).`);
    process.exit(1);
  }
  console.log("\ndaily-series.test: all passed.");
}

main();
