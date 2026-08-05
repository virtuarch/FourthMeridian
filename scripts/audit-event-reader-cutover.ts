/**
 * scripts/audit-event-reader-cutover.ts   (L8 — Phase B1)
 *
 * Proves the reader cutover changed NO number. READ-ONLY.
 *
 * It computes every headline total twice over the live corpus — once on the
 * pre-cutover population (`deletedAt: null` + banking population) and once on
 * the post-cutover population (the same, AND the event-projection filter) — and
 * asserts they are identical. A cutover that moves a total is a cutover that
 * changed meaning, which this one must not.
 *
 * Run: npx tsx --env-file=.env.local scripts/audit-event-reader-cutover.ts
 */

import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { serializeTransactionRow } from "@/lib/transactions/serialize";
import { classifyLiquidity, tierResolver, type LiquidityTx } from "@/lib/transactions/liquidity";
import { totalDebtPaid } from "@/lib/transactions/debt-payment-authority";
import { isIncome, isTransfer, isCostFlow, isRefund } from "@/lib/transactions/flow-predicates";
import { eventProjectionWhere, findDuplicateEvents } from "@/lib/transactions/event-projection";
import type { Transaction } from "@/types";

const bar = (s: string) => console.log(`\n${"═".repeat(78)}\n${s}\n${"═".repeat(78)}`);
const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
};

