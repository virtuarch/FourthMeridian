/**
 * lib/platform/intelligence/ai/compose/window-disclosure.test.ts — G1b-1 (S2 P2, 2026-11-10):
 * the asked period vs the served window ⇒ ONE deterministic disclosure note. Pure; no model,
 * no database, no clock.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/intelligence/ai/compose/window-disclosure.test.ts
 */

import type { MetricEnvelope } from "@/lib/platform/intelligence/metrics/retrieve-core";
import { monthToDateSpan, parseAskedPeriods, servedWindow, windowDisclosureText, windowMatches } from "./window-disclosure";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`  ✗ ${name}${detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`); }
}

type W = MetricEnvelope["window"];
const env = (metric: string, window: Partial<W>, asOf: string | null = "2026-11-10T08:15:00.000Z"): MetricEnvelope => ({
  metric: metric as MetricEnvelope["metric"],
  window: { kind: "ROLLING", description: "", days: null, hours: null, label: null, start: null, ...window },
  freshness: { asOf, source: "test" },
} as unknown as MetricEnvelope);
const MTD = (metric = "economics-operating-cost@1", asOf?: string | null) =>
  env(metric, { kind: "UTC_DAYS", label: "this UTC calendar month to date", start: "2026-11-01" }, asOf === undefined ? "2026-11-10T08:15:00.000Z" : asOf);
const D30 = (metric = "economics-ai-cost@1") => env(metric, { kind: "UTC_DAYS", days: 30, label: "in the last 30 days" });
const H24 = (metric = "ai-fleet-spend-status@1") => env(metric, { label: "in the last 24 hours" });
const POINT = (metric = "incident-broken-now@1") => env(metric, { kind: "POINT_IN_TIME" });
const LABELS: Record<string, string> = {
  "economics-operating-cost@1": "Estimated operating cost this cycle (by category)",
  "economics-ai-cost@1": "Estimated AI cost (7 / 30 / 90 d)",
  "ai-fleet-spend-status@1": "AI fleet spend vs budget (24 h)",
  "incident-broken-now@1": "Broken now (incidents)",
  "mystery@1": "Mystery metric",
};
const labelOf = (k: string) => LABELS[k] ?? k;
const Q_C = "What's costing me the most money in the past 30 days?";

console.log("\n1. parseAskedPeriods — deterministic, numeric and calendar phrasings");
{
  const p = (q: string) => parseAskedPeriods(q).map((a) => (a.kind === "ROLLING" ? `R${a.hours}` : a.period));
  check("G1b question ⇒ the past 30 days (720 h)", JSON.stringify(parseAskedPeriods(Q_C)) === JSON.stringify([{ kind: "ROLLING", hours: 720, phrase: "the past 30 days" }]), parseAskedPeriods(Q_C));
  check("last 7 days / 24h / 30-day / past 1 day", p("last 7 days").join() === "R168" && p("in 24h").join() === "R24" && p("the 30-day trend").join() === "R720" && parseAskedPeriods("past 1 day")[0]?.phrase === "the past day");
  check("past week / past month / trailing year (no number = one unit)", p("over the past week").join() === "R168" && p("in the past month").join() === "R720" && p("trailing year").join() === "R8760");
  check("calendar: today, yesterday, this week, this month, month to date, MTD, YTD, this year",
    p("today?").join() === "TODAY" && p("Yesterday").join() === "YESTERDAY" && p("this week").join() === "WEEK_TO_DATE"
    && p("this month").join() === "MONTH_TO_DATE" && p("month-to-date").join() === "MONTH_TO_DATE" && p("MTD spend").join() === "MONTH_TO_DATE"
    && p("YTD").join() === "YEAR_TO_DATE" && p("this year").join() === "YEAR_TO_DATE");
  check("previous calendar periods: last week / last month / previous year", p("last week").join() === "PREVIOUS_WEEK" && p("How much did Plaid cost last month?").join() === "PREVIOUS_MONTH" && p("previous year").join() === "PREVIOUS_YEAR");
  check("no window phrase ⇒ []", parseAskedPeriods("What's costing me the most money?").length === 0 && parseAskedPeriods("What is the AI cost per call?").length === 0 && parseAskedPeriods("").length === 0);
  check("deduplicated: 'past 30 days … 30 days' ⇒ one period", parseAskedPeriods("past 30 days, i.e. 30 days").length === 1);
  check("scrubbed placeholders are not periods ('[number] days')", parseAskedPeriods("past [number] days").length === 0);
}

