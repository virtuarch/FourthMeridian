/**
 * components/platform/widgets/jobs.test.ts  (S4 · the Jobs surface)
 *
 * Guards for the Jobs surface — the dominant surface of Platform Operations.
 * Standalone tsx script (house pattern):
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/platform/widgets/jobs.test.ts
 *
 * Two kinds of assertion, and the split is deliberate:
 *
 *   RENDERED   `renderToStaticMarkup` over the real components, because the
 *              claims worth pinning here are about what an operator SEES — that
 *              a never-ran job does not read as healthy, that the policy column
 *              says the absence out loud, that a failed fetch is not a zero.
 *              Source-scanning those would prove only that a string exists.
 *
 *   SOURCE     a handful of structural rules a static render cannot see: the
 *              responsive collapse is a `md:` variant rather than a JS viewport
 *              read, the surface fetches exactly one static url, and nothing is
 *              imported from the gitignored prototype tree.
 *
 * THE INVARIANT THIS FILE EXISTS FOR: the surface must not author a fact. It may
 * format, order, filter and lay out. The moment it decides a health state, or
 * fills the policy column with something, it has forked `lib/jobs/health.ts` or
 * invented an authority that does not exist.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ATTENTION_STATUSES,
  FILTER_LABELS,
  JOBS_FILTERS,
  NEVER_RAN_REASON,
  NO_SLOT_REASON,
  POLICY_UNRECORDED_REASON,
  attentionCount,
  cadenceLine,
  filterJobs,
  fmtUtc,
  jobSource,
  lastExecutionCell,
  nextExpectedCell,
  orderJobs,
} from "./jobs-view";
import { JobRowDetail, JobsSurface, JobsTable } from "./OpsJobHealthWidget";
import { JobDetailBody } from "./JobDetailPanel";
import { relTime, statusLabel } from "./job-health-format";
import type {
  PlatformJobHealthResponse,
  PlatformJobRow,
} from "@/app/api/platform/platform-ops/job-health/route";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const ROOT = process.cwd();
const strip = (rel: string) =>
  readFileSync(path.join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

const WIDGET = "components/platform/widgets/OpsJobHealthWidget.tsx";
const PANEL = "components/platform/widgets/JobDetailPanel.tsx";
const VIEW = "components/platform/widgets/jobs-view.ts";

// ── Fixtures ─────────────────────────────────────────────────────────────────
// Shaped exactly like the route's `PlatformJobRow`. NOW is fixed so every
// relative time in this file is deterministic.

const NOW = Date.parse("2026-07-26T09:12:00.000Z");

function row(over: Partial<PlatformJobRow> & Pick<PlatformJobRow, "job" | "status">): PlatformJobRow {
  return {
    expectedEveryHours: 24,
    lastStartedAt: "2026-07-26T06:00:00.000Z",
    lastRunStatus: "succeeded",
    lastCompletedAt: "2026-07-26T06:00:42.000Z",
    consecutiveFailures: 0,
    nextExpectedAt: "2026-07-27T06:00:00.000Z",
    lastRuntimeMs: 42_000,
    avgRuntimeMs: 38_500,
    successRate: 1,
    totalRuns: 12,
    succeededRuns: 12,
    failedRuns: 0,
    manualRuns: 0,
    lastFailureAt: null,
    lastFailureSummary: null,
    ...over,
  };
}

const healthy = row({ job: "sync-banks", status: "healthy" });

const failing = row({
  job: "fetch-fx-rates",
  status: "failing",
  consecutiveFailures: 3,
  successRate: 0.75,
  totalRuns: 12,
  succeededRuns: 9,
  failedRuns: 3,
  lastFailureAt: "2026-07-26T06:30:00.000Z",
  lastFailureSummary: "openexchangerates: 429 rate limited",
});

const overdue = row({
  job: "purge-trash",
  status: "overdue",
  lastStartedAt: "2026-07-24T07:30:00.000Z",
});

/** Never ran: no ledger row at all. Every metric the route derives is null/zero. */
const neverRan = row({
  job: "evaluate-alerts",
  status: "never-ran",
  lastStartedAt: null,
  lastRunStatus: null,
  lastCompletedAt: null,
  lastRuntimeMs: null,
  avgRuntimeMs: null,
  successRate: null,
  totalRuns: 0,
  succeededRuns: 0,
  failedRuns: 0,
});

