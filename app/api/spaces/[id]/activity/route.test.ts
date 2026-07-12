/**
 * app/api/spaces/[id]/activity/route.test.ts
 *
 * Gate for the activity route's merge/sort/scoping behavior (Activity Tab event
 * feed, plan §7). The merge is inline in an impure, DB-bound handler, so this
 * test has two halves in the house pattern (standalone tsx, exit 0/1):
 *
 *   1. Behavioral fixture — a local mirror of the route's merge expression,
 *      proving three pre-sorted source arrays collapse into one date-desc,
 *      single-capped array.
 *   2. Source-scan drift/safety guards — read route.ts as text and assert the
 *      real handler still uses that exact expression, still scopes to ACTIVE
 *      links, and NEVER selects SyncIssue.detail into member-facing copy.
 *
 * If the behavioral mirror and the real route ever drift, half (2) fails.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type { TimelineEvent } from "@/lib/timeline-types";

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; return; }
  failures.push(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
}

// ── 1. Behavioral fixture: mirror of the route's merge/sort/cap ───────────────
// Mirrors:  [...audit, ...import, ...sync].sort((a,b) => b.date.localeCompare(a.date)).slice(0, 60)
function mergeSortCap(...sources: TimelineEvent[][]): TimelineEvent[] {
  return sources
    .flat()
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 60);
}

function ev(id: string, date: string): TimelineEvent {
  return { id, type: "T", title: id, date };
}

// Three pre-sorted (newest-first) source arrays, as the route produces them.
const audit  = [ev("a1", "2026-07-12T10:00:00.000Z"), ev("a2", "2026-07-05T10:00:00.000Z")];
const imp    = [ev("i1", "2026-07-11T10:00:00.000Z"), ev("i2", "2026-07-01T10:00:00.000Z")];
const sync   = [ev("s1", "2026-07-10T10:00:00.000Z")];

const merged = mergeSortCap(audit, imp, sync);
check("merge preserves every event", merged.length === 5);
check(
  "merged is strictly newest-first across all sources",
  merged.map((e) => e.id).join(",") === "a1,i1,s1,a2,i2",
  merged.map((e) => e.id).join(","),
);
{
  // Cap at 60: 80 events in → exactly 60 out, newest kept.
  const many = Array.from({ length: 80 }, (_, i) =>
    ev(`m${i}`, new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()),
  );
  const capped = mergeSortCap(many, [], []);
  check("cap at 60", capped.length === 60);
  check("cap keeps the newest, drops the oldest", capped[0].id === "m79" && !capped.some((e) => e.id === "m0"));
}
{
  // Empty sources are harmless.
  check("all-empty merge → []", mergeSortCap([], [], []).length === 0);
}

// ── 2. Source-scan drift/safety guards ────────────────────────────────────────
const routeSrc = readFileSync(
  path.join(process.cwd(), "app", "api", "spaces", "[id]", "activity", "route.ts"),
  "utf8",
);

check(
  "route merges all three sources",
  /\[\s*\.\.\.auditEvents\s*,\s*\.\.\.importEvents\s*,\s*\.\.\.syncEvents\s*\]/.test(routeSrc),
);
check(
  "route sorts date-desc via localeCompare",
  routeSrc.includes("b.date.localeCompare(a.date)"),
);
check("route caps at a single .slice(0, 60)", routeSrc.includes(".slice(0, 60)"));
check(
  "import/sync scoped to ACTIVE links",
  routeSrc.includes("status: ShareStatus.ACTIVE"),
);
check(
  "account set filtered to non-deleted accounts",
  routeSrc.includes("financialAccount: { deletedAt: null }"),
);
// The single most important safety invariant: SyncIssue.detail is never loaded.
check(
  "SyncIssue.detail is NEVER selected",
  !/detail:\s*true/.test(routeSrc),
);
// The syncIssue select loads only the four contract fields (no detail leak).
check(
  "syncIssue select is exactly id/kind/resolved/createdAt",
  routeSrc.includes("select: { id: true, kind: true, resolved: true, createdAt: true }"),
);

// ── Report ────────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`\nactivity route merge/scoping: ${failures.length} FAILURE(S) (${passed} checks passed):`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
console.log(`activity route merge/scoping: all ${passed} checks passed.`);
process.exit(0);