console.log("\n2. servedWindow — envelope data only");
{
  check("month to date with a reader start + as-of ⇒ '1–10 Nov 2026 (month to date, UTC)'", JSON.stringify(servedWindow(MTD())) === JSON.stringify({ kind: "MONTH_TO_DATE", text: "1–10 Nov 2026 (month to date, UTC)" }), servedWindow(MTD()));
  check("…no as-of ⇒ 'since 1 Nov 2026'; no start ⇒ 'this month to date (UTC)' (never inferred)",
    (servedWindow(MTD(undefined, null)) as { text: string }).text === "since 1 Nov 2026 (month to date, UTC)"
    && (servedWindow(env("x@1", { label: "this UTC calendar month to date" })) as { text: string }).text === "this month to date (UTC)");
  check("monthToDateSpan: same day / before start / month rollover / bad start",
    monthToDateSpan("2026-11-01", "2026-11-01T03:00:00Z") === "1 Nov 2026" && monthToDateSpan("2026-11-05", "2026-11-01T00:00:00Z") === "since 5 Nov 2026"
    && monthToDateSpan("2026-11-01", "2026-12-01T00:30:00Z") === "1 Nov 2026 – 1 Dec 2026" && monthToDateSpan("nope", "2026-11-10T00:00:00Z") === null);
  check("rolling: 30 days / 24 hours / label-only 7 days", (servedWindow(D30()) as { text: string }).text === "the last 30 days" && (servedWindow(H24()) as { text: string }).text === "the last 24 hours"
    && JSON.stringify(servedWindow(env("x@1", { label: "in the last 7 days" }))) === JSON.stringify({ kind: "ROLLING", hours: 168, text: "the last 7 days" }));
  check("point in time ⇒ POINT; another server label ⇒ LABELLED verbatim; nothing ⇒ UNKNOWN",
    servedWindow(POINT()).kind === "POINT" && JSON.stringify(servedWindow(env("x@1", { kind: "UTC_DAYS", label: "since yesterday (UTC)" }))) === JSON.stringify({ kind: "LABELLED", text: "since yesterday (UTC)" })
    && servedWindow(env("x@1", { kind: "ROLLING" })).kind === "UNKNOWN");
  check("windowMatches: rolling = same span; this month = MTD; today = point / 24 h; everything else differs",
    windowMatches(parseAskedPeriods("past 30 days")[0], servedWindow(D30())) && !windowMatches(parseAskedPeriods("past 30 days")[0], servedWindow(MTD()))
    && windowMatches(parseAskedPeriods("this month")[0], servedWindow(MTD())) && !windowMatches(parseAskedPeriods("this month")[0], servedWindow(D30()))
    && windowMatches(parseAskedPeriods("today")[0], servedWindow(POINT())) && windowMatches(parseAskedPeriods("today")[0], servedWindow(H24()))
    && !windowMatches(parseAskedPeriods("last month")[0], servedWindow(MTD())) && !windowMatches(parseAskedPeriods("past 30 days")[0], { kind: "UNKNOWN" }));
}

