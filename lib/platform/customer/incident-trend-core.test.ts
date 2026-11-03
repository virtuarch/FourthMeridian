/**
 * lib/platform/customer/incident-trend-core.test.ts  (PB-1 Phase 3 — the CS trend folds module verdicts)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/customer/incident-trend-core.test.ts
 *
 * Ports the PB-4 owner case (64 tombstones ≠ "64 opened") onto module verdicts,
 * proves the fold agrees with the pre-cutover rule on the PB-1 parity world, and
 * pins the one D8 correction. Synthetic ids only.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { deriveIncidentVerdicts } from "@/lib/platform/incidents/intelligence/core";
import type { IncidentFacts, IncidentRowFacts } from "@/lib/platform/incidents/intelligence/types";
import { syncIssueState } from "@/lib/platform/sync-issue-semantics";
import { countByDay, windowDayKeys } from "@/lib/platform/trends/daily-core";
import { buildWorld } from "@/lib/platform/incidents/parity/world";
import { worldToFacts } from "@/lib/platform/incidents/parity/module-adapter";
import { incidentTrendInstants } from "./incident-trend-core";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
}
const at = (s: string) => new Date(s);
const NOW = at("2026-11-03T23:00:00Z");
const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);

function row(id: string, kind: string, o: Partial<IncidentRowFacts> = {}): IncidentRowFacts {
  return {
    id, kind, provider: "PLAID", plaidItemId: "item_live", financialAccountId: null, plaidTransactionId: null,
    detail: { stage: "transaction-persist", cursorBlocking: true }, resolved: false, incidentKey: null, previousIncidentId: null,
    createdAt: at("2026-11-01T10:00:00Z"), firstOccurredAt: at("2026-11-01T10:00:00Z"), lastOccurredAt: at("2026-11-03T20:00:00Z"),
    resolvedAt: null, resolutionKind: null, resolutionReasonCode: null, lifecycleState: null, acknowledgedAt: null,
    recoveringSince: null, archivedAt: null, subjectUserId: null, causeStatus: null, causeCode: null, evidence: null,
    occurrenceCount: 1, correlatedOccurrenceCount: 0, ...o,
  };
}
const facts = (rows: IncidentRowFacts[]): IncidentFacts => ({
  rows, scanTruncated: false,
  subjects: { items: new Map([["item_live", { status: "ACTIVE", userId: null }]]), accounts: new Map() },
});
const verdicts = (rows: IncidentRowFacts[]) => deriveIncidentVerdicts(facts(rows), { now: NOW, audience: "PLATFORM_OPS" }).all;

console.log("1. the owner's case on module verdicts — events, superseded and removed rows are not episodes");
{
  const tombstones = Array.from({ length: 64 }, (_, i) => row(`t${i}`, "REMOVED_TOMBSTONE", { resolved: true, plaidTransactionId: `ptx${i}`, detail: {} }));
  const rows = [
    ...tombstones,
    row("active1", "TRANSACTION_PERSISTENCE_FAILED", { firstOccurredAt: at("2026-11-02T09:00:00Z") }),
    row("active2", "WALLET_SYNC_FAILED", { provider: "WALLET", plaidItemId: null, firstOccurredAt: null, createdAt: at("2026-11-03T09:00:00Z"), detail: {} }),
    row("recovered1", "TRANSACTION_PERSISTENCE_FAILED", { resolved: true, resolutionKind: "AUTOMATIC_RECOVERY", firstOccurredAt: at("2026-11-01T08:00:00Z"), resolvedAt: at("2026-11-03T12:00:00Z") }),
    row("superseded1", "BALANCE_TX_MISMATCH", { detail: {} }),
    row("removed1", "MISSING_ACCOUNT", { plaidItemId: "item_gone", detail: {} }),
  ];
  const eps = incidentTrendInstants(verdicts(rows));
  const keys = windowDayKeys(NOW, 14);
  const opened = countByDay(keys, eps.map((e) => e.openedAt));
  const resolved = countByDay(keys, eps.map((e) => e.resolvedAt));
  check("opened = 3 episodes (first occurrence, else created) — not 64 + …", sum(opened) === 3 && opened["2026-11-01"] === 1 && opened["2026-11-02"] === 1 && opened["2026-11-03"] === 1, opened);
  check("resolved = 1 (the resolution's resolvedAt day)", sum(resolved) === 1 && resolved["2026-11-03"] === 1, resolved);
  check("64 tombstones alone ⇒ 0 episodes", incidentTrendInstants(verdicts(tombstones)).length === 0);
  check("a removed-connection incident is neither opened nor resolved (D2 — never an orphan, never a recovery)",
    incidentTrendInstants(verdicts([row("removed1", "MISSING_ACCOUNT", { plaidItemId: "item_gone", detail: {} })])).length === 0);
}

console.log("2. D10 — a stale-unverified incident still opened, has not resolved");
{
  const v = verdicts([row("stale", "TRANSACTION_PERSISTENCE_FAILED", { lastOccurredAt: at("2026-08-01T00:00:00Z"), firstOccurredAt: at("2026-08-01T00:00:00Z") })]);
  const eps = incidentTrendInstants(v);
  check("counted once as opened, never resolved", eps.length === 1 && eps[0].resolvedAt === null);
}

console.log("3. D8 — a folded legacy duplicate is ONE episode (the one visible change)");
{
  const key = "v1::PLAID::item:item_live::transactions::transaction-persist";
  const v = verdicts([
    row("dup_old", "TRANSACTION_PERSISTENCE_FAILED", { incidentKey: key, lastOccurredAt: at("2026-11-02T00:00:00Z") }),
    row("dup_new", "TRANSACTION_PERSISTENCE_FAILED", { incidentKey: key, lastOccurredAt: at("2026-11-03T00:00:00Z") }),
  ]);
  check("fixture: the module folds one as a duplicate of the other", v.filter((x) => x.duplicateOf !== null).length === 1, v.map((x) => [x.id, x.duplicateOf]));
  check("the trend counts the episode once", incidentTrendInstants(v).length === 1);
}

console.log("4. parity world — the fold agrees with the pre-cutover rule (every difference is a D8 duplicate)");
{
  const w = buildWorld();
  const f = worldToFacts(w);
  const vs = deriveIncidentVerdicts(f, { now: w.now, audience: "PLATFORM_OPS" }).all;
  const byId = new Map(vs.map((v) => [v.id, v] as const));
  // PRE-CUTOVER rule (inline, historical): syncIssueState with the subjects-core referent rule
  // (getIncidentEpisodeTimeline after R4) — an episode is active or recovered.
  const baseline = new Map<string, { opened: number; resolved: number | null }>();
  for (const r of f.rows) {
    const removed = ["DELETED", "REVOKED", "MISSING"].includes(byId.get(r.id)!.subjectState);
    const s = syncIssueState({ kind: r.kind, provider: r.provider, detail: r.detail, plaidTransactionId: r.plaidTransactionId }, { referentExists: !removed, resolved: r.resolved });
    if (s !== "active" && s !== "recovered") continue;
    baseline.set(r.id, { opened: (r.firstOccurredAt ?? r.createdAt).getTime(), resolved: s === "recovered" && r.resolvedAt ? r.resolvedAt.getTime() : null });
  }
  const now = new Map<string, { opened: number; resolved: number | null }>();
  for (const v of vs) {
    const [e] = incidentTrendInstants([v]);
    if (e) now.set(v.id, { opened: e.openedAt.getTime(), resolved: e.resolvedAt?.getTime() ?? null });
  }
  const ids = [...new Set([...baseline.keys(), ...now.keys()])];
  const diffs = ids.filter((id) => JSON.stringify(baseline.get(id)) !== JSON.stringify(now.get(id)));
  const unexplained = diffs.filter((id) => byId.get(id)?.duplicateOf == null);
  check(`world: ${diffs.length} difference(s), every one a D8 folded duplicate`, unexplained.length === 0,
    unexplained.map((id) => ({ id, before: baseline.get(id) ?? null, after: now.get(id) ?? null })));
  check("the world exercises the trend (episodes opened and resolved)", now.size > 0 && [...now.values()].some((x) => x.resolved !== null));
}

console.log("5. source pins — the trend reads module verdicts only");
{
  const code = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const core = code("lib/platform/customer/incident-trend-core.ts");
  check("the fold reads verdict fields only — no row → state call, no syncIssue, no referent rule",
    !/syncIssueState|episodeStateOf|syncIssue\.|referent|resolved:/.test(core) && /v\.rowClass !== "incident"/.test(core) && /v\.duplicateOf !== null/.test(core));
  const daily = code("lib/platform/customer/incidents-daily.ts");
  check("the reader reads the module's window at the identity-free tier, through the fold",
    /incidentAccessors\.window\(atOpsTier\(incidentToken\)!, \{ from: since, to: now \}, \{ limit: INCIDENTS_DAILY_ROW_CAP, now \}\)/.test(daily)
    && /incidentTrendInstants\(page\.items\)/.test(daily) && !/projections|episodes-core|systemDb|syncIssue/.test(daily));
  const route = code("app/api/platform/customer-success/incidents-daily/route.ts");
  check("the route mints the CS token from its own guard result", /const incidentToken = incidentAudienceFor\(auth\);/.test(route) && /incidentToken\.audience !== "CUSTOMER_SUCCESS"/.test(route));
}

if (failures) { console.error(`\nincident-trend-core.test: ${failures} failure(s).`); process.exit(1); }
console.log("\nincident-trend-core.test: all passed.");
