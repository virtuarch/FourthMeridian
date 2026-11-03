/**
 * lib/activity/member-incidents.test.ts  (PB-1 Phase 3 — the member feed reads the module's pure core)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/activity/member-incidents.test.ts
 *
 * Synthetic ids only; pure + source pins.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { SyncIssueKind } from "@prisma/client";
import { classifySyncIssue } from "@/lib/platform/sync-issue-semantics";
import { normalizeSyncIssueEvent } from "./normalize-sync-issue";
import { MEMBER_INCIDENT_EVENT_KEYS, memberIncidentEvents, memberIncidentFacts, type MemberSyncIssueRow } from "./member-incidents";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
}

const NOW = new Date("2026-11-03T12:00:00Z");
const row = (id: string, over: Partial<MemberSyncIssueRow> = {}): MemberSyncIssueRow => ({
  id, kind: "TRANSACTION_PERSISTENCE_FAILED", resolved: false, createdAt: new Date("2026-11-02T00:00:00Z"), plaidTransactionId: "txn_1", ...over,
});
const ids = (rows: MemberSyncIssueRow[]) => memberIncidentEvents(rows, NOW).map((e) => e.id);

console.log("facts — every unreadable column is explicitly null; D2b stays out");
{
  const f = memberIncidentFacts([row("a")]);
  const r = f.rows[0];
  check("plaidItemId and financialAccountId are null (D2b out; D2 is the route's scope)", r.plaidItemId === null && r.financialAccountId === null);
  check("no detail, no lifecycle, no identity, no key", r.detail === null && r.lifecycleState === null && r.subjectUserId === null && r.incidentKey === null && r.lastOccurredAt === null);
  check("provider PLAID (implied by plaidTransactionId)", r.provider === "PLAID");
  check("no attempt evidence supplied (UNKNOWN never hides a row) and no subjects", f.attempts === undefined && f.subjects.items.size === 0 && f.subjects.accounts.size === 0);
}

console.log("verdicts → member events");
{
  check("an open member-actionable incident is an event, keyed exactly {id, kind, at}",
    (() => { const [e] = memberIncidentEvents([row("a")], NOW); return !!e && Object.keys(e).sort().join() === [...MEMBER_INCIDENT_EVENT_KEYS].sort().join() && e.at === "2026-11-02T00:00:00.000Z"; })());
  check("a resolved row is never an event", ids([row("r", { resolved: true })]).length === 0);
  check("D1: a tombstone (evidence) is never an event", ids([row("t", { kind: "REMOVED_TOMBSTONE" })]).length === 0);
  check("D1: a BALANCE_TX_MISMATCH with no detail is never an event", ids([row("b", { kind: "BALANCE_TX_MISMATCH" })]).length === 0);
  check("a non-actionable row is never an event (UPSERT_ERROR without a transaction id)", ids([row("u", { kind: "UPSERT_ERROR", plaidTransactionId: null })]).length === 0);
  check("D10 not applied: a long-open incident is still an event (unknown evidence never hides)", ids([row("old", { createdAt: new Date("2026-06-01T00:00:00Z") })]).join() === "old");
  check("identity-free: no event carries a customer or opaque subject id", !/subjectUserId|plaidItemId|financialAccountId/.test(JSON.stringify(memberIncidentEvents([row("a")], NOW))));
}

console.log("Condition 1 — the member feed is UNCHANGED (old rule vs module path, every kind × txn id × resolved)");
{
  const diffs: unknown[] = [];
  for (const kind of Object.values(SyncIssueKind)) for (const txn of ["txn_1", null]) for (const resolved of [false, true]) {
    const r = row(`x_${kind}_${txn}_${resolved}`, { kind, plaidTransactionId: txn, resolved });
    const before = normalizeSyncIssueEvent({ id: r.id, kind, resolved, createdAt: r.createdAt }, classifySyncIssue({ kind, plaidTransactionId: txn }).customerActionable);
    const [e] = memberIncidentEvents([r], NOW);
    const after = e ? normalizeSyncIssueEvent({ id: e.id, kind: e.kind, resolved, createdAt: new Date(e.at) }) : null;
    if (JSON.stringify(before) !== JSON.stringify(after)) diffs.push({ kind, txn, resolved, before: before?.type ?? null, after: after?.type ?? null });
  }
  check("module path yields byte-identical member events to the pre-cutover rule for every case", diffs.length === 0, diffs);
}

console.log("source pins");
{
  const ROOT = process.cwd();
  const code = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const route = code("app/api/spaces/[id]/activity/route.ts");
  check("the route reads SyncIssue as the member (withTenantDb) and never through the fm_system module loaders",
    /withTenantDb\(/.test(route) && !/incidentAccessors|loadIncidentFacts|incidents\/intelligence["/]|systemDb|systemIncidentAudience|incidentAudienceFor/.test(route));
  check("the route hands its tenant rows to the pure member path", /memberIncidentEvents\(syncIssues, new Date\(\)\)/.test(route));
  check("Condition 2a: the route's WHERE requires plaidTransactionId != null",
    /where: \{ resolved: false, financialAccountId: \{ in: accountIds \}, plaidTransactionId: \{ not: null \} \}/.test(route));
  // Condition 2b — only the Plaid bank-transaction producer sets plaidTransactionId, so a row reaching the
  // member feed is a PLAID row. A future producer (e.g. a wallet) setting it would fail here first.
  function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === ".next") continue;
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) walk(rel, out); else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(rel);
    }
    return out;
  }
  const FACADE = "lib/plaid/syncIssues.ts";
  const producers = [...walk("lib"), ...walk("app"), ...walk("jobs").filter(() => true)].filter((f) => f !== FACADE && /recordSyncIssue\(/.test(code(f)));
  const setters = producers.filter((f) => /plaidTransactionId\s*:/.test(code(f)));
  check("Condition 2b: among recordSyncIssue producers, only the Plaid transaction sync sets plaidTransactionId",
    setters.join() === "lib/plaid/syncTransactions.ts", setters);
  const mod = code("lib/activity/member-incidents.ts");
  check("the member path tells the core MEMBER and never a token tier", /audience: "MEMBER"/.test(mod) && !/CUSTOMER_SUCCESS|PLATFORM_OPS|SYSTEM/.test(mod));
  check("the member path supplies no attempt evidence and no item", !/attempts:/.test(mod) && /plaidItemId: null,/.test(mod));
}

if (failures) { console.error(`\nmember-incidents.test: ${failures} failure(s).`); process.exit(1); }
console.log("\nmember-incidents.test: all passed.");
