/**
 * components/platform/widgets/scheduler.test.ts  (PM-1 S3)
 *
 * RENDER-PATH proof for the Scheduler surface (house pattern: standalone tsx +
 * renderToStaticMarkup, DB-free):
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/platform/widgets/scheduler.test.ts
 *
 * Two components are rendered, and the split matters:
 *   · `OpsSchedulerWidget` — the REAL self-fetching widget. Server rendering
 *     never runs an effect, so what it renders is exactly the first frame an
 *     operator sees. That is the only way to prove the loading state is
 *     genuinely the loading state and not a hopeful empty one.
 *   · `SchedulerSurface` — the prop-driven surface, which is how failure and
 *     every absent-figure case become reachable without a network.
 *
 * The populated fixture is produced by the REAL pure authority
 * `buildSchedulerObservation` over synthetic ledger rows, so the test cannot
 * drift from the shape the route actually serves: a field the authority stops
 * emitting fails the typecheck here rather than rendering blank in production.
 *
 * ── WHAT IS PINNED HERE ──────────────────────────────────────────────────────
 * Every one of these is a way this surface could quietly start lying:
 *   1. loading is not the empty state and not a zero
 *   2. a failed fetch is not a time, not a zero, not "nothing to report"
 *   3. an error wins over data the hook happens to be holding
 *   4. the three epistemic groups all render, with their headline figures
 *   5. an absent instant is `Unavailable` with a REASON, never 00:00
 *   6. an unreadable instant says unreadable — a different fact from absent
 *   7. no scheduler-health verdict is ever claimed
 *   8. tokens only; nothing coloured is wordless
 *   9. one literal url, and no second route
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  EXTERNAL_CRON_NOTE,
  SCHEDULER_NOTES,
  buildSchedulerObservation,
} from "@/lib/platform/scheduler/observation-core";
import type { ScheduledJob } from "@/lib/jobs/registry";
import type { SchedulerObservationResponse } from "@/app/api/platform/platform-ops/scheduler/route";
import type { SharedFetchState } from "../workspace-session";
import { OpsSchedulerWidget, SchedulerSurface } from "./OpsSchedulerWidget";
import {
  CRON_CADENCE_REASON,
  EXTERNAL_CRON_HINT,
  NO_EXECUTION_REASON,
  NO_EXTERNAL_CRONS_QUALIFIER,
  NO_SLOT_REASON,
  OBSERVED_HINT,
  UNREADABLE_TIME_REASON,
  externalCronNames,
  isUnreadable,
  jobsInSlotQualifier,
  lastExecutionDerivation,
  registeredJobsNote,
  utcClock,
} from "./scheduler-view";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const ROOT = process.cwd();
const strip = (rel: string) =>
  readFileSync(path.join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const SECTION = { id: "s1", key: "ops_scheduler", label: "Scheduler" };

/** A fixed clock, so every relative age in this file is deterministic. */
const NOW = Date.parse("2026-07-25T09:12:00.000Z");

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** Registry entries. Only name/slot matter to the derivation; `run` is required
 *  by the type and is never invoked here. */
const job = (name: string, hourUTC: number | number[]): ScheduledJob => ({
  name,
  hourUTC,
  minuteUTC: 0,
  run: async () => undefined,
});

const JOBS: ScheduledJob[] = [job("sync-banks", 6), job("sync-crypto", [0, 6, 12, 18]), job("fetch-fx-rates", 7)];

const WINDOW = { from: "2026-07-24T09:12:00.000Z", to: "2026-07-25T09:12:00.000Z" };

