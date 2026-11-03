/**
 * lib/platform/convergence/r3-cutover.test.ts  (PB-1 Phase 2 R3 — convergence reads module verdicts)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/convergence/r3-cutover.test.ts
 *
 * Synthetic ids only. The reader is a fake; the participant and correlation are real.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { UserRole } from "@prisma/client";
import { convSyncIssueOf, getConvergence } from "@/lib/platform/convergence/convergence";
import { atOpsTier, incidentAudienceFor, type OpsToken } from "@/lib/platform/incidents/intelligence/audience";
import { deriveIncidentVerdicts } from "@/lib/platform/incidents/intelligence/core";
import { createIncidentAccessors, type IncidentFactsReader } from "@/lib/platform/incidents/intelligence";
import type { CsIncidentVerdict, IncidentFacts, IncidentRowFacts } from "@/lib/platform/incidents/intelligence/types";
import { convergenceInstant, syncIssueOutcome, type ConvSyncIssue, type ConvergenceReaders } from "@/lib/platform/convergence/participants";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
}

function issue(id: string, over: Partial<ConvSyncIssue> = {}): ConvSyncIssue {
  return {
    id, provider: "PLAID", kind: "UPSERT_ERROR", plaidItemId: "item_a", financialAccountId: null,
    rowClass: "incident", state: "active", closure: null, severity: "critical", domain: "transactions",
    operation: "transaction-persist", episodeKey: `key_${id}`,
    firstSeenAt: "2026-11-01T10:00:00.000Z", lastSeenAt: "2026-11-02T10:00:00.000Z", resolvedAt: null,
    subjectLabel: "Bank A", ...over,
  };
}

const NOW = new Date("2026-11-03T12:00:00Z");
function readers(rows: ConvSyncIssue[]): ConvergenceReaders {
  return {
    now: NOW, jobRuns: async () => [], alertRuns: async () => [], syncIssues: async () => rows,
    statusTransitions: async () => [], lifecycleEvents: async () => [],
  };
}

async function main() {
  console.log("outcome is the module's verdict (MODULE_OPEN ⇔ state === \"active\")");
  check("active ⇒ degraded", syncIssueOutcome(issue("a")) === "degraded");
  for (const s of ["acknowledged", "recovering", "stale-unverified"] as const) {
    check(`${s} ⇒ not degraded (action)`, syncIssueOutcome(issue("x", { state: s })) === "action");
  }
  check("resolved (recovered / operator) ⇒ recovery", syncIssueOutcome(issue("r", { state: "resolved", closure: "recovered" })) === "recovery"
    && syncIssueOutcome(issue("o", { state: "resolved", closure: "operator" })) === "recovery");
  check("D2/D2b connection removed ⇒ action, never recovery", syncIssueOutcome(issue("c", { state: "resolved", closure: "connection-removed" })) === "action");
  check("D1 evidence / superseded ⇒ action", syncIssueOutcome(issue("e", { rowClass: "evidence", state: "resolved" })) === "action"
    && syncIssueOutcome(issue("s", { rowClass: "superseded", state: "resolved" })) === "action");

  console.log("D7 — timeline instant");
  check("open rows sit at their latest occurrence", convergenceInstant(issue("a")) === "2026-11-02T10:00:00.000Z");
  check("closed rows sit at their resolution", convergenceInstant(issue("r", { state: "resolved", closure: "recovered", resolvedAt: "2026-11-03T01:00:00.000Z" })) === "2026-11-03T01:00:00.000Z");

  console.log("D8 — one story per incident episode, per subject");
  {
    const res = await getConvergence({ asOf: "2026-11-03", from: "2026-10-20" }, {
      now: NOW,
      readers: readers([
        issue("g1", { episodeKey: "k_shared", state: "resolved", closure: "recovered", resolvedAt: "2026-10-25T00:00:00.000Z" }),
        issue("g2", { episodeKey: "k_shared" }),
        issue("other", { episodeKey: "k_other" }),
      ]),
    });
    const syncEpisodes = res.episodes.filter((e) => e.participants.includes("syncIssue"));
    check("the recurrence pair is one episode; an unrelated incident on the same item is another", syncEpisodes.length === 2
      && syncEpisodes.some((e) => e.events.length === 2), syncEpisodes.map((e) => e.events.length));
    const json = JSON.stringify(res);
    check("no raw stage, no customer id, no detail in the payload", !/"detail":\{|subjectUserId|u_/.test(json));
  }

  console.log("D5 — truncation reaches the result; OPEN-FIRST under a small cap");
  {
    const res = await getConvergence({ asOf: "2026-11-03", from: "2026-10-20" }, {
      now: NOW, readers: { ...readers([issue("a")]), incidentScan: () => ({ truncated: true, scanned: 3, cap: 3 }) },
    });
    check("the result carries the scan's truncation", res.incidentScan?.truncated === true && res.incidentScan.cap === 3);
    const none = await getConvergence({ asOf: "2026-11-03", from: "2026-10-20" }, { now: NOW, readers: readers([]) });
    check("…and null when the reader reports none", none.incidentScan === null);

    const D = (iso: string) => new Date(iso);
    const base = (id: string, over: Partial<IncidentRowFacts>): IncidentRowFacts => ({
      id, kind: "UPSERT_ERROR", provider: "PLAID", plaidItemId: "item_a", financialAccountId: null, plaidTransactionId: null,
      detail: null, resolved: false, incidentKey: null, previousIncidentId: null, createdAt: D("2026-09-01T00:00:00Z"),
      firstOccurredAt: D("2026-09-01T00:00:00Z"), lastOccurredAt: D("2026-09-01T00:00:00Z"), resolvedAt: null, resolutionKind: null,
      resolutionReasonCode: null, lifecycleState: null, acknowledgedAt: null, recoveringSince: null, archivedAt: null,
      subjectUserId: null, causeStatus: null, causeCode: null, evidence: null, occurrenceCount: 1, correlatedOccurrenceCount: 0, ...over,
    });
    // Two OLD open rows (D6) and three RECENT closed rows that touched the window.
    const ROWS = [
      base("old_open_1", {}), base("old_open_2", { lastOccurredAt: D("2026-08-01T00:00:00Z") }),
      ...[1, 2, 3].map((i) => base(`closed_${i}`, { resolved: true, resolutionKind: "AUTOMATIC_RECOVERY",
        lastOccurredAt: D(`2026-11-0${i}T00:00:00Z`), resolvedAt: D(`2026-11-0${i}T01:00:00Z`) })),
    ];
    const scans: { resolved: unknown; take: number }[] = [];
    const empty = (async () => []) as never;
    const client: IncidentFactsReader = {
      syncIssue: { findMany: (async (a: { where?: { resolved?: boolean }; take: number }) => {
        scans.push({ resolved: a.where?.resolved, take: a.take });
        const rows = ROWS.filter((r) => a.where?.resolved === undefined || r.resolved === a.where.resolved)
          .sort((x, y) => (y.lastOccurredAt!.getTime() - x.lastOccurredAt!.getTime()));
        return rows.slice(0, a.take).map((r) => ({ ...r, resolutionEvidence: null, _count: { occurrences: 1 } }));
      }) as never },
      syncIssueOccurrence: { findMany: empty, groupBy: empty },
      syncIssueArchive: { findMany: empty }, syncIssueRelation: { findMany: empty }, syncIssueEvent: { findMany: empty },
      financialAccount: { findMany: empty },
      plaidItem: { findMany: (async () => [{ id: "item_a", status: "ACTIVE", userId: "u_1" }]) as never },
      latestAttempts: empty,
    } as IncidentFactsReader;
    const ops = incidentAudienceFor({ user: { role: UserRole.USER }, grant: { area: "PLATFORM_OPS", level: "READ" } as never }) as OpsToken;
    const page = await createIncidentAccessors(client).window(ops, { from: D("2026-10-20T00:00:00Z"), to: D("2026-11-03T23:59:59Z") }, { now: NOW, limit: 3 });
    const ids = page.items.map((v) => v.id);
    check("open rows are scanned FIRST (both old open rows kept, whatever their dates)", ids.includes("old_open_1") && ids.includes("old_open_2"), ids);
    check("closed in-window rows take only the remainder (newest first)", ids.filter((x) => x.startsWith("closed_")).join() === "closed_3", ids);
    check("the scan is reported truncated (story counts are a floor)", page.truncated === true && page.scanned === 3);
    check("open scan with the full cap, then closed with the remainder", scans[0]?.resolved === false && scans[0].take === 3 && scans[1]?.resolved === true && scans[1].take === 1, scans);
  }

  console.log("identity — break-glass is pinned to the Ops tier, and the mapping drops identity anyway");
  {
    const sa = incidentAudienceFor({ user: { role: UserRole.SYSTEM_ADMIN }, grant: null });
    check("a System Admin's break-glass mints CUSTOMER_SUCCESS …", sa?.audience === "CUSTOMER_SUCCESS");
    check("… and atOpsTier downgrades it to PLATFORM_OPS", atOpsTier(sa)?.audience === "PLATFORM_OPS");
    const ops = incidentAudienceFor({ user: { role: UserRole.USER }, grant: { area: "PLATFORM_OPS", level: "READ" } as never });
    check("an Ops token stays Ops; null stays null", atOpsTier(ops) === ops && atOpsTier(null) === null);
    let refused = false;
    try { atOpsTier(Object.freeze({ audience: "CUSTOMER_SUCCESS" }) as never); } catch { refused = true; }
    check("a forged token is refused (never laundered into a real one)", refused);
    const conv = readFileSync(path.join(process.cwd(), "app/api/platform/platform-ops/convergence/route.ts"), "utf8");
    check("the Ops convergence route mints at the Ops tier", /atOpsTier\(incidentAudienceFor\(auth\)\)/.test(conv));

    const facts: IncidentFacts = {
      rows: [{
        id: "cs_row", kind: "UPSERT_ERROR", provider: "PLAID", plaidItemId: "item_a", financialAccountId: null, plaidTransactionId: null,
        detail: null, resolved: false, incidentKey: null, previousIncidentId: null, createdAt: NOW, firstOccurredAt: NOW, lastOccurredAt: NOW,
        resolvedAt: null, resolutionKind: null, resolutionReasonCode: null, lifecycleState: null, acknowledgedAt: null, recoveringSince: null,
        archivedAt: null, subjectUserId: "u_customer_9", causeStatus: null, causeCode: null, evidence: null, occurrenceCount: 1, correlatedOccurrenceCount: 0,
      }],
      subjects: { items: new Map([["item_a", { status: "ACTIVE", userId: "u_customer_9" }]]), accounts: new Map() },
      scanTruncated: false,
    };
    const csVerdicts = deriveIncidentVerdicts(facts, { now: NOW, audience: "CUSTOMER_SUCCESS" }).all as CsIncidentVerdict[];
    check("(fixture) the CS-tier verdict does carry the customer id", csVerdicts[0].subjectUserId === "u_customer_9");
    const rows = csVerdicts.map((v) => convSyncIssueOf(v, "Bank A"));
    const res = await getConvergence({ asOf: "2026-11-03", from: "2026-10-20" }, { now: NOW, readers: readers(rows) });
    const json = JSON.stringify({ rows, res });
    check("convergence built from CS-tier verdicts has no subjectUserId key and no customer id anywhere",
      !rows.some((r) => "subjectUserId" in r) && !json.includes("subjectUserId") && !json.includes("u_customer_9"));
  }

  console.log("source pins");
  {
    const strip = (x: string) => x.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const conv = strip(readFileSync(path.join(process.cwd(), "lib/platform/convergence/convergence.ts"), "utf8"));
    const part = strip(readFileSync(path.join(process.cwd(), "lib/platform/convergence/participants.ts"), "utf8"));
    check("convergence reads no SyncIssue directly — only the module's window accessor",
      !/\.syncIssue\./.test(conv) && /incidentAccessors\.window\(incidentToken/.test(conv));
    const syncPart = part.slice(part.indexOf("const syncIssueParticipant"), part.indexOf("const auditTransitionParticipant"));
    check("the sync-issue participant derives no state of its own (no classifier, no syncIssueState, no row detail)",
      syncPart.length > 0 && !/classifySyncIssue|syncIssueState|stageOf|r\.detail/.test(part) && !/r\.detail/.test(syncPart));
    check("no token ⇒ refused (fail closed), never an unscoped read", /if \(!incidentToken\) throw/.test(conv));
  }

  if (failures) { console.error(`\nr3-cutover.test: ${failures} failure(s).`); process.exit(1); }
  console.log("\nr3-cutover.test: all passed.");
}

void main();
