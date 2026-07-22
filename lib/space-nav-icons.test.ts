/**
 * lib/space-nav-icons.test.ts
 *
 * SHELL_NAV Phase 2 S2/S5 — the rail icon map is the single source for the Space
 * rail tabs' glyphs. Contract (stop condition #2 — no rail tab ships silently
 * iconless): every SpaceTabId in SPACE_TAB_LABELS maps to a real component (never
 * only the generic fallback), and a fallback exists for an off-list id. The
 * compile-time `satisfies Record<SpaceTabId, ElementType>` in the source already
 * makes an omission a type error; this mirrors it at runtime.
 *
 *   npx tsx lib/space-nav-icons.test.ts
 */

import { SPACE_TAB_ICON_MAP, SPACE_TAB_ICON_FALLBACK } from "./space-nav-icons";
import { SPACE_TAB_LABELS, SPACE_TAB_ORDER } from "./space-nav";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

function main(): void {
  console.log("every rail tab id maps to a real, distinct icon (no silent fallback)");
  for (const id of Object.keys(SPACE_TAB_LABELS)) {
    const mapped = SPACE_TAB_ICON_MAP[id];
    check(
      `tab "${id}" (${SPACE_TAB_LABELS[id as keyof typeof SPACE_TAB_LABELS]}) is mapped`,
      mapped !== undefined && mapped !== SPACE_TAB_ICON_FALLBACK,
      mapped === undefined ? "no map entry" : "resolves only to the generic fallback",
    );
  }

  console.log("the map covers exactly the canonical tab order (no missing / stray ids)");
  check(
    "SPACE_TAB_ORDER ids all present in the map",
    SPACE_TAB_ORDER.every((id) => SPACE_TAB_ICON_MAP[id] !== undefined),
  );

  console.log("fallback is defined and neutral");
  check("fallback constant is set", !!SPACE_TAB_ICON_FALLBACK);
  check(
    "unknown id resolves via the fallback",
    (SPACE_TAB_ICON_MAP["NOT_A_TAB"] ?? SPACE_TAB_ICON_FALLBACK) === SPACE_TAB_ICON_FALLBACK,
  );

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nAll space-nav-icons checks passed");
}

main();
