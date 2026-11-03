/**
 * lib/platform/incidents/intelligence/investigation.test.ts  (PB-1 Phase 2B — search + investigate)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/incidents/intelligence/investigation.test.ts
 *
 * The two investigation accessors (index.ts `search`, `investigate`) and the
 * wire projection (investigation-dto.ts), end to end over an in-memory client
 * that evaluates the Prisma `where` subset the loader issues and counts reads:
 *   1. a forged / SYSTEM token is refused BEFORE any read;
 *   2. list total = KPI: the broken-now preset is exactly `brokenNow`, and the
 *      KPI (preset, no filters) and the list read the same query;
 *   3. the timeline renders SyncIssueEvent rows oldest first, field-for-field;
 *   4. Platform Ops output carries no identity — even from a CS-tier verdict;
 *   5. history search: status / provider / code / date filters, retention
 *      clamp, paging bounds;
 *   6. detail: relations, recurrence, archive state, affected counts, and
 *      only the EXISTING recovery routes.
 */

import { readFileSync } from "node:fs";
import { UserRole } from "@prisma/client";
import { createIncidentAccessors, type IncidentFactsReader } from "./index";
import { incidentAudienceFor, systemIncidentAudience, IncidentAudienceError, type CsToken, type OpsToken } from "./audience";
import {
  DEFAULT_SEARCH, HISTORY_RETENTION_DAYS, INCIDENT_PAGE_SIZE, MAX_INCIDENT_PAGE, incidentSearchParams, parseIncidentSearch, retentionFloorDay,
} from "./search-core";
import { incidentDetailDTO, incidentListDTO, incidentRowDTO } from "../investigation-dto";
import type { IncidentSearchQuery } from "./types";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
}

const NOW = new Date("2026-11-03T12:00:00Z");
const ago = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
const KEY = "v1::PLAID::item:item_c::banking::transaction-persist";

type Row = Record<string, unknown> & { id: string };
function row(o: Partial<Row> & { id: string }): Row {
  return {
    kind: "UPSERT_ERROR", provider: "PLAID", plaidItemId: null, financialAccountId: null, plaidTransactionId: null,
    detail: null, resolved: false, incidentKey: null, previousIncidentId: null, createdAt: ago(2), firstOccurredAt: ago(2),
    lastOccurredAt: ago(1), resolvedAt: null, resolutionKind: null, resolutionReasonCode: null, lifecycleState: null,
    acknowledgedAt: null, recoveringSince: null, archivedAt: null, subjectUserId: null, causeStatus: null, causeCode: null,
    resolutionEvidence: null, _count: { occurrences: 1 }, ...o,
  };
}

