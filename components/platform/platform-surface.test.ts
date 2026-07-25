/**
 * components/platform/platform-surface.test.ts  (PM-1)
 *
 * Guard for the page-grain platform primitives (house pattern: standalone tsx +
 * renderToStaticMarkup, DB-free):
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/platform/platform-surface.test.ts
 *
 * These are four tiny components, so the interesting assertions are not "does it
 * render" — they are the DOCTRINES the primitives exist to make structural:
 *
 *   · ONE frame level. A SectionSurface must not nest another bordered surface,
 *     because the whole point of consolidating five cards is that the result is
 *     one box, not one box containing five.
 *   · Colour is never alone. StatusWord takes a required word, so there is no
 *     way to spend urgency colour without spending a word too.
 *   · Urgency is saturation. --coral-600 fails WCAG AA on the dark surface; the
 *     primitives must not reintroduce it, and must not carry raw hex at all.
 *   · Nothing is hidden behind a hover. No `title=` tooltip, no truncation of a
 *     fact that has nowhere else to be read.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Activity } from "lucide-react";
import { GroupLabel, Provenance, SectionSurface, StatusWord, TwoLine } from "./platform-surface";

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

function main() {
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
  }

  // ── 2. GroupLabel is the demoted eyebrow ───────────────────────────────────
  console.log("2. GroupLabel is the 10px eyebrow, not a heading");
  {
    const html = renderToStaticMarkup(createElement(GroupLabel, null, "Providers"));
    check("renders the label", text(html) === "Providers");
    check("uses the 10px uppercase tier", /text-\[10px\]/.test(html) && /uppercase/.test(html));
    // A group label must not compete with the surface title for first read.
    check("is not a heading element", !/<h[1-6]/.test(html), html);
  }

  // ── 3. TwoLine puts every fact on the surface ──────────────────────────────
  console.log("3. TwoLine renders both lines, hides nothing");
  {
    const html = renderToStaticMarkup(
      createElement(TwoLine, { value: "Open Exchange Rates", qualifier: "Stale data · newest 2026-07-20" }),
    );
    check("renders the value", text(html).includes("Open Exchange Rates"));
    check("renders the qualifier", text(html).includes("Stale data · newest 2026-07-20"));

    // Truncation with no tooltip destroys the fact; truncation WITH a tooltip
    // hides it from touch and from a screen reader. Neither is acceptable, so
    // long qualifiers wrap.
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
    const src = strip(SOURCE);
    const sig = src.slice(src.indexOf("export function StatusWord"), src.indexOf("export function Provenance"));
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

    // Provenance is an attribution, not a status. If it ever borrows an accent
    // colour it starts reading as a verdict about the source.
    check("carries no urgency colour", !/--coral-|--emerald-|--accent-negative|--accent-positive/.test(html), html);
  }

  // ── 6. Palette + accessibility rules for the file as a whole ───────────────
  console.log("6. tokens only, and the accessible end of the coral ramp");
  {
    const src = strip(SOURCE);
    check("no raw hex colour", !/#[0-9a-fA-F]{3,8}\b/.test(src), src.match(/#[0-9a-fA-F]{3,8}\b/)?.[0]);
    check("no tailwind palette class",
      !/\b(?:bg|text|border)-(?:gray|blue|red|emerald|green|violet|yellow|amber|purple)-\d{2,3}\b/.test(src), src);
    // --coral-600 measured 3.28:1 against the dark card background: below WCAG
    // AA for small text. It must not come back as "the heavier red".
    check("never uses --coral-600", !src.includes("--coral-600"), src);
    check("never uses --coral-500", !src.includes("--coral-500"), src);

    // widget-kit is card grain; this file is page grain. The split is the whole
    // reason the file exists (migration plan §9), so it must not re-import the
    // card shell and quietly become widget-kit's second half.
    check("does not depend on widget-kit", !/widget-kit/.test(src), src);
  }

  // ── 7. Only the primitives PM-1 actually uses exist ────────────────────────
  console.log("7. no speculative primitives");
  {
    const src = strip(SOURCE);
    const exported = [...src.matchAll(/export function (\w+)/g)].map((m) => m[1]).sort();
    check("exports exactly the four consumed primitives + StatusWord",
      exported.join(",") === "GroupLabel,Provenance,SectionSurface,StatusWord,TwoLine", exported.join(","));

    // The prototype's parts.tsx ships 21 pieces. Copying the ones nothing uses
    // would be building a framework, not extracting a primitive.
    for (const absent of ["BigStat", "VRule", "KeyRow", "PanelSection", "StatusBadge", "SeverityBadge", "ScopeLine", "useNarrowViewport"]) {
      check(`${absent} is not speculatively ported`, !new RegExp(`function ${absent}\\b`).test(src));
    }
  }

  if (failures > 0) { console.error(`\nplatform-surface.test: ${failures} failure(s).`); process.exit(1); }
  console.log("\nplatform-surface.test: all passed.");
}

main();
