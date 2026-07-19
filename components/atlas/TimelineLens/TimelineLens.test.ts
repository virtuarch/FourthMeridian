/**
 * components/atlas/TimelineLens/TimelineLens.test.ts
 *
 * Ownership guard for the TimelineLens Atlas primitive.
 *
 * Co-located because the sibling Atlas guards are __dirname-scoped
 * (components/atlas/panels/panels.test.ts scans only its own directory), so a
 * NEW folder under components/atlas/ inherits ZERO import checking. Without this
 * file TimelineLens would be unguarded.
 *
 * What it protects: TimelineLens must be structurally incapable of becoming a
 * second time authority — not "we agreed not to", incapable. It cannot reach the
 * domain (import guard), cannot read a clock or do calendar math (API guard), and
 * cannot name a canonical preset (vocabulary guard).
 *
 * It also pins Atlas compliance, including that every `var(--token)` is real.
 * Three prototype iterations shipped --font-serif, --surface-raised, and
 * --neutral-950 — none of which exist. Undefined custom properties do not throw;
 * the declaration is silently dropped. A scan is the only place it surfaces.
 *
 * Pure, DB-free:  npx tsx components/atlas/TimelineLens/TimelineLens.test.ts
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const DIR = __dirname;
const GLOBALS = path.join(process.cwd(), "app", "globals.css");

let failures = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) { console.log(`  ✓ ${label}`); return; }
  console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  failures++;
}

/** Drop comments before scanning — this file's own prose names the very strings
 *  the vocabulary guard forbids, and so do the component's doc blocks. */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");

const files = readdirSync(DIR).filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith(".test.ts"));
const sources = files.map((f) => ({
  file: f,
  raw: readFileSync(path.join(DIR, f), "utf8"),
  src: strip(readFileSync(path.join(DIR, f), "utf8")),
}));

console.log("0. Component directory");
check("TimelineLens has source files to guard", sources.length >= 3);

// ── 1. Import boundary ───────────────────────────────────────────────────────
console.log("1. Ownership guard — TimelineLens reaches no domain");
{
  const allowed = (spec: string) =>
    spec === "react" || spec === "react-dom" || spec.startsWith("react/") ||
    spec === "lucide-react" ||
    spec.startsWith("node:") ||
    spec.startsWith("@/components/atlas/") ||
    spec.startsWith("./") || spec.startsWith("../");

  const forbidden = [
    "@/lib/time", "@/lib/perspectives", "@/lib/snapshots", "@/lib/wealth",
    "@/lib/transactions", "@/lib/investments", "@/lib/liquidity", "@/lib/data",
    "@/components/space", "@/components/dashboard",
  ];

  for (const { file, src } of sources) {
    for (const spec of [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1])) {
      check(`${file}: import "${spec}" is allowlisted`, allowed(spec));
      for (const bad of forbidden) {
        check(`${file}: does not import "${bad}"`, !spec.startsWith(bad));
      }
    }
  }
}

// ── 2. No date authority ─────────────────────────────────────────────────────
console.log("2. No date authority — cannot read a clock or do calendar math");
{
  const dateApis = [
    "new Date", "Date.now", "Intl.DateTimeFormat", "toISOString", "toLocaleDateString",
    "getFullYear", "setMonth", "setDate", "addDays", "subMonths", "subYears",
    "startOfWeek", "startOfMonth", "startOfQuarter", "startOfYear",
  ];
  for (const { file, src } of sources) {
    for (const api of dateApis) {
      check(`${file}: no date arithmetic (${api})`, !src.includes(api));
    }
  }
}

// ── 3. No canonical vocabulary ───────────────────────────────────────────────
console.log("3. Vocabulary guard — cannot name canonical time");
{
  // The strongest guard: TimelineLens cannot assemble {preset, asOf, compareTo}
  // if it cannot name a preset. asOf/compareTo DO appear as boundary-field
  // identifiers in the public contract; the preset IDS must never leak in,
  // because those are the ones carrying canonical meaning.
  const presetIds = [
    "WTD", "MTD", "QTD", "YTD",
    "PAST_WEEK", "PAST_MONTH", "PAST_QUARTER", "PAST_6_MONTHS", "PAST_YEAR",
    "CUSTOM",
  ];
  for (const { file, src } of sources) {
    for (const id of presetIds) {
      check(`${file}: does not name preset "${id}"`, !new RegExp(`["'\`]${id}["'\`]`).test(src));
    }
    check(`${file}: declares no TimePreset`, !src.includes("TimePreset"));
    check(`${file}: declares no PerspectiveTimeState`, !src.includes("PerspectiveTimeState"));
    check(`${file}: dispatches no ShellTimeAction`, !src.includes("ShellTimeAction"));
    check(`${file}: never calls a shell reducer`, !src.includes("shellTimeReducer"));
  }
}

