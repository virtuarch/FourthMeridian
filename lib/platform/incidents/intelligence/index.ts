/**
 * lib/platform/incidents/intelligence/index.ts  (PB-1 Phase 2 — the thin loader + typed accessors)
 *
 * I/O only: gather `IncidentFacts` in batched reads, hand them to the pure core
 * (./core.ts), filter. NO derivation happens here and NOTHING is written.
 *
 * AUTHORITY. Reads run through the operator-console authority (`systemDb`,
 * fm_system — the same client the CS detail loader and CS attention use; see
 * scripts/audit-db-authority.ts). The loader takes its client as a parameter
 * with no default; the default accessors bind `systemDb` explicitly.
 *
 * EVERY ACCESSOR VERIFIES ITS TOKEN FIRST (assertAudienceToken), before any
 * read. A token this module's minter did not issue, or one of the wrong tier,
 * is refused — never downgraded.
 *
 * NOT CUT OVER. No reader uses this module yet (PB-1 §13.3 step 5: one reader
 * per PR, after the parity gate is green for it).
 *
 * PB-1 Phase 2B adds two accessors for the incident investigation surfaces
 * (Platform Ops / Customer Success incidents workspaces): `search` (one status
 * preset — exactly one existing accessor's filter — plus validated filters,
 * paged; search-core.ts) and `investigate` (one episode with its append-only
 * SyncIssueEvent timeline, evidence DIGEST, relation / recurrence links,
 * affected-subject counts and archive state). Both verify the token first.
 */

import "server-only";
import { SyncIssueKind, type Prisma } from "@prisma/client";
import { systemDb } from "@/lib/db";
import { latestStageAttemptsBySubject } from "@/lib/platform/refresh/projections";
import { EVIDENCE_DIGEST_SELECT, evidenceDigestOf } from "../evidence";
import { loadOccurrenceAccounts, loadSubjectFacts } from "../subjects";
import { assertAudienceToken, type CsToken, type OpsToken, type SystemToken } from "./audience";
import { criticalCapableKinds, deriveIncidentVerdicts, operationOf } from "./core";
import {
  archiveDates,
  archivedTimelineOf,
  dayBounds,
  RECURRENCE_CAP,
  SEARCH_SCAN_LIMIT,
  searchVerdicts,
  statusReadsClosed,
  TIMELINE_READ_CAP,
  timelineEventOf,
} from "./search-core";
import { isRegistryCode } from "../codes";
import { attemptEndpointsFor, isPastStaleWindow, UNKNOWN_EVIDENCE } from "./staleness";
import type {
  ArchivedIncidentFacts,
  AttemptEvidence,
  CsIncidentVerdict,
  IncidentAccessors,
  IncidentAudience,
  IncidentFacts,
  IncidentInvestigation,
  IncidentLink,
  IncidentRowFacts,
  IncidentSearchQuery,
  IncidentTimeline,
  IncidentVerdict,
  ListOptions,
  RelationFacts,
  VerdictForToken,
  VerdictList,
} from "./types";

/** Row cap for a window scan (convergence); D5 — reported as `truncated`, never silent. */
export const WINDOW_SCAN_LIMIT = 500;
/** Default row cap for one scan (D5 — reported, never silent). */
export const DEFAULT_SCAN_LIMIT = 200;
/**
 * The SyncIssue kinds the classifier can rank `critical` (derived from
 * classifySyncIssue over the schema enum — never a hand list). The bounded
 * critical-kind second scan (`ListOptions.criticalOpenLimit`) reads open rows
 * of these kinds only; the core still decides every verdict's severity.
 */
export const CRITICAL_KINDS: readonly string[] = criticalCapableKinds(Object.values(SyncIssueKind));

type Db = typeof systemDb;
export type IncidentFactsReader = {
  syncIssue: Pick<Db["syncIssue"], "findMany">;
  syncIssueOccurrence: Pick<Db["syncIssueOccurrence"], "findMany" | "groupBy">;
  syncIssueArchive: Pick<Db["syncIssueArchive"], "findMany">;
  syncIssueRelation: Pick<Db["syncIssueRelation"], "findMany">;
  /** PB-1 2B — the append-only timeline (read only; codes and refs). */
  syncIssueEvent: Pick<Db["syncIssueEvent"], "findMany">;
  financialAccount: Pick<Db["financialAccount"], "findMany">;
  plaidItem: Pick<Db["plaidItem"], "findMany">;
  /** Latest stage attempt / skip per subject — the refresh ledger's PROJECTION SEAM (never the ledger directly). */
  latestAttempts: typeof latestStageAttemptsBySubject;
};

