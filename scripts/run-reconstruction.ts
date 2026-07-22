/**
 * scripts/run-reconstruction.ts
 *
 * One-time position reconstruction runner (Slice A4-3). For every account with
 * investment activity (an OBSERVED position or a canonical InvestmentEvent), runs
 * the backward-walk reconstruction and persists DERIVED PositionObservation rows
 * + a PositionReconstruction summary per position.
 *
 * Gated behind INVESTMENT_RECONSTRUCTION_ENABLED — with the flag absent the
 * runner writes nothing and this script reports "disabled" and exits 0 (so it is
 * safe to wire into any pipeline before dark writes are turned on). The one-time
 * run is idempotent: reruns regenerate only the DERIVED reconstruction rows.
 *
 *   INVESTMENT_RECONSTRUCTION_ENABLED=true npx tsx scripts/run-reconstruction.ts
 *   INVESTMENT_RECONSTRUCTION_ENABLED=true npx tsx scripts/run-reconstruction.ts --account <financialAccountId>
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { PrismaClient } from "@prisma/client";
import {
  reconstructAccount,
  investmentReconstructionEnabled,
} from "@/lib/investments/reconstruction-runner";

const db = new PrismaClient({ log: ["error"] });

function accountArg(): string | null {
  const i = process.argv.indexOf("--account");
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

async function accountsWithActivity(): Promise<string[]> {
  const [obs, events] = await Promise.all([
    db.positionObservation.findMany({ distinct: ["financialAccountId"], select: { financialAccountId: true } }),
    db.investmentEvent.findMany({ where: { deletedAt: null }, distinct: ["financialAccountId"], select: { financialAccountId: true } }),
  ]);
  return [...new Set([...obs, ...events].map((r) => r.financialAccountId))].sort();
}

async function main(): Promise<void> {
  console.log(`\n=== run-reconstruction ===`);
  if (!investmentReconstructionEnabled()) {
    console.log("INVESTMENT_RECONSTRUCTION_ENABLED is not 'true' — nothing written (dark by design).");
    console.log("Re-run with INVESTMENT_RECONSTRUCTION_ENABLED=true to persist.");
    return;
  }

  const only = accountArg();
  const accounts = only ? [only] : await accountsWithActivity();
  console.log(`Reconstructing ${accounts.length} account(s)${only ? ` (--account ${only})` : ""}.\n`);

  const now = new Date();
  const totals = { instruments: 0, complete: 0, partial: 0, failed: 0, conflicted: 0, derivedRows: 0 };
  for (const financialAccountId of accounts) {
    try {
      const m = await reconstructAccount({ financialAccountId, now, client: db });
      totals.instruments += m.instruments;
      totals.complete += m.complete;
      totals.partial += m.partial;
      totals.failed += m.failed;
      totals.conflicted += m.conflicted;
      totals.derivedRows += m.derivedRows;
      console.log(
        `  ${financialAccountId}: ${m.instruments} position(s) — ${m.complete} complete, ${m.partial} partial, ${m.failed} failed, ${m.conflicted} conflicted, ${m.derivedRows} derived row(s)`,
      );
    } catch (err) {
      console.error(`  ${financialAccountId}: FAILED — ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log(
    `\nTotal: ${totals.instruments} position(s) — ${totals.complete} complete, ${totals.partial} partial, ${totals.failed} failed, ${totals.conflicted} conflicted; ${totals.derivedRows} derived row(s) written.`,
  );
  console.log("Opening + Σ events = current + unexplained residual — residuals persisted, never zeroed.");
}

main()
  .catch((err) => { console.error("run-reconstruction crashed:", err); process.exitCode = 1; })
  .finally(() => db.$disconnect());