// ── 4. Atlas compliance ──────────────────────────────────────────────────────
console.log("4. Atlas compliance — primitives, no one-offs, real tokens");
{
  for (const { file, src } of sources) {
    check(`${file}: uses no CSS module`, !src.includes(".module.css"));
    check(`${file}: implements no custom overlay`, !src.includes("createPortal"));
    check(`${file}: defines no focus trap of its own`, !src.includes("FOCUSABLE"));
  }

  const globalsSrc = readFileSync(GLOBALS, "utf8");
  const defined = new Set([...globalsSrc.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1].toLowerCase()));
  for (const { file, raw } of sources) {
    const used = new Set([...raw.matchAll(/var\((--[a-z0-9-]+)/gi)].map((m) => m[1].toLowerCase()));
    for (const token of used) {
      check(`${file}: ${token} is a real Atlas token`, defined.has(token), "not defined in app/globals.css");
    }
  }

  const lens = sources.find((s) => s.file === "TimelineLens.tsx")?.src ?? "";
  const panel = sources.find((s) => s.file === "TimelineLensPanel.tsx")?.src ?? "";
  check("composes GlassPanel for the closed readout", lens.includes("<GlassPanel"));
  check("composes the Atlas panel family", panel.includes("<LeftPanel") && panel.includes("<PanelFooter"));
  check("composes GlassButton, not a hand-rolled button", panel.includes("<GlassButton"));
  check("composes Field + Input for the boundary dates", panel.includes("<Field") && panel.includes("<Input"));
}

// ── 5. Contract shape + the three regressions this replaces ──────────────────
console.log("5. Contract — intent surface and prior-iteration regressions");
{
  const types = sources.find((s) => s.file === "types.ts")?.src ?? "";
  const panel = sources.find((s) => s.file === "TimelineLensPanel.tsx")?.src ?? "";

  check("TimelineIntent exposes exactly the four mapped variants",
    ['"period"', '"customBoundary"', '"swap"', '"clearComparison"'].every((v) => types.includes(v)));
  check("props carry maxDate", /maxDate:\s*string/.test(types));

  // A rejected boundary must be attributable to the field the user touched. An
  // opaque string cannot say which, and defaulted to rendering under the wrong
  // one — caught only by exercising the real panel in a browser.
  check("boundary errors carry which boundary they belong to",
    /boundary:\s*"asOf"\s*\|\s*"compareTo"/.test(types) && types.includes("TimelineBoundaryError"));
  check("each boundary Field renders only its OWN error",
    (panel.match(/boundaryError\?\.boundary === "(asOf|compareTo)"/g) ?? []).length === 2);

  // Parity: production caps As-of AND Compare-to at today.
  check("both boundary inputs are capped with max",
    (panel.match(/max=\{maxDate\}/g) ?? []).length === 2);

  // v2 regression: a cross-field clamp made forward comparison inexpressible,
  // which Wealth depends on. Constrain input, never meaning.
  check("no cross-field clamp reintroduces a backwards-comparison assumption",
    !/max=\{boundaries\.asOf\}/.test(panel) && !/min=\{boundaries\.compareTo\}/.test(panel));

  // v3 regression: roving tabindex with no fallback left every option
  // unreachable by keyboard whenever nothing was selected (i.e. a custom range).
  check("roving tabindex falls back when no option is active",
    panel.includes("activeOptionId ?? ordered[0]?.id"));

  check("the period choice is ONE radiogroup, not competing groups",
    (panel.match(/role="radiogroup"/g) ?? []).length === 1);
  // Choosing a period applies immediately AND dismisses the panel, so arrow keys
  // must not carry selection — otherwise the first arrow press commits and closes,
  // and a keyboard user can never browse the options.
  check("arrow keys move focus without committing a selection",
    /radios\[next\]\.focus\(\);/.test(panel) && !/radios\[next\]\.click\(\)/.test(panel));

  check("options expose radio semantics",
    panel.includes('role="radio"') && panel.includes("aria-checked"));

  // Panel doctrine: LeftPanel is context/control, RightPanel is selected-item detail.
  // Mobile touch floor: the icon-only swap/clear affordances render ~27px from
  // `size="sm"` alone, below a comfortable touch target on the bottom sheet.
  check("icon-only affordances carry a 44px minimum touch target",
    (panel.match(/min-h-11 min-w-11/g) ?? []).length === 2);

  check("uses LeftPanel (context/control), not RightPanel",
    panel.includes("<LeftPanel") && !panel.includes("<RightPanel"));
}

if (failures > 0) {
  console.error(`\n${failures} TimelineLens check(s) failed.`);
  process.exit(1);
}
console.log("\nAll TimelineLens Atlas invariants hold.");