const ROW_SELECT = {
  id: true, kind: true, provider: true, plaidItemId: true, financialAccountId: true, plaidTransactionId: true,
  detail: true, resolved: true, incidentKey: true, previousIncidentId: true, createdAt: true,
  firstOccurredAt: true, lastOccurredAt: true, resolvedAt: true, resolutionKind: true, resolutionReasonCode: true,
  lifecycleState: true, acknowledgedAt: true, recoveringSince: true, archivedAt: true, subjectUserId: true,
  causeStatus: true, causeCode: true,
  ...EVIDENCE_DIGEST_SELECT,
  _count: { select: { occurrences: true } },
} as const;

const ARCHIVE_SELECT = {
  incidentId: true, incidentKey: true, provider: true, kind: true, operation: true, plaidItemId: true,
  financialAccountId: true, subjectUserId: true, previousIncidentId: true, firstOccurredAt: true,
  lastOccurredAt: true, resolvedAt: true, resolutionKind: true, resolutionReasonCode: true,
  causeStatus: true, causeCode: true, occurrenceCount: true, archivedAt: true,
} as const;

export interface LoadOptions {
  /** The SyncIssue `where` — callers pass only scalar predicates. */
  where: Prisma.SyncIssueWhereInput;
  limit: number;
  now: Date;
  includeArchive?: boolean;
  /** PB-1 2B — scalar predicates for the archive scan (absent ⇒ the newest `limit` archive rows, unchanged). */
  archiveWhere?: Prisma.SyncIssueArchiveWhereInput;
}

/**
 * The §12 P2.1 attempt / skip evidence for every OPEN row past its window:
 * RefreshEndpointResult rows of the operation's endpoints on the row's
 * subject, started after its lastOccurredAt. A row inside its window needs
 * none (the rule never reads it). UNKNOWN whenever it cannot be read cleanly.
 */
