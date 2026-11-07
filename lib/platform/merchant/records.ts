/**
 * lib/platform/merchant/records.ts  (PB-9 — THE readers behind the Merchant Identity KPIs)
 *
 * Typed, reusable, READ-ONLY readers. Each KPI on the Merchant Identity
 * overview and the drill-down table it opens are served by the SAME count
 * function over the SAME definition (records-query.ts):
 *
 *   readMerchantIdentityKpis(window)        — the four KPI figures + precise coverage
 *   listMerchantIdentityRecords(query)      — one page of a KPI's records (total = the KPI's count fn)
 *   getMerchantIdentityDetail(merchantId)   — one merchant: aliases, transactions, classification, history
 *
 * These are the interfaces a later consumer (Platform AI) reads; callers gate
 * first (MERCHANT_OPS READ — the route does). fm_system (`systemDb`) for the
 * same reason as the overview and the review page: per-tenant narrowing would be
 * a wrong answer. No amount, no tenant / user / account identity, no raw
 * provider descriptor and no wallet address leaves this module (a wallet
 * address is only ever a null-test inside a where — it is never selected).
 */

import "server-only";
import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { systemDb } from "@/lib/db";
import { operatorDisplayName } from "@/lib/platform/customer/identity-label";
import { auditFacts, pageWindow, providerOf, sanitizeDescriptor, shapeUnlinkedRow } from "./records-core";
import {
  LIVE_TRANSACTION_WHERE, MERCHANT_DIRECTORY_ORDER, decisionListWhere, decisionWhere, identityClassWhere, liveClassWhere,
  merchantDirectoryFilterSql, unlinkedListWhere, unlinkedWhere, windowSince,
} from "./records-query";
import {
  IDENTITY_CLASSES, IDENTITY_CLASS_META, MERCHANT_RECORDS_PAGE_SIZE,
  type IdentityClass, type IdentityCoverage, type MergeDecisionRow, type MerchantDetailResponse, type MerchantDirectoryRow,
  type MerchantRecordsPage, type MerchantRecordsQuery, type MerchantRecordsResponse, type MerchantWindowDays, type UnlinkedTransactionRow,
} from "./records-types";

/** The client the readers take — systemDb in production, a fake in tests. */
export type MerchantRecordsClient = Pick<PrismaClient, "$queryRaw" | "transaction" | "merchant" | "merchantAlias" | "merchantRule" | "merchantMergeDecision" | "auditLog" | "user" | "financialAccount">;

export interface ReaderDeps { client?: MerchantRecordsClient; now?: Date }
const clientOf = (d: ReaderDeps): MerchantRecordsClient => d.client ?? (systemDb as unknown as MerchantRecordsClient);
const num = (v: bigint | number | null | undefined) => Number(v ?? 0);

// ── The shared counts (KPI and list total both call these) ───────────────────

export async function countMerchantDirectory(client: MerchantRecordsClient, q: string | null): Promise<number> {
  const rows = await client.$queryRaw<{ n: bigint | number }[]>(Prisma.sql`SELECT count(*) AS n FROM "Merchant" m WHERE ${merchantDirectoryFilterSql(q)}`);
  return num(rows[0]?.n);
}

export function countUnlinked(client: MerchantRecordsClient, query: Pick<MerchantRecordsQuery, "filter" | "q">): Promise<number> {
  return client.transaction.count({ where: unlinkedListWhere(query) });
}

export function countDecisions(client: MerchantRecordsClient, verdict: "MERGED" | "DISMISSED", since: Date, q: string | null): Promise<number> {
  return client.merchantMergeDecision.count({ where: q ? decisionListWhere(verdict, since, q) : decisionWhere(verdict, since) });
}

export async function readIdentityCoverage(client: MerchantRecordsClient): Promise<IdentityCoverage> {
  const [live, unlinked, eligible, eligibleLinked, ...byClass] = await Promise.all([
    client.transaction.count({ where: LIVE_TRANSACTION_WHERE }),
    countUnlinked(client, { filter: null, q: null }),
    client.transaction.count({ where: liveClassWhere("ELIGIBLE") }),
    client.transaction.count({ where: liveClassWhere("ELIGIBLE", true) }),
    ...IDENTITY_CLASSES.map((c) => countUnlinked(client, { filter: c, q: null })),
  ]);
  const unlinkedByClass = Object.fromEntries(IDENTITY_CLASSES.map((c, i) => [c, byClass[i]])) as Record<IdentityClass, number>;
  return { live, linked: live - unlinked, unlinked, eligible, eligibleLinked, unlinkedByClass };
}

