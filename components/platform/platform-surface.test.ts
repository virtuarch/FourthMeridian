/**
 * components/platform/platform-surface.test.ts  (PM-1, extended by S2)
 *
 * Guard for the shared platform presentation vocabulary (house pattern:
 * standalone tsx + renderToStaticMarkup, DB-free):
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/platform/platform-surface.test.ts
 *
 * These are small components, so the interesting assertions are not "does it
 * render" — they are the DOCTRINES the primitives exist to make structural:
 *
 *   · ONE frame level. A SectionSurface must not nest another bordered surface.
 *     `PanelSection` is the deliberate exception and lives on another plane.
 *   · Colour is never alone. StatusWord takes a required word; StatusBadge takes
 *     only a status and derives BOTH the colour and the word from it; the
 *     ExecutionStrip carries an accessible summary in words.
 *   · Urgency is saturation. --coral-500/600/700 fail WCAG AA on the dark
 *     surface; the primitives must not reintroduce them, and must carry no raw
 *     hex at all.
 *   · Unknown never reads as healthy. `Unavailable` renders an em-dash plus a
 *     reason — never a zero, never a colour.
 *   · Collapse is a CLASS, not a JS viewport read. `VRule` takes no `hidden`
 *     prop and the module contains no `matchMedia`.
 *   · Primitives are pure. No fetch, no clock read; "now" arrives as a prop.
 *
 * ── WHY §11's CENSUS REVERSED (S2) ───────────────────────────────────────────
 * PM-1 asserted that BigStat / VRule / KeyRow / PanelSection / StatusBadge were
 * NOT ported, because nothing consumed them. That was correct for PM-1's scope
 * and is now WRONG: the corrected migration replaces the production dashboard
 * with the prototype's Scheduler, Jobs and Job-detail surfaces, and those consume
 * all five heavily. The census below therefore asserts the OPPOSITE membership —
 * and still refuses the exports that have no named upcoming consumer.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Activity } from "lucide-react";
import {
  BigStat,
  ExecutionStrip,
  GroupLabel,
  KeyRow,
  NO_AUTHORITY,
  PanelSection,
  PolicyChip,
  Provenance,
  RuntimeTrend,
  SectionSurface,
  StatusBadge,
  StatusWord,
  TONE_COLOR,
  TwoLine,
  Unavailable,
  VRule,
  statusLabel,
  statusTone,
  type JobHealthStatus,
} from "./platform-surface";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const ROOT = process.cwd();
const SOURCE = "components/platform/platform-surface.tsx";
const strip = (rel: string) =>
  readFileSync(path.join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

/** Source of one exported symbol, sliced between export markers (no brace counting). */
function exportSlice(src: string, name: string): string {
  const start = src.indexOf(`export function ${name}`);
  if (start < 0) return "";
  const next = src.indexOf("\nexport ", start + 1);
  return src.slice(start, next < 0 ? src.length : next);
}

const ALL_STATUSES: JobHealthStatus[] = ["healthy", "never-ran", "running", "overdue", "dead", "failing"];