export async function loadAttemptEvidence(
  rows: readonly IncidentRowFacts[],
  client: Pick<IncidentFactsReader, "latestAttempts">,
  now: Date,
): Promise<Map<string, AttemptEvidence>> {
  const out = new Map<string, AttemptEvidence>();
  type Need = { id: string; subject: { item: string } | { account: string }; endpoints: readonly string[]; since: Date };
  const needs: Need[] = [];
  for (const r of rows) {
    if (r.resolved) continue;
    const op = operationOf(r);
    const since = r.lastOccurredAt ?? r.createdAt;
    // Inside its window: the STALE rule never reads evidence (the core reports "not-needed").
    if (!isPastStaleWindow({ operation: op, provider: r.provider, lastOccurredAt: since, now })) continue;
    const endpoints = attemptEndpointsFor(op, r.provider);
    // The ledger records no attempt of this operation at all: "neither attempted nor skipped" is literal.
    if (endpoints.length === 0) { out.set(r.id, { known: true, lastAttemptAt: null, lastSkipAt: null, basis: "read" }); continue; }
    // Subject keys: a wallet (or any non-Plaid source) is its FinancialAccount (RefreshExecution.sourceRef);
    // a Plaid incident is its item (RefreshExecution.plaidItemId).
    const subject = r.provider === "WALLET"
      ? (r.financialAccountId ? { account: r.financialAccountId } : null)
      : (r.plaidItemId ? { item: r.plaidItemId } : null);
    if (!subject) { out.set(r.id, { ...UNKNOWN_EVIDENCE, basis: "unsupported" }); continue; }
    needs.push({ id: r.id, subject, endpoints, since });
  }
  if (needs.length === 0) return out;

  // One aggregate per endpoint set (a handful), each uncapped (one row per subject).
  const bySignature = new Map<string, Need[]>();
  for (const n of needs) {
    const sig = [...n.endpoints].sort().join(",");
    bySignature.set(sig, [...(bySignature.get(sig) ?? []), n]);
  }
  await Promise.all([...bySignature.values()].map(async (group) => {
    const itemIds = [...new Set(group.flatMap((n) => ("item" in n.subject ? [n.subject.item] : [])))];
    const accountIds = [...new Set(group.flatMap((n) => ("account" in n.subject ? [n.subject.account] : [])))];
    const after = new Date(Math.min(...group.map((n) => n.since.getTime())));
    let latest: Awaited<ReturnType<IncidentFactsReader["latestAttempts"]>>;
    try {
      latest = await client.latestAttempts({ plaidItemIds: itemIds, sourceRefs: accountIds, endpoints: group[0].endpoints, after });
    } catch (e) {
      // Logged without ids or query text; the rows stay visible (unknown never hides a row).
      console.warn("[incident-intelligence] attempt evidence unreadable:", e instanceof Error ? e.name : "unknown error");
      for (const n of group) out.set(n.id, { ...UNKNOWN_EVIDENCE, basis: "unreadable" });
      return;
    }
    for (const n of group) {
      // groupBy keys on the (plaidItemId, sourceRef) PAIR, so one subject can own several rows:
      // take the max over ALL of them. Then apply THIS row's `since` — the read used the group's
      // earliest one — and a `_max` not after it means nothing after it exists.
      const mine = latest.filter((x) => ("item" in n.subject ? x.plaidItemId === n.subject.item : x.sourceRef === n.subject.account));
      const maxOf = (pick: (x: (typeof latest)[number]) => Date | null): Date | null => {
        let best: Date | null = null;
        for (const x of mine) { const t = pick(x); if (t && (!best || t > best)) best = t; }
        return best && best.getTime() > n.since.getTime() ? best : null;
      };
      out.set(n.id, { known: true, lastAttemptAt: maxOf((x) => x.lastAttemptAt), lastSkipAt: maxOf((x) => x.lastSkipAt), basis: "read" });
    }
  }));
  return out;
}

