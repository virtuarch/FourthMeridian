/**
 * lib/platform/incidents/intelligence/critical-scan.test.ts  (S2 P8 4b — Ops attention critical-kind second scan)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/incidents/intelligence/critical-scan.test.ts
 *
 * `brokenNow(token, { limit, criticalOpenLimit })` over an in-memory client that
 * honours the scan predicates the loader issues (resolved / kind in / id notIn,
 * lastOccurredAt desc, take). Pins:
 *   1. CRITICAL_KINDS is the classifier's own answer (no kind that can be critical is missed);
 *   2. a critical open incident older than the 200 recent open rows APPEARS;
 *   3. no duplicate when it is also in the recent scan (and mergeFacts de-duplicates by id);
 *   4. the second scan reaching its cap ⇒ `truncated`, never silent;
 *   5. a NON-critical old incident still does not appear (unchanged);
 *   6. without `criticalOpenLimit` the accessor is the single scan, unchanged;
 *   7. the Ops composition stays identity-free, and attention.ts wires the option.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { SyncIssueKind, UserRole } from "@prisma/client";
import { classifySyncIssue } from "@/lib/platform/sync-issue-semantics";
import { projectVerdictForPlatform } from "@/lib/platform/incidents/platform-projection";
import { buildAttention } from "@/lib/platform/ops/attention-core";
import { createIncidentAccessors, CRITICAL_KINDS, DEFAULT_SCAN_LIMIT, type IncidentFactsReader } from "./index";
import { incidentAudienceFor, type CsToken, type OpsToken } from "./audience";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
}

const NOW = new Date("2026-11-03T12:00:00Z");
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const OWNER = "u_owner_000000000001";

type Row = ReturnType<typeof row>;
function row(id: string, kind: string, provider: string, lastMinsAgo: number, resolved = false) {
  return {
    id, kind, provider, plaidItemId: `item_${id}`, financialAccountId: null, plaidTransactionId: null, detail: null,
    resolved, incidentKey: null, previousIncidentId: null,
    createdAt: minsAgo(lastMinsAgo + 5), firstOccurredAt: minsAgo(lastMinsAgo + 5), lastOccurredAt: minsAgo(lastMinsAgo),
    resolvedAt: resolved ? minsAgo(lastMinsAgo) : null, resolutionKind: null, resolutionReasonCode: null, lifecycleState: null,
    acknowledgedAt: null, recoveringSince: null, archivedAt: null, subjectUserId: OWNER, causeStatus: null, causeCode: null,
    resolutionEvidence: null, _count: { occurrences: 1 },
  };
}
/** `n` recent open NON-critical rows (wallet sync, severity error), newest first. */
const recentRows = (n: number): Row[] => Array.from({ length: n }, (_, i) => row(`r_${String(i).padStart(4, "0")}`, "WALLET_SYNC_FAILED", "WALLET", i + 1));

type Where = Record<string, unknown> | undefined;
function matches(w: Where, r: Row): boolean {
  if (!w) return true;
  if (typeof w.id === "string") return r.id === w.id;
  if (w.resolved === false && r.resolved) return false;
  const kinds = (w.kind as { in?: string[] } | undefined)?.in;
  if (kinds && !kinds.includes(r.kind)) return false;
  const notIn = (w.id as { notIn?: string[] } | undefined)?.notIn;
  if (notIn && notIn.includes(r.id)) return false;
  return true;
}

function clientOver(rows: Row[]): { client: IncidentFactsReader; scans: number[] } {
  const scans: number[] = [];
  const client: IncidentFactsReader = {
    syncIssue: {
      findMany: (async (a: { where?: Where; take?: number }) => {
        const out = rows.filter((r) => matches(a.where, r))
          .sort((x, y) => y.lastOccurredAt.getTime() - x.lastOccurredAt.getTime() || (x.id < y.id ? -1 : 1))
          .slice(0, a.take ?? rows.length);
        scans.push(out.length);
        return out;
      }) as never,
    },
    syncIssueOccurrence: { findMany: (async () => []) as never, groupBy: (async () => []) as never },
    syncIssueArchive: { findMany: (async () => []) as never },
    syncIssueRelation: { findMany: (async () => []) as never },
    syncIssueEvent: { findMany: (async () => []) as never },
    financialAccount: { findMany: (async () => []) as never },
    plaidItem: {
      findMany: (async (a: { where?: Where }) => {
        const ids = (a.where?.id as { in?: string[] } | undefined)?.in ?? [];
        return ids.map((id) => ({ id, status: "ACTIVE", userId: OWNER }));
      }) as never,
    },
    latestAttempts: (async () => []) as never,
  };
  return { client, scans };
}