/** The REAL authority's answer over synthetic ledger rows. */
function observation(
  over: {
    runs?: { jobName: string; startedAt: Date }[];
    nextSlotAt?: Date | null;
    jobsInNextSlot?: readonly string[];
  } = {},
): SchedulerObservationResponse {
  return {
    ...buildSchedulerObservation({
      jobs: JOBS,
      health: [],
      runs: over.runs ?? [
        { jobName: "sync-banks", startedAt: new Date("2026-07-25T06:00:00.000Z") },
        { jobName: "resume-stale-imports", startedAt: new Date("2026-07-25T07:30:00.000Z") },
      ],
      nextSlotAt: over.nextSlotAt === undefined ? new Date("2026-07-25T12:00:00.000Z") : over.nextSlotAt,
      jobsInNextSlot: over.jobsInNextSlot ?? ["sync-crypto"],
      window: WINDOW,
    }),
    checkedAt: "2026-07-25T09:12:00.000Z",
  };
}

/**
 * A hand-built response, for the cases no ledger can produce: an unreadable
 * timestamp. Typed, so drift in the route's shape fails the typecheck.
 */
function malformed(): SchedulerObservationResponse {
  return {
    observed: {
      lastRecordedExecutionAt: "not-a-timestamp",
      recordedExecutions: 4,
      overdue: [],
      externalCrons: [],
    },
    expected: { nextSlotAt: "also-not-a-timestamp", jobsInNextSlot: [], registeredJobs: 3 },
    notes: SCHEDULER_NOTES,
    window: WINDOW,
    checkedAt: "2026-07-25T09:12:00.000Z",
  };
}

const ok = (d: SchedulerObservationResponse): SharedFetchState<SchedulerObservationResponse> =>
  ({ data: d, loading: false, error: null });
const loadingState = (): SharedFetchState<SchedulerObservationResponse> =>
  ({ data: null, loading: true, error: null });
const failed = (msg = "Request failed (500)"): SharedFetchState<SchedulerObservationResponse> =>
  ({ data: null, loading: false, error: msg });

function renderSurface(state: SharedFetchState<SchedulerObservationResponse> = ok(observation())) {
  const html = renderToStaticMarkup(
    createElement(SchedulerSurface, { section: SECTION, state, nowMs: NOW }),
  );
  return { html, text: html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() };
}

const GROUPS = ["Observed", "Expected", "Scheduler notes"];
const REASSURING = /healthy|all clear|all good|everything is|no issues|operating normally|scheduler is (alive|ok)/i;

/**
 * The surface's honesty footnote necessarily REFUSES the claim "the scheduler is
 * alive", so it necessarily contains the phrase. Assertions about what the
 * surface CLAIMS therefore read the body with the footnote removed — otherwise
 * the refusal of a claim would count as making it. (The `body()` idiom from
 * platform-health.test.ts.)
 */