/** The thin loader: one capped SyncIssue scan + batched subject / occurrence / attempt / relation reads. */
export async function loadIncidentFacts(client: IncidentFactsReader, o: LoadOptions): Promise<IncidentFacts> {
  const raw = await client.syncIssue.findMany({
    where: o.where,
    orderBy: [{ lastOccurredAt: "desc" }, { id: "asc" }],
    take: o.limit,
    select: ROW_SELECT,
  });
  const ids = raw.map((r) => r.id);
  const [correlated, archivedRaw, relationsRaw] = await Promise.all([
    ids.length
      ? client.syncIssueOccurrence.groupBy({
        by: ["syncIssueId"],
        where: { syncIssueId: { in: ids }, refreshExecutionId: { not: null } },
        _count: { _all: true },
      })
      : Promise.resolve([] as { syncIssueId: string; _count: { _all: number } }[]),
    o.includeArchive
      ? client.syncIssueArchive.findMany({ ...(o.archiveWhere ? { where: o.archiveWhere } : {}), orderBy: [{ archivedAt: "desc" }, { incidentId: "asc" }], take: o.limit, select: ARCHIVE_SELECT })
      : Promise.resolve([]),
    ids.length
      ? client.syncIssueRelation.findMany({
        where: { OR: [{ fromIncidentId: { in: ids } }, { toIncidentId: { in: ids } }] },
        select: { fromIncidentId: true, toIncidentId: true, kind: true },
      })
      : Promise.resolve([]),
  ]);
  const correlatedBy = new Map(correlated.map((g) => [g.syncIssueId, g._count._all] as const));

  const rows: IncidentRowFacts[] = raw.map((r) => ({
    id: r.id, kind: String(r.kind), provider: String(r.provider),
    plaidItemId: r.plaidItemId, financialAccountId: r.financialAccountId, plaidTransactionId: r.plaidTransactionId,
    detail: r.detail, resolved: r.resolved, incidentKey: r.incidentKey, previousIncidentId: r.previousIncidentId,
    createdAt: r.createdAt, firstOccurredAt: r.firstOccurredAt, lastOccurredAt: r.lastOccurredAt,
    resolvedAt: r.resolvedAt, resolutionKind: r.resolutionKind, resolutionReasonCode: r.resolutionReasonCode,
    lifecycleState: r.lifecycleState, acknowledgedAt: r.acknowledgedAt, recoveringSince: r.recoveringSince,
    archivedAt: r.archivedAt, subjectUserId: r.subjectUserId, causeStatus: r.causeStatus, causeCode: r.causeCode,
    evidence: evidenceDigestOf(r),
    occurrenceCount: r._count?.occurrences ?? 0,
    correlatedOccurrenceCount: correlatedBy.get(r.id) ?? 0,
  }));

  // §12 P2.2 — account subjects named on OPEN item-scoped episodes' occurrences.
  const itemScopedOpen = rows.filter((r) => !r.resolved && r.plaidItemId).map((r) => r.id);
  const occurrenceAccounts = await loadOccurrenceAccounts(itemScopedOpen, client);
  const extraAccountIds = [...occurrenceAccounts.values()].flat();
  const archived: ArchivedIncidentFacts[] = archivedRaw.map((a) => ({ ...a, provider: String(a.provider), kind: String(a.kind) }));
  const subjectRows = [...rows, ...archived.map((a) => ({ plaidItemId: a.plaidItemId, financialAccountId: a.financialAccountId }))];
  const [subjects, attempts] = await Promise.all([
    loadSubjectFacts(subjectRows, client, extraAccountIds),
    loadAttemptEvidence(rows, client, o.now),
  ]);
  // Full owner facts for D4 (loadSubjectFacts keeps the owner keyed by subject).
  // Unattributed is null, never "" — an empty string is a value a caller could match on.
  const items = new Map<string, { status: string; userId: string | null }>();
  for (const [id, status] of subjects.itemStatus) items.set(id, { status, userId: subjects.owners.get(`item:${id}`) || null });
  const accounts = new Map<string, { deletedAt: Date | null; ownerUserId: string | null; createdByUserId: string | null }>();
  // The owner map already folds ownerUserId ?? createdByUserId (the D4 order).
  for (const [id, deletedAt] of subjects.accountDeletedAt) accounts.set(id, { deletedAt, ownerUserId: subjects.owners.get(`account:${id}`) ?? null, createdByUserId: null });

  const isRelationKind = (k: string): k is RelationFacts["kind"] => k === "RECURRENCE_OF" || k === "SAME_ROOT_CAUSE" || k === "RELATED";
  const relations: RelationFacts[] = relationsRaw.flatMap((x) =>
    isRelationKind(x.kind) ? [{ fromIncidentId: x.fromIncidentId, toIncidentId: x.toIncidentId, kind: x.kind }] : []);

  return {
    rows,
    archived,
    subjects: { items, accounts, occurrenceAccounts },
    attempts,
    relations,
    scanTruncated: raw.length >= o.limit,
  };
}

/**
 * Two loads as one fact set (rows, subjects, evidence, relations). Rows are
 * de-duplicated by incident id (the first load's copy wins), so two scans that
 * may overlap can never list one incident twice.
 */
function mergeFacts(a: IncidentFacts, b: IncidentFacts): IncidentFacts {
  const merge = <K, V>(x: ReadonlyMap<K, V> | undefined, y: ReadonlyMap<K, V> | undefined) => new Map([...(x ?? []), ...(y ?? [])]);
  const seen = new Set(a.rows.map((r) => r.id));
  return {
    rows: [...a.rows, ...b.rows.filter((r) => !seen.has(r.id))],
    archived: [...(a.archived ?? []), ...(b.archived ?? [])],
    subjects: {
      items: merge(a.subjects.items, b.subjects.items),
      accounts: merge(a.subjects.accounts, b.subjects.accounts),
      occurrenceAccounts: merge(a.subjects.occurrenceAccounts, b.subjects.occurrenceAccounts),
    },
    attempts: merge(a.attempts, b.attempts),
    relations: [...(a.relations ?? []), ...(b.relations ?? [])],
    scanTruncated: a.scanTruncated || b.scanTruncated,
  };
}

// ── Accessors ───────────────────────────────────────────────────────────────

const READERS = ["CUSTOMER_SUCCESS", "PLATFORM_OPS"] as const;

