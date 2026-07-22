/**
 * lib/perspective-icons.test.ts
 *
 * SHELL_NAV S1/S6 — the shared perspective icon resolver is the single source of
 * truth for turning a PerspectiveDef.icon NAME into a Lucide component (used by
 * both PerspectivesWidget's cards and the shell's PerspectiveTabs). Contract:
 * every icon name any real lens declares must map to a component (never silently
 * fall back to Sparkles), and an unknown name falls back cleanly.
 *
 *   npx tsx lib/perspective-icons.test.ts
 */

import { PERSPECTIVE_ICON_MAP, PERSPECTIVE_ICON_FALLBACK } from "./perspective-icons";
import { PERSPECTIVE_LIBRARY } from "./perspectives";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

function main(): void {
  console.log("every lens icon name resolves to a real mapped component (no silent fallback)");
  for (const p of Object.values(PERSPECTIVE_LIBRARY)) {
    const mapped = PERSPECTIVE_ICON_MAP[p.icon];
    check(
      `lens "${p.id}" icon "${p.icon}" is mapped`,
      mapped !== undefined && mapped !== PERSPECTIVE_ICON_FALLBACK,
      mapped === undefined ? "no map entry" : "resolves only to the Sparkles fallback",
    );
  }

  console.log("fallback behavior is defined and neutral");
  check("fallback constant is set", !!PERSPECTIVE_ICON_FALLBACK);
  check(
    "unknown/empty name resolves via fallback",
    (PERSPECTIVE_ICON_MAP["NotAnIcon"] ?? PERSPECTIVE_ICON_FALLBACK) === PERSPECTIVE_ICON_FALLBACK,
  );

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nAll perspective-icons checks passed");
}

main();