const ROWS: Row[] = [
  row({ id: "i_open_a", plaidItemId: "item_a" }),
  row({ id: "i_open_b", plaidItemId: "item_b", causeStatus: "HYPOTHESIS", causeCode: "PROVIDER_OUTAGE" }),
  // Past the 14-day Plaid window, nothing attempted since ⇒ stale-unverified (needs verification, NOT broken now).
  row({ id: "i_stale", plaidItemId: "item_a", lastOccurredAt: ago(30), firstOccurredAt: ago(40), createdAt: ago(40) }),
  row({ id: "i_res", plaidItemId: "item_c", resolved: true, resolvedAt: ago(5), lastOccurredAt: ago(6), firstOccurredAt: ago(9),
    resolutionKind: "AUTOMATIC_RECOVERY", incidentKey: KEY, previousIncidentId: "i_arch", _count: { occurrences: 3 } }),
  row({ id: "i_wallet", provider: "WALLET", kind: "WALLET_SYNC_FAILED", financialAccountId: "acct_w", resolved: true,
    resolvedAt: ago(20), lastOccurredAt: ago(21), firstOccurredAt: ago(22), resolutionKind: "SUBJECT_REMOVED" }),
  // 30 closed rows for paging (one page of 25 + 5), all on one live item.
  ...Array.from({ length: 30 }, (_, i) => row({ id: `i_hist_${String(i).padStart(2, "0")}`, plaidItemId: "item_c", resolved: true,
    resolvedAt: ago(50 + i), lastOccurredAt: ago(51 + i), firstOccurredAt: ago(52 + i), resolutionKind: "AUTOMATIC_RECOVERY" })),
];
const ARCHIVE: Row[] = [{
  id: "arch_row_1", incidentId: "i_arch", incidentKey: KEY, provider: "PLAID", kind: "UPSERT_ERROR", operation: "transaction-persist",
  plaidItemId: "item_c", financialAccountId: null, subjectUserId: "u_carol_000000003", previousIncidentId: null,
  firstOccurredAt: ago(220), lastOccurredAt: ago(210), resolvedAt: ago(200), resolutionKind: "AUTOMATIC_RECOVERY",
  resolutionReasonCode: null, causeStatus: null, causeCode: null, occurrenceCount: 4, archivedAt: ago(100), resolutionEvidence: null,
  eventTimeline: { events: [{ at: ago(220).toISOString(), type: "OBSERVED" }, { at: ago(200).toISOString(), type: "STATE_CHANGED", fromState: "ACTIVE", toState: "RESOLVED" }], truncated: false },
}];
const ITEMS = [
  { id: "item_a", status: "ACTIVE", userId: "u_alice_000000001", institutionName: "Example Bank" },
  { id: "item_b", status: "NEEDS_REAUTH", userId: "u_bob_00000000002", institutionName: "Sample Credit Union" },
  { id: "item_c", status: "ACTIVE", userId: "u_carol_000000003", institutionName: "Example Bank" },
];
const ACCOUNTS = [
  { id: "acct_1", deletedAt: null, ownerUserId: "u_alice_000000001", createdByUserId: null },
  { id: "acct_2", deletedAt: null, ownerUserId: "u_alice_000000001", createdByUserId: null },
  // The wallet account was removed (its incident closed as SUBJECT_REMOVED).
  { id: "acct_w", deletedAt: ago(20), ownerUserId: "u_dave_000000004", createdByUserId: null },
];
const USER_IDS = [...ITEMS.map((i) => i.userId), "u_dave_000000004"];

const RELATIONS = [{ fromIncidentId: "i_res", toIncidentId: "i_open_a", kind: "RELATED" }];
// Stored deliberately OUT of order: the timeline must come back oldest first, values untouched.
const EVENTS = [
  { id: "ev_3", incidentId: "i_res", at: ago(5), type: "STATE_CHANGED", actorKind: "SYSTEM", actorId: null, auditId: null, fromState: "ACTIVE", toState: "RESOLVED", causeCode: null, actionCode: null, outcomeCode: "RECOVERED_BY_EVIDENCE", refEventId: null, refreshExecutionId: "exec_9", jobRunId: null },
  { id: "ev_1", incidentId: "i_res", at: ago(9), type: "OBSERVED", actorKind: "SYSTEM", actorId: null, auditId: null, fromState: null, toState: "ACTIVE", causeCode: null, actionCode: null, outcomeCode: null, refEventId: null, refreshExecutionId: "exec_1", jobRunId: "job_1" },
  { id: "ev_2", incidentId: "i_res", at: ago(7), type: "CAUSE_HYPOTHESIZED", actorKind: "OPERATOR", actorId: "u_operator_00000009", auditId: "audit_1", fromState: null, toState: null, causeCode: "PROVIDER_OUTAGE", actionCode: null, outcomeCode: null, refEventId: null, refreshExecutionId: null, jobRunId: null },
];

