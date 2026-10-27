/**
 * scripts/repair-transfer-debt-payment.ts   (v2.7-P1)
 *
 * HISTORICAL REPAIR — depository legs the provider filed as a loan payment that
 * the transfer authority resolves to a transfer between the owner's own
 * accounts. DRY RUN BY DEFAULT.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs --env-file=.env.local \
 *     scripts/repair-transfer-debt-payment.ts [--space=<id>] [--out=<report.json>]
 *
 *   # write (never Production):
 *   FM_PRODUCTION_DB_REF=<prod project ref> npx tsx … scripts/repair-transfer-debt-payment.ts \
 *     --apply --env=preview --out=tmp/repair-transfer-debt-payment.preview.json
 *
 * ── What it selects ─────────────────────────────────────────────────────────
 *
 * EXACTLY the rule the Plaid sync now applies after every completed sync
 * (lib/transactions/transfer-debt-payment-correction.ts, planned by
 * lib/transactions/transfer-debt-payment-correction-write.ts):
 *   · own account depository (checking / savings), row live;
 *   · stored DEBT_PAYMENT written by the CLASSIFIER from PFC LOAN_PAYMENTS or the
 *     `Payment` category — never a USER_OVERRIDE / USER_RULE category;
 *   · the transfer authority (resolveTransferAssessments — mutuality guard,
 *     cash veto, admission, identifier tier) puts the destination at
 *     PROVIDER_LINKED / ACCOUNT_CERTAIN / ACCOUNT_CERTAIN_LEG_AMBIGUOUS /
 *     TYPE_CERTAIN_ACCOUNT_AMBIGUOUS with a transfer-leaf maturity
 *       → TRANSFER · Transfer · ACCOUNT_TYPE_CONTEXT · 1.0;
 *   · TYPE_AMBIGUOUS, or unpaired with no liability evidence
 *       → TRANSFER · Transfer · AMBIGUOUS_UNKNOWN · 0.2 (surfaces needsClassification);
 *   · a liability destination, a liability-naming PFC detailed category, a
 *     cross-owner boundary, or a cash movement → untouched.
 * No institution name, merchant or descriptor is read to SELECT a row.
 *
 * ── Pending rows ────────────────────────────────────────────────────────────
 *
 * A live PENDING row whose posted twin (pendingTransactionRef) is live is NOT
 * rewritten: the posted row carries the correction and the pending observation
 * retires through the provider's removed[] (or is already superseded). Such rows
 * are listed under `retiringPending` in the report. A live pending row with NO
 * posted twin is the current observation of the movement and IS corrected; when
 * it later posts, the posted row is born from the classifier and the sync-time
 * pass corrects it, while the pending row is tombstoned by removed[]. No row is
 * ever created, merged or deleted, so no duplicate can arise.
 *
 * ── What it writes ──────────────────────────────────────────────────────────
 *
 * flowType · category · classificationReason · classificationConfidence ·
 * categorySource → NULL (the provider no longer chose the category) ·
 * flowAuthority → TRANSFER_AUTHORITY · classifierVersion → NULL
 * (foreignFlowOwnershipFields; the signatures are registered in
 * scripts/backfill-flow-authority.ts). NEVER: amount, date, flowDirection,
 * counterpartyAccountId, pending, deletedAt, provider PFC columns, balances.
 * One database transaction; each row guarded by its BEFORE shape. Idempotent: a
 * second run proposes 0.
 *
 * ── Environment gate ────────────────────────────────────────────────────────
 *
 * --apply requires --env=preview|local AND a connection that proves it is that
 * environment and not Production (scripts/lib/repair-env-guard.ts). Not
 * authorized for Production. No URL, host or secret is ever printed.
 *
 * ── Expected Production candidate set (documentation only) ──────────────────
 *
 * The 2026-10-27 audit (docs/plans/P1-AMEX-TRANSFER-CLASSIFICATION-AUDIT-2026-10-27.md)
 * measured 16 Chase-checking legs, −$24,372.67, 2025-09-11 → 2026-10-26: 13 posted
 * (−22,000.00) and 3 pending (−2,372.67); 14 paired to the Amex HYSA, 1 to Amex
 * checking, 1 unpaired. A pending one with a live posted twin will appear under
 * `retiringPending`, not as a write. Money totals do not move: an unattested
 * DEBT_PAYMENT cash leg and a TRANSFER leg resolve identically on the liquidity
 * axis.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { decideRepairEnvGuard } from "./lib/repair-env-guard";
import { runTransferDebtPaymentRepair, summarizeRepairReport } from "./lib/repair-transfer-debt-payment.core";

function flag(name: string): string | null {
  const hit = process.argv.slice(2).find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return null;
  const eq = hit.indexOf("=");
  return eq === -1 ? "" : hit.slice(eq + 1);
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const envFlag = flag("env");
  const spaceId = flag("space") || null;
  const out = flag("out") || null;

  const gate = decideRepairEnvGuard({
    apply,
    envFlag,
    databaseUrl: process.env.DATABASE_URL,
    directUrl: process.env.DIRECT_URL,
    productionRef: process.env.FM_PRODUCTION_DB_REF,
    vercelEnv: process.env.VERCEL_ENV,
    env: process.env,
  });
  if (!gate.ok) {
    console.error("\n  REFUSED — nothing was read or written.");
    for (const r of gate.reasons) console.error(`    · ${r}`);
    console.error("");
    process.exit(2);
  }

  // Imported only after the gate: constructing the client is the first contact
  // with any database.
  const { db } = await import("@/lib/db");
  const report = await runTransferDebtPaymentRepair(db as never, { apply, spaceId });
  const summary = summarizeRepairReport(report, gate.env);
  console.log(`\n${summary}\n`);

  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
    const txt = out.replace(/\.json$/i, "") + ".summary.txt";
    writeFileSync(txt, `${summary}\n`);
    console.log(`  report: ${out}\n  summary: ${txt}\n`);
  }
  await db.$disconnect();
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