async function main() {
  console.log(`\n[AUDIT] L8-B1 reader cutover — READ-ONLY\n`);

  const spaces = await db.space.findMany({ select: { id: true, name: true } });
  const counts = await Promise.all(spaces.map(async (s) => ({
    ...s,
    n: await db.transaction.count({
      where: { deletedAt: null, financialAccount: { deletedAt: null, spaceAccountLinks: { some: { spaceId: s.id, status: "ACTIVE" } } } },
    }),
  })));
  const space = counts.sort((a, b) => b.n - a.n)[0];
  console.log(`  Space: ${space.name}`);

  const accounts = await db.financialAccount.findMany({ select: { id: true, type: true } });
  const liqCtx = tierResolver(accounts.map((a) => ({ id: a.id, type: a.type })));
  const A = new Map(accounts.map((a) => [a.id, a.type]));

  const base: Prisma.TransactionWhereInput = {
    deletedAt: null,
    flowType: { not: "INVESTMENT" },
    financialAccount: { deletedAt: null, spaceAccountLinks: { some: { spaceId: space.id, status: "ACTIVE" } } },
  };

  const load = async (where: Prisma.TransactionWhereInput) => {
    const rows = await db.transaction.findMany({
      where,
      include: { resolvedMerchant: { select: { displayName: true, logoUrl: true } } },
      orderBy: { economicDate: { sort: "desc", nulls: "last" } },
    });
    return rows.map((r) => ({
      ...serializeTransactionRow({ ...r, accountType: A.get(r.financialAccountId ?? "") ?? null }),
      financialAccountId: r.financialAccountId,
      transactionEventId: r.transactionEventId,
    })) as (Transaction & { financialAccountId: string | null; transactionEventId: string | null })[];
  };

  const before = await load(base);
  const after = await load({ AND: [base, eventProjectionWhere()] });

  bar("POPULATION");
  console.log(`  pre-cutover  (deletedAt null + banking population) : ${before.length}`);
  console.log(`  post-cutover (+ event-projection filter)           : ${after.length}`);
  const dropped = before.filter((b) => !after.some((a) => a.id === b.id));
  console.log(`  rows the filter removed                            : ${dropped.length}`);
  for (const d of dropped.slice(0, 10)) {
    console.log(`      ${String(d.date).slice(0, 10)}  ${money(d.amount)}  ${(d.merchant ?? "").slice(0, 40)}  event=${d.transactionEventId}`);
  }
  const eventless = after.filter((r) => r.transactionEventId == null);
  console.log(`  rows KEPT with no event (out of scope, e.g. crypto): ${eventless.length}`);

  bar("EVERY HEADLINE TOTAL, BEFORE vs AFTER");
  const totals = (rows: typeof before) => {
    const liq = rows.map((t) => ({ t, c: classifyLiquidity(t as unknown as LiquidityTx, liqCtx) }));
    return {
      count:      rows.length,
      cashIn:     liq.filter((x) => x.c.effect === "CASH_IN").reduce((a, x) => a + Math.abs(x.t.amount), 0),
      cashOut:    liq.filter((x) => x.c.effect === "CASH_OUT").reduce((a, x) => a + Math.abs(x.t.amount), 0),
      income:     rows.filter((t) => isIncome(t.flowType)).reduce((a, t) => a + t.amount, 0),
      spend:      rows.filter((t) => isCostFlow(t.flowType)).reduce((a, t) => a + Math.abs(t.amount), 0),
      refunds:    rows.filter((t) => isRefund(t.flowType)).reduce((a, t) => a + Math.abs(t.amount), 0),
      transfers:  rows.filter((t) => isTransfer(t.flowType)).reduce((a, t) => a + Math.abs(t.amount), 0),
      debtPaid:   totalDebtPaid(rows as unknown as LiquidityTx[], liqCtx, (t) => Math.abs(t.amount)).total,
    };
  };
  const b = totals(before), a = totals(after);
  const rows: [string, number, number][] = [
    ["transaction count", b.count, a.count],
    ["Cash In", b.cashIn, a.cashIn],
    ["Cash Out", b.cashOut, a.cashOut],
    ["Net Cash Flow", b.cashIn - b.cashOut, a.cashIn - a.cashOut],
    ["Income", b.income, a.income],
    ["Spending", b.spend, a.spend],
    ["Refunds", b.refunds, a.refunds],
    ["Transfers", b.transfers, a.transfers],
    ["Debt paid", b.debtPaid, a.debtPaid],
  ];
  for (const [name, bv, av] of rows) {
    const same = Math.abs(bv - av) < 0.005;
    const fmt = name === "transaction count" ? (n: number) => String(n) : money;
    console.log(`  ${name.padEnd(20)} ${fmt(bv).padStart(15)}  →  ${fmt(av).padStart(15)}   ${same ? "✓" : "✗ CHANGED"}`);
    if (!same) failures++;
  }

  bar("GUARANTEES");
  check("no logical event appears twice in the post-cutover population",
    findDuplicateEvents(after).length === 0,
    JSON.stringify(findDuplicateEvents(after).slice(0, 3)));
  check("the pre-cutover population also had none (so nothing was being double-counted)",
    findDuplicateEvents(before).length === 0);
  check("rows outside the event domain are KEPT, not dropped",
    eventless.length > 0 || (await db.transaction.count({ where: { ...base, transactionEventId: null } })) === 0);

  // Observation history survives the cutover untouched.
  const obs = await db.transactionObservation.count();
  const events = await db.transactionEvent.count();
  console.log(`\n  observations preserved : ${obs}`);
  console.log(`  events preserved       : ${events}`);
  const multi = await db.transactionEvent.count({ where: { observationCount: { gt: 1 } } });
  console.log(`  multi-observation events (a pending that later posted): ${multi}`);
  // The event that a pending→posted chain produced must still resolve to exactly
  // one live row (or to none, when the pending was withdrawn and never posted).
  const multiEvents = await db.transactionEvent.findMany({
    where: { observationCount: { gt: 1 } }, select: { id: true, currentTransactionId: true },
  });
  const multiObs = await db.transactionObservation.findMany({
    where: { eventId: { in: multiEvents.map((e) => e.id) } },
    select: { eventId: true, transactionId: true },
  });
  const liveIds = new Set((await db.transaction.findMany({
    where: { id: { in: multiObs.map((o) => o.transactionId).filter((x): x is string => x != null) }, deletedAt: null },
    select: { id: true },
  })).map((r) => r.id));
  const liveByEvent = new Map<string, number>();
  for (const o of multiObs) {
    if (o.transactionId && liveIds.has(o.transactionId)) {
      liveByEvent.set(o.eventId, (liveByEvent.get(o.eventId) ?? 0) + 1);
    }
  }
  const overProjected = multiEvents.filter((e) => (liveByEvent.get(e.id) ?? 0) > 1);
  check("multi-observation events project at most ONE live row each",
    overProjected.length === 0, overProjected.slice(0, 3).map((e) => e.id).join("; "));

  bar("CHRONOLOGY UNCHANGED");
  const chron = (rows: typeof before) => rows.map((r) => `${r.id}|${r.date}`).sort();
  const same = JSON.stringify(chron(before).filter((x) => chron(after).includes(x))) === JSON.stringify(chron(after));
  check("every surviving row keeps its economic date", same);

  bar("FINGERPRINTS");
  const fp = (label: string, parts: string[]) =>
    console.log(`  ${label.padEnd(30)} ${createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16)}  (${parts.length})`);
  fp("pre-cutover rows", before.map((r) => `${r.id}|${r.date}|${r.amount}|${r.flowType}`).sort());
  fp("post-cutover rows", after.map((r) => `${r.id}|${r.date}|${r.amount}|${r.flowType}`).sort());

  if (failures > 0) {
    console.error(`\n[AUDIT] FAILED — ${failures} check(s) broken.\n`);
    await db.$disconnect(); process.exit(1);
  }
  console.log(`\n[AUDIT] PASSED — the cutover moved no number. Nothing was written.\n`);
  await db.$disconnect();
}
main().catch(async (e) => { console.error(e); await db.$disconnect(); process.exit(1); });
