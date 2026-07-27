/**
 * components/platform/widgets/growth-funnel.test.ts  (GROWTH-1 · growth_funnel)
 *
 * Guards for the Growth funnel surface. Standalone tsx script (house pattern):
 * npx tsx components/platform/widgets/growth-funnel.test.ts — exits 0/1.
 *
 * There is no DOM harness in this repo, so the behavioural invariants are
 * asserted where they actually live: the pure presentation model
 * (growth-funnel-view.ts) decides every figure and every subject, and the two
 * .tsx files only lay it out. Selection behaviour is therefore proven twice —
 * as subject resolution here, and as a source assertion that the panel is
 * always-mounted (which is what makes "replace without reopening" true).
 *
 * THE INVARIANT THIS FILE EXISTS FOR: the surface must not author a metric. It
 * may format, order, label and lay out; the moment it computes a conversion
 * figure it has forked `lib/platform/growth/growth.ts`.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  RATE_UNAVAILABLE,
  adjacentStages,
  barFraction,
  buildFunnelViews,
  findStage,
  formatRate,
} from "./growth-funnel-view";
import type { GrowthFunnel } from "@/lib/platform/growth/growth";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
/** Strip comments so prose describing a rule never satisfies the rule. */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const WIDGET = "components/platform/widgets/OpsGrowthWidget.tsx";
const STAGES = "components/platform/widgets/FunnelStages.tsx";
const PANEL = "components/platform/widgets/GrowthStagePanel.tsx";
const VIEW = "components/platform/widgets/growth-funnel-view.ts";

// ── Fixtures ─────────────────────────────────────────────────────────────────
// Shaped exactly like buildGrowthFunnel's output. `populated` carries real
// ratios; `empty` is the zero-denominator case the authority answers with null.

const populated: GrowthFunnel = {
  beta: {
    requested: 148, approved: 96, redeemed: 62, denied: 31, pending: 21,
    redeemedActivated: 55,
    approveRate: 96 / 148,
    redeemRate: 62 / 96,
  },
  activation: {
    totalUsers: 62, verified: 58, activated: 55, returning7: 31,
    verifyRate: 58 / 62,
    activationRate: 55 / 62,
  },
  checkedAt: "2026-07-25T09:12:00.000Z",
};

const empty: GrowthFunnel = {
  beta: {
    requested: 0, approved: 0, redeemed: 0, denied: 0, pending: 0,
    redeemedActivated: 0,
    approveRate: null, // ratio(0, 0) — the authority's own null
    redeemRate: null,
  },
  activation: {
    totalUsers: 0, verified: 0, activated: 0, returning7: 0,
    verifyRate: null,
    activationRate: null,
  },
  checkedAt: "2026-07-25T09:12:00.000Z",
};

console.log("\nGROWTH-1 — canonical funnels as the dominant surface\n");

// ── 1 · a null rate never renders a percent ──────────────────────────────────
console.log("1. a null conversion rate never renders a percentage");
{
  check("formatRate(null) is the em-dash", formatRate(null) === RATE_UNAVAILABLE);
  check("formatRate(null) contains no percent sign", !String(formatRate(null)).includes("%"));

  const views = buildFunnelViews(empty);
  const rendered = views.flatMap((v) => v.stages.map((s) => formatRate(s.rate)));
  check(
    "no stage of a zero-denominator funnel renders a percentage",
    rendered.every((r) => r == null || !r.includes("%")),
    JSON.stringify(rendered),
  );
  check(
    "every measured stage of an empty funnel renders the em-dash",
    rendered.filter((r) => r !== null).every((r) => r === RATE_UNAVAILABLE),
  );
  check("formatRate(0) renders 0%, not the em-dash (a real zero is a real ratio)", formatRate(0) === "0%");
}

// ── 2 · the first stage of each funnel shows no rate ─────────────────────────
console.log("\n2. the first stage of each funnel renders no conversion rate");
{
  for (const funnel of [populated, empty]) {
    const views = buildFunnelViews(funnel);
    for (const v of views) {
      check(
        `${v.id}: first stage (${v.stages[0].label}) has an undefined rate`,
        v.stages[0].rate === undefined,
      );
      check(
        `${v.id}: first stage formats to nothing at all (not an em-dash)`,
        formatRate(v.stages[0].rate) === null,
      );
    }
  }
  // The two tail stages the authority computes no ratio for must behave the same
  // way as a first stage: absent, not "unavailable".
  const v = buildFunnelViews(populated);
  const tails = [v[0].stages[3], v[1].stages[3]];
  check(
    "unmeasured tail stages (redeemedActivated, returning7) are undefined, not null",
    tails.every((s) => s.rate === undefined),
  );
}

