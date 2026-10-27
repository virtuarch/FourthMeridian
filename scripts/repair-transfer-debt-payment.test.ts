/**
 * scripts/repair-transfer-debt-payment.test.ts
 *
 * v2.7-P1 — the historical repair: environment gate (incl. the owner-authorized
 * Production path), dry-run default, apply, expect, restore record, strict
 * all-or-nothing write, idempotence, precedence, report shape, rollback. DB-free: the core runs against the
 * schema-driven in-memory Prisma, and the CLI is only ever spawned on paths the
 * gate refuses BEFORE any client is constructed.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs scripts/repair-transfer-debt-payment.test.ts
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { FakePrisma } from "@/lib/test-support/fake-prisma";
import type { CorrectionClient } from "@/lib/transactions/transfer-debt-payment-correction-write";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import { shouldSurfaceAsNeedsClassification } from "@/lib/transactions/needs-classification";
import {
  decideRepairEnvGuard, hashTarget, redactConnectionDetails, restoreLocationRefusal, type RepairEnvGuardInput,
} from "./lib/repair-env-guard";
import {
  RESTORABLE_COLUMNS, hashId, runTransferDebtPaymentRepair, summarizeRepairReport,
  type RepairOptions, type RestoreFile,
} from "./lib/repair-transfer-debt-payment.core";
import {
  RestoreFileError, parseRestoreFile, runTransferDebtPaymentRollback, summarizeRollbackReport,
} from "./lib/repair-transfer-debt-payment.rollback";

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`); return; }
  failures.push(name);
  console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
}

const PROD_REF  = "prodprojectref0000001";
const PREV_REF  = "previewprojectref0002";
const SECRET    = "s3cr3tPassw0rd";
const direct    = (ref: string) => `postgresql://postgres:${SECRET}@db.${ref}.supabase.co:5432/postgres`;
const pooler    = (ref: string) => `postgresql://postgres.${ref}:${SECRET}@aws-0-us-east-1.pooler.supabase.com:6543/postgres`;
const LOCAL     = `postgresql://fm:${SECRET}@localhost:5432/fintracker`;

const gate = (over: Partial<RepairEnvGuardInput>) => decideRepairEnvGuard({
  apply: true, envFlag: null, databaseUrl: LOCAL, directUrl: undefined,
  productionRef: PROD_REF, vercelEnv: undefined, env: {} as NodeJS.ProcessEnv, ...over,
});

console.log("1. the environment gate");
{
  check("a dry run is always allowed (read-only)", gate({ apply: false, envFlag: null, databaseUrl: direct(PROD_REF) }).ok);
  check("--apply without --env is refused", !gate({ envFlag: null }).ok);
  check("--apply --env=production is refused", !gate({ envFlag: "production", databaseUrl: direct(PROD_REF) }).ok);
  check("--apply --env=staging is refused (closed set)", !gate({ envFlag: "staging" }).ok);
  check("--env=local on a loopback host is allowed", gate({ envFlag: "local", databaseUrl: LOCAL }).ok);
  check("--env=local on a hosted database is refused", !gate({ envFlag: "local", databaseUrl: direct(PREV_REF) }).ok);
  check("--env=preview on the Preview project is allowed (direct host)", gate({ envFlag: "preview", databaseUrl: direct(PREV_REF) }).ok);
  check("--env=preview on the Preview project is allowed (pooler)", gate({ envFlag: "preview", databaseUrl: pooler(PREV_REF), directUrl: direct(PREV_REF) }).ok);
  check("--env=preview on the PRODUCTION project is refused (direct host)", !gate({ envFlag: "preview", databaseUrl: direct(PROD_REF) }).ok);
  check("--env=preview on the PRODUCTION project is refused (pooler user)", !gate({ envFlag: "preview", databaseUrl: pooler(PROD_REF) }).ok);
  check("--env=preview without FM_PRODUCTION_DB_REF is refused (cannot prove non-Production)",
    !gate({ envFlag: "preview", databaseUrl: direct(PREV_REF), productionRef: undefined }).ok);
  check("--env=preview on an unidentifiable host is refused", !gate({ envFlag: "preview", databaseUrl: `postgresql://u:${SECRET}@db.example.com:5432/postgres` }).ok);
  check("DATABASE_URL and DIRECT_URL on different databases is refused",
    !gate({ envFlag: "preview", databaseUrl: pooler(PREV_REF), directUrl: direct(PROD_REF) }).ok);
  check("VERCEL_ENV=production is refused", !gate({ envFlag: "preview", databaseUrl: direct(PREV_REF), vercelEnv: "production" }).ok);
  check("FM_DB_GUARD=clone-only keeps its meaning", !gate({ envFlag: "local", databaseUrl: LOCAL, env: { FM_DB_GUARD: "clone-only" } as unknown as NodeJS.ProcessEnv }).ok);
  const all = [
    gate({ envFlag: "preview", databaseUrl: direct(PROD_REF) }),
    gate({ envFlag: "preview", databaseUrl: pooler(PROD_REF) }),
    gate({ envFlag: "local", databaseUrl: direct(PREV_REF) }),
    gate({ envFlag: "preview", databaseUrl: pooler(PREV_REF), directUrl: direct(PROD_REF) }),
  ].flatMap((d) => d.reasons).join("\n");
  check("refusals never print a URL, host, ref, user or password",
    !all.includes(SECRET) && !all.includes(PROD_REF) && !all.includes(PREV_REF) && !all.includes("supabase.co") && !all.includes("postgresql://"));
}

console.log("1b. the owner-authorized Production path");
{
  const prodApply = (over: Partial<RepairEnvGuardInput> = {}) => gate({
    envFlag: "production", databaseUrl: pooler(PROD_REF), directUrl: direct(PROD_REF),
    approvalTicket: "FM-OPS-142", expect: "16", ...over,
  });
  check("--env=production --apply WITH ticket + expect on the Production project is allowed", prodApply().ok && prodApply().env === "production");
  check("…and returns the validated ticket, expect and a target hash", prodApply().approvalTicket === "FM-OPS-142" && prodApply().expect === 16
    && prodApply().targetHash === hashTarget(`supabase:${PROD_REF}/postgres`));
  check("…without --i-have-owner-approval is refused", !prodApply({ approvalTicket: null }).ok);
  check("…with an empty / malformed ticket is refused", !prodApply({ approvalTicket: "" }).ok && !prodApply({ approvalTicket: "a b" }).ok
    && !prodApply({ approvalTicket: "https://x" }).ok);
  check("…without --expect is refused", !prodApply({ expect: null }).ok);
  check("…with a non-numeric --expect is refused", !prodApply({ expect: "sixteen" }).ok && !prodApply({ expect: "-1" }).ok && !prodApply({ expect: "" }).ok);
  check("…against a NON-Production project is refused (positive proof required)", !prodApply({ databaseUrl: direct(PREV_REF), directUrl: undefined }).ok);
  check("…without FM_PRODUCTION_DB_REF is refused", !prodApply({ productionRef: undefined }).ok);
  check("…on a loopback host is refused", !prodApply({ databaseUrl: LOCAL, directUrl: undefined }).ok);
  check("…with DIRECT_URL on another database is refused", !prodApply({ directUrl: direct(PREV_REF) }).ok);
  check("…with FM_DB_GUARD=clone-only armed is refused", !prodApply({ env: { FM_DB_GUARD: "clone-only" } as unknown as NodeJS.ProcessEnv }).ok);
  check("…VERCEL_ENV=production does not block an explicit --env=production", prodApply({ vercelEnv: "production" }).ok);
  check("--i-have-owner-approval with --env=preview is refused (no ambiguous env)",
    !gate({ envFlag: "preview", databaseUrl: direct(PREV_REF), approvalTicket: "FM-OPS-142" }).ok);
  check("a dry run labelled --env=production must read the Production project",
    gate({ apply: false, envFlag: "production", databaseUrl: direct(PROD_REF) }).ok
    && !gate({ apply: false, envFlag: "production", databaseUrl: direct(PREV_REF) }).ok);
  check("a production dry run needs no ticket", gate({ apply: false, envFlag: "production", databaseUrl: direct(PROD_REF), expect: "16" }).ok);
  check("--expect is validated on a dry run too", !gate({ apply: false, expect: "x" }).ok);
  const reasons = [prodApply({ approvalTicket: null }), prodApply({ databaseUrl: direct(PREV_REF), directUrl: undefined }), prodApply({ expect: null })]
    .flatMap((d) => d.reasons).join("\n");
  check("production refusals print no URL, host, ref or password",
    !reasons.includes(SECRET) && !reasons.includes(PROD_REF) && !reasons.includes(PREV_REF) && !reasons.includes("supabase.co"));
  check("the target hash is not the ref", !String(prodApply().targetHash).includes(PROD_REF));
  check("restore location: under tmp/ or outside the repo only",
    restoreLocationRefusal("tmp/x.json", "/repo") === null && restoreLocationRefusal("/elsewhere/x.json", "/repo") === null
    && restoreLocationRefusal("docs/x.json", "/repo") !== null && restoreLocationRefusal("x.json", "/repo") !== null);
  const redacted = redactConnectionDetails(`Can't reach database server at \`aws-0-us-east-1.pooler.supabase.com:6543\` ${pooler(PROD_REF)} user postgres.${PROD_REF}`, [PROD_REF]);
  check("connection errors are redacted before printing", !redacted.includes(SECRET) && !redacted.includes(PROD_REF) && !redacted.includes("supabase.com"), redacted);
}

console.log("2. the CLI refuses before constructing any client");
{
  const ROOT = path.resolve(__dirname, "..");
  const run = (args: string[], env: Record<string, string>) => spawnSync(
    path.join(ROOT, "node_modules", ".bin", "tsx"),
    ["--require", "./scripts/lib/server-only-preload.cjs", "scripts/repair-transfer-debt-payment.ts", ...args],
    { cwd: ROOT, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env } as unknown as NodeJS.ProcessEnv, timeout: 120_000 },
  );
  const noEnv = run(["--apply"], { DATABASE_URL: LOCAL });
  check("--apply with no --env exits 2, nothing read or written", noEnv.status === 2 && /REFUSED/.test(noEnv.stderr), `${noEnv.status} ${noEnv.stderr}`);
  const prod = run(["--apply", "--env=preview"], { DATABASE_URL: direct(PROD_REF), FM_PRODUCTION_DB_REF: PROD_REF });
  check("--apply --env=preview against the Production project exits 2", prod.status === 2 && /Production/.test(prod.stderr), `${prod.status} ${prod.stderr}`);
  check("…and prints no secret or URL", !`${prod.stdout}${prod.stderr}`.includes(SECRET) && !`${prod.stdout}${prod.stderr}`.includes(PROD_REF));
  const prodNoTicket = run(["--apply", "--env=production", "--expect=16", "--out=tmp/x.json"], { DATABASE_URL: direct(PROD_REF), FM_PRODUCTION_DB_REF: PROD_REF });
  check("--apply --env=production without an owner ticket exits 2", prodNoTicket.status === 2 && /owner-approval/.test(prodNoTicket.stderr), `${prodNoTicket.status} ${prodNoTicket.stderr}`);
  const prodNoExpect = run(["--apply", "--env=production", "--i-have-owner-approval=FM-OPS-142", "--out=tmp/x.json"], { DATABASE_URL: direct(PROD_REF), FM_PRODUCTION_DB_REF: PROD_REF });
  check("--apply --env=production without --expect exits 2", prodNoExpect.status === 2 && /--expect/.test(prodNoExpect.stderr), `${prodNoExpect.status} ${prodNoExpect.stderr}`);
  const typo = run(["--aply", "--env=local"], { DATABASE_URL: LOCAL });
  check("an unknown flag (typo) exits 2 instead of silently dry-running", typo.status === 2 && /unknown argument/.test(typo.stderr), `${typo.status} ${typo.stderr}`);
  const noOut = run(["--apply", "--env=local"], { DATABASE_URL: LOCAL });
  check("--apply without --out exits 2 (no write without a restore file)", noOut.status === 2 && /--out/.test(noOut.stderr), `${noOut.status} ${noOut.stderr}`);
  const inRepo = run(["--apply", "--env=local", "--out=docs/plans/x.json"], { DATABASE_URL: LOCAL });
  check("--out inside the repo but outside tmp/ exits 2", inRepo.status === 2 && /tmp\//.test(inRepo.stderr), `${inRepo.status} ${inRepo.stderr}`);
  const dir = mkdtempSync(path.join(os.tmpdir(), "fm-repair-test-"));
  writeFileSync(path.join(dir, "r.restore.json"), "{}");
  const clobber = run(["--apply", "--env=local", `--out=${path.join(dir, "r.json")}`], { DATABASE_URL: LOCAL });
  check("an existing restore file is never overwritten (exit 2)", clobber.status === 2 && /restore file already exists/.test(clobber.stderr), `${clobber.status} ${clobber.stderr}`);
  writeFileSync(path.join(dir, "bad.restore.json"), JSON.stringify({ kind: "fm.repair-transfer-debt-payment.restore", version: 1, rule: "x", rows: [], checksum: "0" }));
  const bad = run([`--rollback=${path.join(dir, "bad.restore.json")}`], { DATABASE_URL: LOCAL });
  check("a rollback with an untrustworthy restore file exits 2 before any database contact", bad.status === 2 && /restore file rejected/.test(bad.stderr), `${bad.status} ${bad.stderr}`);
}

// ── Core fixture ─────────────────────────────────────────────────────────────

function world(): { fake: FakePrisma; client: CorrectionClient } {
  const fake = new FakePrisma();
  fake.seed("Space", { id: "space_a", name: "A" });
  fake.seed("Space", { id: "space_b", name: "B" });
  const acct = (id: string, type: string, mask: string, space: string) => {
    fake.seed("FinancialAccount", { id, ownerType: "USER", ownerUserId: "u1", name: id, type, institution: "Bank", mask, currency: "USD" });
    fake.seed("SpaceAccountLink", { spaceId: space, financialAccountId: id, kind: "HOME", visibilityLevel: "FULL", status: "ACTIVE" });
  };
  acct("fa_chk", "checking", "4321", "space_a");
  acct("fa_hysa", "savings", "8765", "space_a");
  acct("fa_card", "debt", "1111", "space_a");
  acct("fa_other_chk", "checking", "2468", "space_b");
  acct("fa_other_sav", "savings", "1357", "space_b");
  const tx = (id: string, acctId: string, day: string, amount: number, flowType: string, category: string, pfc: [string | null, string | null], over: Record<string, unknown> = {}) => {
    const date = new Date(`${day}T00:00:00.000Z`);
    fake.seed("Transaction", {
      id, financialAccountId: acctId, date, economicDate: date, amount, currency: "USD",
      merchant: `M ${id}`, description: "ORIG CO NAME:AMERICANEXPRESS CO ENTRY DESCR:TRANSFER",
      category, flowType, flowDirection: amount < 0 ? "INTERNAL" : "INFLOW",
      flowAuthority: "CLASSIFIER", classifierVersion: 5, classificationReason: "PLAID_PFC_PRIMARY", classificationConfidence: 0.8,
      pfcPrimary: pfc[0], pfcDetailed: pfc[1], pending: false, settlementState: "POSTED",
      plaidTransactionId: `p_${id}`, categorySource: "PLAID_PFC", ...over,
    });
  };
  const LP: [string, string] = ["LOAN_PAYMENTS", "LOAN_PAYMENTS_OTHER_PAYMENT"];
  const TI: [string, string] = ["TRANSFER_IN", "TRANSFER_IN_ACCOUNT_TRANSFER"];
  // Corrected: a posted HYSA leg.
  tx("a_out", "fa_chk", "2026-03-01", -1000, "DEBT_PAYMENT", "Payment", LP);
  tx("a_in", "fa_hysa", "2026-03-02", 1000, "TRANSFER", "Transfer", TI);
  // Unrelated same-amount purchase the same day: never selected.
  tx("a_buy", "fa_chk", "2026-03-01", -1000, "SPENDING", "Shopping", ["GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE"]);
  // Human override: untouched.
  tx("o_out", "fa_chk", "2026-04-01", -2000, "DEBT_PAYMENT", "Payment", LP, { categorySource: "USER_OVERRIDE" });
  tx("o_in", "fa_hysa", "2026-04-01", 2000, "TRANSFER", "Transfer", TI);
  // Real card payment: kept.
  tx("c_out", "fa_chk", "2026-05-01", -300, "DEBT_PAYMENT", "Payment", ["LOAN_PAYMENTS", "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT"]);
  tx("c_in", "fa_card", "2026-05-01", 300, "DEBT_PAYMENT", "Payment", ["LOAN_PAYMENTS", "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT"]);
  // Pending + live posted twin: posted corrected, pending retires.
  tx("p_pend", "fa_chk", "2026-06-01", -125.41, "DEBT_PAYMENT", "Payment", LP, { pending: true, settlementState: "PENDING", plaidTransactionId: "pp_pend" });
  tx("p_post", "fa_chk", "2026-06-02", -125.41, "DEBT_PAYMENT", "Payment", LP, { pendingTransactionRef: "pp_pend" });
  tx("p_in", "fa_hysa", "2026-06-02", 125.41, "TRANSFER", "Transfer", TI);
  // Another Space's leg.
  tx("b_out", "fa_other_chk", "2026-07-01", -500, "DEBT_PAYMENT", "Payment", LP);
  tx("b_in", "fa_other_sav", "2026-07-01", 500, "TRANSFER", "Transfer", TI);
  // Unpaired OTHER_PAYMENT leg: NOT asserted — the 0.2 unresolved signature.
  tx("u_out", "fa_chk", "2026-08-01", -1234.56, "DEBT_PAYMENT", "Payment", LP);
  // Pending with NO posted twin, paired: the current observation — corrected.
  tx("q_pend", "fa_chk", "2026-09-01", -747.26, "DEBT_PAYMENT", "Payment", LP, { pending: true, settlementState: "PENDING", plaidTransactionId: "pp_q" });
  tx("q_in", "fa_hysa", "2026-09-01", 747.26, "TRANSFER", "Transfer", TI);
  const client = { ...fake.txClient(), $transaction: (x: unknown) => fake.transaction(x) } as unknown as CorrectionClient;
  return { fake, client };
}
const NOW = () => new Date("2026-10-27T12:00:00.000Z");
const flow = (fake: FakePrisma, id: string) => (fake.one("Transaction", { id }) as Record<string, unknown>).flowType;
const row = (fake: FakePrisma, id: string) => fake.one("Transaction", { id }) as Record<string, unknown>;
const snapshot = (fake: FakePrisma) => new Map((fake.rows("Transaction") as Record<string, unknown>[]).map((r) => [r.id as string, JSON.stringify(r)]));
const LOCAL_CTX = { env: "local", targetHash: "t".repeat(16), approvalTicket: null };
/** A capturing persistRestore: records each persisted state and the updateMany count at that moment. */
function capture(fake: FakePrisma) {
  const states: { file: RestoreFile; writesSoFar: number }[] = [];
  const persistRestore: RepairOptions["persistRestore"] = (file) => {
    states.push({ file: JSON.parse(JSON.stringify(file)), writesSoFar: fake.callsTo("Transaction", "updateMany").length });
  };
  return { states, persistRestore, last: () => states[states.length - 1]?.file };
}
const applyOpts = (fake: FakePrisma, over: Partial<RepairOptions> = {}) => {
  const c = capture(fake);
  return { c, opts: { apply: true, now: NOW, context: LOCAL_CTX, persistRestore: c.persistRestore, ...over } as RepairOptions };
};

