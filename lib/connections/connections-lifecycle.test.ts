/**
 * lib/connections/connections-lifecycle.test.ts  (Connections pass PR 3)
 *
 * The list says what is genuinely running, and the "ready" moment comes from the
 * poller's observed transition — never a timer, a guess or a percentage.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); }
}
const code = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const list = code("components/connections/ConnectionsList.tsx");
check("ready is set ONLY on the poll's true → false transition", /if \(prevShouldPollRef\.current && !nextShouldPoll\) \{\s*router\.refresh\(\);\s*setJustCompleted\(true\);/.test(list)
  && (list.match(/setJustCompleted\(/g) ?? []).length === 1);
check("first snapshot: Explore My Space (primary) + Add another connection (secondary)",
  /data-connections-ready/.test(list) && /href="\/dashboard"[\s\S]{0,400}Explore My Space/.test(list) && /Add another connection/.test(list));
check("in-progress strip counts running work only (importing or building), not paused or deferred",
  /const inFlight = ordered\.filter\(\(c\) => c\.state === "importing" \|\| inProgressPhase\(c\.id\)\);/.test(list));
check("it says the work continues server-side if the user leaves", /even if you leave this page/.test(list));
check("no percentage anywhere in the list", !/%|percent/i.test(list));
check("Add another connection reuses the page's own actions", /\[data-connections-actions\] button/.test(list)
  && /data-connections-actions/.test(code("components/connections/ConnectionsActions.tsx")));

if (failures > 0) { console.error(`\nconnections-lifecycle: ${failures} failed.`); process.exit(1); }
console.log("\nconnections-lifecycle: all checks passed.");