export interface MerchantIdentityKpis {
  windowDays: MerchantWindowDays;
  since: string;
  merchants: number;
  coverage: IdentityCoverage;
  merged: number;
  dismissed: number;
}

/** The four KPI figures, from the same count functions the drill-downs total with. */
export async function readMerchantIdentityKpis(windowDays: MerchantWindowDays, deps: ReaderDeps = {}): Promise<MerchantIdentityKpis> {
  const client = clientOf(deps);
  const since = windowSince(deps.now ?? new Date(), windowDays);
  const [merchants, coverage, merged, dismissed] = await Promise.all([
    countMerchantDirectory(client, null),
    readIdentityCoverage(client),
    countDecisions(client, "MERGED", since, null),
    countDecisions(client, "DISMISSED", since, null),
  ]);
  return { windowDays, since: since.toISOString(), merchants, coverage, merged, dismissed };
}

// ── The lists ─────────────────────────────────────────────────────────────────

type DirRow = {
  id: string; displayName: string; canonicalKey: string; provider_backed: boolean; enriched: boolean; createdAt: Date;
  alias_count: bigint | number; tx_count: bigint | number; last_seen: Date | null;
};

async function reviewStatusByKey(client: MerchantRecordsClient, keys: string[]): Promise<Map<string, MerchantDirectoryRow["reviewStatus"]>> {
  const out = new Map<string, MerchantDirectoryRow["reviewStatus"]>();
  if (keys.length === 0) return out;
  const ds = await client.merchantMergeDecision.findMany({
    where: { OR: [{ survivorKey: { in: keys } }, { absorbedKey: { in: keys } }] },
    select: { verdict: true, survivorKey: true, absorbedKey: true },
  });
  for (const d of ds) {
    if (d.verdict === "MERGED") out.set(d.survivorKey, "MERGE_SURVIVOR");
    for (const k of [d.survivorKey, d.absorbedKey]) if (d.verdict === "DISMISSED" && !out.has(k)) out.set(k, "KEPT_APART");
  }
  return out;
}

