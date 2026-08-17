/**
 * lib/space-nav.test.ts
 *
 * Rail guard, migrated for REVIEW-3 (slice F): the placeholder ids
 * (FINANCES / DOCUMENTS), the retired PERSPECTIVES id, and the non-rail
 * SETTINGS id were DELETED from SpaceTabId — every id in SPACE_TAB_ORDER is
 * rail-real now, and the per-host gating machinery (isRailTabVisible /
 * PLACEHOLDER_SPACE_TABS / SHARED_ONLY_PLACEHOLDER_TABS) retired with its
 * permanently-empty lists. This guard pins that state so a dead id cannot
 * silently reappear.
 *
 * Standalone, dependency-free script runnable with the already-installed
 * `tsx`:
 *
 *     npx tsx lib/space-nav.test.ts
 *
 * Exits 0 when all cases pass and 1 on failure, so it can be wired into CI.
 */

import {
  SPACE_TAB_ORDER,
  SPACE_TAB_LABELS,
  railVisibleTabs,
} from "./space-nav";

let failures = 0;

function check(name: string, ok: boolean, detail?: string): void {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.log(`        ${detail}`);
  }
}

// 1. The rail IS the fixed order — no filtering machinery remains.
check(
  "railVisibleTabs() is exactly SPACE_TAB_ORDER",
  JSON.stringify(railVisibleTabs()) === JSON.stringify(SPACE_TAB_ORDER),
  `got ${JSON.stringify(railVisibleTabs())}`,
);

// 2. Exact expected rail (update deliberately when a tab earns a slot).
check(
  "rail is exactly OVERVIEW/ACTIVITY/ACCOUNTS/TRANSACTIONS/MEMBERS",
  JSON.stringify(SPACE_TAB_ORDER) ===
    JSON.stringify(["OVERVIEW", "ACTIVITY", "ACCOUNTS", "TRANSACTIONS", "MEMBERS"]),
  `got ${JSON.stringify(SPACE_TAB_ORDER)}`,
);

// 3. Dead ids stay dead — REVIEW-3 regression pins.
for (const dead of ["PERSPECTIVES", "FINANCES", "DOCUMENTS", "SETTINGS"]) {
  check(
    `${dead} is not a rail id`,
    !(SPACE_TAB_ORDER as string[]).includes(dead) &&
      !(dead in SPACE_TAB_LABELS),
  );
}

// 4. Every rail id carries a label.
for (const id of SPACE_TAB_ORDER) {
  check(`${id} has a label`, typeof SPACE_TAB_LABELS[id] === "string" && SPACE_TAB_LABELS[id].length > 0);
}

console.log(failures === 0 ? "\nAll space-nav rail checks passed." : `\n${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