// ── 3 · authority rates pass through without recomputation ───────────────────
console.log("\n3. an authority-provided rate is displayed without local recomputation");
{
  const views = buildFunnelViews(populated);
  const beta = views[0].stages;
  const act = views[1].stages;

  check("beta.approved carries the payload's approveRate by identity", beta[1].rate === populated.beta.approveRate);
  check("beta.redeemed carries the payload's redeemRate by identity", beta[2].rate === populated.beta.redeemRate);
  check("activation.verified carries verifyRate by identity", act[1].rate === populated.activation.verifyRate);
  check("activation.activated carries activationRate by identity", act[2].rate === populated.activation.activationRate);

  check("each rate names the authority field it came from", beta[1].rateField === "beta.approveRate");
  check("formatting is display-only rounding", formatRate(96 / 148) === "65%");

  // A recomputation would produce a DIFFERENT number for at least one stage.
  // approved/requested is the authority's ratio; redeemed/requested is not.
  check(
    "beta.redeemed's rate is redeemed/approved (authority), not redeemed/requested",
    Math.abs((beta[2].rate as number) - 62 / 96) < 1e-12 &&
      Math.abs((beta[2].rate as number) - 62 / 148) > 1e-6,
  );
}

// ── 4 · selecting a stage resolves the expected subject ──────────────────────
console.log("\n4. selecting a stage opens that stage's detail");
{
  const views = buildFunnelViews(populated);

  const s = findStage(views, "beta.redeemed");
  check("findStage resolves the selected id", s?.id === "beta.redeemed");
  check("resolved subject carries the right funnel identity", s?.funnelLabel === "Beta access");
  check("resolved subject carries the right label", s?.label === "Redeemed");
  check("resolved subject carries the right count", s?.count === 62);

  check("no selection resolves to no subject", findStage(views, null) === null);
  check("an unknown id resolves to no subject (never a wrong one)", findStage(views, "beta.nope") === null);

  const adj = adjacentStages(views, "beta.redeemed");
  check("adjacency is within the same funnel", adj.previous?.id === "beta.approved" && adj.next?.id === "beta.redeemedActivated");
  check("the first stage has no previous", adjacentStages(views, "beta.requested").previous === null);
  check("the last stage has no next", adjacentStages(views, "activation.returning7").next === null);
  check(
    "adjacency never crosses funnels",
    adjacentStages(views, "beta.redeemedActivated").next === null,
  );
}

// ── 5 · selecting another stage replaces the subject ─────────────────────────
console.log("\n5. selecting another stage replaces the panel subject");
{
  const views = buildFunnelViews(populated);
  const first = findStage(views, "beta.approved");
  const second = findStage(views, "activation.verified");

  check("a second selection resolves a different subject", first?.id !== second?.id);
  check("the replacement subject is fully formed", second?.label === "Verified" && second?.count === 58);
  check("the replacement crosses funnels correctly", second?.funnelLabel === "Activation");

  // Replacement without reopening is a MOUNT property, so assert it structurally:
  // the panel must be rendered unconditionally with a toggled `open`, never
  // returned early on a null subject (which would unmount and skip the exit).
  const panel = stripComments(read(PANEL));
  check(
    "the panel is always mounted with a toggled `open` (so a new subject re-renders rather than reopens)",
    /<RightPanel\s+open=\{stage\s*!=\s*null\}/.test(panel),
  );
  check(
    "the panel does not early-return on a null subject",
    !/if\s*\(\s*!stage\s*\)\s*return\s+null/.test(panel),
  );
  check("the panel supplies an ariaLabel for the header-less exit frame", /ariaLabel=/.test(panel));
}

