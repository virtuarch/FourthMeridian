/**
 * scripts/audit-unattested-debt-payments.ts
 *
 * READ-ONLY investigation: are the Debt Payments card's rows WITHOUT a
 * structurally resolved counterparty legitimately debt payments?
 *
 * It reports every such row with the full evidence the canonical authorities
 * hold, buckets them, and quantifies each bucket. It changes nothing and
 * recommends nothing in code.
 *
 * Run: npx tsx --env-file=.env.local scripts/audit-unattested-debt-payments.ts
 */

import { db } from "@/lib/db";
import { accountDisplayName, ACCOUNT_NAME_SELECT } from "@/lib/accounts/display-identity";
import { serializeTransactionRow } from "@/lib/transactions/serialize";
import { resolveTransferAssessments } from "@/lib/transactions/transfer-resolution";
import { classifyLiquidity, tierResolver, type LiquidityTx } from "@/lib/transactions/liquidity";
import { selectDebtPaymentCashLegs } from "@/lib/transactions/debt-payment-authority";
import type { Transaction } from "@/types";

const bar = (s: string) => console.log(`\n${"═".repeat(90)}\n${s}\n${"═".repeat(90)}`);
const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function main() {
  console.log(`\n[AUDIT] Unattested debt payments — READ-ONLY\n`);

  const accounts = await db.financialAccount.findMany({
    select: { id: true, type: true, institution: true, mask: true, ...ACCOUNT_NAME_SELECT },
  });
  // v2.6-TRUTH-10 — the canonical identity, so this reads what the app renders.
  const A = new Map(accounts.map((a) => [a.id, { ...a, name: accountDisplayName(a) }]));
  const liqCtx = tierResolver(accounts.map((a) => ({ id: a.id, type: a.type })));
  const liabilities = accounts.filter((a) => a.type === "debt");

  const space = (await db.space.findFirst({ where: { name: "Chris' Space" }, select: { id: true } }))!;
  const raw = await db.transaction.findMany({
    where: {
      deletedAt: null, flowType: { not: "INVESTMENT" },
      financialAccount: { deletedAt: null, spaceAccountLinks: { some: { spaceId: space.id, status: "ACTIVE" } } },
    },
    include: { resolvedMerchant: { select: { displayName: true, logoUrl: true } } },
    orderBy: { economicDate: { sort: "desc", nulls: "last" } },
  });
  const assess = await resolveTransferAssessments(raw as never, { spaceId: space.id });

  const rows = raw.map((r) => ({
    ...serializeTransactionRow({ ...r, accountType: A.get(r.financialAccountId ?? "")?.type ?? null }),
    counterpartyAccountId: r.counterpartyAccountId ?? assess.get(r.id)?.counterpartyAccountId ?? null,
    persistedCounterpartyId: r.counterpartyAccountId,
    financialAccountId: r.financialAccountId,
    transactionEventId: r.transactionEventId,
    pfcPrimary: r.pfcPrimary, pfcDetailed: r.pfcDetailed,
    classificationReason: r.classificationReason,
    a: assess.get(r.id) ?? null,
  })) as never as (Transaction & {
    financialAccountId: string | null; persistedCounterpartyId: string | null;
    transactionEventId: string | null; pfcPrimary: string | null; pfcDetailed: string | null;
    classificationReason: string | null;
    a: null | {
      status: string; reason: string; maturity: string; evidenceLevel: string;
      destinationAccountType: string | null; counterpartyAccountId: string | null;
      persistableCounterparty: boolean;
    };
  })[];

  const carded = selectDebtPaymentCashLegs(rows as unknown as LiquidityTx[], liqCtx).counted as unknown as typeof rows;
  const unattested = carded.filter((r) => {
    const cp = r.counterpartyAccountId ? A.get(r.counterpartyAccountId) : null;
    return cp?.type !== "debt";
  });

  console.log(`  liabilities owned: ${liabilities.map((l) => `${l.name} (••${l.mask ?? "?"}) · ${l.institution}`).join(" · ")}`);
  console.log(`  carded rows: ${carded.length}   of which without a resolved LIABILITY counterparty: ${unattested.length}`);
  console.log(`  amount at stake: ${money(unattested.reduce((s, r) => s + Math.abs(r.amount), 0))}`);

  bar("EVERY UNATTESTED ROW, IN FULL");
  type Bucket = "A" | "B" | "C" | "D";
  const bucketOf = new Map<string, { b: Bucket; why: string }>();

  for (const r of [...unattested].sort((x, y) => Math.abs(y.amount) - Math.abs(x.amount))) {
    const own = A.get(r.financialAccountId ?? "");
    const a = r.a;
    const c = classifyLiquidity(r as unknown as LiquidityTx, liqCtx);

    // ── Bucketing, from evidence only ──────────────────────────────────────
    let b: Bucket, why: string;
    if (a?.destinationAccountType === "debt") {
      b = "A"; why = "the authority proves the destination TYPE is a liability; only WHICH card is unknowable";
    } else if (a?.maturity === "DEBT_PAYMENT") {
      b = "A"; why = "the authority's maturity is DEBT_PAYMENT on its own evidence";
    } else if (a && ["SAVINGS_TRANSFER", "CASH_TRANSFER", "INTERNAL_TRANSFER", "INVESTMENT_TRANSFER"].includes(a.maturity)) {
      b = "D"; why = `the authority CONTRADICTS the card: maturity ${a.maturity}`;
    } else if (!a) {
      b = "B"; why = "no assessment ran (not a resolver target); only the provider's category supports it";
    } else if (["TYPE_AMBIGUOUS", "UNRESOLVED_TRANSFER"].includes(a.evidenceLevel) || a.maturity === "UNRESOLVED_TRANSFER") {
      b = "C"; why = `the authority resolves nothing above "a movement happened" (${a.evidenceLevel})`;
    } else {
      b = "B"; why = `authority level ${a.evidenceLevel}, maturity ${a.maturity} — no liability destination established`;
    }
    bucketOf.set(r.id, { b, why });

    console.log(`\n  ── [${b}] ${r.id}`);
    console.log(`     event                ${r.transactionEventId}`);
    console.log(`     account              ${own?.name} (${own?.type}) · ${own?.institution} ••${own?.mask ?? "?"}`);
    console.log(`     amount / date        ${money(r.amount)}  ${String(r.date).slice(0, 10)}`);
    console.log(`     descriptor           ${(r.merchant ?? "").slice(0, 62)}`);
    console.log(`     provider category    ${r.pfcPrimary ?? "—"} / ${r.pfcDetailed ?? "—"}   via ${r.classificationReason ?? "—"}`);
    console.log(`     stored flowType      ${r.flowType}`);
    console.log(`     transfer maturity    ${a?.maturity ?? "(not assessed)"}`);
    console.log(`     evidence level       ${a?.evidenceLevel ?? "(not assessed)"}`);
    console.log(`     destination evidence ${a?.destinationAccountType ? `TYPE = ${a.destinationAccountType}` : "none"}`);
    console.log(`     match status/reason  ${a?.status ?? "—"} / ${a?.reason ?? "—"}`);
    console.log(`     counterparty unresolved because: ${
      !a ? "the resolver never targeted it" :
      a.reason === "TYPE_CERTAIN_ACCOUNT_AMBIGUOUS" ? "several owned accounts qualify and they share one TYPE — the account is not a fact" :
      a.reason === "NOT_MUTUALLY_UNIQUE" ? "a candidate leg exists but that leg has rivals — pairing is not mutually unique" :
      a.reason === "AMBIGUOUS_MULTIPLE_ACCOUNTS" ? "candidates span more than one account" :
      a.reason === "NO_CANDIDATE" ? "no opposite leg matched in window" : a.reason}`);
    console.log(`     DEBT_PAYMENT asserted by: ${
      a?.destinationAccountType === "debt" ? "the AUTHORITY (destination type is a liability)" :
      a?.maturity === "DEBT_PAYMENT" ? "the AUTHORITY (maturity)" :
      "the PROVIDER's category alone"}`);
    console.log(`     liquidity            ${c.effect} / ${c.reason}`);
    console.log(`     → ${why}`);
  }

  bar("BUCKETS");
  const tally = new Map<Bucket, { n: number; sum: number }>();
  for (const r of unattested) {
    const b = bucketOf.get(r.id)!.b;
    const g = tally.get(b) ?? { n: 0, sum: 0 };
    g.n++; g.sum += Math.abs(r.amount); tally.set(b, g);
  }
  const LABEL: Record<Bucket, string> = {
    A: "A — structurally proven debt payment, funding/destination account unknowable",
    B: "B — supported only by provider evidence",
    C: "C — ambiguous; should not remain DEBT_PAYMENT",
    D: "D — genuine bug (authority contradicts the card)",
  };
  for (const k of ["A", "B", "C", "D"] as Bucket[]) {
    const g = tally.get(k) ?? { n: 0, sum: 0 };
    console.log(`  ${LABEL[k].padEnd(72)} ${String(g.n).padStart(3)} rows  ${money(g.sum).padStart(13)}`);
  }

  bar("WHAT EACH CANDIDATE RULE WOULD COUNT");
  const total = (rs: typeof carded) => rs.reduce((s, r) => s + Math.abs(r.amount), 0);
  const structural = carded.filter((r) => A.get(r.counterpartyAccountId ?? "")?.type === "debt");
  const structuralOrAuthority = carded.filter((r) => {
    const cp = A.get(r.counterpartyAccountId ?? "");
    return cp?.type === "debt" || r.a?.destinationAccountType === "debt" || r.a?.maturity === "DEBT_PAYMENT";
  });
  console.log(`  1. structural destination certainty only   ${String(structural.length).padStart(4)} rows  ${money(total(structural)).padStart(14)}`);
  console.log(`  2. structural OR authority attestation     ${String(structuralOrAuthority.length).padStart(4)} rows  ${money(total(structuralOrAuthority)).padStart(14)}`);
  console.log(`  3. the current rule (uncontradicted)       ${String(carded.length).padStart(4)} rows  ${money(total(carded)).padStart(14)}`);
  const droppedBy1 = carded.filter((r) => !structural.includes(r));
  console.log(`\n  rule 1 would DROP ${droppedBy1.length} rows (${money(total(droppedBy1))}) — bucketed:`);
  const d1 = new Map<Bucket, number>();
  for (const r of droppedBy1) { const b = bucketOf.get(r.id)?.b ?? "B"; d1.set(b, (d1.get(b) ?? 0) + 1); }
  for (const [k, n] of [...d1].sort()) console.log(`      ${k}: ${n}`);

  console.log(`\n[AUDIT] complete — nothing was written.\n`);
  await db.$disconnect();
}
main().catch(async (e) => { console.error(e); await db.$disconnect(); process.exit(1); });