const ops = incidentAudienceFor({ user: { role: UserRole.USER }, grant: { area: "PLATFORM_OPS", level: "READ" } as never }) as OpsToken;
const cs = incidentAudienceFor({ user: { role: UserRole.USER }, grant: { area: "CUSTOMER_SUCCESS", level: "READ" } as never }) as CsToken;
const OPTS = { now: NOW, limit: DEFAULT_SCAN_LIMIT, criticalOpenLimit: 100 };

async function main(): Promise<void> {
  console.log("S2 P8 4b — critical-kind second scan\n\n1. CRITICAL_KINDS is the classifier's");
  const stages = [null, "transaction-persist", "investment-import-repair", "import-rollback-repair", "balance", "event-identity-persist"];
  const everCritical = Object.values(SyncIssueKind).filter((kind) =>
    ["PLAID", "WALLET"].some((provider) => stages.some((stage) => [null, "tx_1"].some((plaidTransactionId) =>
      classifySyncIssue({ kind, provider, detail: stage ? { stage } : null, plaidTransactionId }).severity === "critical"))));
  check("every kind that classifies critical under any probed stage/provider is in CRITICAL_KINDS",
    everCritical.every((k) => CRITICAL_KINDS.includes(k)), { everCritical, CRITICAL_KINDS });
  check("…and nothing else", CRITICAL_KINDS.every((k) => everCritical.includes(k as SyncIssueKind)), CRITICAL_KINDS);
  check("TRANSACTION_PERSISTENCE_FAILED is critical, WALLET_SYNC_FAILED is not",
    CRITICAL_KINDS.includes("TRANSACTION_PERSISTENCE_FAILED") && !CRITICAL_KINDS.includes("WALLET_SYNC_FAILED"));

  console.log("\n2. an old critical open incident behind 200 newer open rows APPEARS");
  const oldCritical = row("c_old", "TRANSACTION_PERSISTENCE_FAILED", "PLAID", 24 * 60);
  const oldNonCritical = row("n_old", "WALLET_SYNC_FAILED", "WALLET", 24 * 60 + 1);
  const oldClosedCritical = row("c_closed", "TRANSACTION_PERSISTENCE_FAILED", "PLAID", 24 * 60 + 2, true);
  const world = [...recentRows(250), oldCritical, oldNonCritical, oldClosedCritical];
  {
    const { client } = clientOver(world);
    const single = await createIncidentAccessors(client).brokenNow(ops, { now: NOW, limit: DEFAULT_SCAN_LIMIT });
    check("control: the single scan misses it (the defect)", !single.items.some((v) => v.id === "c_old") && single.truncated);
  }
  const { client, scans } = clientOver(world);
  const page = await createIncidentAccessors(client).brokenNow(ops, OPTS);
  check("the old critical incident is listed", page.items.some((v) => v.id === "c_old"), page.items.length);
  check("…ranked first (critical outranks the newer errors)", page.items[0]?.id === "c_old", page.items[0]?.id);
  check("two scans ran: the recent 200, then the critical-kind scan", scans.length >= 2 && scans[0] === 200 && scans[1] === 1, scans);
  check("a closed old critical incident is not listed", !page.items.some((v) => v.id === "c_closed"));

  console.log("\n5. a non-critical old incident still does not appear");
  check("the old wallet incident stays outside the list", !page.items.some((v) => v.id === "n_old"));
  check("…and the list is still a floor (truncated), as before", page.truncated === true);

  console.log("\n3. no duplicate when the critical incident is also in the recent scan");
  {
    const recentCritical = row("c_recent", "TRANSACTION_PERSISTENCE_FAILED", "PLAID", 0);
    const { client: c2 } = clientOver([...recentRows(250), recentCritical, oldCritical]);
    const p2 = await createIncidentAccessors(c2).brokenNow(ops, OPTS);
    const ids = p2.items.map((v) => v.id);
    check("every id is listed once", new Set(ids).size === ids.length, ids.length);
    check("both critical incidents are listed", ids.includes("c_recent") && ids.includes("c_old"));
    // mergeFacts itself de-duplicates (a fake that ignores notIn returns the overlap).
    const overlapping = clientOver([...recentRows(250), recentCritical, oldCritical]);
    const ignoreNotIn = overlapping.client.syncIssue.findMany;
    overlapping.client.syncIssue.findMany = (async (a: { where?: Where; take?: number }) => {
      const w = a.where ? { ...a.where, id: undefined } : a.where;
      return (ignoreNotIn as unknown as (x: unknown) => Promise<unknown>)({ ...a, where: w });
    }) as never;
    const p3 = await createIncidentAccessors(overlapping.client).brokenNow(ops, OPTS);
    const ids3 = p3.items.map((v) => v.id);
    check("…even when the second scan returns rows the first already read (merge de-duplicates by id)",
      new Set(ids3).size === ids3.length && ids3.filter((x) => x === "c_recent").length === 1, ids3.length);
  }

  console.log("\n4. the second scan reaching its cap ⇒ truncated");
  {
    const manyCritical = Array.from({ length: 5 }, (_, i) => row(`c_${i}`, "TRANSACTION_PERSISTENCE_FAILED", "PLAID", 24 * 60 + i));
    const { client: c4, scans: s4 } = clientOver([...recentRows(250), ...manyCritical]);
    const p4 = await createIncidentAccessors(c4).brokenNow(ops, { ...OPTS, criticalOpenLimit: 3 });
    check("the second scan read exactly its cap", s4[1] === 3, s4);
    check("the result is marked truncated", p4.truncated === true);
    check("…and lists the capped critical rows (3), not more", p4.items.filter((v) => v.id.startsWith("c_")).length === 3);
  }

  console.log("\n6. unchanged paths");
  {
    const { client: c6, scans: s6 } = clientOver(recentRows(10).concat(oldCritical));
    const p6 = await createIncidentAccessors(c6).brokenNow(ops, OPTS);
    check("recent scan not cut ⇒ no second scan, not truncated", s6.length === 1 && !p6.truncated, s6);
    check("…and the old critical is there from the first scan", p6.items.some((v) => v.id === "c_old"));
    const { client: c7, scans: s7 } = clientOver(world);
    await createIncidentAccessors(c7).brokenNow(ops, { now: NOW, limit: DEFAULT_SCAN_LIMIT });
    check("no criticalOpenLimit ⇒ exactly one SyncIssue scan", s7.length === 1, s7);
  }

  console.log("\n7. identity-free on Ops; CS still attributes");
  {
    const noIdentity = (x: unknown) => !/"subjectUserId"|u_owner_000000000001/.test(JSON.stringify(x));
    check("brokenNow (Ops) with the second scan carries no subjectUserId and no customer id", noIdentity(page));
    const items = page.items.map((v) => projectVerdictForPlatform(v, { primary: null, secondary: null }, null));
    const core = buildAttention({ connections: null, jobs: null, providers: null, resources: null, alerts: null, policyAssignments: null,
      incidents: { items: items.slice(0, 20), activeTotal: items.length, truncated: page.truncated } } as never, NOW);
    check("the Ops attention composition shows it and stays identity-free",
      core.items.some((i) => i.id === "incident:c_old") && noIdentity(core.items), core.items.length);
    const csPage = await createIncidentAccessors(clientOver(world).client).brokenNow(cs, OPTS);
    const csOld = csPage.items.find((v) => v.id === "c_old") as { subjectUserId?: string } | undefined;
    check("control: the CS tier attributes the same row (the fixture CAN carry identity)", csOld?.subjectUserId === OWNER);
    const src = readFileSync(path.join(process.cwd(), "lib/platform/ops/attention.ts"), "utf8");
    check("attention.ts asks brokenNow for the second scan with its own cap",
      /incidentAccessors\.brokenNow\(token, \{ limit: ATTENTION_INCIDENT_SCAN, criticalOpenLimit: ATTENTION_CRITICAL_SCAN \}\)/.test(src)
      && /export const ATTENTION_CRITICAL_SCAN = \d+;/.test(src));
  }

  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\ncritical-scan.test: all passed.");
}

main().catch((e) => { console.error(e); process.exit(1); });
