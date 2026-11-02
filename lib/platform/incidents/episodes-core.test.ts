/**
 * lib/platform/incidents/episodes-core.test.ts  (PB-4 — canonical incident episodes)
 *
 * The Customer Success opened / resolved trend counts the SAME canonical
 * incidents the active-incident projection lists: event rows (the 64
 * REMOVED_TOMBSTONE rows behind "64 opened · 0 resolved"), superseded and
 * orphaned rows are never episodes; a still-open episode is exactly an active
 * incident; resolved = a recovered episode's resolvedAt.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/incidents/episodes-core.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { episodeStateOf, incidentEpisodes, isIncidentEpisodeState, type EpisodeTimelineRow } from "./episodes-core";
import { countByDay, windowDayKeys } from "@/lib/platform/trends/daily-core";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}
const code = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const at = (s: string) => new Date(s);

const row = (id: string, kind: string, o: Partial<EpisodeTimelineRow> = {}): EpisodeTimelineRow => ({
  id, kind, provider: "PLAID", detail: {}, plaidTransactionId: null, resolved: false,
  firstOccurredAt: at("2026-11-01T10:00:00Z"), resolvedAt: null, createdAt: at("2026-11-01T10:00:00Z"), ...o,
});

// The owner's Preview population: routine tombstones (EVENT: resolved, no resolvedAt, no key) …
const tombstones = Array.from({ length: 64 }, (_, i) => row(`t${i}`, "REMOVED_TOMBSTONE", { resolved: true, resolvedAt: null, plaidTransactionId: `ptx${i}` }));
// … plus one of every other state, so the predicate is exercised on each.
const rows: EpisodeTimelineRow[] = [
  ...tombstones,
  row("active1", "TRANSACTION_PERSISTENCE_FAILED", { firstOccurredAt: at("2026-11-02T09:00:00Z") }),
  row("active2", "WALLET_SYNC_FAILED", { provider: "WALLET", firstOccurredAt: null, createdAt: at("2026-11-03T09:00:00Z") }),
  row("recovered1", "TRANSACTION_PERSISTENCE_FAILED", { resolved: true, firstOccurredAt: at("2026-11-01T08:00:00Z"), resolvedAt: at("2026-11-03T12:00:00Z") }),
  row("superseded1", "BALANCE_TX_MISMATCH", { detail: {} }),
  row("orphaned1", "MISSING_ACCOUNT"),
];
const exists = (id: string) => id !== "orphaned1";

console.log("1. only canonical episodes");
{
  const eps = incidentEpisodes(rows, exists);
  const ids = eps.map((e) => e.id).sort();
  check("event rows (REMOVED_TOMBSTONE) are never episodes", !ids.some((id) => id.startsWith("t")), ids);
  check("superseded and orphaned rows are never episodes", !ids.includes("superseded1") && !ids.includes("orphaned1"));
  check("active + recovered conditions are the episodes", JSON.stringify(ids) === JSON.stringify(["active1", "active2", "recovered1"]), ids);
  check("the predicate names exactly active and recovered",
    isIncidentEpisodeState("active") && isIncidentEpisodeState("recovered")
    && !isIncidentEpisodeState("evidence") && !isIncidentEpisodeState("superseded") && !isIncidentEpisodeState("orphaned"));
}

console.log("2. the trend's still-open population IS the active projection's");
{
  const eps = incidentEpisodes(rows, exists);
  const trendOpen = eps.filter((e) => e.resolvedAt === null).map((e) => e.id).sort();
  // getActiveIncidentPage keeps exactly the rows whose derived state is "active" — via episodeStateOf.
  const projectionActive = rows.filter((r) => episodeStateOf(r, exists(r.id)) === "active").map((r) => r.id).sort();
  check("opened-and-not-resolved == the projection's active set", JSON.stringify(trendOpen) === JSON.stringify(projectionActive), { trendOpen, projectionActive });
  check("every still-open episode is state active; every resolved one is recovered with a resolvedAt",
    eps.every((e) => (e.resolvedAt === null) === (e.state === "active")) && eps.filter((e) => e.state === "recovered").every((e) => e.resolvedAt instanceof Date));
}

console.log("3. day counts: the owner's case no longer reads 64 opened · 0 resolved");
{
  const keys = windowDayKeys(at("2026-11-03T23:00:00Z"), 14);
  const eps = incidentEpisodes(rows, exists);
  const opened = countByDay(keys, eps.map((e) => e.openedAt));
  const resolved = countByDay(keys, eps.map((e) => e.resolvedAt));
  const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);
  check("opened = 3 episodes (first occurrence, else created)", sum(opened) === 3 && opened["2026-11-01"] === 1 && opened["2026-11-02"] === 1 && opened["2026-11-03"] === 1, opened);
  check("resolved = 1 (the recovery's resolvedAt day)", sum(resolved) === 1 && resolved["2026-11-03"] === 1, resolved);
  const onlyTombstones = incidentEpisodes(tombstones, () => true);
  check("64 tombstones alone ⇒ 0 opened, 0 resolved", onlyTombstones.length === 0);
}

console.log("4. one derivation, shared (source pins)");
{
  const proj = code("lib/platform/incidents/projections.ts");
  check("projections derive state through episodeStateOf, never syncIssueState directly", /state: episodeStateOf\(r, referentExists\)/.test(proj) && !/syncIssueState\(/.test(proj));
  check("the active page still filters derived state === active", /\.filter\(\(v\) => v\.state === "active"\)/.test(proj));
  check("the timeline uses the same referent check and the episode fold", /getIncidentEpisodeTimeline[\s\S]*referentExistence\(rows, client\)[\s\S]*incidentEpisodes\(/.test(proj));
  const daily = code("lib/platform/customer/incidents-daily.ts");
  check("the CS trend reads the canonical timeline, not raw SyncIssue rows", /getIncidentEpisodeTimeline\(/.test(daily) && !/syncIssue\.findMany/.test(daily));
  check("resolved counts the episode's resolvedAt (recovered only)", /countByDay\(keys, episodes\.map\(\(e\) => e\.resolvedAt\)\)/.test(daily));
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