// ── 6 · no metric is authored, and no absent capability is figured ───────────
console.log("\n6. the surface authors no metric and figures no absent capability");
{
  const widget = stripComments(read(WIDGET));
  const stages = stripComments(read(STAGES));
  const view = stripComments(read(VIEW));
  const panel = stripComments(read(PANEL));
  const all = [
    [WIDGET, widget],
    [STAGES, stages],
    [VIEW, view],
    [PANEL, panel],
  ] as const;

  /**
   * THE REAL RULE, asserted structurally rather than lexically.
   *
   * A first attempt banned identifiers named *Rate and banned division outright.
   * Both were lexical proxies and both were wrong: `const rate = formatRate(x)`
   * is a read, not an authored metric, and `/` matches every JSX closing tag.
   *
   * The invariant that actually holds is a BOUNDARY: raw authority count fields
   * are readable in exactly one file. `growth-funnel-view.ts` maps the payload to
   * stage descriptors; the two .tsx files receive descriptors and never see a raw
   * count, so they are structurally incapable of deriving a metric from one.
   */
  const RAW_FIELDS = [
    "requested", "approved", "redeemed", "denied", "pending", "redeemedActivated",
    "totalUsers", "verified", "activated", "returning7",
    "approveRate", "redeemRate", "verifyRate", "activationRate",
  ];
  // "Touches" means ACCESSES or BINDS the field — `.approved` / `approved:`.
  // A bare word is prose: the panel legitimately says "requests that were not
  // approved", and a guard that failed on English would be a guard that
  // eventually gets satisfied by degrading the copy.
  const touches = (src: string, field: string) =>
    new RegExp(`(?:\\.${field}\\b|\\b${field}\\s*:)`).test(src);
  for (const [name, src] of [[WIDGET, widget], [STAGES, stages], [PANEL, panel]] as const) {
    const leaked = RAW_FIELDS.filter((f) => touches(src, f));
    check(
      `${path.basename(name)} never accesses a raw authority field`,
      leaked.length === 0,
      leaked.join(", "),
    );
  }
  check(
    "the view module is the single place raw authority fields are read",
    RAW_FIELDS.every((f) => touches(view, f)),
  );

  // Every rate the view emits must BE one of the four authority ratios, or be
  // absent. Anything else on the right-hand side of `rate:` is an invention.
  const rateAssignments = [...view.matchAll(/\brate:\s*([^,;)\n]+)[,]/g)]
    .map((m) => m[1].trim())
    .filter((r) => r !== "StageRate"); // the interface field, not an assignment
  const PERMITTED = new Set([
    "undefined",
    "beta.approveRate",
    "beta.redeemRate",
    "activation.verifyRate",
    "activation.activationRate",
  ]);
  check(
    "every emitted rate is an authority ratio or absent",
    rateAssignments.length === 8 && rateAssignments.every((r) => PERMITTED.has(r)),
    rateAssignments.join(" | "),
  );

  // The view module is plain .ts with no JSX and no regex literals, so after
  // stripping comments and strings every `/` is arithmetic. Exactly one is
  // permitted: barFraction's presentational width.
  const viewCode = view
    .replace(/["'`][^"'`]*["'`]/g, "") // strings first — import paths hold slashes
    .replace(/\/\/.*$/gm, "");        // then trailing line comments
  const divisions = (viewCode.match(/\//g) ?? []).length;
  check("the view module divides exactly once (barFraction's width)", divisions === 1, `${divisions}`);

  // barFraction must refuse a denominator it cannot honour, or an empty funnel
  // would render a row of full-width bars.
  check("barFraction(0, 0) is null — no bar rather than a full one", barFraction(0, 0) === null);
  check("barFraction(5, null) is null", barFraction(5, null) === null);
  check("barFraction(5, undefined) is null", barFraction(5, undefined) === null);
  check("barFraction clamps to 1", barFraction(200, 100) === 1);
  check("barFraction is proportional", barFraction(50, 100) === 0.5);

  // Named-absent capabilities may be NAMED once, but never given a figure, a
  // chart, or a tab. The assertion is that no digit or percent sits next to one.
  const ABSENT = ["revenue", "cohort", "attribution", "churn", "MRR", "forecast"];
  for (const word of ABSENT) {
    const re = new RegExp(`${word}[^.\\n]{0,40}?(\\d|%)`, "i");
    for (const [name, src] of all) {
      check(
        `${path.basename(name)}: "${word}" is never followed by a figure`,
        !re.test(src),
      );
    }
  }

  // No stage may be given a verdict. Health vocabulary and status colour are
  // both claims the projection does not make.
  const VERDICT = /\b(healthy|unhealthy|at-risk|at risk|degraded|failing|success-rate|recommend|should)\b/i;
  for (const [name, src] of all) {
    check(`${path.basename(name)} asserts no health verdict`, !VERDICT.test(src));
  }
  for (const [name, src] of [[STAGES, stages], [WIDGET, widget]] as const) {
    check(
      `${path.basename(name)} colours no stage with a status tone`,
      !/--(success|danger|warning|accent-positive|accent-negative)/.test(src),
    );
  }

  // The evidence limit must be stated, not left as an empty region.
  check(
    "the panel states that stage-level evidence is unavailable from this projection",
    /evidence is not available from the current projection/i.test(panel),
  );

  // One authority, consumed as-is.
  check("the widget reads only the canonical growth route", /\/api\/platform\/growth-revenue\/growth/.test(widget));
  check("the widget issues exactly one read", (widget.match(/useWidgetFetch</g) ?? []).length === 1);
  check("no file queries a model directly", !all.some(([, s]) => /\bdb\./.test(s)));
}

console.log(
  failures === 0
    ? "\n✓ growth funnel surface: authors no metric, figures no absent capability\n"
    : `\n✗ ${failures} check(s) failed\n`,
);
process.exit(failures === 0 ? 0 : 1);