// ── A tiny evaluator for the `where` subset the loader issues ─────────────────
type W = Record<string, unknown> | undefined;
function matches(w: W, r: Record<string, unknown>): boolean {
  if (!w) return true;
  for (const [k, cond] of Object.entries(w)) {
    if (k === "AND") { if (!(cond as W[]).every((c) => matches(c, r))) return false; continue; }
    if (k === "OR") { if (!(cond as W[]).some((c) => matches(c, r))) return false; continue; }
    const v = r[k];
    if (cond === null) { if (v !== null && v !== undefined) return false; continue; }
    if (typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as { in?: unknown[]; gte?: Date; lte?: Date; not?: unknown };
      if (c.in && !c.in.includes(v)) return false;
      if ("not" in c && c.not === null && (v === null || v === undefined)) return false;
      if (c.gte && !(v instanceof Date && v >= c.gte)) return false;
      if (c.lte && !(v instanceof Date && v <= c.lte)) return false;
      continue;
    }
    if (v !== cond) return false;
  }
  return true;
}

let reads = 0;
const byLastDesc = (a: Row, b: Row) => (b.lastOccurredAt as Date).getTime() - (a.lastOccurredAt as Date).getTime() || (a.id < b.id ? -1 : 1);
const client: IncidentFactsReader = {
  syncIssue: { findMany: (async (a: { where?: W; take?: number }) => { reads++; return ROWS.filter((r) => matches(a.where, r)).sort(byLastDesc).slice(0, a.take ?? 1e9); }) as never },
  syncIssueOccurrence: {
    findMany: (async (a: { where?: W }) => {
      reads++;
      const ids = ((a.where?.syncIssueId as { in?: string[] })?.in) ?? [];
      // i_open_a's occurrences named two accounts on its item.
      return ids.includes("i_open_a") ? [{ syncIssueId: "i_open_a", subjectAccountId: "acct_1", detail: null }, { syncIssueId: "i_open_a", subjectAccountId: "acct_2", detail: null }] : [];
    }) as never,
    groupBy: (async () => { reads++; return []; }) as never,
  },
  syncIssueArchive: { findMany: (async (a: { where?: W; take?: number }) => { reads++; return ARCHIVE.filter((r) => matches(a.where, r)).slice(0, a.take ?? 1e9); }) as never },
  syncIssueRelation: { findMany: (async (a: { where?: W }) => { reads++; return RELATIONS.filter((r) => matches(a.where, r)); }) as never },
  syncIssueEvent: {
    findMany: (async (a: { where?: W; take?: number }) => {
      reads++;
      return EVENTS.filter((e) => matches(a.where, e)).sort((x, y) => y.at.getTime() - x.at.getTime() || (x.id < y.id ? 1 : -1)).slice(0, a.take ?? 1e9);
    }) as never,
  },
  financialAccount: { findMany: (async (a: { where?: W }) => { reads++; return ACCOUNTS.filter((x) => matches(a.where, x)); }) as never },
  plaidItem: { findMany: (async (a: { where?: W }) => { reads++; return ITEMS.filter((i) => matches(a.where, i)); }) as never },
  stageAttempts: (async () => { reads++; return []; }) as never,
};
const acc = createIncidentAccessors(client);
const opts = { now: NOW };

const ops = incidentAudienceFor({ user: { role: UserRole.USER }, grant: { area: "PLATFORM_OPS", level: "READ" } as never }) as OpsToken;
const cs = incidentAudienceFor({ user: { role: UserRole.USER }, grant: { area: "CUSTOMER_SUCCESS", level: "READ" } as never }) as CsToken;
const sys = systemIncidentAudience();
const forged = Object.freeze({ audience: "PLATFORM_OPS" });
const q = (o: Partial<IncidentSearchQuery>): IncidentSearchQuery => ({ ...DEFAULT_SEARCH, ...o });
const noIdentity = (x: unknown) => !/"subjectUserId"/.test(JSON.stringify(x)) && !USER_IDS.some((u) => JSON.stringify(x).includes(u)) && !JSON.stringify(x).includes("u_operator_");

