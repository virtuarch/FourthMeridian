/**
 * scripts/audit-cashflow-debt-defect.ts
 *
 * Financial Truth — the Cash Flow transfer / debt-payment defect. READ-ONLY.
 *
 * Parts 1–5 of the brief, measured rather than reasoned about:
 *   1. the exact $4,000 legs, end to end
 *   2. what each Cash Flow number claims vs contains
 *   3. every American Express movement by canonical maturity
 *   4. the Debt Payments card's exact event ids, with attestation
 *   5. Cash Out composition
 *
 * Run: npx tsx --env-file=.env.local scripts/audit-cashflow-debt-defect.ts
 */

import { db } from "@/lib/db";
import { createHash } from "node:crypto";
import { serializeTransactionRow } from "@/lib/transactions/serialize";
import { resolveTransferAssessments } from "@/lib/transactions/transfer-resolution";
import { classifyLiquidity, tierResolver, type LiquidityTx } from "@/lib/transactions/liquidity";
import {
  selectDebtPaymentCashLegs, groupDebtPaymentsByCreditor, attributeCreditor,
  UNRESOLVED_CREDITOR_KEY, type CreditorAccountRef,
} from "@/lib/transactions/debt-payment-authority";
import { isDebtPayment, isTransfer } from "@/lib/transactions/flow-predicates";
import type { Transaction } from "@/types";

