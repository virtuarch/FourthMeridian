/**
 * scripts/audit-debt-payment-attestation.ts
 *
 * v2.6-DEBT-1 — every Debt Payment is positively attested. READ-ONLY.
 *
 *   npx tsx --env-file=.env.local scripts/audit-debt-payment-attestation.ts
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 *
 *   A row belongs in Debt Payments only when the transfer authority POSITIVELY
 *   attests the destination:
 *
 *     · the counterparty is an OWNED LIABILITY account, or
 *     · the destination TYPE is proven to be a liability
 *       (transfer maturity = DEBT_PAYMENT)
 *
 *   Silence, ambiguity, provider categorisation, descriptor text, institution
 *   names and "nothing contradicted it" must NEVER admit a row.
 *
 * ── What was wrong ──────────────────────────────────────────────────────────
 *
 * `classifyLiquidity`'s DEBT_PAYMENT branch diverted a row only when the
 * destination was KNOWN and NOT a liability. An UNKNOWN destination fell through
 * and was admitted — at confidence 1. That is admission by absence of
 * contradiction: the row was counted because nothing had disproved it, which is
 * not evidence. Three live rows ($6,500) entered the Debt Payments total on that
 * basis while the transfer authority had explicitly returned UNRESOLVED_TRANSFER
 * / CANDIDATES_SPAN_TYPES for them — "several possible destinations of different
 * kinds". The authority said "I do not know"; the liquidity axis heard "yes".
 *
 * ⚠️ Attestation is about MEMBERSHIP, not about naming the creditor. 15 rows are
 * attested at the TYPE level (destination proven to be a liability) without a
 * nameable account; they are real debt payments and stay counted, appearing
 * under "Debt account not determined". Naming is a separate axis and can never
 * remove a payment from the total.
 */

import { createHash } from "node:crypto";

import { db } from "@/lib/db";
import { bankingTransactionWhere } from "@/lib/data/banking-population";
import { serializeTransactionRow } from "@/lib/transactions/serialize";
import { resolveTransferAssessments } from "@/lib/transactions/transfer-resolution";
import { classifyLiquidity, tierResolver, type LiquidityTx } from "@/lib/transactions/liquidity";
import { isDebtPaymentAttested } from "@/lib/transactions/debt-payment-authority";