console.log("\n3. windowDisclosureText — ONE deterministic note, or none");
{
  const asked30 = parseAskedPeriods(Q_C);
  const g1b = windowDisclosureText(asked30, [MTD(), MTD()], labelOf);
  check("G1b EXACT: asked the past 30 days, served month to date ⇒ the explicit substitution note",
    g1b === "Note: You asked about the past 30 days; Estimated operating cost this cycle (by category) covers 1–10 Nov 2026 (month to date, UTC) instead.", g1b);
  check("matching windows ⇒ none (30 days asked, 30-day figure; this month asked, MTD figure)",
    windowDisclosureText(asked30, [D30()], labelOf) === null && windowDisclosureText(parseAskedPeriods("this month"), [MTD()], labelOf) === null);
  check("no window in the question ⇒ none (whatever the figures cover)", windowDisclosureText(parseAskedPeriods("What's costing me the most money?"), [MTD(), H24()], labelOf) === null);
  check("no placed figure ⇒ none", windowDisclosureText(asked30, [], labelOf) === null);
  const mixed = windowDisclosureText(asked30, [MTD(), D30(), H24(), MTD()], labelOf);
  check("mixed windows ⇒ ONE note naming each affected metric once with its own window; the matching 30-day metric is not listed",
    mixed === "Note: You asked about the past 30 days; these figures cover other periods instead: Estimated operating cost this cycle (by category) covers 1–10 Nov 2026 (month to date, UTC); AI fleet spend vs budget (24 h) covers the last 24 hours."
    && (mixed.match(/Note: /g) ?? []).length === 1, mixed);
  const same = windowDisclosureText(asked30, [MTD(), MTD("economics-provider-cost@1")], (k) => (k === "economics-provider-cost@1" ? "Estimated provider cost this cycle (Plaid)" : labelOf(k)));
  check("two metrics, one served window ⇒ plural 'cover'", same === "Note: You asked about the past 30 days; Estimated operating cost this cycle (by category) and Estimated provider cost this cycle (Plaid) cover 1–10 Nov 2026 (month to date, UTC) instead.", same);
  const unknown = windowDisclosureText(asked30, [env("mystery@1", { kind: "ROLLING" })], labelOf);
  check("unknown served window ⇒ 'couldn't be confirmed', never a guessed window",
    unknown === "Note: You asked about the past 30 days; the period Mystery metric covers couldn't be confirmed, so it may not match what you asked.", unknown);
  const both = windowDisclosureText(asked30, [MTD(), env("mystery@1", { kind: "ROLLING" })], labelOf);
  check("known + unknown ⇒ one note with both clauses",
    both === "Note: You asked about the past 30 days; Estimated operating cost this cycle (by category) covers 1–10 Nov 2026 (month to date, UTC) instead; the period Mystery metric covers couldn't be confirmed, so it may not match what you asked.", both);
  check("unknown is disclosed even when no period-word matches it (it can never be confirmed)", windowDisclosureText(parseAskedPeriods("this month"), [env("mystery@1", { kind: "ROLLING" })], labelOf)?.includes("couldn't be confirmed") === true);
  check("calendar asked period: last month vs MTD ⇒ disclosed", windowDisclosureText(parseAskedPeriods("last month"), [MTD()], labelOf)
    === "Note: You asked about last month; Estimated operating cost this cycle (by category) covers 1–10 Nov 2026 (month to date, UTC) instead.");
  check("today: current-state + 24 h figures answer it; a 7-day figure is disclosed",
    windowDisclosureText(parseAskedPeriods("How are we looking today?"), [POINT(), H24()], labelOf) === null
    && windowDisclosureText(parseAskedPeriods("today"), [POINT(), env("provider-outcome@1", { label: "in the last 7 days" })], labelOf) === "Note: You asked about today; provider-outcome@1 covers the last 7 days instead.");
  check("two asked periods ⇒ both named; a figure must match every one to be left out",
    windowDisclosureText(parseAskedPeriods("past 30 days and today"), [D30()], labelOf) === "Note: You asked about the past 30 days and today; Estimated AI cost (7 / 30 / 90 d) covers the last 30 days instead.");
  check("the note carries no model text: built only from the asked phrase, server labels and envelope windows",
    !/\{\{|\}\}/.test(g1b ?? "") && windowDisclosureText(asked30, [MTD()], () => "L") === "Note: You asked about the past 30 days; L covers 1–10 Nov 2026 (month to date, UTC) instead.");
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