const FOOTNOTE_START = "Observed values are read from the JobRun ledger";
const body = (text: string) => {
  const i = text.indexOf(FOOTNOTE_START);
  return (i < 0 ? text : text.slice(0, i)).trim();
};
/** Every headline figure the surface rendered — structurally, from `Figure`. */
const figures = (html: string) =>
  [...html.matchAll(/<span class="tabular-nums tracking-tight text-2xl[^"]*"[^>]*>([\s\S]*?)<\/span>/g)]
    .map((m) => m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());

function main() {
  // ── 0. The pure view module ───────────────────────────────────────────────
  console.log("0. the view module formats without deciding");
  {
    check("utcClock renders the UTC wall clock", utcClock("2026-07-25T07:30:00.000Z") === "07:30");
    check("utcClock on null is null", utcClock(null) === null);
    check("utcClock on garbage is null (never 00:00)", utcClock("nope") === null);
    check("an unreadable stamp is distinguished from an absent one",
      isUnreadable("nope") && !isUnreadable(null) && !isUnreadable("2026-07-25T07:30:00.000Z"));
    check("the window count rides the derivation line",
      lastExecutionDerivation(2) === "From job runs (not dispatcher ticks) · 2 recorded in the window");
    check("zero recorded is worded, not zeroed",
      lastExecutionDerivation(0).endsWith("none recorded in the window"), lastExecutionDerivation(0));
    check("no external crons is worded", externalCronNames([]) === null);
    check("external crons are named", externalCronNames([
      { job: "a", lastRecordedExecutionAt: null, recordedExecutions: 1, registered: false },
      { job: "b", lastRecordedExecutionAt: null, recordedExecutions: 1, registered: false },
    ]) === "a · b");
    check("an empty slot is worded", jobsInSlotQualifier([]) === "no jobs declared for that slot");
    check("the registry count is singular-aware",
      registeredJobsNote(1) === "1 registered job" && registeredJobsNote(3) === "3 registered jobs");
  }

  // ── 1. The real widget's FIRST FRAME is loading, and only loading ─────────
  console.log("1. the self-fetching widget renders a loading state, never an empty one");
  {
    const html = renderToStaticMarkup(createElement(OpsSchedulerWidget, { section: SECTION }));
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

    check("shows a loading line", /Loading/.test(text), text.slice(0, 200));
    check("exactly one loading state", (html.match(/role="status"/g) ?? []).length === 1);
    check("does not render an alert", !html.includes('role="alert"'));

    // The ways this frame could lie about a request that has not returned.
    check("renders NO figure at all", figures(html).length === 0, figures(html).join(","));
    check("reports no count at all", !/\d/.test(text), text);
    check("does not claim an absent observation",
      !text.includes(NO_EXECUTION_REASON) && !text.includes(NO_SLOT_REASON), text);
    check("does not read as reassuring", !REASSURING.test(body(text)), text);
    // The surface still names itself while it loads.
    check("the surface title renders", text.includes("Scheduler"), text);

    // The prop-driven surface agrees, so the loading branch is not an accident
    // of the hook's first frame.
    const surface = renderSurface(loadingState());
    check("the surface's own loading branch matches", surface.html.includes('role="status"')
      && figures(surface.html).length === 0, surface.text);
  }

  // ── 2. A failed fetch is never a time and never zero ──────────────────────
  console.log("2. a failed fetch renders unavailable, never zero and never a clock");
  {
    const { html, text } = renderSurface(failed());

    check("states it is unavailable", text.includes("Scheduler observation unavailable"), text);
    check("explicitly disclaims a clean reading",
      text.includes("This is not a report that nothing is wrong"), text);
    check("renders it as an alert", html.includes('role="alert"'));

    check("renders NO figure at all", figures(html).length === 0, figures(html).join(","));
    check("renders no number at all", !/\d/.test(text), text);
    check("renders no clock face", !/\b\d{2}:\d{2}\b/.test(text), text);
    check("does not render the headline labels", !text.includes("Last recorded execution"), text);
    check("does not render a registry count", !/registered job/.test(text), text);
    check("does not read as reassuring", !REASSURING.test(body(text)), text);
  }

  // ── 3. Data present but the fetch failed → still unavailable ──────────────
  console.log("3. an error wins over data we happen to be holding");
  {
    const { text } = renderSurface({ data: observation(), loading: false, error: "Request failed (500)" });
    check("shows the unavailable line", text.includes("Scheduler observation unavailable"), text);
    check("does not render the held clock", !text.includes("07:30"), text);
    check("does not render the held external cron", !text.includes("resume-stale-imports"), text);
  }

  // ── 4. Three epistemic groups, each with its headline figure ──────────────
  console.log("4. observed | expected | notes, with the figures the eye lands on");
  {
    const { html, text } = renderSurface();

    for (const g of GROUPS) check(`group "${g}" renders`, text.includes(g), text);
    // Two hairlines, one between each pair, collapsing with the columns at `md`.
    check("two vertical rules separate the three groups",
      (html.match(/hidden w-px self-stretch md:block/g) ?? []).length === 2,
      `${(html.match(/hidden w-px self-stretch md:block/g) ?? []).length}`);

    // The four headline figures, as figures — not as body text.
    check("four headline figures render", figures(html).length === 4, figures(html).join(","));
    check("the observed clock is a figure", figures(html).includes("07:30"), figures(html).join(","));
    check("the expected clock is a figure", figures(html).includes("12:00"), figures(html).join(","));

    // OBSERVED — recorded facts, each carrying its derivation.
    check("the observed qualifier is signed and UTC", text.includes("1h ago · UTC"), text);
    check("the derivation names job runs, not ticks",
      text.includes("From job runs (not dispatcher ticks) · 2 recorded in the window"), text);
    check("the external cron is named", text.includes("resume-stale-imports"), text);
    check("the external-cron gap is explained", html.includes(EXTERNAL_CRON_HINT), text);

    // EXPECTED — configuration, and evidence of nothing.
    check("the expected qualifier is signed and UTC", text.includes("in 2h · UTC"), text);
    check("the expected derivation names the registry",
      text.includes("Derived from the schedules declared in the job registry"), text);
    check("the slot's jobs are named", text.includes("sync-crypto"), text);
    check("the expected figures are marked as configuration",
      text.includes("Declared configuration, not evidence that anything ran"), text);

    // NOTES — the ROUTE's prose, verbatim, and no figure of its own.
    for (const n of [...SCHEDULER_NOTES, EXTERNAL_CRON_NOTE]) {
      check(`route note rendered: "${n.slice(0, 40)}…"`, text.includes(n), text.slice(0, 200));
    }
    check("provenance names the registry module", text.includes("lib/jobs/registry"), text);
    check("the missing cron cadence is stated, not invented",
      text.includes(CRON_CADENCE_REASON) && !/\d[,\d* ]+\* \* \*/.test(text), text);

    // The header note is the count this route actually serves.
    check("the header carries the registry count", text.includes("3 registered jobs"), text);

    // The hints that stop each column being misread are exposed to AT, not
    // hover-only.
    check("the observed column explains its epistemic status", html.includes(OBSERVED_HINT), html.slice(0, 400));

    // NO scheduler-health verdict, ever.
    check("claims no scheduler health", !REASSURING.test(body(text)), text);
    check("claims no tick", !/last tick|dispatcher tick(?!s)/i.test(text.replace("not dispatcher ticks", "")), text);
  }

  // ── 5. An absent instant is a reason, never a zero clock ──────────────────
  console.log("5. nothing observed renders as absent-with-a-reason, never as 00:00");
  {
    const { html, text } = renderSurface(ok(observation({ runs: [], nextSlotAt: null, jobsInNextSlot: [] })));

    check("no execution says why", text.includes(NO_EXECUTION_REASON), text);
    check("no slot says why", text.includes(NO_SLOT_REASON), text);
    check("never renders midnight", !text.includes("00:00"), text);
    check("never renders NaN", !/NaN/.test(text), text);
    check("no relative qualifier is invented", !text.includes("· UTC"), text);
    // Only the two genuinely-observed counts remain as figures.
    check("the absent clocks are not figures", !figures(html).some((f) => /\d{2}:\d{2}/.test(f)),
      figures(html).join(","));
    check("zero external crons is worded", text.includes(NO_EXTERNAL_CRONS_QUALIFIER), text);
    check("an empty slot is worded", text.includes("no jobs declared for that slot"), text);
    check("an empty window is worded, not zeroed",
      text.includes("none recorded in the window"), text);
    check("does not read as reassuring", !REASSURING.test(body(text)), text);
  }

  // ── 6. An unreadable instant is a THIRD state ─────────────────────────────
  console.log("6. unreadable is not the same fact as absent");
  {
    const { text } = renderSurface(ok(malformed()));
    check("says the stamp is unreadable",
      (text.match(new RegExp(UNREADABLE_TIME_REASON, "g")) ?? []).length === 2, text);
    check("does not claim nothing was recorded", !text.includes(NO_EXECUTION_REASON), text);
    check("never renders midnight", !text.includes("00:00"), text);
    check("never renders NaN", !/NaN/.test(text), text);
  }

  // ── 7. Tokens only, and nothing coloured is wordless ──────────────────────
  console.log("7. tokens only; urgency is never carried by colour alone");
  {
    const { html } = renderSurface(failed());
    const populated = renderSurface().html;

    check("uses the saturated coral for the failure line", html.includes("var(--coral-400)"));
    check("never uses --coral-600", !html.includes("--coral-600"));
    check("never uses --coral-500", !html.includes("--coral-500"));
    for (const [name, markup] of [["failed", html], ["populated", populated]] as const) {
      check(`${name}: no raw hex reaches the markup`, !/#[0-9a-fA-F]{3,8}\b/.test(markup),
        markup.match(/#[0-9a-fA-F]{3,8}\b/)?.[0]);
      check(`${name}: no rgba() reaches the markup`, !/rgba?\(/.test(markup));
      check(`${name}: no coloured element without a word`,
        !/style="color:var\(--[a-z0-9-]+\)"[^>]*>\s*<\/(span|p)>/.test(markup), markup.slice(0, 300));
    }

    const widget = strip("components/platform/widgets/OpsSchedulerWidget.tsx");
    const view = strip("components/platform/widgets/scheduler-view.ts");
    for (const [name, src] of [["widget", widget], ["view", view]] as const) {
      check(`${name}: no raw hex colour`, !/#[0-9a-fA-F]{3,8}\b/.test(src), src.match(/#[0-9a-fA-F]{3,8}\b/)?.[0]);
      check(`${name}: no rgba()`, !/rgba?\(/.test(src));
      check(`${name}: no tailwind palette class`,
        !/\b(?:bg|text|border)-(?:gray|slate|zinc|blue|red|emerald|green|violet|yellow|amber|purple)-\d{2,3}\b/.test(src));
      check(`${name}: never uses --coral-600`, !src.includes("--coral-600"));
      check(`${name}: never imports the prototype`, !/from\s+["'][^"']*prototype/.test(src));
    }
  }

  // ── 8. One route, one literal url, nothing derived here ───────────────────
  console.log("8. the surface consumes the existing route and derives nothing");
  {
    const widget = strip("components/platform/widgets/OpsSchedulerWidget.tsx");
    const view = strip("components/platform/widgets/scheduler-view.ts");

    check("reads the existing scheduler route",
      widget.includes('useSharedWidgetFetch<SchedulerObservationResponse>(\n    "/api/platform/platform-ops/scheduler",\n  )')
      || /useSharedWidgetFetch<[^>]*>\(\s*"\/api\/platform\/platform-ops\/scheduler",?\s*\)/.test(widget), widget);
    check("exactly one fetch", (widget.match(/useSharedWidgetFetch</g) ?? []).length === 1);
    check("no second route is called",
      (widget.match(/"\/api\/[^"]*"/g) ?? []).length === 1, (widget.match(/"\/api\/[^"]*"/g) ?? []).join(","));
    check("the url is a string literal", !/useSharedWidgetFetch<[^>]*>\(\s*[^"\s]/.test(widget), widget);

    // The clock is READ ONCE, in the widget, and injected — never read during
    // render and never inside the pure view module.
    check("the view module never reads the clock", !/Date\.now\(\)/.test(view), view);
    check("the widget reads the clock exactly once, lazily",
      (widget.match(/Date\.now\(\)/g) ?? []).length === 1 && widget.includes("useState(() => Date.now())"));

    // No authority is re-derived: slot arithmetic, overdue detection and health
    // classification all live in lib/. A view function computing one has forked it.
    const names = [...view.matchAll(/function (\w+)/g)].map((m) => m[1]);
    check("no view function computes health/slots/overdue",
      !names.some((n) => /(Health|Slot|Overdue|Status|Severity)$/.test(n)), names.join(","));
    check("no slot arithmetic in the view module",
      !/[*/]\s*(?:60|1000|3600)/.test(view) && !/hourUTC|minuteUTC/.test(view), view);
  }

  if (failures > 0) { console.error(`\nscheduler.test: ${failures} failure(s).`); process.exit(1); }
  console.log("\nscheduler.test: all passed.");
}

main();
