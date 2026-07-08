/**
 * lib/space-nav.test.ts
 *
 * v2.5 honesty-slice guard — placeholder tabs must never reappear as
 * active rail items, and rail ordering must stay a subsequence of
 * SPACE_TAB_ORDER.
 *
 * The project has no test runner (no jest/vitest). This is a standalone,
 * dependency-free script runnable with the already-installed `tsx`,
 * mirroring lib/ai/output-validator.test.ts and
 * lib/data/transactions.privacy.test.ts:
 *
 *     npx tsx lib/space-nav.test.ts
 *
 * Exits 0 when all cases pass and 1 on failure, so it can be wired into CI.
 */

import {
  SPACE_TAB_ORDER,
  PLACEHOLDER_SPACE_TABS,
  SHARED_ONLY_PLACEHOLDER_TABS,
  isRailTabVisible,
  railVisibleTabs,
  type SpaceDashboardHost,
  type SpaceTabId,
} from "./space-nav";

let failures = 0;

function check(name: string, ok: boolean, detail?: string): void {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.log(`        ${detail}`);
  }
}

const HOSTS: SpaceDashboardHost[] = ["personal", "shared"];

// 1. Product-wide placeholder tabs are hidden on every host.
for (const host of HOSTS) {
  for (const id of PLACEHOLDER_SPACE_TABS) {
    check(
      `${id} is not rail-visible on ${host}`,
      !isRailTabVisible(id, host) && !railVisibleTabs(host).includes(id),
    );
  }
}

// 2. Shared-only placeholders: hidden on shared, visible on personal.
//    (Space Template Redesign: TRANSACTIONS re-earned its shared slot —
//    the list is currently empty; the loop stands ready for future
//    personal-first tabs.)
for (const id of SHARED_ONLY_PLACEHOLDER_TABS) {
  check(`${id} is hidden on shared`, !railVisibleTabs("shared").includes(id));
  check(`${id} is visible on personal`, railVisibleTabs("personal").includes(id));
}

// 2b. TRANSACTIONS is real on BOTH hosts now.
check("TRANSACTIONS is visible on shared", railVisibleTabs("shared").includes("TRANSACTIONS"));
check("TRANSACTIONS is visible on personal", railVisibleTabs("personal").includes("TRANSACTIONS"));

// 3. Tabs with real content everywhere keep their rail slot on both hosts.
const ALWAYS_REAL: SpaceTabId[] = [
  "OVERVIEW", "PERSPECTIVES", "ACTIVITY", "ACCOUNTS", "MEMBERS", "SETTINGS",
];
for (const host of HOSTS) {
  for (const id of ALWAYS_REAL) {
    check(`${id} is rail-visible on ${host}`, railVisibleTabs(host).includes(id));
  }
}

// 4. Fixed order preserved: railVisibleTabs must be a subsequence of
//    SPACE_TAB_ORDER (filtering only — never reordering).
for (const host of HOSTS) {
  const visible = railVisibleTabs(host);
  const expected = SPACE_TAB_ORDER.filter((id) => visible.includes(id));
  check(
    `rail order for ${host} is a subsequence of SPACE_TAB_ORDER`,
    JSON.stringify(visible) === JSON.stringify(expected),
    `got ${JSON.stringify(visible)}`,
  );
}

// 5. Exact expected rails (update deliberately when a tab re-earns its slot).
//    TRANSACTIONS re-earned its shared slot in the Space Template Redesign.
check(
  "shared rail is exactly OVERVIEW/PERSPECTIVES/ACTIVITY/ACCOUNTS/TRANSACTIONS/MEMBERS/SETTINGS",
  JSON.stringify(railVisibleTabs("shared")) ===
    JSON.stringify(["OVERVIEW", "PERSPECTIVES", "ACTIVITY", "ACCOUNTS", "TRANSACTIONS", "MEMBERS", "SETTINGS"]),
  `got ${JSON.stringify(railVisibleTabs("shared"))}`,
);
check(
  "personal rail is exactly OVERVIEW/PERSPECTIVES/ACTIVITY/ACCOUNTS/TRANSACTIONS/MEMBERS/SETTINGS",
  JSON.stringify(railVisibleTabs("personal")) ===
    JSON.stringify(["OVERVIEW", "PERSPECTIVES", "ACTIVITY", "ACCOUNTS", "TRANSACTIONS", "MEMBERS", "SETTINGS"]),
  `got ${JSON.stringify(railVisibleTabs("personal"))}`,
);

console.log(failures === 0 ? "\nAll space-nav rail checks passed." : `\n${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