const bar = (s: string) => console.log(`\n${"═".repeat(78)}\n${s}\n${"═".repeat(78)}`);
const money = (n: number) => `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fp = (parts: readonly string[]) =>
  createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16);

const breaches: string[] = [];
function invariant(held: boolean, statement: string): boolean {
  if (!held) breaches.push(statement);
  return held;
}

async function main(): Promise<void> {
  console.log("\n[AUDIT] Debt-payment attestation — membership requires positive evidence. READ-ONLY\n");

  const spaces = await db.space.findMany({ select: { id: true, name: true, _count: { select: { accountLinks: true } } } });
  const counts = await Promise.all(spaces.map(async (s) => ({
    ...s, n: await db.transaction.count({ where: bankingTransactionWhere(s.id) }),
  })));
  const space = counts.sort((a, b) => b.n - a.n)[0];
  if (!space || space.n === 0) { console.log("  (no Space carries banking rows)"); return; }
  console.log(`  Space: ${space.name}  (${space.n} banking rows)\n`);

  const accounts = await db.financialAccount.findMany({ select: { id: true, type: true, name: true } });
  const A = new Map(accounts.map((a) => [a.id, a]));
  const liqCtx = tierResolver(accounts.map((a) => ({ id: a.id, type: a.type })));

  const raw = await db.transaction.findMany({
    where: bankingTransactionWhere(space.id),
    include: { resolvedMerchant: { select: { displayName: true, logoUrl: true } } },
  });
  const assess = await resolveTransferAssessments(raw as never, { spaceId: space.id });
  const rows = raw.map((r) => ({
    ...serializeTransactionRow({ ...r, accountType: A.get(r.financialAccountId ?? "")?.type ?? null }),
    financialAccountId: r.financialAccountId,
    counterpartyAccountId: r.counterpartyAccountId ?? assess.get(r.id)?.counterpartyAccountId ?? null,
    transferMaturity: assess.get(r.id)?.maturity ?? null,
  })) as (LiquidityTx & { transferMaturity: string | null; financialAccountId: string | null })[];

  // ── 1. Membership, and the evidence behind each row ───────────────────────
  bar("1. DEBT PAYMENTS — membership and its evidence");
  const counted = rows.filter((r) => {
    const c = classifyLiquidity(r, liqCtx);
    return c.effect === "CASH_OUT" && c.reason === "DEBT_PAYMENT";
  });
  const total = counted.reduce((s, r) => s + Math.abs(r.amount), 0);
  console.log(`  counted as Debt Payments : ${counted.length}   total ${money(total)}`);

  /** Positive attestation, evaluated the same way the authority evaluates it. */
  const evidenceOf = (r: (typeof rows)[number]) => {
    const cpTier = r.counterpartyAccountId ? liqCtx.tierOf(r.counterpartyAccountId) : "unknown";
    return {
      ownedLiability: cpTier === "liability",
      typeProven: r.transferMaturity === "DEBT_PAYMENT",
      attested: isDebtPaymentAttested({
        counterpartyTier: cpTier,
        transferMaturity: r.transferMaturity,
      }),
      cpTier,
    };
  };

  const byEvidence = new Map<string, { n: number; sum: number }>();
  for (const r of counted) {
    const e = evidenceOf(r);
    const k = e.ownedLiability ? "OWNED LIABILITY counterparty (nameable)"
      : e.typeProven ? "destination TYPE proven liability (account unknowable)"
      : `UNATTESTED — maturity=${r.transferMaturity ?? "none"}, counterparty tier=${e.cpTier}`;
    const g = byEvidence.get(k) ?? { n: 0, sum: 0 };
    g.n++; g.sum += Math.abs(r.amount); byEvidence.set(k, g);
  }
  for (const [k, v] of [...byEvidence].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`    ${String(v.n).padStart(4)}  ${money(v.sum).padStart(14)}  ${k}`);
  }

  // ── 2. The failure mode, enumerated ───────────────────────────────────────
  bar("2. ADMITTED WITHOUT POSITIVE EVIDENCE");
  const unattested = counted.filter((r) => !evidenceOf(r).attested);
  const unattestedTotal = unattested.reduce((s, r) => s + Math.abs(r.amount), 0);
  console.log(`  rows counted with NO positive attestation : ${unattested.length}   ${money(unattestedTotal)}`);
  for (const r of unattested) {
    const own = r.financialAccountId ? A.get(r.financialAccountId) : undefined;
    console.log(`\n    ${r.id}`);
    console.log(`      ${String(r.date).slice(0, 10)}  ${money(r.amount)}  on ${own?.name} (${own?.type})`);
    console.log(`      descriptor           "${(r.merchant ?? "").slice(0, 52)}"`);
    console.log(`      stored flowType      ${r.flowType}   ← a PROVIDER-derived category, not evidence`);
    console.log(`      transfer maturity    ${r.transferMaturity ?? "—"}   ← the authority's actual verdict`);
    console.log(`      counterparty         ${r.counterpartyAccountId ?? "none"} (tier ${evidenceOf(r).cpTier})`);
    console.log(`      → admitted ONLY because nothing contradicted it`);
  }

  console.log(
    `\n  ${invariant(unattested.length === 0,
      `every counted debt payment is positively attested (${unattested.length} admitted on absence of contradiction, ${money(unattestedTotal)})`)
      ? "✓ every counted debt payment carries positive destination evidence"
      : "✗ rows are counted because nothing disproved them"}`,
  );

  // ── 3. Nothing else shares the failure mode ───────────────────────────────
  bar("3. THE SAME SHAPE ELSEWHERE");
  // A stored DEBT_PAYMENT on a liquid account with no attestation, whether or not
  // it is currently counted — so a change in the counting rule cannot hide one.
  const shaped = rows.filter((r) => {
    const own = r.financialAccountId ? liqCtx.tierOf(r.financialAccountId) : "unknown";
    return r.flowType === "DEBT_PAYMENT" && own === "liquid" && !evidenceOf(r).attested;
  });
  console.log(`  stored DEBT_PAYMENT rows on a liquid account lacking attestation : ${shaped.length}`);
  for (const r of shaped) {
    console.log(`    ${r.id}  ${money(r.amount)}  maturity=${r.transferMaturity ?? "—"}`);
  }

  // ── 4. Fingerprints ───────────────────────────────────────────────────────
  bar("4. FINGERPRINTS");
  const ids = counted.map((r) => r.id).sort();
  console.log(`  debt-payment membership  ${fp(ids)}  (${ids.length} rows, ${money(total)})`);
  const attestedIds = counted.filter((r) => evidenceOf(r).attested).map((r) => r.id).sort();
  console.log(`  attested subset          ${fp(attestedIds)}  (${attestedIds.length} rows)`);

  bar("VERDICT");
  if (breaches.length > 0) {
    console.error(`  ✗ ${breaches.length} invariant(s) breached:`);
    for (const b of breaches) console.error(`      · ${b}`);
    console.error(
      "\n[AUDIT] FAILED — Debt Payments is admitting rows on absence of contradiction.\n" +
      "Membership requires POSITIVE destination evidence: an owned liability counterparty,\n" +
      "or a transfer maturity of DEBT_PAYMENT. Silence is not attestation.\n",
    );
    process.exitCode = 1;
    return;
  }
  console.log("\n[AUDIT] PASSED — every debt payment is positively attested. Nothing was written.\n");
}

main()
  .catch((err) => { console.error("audit-debt-payment-attestation failed:", err); process.exitCode = 1; })
  .finally(async () => { await db.$disconnect(); });
