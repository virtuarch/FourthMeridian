/**
 * components/space/widgets/BreakdownWidget.test.ts
 *
 * Standalone tsx guard (house convention: exit 0/1). This RENDERS the component
 * (renderToStaticMarkup) rather than scanning source, for the same reason
 * GlassPanel.test.ts does: the questions here are "is this markup valid?" and
 * "did an inert chart quietly gain a control?", and a source scan cannot answer
 * either.
 *
 * Two contracts:
 *
 *   1. SELECTION IS OPT-IN. With no `onSelect` the widget must emit NO button,
 *      no focus stop, and no pointer cursor. The donut previously set
 *      `cursor: pointer` on every segment product-wide while doing nothing on
 *      click — an affordance that lied.
 *
 *   2. INTERACTIVE ROWS ARE VALID BUTTONS. `<button>`'s content model is
 *      phrasing content, so a row that becomes a button may not contain
 *      <div>/<p>. This is the exact defect ATLAS_PRIMITIVE_HARDENING §6 rule 1
 *      records against GlassPanel; the same trap applies here.
 *
 *   npx tsx components/space/widgets/BreakdownWidget.test.ts
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BreakdownWidget, type BreakdownItem, type BreakdownViewMode } from "./BreakdownWidget";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const ITEMS: BreakdownItem[] = [
  { id: "chase",    label: "Chase",    value: 60, meta: "Bank" },
  { id: "vanguard", label: "Vanguard", value: 30 },
  { id: "ally",     label: "Ally",     value: 10 },
];

const MODES: BreakdownViewMode[] = ["donut", "bar", "list"];

function render(props: Record<string, unknown>): string {
  return renderToStaticMarkup(createElement(BreakdownWidget, { items: ITEMS, ...props } as never));
}

/** Flow-content tags that are illegal inside <button>. */
const FLOW = ["div", "p", "ul", "ol", "li", "section", "h1", "h2", "h3"];

function buttonBodies(html: string): string[] {
  return [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1]);
}

function main(): void {
  console.log("selection is opt-in — an inert chart stays inert");
  for (const viewMode of MODES) {
    const html = render({ viewMode });
    check(`${viewMode}: emits no <button> without onSelect`, !html.includes("<button"));
    check(`${viewMode}: no pointer cursor without onSelect`, !/cursor:\s*pointer/.test(html));
    check(`${viewMode}: no aria-pressed without onSelect`, !html.includes("aria-pressed"));
  }

  console.log("interactive mode — one control per item, correctly labelled");
  for (const viewMode of MODES) {
    const html = render({ viewMode, onSelect: () => {} });
    const bodies = buttonBodies(html);
    check(`${viewMode}: renders one button per item`, bodies.length === ITEMS.length,
      `got ${bodies.length}`);
    check(`${viewMode}: every button is type="button" (never submits)`,
      [...html.matchAll(/<button\b[^>]*>/g)].every((m) => m[0].includes('type="button"')));
    check(`${viewMode}: each item's label is the accessible name`,
      ITEMS.every((i) => html.includes(`aria-label="${i.label}"`)));
  }

  console.log("button content model — phrasing content only (GlassPanel §6 rule 1)");
  for (const viewMode of MODES) {
    const html = render({ viewMode, onSelect: () => {} });
    for (const body of buttonBodies(html)) {
      const bad = FLOW.filter((t) => new RegExp(`<${t}[\\s>]`).test(body));
      check(`${viewMode}: no flow content inside <button>`, bad.length === 0,
        bad.length ? `found <${bad.join(">, <")}>` : undefined);
    }
    check(`${viewMode}: no nested interactive element inside a button`,
      buttonBodies(html).every((b) => !/<(button|a)[\s>]/.test(b)));
  }

  console.log("selected state");
  const selHtml = render({ viewMode: "donut", onSelect: () => {}, selectedId: "vanguard" });
  check("aria-pressed is present once selectedId is tracked", selHtml.includes("aria-pressed"));
  check("exactly one row is pressed", (selHtml.match(/aria-pressed="true"/g) ?? []).length === 1);
  const unselHtml = render({ viewMode: "donut", onSelect: () => {}, selectedId: null });
  check("a null selection presses nothing", !unselHtml.includes('aria-pressed="true"'));
  check("but still exposes the state (caller tracks selection)", unselHtml.includes("aria-pressed"));
  const noTrack = render({ viewMode: "donut", onSelect: () => {} });
  check("omitting selectedId claims NO state — it is a plain action button",
    !noTrack.includes("aria-pressed"));

  console.log("selectLabel disambiguates");
  const labelled = render({
    viewMode: "list",
    onSelect: () => {},
    selectLabel: (i: BreakdownItem) => `${i.label} — show contributing accounts`,
  });
  check("selectLabel overrides the accessible name",
    labelled.includes('aria-label="Chase — show contributing accounts"'));

  console.log("colour is identity-keyed, not position-keyed");
  // The regression: these lists sort value-descending and drop empties, so a
  // reordered or shortened set must not repaint the survivors.
  const forward = render({ viewMode: "list" });
  const reversedItems = [...ITEMS].reverse();
  const reversed = renderToStaticMarkup(
    createElement(BreakdownWidget, { items: reversedItems, viewMode: "list" } as never),
  );
  const colorsOf = (html: string) =>
    [...html.matchAll(/background-color:\s*([^;"]+)/g)].map((m) => m[1].trim());
  const fwd = colorsOf(forward);
  const rev = colorsOf(reversed);
  check("reversing item order does not repaint any item",
    fwd.length === rev.length && fwd.every((c, i) => c === rev[rev.length - 1 - i]),
    `fwd=${fwd.join()} rev=${rev.join()}`);

  const dropped = renderToStaticMarkup(
    createElement(BreakdownWidget, {
      items: ITEMS.filter((i) => i.id !== "vanguard"),
      viewMode: "list",
    } as never),
  );
  const drop = colorsOf(dropped);
  check("dropping a middle item does not repaint the survivors",
    drop[0] === fwd[0] && drop[1] === fwd[2],
    `full=${fwd.join()} dropped=${drop.join()}`);

  console.log("explicit colour always wins (the identity regime)");
  const pinned = renderToStaticMarkup(
    createElement(BreakdownWidget, {
      items: [{ id: "cash", label: "Cash", value: 1, color: "#123456" }],
      viewMode: "list",
    } as never),
  );
  check("caller-supplied colour is used verbatim", pinned.includes("#123456"));

  console.log("empty state is unchanged");
  const empty = renderToStaticMarkup(
    createElement(BreakdownWidget, { items: [], onSelect: () => {} } as never),
  );
  check("no items ⇒ no buttons even when selectable", !empty.includes("<button"));

  console.log(failures === 0 ? "\nPASS" : `\nFAIL — ${failures} check(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
