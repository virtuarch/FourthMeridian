/**
 * scripts/repair-transfer-debt-payment.ts   (v2.7-P1)
 *
 * HISTORICAL REPAIR — depository legs the provider filed as a loan payment that
 * the transfer authority resolves to a transfer between the owner's own
 * accounts. DRY RUN BY DEFAULT. Runbook:
 * docs/plans/P1-REPAIR-PRODUCTION-RUNBOOK-2026-10-27.md
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs --env-file=.env.local \
 *     scripts/repair-transfer-debt-payment.ts [--env=<env>] [--space=<id>] [--expect=<n>] [--out=<report.json>]
 *
 *   # write, Preview / local:
 *   FM_PRODUCTION_DB_REF=<prod ref> npx tsx … scripts/repair-transfer-debt-payment.ts \
 *     --apply --env=preview --out=tmp/repair-tdp.preview.json [--expect=<n>]
 *
 *   # write, PRODUCTION — only under a separate, written owner authorization:
 *   FM_PRODUCTION_DB_REF=<prod ref> npx tsx … scripts/repair-transfer-debt-payment.ts \
 *     --apply --env=production --i-have-owner-approval=<ticket> --expect=<n from the dry run> \
 *     --out=tmp/repair-tdp.production.json
 *
 *   # rollback (dry run; add --apply + the same env flags to write):
 *   npx tsx … scripts/repair-transfer-debt-payment.ts --rollback=tmp/repair-tdp.production.restore.json --env=production
 *
 * Files written by an --out run (report.json):
 *   report.json          hashed ids — shareable
 *   report.summary.txt   the printed summary — shareable
 *   report.restore.json  APPLY only, 0600, created exclusively BEFORE the first
 *                        write: raw ids + full before/after. RESTRICTED (see
 *                        scripts/lib/repair-transfer-debt-payment.core.ts).
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
 * pass corrects it (or, when the provider flips the SAME transaction id to posted,
 * the ownership gate keeps the correction), while the pending row is tombstoned
 * by removed[]. No row is ever created, merged or deleted, so no duplicate can arise.
 *

 * ── What it writes ──────────────────────────────────────────────────────────
 *
 * flowType · category · classificationReason · classificationConfidence ·
 * flowAuthority → TRANSFER_AUTHORITY · classifierVersion → NULL
 * (foreignFlowOwnershipFields; the signatures are registered in
 * scripts/backfill-flow-authority.ts). categorySource is NOT written (it is only
 * read, so a human's category wins). NEVER: amount, date, flowDirection,
 * counterpartyAccountId, pending, deletedAt, provider PFC columns, balances.
 * ONE interactive transaction, all-or-nothing; each row guarded by its full
 * BEFORE shape. Idempotent: a second run proposes 0.
 *
 * ── Environment gate ────────────────────────────────────────────────────────
 *
 * scripts/lib/repair-env-guard.ts. --apply requires --env and a connection that
 * proves it: local = loopback; preview = a Supabase project that is NOT
 * FM_PRODUCTION_DB_REF; production = the project that IS FM_PRODUCTION_DB_REF,
 * plus --i-have-owner-approval=<ticket> and --expect=<n> (a mismatch writes
 * nothing). Every apply also needs --out (the restore file is written before
 * the first write; an existing restore file is never overwritten). No URL, host
 * or secret is ever printed.
 *
 * ── Expected Production candidate set (documentation only) ──────────────────
 *
 * The 2026-10-27 audit (docs/plans/P1-AMEX-TRANSFER-CLASSIFICATION-AUDIT-2026-10-27.md)
 * and the read-only reconstruction (docs/plans/P1-PRODUCTION-REPAIR-CANDIDATES-2026-10-27.md)
 * measured 16 Chase-checking legs, −$24,372.67, 2025-09-11 → 2026-10-26: 13 posted
 * (−22,000.00) and 3 pending (−2,372.67); 14 paired to the Amex HYSA, 1 to Amex
 * checking, 1 unpaired (→ the 0.2 unresolved signature, needsClassification). A
 * fresh dry run immediately before any apply is still required: syncs change the
 * set. Money totals do not move: an unattested DEBT_PAYMENT cash leg and a
 * TRANSFER leg resolve identically on the liquidity axis.
 */


import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { decideRepairEnvGuard, redactConnectionDetails, restoreLocationRefusal } from "./lib/repair-env-guard";
import { runTransferDebtPaymentRepair, summarizeRepairReport, type RestoreFile } from "./lib/repair-transfer-debt-payment.core";
import {
  parseRestoreFile,
  runTransferDebtPaymentRollback,
  summarizeRollbackReport,
} from "./lib/repair-transfer-debt-payment.rollback";

const KNOWN_FLAGS = new Set(["apply", "env", "space", "out", "expect", "i-have-owner-approval", "rollback"]);
const ROOT = path.resolve(__dirname, "..");

