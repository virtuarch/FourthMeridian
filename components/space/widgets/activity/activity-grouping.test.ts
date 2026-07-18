/**
 * components/space/widgets/activity/activity-grouping.test.ts
 *
 * Pure tests for the Activity timeline's date-bucketing + the presentation-layer
 * honesty tripwires. Deterministic (injected `now`), DB-free (house pattern):
 *
 *   npx tsx components/space/widgets/activity/activity-grouping.test.ts
 *
 * Locks:
 *   1. groupActivityEvents — Today / Yesterday / Earlier this week / month bands,
 *      band ordering, empty bands omitted, input order preserved, no event lost,
 *      month bands split by calendar month and labelled stably.
 *   2. Source-scan tripwires: the editorial layer stays presentation-only — it
 *      never fetches from anything but the canonical activity route, never
 *      fabricates AI/causality/insight copy, and the detail panel only surfaces
 *      TimelineEvent contract fields.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TimelineEvent } from "@/lib/timeline-types";
import { groupActivityEvents } from "./activity-grouping";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// Fixed local clock: Wed 2026-07-15, 14:00 local.
const NOW = new Date(2026, 6, 15, 14, 0, 0);

let n = 0;
function ev(dateISO: string, over: Partial<TimelineEvent> = {}): TimelineEvent {
  return { id: `e${n++}`, type: "SPACE_UPDATE", title: "t", date: dateISO, ...over };
}
/** Build an ISO string at local noon on the given Y/M/D (avoids TZ edge flips). */
function localNoon(y: number, m: number, d: number): string {
  return new Date(y, m, d, 12, 0, 0).toISOString();
}

console.log("1. groupActivityEvents — bands, order, completeness");
{
  // Newest-first input (as the API emits): today, today, yesterday, 3-days-ago
  // (earlier this week), and two June events (older → month band).
  const events = [
    ev(localNoon(2026, 6, 15), { id: "today-a" }),
    ev(new Date(2026, 6, 15, 9, 0, 0).toISOString(), { id: "today-b" }),
    ev(localNoon(2026, 6, 14), { id: "yday" }),
    ev(localNoon(2026, 6, 12), { id: "week" }),      // 3 days before → earlier this week
    ev(localNoon(2026, 5, 20), { id: "jun-a" }),
    ev(localNoon(2026, 5, 2),  { id: "jun-b" }),
  ];
  const groups = groupActivityEvents(events, NOW);

  check("band order is Today, Yesterday, Earlier this week, June 2026",
    groups.map((g) => g.label).join(" | ") === "Today | Yesterday | Earlier this week | June 2026",
    groups.map((g) => g.label).join(" | "));

  check("Today band holds both of today's events, newest-first order preserved",
    groups[0].key === "today" && groups[0].events.map((e) => e.id).join(",") === "today-a,today-b");

  check("Yesterday band holds only the yesterday event",
    groups[1].key === "yesterday" && groups[1].events.length === 1 && groups[1].events[0].id === "yday");

  check("Earlier-this-week band holds the 3-days-ago event",
    groups[2].key === "earlier-week" && groups[2].events[0].id === "week");

  check("June month band groups both June events with a stable anchor",
    groups[3].key === "2026-06" && groups[3].anchor === "activity-2026-06" &&
    groups[3].events.map((e) => e.id).join(",") === "jun-a,jun-b");

  const total = groups.reduce((s, g) => s + g.events.length, 0);
  check("no event is dropped (6 in → 6 out)", total === 6, String(total));
}

console.log("2. Empty bands are omitted");
{
  // Only an old event — no Today/Yesterday/week bands should appear.
  const groups = groupActivityEvents([ev(localNoon(2026, 3, 4), { id: "old" })], NOW);
  check("single old event yields exactly one month band",
    groups.length === 1 && groups[0].key === "2026-04");
  check("empty input yields no bands", groupActivityEvents([], NOW).length === 0);
}

console.log("3. Week boundary — 6 days back is 'earlier this week', 7 days back is a month band");
{
  const sixBack   = groupActivityEvents([ev(localNoon(2026, 6, 9), { id: "6d" })], NOW);
  const sevenBack = groupActivityEvents([ev(localNoon(2026, 6, 8), { id: "7d" })], NOW);
  check("6 days back → Earlier this week", sixBack[0].key === "earlier-week");
  check("7 days back → month band (not this week)", sevenBack[0].key === "2026-07");
}

console.log("4. Distinct calendar months become distinct bands, newest-first");
{
  const groups = groupActivityEvents([
    ev(localNoon(2026, 4, 10), { id: "may" }),
    ev(localNoon(2026, 3, 10), { id: "apr" }),
  ], NOW);
  check("May 2026 band precedes April 2026 band",
    groups.map((g) => g.label).join(" | ") === "May 2026 | April 2026", groups.map((g) => g.label).join(" | "));
}

console.log("5. Source-scan — editorial layer is presentation-only + honest");
{
  const dir = join(process.cwd(), "components", "space", "widgets", "activity");
  const feed   = readFileSync(join(dir, "useActivityFeed.ts"), "utf8");
  const detail = readFileSync(join(dir, "ActivityEventDetail.tsx"), "utf8");
  const timeline = readFileSync(join(dir, "ActivityTimeline.tsx"), "utf8");
  const workspace = readFileSync(join(process.cwd(), "components", "space", "workspaces", "ActivityWorkspace.tsx"), "utf8");

  // (a) The feed reads ONLY the canonical activity route — no new authority, no
  //     other endpoint, no direct DB/prisma import. Scanned on comment-stripped
  //     code so a doc-comment mention of the route path doesn't count.
  const stripC = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
  const feedCode = stripC(feed);
  check("feed fetches the canonical /api/spaces/${...}/activity route",
    /\/api\/spaces\/\$\{[^}]+\}\/activity/.test(feedCode));
  check("feed hits no other API endpoint in code",
    (feedCode.match(/\/api\/[^\s"'`)]*/g) ?? []).every((p) => /^\/api\/spaces\/\$\{[^}]+\}\/activity$/.test(p)));
  check("editorial layer never imports the db/prisma client",
    !/@\/lib\/db|from "@prisma\/client"/.test(feed + detail + timeline + workspace));

  // (b) No fabricated AI / causality / insight synthesis anywhere in the layer.
  //     Scanned on comment-stripped CODE so honest prose in a comment can't trip
  //     it — the guard is against rendered copy and synthesis logic, not docs.
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
  const blob = strip(feed + detail + timeline + workspace).toLowerCase();
  for (const banned of ["because", "we think", "insight", "recommend", "likely due", "caused by"]) {
    check(`no fabricated interpretation copy: "${banned.trim()}"`, !blob.includes(banned));
  }

  // (c) The detail panel only surfaces TimelineEvent contract fields — it must
  //     not synthesize a numeric total or invent a field the contract lacks.
  check("detail reads event.href for navigation (existing link, not invented)",
    /event\.href|\bhref\b/.test(detail));
  check("detail does not compute sums (no reduce/+= arithmetic over events)",
    !/\.reduce\(|\+=/.test(detail));
}

if (failures > 0) { console.error(`\n${failures} activity-grouping check(s) failed`); process.exit(1); }
console.log("\nAll activity-grouping checks passed");
