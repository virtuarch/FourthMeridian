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
 */

import "server-only";
import type { Prisma } from "@prisma/client";
import { systemDb } from "@/lib/db";
import { listSubjectStageAttempts } from "@/lib/platform/refresh/execution-query";
import { EVIDENCE_DIGEST_SELECT, evidenceDigestOf } from "../evidence";
import { loadOccurrenceAccounts, loadSubjectFacts } from "../subjects";
import { assertAudienceToken, type CsToken, type OpsToken, type SystemToken } from "./audience";
import { deriveIncidentVerdicts, operationOf } from "./core";
import { attemptEndpointsFor, isPastStaleWindow, UNKNOWN_EVIDENCE } from "./staleness";
import type {
  ArchivedIncidentFacts,
  AttemptEvidence,
  CsIncidentVerdict,
  IncidentAccessors,
  IncidentAudience,
  IncidentFacts,
  IncidentRowFacts,
  IncidentVerdict,
  ListOptions,
  RelationFacts,
  VerdictForToken,
  VerdictList,
} from "./types";

/** Default row cap for one scan (D5 — reported, never silent). */
export const DEFAULT_SCAN_LIMIT = 200;
/** Cap on the attempt-evidence scan; hitting it makes EVERY row's evidence UNKNOWN (never hides a row). */
export const ATTEMPT_SCAN_CAP = 2000;

type Db = typeof systemDb;
export type IncidentFactsReader = {
  syncIssue: Pick<Db["syncIssue"], "findMany">;
  syncIssueOccurrence: Pick<Db["syncIssueOccurrence"], "findMany" | "groupBy">;
  syncIssueArchive: Pick<Db["syncIssueArchive"], "findMany">;
  syncIssueRelation: Pick<Db["syncIssueRelation"], "findMany">;
  financialAccount: Pick<Db["financialAccount"], "findMany">;
  plaidItem: Pick<Db["plaidItem"], "findMany">;
  /** Stage attempts on subjects — the refresh ledger's ROW SEAM (never the ledger directly). */
  stageAttempts: typeof listSubjectStageAttempts;
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
}

/**
 * The §12 P2.1 attempt / skip evidence for every OPEN row past its window:
 * RefreshEndpointResult rows of the operation's endpoints on the row's
 * subject, started after its lastOccurredAt. A row inside its window needs
 * none (the rule never reads it). UNKNOWN whenever it cannot be read cleanly.
 */
export async function loadAttemptEvidence(
  rows: readonly IncidentRowFacts[],
  client: Pick<IncidentFactsReader, "stageAttempts">,
  now: Date,
): Promise<Map<string, AttemptEvidence>> {
  const out = new Map<string, AttemptEvidence>();
  type Need = { id: string; subject: { item?: string; account?: string } | null; endpoints: readonly string[]; since: Date };
  const needs: Need[] = [];
  for (const r of rows) {
    if (r.resolved) continue;
    const op = operationOf(r);
    const since = r.lastOccurredAt ?? r.createdAt;
    if (!isPastStaleWindow({ operation: op, provider: r.provider, lastOccurredAt: since, now })) continue;
    const endpoints = attemptEndpointsFor(op, r.provider);
    const subject = r.provider === "WALLET"
      ? (r.financialAccountId ? { account: r.financialAccountId } : null)
      : (r.plaidItemId ? { item: r.plaidItemId } : null);
    needs.push({ id: r.id, subject, endpoints, since });
  }
  for (const n of needs) {
    // The ledger records no attempt of this operation at all: "neither attempted nor skipped" is literal.
    if (n.endpoints.length === 0) out.set(n.id, { known: true, lastAttemptAt: null, lastSkipAt: null });
    else if (!n.subject) out.set(n.id, UNKNOWN_EVIDENCE);
  }
  const scoped = needs.filter((n) => n.endpoints.length > 0 && n.subject);
  if (scoped.length === 0) return out;

  const itemIds = [...new Set(scoped.map((n) => n.subject!.item).filter((x): x is string => !!x))];
  const accountIds = [...new Set(scoped.map((n) => n.subject!.account).filter((x): x is string => !!x))];
  const endpoints = [...new Set(scoped.flatMap((n) => n.endpoints))];
  const minSince = new Date(Math.min(...scoped.map((n) => n.since.getTime())));
  let results: Awaited<ReturnType<typeof listSubjectStageAttempts>>;
  try {
    results = await client.stageAttempts({ plaidItemIds: itemIds, sourceRefs: accountIds, endpoints, after: minSince, take: ATTEMPT_SCAN_CAP });
  } catch {
    for (const n of scoped) out.set(n.id, UNKNOWN_EVIDENCE);
    return out;
  }
  if (results.length >= ATTEMPT_SCAN_CAP) {
    for (const n of scoped) out.set(n.id, UNKNOWN_EVIDENCE);
    return out;
  }
  for (const n of scoped) {
    let lastAttemptAt: Date | null = null;
    let lastSkipAt: Date | null = null;
    for (const x of results) {
      const onSubject = n.subject!.item ? x.plaidItemId === n.subject!.item : x.sourceRef === n.subject!.account;
      if (!onSubject || !n.endpoints.includes(x.endpoint) || x.startedAt.getTime() <= n.since.getTime()) continue;
      if (x.status === "SKIPPED") { if (!lastSkipAt || x.startedAt > lastSkipAt) lastSkipAt = x.startedAt; }
      else if (!lastAttemptAt || x.startedAt > lastAttemptAt) lastAttemptAt = x.startedAt;
    }
    out.set(n.id, { known: true, lastAttemptAt, lastSkipAt });
  }
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
      ? client.syncIssueArchive.findMany({ orderBy: [{ archivedAt: "desc" }, { incidentId: "asc" }], take: o.limit, select: ARCHIVE_SELECT })
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

// ── Accessors ───────────────────────────────────────────────────────────────

const READERS = ["CUSTOMER_SUCCESS", "PLATFORM_OPS"] as const;

function list<T extends IncidentVerdict>(facts: IncidentFacts, items: T[]): VerdictList<T> {
  return { items, truncated: facts.scanTruncated, scanned: facts.rows.length };
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
      const { facts, set } = await derive(audience, { resolved: false }, opts);
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
  };
}

/** The production accessors (fm_system, the operator-console authority). */
export const incidentAccessors: IncidentAccessors = createIncidentAccessors({
  syncIssue: systemDb.syncIssue,
  syncIssueOccurrence: systemDb.syncIssueOccurrence,
  syncIssueArchive: systemDb.syncIssueArchive,
  syncIssueRelation: systemDb.syncIssueRelation,
  financialAccount: systemDb.financialAccount,
  plaidItem: systemDb.plaidItem,
  stageAttempts: listSubjectStageAttempts,
});