const bar = (s: string) => console.log(`\n${"═".repeat(78)}\n${s}\n${"═".repeat(78)}`);
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  \u2713 ${name}`);
  else { failures++; console.error(`  \u2717 ${name}${detail ? `\n      ${detail}` : ""}`); }
};
const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The two rows the brief names. */
const INBOUND  = "cms98o4rp005u2bihex0q0loq"; // +4000 into the Amex HYSA
const OUTBOUND = "cmsg19jov000ctjqvnmibcpaq"; // −4000 out of Chase checking

async function main() {
  console.log(`\n[AUDIT] Cash Flow transfer / debt-payment defect — READ-ONLY\n`);

  const accounts = await db.financialAccount.findMany({
    select: { id: true, name: true, type: true, institution: true, institutionId: true },
  });
  const A = new Map(accounts.map((a) => [a.id, a]));
  const liqCtx = tierResolver(accounts.map((a) => ({ id: a.id, type: a.type })));

  const spaces = await db.space.findMany({ select: { id: true, name: true } });
  const counts = await Promise.all(spaces.map(async (s) => ({
    ...s,
    n: await db.transaction.count({
      where: { deletedAt: null, financialAccount: { deletedAt: null, spaceAccountLinks: { some: { spaceId: s.id, status: "ACTIVE" } } } },
    }),
  })));
  const space = counts.sort((a, b) => b.n - a.n)[0];

  const raw = await db.transaction.findMany({
    where: {
      deletedAt: null, flowType: { not: "INVESTMENT" },
      financialAccount: { deletedAt: null, spaceAccountLinks: { some: { spaceId: space.id, status: "ACTIVE" } } },
    },
    include: { resolvedMerchant: { select: { displayName: true, logoUrl: true } } },
    orderBy: { economicDate: { sort: "desc", nulls: "last" } },
  });
  // ⚠️ The live read boundary runs READ-TIME transfer resolution and feeds the
  // result through `chooseCounterpartyId`. A probe that skips it sees a DIFFERENT
  // counterparty than the app does — which is exactly how the previous
  // convergence proof missed this defect.
  const assess = await resolveTransferAssessments(raw as never, { spaceId: space.id });
  const rows = raw.map((r) => ({
    ...serializeTransactionRow({ ...r, accountType: A.get(r.financialAccountId ?? "")?.type ?? null }),
    counterpartyAccountId: r.counterpartyAccountId ?? assess.get(r.id)?.counterpartyAccountId ?? null,
    transferMaturity: assess.get(r.id)?.maturity ?? null,
    financialAccountId: r.financialAccountId,
    transactionEventId: r.transactionEventId,
    pfcDetailed: r.pfcDetailed,
    classificationReason: r.classificationReason,
  })) as (Transaction & {
    financialAccountId: string | null; transactionEventId: string | null;
    pfcDetailed: string | null; classificationReason: string | null; transferMaturity: string | null;
  })[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  console.log(`  Space: ${space.name}   rows: ${rows.length}`);

  // ── PART 1 ───────────────────────────────────────────────────────────────
  bar("PART 1 — the exact $4,000 legs, end to end");
  const counted = new Set(selectDebtPaymentCashLegs(rows as unknown as LiquidityTx[], liqCtx).counted.map((r) => (r as unknown as Transaction).id));
  for (const id of [INBOUND, OUTBOUND]) {
    const r = byId.get(id);
    if (!r) { console.log(`  ${id}: NOT in the Cash Flow population`); continue; }
    const c = classifyLiquidity(r as unknown as LiquidityTx, liqCtx);
    const own = A.get(r.financialAccountId ?? "");
    const cp = r.counterpartyAccountId ? A.get(r.counterpartyAccountId) : null;
    console.log(`\n  ── ${id}`);
    console.log(`     amount            ${money(r.amount)}`);
    console.log(`     merchant          ${(r.merchant ?? "").slice(0, 56)}`);
    console.log(`     account           ${own?.name} (${own?.type}) · ${own?.institution}`);
    console.log(`     economic date     ${r.date}   posting ${(r as { postingDate?: string }).postingDate}`);
    console.log(`     event id          ${r.transactionEventId}`);
    console.log(`     flowType          ${r.flowType}      flowDirection ${(r as { flowDirection?: string }).flowDirection ?? "—"}`);
    console.log(`     provider category ${r.pfcDetailed ?? "—"}   via ${r.classificationReason ?? "—"}`);
    console.log(`     income subtype    ${(r as { incomeSubtype?: string }).incomeSubtype ?? "—"}`);
    console.log(`     transfer disposition ${(r as { transferDisposition?: string }).transferDisposition ?? "—"}`);
    console.log(`     TRANSFER MATURITY ${r.transferMaturity ?? "—"}   ← the canonical authority's verdict`);
    console.log(`     counterparty      ${cp ? `${cp.name} (${cp.type}) · ${cp.institution}` : "— NONE"}`);
    console.log(`     liquidity         ${c.effect} / ${c.reason}   confidence ${c.confidence}`);
    console.log(`     → enters Cash In        ${c.effect === "CASH_IN" ? "YES" : "no"}`);
    console.log(`     → enters Cash Out       ${c.effect === "CASH_OUT" ? "YES  ⚠️" : "no"}`);
    console.log(`     → enters Debt Payments  ${counted.has(r.id) ? "YES  ⚠️" : "no"}`);
  }

  // ── PART 4 ───────────────────────────────────────────────────────────────
  bar("PART 4 — the Debt Payments card's exact contents, with ATTESTATION");
  const cardRows = rows.filter((r) => counted.has(r.id));
  console.log(`  rows the card counts: ${cardRows.length}   total ${money(cardRows.reduce((a, r) => a + Math.abs(r.amount), 0))}`);
  // Attested = the destination is an OWNED LIABILITY account. Structural, from
  // the account graph — no merchant string, no institution name.
  const attested = cardRows.filter((r) => {
    const cp = r.counterpartyAccountId ? A.get(r.counterpartyAccountId) : null;
    return cp?.type === "debt";
  });
  const unattested = cardRows.filter((r) => !attested.includes(r));
  console.log(`  ATTESTED   (counterparty is an owned liability) : ${attested.length}  ${money(attested.reduce((a, r) => a + Math.abs(r.amount), 0))}`);
  console.log(`  UNATTESTED (no owned liability destination)     : ${unattested.length}  ${money(unattested.reduce((a, r) => a + Math.abs(r.amount), 0))}`);
  console.log(`\n  the UNATTESTED rows — each counted purely on the provider's category:`);
  for (const r of unattested.slice(0, 30)) {
    console.log(`    ${String(r.date).slice(0, 10)} ${money(r.amount).padStart(12)}  ${(r.merchant ?? "").slice(0, 44).padEnd(44)}  ${r.pfcDetailed ?? "—"}`);
  }
  if (unattested.length > 30) console.log(`    … and ${unattested.length - 30} more`);

  // The brief's actual test: no carded row may RESOLVE to a transfer maturity.
  // An unresolved counterparty is not a failure — a contradicted one is.
  const matOf = new Map<string, number>();
  for (const r of cardRows) matOf.set(r.transferMaturity ?? "(not assessed — persisted cp)", (matOf.get(r.transferMaturity ?? "(not assessed — persisted cp)") ?? 0) + 1);
  console.log(`\n  every carded row by CANONICAL MATURITY:`);
  for (const [k, n] of [...matOf].sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(34)} ${n}`);
  const CONTRADICTED = ["SAVINGS_TRANSFER", "CASH_TRANSFER", "INTERNAL_TRANSFER", "INVESTMENT_TRANSFER"];
  const bad = cardRows.filter((r) => r.transferMaturity && CONTRADICTED.includes(r.transferMaturity));
  console.log(`\n  ⚠️ carded rows the transfer authority says are NOT debt payments: ${bad.length}`);
  for (const r of bad) console.log(`     ${r.id}  ${money(r.amount)}  ${r.transferMaturity}  ${(r.merchant ?? "").slice(0,40)}`);

  // ── PART 3 ───────────────────────────────────────────────────────────────
  bar("PART 3 — every American Express movement, by structural destination");
  const amexIds = new Set(accounts.filter((a) => a.institutionId === "ins_10" || /american express/i.test(a.institution ?? "")).map((a) => a.id));
  console.log(`  Amex accounts: ${[...amexIds].map((i) => `${A.get(i)!.name} (${A.get(i)!.type})`).join(" · ")}`);
  const amexRows = rows.filter((r) =>
    amexIds.has(r.financialAccountId ?? "") || amexIds.has(r.counterpartyAccountId ?? ""));
  const cls = new Map<string, { n: number; sum: number; inCard: number }>();
  for (const r of amexRows) {
    const own = A.get(r.financialAccountId ?? "");
    const cp = r.counterpartyAccountId ? A.get(r.counterpartyAccountId) : null;
    // Structural classification ONLY — account types, never names.
    const k =
      own?.type === "debt" && r.amount > 0 ? ((r as { incomeSubtype?: string }).incomeSubtype === "ISSUER_CREDIT" ? "ISSUER_CREDIT" : "LIABILITY_INFLOW")
      : cp?.type === "debt" ? "DEBT_PAYMENT (attested)"
      : cp?.type === "savings" ? "SAVINGS_TRANSFER (attested)"
      : cp?.type === "checking" ? "CASH_TRANSFER (attested)"
      : isDebtPayment(r.flowType) ? "DEBT_PAYMENT (provider-asserted, UNATTESTED)"
      : isTransfer(r.flowType) ? "TRANSFER (unresolved destination)"
      : `other:${r.flowType}`;
    const g = cls.get(k) ?? { n: 0, sum: 0, inCard: 0 };
    g.n++; g.sum += Math.abs(r.amount); if (counted.has(r.id)) g.inCard++;
    cls.set(k, g);
  }
  console.log(`  rows touching an Amex account: ${amexRows.length}\n`);
  console.log(`  ${"class".padEnd(46)} ${"rows".padStart(5)} ${"amount".padStart(14)}  in Debt card`);
  for (const [k, g] of [...cls].sort((a, b) => b[1].sum - a[1].sum)) {
    console.log(`  ${k.padEnd(46)} ${String(g.n).padStart(5)} ${money(g.sum).padStart(14)}  ${g.inCard}`);
  }

  // ── PART 5 ───────────────────────────────────────────────────────────────
  bar("PART 5 — what Cash Out actually contains");
  const out = rows.map((r) => ({ r, c: classifyLiquidity(r as unknown as LiquidityTx, liqCtx) }))
    .filter((x) => x.c.effect === "CASH_OUT");
  const byReason = new Map<string, { n: number; sum: number }>();
  for (const x of out) {
    const g = byReason.get(x.c.reason) ?? { n: 0, sum: 0 };
    g.n++; g.sum += Math.abs(x.r.amount); byReason.set(x.c.reason, g);
  }
  console.log(`  Cash Out total ${money(out.reduce((a, x) => a + Math.abs(x.r.amount), 0))} across ${out.length} rows\n`);
  for (const [k, g] of [...byReason].sort((a, b) => b[1].sum - a[1].sum)) {
    console.log(`    ${k.padEnd(24)} ${String(g.n).padStart(5)} ${money(g.sum).padStart(14)}`);
  }
  // Does Cash Out contain movement between the user's OWN accounts?
  const internalInCashOut = out.filter((x) => {
    const cp = x.r.counterpartyAccountId ? A.get(x.r.counterpartyAccountId) : null;
    return cp != null && cp.type !== "debt";   // own non-liability destination
  });
  console.log(`\n  ⚠️ Cash Out rows whose destination is the user's OWN non-liability account:`);
  console.log(`     ${internalInCashOut.length} rows  ${money(internalInCashOut.reduce((a, x) => a + Math.abs(x.r.amount), 0))}`);

  // ── CREDITOR PRESENTATION PARITY (v2.6-TRUTH-9) ──────────────────────────
  bar("CREDITOR PRESENTATION — grouping is presentation only");
  const refs = new Map<string, CreditorAccountRef>(
    accounts.map((a) => [a.id, { id: a.id, name: a.name, type: a.type }]));
  const groups = groupDebtPaymentsByCreditor(cardRows as never, refs, (t) => Math.abs((t as never as { amount: number }).amount));
  const groupedIds = groups.flatMap((g) => g.transactionIds).sort();
  const cardIds = cardRows.map((r) => r.id).sort();
  const groupedSum = groups.reduce((s, g) => s + g.value, 0);
  const cardSum = cardRows.reduce((s, r) => s + Math.abs(r.amount), 0);
  console.log(`  groups: ${groups.length}`);
  for (const g of groups) {
    const kind = g.creditorAccountId ? "ACCOUNT_CERTAIN" : "unresolved bucket";
    console.log(`    ${g.label.padEnd(34)} ${String(g.count).padStart(4)} rows ${money(g.value).padStart(14)}   ${kind}`);
  }
  check("Σ(groups) === the card total", Math.abs(groupedSum - cardSum) < 0.005, `${groupedSum} vs ${cardSum}`);
  check("grouping changed NO membership", JSON.stringify(groupedIds) === JSON.stringify(cardIds),
    `${groupedIds.length} vs ${cardIds.length}`);
  check("no row appears in two groups", new Set(groupedIds).size === groupedIds.length);
  const named = groups.filter((g) => g.creditorAccountId);
  check("every named group is an owned LIABILITY account",
    named.every((g) => A.get(g.creditorAccountId!)?.type === "debt"),
    named.filter((g) => A.get(g.creditorAccountId!)?.type !== "debt").map((g) => g.label).join("; "));
  check("every named group's label IS its account's name",
    named.every((g) => g.label === A.get(g.creditorAccountId!)?.name));
  const bucket = groups.find((g) => g.id === UNRESOLVED_CREDITOR_KEY);
  const ambiguous = cardRows.filter((r) => attributeCreditor(r as never, refs).certainty !== "ACCOUNT_CERTAIN");
  console.log(`\n  rows whose creditor cannot be named: ${ambiguous.length}  ${money(ambiguous.reduce((s, r) => s + Math.abs(r.amount), 0))}`);
  check("every un-nameable row sits in the unresolved bucket",
    bucket != null && ambiguous.every((r) => bucket.transactionIds.includes(r.id)));
  check("the unresolved bucket contains NOTHING else",
    bucket == null || bucket.transactionIds.every((id) => ambiguous.some((r) => r.id === id)));
  check("the unresolved bucket sorts LAST", groups.length === 0 || groups[groups.length - 1].id === UNRESOLVED_CREDITOR_KEY);

  bar("FINGERPRINTS");
  const fp = (label: string, parts: string[]) =>
    console.log(`  ${label.padEnd(34)} ${createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16)}  (${parts.length})`);
  fp("debt-card event ids", cardRows.map((r) => r.transactionEventId ?? r.id).sort());
  fp("GROUPED event ids", groups.flatMap((g) => g.transactionIds)
    .map((id) => byId.get(id)?.transactionEventId ?? id).sort());
  fp("debt-card row ids", cardRows.map((r) => r.id).sort());
  fp("cash-out row ids", out.map((x) => x.r.id).sort());

  if (failures > 0) {
    console.error(`\n[AUDIT] FAILED — ${failures} presentation check(s) broken.\n`);
    await db.$disconnect(); process.exit(1);
  }
  console.log(`\n[AUDIT] PASSED — nothing was written.\n`);
  await db.$disconnect();
}
main().catch(async (e) => { console.error(e); await db.$disconnect(); process.exit(1); });