function flag(name: string): string | null {
  const hit = process.argv.slice(2).find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return null;
  const eq = hit.indexOf("=");
  return eq === -1 ? "" : hit.slice(eq + 1);
}

function refuse(reasons: string[], code = 2): never {
  console.error("\n  REFUSED — nothing was read or written.");
  for (const r of reasons) console.error(`    · ${r}`);
  console.error("");
  process.exit(code);
}

const restorePathOf = (out: string) => out.replace(/\.json$/i, "") + ".restore.json";
const summaryPathOf = (out: string) => out.replace(/\.json$/i, "") + ".summary.txt";

async function main(): Promise<void> {
  const unknown = process.argv.slice(2).filter((a) => !KNOWN_FLAGS.has(a.replace(/^--/, "").split("=")[0]) || !a.startsWith("--"));
  if (unknown.length) refuse([`unknown argument(s): ${unknown.map((a) => a.split("=")[0]).join(", ")} — refusing rather than guessing.`]);

  const apply = process.argv.includes("--apply");
  const spaceId = flag("space") || null;
  const out = flag("out") || null;
  const rollbackPath = flag("rollback");
  if (rollbackPath === "") refuse(["--rollback needs the restore file: --rollback=<report>.restore.json"]);
  if (rollbackPath && spaceId) refuse(["--space does not apply to --rollback (the restore file names its rows)."]);

  const gate = decideRepairEnvGuard({
    apply,
    envFlag: flag("env"),
    databaseUrl: process.env.DATABASE_URL,
    directUrl: process.env.DIRECT_URL,
    productionRef: process.env.FM_PRODUCTION_DB_REF,
    vercelEnv: process.env.VERCEL_ENV,
    env: process.env,
    approvalTicket: flag("i-have-owner-approval"),
    expect: flag("expect"),
  });
  if (!gate.ok) refuse(gate.reasons);

  if (apply) {
    if (!out) refuse(["--apply requires --out=<report.json>: the restore file is written beside it before the first write."]);
    const loc = restoreLocationRefusal(out, ROOT);
    if (loc) refuse([loc]);
    if (!rollbackPath && existsSync(restorePathOf(out))) {
      refuse(["a restore file already exists for this --out — it may be the only rollback source of an earlier apply. Choose a new --out."]);
    }
  }

  // Read and verify the restore file BEFORE any database contact.
  let restore: RestoreFile | null = null;
  if (rollbackPath) {
    try {
      restore = parseRestoreFile(JSON.parse(readFileSync(rollbackPath, "utf8")));
    } catch (e) {
      refuse([`restore file rejected: ${e instanceof Error ? e.message : String(e)}`]);
    }
  }

  const context = { env: gate.env, targetHash: gate.targetHash, approvalTicket: gate.approvalTicket };

  // Imported only after the gate: constructing the client is the first contact
  // with any database.
  const { db } = await import("@/lib/db");
  let summary: string;
  let json: unknown;
  let exitCode = 0;
  if (restore) {
    const r = await runTransferDebtPaymentRollback(db as never, restore, { apply, expect: gate.expect, context });
    summary = summarizeRollbackReport(r, gate.env);
    json = r;
    if (r.outcome === "REFUSED_EXPECT_MISMATCH" || r.outcome === "ABORTED_CONFLICT" || (r.expect && !r.expect.matched)) exitCode = 3;
  } else {
    let firstPersist = true;
    const persistRestore = (file: RestoreFile) => {
      const p = restorePathOf(out as string);
      mkdirSync(path.dirname(p), { recursive: true });
      // First write is EXCLUSIVE ('wx'): never clobber an earlier run's rollback source.
      writeFileSync(p, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600, flag: firstPersist ? "wx" : "w" });
      chmodSync(p, 0o600);
      firstPersist = false;
    };
    const r = await runTransferDebtPaymentRepair(db as never, {
      apply, spaceId, expect: gate.expect, context, ...(apply ? { persistRestore } : {}),
    });
    summary = summarizeRepairReport(r, gate.env);
    json = r;
    if (r.outcome === "REFUSED_EXPECT_MISMATCH" || r.outcome === "ABORTED_CONFLICT" || (r.expect && !r.expect.matched)) exitCode = 3;
    if (apply && r.outcome === "APPLIED") console.log(`  restore (RESTRICTED, 0600): ${restorePathOf(out as string)}`);
  }
  console.log(`\n${summary}\n`);

  if (out) {
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(json, null, 2)}\n`);
    writeFileSync(summaryPathOf(out), `${summary}\n`);
    console.log(`  report: ${out}\n  summary: ${summaryPathOf(out)}\n`);
  }
  await db.$disconnect();
  process.exit(exitCode);
}

main().catch((e) => {
  console.error(redactConnectionDetails(e instanceof Error ? e.message : String(e), [process.env.FM_PRODUCTION_DB_REF]));
  process.exit(1);
});
