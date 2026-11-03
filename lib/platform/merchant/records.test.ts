/**
 * lib/platform/merchant/records.test.ts  (PB-9 — Merchant Identity KPIs drill into their records)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/merchant/records.test.ts
 *
 * Pins, over an in-memory fake that evaluates the readers' Prisma `where`s with
 * SQL THREE-VALUED logic (so a NULL-unsafe NOT IN is caught, not hidden):
 *   1. precision — the linked share is floored; incomplete never reads 100%
 *   2. classification — the identity-class wheres PARTITION every row and agree
 *      with the TS classifier
 *   3. KPI == table — each of the four KPIs equals its table's total (one count fn)
 *   4. filters / search / sort / pagination with accurate counts
 *   5. parsing + deep-link round trip (REPLACE-only, workspace-scoped params)
 *   6. sanitization — no raw descriptor / digits / address where withheld
 *   7. permission + exposure — READ routes, WRITE-only controls, reconsider semantics
 * Synthetic merchants and descriptors only.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Prisma } from "@prisma/client";
import { classifyIdentity, cleanSearch, formatCoveragePct, pageWindow, parseRecordsQuery, sanitizeDescriptor } from "./records-core";
import { identityClassWhere, unlinkedWhere } from "./records-query";
import { countUnlinked, getMerchantIdentityDetail, listMerchantIdentityRecords, readMerchantIdentityKpis, type MerchantRecordsClient } from "./records";
import { IDENTITY_CLASSES, type MergeDecisionRow, type MerchantRecordsQuery, type UnlinkedTransactionRow } from "./records-types";
import { buildMerchantOverview } from "./overview-core";
import { merchantHero, merchantKpis } from "@/components/platform/leads/merchant-model";
import { MERCHANT_URL_PARAMS, merchantRecordsUrlUpdate, openRecords, readMerchantRecordsUrl, recordsApiPath, CLOSED_STATE } from "@/components/platform/leads/merchant-records-url";
import { RECONSIDER_READ_ONLY, RecordsBody, populationLine } from "@/components/platform/leads/MerchantRecords";
import { MerchantLeadSurface } from "@/components/platform/leads/MerchantLead";
import { SPACE_URL_PARAMS, applySpaceUrlUpdate } from "@/lib/space/space-url";
import { PLATFORM_WORKSPACE_SCOPED_PARAMS } from "@/lib/space/use-platform-workspace-navigation";
import { reconsiderDismissedPair, ReconsiderIneligibleError } from "@/lib/platform/merchant/reconsider";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}
const ROOT = process.cwd();
const code = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ── SQL three-valued evaluator for the where shapes the readers build ─────────
type T3 = boolean | null;
const and3 = (xs: T3[]): T3 => (xs.includes(false) ? false : xs.includes(null) ? null : true);
const or3 = (xs: T3[]): T3 => (xs.includes(true) ? true : xs.includes(null) ? null : false);
const LOGICAL = new Set(["AND", "OR", "NOT"]);
function evalWhere(row: Record<string, unknown>, w: unknown): T3 {
  if (!w || typeof w !== "object") return true;
  const parts: T3[] = [];
  for (const [k, v] of Object.entries(w as Record<string, unknown>)) {
    if (k === "AND") parts.push(and3((Array.isArray(v) ? v : [v]).map((x) => evalWhere(row, x))));
    else if (k === "OR") parts.push(or3((v as unknown[]).map((x) => evalWhere(row, x))));
    else if (k === "NOT") { const r = and3((Array.isArray(v) ? v : [v]).map((x) => evalWhere(row, x))); parts.push(r === null ? null : !r); }
    else parts.push(evalField(row[k], v));
  }
  return and3(parts);
}
function evalField(col: unknown, cond: unknown): T3 {
  if (cond === null) return col === null || col === undefined;
  if (cond instanceof Date) return col == null ? null : (col as Date).getTime() === cond.getTime();
  if (typeof cond !== "object") return col == null ? null : col === cond;
  const c = cond as Record<string, unknown>;
  const keys = Object.keys(c);
  // A relation filter (financialAccount: { walletAddress: … }).
  if (!keys.some((k) => ["not", "in", "notIn", "contains", "gte", "equals", "mode"].includes(k)) && !keys.some((k) => LOGICAL.has(k))) {
    return evalWhere((col ?? {}) as Record<string, unknown>, c);
  }
  const out: T3[] = [];
  if ("not" in c) out.push(c.not === null ? col != null : col == null ? null : col !== c.not);
  if ("in" in c) out.push(col == null ? null : (c.in as unknown[]).includes(col));
  if ("notIn" in c) out.push(col == null ? null : !(c.notIn as unknown[]).includes(col));
  if ("equals" in c) out.push(col == null ? null : col === c.equals);
  if ("gte" in c) out.push(col == null ? null : (col as Date).getTime() >= (c.gte as Date).getTime());
  if ("contains" in c) out.push(col == null ? null : String(col).toLowerCase().includes(String(c.contains).toLowerCase()));
  return and3(out);
}
const matches = (row: Record<string, unknown>, w: unknown) => evalWhere(row, w) === true;

// ── Fixtures (synthetic) ─────────────────────────────────────────────────────
const NOW = new Date("2026-11-20T15:00:00.000Z");
const cid = (i: number) => `cm${String(i).padStart(4, "0")}aaaaaaaaaaaaaaaaaaaa`;
const accounts = [
  { id: "acc-bank", type: "checking", walletAddress: null },
  { id: "acc-card", type: "debt", walletAddress: null },
  { id: "acc-wallet", type: "crypto", walletAddress: "bc1qsyntheticwalletaddressxyz0000000000" },
];
const merchants = [
  { id: cid(1), canonicalKey: "NORTHWIND GROCER", displayName: "Northwind Grocer", plaidEntityId: "ent-1", enrichmentSource: "PLAID", createdAt: new Date("2026-01-01T00:00:00Z") },
  { id: cid(2), canonicalKey: "BLUE HERON CAFE", displayName: "Blue Heron Cafe", plaidEntityId: null, enrichmentSource: null, createdAt: new Date("2026-02-01T00:00:00Z") },
  { id: cid(3), canonicalKey: "ACME STREAMING", displayName: "Acme Streaming", plaidEntityId: null, enrichmentSource: null, createdAt: new Date("2026-03-01T00:00:00Z") },
];
const aliases = [
  { id: "al1", merchantId: cid(1), aliasKey: "NORTHWIND GROCER 0042", source: "PLAID", createdAt: new Date("2026-01-02T00:00:00Z") },
  { id: "al2", merchantId: cid(1), aliasKey: "NORTHWIND GRO", source: "IMPORT", createdAt: new Date("2026-01-05T00:00:00Z") },
  { id: "al3", merchantId: cid(2), aliasKey: "BLUE HERON CAFE", source: "PLAID", createdAt: new Date("2026-02-02T00:00:00Z") },
];
type Tx = Record<string, unknown>;
const txs: Tx[] = [];
let seq = 0;
function tx(p: Partial<Tx> & { account?: string }): void {
  seq++;
  const account = accounts.find((a) => a.id === (p.account ?? "acc-bank"))!;
  txs.push({
    id: `tx${String(seq).padStart(3, "0")}`, date: new Date(Date.UTC(2026, 9, 1) + seq * 86_400_000), merchant: "SYNTHETIC SHOP",
    category: "Shopping", flowType: "SPENDING", deletedAt: null, merchantId: null, categorySource: null,
    plaidTransactionId: `p${seq}`, importBatchId: null, financialAccountId: account.id, financialAccount: account, ...p,
  });
}
// Linked rows.
for (let i = 0; i < 40; i++) tx({ merchantId: cid(1), category: "Groceries", merchant: "NORTHWIND GROCER 0042" });
for (let i = 0; i < 6; i++) tx({ merchantId: cid(2), category: "Dining" });
tx({ merchantId: cid(2), category: "Transfer", flowType: "TRANSFER" }); // a linked transfer (the write path mints these)
tx({ merchantId: cid(1), deletedAt: new Date("2026-10-30T00:00:00Z") }); // soft-deleted: never counted
// Unlinked, identity expected (actionable) — including NULL flow (the NULL-safety case).
tx({ merchant: "POS DEBIT BLUEFIELD HARDWARE #1234 5551234567" });
tx({ merchant: "ORDER contact@shop.example ref A1B2C3D4E5F6G7H8J9" , flowType: null, category: "Shopping" });
tx({ merchant: "LANTERN BOOKS", flowType: "FEE", category: "Fees", importBatchId: "ib1", plaidTransactionId: null });
tx({ merchant: "UNCLASSIFIED ROW", flowType: null, category: "Other" });
// Unlinked, legitimate exclusions.
tx({ merchant: "ZELLE TO PAT EXAMPLE 99887766", flowType: "TRANSFER", category: "Transfer" });
tx({ merchant: "AUTOPAY CARD 4455", flowType: "DEBT_PAYMENT", category: "Transfer", account: "acc-card" });
tx({ merchant: "INTERNAL MOVE", flowType: null, category: "Transfer" }); // transfer by category, NULL flow
tx({ merchant: "PAYROLL SYNTHCO", flowType: "INCOME", category: "Income" });
tx({ merchant: "INTEREST PAID", flowType: "INTEREST", category: "Income" });
for (let i = 0; i < 3; i++) tx({ merchant: "bc1qsyntheticwalletaddressxyz0000000000", flowType: "TRANSFER", category: "Transfer", account: "acc-wallet", plaidTransactionId: null });
tx({ merchant: "RECEIVE", flowType: null, category: "Other", account: "acc-wallet", plaidTransactionId: null });
// A bulk of actionable rows for pagination (60 total eligible-unlinked after this).
for (let i = 0; i < 56; i++) tx({ merchant: `SYNTHETIC VENDOR ${String.fromCharCode(65 + (i % 26))}` });

const decisions = [
  { id: "d1", pairKey: "ACME STREAMING|ACME STREAMING PLUS", verdict: "MERGED", survivorKey: "ACME STREAMING", absorbedKey: "ACME STREAMING PLUS", evidenceTier: "T2", evidenceSignal: "prefix", decidedByUserId: "op1", createdAt: new Date("2026-11-19T10:00:00Z") },
  { id: "d2", pairKey: "BLUE HERON CAFE|BLUE HERON CATERING", verdict: "DISMISSED", survivorKey: "BLUE HERON CAFE", absorbedKey: "BLUE HERON CATERING", evidenceTier: "T2", evidenceSignal: null, decidedByUserId: "op2", createdAt: new Date("2026-11-10T10:00:00Z") },
  { id: "d3", pairKey: "OLD A|OLD B", verdict: "DISMISSED", survivorKey: "OLD A", absorbedKey: "OLD B", evidenceTier: "T1", evidenceSignal: null, decidedByUserId: null, createdAt: new Date("2026-06-01T10:00:00Z") }, // outside 30 and 90 d
  { id: "d4", pairKey: "NORTHWIND GROCER|NORTHWIND GROCERY", verdict: "MERGED", survivorKey: "NORTHWIND GROCER", absorbedKey: "NORTHWIND GROCERY", evidenceTier: "T1", evidenceSignal: "ent-1", decidedByUserId: "op1", createdAt: new Date("2026-09-15T10:00:00Z") }, // in 90 d only
];
const audits = [
  { action: "MERCHANT_MERGE_APPLIED", metadata: { target: { kind: "MERCHANT_PAIR", id: "ACME STREAMING|ACME STREAMING PLUS" }, perDuplicate: [{ transactionsRepointed: 7 }], reason: { code: "DUPLICATE_RECORD", note: "same streaming service" } } },
  { action: "MERCHANT_MERGE_DISMISSED", metadata: { target: { kind: "MERCHANT_PAIR", id: "BLUE HERON CAFE|BLUE HERON CATERING" }, reason: { code: "NOT_A_DUPLICATE" } } },
];
const users = [{ id: "op1", username: "ops-one", name: null }, { id: "op2", username: null, name: "Operator Two" }];

// ── The fake client ────────────────────────────────────────────────────────────
const calls: { model: string; op: string; where: string }[] = [];
function page<R extends Record<string, unknown>>(rows: R[], a: { orderBy?: unknown; skip?: number; take?: number }): R[] {
  const order = (Array.isArray(a.orderBy) ? a.orderBy : a.orderBy ? [a.orderBy] : []) as Record<string, "asc" | "desc">[];
  const sorted = [...rows].sort((x, y) => {
    for (const o of order) {
      const [k, dir] = Object.entries(o)[0];
      const xv = x[k] instanceof Date ? (x[k] as Date).getTime() : (x[k] as string);
      const yv = y[k] instanceof Date ? (y[k] as Date).getTime() : (y[k] as string);
      if (xv < yv) return dir === "asc" ? -1 : 1;
      if (xv > yv) return dir === "asc" ? 1 : -1;
    }
    return 0;
  });
  return sorted.slice(a.skip ?? 0, (a.skip ?? 0) + (a.take ?? sorted.length));
}
function model<R extends Record<string, unknown>>(name: string, rows: () => R[]) {
  return {
    count: async (a: { where?: unknown } = {}) => { calls.push({ model: name, op: "count", where: JSON.stringify(a.where ?? null) }); return rows().filter((r) => matches(r, a.where)).length; },
    findMany: async (a: { where?: unknown; orderBy?: unknown; skip?: number; take?: number } = {}) => { calls.push({ model: name, op: "findMany", where: JSON.stringify(a.where ?? null) }); return page(rows().filter((r) => matches(r, a.where)), a); },
    findUnique: async (a: { where: Record<string, unknown> }) => rows().find((r) => matches(r, a.where)) ?? null,
    groupBy: async (a: { by: string[]; where?: unknown }) => {
      const m = new Map<string, { key: unknown; n: number }>();
      for (const r of rows().filter((x) => matches(x, a.where))) { const k = String(r[a.by[0]]); const e = m.get(k) ?? { key: r[a.by[0]], n: 0 }; e.n++; m.set(k, e); }
      return [...m.values()].map((e) => ({ [a.by[0]]: e.key, _count: { _all: e.n } }));
    },
  };
}
function directoryRows() {
  return merchants.map((m) => {
    const live = txs.filter((t) => t.merchantId === m.id && t.deletedAt === null);
    const last = live.reduce<Date | null>((a, t) => (!a || (t.date as Date) > a ? (t.date as Date) : a), null);
    return { id: m.id, displayName: m.displayName, canonicalKey: m.canonicalKey, provider_backed: m.plaidEntityId !== null, enriched: m.enrichmentSource !== null, createdAt: m.createdAt, alias_count: BigInt(aliases.filter((a) => a.merchantId === m.id).length), tx_count: BigInt(live.length), last_seen: last };
  });
}
const sqlCalls: string[] = [];
const fake = {
  async $queryRaw(q: Prisma.Sql) {
    sqlCalls.push(JSON.stringify({ sql: q.text, values: q.values }));
    const vals = q.values as unknown[];
    const filter = (r: { id: string; displayName: string; canonicalKey: string }) => {
      if (/m\."id" = \$1/.test(q.text) && !/ILIKE/.test(q.text)) return r.id === vals[0];
      if (!/ILIKE/.test(q.text)) return true;
      const term = String(vals[0]).slice(1, -1).replace(/\\(.)/g, "$1").toLowerCase();
      return r.displayName.toLowerCase().includes(term) || r.canonicalKey.toLowerCase().includes(term) || r.id === vals[2];
    };
    if (/^SELECT count\(\*\) AS n FROM "Merchant"/.test(q.text.trim())) return [{ n: BigInt(directoryRows().filter(filter).length) }];
    let rows = directoryRows().filter(filter);
    if (/tx_count DESC/.test(q.text)) rows = rows.sort((a, b) => Number(b.tx_count) - Number(a.tx_count) || a.displayName.localeCompare(b.displayName));
    else if (/"displayName" DESC/.test(q.text)) rows = rows.sort((a, b) => b.displayName.localeCompare(a.displayName));
    else rows = rows.sort((a, b) => a.displayName.localeCompare(b.displayName));
    if (/LIMIT \$\d+ OFFSET/.test(q.text)) { const [take, skip] = vals.slice(-2) as number[]; rows = rows.slice(skip, skip + take); }
    else if (/LIMIT 1/.test(q.text)) rows = rows.slice(0, 1);
    return rows;
  },
  transaction: model("transaction", () => txs),
  merchant: model("merchant", () => merchants),
  merchantAlias: model("merchantAlias", () => aliases),
  merchantRule: model("merchantRule", () => [] as Record<string, unknown>[]),
  merchantMergeDecision: model("merchantMergeDecision", () => decisions),
  financialAccount: model("financialAccount", () => accounts),
  user: model("user", () => users),
  auditLog: {
    findMany: async (a: { where: { action: string; OR: { metadata: { equals: string } }[] } }) => {
      const ids = new Set(a.where.OR.map((o) => o.metadata.equals));
      return audits.filter((x) => x.action === a.where.action && ids.has(x.metadata.target.id));
    },
  },
} as unknown as MerchantRecordsClient;
const deps = { client: fake, now: NOW };
const q = (p: Partial<MerchantRecordsQuery> & Pick<MerchantRecordsQuery, "kind">): MerchantRecordsQuery => ({ window: 30, q: null, sort: { merchants: "transactions_desc", unlinked: "date_desc", merged: "decided_desc", dismissed: "decided_desc" }[p.kind], page: 1, filter: null, ...p });

async function main() {
  console.log("1. precision — the linked share is floored; incomplete never reads 100%");
  check("7,986 of 8,014 → 99.65% (Math.round said 100%)", formatCoveragePct(7986, 8014) === "99.65%", formatCoveragePct(7986, 8014));
  check("exact → 100%; none → 0%; empty → null", formatCoveragePct(8014, 8014) === "100%" && formatCoveragePct(0, 10) === "0%" && formatCoveragePct(0, 0) === null);
  check("99,999 of 100,000 → 99.99% (not 100%)", formatCoveragePct(99_999, 100_000) === "99.99%");
  check("1 of 1,000,000 → <0.01%", formatCoveragePct(1, 1_000_000) === "<0.01%");
  check("an exact whole share prints without decimals (150/200 → 75%)", formatCoveragePct(150, 200) === "75%");
  {
    let bad = 0;
    for (let total = 1; total <= 3000; total += 7) for (const linked of [total - 1, Math.floor(total * 0.999), Math.floor(total / 3)]) {
      if (linked >= 0 && linked < total && formatCoveragePct(linked, total) === "100%") bad++;
    }
    check("sweep: no incomplete share ever prints 100%", bad === 0, bad);
  }

  console.log("2. classification — the wheres partition every row and agree with the classifier");
  {
    const grid: Tx[] = [];
    for (const account of accounts) for (const flowType of [null, "SPENDING", "TRANSFER", "DEBT_PAYMENT", "INCOME", "INTEREST", "INVESTMENT", "ADJUSTMENT", "FEE", "REFUND", "UNKNOWN"])
      for (const category of ["Transfer", "Groceries", "Income", "Other"]) grid.push({ flowType, category, financialAccount: account, deletedAt: null, merchantId: null });
    let overlaps = 0; let disagree = 0;
    for (const r of grid) {
      const hits = IDENTITY_CLASSES.filter((c) => evalWhere(r, identityClassWhere(c)) === true);
      if (hits.length !== 1) overlaps++;
      const ts = classifyIdentity({ wallet: (r.financialAccount as { walletAddress: string | null }).walletAddress !== null, flowType: r.flowType as string | null, category: r.category as string });
      if (hits[0] !== ts) disagree++;
    }
    check(`every one of ${grid.length} rows is in exactly ONE class (incl. NULL flow)`, overlaps === 0, overlaps);
    check("the where class equals the TS classifier for every row", disagree === 0, disagree);
    const nullFlow = { flowType: null, category: "Shopping", financialAccount: accounts[0], deletedAt: null, merchantId: null };
    check("a NULL-flow, non-transfer row is ELIGIBLE (NOT IN on NULL would have dropped it)", evalWhere(nullFlow, identityClassWhere("ELIGIBLE")) === true);
    check("a NULL-flow row with category Transfer is a TRANSFER", classifyIdentity({ wallet: false, flowType: null, category: "Transfer" }) === "TRANSFER");
    check("a wallet row is WALLET whatever its flow", classifyIdentity({ wallet: true, flowType: "SPENDING", category: "Shopping" }) === "WALLET");
    check("fees and refunds expect identity", classifyIdentity({ wallet: false, flowType: "FEE", category: "Fees" }) === "ELIGIBLE" && classifyIdentity({ wallet: false, flowType: "REFUND", category: "Shopping" }) === "ELIGIBLE");
  }

  console.log("3. KPI == table total, for each of the four (one count function)");
  const k30 = await readMerchantIdentityKpis(30, deps);
  const k90 = await readMerchantIdentityKpis(90, deps);
  const live = txs.filter((t) => t.deletedAt === null);
  check("denominator = every LIVE transaction (wallet, transfers, income included; soft-deleted excluded)", k30.coverage.live === live.length && k30.coverage.live === txs.length - 1, k30.coverage);
  check("linked + unlinked = live", k30.coverage.linked + k30.coverage.unlinked === k30.coverage.live);
  check("unlinked by class sums to unlinked", IDENTITY_CLASSES.reduce((a, c) => a + k30.coverage.unlinkedByClass[c], 0) === k30.coverage.unlinked, k30.coverage.unlinkedByClass);
  check("class counts are as seeded (60 actionable · 3 transfer · 4 wallet · 2 no-counterparty)",
    k30.coverage.unlinkedByClass.ELIGIBLE === 60 && k30.coverage.unlinkedByClass.TRANSFER === 3 && k30.coverage.unlinkedByClass.WALLET === 4 && k30.coverage.unlinkedByClass.NO_COUNTERPARTY === 2, k30.coverage.unlinkedByClass);
  check("eligible linked excludes the linked transfer", k30.coverage.eligibleLinked === 46 && k30.coverage.eligible === 106, [k30.coverage.eligible, k30.coverage.eligibleLinked]);
  for (const [kind, kpi] of [["merchants", k30.merchants], ["unlinked", k30.coverage.unlinked], ["merged", k30.merged], ["dismissed", k30.dismissed]] as const) {
    calls.length = 0; sqlCalls.length = 0;
    const r = await listMerchantIdentityRecords(q({ kind }), deps);
    check(`${kind}: table total = KPI (${kpi}) = kpiTotal`, r.total === kpi && r.kpiTotal === kpi, { total: r.total, kpiTotal: r.kpiTotal, kpi });
  }
  {
    const r90m = await listMerchantIdentityRecords(q({ kind: "merged", window: 90 }), deps);
    const r90d = await listMerchantIdentityRecords(q({ kind: "dismissed", window: 90 }), deps);
    check("the 90-day window: merged 2 / dismissed 1, table = KPI", k90.merged === 2 && r90m.total === 2 && k90.dismissed === 1 && r90d.total === 1, [k90.merged, k90.dismissed]);
    check("30-day: merged 1 / dismissed 1 (the window is the KPI's)", k30.merged === 1 && k30.dismissed === 1);
  }
  {
    // The KPI and the list issue the SAME where for the unlinked count.
    calls.length = 0;
    await countUnlinked(fake, { filter: null, q: null });
    const kpiWhere = calls[0].where;
    check("the KPI's where is the unlinked definition", kpiWhere === JSON.stringify(unlinkedWhere(null)));
    calls.length = 0;
    await listMerchantIdentityRecords(q({ kind: "unlinked" }), deps);
    check("…and the list's total uses that very where", calls.filter((c) => c.model === "transaction" && c.op === "count")[0]?.where === kpiWhere);
  }
  {
    const overview = buildMerchantOverview({ kpis: k30, bySource: [], aliasesBySource: [], userRules: 0, decisions: [], byTier: [], aliasDays: [], ruleDays: [] }, NOW, 30);
    const tiles = merchantKpis({ data: overview, loading: false, error: null });
    check("the overview tiles print the same four figures", tiles[0].value === String(k30.merchants) && tiles[1].value === String(k30.coverage.unlinked) && tiles[2].value === String(k30.merged) && tiles[3].value === String(k30.dismissed), tiles.map((t) => t.value));
    check("'Without a merchant' tile names actionable vs excluded", tiles[1].sub === "60 identity expected · 9 excluded", tiles[1].sub);
    const hero = merchantHero({ data: overview, loading: false, error: null });
    const expected = formatCoveragePct(k30.coverage.linked, k30.coverage.live);
    check("the hero verdict uses the floored share", hero.verdict.word === `${expected} linked` && expected !== "100%", hero.verdict.word);
    const big = buildMerchantOverview({ kpis: { merchants: 1, merged: 0, dismissed: 0, coverage: { live: 8014, linked: 7986, unlinked: 28, eligible: 7990, eligibleLinked: 7980, unlinkedByClass: { ELIGIBLE: 10, TRANSFER: 3, WALLET: 15, NO_COUNTERPARTY: 0 } } }, bySource: [], aliasesBySource: [], userRules: 0, decisions: [], byTier: [], aliasDays: [], ruleDays: [] }, NOW, 30);
    const bh = merchantHero({ data: big, loading: false, error: null });
    check("7,986 of 8,014 reads '99.65% linked', never '100%'", bh.verdict.word === "99.65% linked" && !/100%/.test(bh.verdict.word), bh.verdict.word);
    check("the caption carries the exact counts and the eligible share", /7,986 of 8,014 live transactions/.test(bh.caption ?? "") && /10 without one where identity is expected/.test(bh.caption ?? "") && /99\.87% of eligible linked/.test(bh.caption ?? ""), bh.caption);
  }

  console.log("4. filters, search, sort and pagination — accurate counts");
  {
    for (const c of IDENTITY_CLASSES) {
      const r = await listMerchantIdentityRecords(q({ kind: "unlinked", filter: c }), deps);
      const rows = r.rows as UnlinkedTransactionRow[];
      check(`filter ${c}: total = its class count, every row is that class`, r.total === k30.coverage.unlinkedByClass[c] && rows.every((x) => x.identityClass === c) && r.kpiTotal === k30.coverage.unlinked);
    }
    const p1 = await listMerchantIdentityRecords(q({ kind: "unlinked", filter: "ELIGIBLE" }), deps);
    const p3 = await listMerchantIdentityRecords(q({ kind: "unlinked", filter: "ELIGIBLE", page: 3 }), deps);
    const p99 = await listMerchantIdentityRecords(q({ kind: "unlinked", filter: "ELIGIBLE", page: 99 }), deps);
    check("60 rows → 3 pages of 25/25/10", p1.pageCount === 3 && p1.rows.length === 25 && p3.rows.length === 10 && p3.page === 3, [p1.pageCount, p3.rows.length]);
    check("a page past the end clamps to the last page", p99.page === 3 && p99.rows.length === 10);
    check("population line is exact", populationLine(p3) === "Showing 51–60 of 60", populationLine(p3));
    const all = new Set<string>();
    for (let pg = 1; pg <= 3; pg++) for (const r of (await listMerchantIdentityRecords(q({ kind: "unlinked", filter: "ELIGIBLE", page: pg }), deps)).rows as UnlinkedTransactionRow[]) all.add(r.id);
    check("pages are disjoint and cover the total", all.size === 60);
    const asc = (await listMerchantIdentityRecords(q({ kind: "unlinked", sort: "date_asc" }), deps)).rows as UnlinkedTransactionRow[];
    const desc = (await listMerchantIdentityRecords(q({ kind: "unlinked", sort: "date_desc" }), deps)).rows as UnlinkedTransactionRow[];
    check("sort date_asc / date_desc order by date", asc[0].date <= asc[1].date && desc[0].date >= desc[1].date);
    const s = await listMerchantIdentityRecords(q({ kind: "unlinked", q: "hardware" }), deps);
    check("search finds the actionable descriptor", s.total === 1 && s.kpiTotal === k30.coverage.unlinked);
    const probe = await listMerchantIdentityRecords(q({ kind: "unlinked", q: "pat example" }), deps);
    check("search never matches a withheld (transfer) descriptor", probe.total === 0);
    const dir = await listMerchantIdentityRecords(q({ kind: "merchants", q: "heron" }), deps);
    check("directory search: 1 of 3, KPI still 3", dir.total === 1 && dir.kpiTotal === 3);
    const top = (await listMerchantIdentityRecords(q({ kind: "merchants" }), deps)).rows as { displayName: string; transactionCount: number; aliasCount: number; reviewStatus: string; lastSeen: string | null }[];
    check("directory: default sort = most LIVE transactions (soft-deleted excluded)", top[0].displayName === "Northwind Grocer" && top[0].transactionCount === 40 && top[1].transactionCount === 7, top.map((t) => t.transactionCount));
    check("directory: alias count, last seen, review status", top[0].aliasCount === 2 && top[0].lastSeen !== null && top[0].reviewStatus === "MERGE_SURVIVOR" && top[1].reviewStatus === "KEPT_APART", top.map((t) => t.reviewStatus));
    const ds = await listMerchantIdentityRecords(q({ kind: "merged", window: 90, q: "northwind" }), deps);
    check("decision search narrows by key, KPI unchanged", ds.total === 1 && ds.kpiTotal === 2);
    const m = (await listMerchantIdentityRecords(q({ kind: "merged" }), deps)).rows as MergeDecisionRow[];
    check("merge row: source → destination, affected count, operator, reason from the audit", m[0].sourceKey === "ACME STREAMING PLUS" && m[0].destinationKey === "ACME STREAMING" && m[0].affectedTransactions === 7 && m[0].operator === "ops-one" && m[0].reason?.code === "DUPLICATE_RECORD" && m[0].destinationMerchantId === cid(3), m[0]);
    const d = (await listMerchantIdentityRecords(q({ kind: "dismissed" }), deps)).rows as MergeDecisionRow[];
    check("dismissed row: candidate, reason, operator", d[0].pairKey === "BLUE HERON CAFE|BLUE HERON CATERING" && d[0].operator === "Operator Two" && d[0].reason?.code === "NOT_A_DUPLICATE" && d[0].affectedTransactions === null);
    const det = await getMerchantIdentityDetail(cid(1), deps);
    check("merchant detail: aliases, transactions, classification, history", !!det && det.aliases.total === 2 && det.transactions.total === 40 && det.classification.byCategory[0].key === "Groceries" && det.history.some((h) => h.kind === "MERGED_IN") && det.history[0].kind === "CREATED", det && { a: det.aliases.total, t: det.transactions.total });
    check("merchant detail: unknown id → null", (await getMerchantIdentityDetail(cid(99), deps)) === null);
    check("pageWindow arithmetic", JSON.stringify(pageWindow(0, 1)) === JSON.stringify({ page: 1, pageCount: 1, skip: 0, take: 25 }));
  }

  console.log("5. parsing + deep-link round trip");
  {
    const bad = (s: string) => !parseRecordsQuery(new URLSearchParams(s)).ok;
    check("refuses unknown kind / window / sort / page / misplaced filter",
      bad("kind=nope") && bad("kind=merged&window=7") && bad("kind=merged&sort=name_asc") && bad("kind=merged&page=0") && bad("kind=merchants&filter=ELIGIBLE") && bad("kind=unlinked&filter=NOPE"));
    const ok = parseRecordsQuery(new URLSearchParams("kind=unlinked&window=90&filter=WALLET&page=2&sort=date_asc&q=Shop%2012345"));
    check("parses a full query; digits stripped from the search", ok.ok && ok.query.window === 90 && ok.query.filter === "WALLET" && ok.query.page === 2 && ok.query.q === "Shop", ok);
    check("a one-letter search is no search", cleanSearch("a") === null);
    check("every Merchant URL param is a declared Space param AND workspace-scoped",
      MERCHANT_URL_PARAMS.every((p) => (SPACE_URL_PARAMS as readonly string[]).includes(p) && PLATFORM_WORKSPACE_SCOPED_PARAMS.includes(p)));
    const states = [
      { ...CLOSED_STATE, period: 90 as const },
      openRecords({ ...CLOSED_STATE, period: 90 }, "unlinked", "ELIGIBLE"),
      { ...openRecords(CLOSED_STATE, "merchants"), q: "heron", sort: "name_asc", page: 2, merchantId: cid(2) },
      { ...openRecords(CLOSED_STATE, "dismissed"), sort: "decided_asc", page: 3 },
    ];
    for (const s of states) {
      const qs = applySpaceUrlUpdate("workspace=platform-overview&foo=1", merchantRecordsUrlUpdate(s));
      const back = readMerchantRecordsUrl(qs);
      check(`round trip ${s.records ?? "closed"}: state → URL → state, unrelated params kept`, JSON.stringify(back) === JSON.stringify(s) && qs.includes("foo=1") && qs.includes("workspace=platform-overview"), { qs, back });
    }
    const closed = applySpaceUrlUpdate("records=merged&rpage=2&rq=x&foo=1", merchantRecordsUrlUpdate(CLOSED_STATE));
    check("closing the records leaves a clean URL", closed === "foo=1", closed);
    const junk = readMerchantRecordsUrl("records=merged&rsort=name_asc&rpage=-4&rfilter=WALLET&rid=" + cid(1));
    check("an invalid refinement drops only itself (never an error page)", junk.records === "merged" && junk.sort === null && junk.page === 1 && junk.filter === null && junk.merchantId === null, junk);
    check("an unknown kind opens nothing", readMerchantRecordsUrl("records=nope").records === null);
    check("the API path carries the period (the KPI's window)", recordsApiPath(openRecords({ ...CLOSED_STATE, period: 90 }, "merged")) === "/api/platform/merchant-ops/records?kind=merged&window=90");
    const lead = code("components/platform/leads/MerchantLead.tsx");
    check("the lead writes the URL through the one seam, REPLACE only", /spaceUrl\.commit\(merchantRecordsUrlUpdate\(next\), \{ history: "replace" \}\)/.test(lead) && !/history: "push"/.test(lead) && !/window\.history/.test(lead));
  }

  console.log("6. sanitization — no raw provider text where it must not appear");
  {
    const rows = [...(await listMerchantIdentityRecords(q({ kind: "unlinked", sort: "date_asc" }), deps)).rows as UnlinkedTransactionRow[]];
    for (let pg = 2; pg <= 3; pg++) rows.push(...((await listMerchantIdentityRecords(q({ kind: "unlinked", sort: "date_asc", page: pg }), deps)).rows as UnlinkedTransactionRow[]));
    const json = JSON.stringify(rows);
    check("excluded rows carry no descriptor", rows.filter((r) => !r.expected).every((r) => r.descriptor === null));
    check("no wallet address, transfer counterparty, e-mail or long digit run in any row",
      !/bc1q|PAT EXAMPLE|Pat Example|99887766|contact@|5551234567|\d{4,}/i.test(json.replace(/"date":"\d{4}-\d\d-\d\d"/g, "").replace(/"id":"tx\d+"/g, "")), json.slice(0, 300));
    check("the processor prefix and store number are dropped", rows.some((r) => r.descriptor === "Bluefield Hardware"), rows.map((r) => r.descriptor).slice(0, 8));
    check("sanitizer masks residual references and e-mail", sanitizeDescriptor("ORDER contact@shop.example ref A1B2C3D4E5F6G7H8J9") === "ORDER [email] ref [ref]", sanitizeDescriptor("ORDER contact@shop.example ref A1B2C3D4E5F6G7H8J9"));
    check("…and clamps length", (sanitizeDescriptor("A".repeat(10) + " " + "B".repeat(60)) ?? "").length <= 40);
    check("no amount field anywhere in the rows", !/amount/i.test(json));
    const detailJson = JSON.stringify(await getMerchantIdentityDetail(cid(1), deps));
    check("merchant detail carries no amount, account id or address; aliases sanitized", !/amount|acc-bank|bc1q|0042/i.test(detailJson), detailJson.slice(0, 200));
    const reader = code("lib/platform/merchant/records.ts") + code("lib/platform/merchant/records-query.ts");
    check("the readers never SELECT an amount, address, account name or user email",
      !/\b(amount|walletAddress|email|name|institution|mask)\s*:\s*true/.test(reader.replace(/username: true, name: true/, "")) , reader.match(/\b(amount|walletAddress|email|institution|mask)\s*:\s*true/));
  }

  console.log("7. permission + read/write separation");
  {
    for (const f of ["app/api/platform/merchant-ops/records/route.ts", "app/api/platform/merchant-ops/merchants/[id]/route.ts"]) {
      const s = code(f);
      check(`${f}: MERCHANT_OPS READ first, error returned`, /requirePlatformAccess\(\s*"MERCHANT_OPS"\s*,\s*"READ"\s*\)/.test(s) && /if \(err\) return err;/.test(s) && s.indexOf("requirePlatformAccess(") < s.indexOf("await ctx.params") + (f.includes("[id]") ? 0 : 1e9));
      check(`${f}: no WRITE/CONTROL, no mutating verb, no db import, no-store`, !/"(WRITE|CONTROL)"/.test(s) && !/export\s+(async\s+)?function\s+(POST|PUT|PATCH|DELETE)/.test(s) && !/@\/lib\/db/.test(s) && /no-store/.test(s));
    }
    const rcRaw = readFileSync(path.join(ROOT, "app/api/merchant-ops/reconsider/route.ts"), "utf8");
    const rc = code("app/api/merchant-ops/reconsider/route.ts");
    check("reconsider: per-operator rate limit on its OWN bucket, right after the fresh grant and before the body",
      /const RECONSIDER_BUCKET = "merchant-ops-reconsider";/.test(rcRaw) && /RECONSIDER_PER_OPERATOR_PER_MINUTE = 30;/.test(rcRaw)
        && /limitByUser\(auth\.user\.id, RECONSIDER_BUCKET, \{ limit: RECONSIDER_PER_OPERATOR_PER_MINUTE, windowSec: 60 \}\)/.test(rc)
        && /if \(limited\) return limited;/.test(rc)
        && rc.indexOf('requireFreshPlatformAccess("MERCHANT_OPS", "WRITE")') < rc.indexOf("limitByUser(") && rc.indexOf("limitByUser(") < rc.indexOf("req.json()"));
    {
      // UI-021 — the bucket is not shared with any other route.
      const { readdirSync, statSync } = await import("node:fs");
      const walk = (d: string): string[] => readdirSync(path.join(ROOT, d)).flatMap((e) => {
        const rel = path.join(d, e);
        return statSync(path.join(ROOT, rel)).isDirectory() ? walk(rel) : /\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e) ? [rel] : [];
      });
      const users = walk("app").filter((f) => readFileSync(path.join(ROOT, f), "utf8").includes('"merchant-ops-reconsider"'));
      check("the merchant-ops-reconsider bucket is used by the reconsider route alone", users.length === 1 && users[0] === path.join("app", "api", "merchant-ops", "reconsider", "route.ts"), users);
    }
    const recordsRaw = readFileSync(path.join(ROOT, "app/api/platform/merchant-ops/records/route.ts"), "utf8");
    check("the records GET documents that q travels in the query string (logs) and must stay letters-only, never amount/digit search",
      /`q` TRAVELS IN THE QUERY STRING/.test(recordsRaw) && /LETTERS-ONLY/.test(recordsRaw) && /amount \/ digit search\s*\n?\s*\*?\s*must NEVER be added to this GET/.test(recordsRaw));
    check("…and the parser it uses keeps q letters-only (digits, symbols, amounts stripped)",
      cleanSearch("$1,234.56 Coffee 4111") === "Coffee" && cleanSearch("12345") === null && cleanSearch("acct#9876 Bistro") === "acct Bistro");
    check("reconsider: FRESH MERCHANT_OPS WRITE before the body, reason before the act",
      rc.indexOf('requireFreshPlatformAccess("MERCHANT_OPS", "WRITE")') > -1 && rc.indexOf('requireFreshPlatformAccess("MERCHANT_OPS", "WRITE")') < rc.indexOf("req.json()")
        && rc.indexOf("parseOperatorReason(") < rc.indexOf("reconsiderDismissedPair("));
    const dismissed = await listMerchantIdentityRecords(q({ kind: "dismissed" }), deps);
    const ro = renderToStaticMarkup(createElement(RecordsBody, { data: dismissed, canWrite: false, onOpenMerchant: () => {}, onChanged: () => {} }));
    const rw = renderToStaticMarkup(createElement(RecordsBody, { data: dismissed, canWrite: true, onOpenMerchant: () => {}, onChanged: () => {} }));
    check("a READ holder sees no Reconsider control and the read-only line", !ro.includes("data-reconsider") && ro.includes(RECONSIDER_READ_ONLY.slice(0, 20)));
    check("a WRITE holder sees Reconsider on each dismissed row", (rw.match(/data-reconsider/g) ?? []).length === dismissed.rows.length);
    const merged = await listMerchantIdentityRecords(q({ kind: "merged" }), deps);
    check("merge history offers no control at any level (a merge has no undo)", !renderToStaticMarkup(createElement(RecordsBody, { data: merged, canWrite: true, onOpenMerchant: () => {}, onChanged: () => {} })).includes("data-reconsider"));
    const ov = buildMerchantOverview({ kpis: k30, bySource: [], aliasesBySource: [], userRules: 0, decisions: [], byTier: [], aliasDays: [], ruleDays: [] }, NOW, 30);
    const opened: string[] = [];
    const surface = renderToStaticMarkup(createElement(MerchantLeadSurface, { f: { data: ov, loading: false, error: null }, period: "30", onPeriod: () => {}, onOpenRecords: (k) => opened.push(k), records: createElement("p", null, "RECORDS-SLOT") }));
    check("each KPI tile names the records it opens; the panel renders under the hero",
      ["Open the merchant directory", "Open the transactions without a merchant", "Open the merge history", "Open the dismissed candidates"].every((l) => surface.includes(l))
        && surface.includes('id="mo-records"') && surface.indexOf("RECORDS-SLOT") < surface.indexOf('id="mo-decisions"'));
    const unl = await listMerchantIdentityRecords(q({ kind: "unlinked" }), deps);
    const uh = renderToStaticMarkup(createElement(RecordsBody, { data: unl, canWrite: true, onOpenMerchant: () => {}, onChanged: () => {} }));
    check("the transaction table has no control and says expected vs excluded", !/<button/.test(uh) && uh.includes("Yes — actionable"));
  }

  console.log("8. reconsider — removes a DISMISSED decision with an audited reason; never a merge");
  {
    const store = [{ ...decisions[1] }, { ...decisions[0] }];
    const written: { action: string; metadata: Record<string, unknown> }[] = [];
    const tx = {
      merchantMergeDecision: {
        findUnique: async (a: { where: { pairKey: string } }) => store.find((d) => d.pairKey === a.where.pairKey) ?? null,
        deleteMany: async (a: { where: { id: string; verdict: string } }) => { const i = store.findIndex((d) => d.id === a.where.id && d.verdict === a.where.verdict); if (i < 0) return { count: 0 }; store.splice(i, 1); return { count: 1 }; },
      },
      auditLog: { create: async (a: { data: { action: string; metadata: Record<string, unknown> } }) => { written.push(a.data); return { id: "a1" }; } },
    };
    const client = { $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) } as unknown as Parameters<typeof reconsiderDismissedPair>[0];
    const by = { actor: { userId: "op1", via: "PLATFORM_GRANT" as const, area: "MERCHANT_OPS" }, reason: { code: "OPERATOR_CORRECTION" as never } };
    await reconsiderDismissedPair(client, "BLUE HERON CAFE|BLUE HERON CATERING", by);
    check("the dismissal is removed", !store.some((d) => d.pairKey === "BLUE HERON CAFE|BLUE HERON CATERING"));
    check("…recorded as MERCHANT_MERGE_RECONSIDERED with the reason and the removed decision",
      written.length === 1 && written[0].action === "MERCHANT_MERGE_RECONSIDERED" && (written[0].metadata.reason as { code: string }).code === "OPERATOR_CORRECTION"
        && (written[0].metadata.removedDecision as { verdict: string }).verdict === "DISMISSED", written[0]);
    let refused = false;
    try { await reconsiderDismissedPair(client, decisions[0].pairKey, by); } catch (e) { refused = e instanceof ReconsiderIneligibleError; }
    check("a MERGED decision cannot be reconsidered (and stays)", refused && store.some((d) => d.pairKey === decisions[0].pairKey) && written.length === 1);
    let missing = false;
    try { await reconsiderDismissedPair(client, "NO|PAIR", by); } catch (e) { missing = e instanceof ReconsiderIneligibleError; }
    check("an unknown pair is refused", missing);
  }

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
}

void main().catch((e) => { console.error(e); process.exit(1); });
