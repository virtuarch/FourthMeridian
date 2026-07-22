/**
 * lib/data/nearest-on-or-before.test.ts
 *
 * HIST-1B — pure tests for the shared nearest-≤ resolver: greatest date on or
 * before the target, first-seen vs. caller-supplied tie-break, honest null gap
 * below coverage, unsorted-input independence, and the optional staleness
 * ceiling (offered but not forced). Also pins parity with the two call sites'
 * tie-break conventions (M7 strongest-origin-wins; M10 last-in-sorted-wins).
 *
 *   npx tsx lib/data/nearest-on-or-before.test.ts
 */

import { nearestOnOrBefore } from "./nearest-on-or-before";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

interface Row { date: string; tag: string }
const dateOf = (r: Row) => r.date;

console.log("nearestOnOrBefore — greatest date ≤ target");
{
  const rows: Row[] = [
    { date: "2026-05-01", tag: "a" },
    { date: "2026-06-01", tag: "b" },
    { date: "2026-07-11", tag: "c" },
  ];
  check("exact hit picks that row", nearestOnOrBefore(rows, "2026-06-01", dateOf)?.tag === "b");
  check("between rows picks the earlier one", nearestOnOrBefore(rows, "2026-06-15", dateOf)?.tag === "b");
  check("target ≥ last row picks the last", nearestOnOrBefore(rows, "2026-08-01", dateOf)?.tag === "c");
  check("target before the first row ⇒ null (honest gap)", nearestOnOrBefore(rows, "2026-04-01", dateOf) === null);
  check("empty series ⇒ null", nearestOnOrBefore([] as Row[], "2026-06-01", dateOf) === null);
}

console.log("nearestOnOrBefore — unsorted input, same answer");
{
  const shuffled: Row[] = [
    { date: "2026-07-11", tag: "c" },
    { date: "2026-05-01", tag: "a" },
    { date: "2026-06-01", tag: "b" },
  ];
  check("does not assume sort order", nearestOnOrBefore(shuffled, "2026-06-15", dateOf)?.tag === "b");
}

console.log("nearestOnOrBefore — tie-break on equal dates");
{
  const tied: Row[] = [
    { date: "2026-06-01", tag: "first" },
    { date: "2026-06-01", tag: "second" },
  ];
  check("default keeps the first-seen on a tie", nearestOnOrBefore(tied, "2026-06-01", dateOf)?.tag === "first");
  check("preferOnTie:()=>true keeps the last-seen (M10 last-in-sorted parity)",
    nearestOnOrBefore(tied, "2026-06-01", dateOf, { preferOnTie: () => true })?.tag === "second");

  // M7 parity — strongest origin (lowest rank) wins regardless of array order.
  const RANK: Record<string, number> = { OBSERVED: 0, DERIVED: 2 };
  const byOrigin = (rows: Row[]) =>
    nearestOnOrBefore(rows, "2026-06-01", dateOf, { preferOnTie: (c, i) => RANK[c.tag] < RANK[i.tag] });
  check("stronger origin replaces weaker on a tie", byOrigin([{ date: "2026-06-01", tag: "DERIVED" }, { date: "2026-06-01", tag: "OBSERVED" }])?.tag === "OBSERVED");
  check("weaker origin never displaces stronger on a tie", byOrigin([{ date: "2026-06-01", tag: "OBSERVED" }, { date: "2026-06-01", tag: "DERIVED" }])?.tag === "OBSERVED");
}

console.log("nearestOnOrBefore — optional staleness ceiling (offered, not forced)");
{
  const rows: Row[] = [{ date: "2026-06-01", tag: "old" }];
  check("no ceiling ⇒ a stale match still resolves", nearestOnOrBefore(rows, "2026-07-01", dateOf)?.tag === "old");
  check("within ceiling ⇒ match resolves", nearestOnOrBefore(rows, "2026-06-05", dateOf, { maxStaleDays: 7 })?.tag === "old");
  check("exactly at the ceiling ⇒ still resolves", nearestOnOrBefore(rows, "2026-06-08", dateOf, { maxStaleDays: 7 })?.tag === "old");
  check("beyond the ceiling ⇒ null (too stale)", nearestOnOrBefore(rows, "2026-06-09", dateOf, { maxStaleDays: 7 }) === null);
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nAll nearest-on-or-before checks passed");