function directorySelect(filter: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    SELECT m."id", m."displayName", m."canonicalKey", (m."plaidEntityId" IS NOT NULL) AS provider_backed,
           (m."enrichmentSource" IS NOT NULL) AS enriched, m."createdAt",
           COALESCE(a.n, 0) AS alias_count, COALESCE(t.n, 0) AS tx_count, t.last_seen
      FROM "Merchant" m
      LEFT JOIN (SELECT "merchantId", count(*) AS n FROM "MerchantAlias" GROUP BY 1) a ON a."merchantId" = m."id"
      LEFT JOIN (SELECT "merchantId", count(*) AS n, max("date") AS last_seen FROM "Transaction"
                  WHERE "deletedAt" IS NULL AND "merchantId" IS NOT NULL GROUP BY 1) t ON t."merchantId" = m."id"
     WHERE ${filter}`;
}

async function shapeDirectory(client: MerchantRecordsClient, rows: DirRow[]): Promise<MerchantDirectoryRow[]> {
  const status = await reviewStatusByKey(client, rows.map((r) => r.canonicalKey));
  return rows.map((r) => ({
    id: r.id,
    displayName: r.displayName,
    canonicalKey: r.canonicalKey,
    aliasCount: num(r.alias_count),
    transactionCount: num(r.tx_count),
    lastSeen: r.last_seen ? new Date(r.last_seen).toISOString().slice(0, 10) : null,
    providerBacked: r.provider_backed === true,
    enriched: r.enriched === true,
    reviewStatus: status.get(r.canonicalKey) ?? "NONE",
    createdAt: new Date(r.createdAt).toISOString(),
  }));
}

async function listDirectory(client: MerchantRecordsClient, query: MerchantRecordsQuery) {
  const [total, kpiTotal] = await Promise.all([countMerchantDirectory(client, query.q), countMerchantDirectory(client, null)]);
  const w = pageWindow(total, query.page);
  const order = MERCHANT_DIRECTORY_ORDER[query.sort] ?? MERCHANT_DIRECTORY_ORDER.transactions_desc;
  const rows = total === 0 ? [] : await client.$queryRaw<DirRow[]>(
    Prisma.sql`${directorySelect(merchantDirectoryFilterSql(query.q))} ORDER BY ${order} LIMIT ${w.take} OFFSET ${w.skip}`,
  );
  return { total, kpiTotal, w, rows: await shapeDirectory(client, rows) };
}

const UNLINKED_SELECT = {
  id: true, date: true, merchant: true, category: true, flowType: true, plaidTransactionId: true, importBatchId: true,
  financialAccountId: true, financialAccount: { select: { type: true } },
} as const;

/**
 * Which of these accounts are on-chain wallets — a NULL-TEST in the where, so
 * the address itself is never selected (only the matching account ids return).
 */
async function walletAccountIds(client: MerchantRecordsClient, ids: string[]): Promise<Set<string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Set();
  const ws = await client.financialAccount.findMany({ where: { id: { in: unique }, walletAddress: { not: null } }, select: { id: true } });
  return new Set(ws.map((w) => w.id));
}

async function listUnlinked(client: MerchantRecordsClient, query: MerchantRecordsQuery) {
  const [total, kpiTotal, ...byClassCounts] = await Promise.all([
    countUnlinked(client, query),
    countUnlinked(client, { filter: null, q: null }),
    ...IDENTITY_CLASSES.map((c) => countUnlinked(client, { filter: c, q: null })),
  ]);
  const w = pageWindow(total, query.page);
  const raw = total === 0 ? [] : await client.transaction.findMany({
    where: unlinkedListWhere(query),
    orderBy: [{ date: query.sort === "date_asc" ? "asc" : "desc" }, { id: "asc" }],
    skip: w.skip, take: w.take,
    select: UNLINKED_SELECT,
  });
  const wallets = await walletAccountIds(client, raw.map((r) => r.financialAccountId));
  const rows: UnlinkedTransactionRow[] = raw.map((r) => shapeUnlinkedRow({
    id: r.id, date: r.date, merchant: r.merchant, category: String(r.category), flowType: r.flowType ? String(r.flowType) : null,
    plaidTransactionId: r.plaidTransactionId, importBatchId: r.importBatchId,
    accountType: String(r.financialAccount.type), wallet: wallets.has(r.financialAccountId),
  }));
  const byClass = IDENTITY_CLASSES.map((c, i) => ({ key: c, label: IDENTITY_CLASS_META[c].label, count: byClassCounts[i], expected: IDENTITY_CLASS_META[c].expected }));
  return { total, kpiTotal, w, rows, byClass };
}

async function operatorLabels(client: MerchantRecordsClient, ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((v): v is string => !!v))];
  if (unique.length === 0) return new Map();
  const us = await client.user.findMany({ where: { id: { in: unique } }, select: { id: true, username: true, name: true } });
  return new Map(us.map((u) => [u.id, operatorDisplayName(u)]));
}

async function listDecisions(client: MerchantRecordsClient, verdict: "MERGED" | "DISMISSED", query: MerchantRecordsQuery, since: Date) {
  const [total, kpiTotal] = await Promise.all([countDecisions(client, verdict, since, query.q), countDecisions(client, verdict, since, null)]);
  const w = pageWindow(total, query.page);
  const ds = total === 0 ? [] : await client.merchantMergeDecision.findMany({
    where: decisionListWhere(verdict, since, query.q),
    orderBy: [{ createdAt: query.sort === "decided_asc" ? "asc" : "desc" }, { id: "asc" }],
    skip: w.skip, take: w.take,
    select: { id: true, pairKey: true, verdict: true, survivorKey: true, absorbedKey: true, evidenceTier: true, evidenceSignal: true, decidedByUserId: true, createdAt: true },
  });
  const action = verdict === "MERGED" ? "MERCHANT_MERGE_APPLIED" : "MERCHANT_MERGE_DISMISSED";
  const [audits, labels, survivors] = await Promise.all([
    ds.length === 0 ? [] : client.auditLog.findMany({
      where: { action, OR: ds.map((d) => ({ metadata: { path: ["target", "id"], equals: d.pairKey } })) },
      orderBy: { createdAt: "desc" },
      select: { metadata: true },
    }),
    operatorLabels(client, ds.map((d) => d.decidedByUserId)),
    ds.length === 0 ? [] : client.merchant.findMany({ where: { canonicalKey: { in: ds.map((d) => d.survivorKey) } }, select: { id: true, canonicalKey: true } }),
  ]);
  const auditByPair = new Map<string, unknown>();
  for (const a of audits) {
    const id = ((a.metadata as Record<string, unknown> | null)?.target as Record<string, unknown> | undefined)?.id;
    if (typeof id === "string" && !auditByPair.has(id)) auditByPair.set(id, a.metadata);
  }
  const survivorId = new Map(survivors.map((m) => [m.canonicalKey, m.id]));
  const rows: MergeDecisionRow[] = ds.map((d) => {
    const facts = auditFacts(auditByPair.get(d.pairKey));
    return {
      id: d.id,
      pairKey: d.pairKey,
      verdict: d.verdict as "MERGED" | "DISMISSED",
      sourceKey: d.absorbedKey,
      destinationKey: d.survivorKey,
      destinationMerchantId: survivorId.get(d.survivorKey) ?? null,
      affectedTransactions: verdict === "MERGED" ? facts.affected : null,
      evidenceTier: d.evidenceTier,
      evidenceSignal: d.evidenceSignal,
      decidedAt: d.createdAt.toISOString(),
      operator: d.decidedByUserId ? labels.get(d.decidedByUserId) ?? null : null,
      reason: facts.reason,
    };
  });
  return { total, kpiTotal, w, rows };
}

/** One page of the records behind a KPI. `total` = matching rows; `kpiTotal` = the KPI figure. */
export async function listMerchantIdentityRecords(query: MerchantRecordsQuery, deps: ReaderDeps = {}): Promise<MerchantRecordsResponse> {
  const client = clientOf(deps);
  const now = deps.now ?? new Date();
  const base = { kind: query.kind, query, pageSize: MERCHANT_RECORDS_PAGE_SIZE, checkedAt: now.toISOString() };
  if (query.kind === "merchants") {
    const r = await listDirectory(client, query);
    return { ...base, total: r.total, kpiTotal: r.kpiTotal, page: r.w.page, pageCount: r.w.pageCount, rows: r.rows } satisfies MerchantRecordsPage<MerchantDirectoryRow>;
  }
  if (query.kind === "unlinked") {
    const r = await listUnlinked(client, query);
    return { ...base, total: r.total, kpiTotal: r.kpiTotal, page: r.w.page, pageCount: r.w.pageCount, rows: r.rows, byClass: r.byClass } satisfies MerchantRecordsPage<UnlinkedTransactionRow>;
  }
  const since = windowSince(now, query.window);
  const r = await listDecisions(client, query.kind === "merged" ? "MERGED" : "DISMISSED", query, since);
  return { ...base, total: r.total, kpiTotal: r.kpiTotal, page: r.w.page, pageCount: r.w.pageCount, rows: r.rows, since: since.toISOString() } satisfies MerchantRecordsPage<MergeDecisionRow>;
}

// ── Merchant detail ──────────────────────────────────────────────────────────

const DETAIL_ROWS = 25;

/** One merchant's identity record, or null when the id names none. */
export async function getMerchantIdentityDetail(merchantId: string, deps: ReaderDeps = {}): Promise<MerchantDetailResponse | null> {
  const client = clientOf(deps);
  const now = deps.now ?? new Date();
  const dir = await client.$queryRaw<DirRow[]>(Prisma.sql`${directorySelect(Prisma.sql`m."id" = ${merchantId}`)} LIMIT 1`);
  if (dir.length === 0) return null;
  const [row] = await shapeDirectory(client, dir);
  const live = { merchantId, ...LIVE_TRANSACTION_WHERE };
  const [m, aliasTotal, aliases, userRuleCount, byCategory, bySource, byFlow, txTotal, txs, decisions] = await Promise.all([
    client.merchant.findUnique({ where: { id: merchantId }, select: { defaultCategory: true, enrichmentSource: true, enrichedAt: true, updatedAt: true } }),
    client.merchantAlias.count({ where: { merchantId } }),
    client.merchantAlias.findMany({ where: { merchantId }, orderBy: { createdAt: "asc" }, take: DETAIL_ROWS, select: { id: true, aliasKey: true, source: true, createdAt: true } }),
    client.merchantRule.count({ where: { merchantId, scope: "USER" } }),
    client.transaction.groupBy({ by: ["category"], where: live, _count: { _all: true } }),
    client.transaction.groupBy({ by: ["categorySource"], where: live, _count: { _all: true } }),
    client.transaction.groupBy({ by: ["flowType"], where: live, _count: { _all: true } }),
    client.transaction.count({ where: live }),
    client.transaction.findMany({
      where: live, orderBy: [{ date: "desc" }, { id: "asc" }], take: DETAIL_ROWS,
      select: { id: true, date: true, category: true, flowType: true, plaidTransactionId: true, importBatchId: true, financialAccountId: true, financialAccount: { select: { type: true } } },
    }),
    client.merchantMergeDecision.findMany({
      where: { OR: [{ survivorKey: row.canonicalKey }, { absorbedKey: row.canonicalKey }] },
      orderBy: { createdAt: "asc" },
      select: { verdict: true, survivorKey: true, absorbedKey: true, decidedByUserId: true, createdAt: true },
    }),
  ]);
  const [labels, wallets] = await Promise.all([
    operatorLabels(client, decisions.map((d) => d.decidedByUserId)),
    walletAccountIds(client, txs.map((t) => t.financialAccountId)),
  ]);
  const counts = (rows: { _count: { _all: number } }[], key: (r: never) => unknown) =>
    rows.map((r) => ({ key: String(key(r as never) ?? "none"), count: r._count._all })).sort((a, b) => b.count - a.count);

  const history: MerchantDetailResponse["history"] = [
    { at: row.createdAt, kind: "CREATED" as const, text: "Merchant identity created", operator: null },
    ...(m?.enrichedAt ? [{ at: m.enrichedAt.toISOString(), kind: "ENRICHED" as const, text: `Enriched (${m.enrichmentSource ?? "unknown source"})`, operator: null }] : []),
    ...aliases.map((a) => ({ at: a.createdAt.toISOString(), kind: "ALIAS_ADDED" as const, text: `Alias added (${String(a.source).toLowerCase()})`, operator: null })),
    ...decisions.map((d) => d.verdict === "MERGED"
      ? { at: d.createdAt.toISOString(), kind: "MERGED_IN" as const, text: d.survivorKey === row.canonicalKey ? `Absorbed "${d.absorbedKey}" in a merge` : `Merged into "${d.survivorKey}"`, operator: d.decidedByUserId ? labels.get(d.decidedByUserId) ?? null : null }
      : { at: d.createdAt.toISOString(), kind: "KEPT_APART" as const, text: `Kept apart from "${d.survivorKey === row.canonicalKey ? d.absorbedKey : d.survivorKey}"`, operator: d.decidedByUserId ? labels.get(d.decidedByUserId) ?? null : null }),
  ].sort((a, b) => a.at.localeCompare(b.at));

  return {
    merchant: {
      ...row,
      defaultCategory: m?.defaultCategory ? String(m.defaultCategory) : null,
      enrichmentSource: m?.enrichmentSource ? String(m.enrichmentSource) : null,
      enrichedAt: m?.enrichedAt ? m.enrichedAt.toISOString() : null,
      updatedAt: (m?.updatedAt ?? new Date(row.createdAt)).toISOString(),
      userRuleCount,
    },
    aliases: { total: aliasTotal, rows: aliases.map((a) => ({ id: a.id, alias: sanitizeDescriptor(a.aliasKey) ?? "—", source: String(a.source), createdAt: a.createdAt.toISOString() })) },
    classification: {
      byCategory: counts(byCategory, (r: { category: unknown }) => r.category),
      byCategorySource: counts(bySource, (r: { categorySource: unknown }) => r.categorySource),
      byFlowType: counts(byFlow, (r: { flowType: unknown }) => r.flowType),
    },
    transactions: {
      total: txTotal,
      rows: txs.map((t) => ({
        id: t.id,
        date: t.date.toISOString().slice(0, 10),
        provider: providerOf({ plaidTransactionId: t.plaidTransactionId, importBatchId: t.importBatchId, wallet: wallets.has(t.financialAccountId) }),
        accountType: String(t.financialAccount.type),
        flowType: t.flowType ? String(t.flowType) : null,
        category: String(t.category),
      })),
    },
    history,
    checkedAt: now.toISOString(),
  };
}

/** Re-exported so a consumer can classify without importing the core. */
export { identityClassWhere, unlinkedWhere };
