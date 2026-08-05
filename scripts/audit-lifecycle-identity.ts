/**
 * scripts/audit-lifecycle-identity.ts   (L8 Part 1)
 *
 * The CURRENT identity model, traced end to end. READ-ONLY.
 *
 * Every lifecycle relationship the corpus already holds, across ACTIVE AND
 * TOMBSTONED rows and the whole corpus — not one user. This is the evidence the
 * additive event model must fit; nothing here proposes a schema.
 *
 * Run: npx tsx --env-file=.env.local scripts/audit-lifecycle-identity.ts
 */

import { db } from "@/lib/db";
import { createHash } from "node:crypto";

const bar = (s: string) => console.log(`\n${"═".repeat(78)}\n${s}\n${"═".repeat(78)}`);
const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "—");
const pct = (n: number, d: number) => (d === 0 ? "—" : `${((100 * n) / d).toFixed(1)}%`);

async function main() {
  const rows = await db.transaction.findMany({
    select: {
      id: true, financialAccountId: true, date: true, economicDate: true, authorizedAt: true,
      amount: true, merchant: true, description: true, category: true, currency: true,
      pending: true, settlementState: true, deletedAt: true,
      plaidTransactionId: true, pendingTransactionRef: true, externalTransactionId: true,
      importBatchId: true, flowType: true, classificationReason: true,
      counterpartyAccountId: true, createdAt: true, updatedAt: true,
    },
  });
  const accounts = await db.financialAccount.findMany({
    select: { id: true, type: true, institution: true, institutionId: true, plaidAccountId: true, walletAddress: true },
  });
  const A = new Map(accounts.map((a) => [a.id, a]));
  const provider = (r: (typeof rows)[number]) => {
    const a = r.financialAccountId ? A.get(r.financialAccountId) : undefined;
    if (a?.walletAddress) return "WALLET";
    if (r.importBatchId) return "IMPORT";
    if (r.plaidTransactionId || a?.plaidAccountId) return "PLAID";
    return "MANUAL";
  };

  bar("1. POPULATION");
  console.log(`  rows in table (tombstones INCLUDED) : ${rows.length}`);
  console.log(`  active (deletedAt IS NULL)          : ${rows.filter((r) => !r.deletedAt).length}`);
  console.log(`  tombstoned                          : ${rows.filter((r) => r.deletedAt).length}`);
  const byProvider = new Map<string, number>();
  for (const r of rows) byProvider.set(provider(r), (byProvider.get(provider(r)) ?? 0) + 1);
  console.log(`  by provider:`, Object.fromEntries([...byProvider].sort((a, b) => b[1] - a[1])));

  bar("2. IDENTITY COLUMN COVERAGE");
  const cov = (n: string, f: (r: (typeof rows)[number]) => boolean) =>
    console.log(`  ${n.padEnd(30)} ${String(rows.filter(f).length).padStart(5)}  ${pct(rows.filter(f).length, rows.length)}`);
  cov("plaidTransactionId", (r) => !!r.plaidTransactionId);
  cov("pendingTransactionRef", (r) => !!r.pendingTransactionRef);
  cov("externalTransactionId", (r) => !!r.externalTransactionId);
  cov("importBatchId", (r) => !!r.importBatchId);
  cov("authorizedAt", (r) => !!r.authorizedAt);
  cov("economicDate", (r) => !!r.economicDate);
  cov("settlementState", (r) => !!r.settlementState);
  // A provider id is the only stable continuity anchor. Where it is absent, no
  // amount of lifecycle evidence can establish identity across a re-sync.
  const noAnchor = rows.filter((r) => !r.plaidTransactionId && !r.externalTransactionId);
  console.log(`  ⚠️ rows with NO provider anchor       ${String(noAnchor.length).padStart(5)}  ${pct(noAnchor.length, rows.length)}`);
  const anchorByProvider = new Map<string, number>();
  for (const r of noAnchor) anchorByProvider.set(provider(r), (anchorByProvider.get(provider(r)) ?? 0) + 1);
  console.log(`     of which:`, Object.fromEntries(anchorByProvider));

  bar("3. LIFECYCLE COLUMN AGREEMENT");
  const agree = new Map<string, number>();
  for (const r of rows) {
    const k = `pending=${r.pending} / settlementState=${r.settlementState ?? "null"} / ${r.deletedAt ? "TOMBSTONED" : "live"}`;
    agree.set(k, (agree.get(k) ?? 0) + 1);
  }
  for (const [k, v] of [...agree].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(5)}  ${k}`);
  const contradictory = rows.filter(
    (r) => r.settlementState != null && ((r.settlementState === "PENDING") !== r.pending));
  console.log(`  ⚠️ pending vs settlementState CONTRADICTORY: ${contradictory.length}`);
  for (const r of contradictory.slice(0, 6)) {
    console.log(`     ${r.id} pending=${r.pending} settlementState=${r.settlementState} ${JSON.stringify(r.merchant).slice(0, 34)}`);
  }

  bar("4. PENDING ↔ POSTED CHAINS — the census");
  const byPlaidId = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (r.plaidTransactionId) byPlaidId.set(r.plaidTransactionId, r);

  const postedWithRef = rows.filter((r) => r.pendingTransactionRef);
  const resolvedRef = postedWithRef.filter((r) => byPlaidId.has(r.pendingTransactionRef!));
  const danglingRef = postedWithRef.filter((r) => !byPlaidId.has(r.pendingTransactionRef!));
  // Which rows are somebody's predecessor?
  const predecessorIds = new Set(resolvedRef.map((r) => byPlaidId.get(r.pendingTransactionRef!)!.id));

  const livePending = rows.filter((r) => r.pending && !r.deletedAt);
  const tombstonedPending = rows.filter((r) => r.pending && r.deletedAt);
  const posted = rows.filter((r) => !r.pending);

  console.log(`  posted rows carrying a pendingTransactionRef : ${postedWithRef.length}`);
  console.log(`    ...whose predecessor EXISTS in the table   : ${resolvedRef.length}`);
  console.log(`    ...DANGLING (predecessor absent)           : ${danglingRef.length}  ⚠️ identity cannot be reconstructed`);
  console.log(`  rows that ARE a predecessor                  : ${predecessorIds.size}`);
  console.log(`  pending rows, live                           : ${livePending.length}`);
  console.log(`  pending rows, tombstoned                     : ${tombstonedPending.length}`);
  console.log(`  posted rows                                  : ${posted.length}`);

  // Every category the brief asks for, as disjoint buckets.
  const pendingWithSuccessor = rows.filter((r) => r.pending && predecessorIds.has(r.id));
  const pendingWithoutSuccessor = rows.filter((r) => r.pending && !predecessorIds.has(r.id));
  const postedWithPredecessor = resolvedRef;
  const postedFirstSeenPosted = posted.filter((r) => !r.pendingTransactionRef);
  console.log(`\n  pending WITH a posted successor              : ${pendingWithSuccessor.length}`);
  console.log(`    ...of which tombstoned (the normal path)   : ${pendingWithSuccessor.filter((r) => r.deletedAt).length}`);
  console.log(`    ...of which STILL LIVE (double-count risk) : ${pendingWithSuccessor.filter((r) => !r.deletedAt).length}`);
  console.log(`  pending WITHOUT a successor                  : ${pendingWithoutSuccessor.length}`);
  console.log(`    ...live  (in flight, or withdrawn)         : ${pendingWithoutSuccessor.filter((r) => !r.deletedAt).length}`);
  console.log(`    ...tombstoned (WITHDRAWN — never posted)   : ${pendingWithoutSuccessor.filter((r) => r.deletedAt).length}`);
  console.log(`  posted WITH a pending predecessor            : ${postedWithPredecessor.length}`);
  console.log(`  posted FIRST OBSERVED as posted              : ${postedFirstSeenPosted.length}`);
  const total = pendingWithSuccessor.length + pendingWithoutSuccessor.length + posted.length;
  console.log(`  ${total === rows.length ? "✓" : "✗"} buckets sum to ${total} of ${rows.length}`);

  bar("5. WHAT CHANGES BETWEEN THE TWO OBSERVATIONS");
  const deltas = { amount: 0, date: 0, economicDate: 0, merchant: 0, description: 0, account: 0, category: 0, flowType: 0, currency: 0 };
  const examples: string[] = [];
  const lagDays: number[] = [];
  for (const p of resolvedRef) {
    const pre = byPlaidId.get(p.pendingTransactionRef!)!;
    if (Math.abs(pre.amount - p.amount) > 0.005) deltas.amount++;
    if (iso(pre.date) !== iso(p.date)) deltas.date++;
    if (iso(pre.economicDate) !== iso(p.economicDate)) deltas.economicDate++;
    if (pre.merchant !== p.merchant) deltas.merchant++;
    if ((pre.description ?? "") !== (p.description ?? "")) deltas.description++;
    if (pre.financialAccountId !== p.financialAccountId) deltas.account++;
    if (pre.category !== p.category) deltas.category++;
    if ((pre.flowType ?? null) !== (p.flowType ?? null)) deltas.flowType++;
    if ((pre.currency ?? null) !== (p.currency ?? null)) deltas.currency++;
    lagDays.push(Math.round((p.date.getTime() - pre.date.getTime()) / 86_400_000));
    if (examples.length < 6 && (Math.abs(pre.amount - p.amount) > 0.005 || iso(pre.date) !== iso(p.date))) {
      examples.push(
        `${pre.id}→${p.id}  amount ${pre.amount}→${p.amount}  posting ${iso(pre.date)}→${iso(p.date)}  ` +
        `economic ${iso(pre.economicDate)}→${iso(p.economicDate)}  ${JSON.stringify(p.merchant).slice(0, 30)}`);
    }
  }
  console.log(`  over ${resolvedRef.length} resolved chains:`);
  for (const [k, v] of Object.entries(deltas)) console.log(`    ${k.padEnd(14)} changed on ${String(v).padStart(4)} chains  ${pct(v, resolvedRef.length)}`);
  console.log(`\n  ⚠️ ECONOMIC DATE MOVED on ${deltas.economicDate} chains — must be 0 (posting must not move the event)`);
  const h = new Map<number, number>();
  for (const d of lagDays) h.set(d, (h.get(d) ?? 0) + 1);
  console.log(`  pending→posted POSTING lag (days): ${[...h].sort((a, b) => a[0] - b[0]).map(([d, c]) => `${d}:${c}`).join(" ")}`);
  for (const e of examples) console.log(`    ${e}`);

  bar("6. CONTRADICTORY / UNMATCHED EVIDENCE");
  console.log(`  dangling pendingTransactionRef (no such plaidTransactionId) : ${danglingRef.length}`);
  for (const r of danglingRef.slice(0, 8)) {
    console.log(`     ${r.id} ref=${r.pendingTransactionRef} ${iso(r.date)} ${r.amount} ${JSON.stringify(r.merchant).slice(0, 30)}`);
  }
  const dupPlaid = new Map<string, number>();
  for (const r of rows) if (r.plaidTransactionId) dupPlaid.set(r.plaidTransactionId, (dupPlaid.get(r.plaidTransactionId) ?? 0) + 1);
  console.log(`  duplicate plaidTransactionId values : ${[...dupPlaid.values()].filter((v) => v > 1).length}  (column is @unique)`);
  const multiRef = new Map<string, number>();
  for (const r of postedWithRef) multiRef.set(r.pendingTransactionRef!, (multiRef.get(r.pendingTransactionRef!) ?? 0) + 1);
  const fanIn = [...multiRef.entries()].filter(([, v]) => v > 1);
  console.log(`  ⚠️ one pending claimed by MORE THAN ONE posted row : ${fanIn.length}  (would break 1:1 identity)`);
  for (const [ref, n] of fanIn.slice(0, 6)) console.log(`     ref=${ref} claimed by ${n} rows`);
  const liveBoth = rows.filter((r) => r.pending && !r.deletedAt && predecessorIds.has(r.id));
  console.log(`  ⚠️ LIVE pending + LIVE posted for one event : ${liveBoth.length}  (double-count risk)`);
  const tombstonedNotPending = rows.filter((r) => r.deletedAt && !r.pending);
  console.log(`  tombstoned rows that were NOT pending : ${tombstonedNotPending.length}  (import rollback, not lifecycle)`);
  const byTombProvider = new Map<string, number>();
  for (const r of tombstonedNotPending) byTombProvider.set(provider(r), (byTombProvider.get(provider(r)) ?? 0) + 1);
  console.log(`     of which:`, Object.fromEntries(byTombProvider));

  bar("7. WHAT AN EVENT MODEL WOULD HAVE TO COVER");
  const eligible = rows.filter((r) => provider(r) === "PLAID" || provider(r) === "IMPORT" || provider(r) === "MANUAL");
  const walletRows = rows.filter((r) => provider(r) === "WALLET");
  console.log(`  BANKING rows (in scope)   : ${eligible.length}`);
  console.log(`  WALLET rows (OUT of scope): ${walletRows.length}  — crypto gets its own domain implementation later`);
  const events = eligible.length - resolvedRef.length;
  console.log(`\n  projected logical events  : ${events}`);
  console.log(`    multi-observation events: ${resolvedRef.length}`);
  console.log(`    single-observation      : ${events - resolvedRef.length}`);
  console.log(`    observations total      : ${eligible.length}`);

  bar("8. FINGERPRINTS");
  const fp = (label: string, parts: string[]) =>
    console.log(`  ${label.padEnd(30)} ${createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16)}  (${parts.length})`);
  fp("lifecycle evidence", rows.map((r) =>
    `${r.id}|${r.plaidTransactionId}|${r.pendingTransactionRef}|${r.pending}|${r.settlementState}|${r.deletedAt?.toISOString() ?? ""}`).sort());
  fp("immutable transaction fields", rows.map((r) =>
    `${r.id}|${r.amount}|${r.date.toISOString()}|${r.economicDate?.toISOString() ?? ""}|${r.financialAccountId}|${r.merchant}`).sort());

  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
