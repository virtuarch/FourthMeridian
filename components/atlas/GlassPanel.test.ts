/**
 * components/atlas/GlassPanel.test.ts
 *
 * Semantic + behavioral invariants for the GlassPanel polymorphic primitive.
 *
 * Unlike the sibling Atlas guards, this renders the component for real
 * (renderToStaticMarkup) and asserts the emitted HTML. Source scanning cannot
 * answer "does as='button' produce valid markup?"; rendering can.
 *
 * The defect this pins: GlassPanel wraps children so they stack above the
 * decorative layers. That wrapper used to be a <div>, which is INVALID inside
 * <button> (button's content model is phrasing content) — and three call sites
 * render as="button". It is now a <span class="block">: phrasing content, so
 * valid everywhere, and layout-identical.
 *
 * Pure, DB-free:  npx tsx components/atlas/GlassPanel.test.ts
 */

import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GlassPanel } from "./GlassPanel";

let failures = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) { console.log(`  ✓ ${label}`); return; }
  console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  failures++;
}

const render = (props: Record<string, unknown>, children: unknown = "content") =>
  renderToStaticMarkup(h(GlassPanel as never, props as never, children as never));

/** Element name of the outermost tag. */
const rootTag = (html: string) => html.match(/^<([a-z0-9]+)/i)?.[1] ?? "";

// ── 1. Polymorphic root element ──────────────────────────────────────────────
console.log("1. Polymorphic root — every `as` target renders that element");
{
  check("default renders <div>", rootTag(render({})) === "div");
  check("as='div' renders <div>", rootTag(render({ as: "div" })) === "div");
  check("as='section' renders <section>", rootTag(render({ as: "section" })) === "section");
  check("as='aside' renders <aside> (Panel.tsx)", rootTag(render({ as: "aside" })) === "aside");
  check("as='button' renders <button>", rootTag(render({ as: "button" })) === "button");
  check("as='a' renders <a> (Link-shaped call sites)", rootTag(render({ as: "a", href: "/x" })) === "a");
}

// ── 2. The semantic defect — no invalid content inside <button> ──────────────
console.log("2. Valid markup inside <button>");
{
  const html = render({ as: "button", type: "button" });

  check("no <div> anywhere inside a button", !html.includes("<div"), html.slice(0, 180));
  check("no <section>/<p>/<aside> flow content either",
    !/<(section|p|aside|h[1-6]|ul|ol|li)\b/.test(html));

  // The wrapper still exists (it carries the stacking) but is phrasing content.
  check("the content wrapper is a <span>", /<span class="[^"]*relative z-10 block/.test(html), html.slice(0, 220));
  check("the wrapper still lifts content above the decorative layers (z-10)",
    /relative z-10 block/.test(html));
  check("children survive", html.includes("content"));

  // Regression pin: a nested interactive element would be invalid regardless of
  // the wrapper, so callers must not pass one. Assert the primitive adds none.
  check("the primitive introduces no nested interactive element",
    (html.match(/<button/g) ?? []).length === 1 && !html.includes("<a "));
}

// ── 3. Accessibility + DOM prop pass-through ─────────────────────────────────
console.log("3. Accessibility and prop pass-through");
{
  const html = render({
    as: "button",
    type: "button",
    disabled: true,
    "aria-label": "Change time period",
    "aria-expanded": false,
    "aria-haspopup": "dialog",
    "aria-describedby": "sum-1",
  });

  check("disabled reaches the button", html.includes("disabled"));
  check("type reaches the button", html.includes('type="button"'));
  check("aria-label passes through", html.includes('aria-label="Change time period"'));
  check("aria-expanded passes through", html.includes('aria-expanded="false"'));
  check("aria-haspopup passes through", html.includes('aria-haspopup="dialog"'));
  check("aria-describedby passes through", html.includes('aria-describedby="sum-1"'));

  // Keyboard accessibility is inherent to a real <button>: it is focusable and
  // Enter/Space activate it. Pin that we did not opt out of that.
  check("no tabindex=-1 is imposed", !html.includes('tabindex="-1"'));
  check("no role override hides the native button semantics", !/role="(?!button)/.test(html));
}

// ── 4. Material system unchanged ─────────────────────────────────────────────
console.log("4. Glass material, tokens, and states preserved");
{
  const html = render({ depth: "thin", elevation: "e1", radius: "lg" });

  check("radius token applied", html.includes("border-radius:var(--radius-lg)"));
  check("depth fill applied", html.includes("background:var(--glass-thin)"));
  check("backdrop filter applied", html.includes("var(--glass-filter-thin)"));
  check("elevation shadow applied", html.includes("var(--shadow-e1)"));
  check("hairline border applied", html.includes("var(--border-hairline)"));
  check("fresnel edge on by default", html.includes("atlas-fresnel-edge"));
  check("edge can be opted out", !render({ edge: false }).includes("atlas-fresnel-edge"));

  for (const depth of ["ultrathin", "thin", "regular", "thick", "floating"]) {
    check(`depth ${depth} resolves its fill`, render({ depth }).includes(`var(--glass-${depth})`));
  }

  check("specular highlight layer present", html.includes("--specular-edge"));
  check("interactive adds the hover lift", render({ interactive: true }).includes("hover:-translate-y-"));
  check("non-interactive adds no hover lift", !render({}).includes("hover:-translate-y-"));
  check("glow is opt-in", !html.includes("radial-gradient") || render({ glow: "meridian" }).includes("radial-gradient"));
  check("bloom defaults on for thick", render({ depth: "thick" }).includes("rgba(255,255,255,0.10)"));
  check("bloom defaults off for thin", !render({ depth: "thin" }).includes("rgba(255,255,255,0.10)"));
}

// ── 5. className vs contentClassName ─────────────────────────────────────────
console.log("5. className targets the panel, contentClassName targets the content");
{
  const html = render({ as: "button", className: "px-4 my-panel", contentClassName: "grid grid-cols-2 my-content" });

  check("className lands on the root element", /^<button[^>]*my-panel/.test(html), html.slice(0, 160));
  check("contentClassName lands on the content wrapper", /<span class="[^"]*my-content/.test(html));
  check("the two do not bleed into each other",
    !/^<button[^>]*my-content/.test(html) && !/<span class="[^"]*my-panel/.test(html));
}

if (failures > 0) {
  console.error(`\n${failures} GlassPanel check(s) failed.`);
  process.exit(1);
}
console.log("\nAll GlassPanel primitive invariants hold.");
