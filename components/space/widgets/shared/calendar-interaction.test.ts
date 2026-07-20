/**
 * components/space/widgets/shared/calendar-interaction.test.ts
 *
 * Standalone tsx guard (house convention: exit 0/1). UX-CLOSE-2B.
 *
 * ── What this file can and cannot prove ───────────────────────────────────────
 * The repo has no DOM test environment (no jsdom / testing-library), so a true
 * "hover → tooltip appears → move away → disappears" test is not expressible
 * here. Those two scenarios were verified in a real browser instead, and are
 * recorded as such in the slice notes.
 *
 * What IS provable statically is the thing that actually broke, and it is
 * structural rather than behavioural: the tooltip used to be driven by CSS
 * pseudo-classes the app could not clear. `group-hover:` needs a mouseleave that
 * never comes once the detail panel portals to <body> over the pointer, and
 * `group-focus-within:` was held by the very button the click had just focused.
 * So the preview outlived the click that replaced it, sitting at z-50 beneath
 * the z-100 panel.
 *
 * The fix is that preview became CONTROLLED. These checks pin that property, so
 * a future edit cannot quietly reintroduce an undismissable preview:
 *
 *   1. no CSS-pseudo preview triggers remain,
 *   2. the click handler ends the preview BEFORE it opens the panel,
 *   3. keyboard preview is :focus-visible (so a mouse click leaves none),
 *   4. selection invalidates on a time change, via one shared hook.
 *
 *   npx tsx components/space/widgets/shared/calendar-interaction.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");

/** Comments describe the OLD behaviour on purpose; strip them before scanning. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const GRID   = stripComments(read("components/space/widgets/shared/CalendarHeatmapGrid.tsx"));
const DRAWER = stripComments(read("components/space/widgets/TransactionSliceDrawer.tsx"));

const SLICE_HOLDERS = [
  "components/space/widgets/CashFlowHistoryWidget.tsx",
  "components/space/widgets/CashFlowSummaryWidget.tsx",
  "components/space/widgets/CashFlowCategoryBreakdown.tsx",
  "components/space/widgets/cashflow/CashFlowCategoryLedger.tsx",
];

function main(): void {
  console.log("1/2. preview is controlled — the stuck-tooltip regression");
  check("no group-hover: preview trigger remains", !GRID.includes("group-hover:"),
    "a CSS-only preview cannot be cleared when the panel covers the pointer");
  check("no group-focus-within: preview trigger remains", !GRID.includes("group-focus-within:"),
    "focus-within is held by the button the click just focused");
  check("the tooltip's visibility is driven by component state",
    /previewing \? "block" : "hidden"/.test(GRID));
  check("preview state exists", /const \[hovering, setHovering\]/.test(GRID));

  console.log("2. click ends the preview, then opens the panel");
  const click = GRID.match(/onClick=\{[^}]*endPreview\(\);[^}]*onSelect\([^)]*\)[^}]*\}/);
  check("onClick calls endPreview() BEFORE onSelect()", click != null,
    "ordering matters: the preview must not survive into the panel");
  check("endPreview clears BOTH hover and keyboard preview",
    /endPreview = \(\) => \{ setHovering\(false\); setKeyboardFocus\(false\); \}/.test(GRID));

  console.log("3. hover capability is preserved (not removed)");
  check("mouseenter still starts a preview", /onMouseEnter=\{\(\) => setHovering\(true\)\}/.test(GRID));
  check("mouseleave still ends it", /onMouseLeave=\{\(\) => setHovering\(false\)\}/.test(GRID));
  check("the tooltip element still exists", GRID.includes('role="tooltip"'));
  check("keyboard users still get a preview", /onFocus=/.test(GRID));
  check("keyboard preview uses :focus-visible, so a mouse click leaves none",
    GRID.includes('matches(":focus-visible")'));
  check("blur ends the keyboard preview", /onBlur=\{\(\) => setKeyboardFocus\(false\)\}/.test(GRID));

  console.log("4. time-change invalidation — one shared authority");
  check("the invalidating hook exists", /export function useTransactionSlice/.test(DRAWER));
  check("it clears the slice when the key changes",
    /if \(invalidationKey !== prevKey\) \{[\s\S]*?setSlice\(null\);[\s\S]*?\}/.test(DRAWER));
  check("it uses adjust-during-render, not an effect",
    !/useEffect/.test(DRAWER.slice(DRAWER.indexOf("useTransactionSlice"), DRAWER.indexOf("useTransactionSlice") + 700)));

  for (const f of SLICE_HOLDERS) {
    const src = stripComments(read(f));
    const name = f.split("/").pop();
    check(`${name}: holds its slice through the invalidating hook`,
      /const \[slice, setSlice\] = useTransactionSlice\(/.test(src));
    check(`${name}: no raw un-invalidated slice state remains`,
      !/useState<TransactionSlice \| null>/.test(src));
  }

  console.log("panel dismissal clears selection");
  for (const f of SLICE_HOLDERS) {
    const src = stripComments(read(f));
    check(`${f.split("/").pop()}: onClose sets the slice back to null`,
      /onClose=\{\(\) => setSlice\(null\)\}/.test(src));
  }

  console.log("anti-vacuity — the scans actually match something");
  check("grid source was read", GRID.length > 2000);
  check("drawer source was read", DRAWER.length > 2000);
  check("comment stripping works", !GRID.includes("UX-CLOSE-2B"));

  console.log(failures === 0 ? "\nPASS" : `\nFAIL — ${failures} check(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