/** No registry slot on the response — source and next-expected are both unknown. */
const slotless = row({ job: "sync-crypto", status: "healthy", expectedEveryHours: 6, nextExpectedAt: null });

const ROWS: PlatformJobRow[] = [healthy, failing, overdue, neverRan, slotless];

const response: PlatformJobHealthResponse = {
  healthy: false,
  checkedAt: "2026-07-26T09:12:00.000Z",
  counts: { healthy: 2, running: 0, overdue: 1, failing: 1, dead: 0, neverRan: 1 },
  jobs: ROWS,
};

const noop = () => {};

const table = (rows: readonly PlatformJobRow[]) =>
  renderToStaticMarkup(createElement(JobsTable, { rows, onOpen: noop, nowMs: NOW }));

const surface = (over: Partial<Parameters<typeof JobsSurface>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(JobsSurface, {
      title: "Job Health",
      data: response,
      loading: false,
      error: null,
      nowMs: NOW,
      ...over,
    }),
  );

function main() {
  const widgetSrc = strip(WIDGET);
  const panelSrc = strip(PANEL);
  const viewSrc = strip(VIEW);

  // ── 1 · every column of the prototype's table renders ───────────────────────
  console.log("\n1. the six-column table renders every column");
  {
    const html = table(ROWS);
    const t = text(html);

    for (const heading of [
      "Job",
      "Health",
      "Policy",
      "Source",
      "Last recorded execution",
      "Next expected",
    ]) {
      check(`column header "${heading}"`, t.includes(heading), t.slice(0, 400));
    }

    check("JOB — the job name", t.includes("sync-banks"));
    check("JOB — cadence as the second identity line", t.includes("Daily") && t.includes("Every 6h"));
    check("HEALTH — the status word", t.includes("Healthy") && t.includes("Failing") && t.includes("Overdue"));
    check("POLICY — the absence, in words", t.includes(POLICY_UNRECORDED_REASON));
    check("SOURCE — the proven provenance", t.includes("registry"));
    check("LAST RECORDED EXECUTION — a UTC time", t.includes("26 Jul 06:00"));
    check("LAST RECORDED EXECUTION — its relative qualifier", t.includes("3h ago"));
    check("NEXT EXPECTED — a UTC time and its qualifier", t.includes("27 Jul 06:00") && t.includes("expected"));
    check("a row menu exists and is named for its job", html.includes("Commands for sync-banks"));
    check("the row menu is inert, not a live write", /Commands for sync-banks[^>]*/.test(html) && html.includes("disabled="));
    check("row expansion is announced", html.includes('aria-expanded="false"'));
  }

  // ── 2 · colour never travels alone ──────────────────────────────────────────
  console.log("\n2. a health dot is never the only carrier");
  {
    const html = table([healthy]);
    const dots = html.match(/aria-hidden="true" class="rounded-full"/g) ?? [];
    check("the dot is decorative", dots.length >= 1, html.slice(0, 600));
    check("the word rides with it", text(html).includes("Healthy"));
    check(
      "removing colour leaves the state readable",
      text(html.replace(/style="[^"]*"/g, "")).includes("Healthy"),
    );
  }

  // ── 3 · "never ran" is not "healthy", and not a zero ────────────────────────
  console.log("\n3. never-ran reads as never-ran");
  {
    const html = table([neverRan]);
    const t = text(html);
    check("the status word is the authority's own", t.includes(statusLabel("never-ran")));
    check("it does NOT read as healthy", !t.includes("Healthy"), t);
    check("last execution states the reason", t.includes(NEVER_RAN_REASON));
    check("no fabricated last-run time", !/\d\d? [A-Z][a-z]{2} \d\d:\d\d/.test(t.split("Next expected")[0] ?? t));

    const detail = renderToStaticMarkup(
      createElement(JobRowDetail, { job: neverRan, onOpen: noop, nowMs: NOW }),
    );
    const d = text(detail);
    check("an unrecorded success rate is an em-dash, not 0%", d.includes("—") && !d.includes("0%"), d);
    check("an unrecorded runtime is an em-dash, not 0ms", !d.includes("0ms"), d);
    check("runs in window are the ledger's real zeros", d.includes("0/0"), d);
  }

  // ── 4 · loading ≠ empty ≠ error ≠ populated ─────────────────────────────────
  console.log("\n4. the four states are four different renders");
  {
    const loading = surface({ loading: true, data: null });
    const errored = surface({ loading: false, error: "Not authorized", data: null });
    const empty = surface({
      data: {
        ...response,
        counts: { healthy: 0, running: 0, overdue: 0, failing: 0, dead: 0, neverRan: 0 },
        jobs: [],
      },
    });
    const populated = surface();

    check("loading says loading", text(loading).includes("Loading"));
    check("error says what failed", text(errored).includes("Not authorized"));
    check("empty says the registry is empty", text(empty).includes("No scheduled jobs are registered."));
    check("the four renders are all distinct", new Set([loading, errored, empty, populated]).size === 4);

    check("a failed fetch renders NO count pill", !/>0</.test(errored), text(errored));
    check("a failed fetch renders no job rows", !text(errored).includes("sync-banks"));
    check("a failed fetch never reads as healthy", !text(errored).includes("Healthy"), text(errored));
    check("loading is not the empty message", !text(loading).includes("No scheduled jobs"));
    check(
      "an EMPTY registry still says zero honestly (it is an answer, not a failure)",
      text(empty).includes("0"),
    );
    check(
      "the surface frame survives every state",
      [loading, errored, empty, populated].every((h) => text(h).includes("Job Health")),
    );
  }

  // ── 5 · the policy column states the missing authority ──────────────────────
  console.log("\n5. POLICY is absent, and says so");
  {
    const html = table(ROWS);
    const cells = (html.match(new RegExp(POLICY_UNRECORDED_REASON, "g")) ?? []).length;
    check("every row states it", cells >= ROWS.length, `${cells} of ${ROWS.length}`);
    check("no policy chip is ever rendered", !/PolicyChip/.test(widgetSrc), widgetSrc.slice(0, 200));
    check(
      "no fabricated policy vocabulary anywhere on the surface",
      !/Paused|Skip next|Disabled|Resume|Maintenance engaged/.test(text(html)),
      text(html),
    );
    check(
      "the footnote explains the blank column rather than leaving it implied",
      text(surface()).includes("records none today"),
    );
    check(
      "the panel says it too, at length",
      text(
        renderToStaticMarkup(createElement(JobDetailBody, { job: healthy, tab: "overview", nowMs: NOW })),
      ).includes("does not record job policy"),
    );
    check(
      "the 'Has policy' filter is not shipped as a fake zero",
      !Object.values(FILTER_LABELS).includes("Has policy") && JOBS_FILTERS.length === 2,
    );
  }

  // ── 6 · filtering and search are pure selection over returned rows ──────────
  console.log("\n6. filter pills and search narrow the view, and only the view");
  {
    const attention = filterJobs(ROWS, "attention", "");
    check("Attention selects exactly the attention statuses", attention.every((r) => ATTENTION_STATUSES.includes(r.status)));
    check("Attention omits healthy jobs", !attention.some((r) => r.status === "healthy"));
    check("Attention omits never-ran (not a fault)", !attention.some((r) => r.status === "never-ran"));
    check(
      "the pill figure is the ROUTE's count, and the selection agrees with it",
      attentionCount(response.counts) === attention.length,
      `${attentionCount(response.counts)} vs ${attention.length}`,
    );
    check("All selects everything", filterJobs(ROWS, "all", "").length === ROWS.length);

    const searched = filterJobs(ROWS, "all", "SYNC");
    check("search is case-insensitive and substring", searched.length === 2, JSON.stringify(searched.map((r) => r.job)));
    check("search composes with a filter", filterJobs(ROWS, "attention", "purge").length === 1);
    check("no match yields an empty selection, not everything", filterJobs(ROWS, "all", "zzz").length === 0);

    const filtered = table(attention);
    check("the rendered table shows only the selected rows", !text(filtered).includes("sync-banks"), text(filtered));
    check("and does show the selected ones", text(filtered).includes("fetch-fx-rates"));
    check("an empty selection renders a message, not a blank table", text(table([])).includes("No jobs match."));

    /* The hook name is assembled at runtime so this guard never looks like a
       call site to widget-fetch-static-url.test.ts, which scans every .tsx? file
       under components/ and app/ — including this one. */
    const HOOK = "useWidget" + "Fetch";
    const mentions = (widgetSrc.match(new RegExp(HOOK, "g")) ?? []).length;
    check(
      "filtering never refetches — exactly one import and one call site",
      mentions === 2,
      `${mentions} mentions`,
    );
    check(
      "and that call site names the one existing route, statically",
      widgetSrc.includes('"/api/platform/platform-ops/job-health"'),
    );
    check(
      "no other route is consumed",
      (widgetSrc.match(/["']\/api\//g) ?? []).length === 1,
    );
  }

  // ── 7 · ordering and counting are not a second authority ────────────────────
  console.log("\n7. ordering and counting defer to the authorities that own them");
  {
    const ordered = orderJobs(ROWS).map((r) => r.job);
    check("worst first", ordered[0] === "fetch-fx-rates", ordered.join(","));
    check("then alphabetical within a rank", ordered.indexOf("sync-banks") < ordered.indexOf("sync-crypto"));
    check("ordering keeps every row", ordered.length === ROWS.length);
    check("ordering does not mutate the input", ROWS[0].job === "sync-banks");

    check(
      "ATTENTION_STATUSES restates the route's own count fields",
      ATTENTION_STATUSES.length === 3 &&
        ["dead", "failing", "overdue"].every((s) => ATTENTION_STATUSES.includes(s as never)),
    );
    check(
      "the view module never classifies a job",
      !/classifyJobHealth|expectedEveryHours\s*[*+]|Date\.now\(\)/.test(viewSrc),
      viewSrc.slice(0, 200),
    );
    check("status words come from the shared vocabulary", !/["']Healthy["']|["']Failing["']/.test(viewSrc));
  }

  // ── 8 · source is derived, never guessed ────────────────────────────────────
  console.log("\n8. SOURCE is proven or unknown — never guessed");
  {
    check("a registry slot proves the registry", jobSource(healthy) === "registry");
    check("no slot proves nothing", jobSource(slotless) === null);
    check("the surface never invents vercel.json", !/vercel\.json/.test(text(table(ROWS))));
    const html = table([slotless]);
    check("an unprovable source renders the no-authority chip", text(html).includes("no authority"), text(html));
    check("and its next-expected states the reason", text(html).includes(NO_SLOT_REASON));
    check("nextExpectedCell refuses to invent a time", nextExpectedCell(slotless) === null);
    check("lastExecutionCell refuses to invent a time", lastExecutionCell(neverRan, () => "x") === null);
  }

  // ── 9 · the detail panel renders its sections ───────────────────────────────
  console.log("\n9. the job detail panel");
  {
    const overview = text(
      renderToStaticMarkup(createElement(JobDetailBody, { job: failing, tab: "overview", nowMs: NOW })),
    );
    for (const s of ["Policy", "Health", "Recent executions", "Runtime", "Metadata"]) {
      check(`Overview renders the "${s}" section`, overview.includes(s), overview.slice(0, 300));
    }
    check("Policy leads Health", overview.indexOf("Policy") < overview.indexOf("Health"));
    check("the verdict slot states the missing resolver", overview.includes("may run is not recorded"));
    check("health figures are the ledger's", overview.includes("75%") && overview.includes("42.0s"));
    check("the last error is shown in words", overview.includes("429 rate limited"));
    check(
      "the streak is labelled for what the route actually counts",
      overview.includes("Consecutive failures") && !overview.includes("Longest failure streak"),
    );
    check("no execution strip is drawn without a run series", overview.includes("Per-run history is not exposed"));
    check("no runtime trend is drawn without a run series", overview.includes("no trend to draw"));
    check("metadata refuses to invent a handler", overview.includes("not on this response"));

    const controls = text(
      renderToStaticMarkup(createElement(JobDetailBody, { job: failing, tab: "controls", nowMs: NOW })),
    );
    check("Controls renders its sections", controls.includes("Blast radius") && controls.includes("Commands"));
    check("Controls offers no command", controls.includes("No job control authority exists"));
    check("Controls has no button at all", !renderToStaticMarkup(
      createElement(JobDetailBody, { job: failing, tab: "controls", nowMs: NOW }),
    ).includes("<button"));

    const log = text(
      renderToStaticMarkup(createElement(JobDetailBody, { job: failing, tab: "log", nowMs: NOW })),
    );
    check("Decision log renders its section", log.includes("Decision log"));
    check("Decision log lists nothing rather than inventing an entry", log.includes("no operator decision"));

    check("the panel never fetches", !/fetch\(|useWidgetFetch|useKeyedFetch/.test(panelSrc), panelSrc.slice(0, 200));
    check("the panel is a RightPanel, not a bespoke overlay", /RightPanel/.test(panelSrc) && !/createPortal|fixed inset-0/.test(panelSrc));
    check("all three tabs are shipped", /"Overview"/.test(panelSrc) && /"Controls"/.test(panelSrc) && /"Decision log"/.test(panelSrc));
    check("the footer's write control is inert and says why", /disabled\s*\n?\s*title=\{NO_COMMANDS_REASON\}/.test(panelSrc));
    check("content is keyed on the job so the tab resets", /key=\{job\.job\}/.test(panelSrc));
  }

  // ── 10 · responsive: the page never scrolls sideways ────────────────────────
  console.log("\n10. responsive — by class, and never at the page's expense");
  {
    const html = table(ROWS);
    check("the table owns a horizontal-scroll container", html.includes("overflow-x-auto"));
    check(
      "the six-column grid is a md: variant, not an unconditional grid",
      html.includes("md:grid") && !/class="[^"]*\bgrid items-center/.test(html),
      html.slice(0, 500),
    );
    check("the column header is suppressed below md", /class="[^"]*hidden[^"]*md:grid/.test(html));
    check(
      "the four dropped columns reappear inside the row expansion",
      text(
        renderToStaticMarkup(createElement(JobRowDetail, { job: healthy, onOpen: noop, nowMs: NOW })),
      ).includes("Last recorded execution"),
    );
    check("no viewport hook is ported", !/useNarrowViewport|innerWidth|matchMedia/.test(widgetSrc));
    check("no fixed pixel width forces overflow", !/minWidth:\s*\d{3}/.test(widgetSrc));
  }

  // ── 11 · tokens, prototype containment, accessibility ───────────────────────
  console.log("\n11. tokens, containment, accessible names");
  {
    for (const [label, src] of [["widget", widgetSrc], ["panel", panelSrc], ["view", viewSrc]] as const) {
      check(`${label} imports nothing from the prototype tree`, !/from\s+["'].*prototype/.test(src));
      check(`${label} uses no raw hex`, !/#[0-9a-fA-F]{3,8}\b/.test(src), src.slice(0, 200));
      check(`${label} uses no rgba()`, !/rgba\(/.test(src));
      check(`${label} uses no tailwind palette class`, !/\b(?:bg|text|border)-(?:gray|blue|red|emerald|green|amber|yellow|violet|purple)-\d{2,3}\b/.test(src));
    }
    check("the forbidden coral-600 never carries small text", !/--coral-600/.test(widgetSrc + panelSrc));

    const html = table(ROWS);
    check("the icon-only row menu has an accessible name", /aria-label="Commands for [^"]+"/.test(html));
    check("row expansion carries aria-expanded", html.includes("aria-expanded"));
    const s = surface();
    check("the maintenance control is inert with a stated reason", s.includes("no job control authority exists"));
    check("the search input has an accessible name", s.includes("Search jobs"));
    check("the filter pills expose their pressed state", s.includes('aria-pressed="true"'));
  }

  // ── 12 · pure formatters ────────────────────────────────────────────────────
  console.log("\n12. formatting is UTC and deterministic");
  {
    check("fmtUtc reads UTC parts", fmtUtc("2026-07-27T00:00:00.000Z") === "27 Jul 00:00");
    check("fmtUtc can name its zone", fmtUtc("2026-07-27T00:00:00.000Z", true) === "27 Jul 00:00 UTC");
    check("fmtUtc refuses a null", fmtUtc(null) === null);
    check("fmtUtc refuses a garbage string", fmtUtc("not a date") === null);
    check("cadence rides as the identity line", cadenceLine(healthy) === "Daily" && cadenceLine(slotless) === "Every 6h");
    check("relTime is injected, never read from the wall clock in a cell", relTime(healthy.lastStartedAt, NOW) === "3h ago");
  }

  console.log(
    failures === 0
      ? "\nAll Jobs-surface guards pass.\n"
      : `\n${failures} guard(s) failed.\n`,
  );
  if (failures > 0) process.exit(1);
}

main();
