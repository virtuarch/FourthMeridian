/**
 * components/space/shell/timeline-lens-exclusivity.test.ts
 *
 * Phase 2 deletion guard — ONE canonical time selector, unconditionally.
 *
 * Before deletion this file proved the two paths were mutually exclusive. That
 * question is gone: there is no second path. It now proves the stronger property
 * — the legacy controls are deleted, cannot return, and TimelineLens renders for
 * every Perspective with no branch to take.
 *
 * It RENDERS PerspectiveShell rather than scanning it, because the property is
 * about what reaches the user, and rendering is the only thing that distinguishes
 * "present in source" from "present on screen".
 *
 * Pure, DB-free:  npx tsx components/space/shell/timeline-lens-exclusivity.test.ts
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PerspectiveTimeState } from "@/lib/perspectives/time-range";
import { PerspectiveShell } from "./PerspectiveShell";
import { PERIOD_OPTIONS, shellActionForIntent, summarize } from "./perspective-time-adapter";
import { COMPLETENESS_PRESENTATION, resolvePerspectiveEnvelope } from "@/lib/perspectives/envelope";

let failures = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) { console.log(`  ✓ ${label}`); return; }
  console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  failures++;
}

const ROOT = process.cwd();
const TODAY = "2026-07-19";
const TIME: PerspectiveTimeState = { preset: "MTD", asOf: TODAY, compareTo: "2026-07-01" };
const HISTORICAL: PerspectiveTimeState = { preset: "YTD", asOf: "2026-03-31", compareTo: "2026-01-01" };
const PERSPECTIVES = ["wealth", "cashFlow", "investments", "debt", "liquidity"];

const noop = () => {};
function render(
  time: PerspectiveTimeState = TIME,
  temporalCapability: unknown = { asOf: "full", compareTo: "full", period: "none" },
  envelope: unknown = {},
) {
  return renderToStaticMarkup(
    h(PerspectiveShell as never, {
      today: TODAY,
      onAsOfChange: noop,
      onCompareToChange: noop,
      onSwap: noop,
      onSelectPreset: noop,
      envelope,
      temporalCapability,
      timeState: time,
      tabs: [],
      activeTabId: null,
      onSelectTab: noop,
    } as never),
  );
}

const LENS = (html: string) => html.includes('aria-label="Change time period"');
const LEGACY_SLICER = (html: string) => html.includes('aria-label="Cash flow period');
const LEGACY_DATES = (html: string) => html.includes('aria-label="As of date"');
const LEGACY_SWAP = (html: string) => html.includes('aria-label="Swap As of and Compare to dates"');

// ── 1. The legacy files are gone and cannot come back ────────────────────────
console.log("1. Deleted — the legacy controls no longer exist");
{
  const DELETED = [
    "components/space/widgets/CashFlowPeriodSelector.tsx",
    "components/space/shell/ShellContextRow.tsx",
    "components/space/shell/timeline-lens-rollout.ts",
  ];
  for (const rel of DELETED) {
    check(`${rel} is deleted`, !existsSync(path.join(ROOT, rel)));
  }

  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".next" || entry.name === "prototype") continue;
        walk(full);
      } else if (/\.tsx?$/.test(entry.name) && !full.endsWith("exclusivity.test.ts")) {
        const src = readFileSync(full, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
        if (/from\s+"[^"]*(CashFlowPeriodSelector|ShellContextRow|timeline-lens-rollout)"/.test(src)) {
          offenders.push(path.relative(ROOT, full));
        }
      }
    }
  };
  for (const d of ["components", "app", "lib"]) walk(path.join(ROOT, d));
  check("nothing imports the deleted modules", offenders.length === 0, offenders.join(", "));
}

// ── 2. TimelineLens renders unconditionally — there is no branch ─────────────
console.log("2. One selector, no branch");
{
  const shellSrc = readFileSync(path.join(ROOT, "components/space/shell/PerspectiveShell.tsx"), "utf8");
  const stripped = shellSrc.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");

  check("PerspectiveShell renders TimelineLens", stripped.includes("<TimelineLens"));
  check("no rollout flag remains", !stripped.includes("usesTimelineLens"));
  check("no conditional selector branch remains", !/useLens\s*\?/.test(stripped));

  for (const time of [TIME, HISTORICAL]) {
    const html = render(time);
    const label = time === TIME ? "present" : "historical";
    check(`${label}: renders TimelineLens`, LENS(html));
    check(`${label}: renders NO legacy preset slicer`, !LEGACY_SLICER(html));
    check(`${label}: renders NO legacy date inputs`, !LEGACY_DATES(html));
    check(`${label}: renders NO legacy swap`, !LEGACY_SWAP(html));
    check(`${label}: exactly one lens trigger`,
      (html.match(/aria-label="Change time period"/g) ?? []).length === 1);
  }

  // Capability still gates the explicit boundary fields, never the selector itself.
  const gated = render(TIME, { asOf: "none", compareTo: "none", period: "full" });
  check("a lens with no explicit date axis STILL gets the selector", LENS(gated));
}

// ── 3. The behavioral adapter seam survived the deletion ─────────────────────
console.log("3. Intent callbacks preserved — adapters, not legacy plumbing");
{
  // The load-bearing distinction of Phase 2. These four LOOK like legacy selector
  // plumbing but are how every TimelineIntent reaches the host: the adapter
  // resolves an intent into a sanctioned ShellTimeAction and the shell dispatches
  // it through exactly these. Losing onSelectPreset would bypass handleSelectSlice
  // and strand cashFlowExplicitPeriod — Cash Flow would stay pinned to a drilled
  // month while every other Perspective moved.
  const shellSrc = readFileSync(path.join(ROOT, "components/space/shell/PerspectiveShell.tsx"), "utf8");
  for (const cb of ["onSelectPreset", "onAsOfChange", "onCompareToChange", "onSwap"]) {
    check(`${cb} is still a prop`, new RegExp(`${cb}:\\s*\\(`).test(shellSrc));
    check(`${cb} is still dispatched by handleTimelineIntent`, new RegExp(`props\\.${cb}\\(`).test(shellSrc));
  }
  check("every ShellTimeAction the adapter can emit has a dispatch arm",
    ["selectPreset", "setAsOf", "setCompareTo", "swap", "clearCompareTo"]
      .every((a) => shellSrc.includes(`case "${a}":`)));

  const host = readFileSync(path.join(ROOT, "components/dashboard/SpaceDashboard.tsx"), "utf8");
  check("the host still routes presets through handleSelectSlice",
    /onSelectPreset=\{handleSelectSlice\}/.test(host));
  check("handleSelectSlice still clears the Cash-Flow override",
    /isExplicitPeriod\(slice\)[\s\S]{0,400}setCashFlowExplicitPeriod\(null\)/.test(host));
}

// ── 3b. The period control still DRIVES the window ───────────────────────────
console.log("3b. Period choices intact; the range pill follows the selected period");
{
  check("every existing period option still resolves to a preset selection",
    PERIOD_OPTIONS.length > 0 && PERIOD_OPTIONS.every((o) => {
      const r = shellActionForIntent({ type: "period", optionId: o.id } as never, { today: TODAY });
      return r.ok && r.action.type === "selectPreset";
    }));
  const rangeOf = (html: string) => html.match(/<span[^>]*data-timeline-range[^>]*>([\s\S]*?)<\/span>\s*<\/span>/)?.[1].replace(/<[^>]+>/g, "").trim() ?? "";
  const triggerOf = (html: string) => (html.match(/<button[^>]*data-timeline-period[\s\S]*?<\/button>/)?.[0] ?? "").replace(/<[^>]+>/g, "").trim();
  const a = render(TIME), b = render(HISTORICAL);
  // The pill prints the ADAPTER's resolved range verbatim — no date math in the component.
  check("the range pill is the canonical resolved range (present)", rangeOf(a) === summarize(TIME, TODAY).rangeLabel, rangeOf(a));
  check("the range pill is the canonical resolved range (historical)", rangeOf(b) === summarize(HISTORICAL, TODAY).rangeLabel, rangeOf(b));
  check("a different period ⇒ a different resolved range", rangeOf(a) !== rangeOf(b) && rangeOf(a).includes("→"));
  check("the trigger shows the selected period and ONLY that", triggerOf(a) === summarize(TIME, TODAY).periodLabel && triggerOf(b) === summarize(HISTORICAL, TODAY).periodLabel,
    `${triggerOf(a)} | ${triggerOf(b)}`);
  const tabbed = renderToStaticMarkup(h(PerspectiveShell as never, {
    today: TODAY, onAsOfChange: noop, onCompareToChange: noop, onSwap: noop, onSelectPreset: noop, envelope: {},
    temporalCapability: { asOf: "full", compareTo: "full", period: "none" }, timeState: TIME,
    tabs: [{ id: "wealth", label: "Net Worth" }, { id: "cashFlow", label: "Cash Flow" }], activeTabId: "wealth", onSelectTab: noop,
  } as never));
  check("the Net Worth / Cash Flow lens tabs still render, BELOW the time row",
    tabbed.includes("Net Worth") && tabbed.includes("Cash Flow") && tabbed.indexOf("data-timeline-period") < tabbed.indexOf("Net Worth"));
}

// ── 4. Provenance chrome is OFF the Overview header; caveats are not ─────────
console.log("4. No Completeness / Evidence pills in the shell — caveats still render");
{
  // An envelope as a real perspective resolves it: observed, with evidence rows.
  const DEFAULT_CAP = { asOf: "full", compareTo: "full", period: "none" };
  const full = render(TIME, DEFAULT_CAP, {
    completeness: { tier: "observed", label: "Observed", tone: "positive", detail: "A provider or you stated this value for this date." },
    evidence: { label: "2 accounts", rows: [{ label: "Chase", tier: "observed" }, { label: "Amex", tier: "observed" }] },
  });
  check("no 'Completeness' pill", !full.includes("Completeness"));
  check("no 'Observed' status pill", !full.includes("Observed"));
  check("no 'Evidence' pill and no 'N accounts' count", !full.includes("Evidence") && !full.includes("2 accounts"));
  // A caveat is not status chrome: "FX rate unavailable" means a total is partial.
  const warned = render(TIME, DEFAULT_CAP, { warnings: [{ kind: "fx", label: "FX rate unavailable", detail: "EUR had no rate." }] });
  check("an orthogonal caveat still renders in the shell", warned.includes("FX rate unavailable"));
  check("no caveat ⇒ the trust row renders NOTHING (no empty wrapper)", !render().includes("AlertTriangle") && !/<div class="flex flex-wrap items-center gap-2 ?"><\/div>/.test(render()));
}

// ── 5. The closed readout: period + resolved range, no "AS OF" label ─────────
console.log("5. Period trigger + separate resolved range, for every capability shape");
{
  const range = (html: string) => html.match(/<span[^>]*data-timeline-range[^>]*>([\s\S]*?)<\/span>\s*<\/span>/)?.[1].replace(/<[^>]+>/g, "").trim() ?? null;
  const trigger = (html: string) => html.match(/<button[^>]*data-timeline-period[\s\S]*?<\/button>/)?.[0] ?? "";
  for (const id of PERSPECTIVES) {
    const cap = id === "debt" || id === "liquidity"
      ? { asOf: "partial", compareTo: "partial", period: "none" }
      : { asOf: "full", compareTo: "full", period: id === "cashFlow" ? "full" : "none" };
    const present = render(TIME, cap);
    const past = render(HISTORICAL, cap);
    check(`${id}: no 'As of today' / 'As of …' label in the closed control`, !/As of/i.test(present) && !/As of/i.test(past));
    check(`${id}: the range is its OWN element, outside the trigger`, range(past) !== null && !trigger(past).includes("→"));
    check(`${id}: a historical anchor is still cued, structurally`, past.includes('data-anchored="past"') && present.includes('data-anchored="present"'));
    check(`${id}: the trigger is a real button that opens the period dialog`, /aria-haspopup="dialog"/.test(trigger(present)) && !/disabled=""/.test(trigger(present)));
    check(`${id}: still states the resolved window`, past.includes("Jan 1, 2026"));
    check(`${id}: no present-tense period claim`, !/>This (week|month|quarter|year)</.test(past));
  }
}

// ── 6. The architecture behind the removed pills is intact ───────────────────
console.log("6. Completeness / evidence still RESOLVED — only the header presentation went");
{
  check("all five canonical completeness tiers still present, 'Observed' included",
    ["observed", "derived", "estimated", "incomplete", "unknown"].every((t) => t in COMPLETENESS_PRESENTATION) && COMPLETENESS_PRESENTATION.observed.label === "Observed");
  const env = resolvePerspectiveEnvelope({ perspectiveId: "debt", lensResult: null });
  check("resolvePerspectiveEnvelope still returns an envelope object for a perspective", typeof env === "object" && env !== null);
  const envSrc = readFileSync(path.join(ROOT, "lib/perspectives/envelope.ts"), "utf8");
  check("the envelope contract still carries completeness, evidence and warnings",
    /completeness\?:\s*EnvelopeCompleteness/.test(envSrc) && /evidence\?:\s*EnvelopeEvidence/.test(envSrc) && /warnings\?:/.test(envSrc));
  check("the shared detail surfaces still exist (TrustIndicator + Wealth use them)",
    existsSync(path.join(ROOT, "components/space/shell/CompletenessPopover.tsx")) && existsSync(path.join(ROOT, "components/space/shell/EvidenceDrawer.tsx")));
  const trustRow = readFileSync(path.join(ROOT, "components/space/shell/ShellTrustRow.tsx"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  check("the shell trust row carries no Completeness / Evidence chip and no dead popover/drawer wiring",
    !/label="Completeness"|label="Evidence"|CompletenessPopover|EvidenceDrawer|useState/.test(trustRow));
  const shell = readFileSync(path.join(ROOT, "components/space/shell/PerspectiveShell.tsx"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  check("the 850px container-query wrapper that existed only for those chips is gone",
    !shell.includes("@container") && !shell.includes("@min-[850px]"));
  check("the host still hands the shell the active envelope (nothing upstream was unwired)", /envelope=\{props\.envelope\}/.test(shell));
}

if (failures > 0) {
  console.error(`\n${failures} deletion-guard check(s) failed.`);
  process.exit(1);
}
console.log("\nLegacy controls deleted; TimelineLens is the only canonical time selector.");