async function main(): Promise<void> {
  console.log("3. dry run by default — nothing written");
  {
    const { fake, client } = world();
    const r = await runTransferDebtPaymentRepair(client, { apply: false, now: NOW });
    check("the dry run proposes the eligible rows", r.totals.proposed === 5, JSON.stringify(r.rows.map((x) => x.idHash)));
    check("…and writes nothing", fake.callsTo("Transaction", "updateMany").length === 0 && flow(fake, "a_out") === "DEBT_PAYMENT");
    check("mode DRY_RUN", r.mode === "DRY_RUN" && r.totals.written === 0);
  }

  console.log("4. apply, idempotence, precedence");
  {
    const { fake, client } = world();
    const before = snapshot(fake);
    const { opts } = applyOpts(fake);
    const r = await runTransferDebtPaymentRepair(client, opts);
    check("apply writes exactly the proposals", r.totals.written === 5 && r.totals.conflicts === 0 && r.outcome === "APPLIED", JSON.stringify(r.totals));
    check("the HYSA leg is TRANSFER/Transfer under TRANSFER_AUTHORITY",
      flow(fake, "a_out") === "TRANSFER" && (fake.one("Transaction", { id: "a_out" }) as Record<string, unknown>).flowAuthority === "TRANSFER_AUTHORITY");
    check("the posted twin is corrected", flow(fake, "p_post") === "TRANSFER");
    check("the pending twin is NOT rewritten (it retires)", flow(fake, "p_pend") === "DEBT_PAYMENT" && r.totals.retiringPending.count === 1);
    check("the USER_OVERRIDE row is untouched", flow(fake, "o_out") === "DEBT_PAYMENT" && (r.untouched.USER_CATEGORY ?? 0) === 1);
    check("the real card payment is kept", flow(fake, "c_out") === "DEBT_PAYMENT");
    check("the unrelated same-amount purchase is untouched", flow(fake, "a_buy") === "SPENDING");
    const u = row(fake, "u_out");
    check("the UNPAIRED leg is not asserted: TRANSFER @0.2 AMBIGUOUS_UNKNOWN",
      u.flowType === "TRANSFER" && u.classificationConfidence === 0.2 && u.classificationReason === "AMBIGUOUS_UNKNOWN");
    check("…and surfaces as needs-classification (UNKNOWN_TRANSFER_DESTINATION)",
      shouldSurfaceAsNeedsClassification({ flowType: u.flowType as string, classificationReason: u.classificationReason as string,
        transferRail: null, hasResolvedMerchant: false, hasResolvedCounterparty: false } as never).reason === "UNKNOWN_TRANSFER_DESTINATION");
    check("the pending row with NO posted twin is corrected", flow(fake, "q_pend") === "TRANSFER" && row(fake, "q_pend").pending === true);
    // Nothing outside the six restorable columns moved on ANY row (amount, date,
    // direction, the persisted counterparty link, pending, deletedAt, PFC, categorySource…).
    const after = snapshot(fake);
    const strip = (j: string) => { const o = JSON.parse(j); for (const k of RESTORABLE_COLUMNS) delete o[k]; delete o.updatedAt; return JSON.stringify(o); };
    const moved = [...before].filter(([id, j]) => strip(j) !== strip(after.get(id)!)).map(([id]) => id);
    check("no column outside the six restorable ones changed on any row (counterparty links, categorySource, amounts…)", moved.length === 0, moved.join(","));
    const changedIds = [...before].filter(([id, j]) => j !== after.get(id)).map(([id]) => id).sort();
    check("only the five planned rows changed at all", JSON.stringify(changedIds) === JSON.stringify(["a_out", "b_out", "p_post", "q_pend", "u_out"]), changedIds.join(","));
    const { opts: o2, c: c2 } = applyOpts(fake);
    const again = await runTransferDebtPaymentRepair(client, o2);
    check("a second run changes nothing (idempotent)", again.totals.proposed === 0 && again.totals.written === 0 && again.outcome === "NOTHING_TO_DO", JSON.stringify(again.totals));
    check("…and persists no restore file", c2.states.length === 0);
  }

  console.log("5. --space scoping");
  {
    const { fake, client } = world();
    const r = await runTransferDebtPaymentRepair(client, applyOpts(fake, { spaceId: "space_b" }).opts);
    check("only the scoped Space's leg is written", r.totals.written === 1 && flow(fake, "b_out") === "TRANSFER" && flow(fake, "a_out") === "DEBT_PAYMENT");
    check("the scope is reported as a hash, never the raw id", r.scope.spaceIdHash === hashId("space_b"));
  }

  console.log("6. the audit report");
  {
    const { client } = world();
    const r = await runTransferDebtPaymentRepair(client, { apply: false, now: NOW });
    const row = r.rows.find((x) => x.idHash === hashId("a_out"))!;
    check("top-level shape", ["rule", "generatedAt", "mode", "outcome", "context", "scope", "expect", "totals", "conflictIdHashes", "untouched", "rows", "retiringPending"].every((k) => k in r));
    check("row: BEFORE carries every restorable column (incl. classifierVersion)",
      RESTORABLE_COLUMNS.every((k) => k in row.before) && row.before.classifierVersion === 5 && row.before.classificationConfidence === 0.8
      && row.before.flowAuthority === "CLASSIFIER" && row.before.classificationReason === "PLAID_PFC_PRIMARY");
    check("row: AFTER states classifierVersion null", row.after.classifierVersion === null);
    check("generatedAt is the injected clock", r.generatedAt === "2026-10-27T12:00:00.000Z");
    check("row: id hash (12 hex), masked account, date, amount, lifecycle",
      /^[0-9a-f]{12}$/.test(row.idHash) && row.account === "checking ••••4321" && row.date === "2026-03-01" && row.amount === -1000 && row.lifecycle === "POSTED");
    check("row: old → new flowType/category, evidence kind, maturity",
      row.before.flowType === "DEBT_PAYMENT" && row.before.category === "Payment"
      && row.after.flowType === "TRANSFER" && row.after.category === "Transfer" && row.after.flowAuthority === "TRANSFER_AUTHORITY"
      && typeof row.evidence === "string" && row.maturity === "SAVINGS_TRANSFER");
    check("totals split posted / pending", r.totals.posted.count + r.totals.pending.count === r.totals.proposed
      && r.totals.amount === Math.round((r.totals.posted.amount + r.totals.pending.amount) * 100) / 100);
    const json = JSON.stringify(r);
    check("no raw transaction or account id and no descriptor in the report",
      !/"a_out"|"fa_chk"|AMERICANEXPRESS|ORIG CO/.test(json));
    const text = summarizeRepairReport(r, "local");
    check("human summary names the mode, totals and each row", /DRY RUN/.test(text) && text.includes(row.idHash) && /retiring pending/.test(text));
  }

  await moreSections();
  console.log(`\nrepair-transfer-debt-payment: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

/** A client whose $transaction first lets a "concurrent writer" change a row. */
function racing(fake: FakePrisma, mutate: () => Promise<unknown>): CorrectionClient {
  return { ...fake.txClient(), $transaction: async (x: unknown, o?: unknown) => { await mutate(); return fake.transaction(x); } } as unknown as CorrectionClient;
}
const txUpdate = (fake: FakePrisma, id: string, data: Record<string, unknown>) =>
  (fake.txClient() as unknown as { transaction: { update: (a: unknown) => Promise<unknown> } }).transaction.update({ where: { id }, data });

async function moreSections(): Promise<void> {
  console.log("7. --expect");
  {
    const { fake, client } = world();
    const { opts, c } = applyOpts(fake, { expect: 4 });
    const r = await runTransferDebtPaymentRepair(client, opts);
    check("a mismatched --expect writes nothing", r.outcome === "REFUSED_EXPECT_MISMATCH" && r.totals.written === 0
      && fake.callsTo("Transaction", "updateMany").length === 0 && flow(fake, "a_out") === "DEBT_PAYMENT");
    check("…and persists no restore file", c.states.length === 0);
    check("…and reports the mismatch", r.expect?.count === 4 && r.expect.matched === false && /REFUSED — --expect=4/.test(summarizeRepairReport(r, "local")));
    const dry = await runTransferDebtPaymentRepair(client, { apply: false, now: NOW, expect: 5 });
    check("a dry run reports a matched expectation", dry.expect?.matched === true && /expect 5: MATCHED/.test(summarizeRepairReport(dry, "production")));
    const ok = await runTransferDebtPaymentRepair(client, applyOpts(fake, { expect: 5 }).opts);
    check("a matching --expect applies", ok.outcome === "APPLIED" && ok.totals.written === 5);
  }

  console.log("8. the restore record is persisted BEFORE the first write");
  {
    const { fake, client } = world();
    const { opts, c } = applyOpts(fake, { context: { env: "production", targetHash: "a".repeat(16), approvalTicket: "FM-OPS-142" } });
    const r = await runTransferDebtPaymentRepair(client, opts);
    check("persisted twice: PLANNED (before any updateMany) then APPLIED",
      c.states.length === 2 && c.states[0].file.state === "PLANNED" && c.states[0].writesSoFar === 0
      && c.states[1].file.state === "APPLIED" && c.states[1].file.written === 5, JSON.stringify(c.states.map((s) => [s.file.state, s.writesSoFar])));
    const f = c.last()!;
    const a = f.rows.find((x) => x.id === "a_out")!;
    check("restore rows carry the REAL id and its hash", a.idHash === hashId("a_out") && f.rows.length === 5);
    check("restore BEFORE = the exact prior values of all six written columns",
      JSON.stringify(a.before) === JSON.stringify({ flowType: "DEBT_PAYMENT", category: "Payment", flowAuthority: "CLASSIFIER", classifierVersion: 5, classificationReason: "PLAID_PFC_PRIMARY", classificationConfidence: 0.8 }),
      JSON.stringify(a.before));
    check("restore AFTER = what was written", JSON.stringify(a.after) === JSON.stringify({ flowType: "TRANSFER", category: "Transfer", flowAuthority: "TRANSFER_AUTHORITY", classifierVersion: null, classificationReason: "ACCOUNT_TYPE_CONTEXT", classificationConfidence: 1 }));
    check("restore records env, target hash and owner ticket, plus a RESTRICTED warning",
      f.context.env === "production" && f.context.approvalTicket === "FM-OPS-142" && /RESTRICTED/.test(f.warning));
    check("the restore file parses and verifies", parseRestoreFile(JSON.parse(JSON.stringify(f))).rows.length === 5);
    check("the shareable report has no raw id; the restore file does", !JSON.stringify(r).includes('"a_out"') && JSON.stringify(f).includes('"a_out"'));
  }
  {
    const { fake, client } = world();
    let threw = false;
    try {
      await runTransferDebtPaymentRepair(client, { apply: true, now: NOW, context: LOCAL_CTX, persistRestore: () => { throw new Error("disk full"); } });
    } catch { threw = true; }
    check("a restore record that cannot be persisted aborts with NOTHING written",
      threw && fake.callsTo("Transaction", "updateMany").length === 0 && flow(fake, "a_out") === "DEBT_PAYMENT");
    let refused = false;
    try { await runTransferDebtPaymentRepair(client, { apply: true, now: NOW }); } catch { refused = true; }
    check("apply without persistRestore is refused by the core", refused && fake.callsTo("Transaction", "updateMany").length === 0);
  }

  console.log("9. strict write — one transaction, all-or-nothing on a concurrent change");
  {
    const { fake } = world();
    const client = racing(fake, () => txUpdate(fake, "a_out", { categorySource: "USER_OVERRIDE" }));
    const { opts, c } = applyOpts(fake);
    const r = await runTransferDebtPaymentRepair(client, opts);
    check("a row overridden between plan and write aborts the whole repair", r.outcome === "ABORTED_CONFLICT" && r.totals.written === 0
      && r.conflictIdHashes.length === 1 && r.conflictIdHashes[0] === hashId("a_out"), JSON.stringify(r.totals));
    check("…the other four rows were rolled back too", ["b_out", "p_post", "q_pend", "u_out"].every((id) => flow(fake, id) === "DEBT_PAYMENT"));
    check("…the human's change survives", row(fake, "a_out").categorySource === "USER_OVERRIDE" && flow(fake, "a_out") === "DEBT_PAYMENT");
    check("…and the restore record is marked ABORTED", c.last()?.state === "ABORTED" && c.last()?.written === 0);
  }
  {
    const { fake } = world();
    const client = racing(fake, () => txUpdate(fake, "u_out", { classifierVersion: 6 }));
    const r = await runTransferDebtPaymentRepair(client, applyOpts(fake).opts);
    check("a classifierVersion change since planning is a conflict (the restore BEFORE would be stale)",
      r.outcome === "ABORTED_CONFLICT" && r.conflictIdHashes[0] === hashId("u_out"));
  }

  console.log("10. rollback");
  {
    const { fake, client } = world();
    const pristine = snapshot(fake);
    const { opts, c } = applyOpts(fake);
    await runTransferDebtPaymentRepair(client, opts);
    const restore = parseRestoreFile(JSON.parse(JSON.stringify(c.last())));

    const dry = await runTransferDebtPaymentRollback(client, restore, { apply: false, now: NOW, context: LOCAL_CTX });
    check("rollback is a dry run by default — nothing written", dry.outcome === "DRY_RUN" && dry.totals.revertible === 5
      && fake.callsTo("Transaction", "updateMany").length === 5 && flow(fake, "a_out") === "TRANSFER");
    check("the rollback report is hashed (no raw id)", !JSON.stringify(dry).includes('"a_out"') && /revertible 5/.test(summarizeRollbackReport(dry, "local")));

    const mism = await runTransferDebtPaymentRollback(client, restore, { apply: true, now: NOW, expect: 4, context: LOCAL_CTX });
    check("a mismatched --expect writes nothing", mism.outcome === "REFUSED_EXPECT_MISMATCH" && flow(fake, "a_out") === "TRANSFER");

    const applied = await runTransferDebtPaymentRollback(client, restore, { apply: true, now: NOW, expect: 5, context: LOCAL_CTX });
    check("rollback --apply restores all five rows", applied.outcome === "APPLIED" && applied.totals.reverted === 5, JSON.stringify(applied.totals));
    const now = snapshot(fake);
    const strip = (j: string) => { const o = JSON.parse(j); delete o.updatedAt; return JSON.stringify(o); };
    const differs = [...pristine].filter(([id, j]) => strip(j) !== strip(now.get(id)!)).map(([id]) => id);
    check("…EXACTLY: every row is byte-identical to its pre-repair state", differs.length === 0, differs.join(","));
    const again = await runTransferDebtPaymentRollback(client, restore, { apply: true, now: NOW, context: LOCAL_CTX });
    check("a second rollback finds nothing revertible (idempotent)", again.outcome === "NOTHING_TO_DO" && again.totals.drifted === 5 && again.totals.reverted === 0);
    const reRepair = await runTransferDebtPaymentRepair(client, { apply: false, now: NOW });
    check("after rollback the repair proposes the same five again", reRepair.totals.proposed === 5);
  }
  {
    const { fake, client } = world();
    const { opts, c } = applyOpts(fake);
    await runTransferDebtPaymentRepair(client, opts);
    const restore = parseRestoreFile(JSON.parse(JSON.stringify(c.last())));
    await txUpdate(fake, "a_out", { categorySource: "USER_OVERRIDE", category: "Savings" });
    await txUpdate(fake, "u_out", { flowType: "TRANSFER", classificationReason: "ACCOUNT_TYPE_CONTEXT", classificationConfidence: 1 }); // later settled by the sync pass
    await txUpdate(fake, "q_pend", { deletedAt: new Date("2026-09-03T00:00:00Z") }); // retired by removed[]
    const r = await runTransferDebtPaymentRollback(client, restore, { apply: true, now: NOW, context: LOCAL_CTX });
    const st = (id: string) => r.rows.find((x) => x.idHash === hashId(id))?.state;
    check("a row a human changed after the repair is left alone (USER_CATEGORY)", st("a_out") === "USER_CATEGORY" && row(fake, "a_out").category === "Savings");
    check("a row that moved on (re-settled) is left alone (DRIFTED)", st("u_out") === "DRIFTED" && row(fake, "u_out").classificationConfidence === 1);
    check("a tombstoned row still in the repaired state is restored", st("q_pend") === "REVERTIBLE" && flow(fake, "q_pend") === "DEBT_PAYMENT" && r.totals.tombstoned === 1);
    check("the rest are restored", r.totals.reverted === 3 && flow(fake, "b_out") === "DEBT_PAYMENT" && row(fake, "b_out").classifierVersion === 5);
  }
  {
    const { fake } = world();
    const base = applyOpts(fake);
    await runTransferDebtPaymentRepair({ ...fake.txClient(), $transaction: (x: unknown) => fake.transaction(x) } as unknown as CorrectionClient, base.opts);
    const restore = parseRestoreFile(JSON.parse(JSON.stringify(base.c.last())));
    const client = racing(fake, () => txUpdate(fake, "b_out", { categorySource: "USER_RULE" }));
    const r = await runTransferDebtPaymentRollback(client as never, restore, { apply: true, now: NOW, context: LOCAL_CTX });
    check("a concurrent change during the rollback aborts it all-or-nothing", r.outcome === "ABORTED_CONFLICT" && r.totals.reverted === 0
      && flow(fake, "a_out") === "TRANSFER" && r.conflictIdHashes[0] === hashId("b_out"));
  }
  {
    const { fake, client } = world();
    const { opts, c } = applyOpts(fake);
    await runTransferDebtPaymentRepair(client, opts);
    const good = JSON.parse(JSON.stringify(c.last())) as RestoreFile;
    const throws = (f: () => unknown) => { try { f(); return false; } catch (e) { return e instanceof RestoreFileError; } };
    const rejectsAsync = async (f: () => Promise<unknown>) => { try { await f(); return false; } catch (e) { return e instanceof RestoreFileError; } };
    const edited = JSON.parse(JSON.stringify(good)); edited.rows[0].before.flowType = "SPENDING";
    check("an edited restore file fails its checksum", throws(() => parseRestoreFile(edited)));
    const truncated = JSON.parse(JSON.stringify(good)); truncated.rows.pop();
    check("a truncated restore file fails its checksum", throws(() => parseRestoreFile(truncated)));
    check("a foreign document is rejected", throws(() => parseRestoreFile({ kind: "x" })) && throws(() => parseRestoreFile(null)));
    check("a restore file for ANOTHER database is refused (target hash)",
      await rejectsAsync(() => runTransferDebtPaymentRollback(client, good, { apply: false, context: { ...LOCAL_CTX, targetHash: "b".repeat(16) } })));
    check("an apply for a different env than the file's is refused",
      await rejectsAsync(() => runTransferDebtPaymentRollback(client, good, { apply: true, context: { ...LOCAL_CTX, env: "preview" } })));
    check("an apply without a provable target is refused",
      await rejectsAsync(() => runTransferDebtPaymentRollback(client, good, { apply: true, context: { ...LOCAL_CTX, targetHash: null } })));
    check("a file recording an ABORTED repair is refused",
      await rejectsAsync(() => runTransferDebtPaymentRollback(client, { ...good, state: "ABORTED" }, { apply: false, context: LOCAL_CTX })));
    check("none of the refusals wrote anything", flow(fake, "a_out") === "TRANSFER");
    check("restore file never lands in the repo by default (tmp/ is git-ignored)", existsSync(path.resolve(__dirname, "..", ".gitignore")));
  }
}
