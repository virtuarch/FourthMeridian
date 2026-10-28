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
check("ready is set on the poll's true → false transition, or once from the onboarding handoff on a server-READY list — nowhere else",
  /if \(prevShouldPollRef\.current && !nextShouldPoll\) \{\s*router\.refresh\(\);\s*takeFirstConnectStarted\(\);[^\n]*\n\s*setJustCompleted\(true\);/.test(list)
  && /if \(shouldPoll \|\| !anyReady\) return;[\s\S]{0,160}if \(takeFirstConnectStarted\(\)\) setJustCompleted\(true\);/.test(list)
  && (list.match(/setJustCompleted\(/g) ?? []).length === 2);
check("first snapshot: Explore My Space (primary) + Add another connection (secondary)",
  /data-connections-ready/.test(list) && /href="\/dashboard"[\s\S]{0,400}Explore My Space/.test(list) && /Add another connection/.test(list));
check("in-progress strip counts running work only (importing or building), not paused or deferred",
  /const inFlight = ordered\.filter\(\(c\) => c\.state === "importing" \|\| inProgressPhase\(c\.id\)\);/.test(list));
check("it says the work continues server-side if the user leaves", /even if you leave this page/.test(list));
check("no percentage anywhere in the list", !/%|percent/i.test(list));
check("Add another connection reuses the page's own actions", /\[data-connections-actions\] button/.test(list)
  && /data-connections-actions/.test(code("components/connections/ConnectionsActions.tsx")));

// 2026-10-28 — wallet history the worker is importing: its own strip, persisted state only.
check("history strip: per-connection worker flag + QUEUED/IMPORTING checkpoint state only",
  /i\?\.facts\?\.historyWorkerEnabled === true && \(st === "QUEUED" \|\| st === "IMPORTING"\)/.test(list));
check("history strip: never doubles a connection already in the setup strip", /!inFlight\.includes\(c\)/.test(list));
check("history strip: holdings current, history continues, absolute proven date",
  /data-connections-history-importing/.test(list) && /Current holdings are already up to date; older history continues in the background\./.test(list)
  && /Verified back to \$\{fmtDay\(proven\)\} so far/.test(list));

if (failures > 0) { console.error(`\nconnections-lifecycle: ${failures} failed.`); process.exit(1); }
console.log("\nconnections-lifecycle: all checks passed.");