async function refusedBeforeRead(name: string, fn: () => Promise<unknown>): Promise<void> {
  const before = reads;
  let refused = false;
  try { await fn(); } catch (e) { refused = e instanceof IncidentAudienceError; }
  check(`${name}: refused with IncidentAudienceError and ZERO reads`, refused && reads === before, { refused, reads: reads - before });
}

async function main(): Promise<void> {
  console.log("PB-1 Phase 2B — investigation accessors\n\n1. token first");
  await refusedBeforeRead("search with a hand-built token", () => acc.search(forged as never, DEFAULT_SEARCH, opts));
  await refusedBeforeRead("search with the SYSTEM token", () => acc.search(sys as never, DEFAULT_SEARCH, opts));
  await refusedBeforeRead("investigate with a hand-built token", () => acc.investigate(forged as never, "i_res", opts));
  await refusedBeforeRead("investigate with the SYSTEM token", () => acc.investigate(sys as never, "i_res", opts));
  {
    const before = reads;
    const r = await acc.investigate(ops, "../../etc", opts);
    check("investigate refuses a non-id-shaped id with no read", r === null && reads === before);
  }

  console.log("\n2. list total = KPI (broken now)");
  const broken = await acc.brokenNow(ops, opts);
  const kpi = await acc.search(ops, DEFAULT_SEARCH, opts);
  check("the broken-now preset lists exactly brokenNow's incidents",
    JSON.stringify(kpi.items.map((v) => v.id).sort()) === JSON.stringify(broken.items.map((v) => v.id).sort()), { search: kpi.items.map((v) => v.id), broken: broken.items.map((v) => v.id) });
  check("…and its total is brokenNow's count (2: the stale row is not broken now)", kpi.total === broken.items.length && kpi.total === 2, kpi.total);
  const listQuery = parseIncidentSearch(incidentSearchParams(DEFAULT_SEARCH), NOW.getTime());
  const { fromClamped: _fc, ...listQ } = listQuery;
  const list = await acc.search(ops, listQ, opts);
  check("the list opened from the KPI (same params, re-parsed) has total = KPI", list.total === kpi.total && JSON.stringify(listQ) === JSON.stringify(DEFAULT_SEARCH));
  const verify = await acc.search(ops, q({ status: "needs-verification" }), opts);
  const nv = await acc.needsVerification(ops, opts);
  check("needs-verification preset = needsVerification", verify.total === nv.items.length && verify.items[0]?.id === "i_stale", verify.items.map((v) => v.id));

  console.log("\n3. the timeline renders the events in order, unmodified");
  const inv = await acc.investigate(ops, "i_res", opts);
  const ev = inv?.timeline.events ?? [];
  check("source = events, oldest first", inv?.timeline.source === "events" && ev.map((e) => e.id).join() === "ev_1,ev_2,ev_3", ev.map((e) => e.id));
  const stored = [...EVENTS].sort((a, b) => a.at.getTime() - b.at.getTime());
  check("every emitted field equals the stored column (no rewrite)", ev.length === 3 && ev.every((e, i) => {
    const s = stored[i];
    return e.at === s.at.toISOString() && e.type === s.type && e.actorKind === s.actorKind && e.fromState === s.fromState && e.toState === s.toState
      && e.causeCode === s.causeCode && e.actionCode === s.actionCode && e.outcomeCode === s.outcomeCode
      && e.refreshExecutionId === s.refreshExecutionId && e.jobRunId === s.jobRunId && e.audited === (s.auditId !== null);
  }));
  check("the operator's id never appears (only `audited`)", !JSON.stringify(ev).includes("u_operator_") && !("actorId" in (ev[1] ?? {})) && ev[1]?.audited === true);
  const archInv = await acc.investigate(ops, "i_arch", opts);
  check("an archived incident shows the archive's code-only timeline, in stored order",
    archInv?.timeline.source === "archive" && archInv.timeline.events.map((e) => e.type).join() === "OBSERVED,STATE_CHANGED" && archInv.timeline.events.every((e) => e.id === null));

  console.log("\n4. Platform Ops output carries no identity");
  check("Ops search (every preset) is identity-free", noIdentity(kpi) && noIdentity(await acc.search(ops, q({ status: "all" }), opts)));
  check("Ops investigate is identity-free (incl. the archived row's stored subjectUserId)", noIdentity(inv) && noIdentity(archInv));
  const csInv = await acc.investigate(cs, "i_open_a", opts);
  check("control: the CS tier DOES name the customer", (csInv?.verdict as { subjectUserId?: string } | undefined)?.subjectUserId === "u_alice_000000001");
  check("the ops projection of a CS-tier verdict drops the identity (break-glass on an Ops route)",
    csInv !== null && noIdentity(incidentDetailDTO(csInv, "ops", NOW)) && noIdentity(incidentRowDTO(csInv.verdict, "ops")));
  check("…and the ops list DTO likewise", noIdentity(incidentListDTO(await acc.search(cs, q({ status: "all" }), opts), "ops", NOW, false)));
  check("the cs projection keeps it", incidentRowDTO(csInv!.verdict, "cs").subjectUserId === "u_alice_000000001");
  check("no DTO carries detail / plaidTransactionId / stored evidence",
    !/"detail"|plaidTransactionId|resolutionEvidence/.test(JSON.stringify(incidentDetailDTO(inv!, "ops", NOW))));

  console.log("\n5. history search: filters and paging bounds");
  const hist = await acc.search(ops, q({ status: "history" }), opts);
  check("history = resolved + archived incidents (33 live closed + 1 archived)", hist.total === 33 && hist.items.length === INCIDENT_PAGE_SIZE, hist.total);
  check("history never lists an open or stale incident", hist.items.every((v) => v.state === "resolved" || v.state === "archived"));
  const p2 = await acc.search(ops, q({ status: "history", page: 2 }), opts);
  check("page 2 holds the remainder, disjoint from page 1", p2.items.length === 33 - INCIDENT_PAGE_SIZE && p2.items.every((v) => !hist.items.some((h) => h.id === v.id)));
  const p9 = await acc.search(ops, q({ status: "history", page: 9 }), opts);
  check("a page past the end is empty with the true total", p9.items.length === 0 && p9.total === 33);
  const wal = await acc.search(ops, q({ status: "history", provider: "WALLET" }), opts);
  check("provider filter", wal.total === 1 && wal.items[0].id === "i_wallet");
  const code = await acc.search(ops, q({ status: "all", code: "PROVIDER_OUTAGE" }), opts);
  check("code matches the cause code", code.total === 1 && code.items[0].id === "i_open_b");
  const kindCode = await acc.search(ops, q({ status: "history", code: "WALLET_SYNC_FAILED" }), opts);
  check("code matches the kind", kindCode.total === 1);
  const day = (d: number) => ago(d).toISOString().slice(0, 10);
  const ranged = await acc.search(ops, q({ status: "history", from: day(8), to: day(4) }), opts);
  check("date range on last seen (inclusive UTC days)", ranged.total === 1 && ranged.items[0].id === "i_res", ranged.items.map((v) => v.id));
  const archRange = await acc.search(ops, q({ status: "history", from: day(215), to: day(205) }), opts);
  check("the archive is searched over the same range", archRange.total === 1 && archRange.items[0].id === "i_arch" && archRange.items[0].state === "archived");
  check("facets name the providers and codes seen", hist.facets.providers.join() === "PLAID,WALLET" && hist.facets.codes.includes("UPSERT_ERROR"));
  const sp = (o: Record<string, string>) => parseIncidentSearch(new URLSearchParams(o), NOW.getTime());
  check("page bounds: 0 / -3 / 'x' ⇒ 1; huge ⇒ MAX_INCIDENT_PAGE", sp({ page: "0" }).page === 1 && sp({ page: "-3" }).page === 1 && sp({ page: "x" }).page === 1 && sp({ page: "99999" }).page === MAX_INCIDENT_PAGE);
  const old = sp({ status: "history", from: "2020-01-01" });
  check("a from older than the archive retention is clamped (and says so)", old.from === retentionFloorDay(NOW.getTime()) && old.fromClamped);
  check("from after to drops the range", sp({ from: "2026-10-10", to: "2026-10-01" }).from === null && sp({ from: "2026-10-10", to: "2026-10-01" }).to === null);
  check("unknown values are dropped, never passed through",
    (() => { const x = sp({ status: "bogus", severity: "huge", provider: "plaid; drop", operation: "Bad Op", code: "lower", from: "2026-02-30" }); return x.status === "broken-now" && !x.severity && !x.provider && !x.operation && !x.code && !x.from; })());
  check("HISTORY_RETENTION_DAYS mirrors the archive retention rule",
    new RegExp(`INCIDENT_ARCHIVE_RETENTION_DAYS = ${HISTORY_RETENTION_DAYS};`).test(readFileSync("jobs/data-retention.ts", "utf8")));

  console.log("\n6. detail: links, archive, affected, recovery");
  check("relations + previous episode are linked (the archived one still resolves)",
    JSON.stringify(inv?.related.map((l) => [l.id, l.kind, l.incident?.state ?? null])) === JSON.stringify([["i_open_a", "RELATED", "active"], ["i_arch", "PREVIOUS_EPISODE", "archived"]]), inv?.related);
  check("recurrences = other episodes of the same incident key", inv?.recurrences.map((v) => v.id).join() === "i_arch");
  check("the archived incident links forward to its next episode", archInv?.related.some((l) => l.id === "i_res" && l.kind === "NEXT_EPISODE") === true);
  check("archive state: live resolved row ⇒ archiveDueAt = resolvedAt + 90 d", inv?.archive.archived === false && inv.archive.archiveDueAt === new Date(ago(5).getTime() + 90 * 86_400_000).toISOString());
  check("archive state: archived row ⇒ retainedUntil = archivedAt + 13 months", archInv?.archive.archived === true && archInv.archive.retainedUntil === new Date(ago(100).getTime() + HISTORY_RETENTION_DAYS * 86_400_000).toISOString());
  const openA = await acc.investigate(ops, "i_open_a", opts);
  check("affected: provider, institution, 1 item, the 2 accounts its occurrences named",
    openA?.affected.provider === "PLAID" && openA.affected.institution === "Example Bank" && openA.affected.itemCount === 1 && openA.affected.accountCount === 2 && openA.affected.itemStatus === "ACTIVE");
  const rec = (id: string, tier: "ops" | "cs", token: OpsToken | CsToken = tier === "ops" ? ops : cs) => acc.investigate(token as never, id, opts).then((x) => incidentDetailDTO(x!, tier, NOW).recovery);
  check("Ops, open on an ACTIVE item ⇒ resync only", JSON.stringify(await rec("i_open_a", "ops")) === JSON.stringify([{ kind: "resync", connectionId: "item_a" }]));
  check("Ops, open on a NEEDS_REAUTH item ⇒ request-reauth only (resync would 409)", JSON.stringify(await rec("i_open_b", "ops")) === JSON.stringify([{ kind: "request-reauth", connectionId: "item_b" }]));
  check("closed / archived ⇒ no recovery action", (await rec("i_res", "ops")).length === 0 && (await rec("i_arch", "ops")).length === 0);
  check("CS, open + attributed ⇒ the customer's Refresh all (the existing CS route)", JSON.stringify(await rec("i_open_a", "cs")) === JSON.stringify([{ kind: "refresh-customer", userId: "u_alice_000000001" }]));
  check("no lifecycle action (acknowledge / resolve / reopen) is ever offered — no route exists yet",
    !/acknowledge|"resolve"|reopen/.test(JSON.stringify(await rec("i_open_a", "ops"))));

  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\ninvestigation.test: all passed.");
}

main().catch((e) => { console.error(e); process.exit(1); });