function main() {
  const src = strip(SOURCE);

  // ── 1. SectionSurface is ONE frame ─────────────────────────────────────────
  console.log("1. SectionSurface renders exactly one frame");
  {
    const html = renderToStaticMarkup(
      // A .test.ts file cannot use JSX, and SectionSurface's `children` is
      // deliberately REQUIRED (an empty frame is never a valid surface), so TS
      // demands it in the props object rather than as a trailing argument.
      // eslint-disable-next-line react/no-children-prop -- see above.
      createElement(SectionSurface, {
        icon: Activity,
        title: "Platform Health",
        footnote: "Only what an authority observed.",
        children: createElement("p", null, "body"),
      }),
    );
    check("renders the title", text(html).includes("Platform Health"));
    check("renders the footnote", text(html).includes("Only what an authority observed."));
    check("renders the children", text(html).includes("body"));

    // The frame rule, asserted rather than described: exactly one element in the
    // output carries the Atlas surface shadow. A nested Surface inside the
    // children would push this to two and reintroduce the box-in-a-box the
    // consolidation exists to remove.
    const surfaceFrames = (html.match(/var\(--shadow-e2\)/g) ?? []).length;
    check("exactly one surface frame", surfaceFrames === 1, `got ${surfaceFrames}`);

    // The hierarchy step that makes this page-grain and not card-grain.
    check("title uses the promoted type tier", /text-base font-semibold/.test(html));

    // The icon is a marker, not a badge — it must not sit in a filled chip.
    check("no icon badge", !/rounded-full[^"]*bg-/.test(html), html.slice(0, 400));

    // Optional icon really is optional.
    const noIcon = renderToStaticMarkup(
      // eslint-disable-next-line react/no-children-prop -- see above.
      createElement(SectionSurface, { title: "T", children: createElement("p", null, "x") }),
    );
    check("renders without an icon", text(noIcon).includes("T") && text(noIcon).includes("x"));

    // S2 reconciliation: count · actions · id, all present in the prototype and
    // all consumed by the Scheduler and Jobs surfaces.
    const full = renderToStaticMarkup(
      // eslint-disable-next-line react/no-children-prop -- see above.
      createElement(SectionSurface, {
        title: "Jobs",
        count: 11,
        id: "jobs",
        actions: createElement("span", null, "3 jobs have a declared policy"),
        children: createElement("p", null, "rows"),
      }),
    );
    check("renders the count pill", text(full).includes("11"));
    check("renders the actions slot", text(full).includes("3 jobs have a declared policy"));
    check("id becomes a scroll target", /id="jobs"/.test(full) && /scroll-mt-20/.test(full), full.slice(0, 200));
    check("count is still one frame", (full.match(/var\(--shadow-e2\)/g) ?? []).length === 1);
    // A count of zero is a fact, not an absence: `count={0}` must still render.
    const zero = renderToStaticMarkup(
      // eslint-disable-next-line react/no-children-prop -- see above.
      createElement(SectionSurface, { title: "T", count: 0, children: createElement("p", null, "x") }),
    );
    check("count={0} renders rather than vanishing", text(zero).includes("0"), text(zero));
  }

  // ── 2. GroupLabel is the demoted eyebrow ───────────────────────────────────
  console.log("2. GroupLabel is the 10px eyebrow, not a heading");
  {
    const html = renderToStaticMarkup(createElement(GroupLabel, null, "Providers"));
    check("renders the label", text(html) === "Providers");
    check("uses the 10px uppercase tier", /text-\[10px\]/.test(html) && /uppercase/.test(html));
    // A group label must not compete with the surface title for first read.
    check("is not a heading element", !/<h[1-6]/.test(html), html);

    // S2: the prototype's `hint`. Supplementary explanation only — and it must
    // reach assistive technology, not only a mouse pointer.
    const hinted = renderToStaticMarkup(
      // eslint-disable-next-line react/no-children-prop -- `children` is required, so TS wants it in props.
      createElement(GroupLabel, {
        hint: "Cron entries that dispatch outside the registry.",
        children: "External crons",
      }),
    );
    check("hint is exposed to assistive technology",
      /aria-label="Cron entries that dispatch outside the registry\."/.test(hinted), hinted);
    check("hint is not hover-only", /aria-label=/.test(hinted) && /title=/.test(hinted), hinted);
    check("no hint renders no icon", !/aria-label=/.test(html), html);
  }

  // ── 3. TwoLine puts every fact on the surface ──────────────────────────────
  console.log("3. TwoLine renders both lines, hides nothing");
  {
    const html = renderToStaticMarkup(
      createElement(TwoLine, { value: "Open Exchange Rates", qualifier: "Stale data · newest 2026-07-20" }),
    );
    check("renders the value", text(html).includes("Open Exchange Rates"));
    check("renders the qualifier", text(html).includes("Stale data · newest 2026-07-20"));

    // S2 reconciliation toward the prototype: the value is the FACT — primary
    // colour, `text-xs`, and tabular so a column of timestamps aligns. PM-1 had
    // it at 11px in secondary, which reads as a qualifier of nothing.
    check("value is the primary tier", /text-xs[^"]*text-\[var\(--text-primary\)\]/.test(html), html);
    check("value is tabular so columns align", /tabular-nums/.test(html), html);

    // Truncation with no tooltip destroys the fact; truncation WITH a tooltip
    // hides it from touch and from a screen reader. Neither is acceptable, so
    // long qualifiers wrap. (The prototype truncates; this is a deliberate,
    // documented accessibility deviation.)
    check("does not truncate", !/truncate/.test(html), html);
    check("no hover-only tooltip", !/title=/.test(html), html);
    check("wraps instead", /break-words/.test(html));

    // A tone is opt-in; the default is quiet, never alarming.
    check("defaults to the muted token", html.includes("var(--text-muted)"));
    const toned = renderToStaticMarkup(
      createElement(TwoLine, { value: "FX rates", qualifier: "Empty", qualifierTone: "var(--coral-400)" }),
    );
    check("applies an explicit tone", toned.includes("var(--coral-400)"));
    // …and the tone never replaces the word.
    check("the toned line still names the state in words", text(toned).includes("Empty"));

    // No qualifier at all renders only the value — an absent qualifier must not
    // materialise as an empty coloured span that reads as a blank verdict.
    const bare = renderToStaticMarkup(createElement(TwoLine, { value: "Only" }));
    check("omits the qualifier line when there is none", (bare.match(/<span/g) ?? []).length === 2, bare);
  }

  // ── 4. StatusWord: colour cannot travel alone ──────────────────────────────
  console.log("4. StatusWord always carries a word");
  {
    const html = renderToStaticMarkup(createElement(StatusWord, { word: "Action needed", token: "var(--coral-400)" }));
    check("renders the word", text(html) === "Action needed");
    check("renders the token", html.includes("var(--coral-400)"));

    // The doctrine is enforced by the SIGNATURE — `word` is required and there
    // is no colour-only escape hatch. Assert the source keeps it that way.
    const sig = exportSlice(src, "StatusWord");
    check("word is a required prop", /word:\s*string/.test(sig) && !/word\?:/.test(sig), sig);
    check("token is only ever a colour", /token:\s*string/.test(sig), sig);
  }

  // ── 5. Provenance names the system of record ───────────────────────────────
  console.log("5. Provenance names where a number came from");
  {
    const html = renderToStaticMarkup(
      createElement(Provenance, { source: "lib/platform/resource-freshness" }, "Read from stored data."),
    );
    check("renders the source", text(html).includes("lib/platform/resource-freshness"));
    check("renders the trailing note", text(html).includes("Read from stored data."));
    check("source is rendered as code, not prose", /font-mono/.test(html));

    // S2 reconciliation: the prototype tints the chip with the INFORMATIONAL
    // accent so it reads as a reference. Meridian is not an urgency colour.
    check("carries the informational tint", /--meridian-400/.test(html), html);

    // Provenance is an attribution, not a status. If it ever borrows an urgency
    // accent it starts reading as a verdict about the source.
    check("carries no urgency colour", !/--coral-|--emerald-|--accent-negative|--accent-positive/.test(html), html);

    // …and "no authority" is not a system of record, so it must NOT borrow the
    // tint that means "this came from somewhere real".
    const none = renderToStaticMarkup(createElement(Provenance, { source: NO_AUTHORITY }));
    check("no-authority renders neutral", !/--meridian/.test(none), none);
    check("no-authority still names itself", text(none).includes("no authority"), none);
  }

  // ── 6. StatusBadge: the observed axis, word and colour together ────────────
  console.log("6. StatusBadge derives both colour and word from one status");
  {
    for (const s of ALL_STATUSES) {
      const html = renderToStaticMarkup(createElement(StatusBadge, { status: s }));
      const word = statusLabel(s);
      check(`${s} renders its word "${word}"`, text(html) === word, text(html));
      check(`${s} renders its tone colour`, html.includes(TONE_COLOR[statusTone(s)]), html);
    }
    // The decorative dot must not be announced twice.
    const one = renderToStaticMarkup(createElement(StatusBadge, { status: "dead" }));
    check("the dot is decorative", /aria-hidden/.test(one), one);

    // COLOUR CANNOT TRAVEL ALONE — enforced by the SIGNATURE. The only prop is a
    // status, and the word comes from the same authority as the colour, so there
    // is no call site that can render this badge coloured and wordless.
    const sig = exportSlice(src, "StatusBadge");
    check("takes only a status", /\{\s*status\s*\}:\s*\{\s*status:\s*JobHealthStatus\s*\}/.test(sig), sig);
    check("word comes from the shared authority", /statusLabel\(status\)/.test(sig), sig);
    check("colour comes from the same status", /TONE_COLOR\[statusTone\(status\)\]/.test(sig), sig);
    // …and there is no second opinion about what a status means.
    check("does not re-declare the tone vocabulary",
      !/function statusTone\b/.test(src) && !/function statusLabel\b/.test(src), src);
  }

  // ── 7. PolicyChip: declared, quiet, and never colour-only ──────────────────
  console.log("7. PolicyChip is a word in a neutral pill");
  {
    for (const tone of ["hold", "off", "skip"] as const) {
      const html = renderToStaticMarkup(createElement(PolicyChip, { label: "Paused", tone }));
      check(`${tone} renders its label`, text(html) === "Paused", text(html));
    }
    const off = renderToStaticMarkup(createElement(PolicyChip, { label: "Disabled", tone: "off" }));
    const hold = renderToStaticMarkup(createElement(PolicyChip, { label: "Paused", tone: "hold" }));
    check("only an indefinite hold is tinted", /--brass-300/.test(off) && !/--brass/.test(hold), off);
    // Policy is DECLARED, not observed — it must never borrow the health palette.
    check("policy never borrows health colour",
      !/--coral-|--emerald-|--accent-warning|--meridian/.test(off + hold), off + hold);
    const sig = exportSlice(src, "PolicyChip");
    check("label is a required prop", /label:\s*string/.test(sig) && !/label\?:/.test(sig), sig);
  }

  // ── 8. Unavailable can never read as healthy or as zero ───────────────────
  console.log("8. Unavailable is an em-dash and a reason, never a zero");
  {
    const html = renderToStaticMarkup(createElement(Unavailable, { reason: "no revenue rows recorded" }));
    check("renders the em-dash", text(html).includes("—"));
    check("renders the reason", text(html).includes("no revenue rows recorded"));
    check("renders no zero", !/\b0\b/.test(text(html)), text(html));
    // The whole point: an unobserved value must not be able to look like a
    // healthy one. Only the two quietest text tokens are permitted.
    check("carries no health colour",
      !/--emerald|--coral|--accent-positive|--accent-negative|--accent-warning|--meridian/.test(html), html);
    const sig = exportSlice(src, "Unavailable");
    check("reason is required — there is no unexplained gap",
      /reason:\s*string/.test(sig) && !/reason\?:/.test(sig), sig);
    check("has no tone escape hatch", !/tone/.test(sig), sig);
  }

  // ── 9. BigStat carries its derivation ──────────────────────────────────────
  console.log("9. BigStat renders label · value · qualifier · derivation");
  {
    const html = renderToStaticMarkup(
      createElement(BigStat, {
        label: "Last recorded execution",
        value: "2026-07-24 09:00",
        qualifier: "3h ago · UTC",
        derivation: "MAX(JobRun.startedAt) — a run, not a tick",
        hint: "Read from the JobRun ledger.",
      }),
    );
    const t = text(html);
    check("renders the label", t.includes("Last recorded execution"));
    check("renders the value", t.includes("2026-07-24 09:00"));
    check("renders the qualifier", t.includes("3h ago · UTC"));
    // The third line is the one that matters: a time with no statement of where
    // it came from is what let "last tick" and "last recorded execution" merge.
    check("renders the derivation", t.includes("MAX(JobRun.startedAt) — a run, not a tick"));
    check("hint reaches the group label", /aria-label="Read from the JobRun ledger\."/.test(html), html);
    check("the figure uses the Atlas figure tier", /text-2xl/.test(html), html);
    // A bare stat is legal; it must not invent a qualifier or a derivation.
    const bare = renderToStaticMarkup(createElement(BigStat, { label: "External crons", value: 2 }));
    check("omits absent lines", text(bare) === "External crons 2", text(bare));
  }

  // ── 10. VRule collapses by CLASS, never by a JS viewport read ─────────────
  console.log("10. VRule is responsive by class");
  {
    const html = renderToStaticMarkup(createElement(VRule));
    check("hidden at the base breakpoint", /\bhidden\b/.test(html), html);
    check("shown from md up", /md:block/.test(html), html);
    check("is decorative", /aria-hidden/.test(html), html);
    check("is a hairline", html.includes("var(--border-hairline)"));

    // The prototype drives this with a `hidden` PROP off `useNarrowViewport`.
    // That workaround exists only because a gitignored tree is invisible to
    // Tailwind's content scan. Production must not inherit it: a JS viewport read
    // would make the primitive impure and fork the breakpoint away from the grid.
    const sig = exportSlice(src, "VRule");
    check("takes no props at all", /export function VRule\(\)/.test(sig), sig);
    check("has no `hidden` prop", !/hidden\?:/.test(sig) && !/\{\s*hidden\s*\}/.test(sig), sig);
    check("reads no viewport", !/matchMedia|innerWidth|useNarrowViewport/.test(sig), sig);
  }

  // ── 11. KeyRow — label left, value right, no box ───────────────────────────
  console.log("11. KeyRow is the detail panel's grammar");
  {
    const html = renderToStaticMarkup(createElement(KeyRow, { label: "Success rate", value: "94%" }));
    check("renders the label", text(html).includes("Success rate"));
    check("renders the value", text(html).includes("94%"));
    check("value is tabular", /tabular-nums/.test(html), html);
    check("is not a box", !/border|shadow/.test(html), html);
  }

  // ── 12. PanelSection is ONE quiet surface with no inner boxes ─────────────
  console.log("12. PanelSection frames a detail section once");
  {
    const html = renderToStaticMarkup(
      // eslint-disable-next-line react/no-children-prop -- children is required.
      createElement(PanelSection, {
        title: "Policy",
        action: createElement("button", null, "Edit"),
        children: createElement(KeyRow, { label: "Cadence", value: "Daily" }),
      }),
    );
    check("renders the title", text(html).includes("Policy"));
    check("renders the action", text(html).includes("Edit"));
    check("renders the children", text(html).includes("Cadence") && text(html).includes("Daily"));
    check("exactly one surface frame", (html.match(/var\(--shadow-e2\)/g) ?? []).length === 1);
    // A section heading, one step below the surface title — never a second <h2>.
    check("heading is h3, not h2", /<h3/.test(html) && !/<h2/.test(html), html);
  }

  // ── 13. ExecutionStrip is never colour-only ────────────────────────────────
  console.log("13. ExecutionStrip states its outcome in words");
  {
    const runs = [
      { status: "failed" as const, deploymentSha: "b2b2b2b" },
      { status: "succeeded" as const, deploymentSha: "b2b2b2b" },
      { status: "succeeded" as const, deploymentSha: "a1a1a1a" },
      { status: "succeeded" as const, deploymentSha: "a1a1a1a" },
    ];
    const html = renderToStaticMarkup(createElement(ExecutionStrip, { runs }));
    check("one mark per run", (html.match(/title="/g) ?? []).length === runs.length,
      String((html.match(/title="/g) ?? []).length));
    // The rule the whole file exists for: a chart made of coloured bars must say
    // what it means in words, or it says nothing to a colour-blind operator.
    check("carries an accessible summary", /role="img"/.test(html) && /aria-label="/.test(html), html);
    check("the summary counts outcomes in words",
      /aria-label="4 recent runs: 3 succeeded, 1 failed/.test(html), html);
    check("names the deployment boundary", text(html).includes("Deployment"));
    check("failure uses the accessible danger token", html.includes(TONE_COLOR.bad), html);

    // No deploy flip ⇒ no boundary. A dashed rule that is always there teaches an
    // operator to ignore it.
    const flat = renderToStaticMarkup(
      createElement(ExecutionStrip, {
        runs: [
          { status: "succeeded" as const, deploymentSha: "a1a1a1a" },
          { status: "succeeded" as const, deploymentSha: "a1a1a1a" },
        ],
      }),
    );
    check("no boundary when the deployment never changed", !text(flat).includes("Deployment"), text(flat));
    check("a clean strip says so", /aria-label="2 recent runs: 2 succeeded, 0 failed"/.test(flat), flat);
  }

  // ── 14. RuntimeTrend refuses to draw a shape it cannot support ────────────
  console.log("14. RuntimeTrend says why it is not drawing");
  {
    const fmt = (ms: number | null) => (ms == null ? "—" : `${ms}ms`);
    const thin = renderToStaticMarkup(createElement(RuntimeTrend, { values: [10, 20, 30, 40], format: fmt }));
    check("refuses below five points", !/<svg/.test(thin), thin);
    // An empty plot box reads as "nothing wrong". A sentence reads as "not known".
    check("states the shortfall", text(thin) === "Not enough recorded runs to plot — 4 of 5 needed.", text(thin));

    const full = renderToStaticMarkup(
      createElement(RuntimeTrend, { values: [null, 100, 200, 300, 400, 500], format: fmt }),
    );
    check("draws at five observed points", /<polyline/.test(full), full);
    // Nulls are UNRECORDED durations. Counting one as zero would drag the axis to
    // 0ms and invent a fast run that never happened.
    // The axis labels are max then min. A null counted as zero would drag the
    // min to "0ms" and invent a fast run that never happened.
    check("nulls are dropped, not zeroed", text(full).startsWith("500ms 100ms"), text(full));
    check("the axis is labelled", text(full).includes("5 runs ago") && text(full).includes("now"));
    check("the line is decorative, the labels carry the values", /aria-hidden/.test(full), full);
  }

  // ── 15. Palette, purity and accessibility for the file as a whole ─────────
  console.log("15. tokens only, pure, and no JS viewport reads");
  {
    check("no raw hex colour", !/#[0-9a-fA-F]{3,8}\b/.test(src), src.match(/#[0-9a-fA-F]{3,8}\b/)?.[0]);
    check("no raw rgb()/rgba()", !/\brgba?\(/.test(src), src.match(/\brgba?\([^)]*\)/)?.[0]);
    check("no tailwind palette class",
      !/\b(?:bg|text|border)-(?:gray|blue|red|emerald|green|violet|yellow|amber|purple)-\d{2,3}\b/.test(src), src);
    // --coral-600 measured 3.28:1 against the dark card background: below WCAG
    // AA for small text. Urgency is SATURATION, not darkness.
    for (const banned of ["--coral-500", "--coral-600", "--coral-700"]) {
      check(`never uses ${banned}`, !src.includes(banned), banned);
    }

    // widget-kit is card grain; this file is page grain. The split is the whole
    // reason the file exists (migration plan §9), so it must not re-import the
    // card shell and quietly become widget-kit's second half.
    check("does not depend on widget-kit", !/widget-kit/.test(src), src);

    // PURITY. A primitive that fetches or reads the clock cannot be tested, cannot
    // be server-rendered deterministically, and hides a data dependency from its
    // caller. "now" arrives as a prop, the way `relTime(iso, nowMs)` already does.
    check("no clock read", !/Date\.now\(|new Date\(/.test(src), src.match(/Date\.now\(|new Date\(/)?.[0]);
    check("no fetching", !/\bfetch\(|useEffect|useState/.test(src), src.match(/\bfetch\(|useEffect|useState/)?.[0]);
    // RESPONSIVE. `useNarrowViewport` is replaced by Tailwind `md:` variants.
    check("no JS viewport read", !/matchMedia|innerWidth|useNarrowViewport/.test(src), src);
    check("collapse is expressed as a variant", /md:/.test(src), src);
  }

  // ── 16. The census: what is ported, and what is refused ────────────────────
  console.log("16. every primitive has a named upcoming consumer");
  {
    const exported = [...src.matchAll(/export function (\w+)/g)].map((m) => m[1]).sort();
    const expected = [
      "BigStat",        // Scheduler
      "ExecutionStrip", // Job detail · Recent executions
      "GroupLabel",     // every surface
      "KeyRow",         // Job detail
      "PanelSection",   // Job detail
      "PolicyChip",     // Jobs row · Job detail
      "Provenance",     // Scheduler · Jobs · Job detail
      "RuntimeTrend",   // Job detail · Runtime
      "SectionSurface", // every surface
      "StatusBadge",    // Jobs row · Job detail header
      "StatusWord",     // Platform health headlines
      "TwoLine",        // Jobs row
      "Unavailable",    // any unobserved value
      "VRule",          // Scheduler
    ];
    check("exports exactly the consumed primitives",
      exported.join(",") === expected.join(","), `got ${exported.join(",")}`);

    // The prototype's parts.tsx ships more than this. Copying an export with no
    // named upcoming consumer would be building a framework, not porting a
    // component — and two of these are owned by other sessions outright.
    const refused: Array<[string, string]> = [
      ["useNarrowViewport", "replaced by Tailwind md: variants (see §10)"],
      ["FunnelStages", "a Growth session owns the production FunnelStages.tsx"],
      ["ScopeLine", "serves the operator WRITE surface — out of scope, no confirmed authority"],
      ["DecisionDialog", "serves the operator WRITE surface — out of scope, no confirmed authority"],
      ["SeverityBadge", "Security Operations, not a named upcoming Platform Ops surface"],
      ["EvidenceChain", "Customer Success, not a named upcoming Platform Ops surface"],
    ];
    for (const [name, why] of refused) {
      check(`${name} is refused — ${why}`, !new RegExp(`function ${name}\\b`).test(src));
    }
  }

  if (failures > 0) { console.error(`\nplatform-surface.test: ${failures} failure(s).`); process.exit(1); }
  console.log("\nplatform-surface.test: all passed.");
}

main();