function list<T extends IncidentVerdict>(facts: IncidentFacts, items: T[]): VerdictList<T> {
  return { items, truncated: facts.scanTruncated, scanned: facts.rows.length };
}

/** An incident id as accepted from a URL: opaque id characters only (cuid / uuid). */
const INCIDENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** SyncIssueEvent columns the timeline emits. NOT actorId (an operator's id is not shown; `audited` says an AuditLog exists). */
const EVENT_SELECT = {
  id: true, at: true, type: true, actorKind: true, auditId: true, fromState: true, toState: true,
  causeCode: true, actionCode: true, outcomeCode: true, refEventId: true, refreshExecutionId: true, jobRunId: true,
} as const;

/** The SyncIssue + archive predicates for one search (scalar only; status / day range / provider). */
export function searchWhere(q: IncidentSearchQuery): { where: Prisma.SyncIssueWhereInput; archiveWhere: Prisma.SyncIssueArchiveWhereInput | null } {
  const { gte, lte } = dayBounds(q);
  const range = gte || lte ? { ...(gte ? { gte } : {}), ...(lte ? { lte } : {}) } : null;
  // An open preset reads exactly the brokenNow / needsVerification scan ({ resolved: false }).
  const base: Prisma.SyncIssueWhereInput = statusReadsClosed(q.status) ? {} : { resolved: false };
  const extra: Prisma.SyncIssueWhereInput[] = [];
  if (q.provider) extra.push({ provider: q.provider });
  if (range) extra.push({ OR: [{ lastOccurredAt: range }, { lastOccurredAt: null, createdAt: range }] });
  const where = extra.length ? { AND: [base, ...extra] } : base;
  if (!statusReadsClosed(q.status)) return { where, archiveWhere: null };
  const archiveExtra: Prisma.SyncIssueArchiveWhereInput[] = [];
  if (q.provider) archiveExtra.push({ provider: q.provider });
  if (range) archiveExtra.push({ OR: [{ lastOccurredAt: range }, { lastOccurredAt: null, archivedAt: range }] });
  return { where, archiveWhere: archiveExtra.length ? { AND: archiveExtra } : {} };
}

export function createIncidentAccessors(client: IncidentFactsReader): IncidentAccessors {
  const derive = async (audience: IncidentAudience, where: Prisma.SyncIssueWhereInput, opts: ListOptions | undefined, includeArchive = false) => {
    const now = opts?.now ?? new Date();
    const facts = await loadIncidentFacts(client, { where, limit: opts?.limit ?? DEFAULT_SCAN_LIMIT, now, includeArchive });
    return { facts, set: deriveIncidentVerdicts(facts, { now, audience }) };
  };

  return {
    async brokenNow<T extends CsToken | OpsToken>(token: T, opts?: ListOptions) {
      const audience = assertAudienceToken(token, READERS);
      const extra = opts?.criticalOpenLimit ?? 0;
      if (extra <= 0) {
        const { facts, set } = await derive(audience, { resolved: false }, opts);
        return list(facts, set.all.filter((v) => v.brokenNow)) as VerdictList<VerdictForToken<T>>;
      }
      // CRITICAL-KIND SECOND SCAN (S2 ruling; the R3 `window` open-first pattern): the recent
      // scan takes its cap; when it was cut, a bounded scan of OPEN critical-kind rows outside
      // it follows, so an old critical incident is ranked whatever its age. Merged through
      // mergeFacts (de-duplicated by id); either scan hitting its cap ⇒ `truncated`, never silent.
      const now = opts?.now ?? new Date();
      const recent = await loadIncidentFacts(client, { where: { resolved: false }, limit: opts?.limit ?? DEFAULT_SCAN_LIMIT, now });
      const facts = recent.scanTruncated
        ? mergeFacts(recent, await loadIncidentFacts(client, {
          where: { resolved: false, kind: { in: [...CRITICAL_KINDS] as SyncIssueKind[] }, id: { notIn: recent.rows.map((r) => r.id) } },
          limit: extra, now,
        }))
        : recent;
      const set = deriveIncidentVerdicts(facts, { now, audience });
      return list(facts, set.all.filter((v) => v.brokenNow)) as VerdictList<VerdictForToken<T>>;
    },
    async needsVerification<T extends CsToken | OpsToken>(token: T, opts?: ListOptions) {
      const audience = assertAudienceToken(token, READERS);
      const { facts, set } = await derive(audience, { resolved: false }, opts);
      return list(facts, set.all.filter((v) => v.rowClass === "incident" && v.state === "stale-unverified")) as VerdictList<VerdictForToken<T>>;
    },
    async history<T extends CsToken | OpsToken>(token: T, opts?: ListOptions) {
      const audience = assertAudienceToken(token, READERS);
      const { facts, set } = await derive(audience, {}, opts, true);
      return list(facts, set.all.filter((v) => v.rowClass === "incident" && (v.state === "resolved" || v.state === "archived"))) as VerdictList<VerdictForToken<T>>;
    },
    async forCustomer(token: CsToken, userId: string, opts?: ListOptions) {
      const audience = assertAudienceToken(token, ["CUSTOMER_SUCCESS"] as const);
      // No user ⇒ no incidents: unattributed rows are never anybody's.
      if (!userId) return { items: [], truncated: false, scanned: 0 };
      // Candidate rows: stamped for the user, or on a subject the user owns (D4) —
      // the exact attribution is then the core's, and the list is filtered on it.
      const [items, accounts] = await Promise.all([
        client.plaidItem.findMany({ where: { userId }, select: { id: true } }),
        client.financialAccount.findMany({ where: { OR: [{ ownerUserId: userId }, { ownerUserId: null, createdByUserId: userId }] }, select: { id: true } }),
      ]);
      const where: Prisma.SyncIssueWhereInput = {
        ...(opts?.openOnly ? { resolved: false } : {}),
        OR: [
          { subjectUserId: userId },
          ...(items.length ? [{ plaidItemId: { in: items.map((i) => i.id) } }] : []),
          ...(accounts.length ? [{ financialAccountId: { in: accounts.map((a) => a.id) } }] : []),
        ],
      };
      const { facts, set } = await derive(audience, where, opts);
      const mine = (set.all as CsIncidentVerdict[]).filter((v) => v.rowClass === "incident" && v.subjectUserId === userId);
      return list(facts, mine);
    },
    async alertable(token: SystemToken, opts?: ListOptions) {
      const audience = assertAudienceToken(token, ["SYSTEM"] as const);
      const { facts, set } = await derive(audience, { resolved: false }, opts);
      return list(facts, set.all.filter((v) => v.alertable));
    },
    async detail<T extends CsToken | OpsToken>(token: T, id: string, opts?: ListOptions) {
      const audience = assertAudienceToken(token, READERS);
      const { set } = await derive(audience, { id }, { ...opts, limit: 1 }, false);
      return (set.all.find((v) => v.id === id) ?? null) as VerdictForToken<T> | null;
    },
    async window<T extends CsToken | OpsToken>(token: T, range: { from: Date; to: Date }, opts?: ListOptions) {
      const audience = assertAudienceToken(token, READERS);
      const now = opts?.now ?? new Date();
      const cap = opts?.limit ?? WINDOW_SCAN_LIMIT;
      const inRange = { gte: range.from, lte: range.to };
      // OPEN-FIRST (D5 + D6): every not-closed row whatever its dates gets the cap first,
      // so a long-open incident is never the one a busy window cuts; closed rows that
      // touched the window take the remainder.
      const open = await loadIncidentFacts(client, { where: { resolved: false }, limit: cap, now });
      const remainder = cap - open.rows.length;
      const closed = remainder > 0
        ? await loadIncidentFacts(client, {
          where: { resolved: true, OR: [{ createdAt: inRange }, { firstOccurredAt: inRange }, { lastOccurredAt: inRange }, { resolvedAt: inRange }] },
          limit: remainder, now,
        })
        : null;
      const facts = closed ? mergeFacts(open, closed) : { ...open, scanTruncated: true };
      // Truncated when either scan hit its share, or the open scan alone used the whole cap.
      facts.scanTruncated = open.scanTruncated || (closed?.scanTruncated ?? true);
      const set = deriveIncidentVerdicts(facts, { now, audience });
      return list(facts, set.all) as VerdictList<VerdictForToken<T>>;
    },
    async search<T extends CsToken | OpsToken>(token: T, query: IncidentSearchQuery, opts?: ListOptions) {
      const audience = assertAudienceToken(token, READERS);
      const now = opts?.now ?? new Date();
      const { where, archiveWhere } = searchWhere(query);
      const facts = await loadIncidentFacts(client, {
        where, limit: opts?.limit ?? SEARCH_SCAN_LIMIT, now,
        includeArchive: archiveWhere !== null, ...(archiveWhere ? { archiveWhere } : {}),
      });
      const set = deriveIncidentVerdicts(facts, { now, audience });
      return searchVerdicts(set.all as VerdictForToken<T>[], query, { truncated: facts.scanTruncated, scanned: facts.rows.length + (facts.archived?.length ?? 0) });
    },
    async investigate<T extends CsToken | OpsToken>(token: T, id: string, opts?: ListOptions) {
      const audience = assertAudienceToken(token, READERS);
      if (typeof id !== "string" || !INCIDENT_ID.test(id)) return null;
      const now = opts?.now ?? new Date();
      const facts = await loadIncidentFacts(client, { where: { id }, limit: 1, now, includeArchive: true, archiveWhere: { incidentId: id } });
      const verdict = deriveIncidentVerdicts(facts, { now, audience }).all.find((v) => v.id === id) as VerdictForToken<T> | undefined;
      if (!verdict) return null;
      const row = facts.rows.find((r) => r.id === id) ?? null;
      const arch = facts.archived?.find((a) => a.incidentId === id) ?? null;
      const itemId = row?.plaidItemId ?? arch?.plaidItemId ?? null;
      const accountId = row?.financialAccountId ?? arch?.financialAccountId ?? null;
      const incidentKey = row?.incidentKey ?? arch?.incidentKey ?? null;

      const [events, archiveExtra, relationsRaw, items, occAccounts] = await Promise.all([
        row
          ? client.syncIssueEvent.findMany({ where: { incidentId: id }, orderBy: [{ at: "desc" }, { id: "desc" }], take: TIMELINE_READ_CAP + 1, select: EVENT_SELECT })
          : Promise.resolve(null),
        !row && arch
          ? client.syncIssueArchive.findMany({ where: { incidentId: id }, take: 1, select: { ...EVIDENCE_DIGEST_SELECT, eventTimeline: true } })
          : Promise.resolve([]),
        client.syncIssueRelation.findMany({
          where: { OR: [{ fromIncidentId: id }, { toIncidentId: id }] },
          select: { fromIncidentId: true, toIncidentId: true, kind: true },
        }),
        itemId ? client.plaidItem.findMany({ where: { id: { in: [itemId] } }, select: { id: true, institutionName: true, status: true } }) : Promise.resolve([]),
        row && itemId && !accountId ? loadOccurrenceAccounts([id], client) : Promise.resolve(new Map<string, string[]>()),
      ]);

      // Timeline — newest TIMELINE_READ_CAP read, then rendered OLDEST FIRST, each row field-for-field.
      let timeline: IncidentTimeline;
      if (events) {
        const truncated = events.length > TIMELINE_READ_CAP;
        const kept = events.slice(0, TIMELINE_READ_CAP).reverse();
        timeline = { source: kept.length ? "events" : "none", events: kept.map(timelineEventOf), truncated };
      } else timeline = archivedTimelineOf((archiveExtra[0] as { eventTimeline?: unknown } | undefined)?.eventTimeline ?? null);

      // Links — explicit relations (both directions) and the previousIncidentId chain neighbours.
      type Kind = IncidentLink["kind"];
      const links: { id: string; kind: Kind }[] = [];
      const add = (other: string, kind: Kind) => { if (other !== id && !links.some((l) => l.id === other && l.kind === kind)) links.push({ id: other, kind }); };
      for (const r of relationsRaw) {
        if (r.kind !== "RECURRENCE_OF" && r.kind !== "SAME_ROOT_CAUSE" && r.kind !== "RELATED") continue;
        add(r.fromIncidentId === id ? r.toIncidentId : r.fromIncidentId, r.kind);
      }
      if (verdict.recurrence.previousIncidentId) add(verdict.recurrence.previousIncidentId, "PREVIOUS_EPISODE");
      const linkedIds = [...new Set(links.map((l) => l.id))].filter((x) => INCIDENT_ID.test(x));
      const neighbourOr: Prisma.SyncIssueWhereInput[] = [{ previousIncidentId: id }];
      const archiveOr: Prisma.SyncIssueArchiveWhereInput[] = [{ previousIncidentId: id }];
      if (incidentKey) { neighbourOr.push({ incidentKey }); archiveOr.push({ incidentKey }); }
      if (linkedIds.length) { neighbourOr.push({ id: { in: linkedIds } }); archiveOr.push({ incidentId: { in: linkedIds } }); }
      const neighbourLimit = RECURRENCE_CAP + linkedIds.length + 2;
      const nFacts = await loadIncidentFacts(client, { where: { OR: neighbourOr }, limit: neighbourLimit, now, includeArchive: true, archiveWhere: { OR: archiveOr } });
      const neighbours = (deriveIncidentVerdicts(nFacts, { now, audience }).all as VerdictForToken<T>[]).filter((v) => v.id !== id);
      for (const v of neighbours) if (v.recurrence.previousIncidentId === id) add(v.id, "NEXT_EPISODE");
      const byId = new Map(neighbours.map((v) => [v.id, v] as const));
      const related: IncidentLink<VerdictForToken<T>>[] = links.map((l) => ({ id: l.id, kind: l.kind, incident: byId.get(l.id) ?? null }));
      const recurrencesAll = incidentKey
        ? neighbours.filter((v) => v.episodeKey === incidentKey).sort((a, b) => (a.firstSeenAt < b.firstSeenAt ? 1 : a.firstSeenAt > b.firstSeenAt ? -1 : 0))
        : [];

      const item = items[0] as { institutionName: string | null; status: unknown } | undefined;
      const accountCount = accountId ? 1 : (occAccounts.get(id)?.length ?? facts.subjects.occurrenceAccounts?.get(id)?.length ?? 0);
      const archivedAt = arch?.archivedAt.toISOString() ?? null;
      const evidence = row ? row.evidence : (archiveExtra[0] ? evidenceDigestOf(archiveExtra[0] as Parameters<typeof evidenceDigestOf>[0]) : null);
      const reason = row?.resolutionReasonCode ?? arch?.resolutionReasonCode ?? null;
      const out: IncidentInvestigation<VerdictForToken<T>> = {
        verdict,
        evidence,
        resolutionReasonCode: isRegistryCode(reason) ? reason : null,
        timeline,
        affected: {
          provider: verdict.provider,
          institution: item?.institutionName?.trim() || null,
          itemCount: itemId ? 1 : 0,
          accountCount,
          subjectState: verdict.subjectState,
          itemStatus: item ? String(item.status) : null,
        },
        related,
        recurrences: recurrencesAll.slice(0, RECURRENCE_CAP),
        recurrencesTruncated: recurrencesAll.length > RECURRENCE_CAP || nFacts.scanTruncated,
        archive: { archived: verdict.state === "archived", archivedAt, ...archiveDates({ resolvedAt: verdict.resolvedAt, archivedAt }) },
      };
      return out;
    },
  };
}

/** The loader's reader over an fm_system-typed client (the caller's own; stage attempts always ride the row seam). */
export function incidentReaderFor(client: Db): IncidentFactsReader {
  return {
    syncIssue: client.syncIssue,
    syncIssueOccurrence: client.syncIssueOccurrence,
    syncIssueArchive: client.syncIssueArchive,
    syncIssueRelation: client.syncIssueRelation,
    syncIssueEvent: client.syncIssueEvent,
    financialAccount: client.financialAccount,
    plaidItem: client.plaidItem,
    latestAttempts: latestStageAttemptsBySubject,
  };
}

/** The production accessors (fm_system, the operator-console authority). */
export const incidentAccessors: IncidentAccessors = createIncidentAccessors(incidentReaderFor(systemDb));

/** Token TYPES for consumers that receive a minted token (minting stays in ./audience, pinned). */
export type { CsToken, OpsToken, SystemToken } from "./audience";
