/**
 * scripts/repair-transfer-debt-payment.test.ts
 *
 * v2.7-P1 — the historical repair: environment gate, dry-run default, apply,
 * idempotence, precedence, report shape. DB-free: the core runs against the
 * schema-driven in-memory Prisma, and the CLI is only ever spawned on paths the
 * gate refuses BEFORE any client is constructed.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs scripts/repair-transfer-debt-payment.test.ts
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { FakePrisma } from "@/lib/test-support/fake-prisma";
import type { CorrectionClient } from "@/lib/transactions/transfer-debt-payment-correction-write";
import { decideRepairEnvGuard, type RepairEnvGuardInput } from "./lib/repair-env-guard";
import { hashId, runTransferDebtPaymentRepair, summarizeRepairReport } from "./lib/repair-transfer-debt-payment.core";

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
  const client = { ...fake.txClient(), $transaction: (x: unknown) => fake.transaction(x) } as unknown as CorrectionClient;
  return { fake, client };
}
const NOW = () => new Date("2026-10-27T12:00:00.000Z");
const flow = (fake: FakePrisma, id: string) => (fake.one("Transaction", { id }) as Record<string, unknown>).flowType;

async function main(): Promise<void> {
  console.log("3. dry run by default — nothing written");
  {
    const { fake, client } = world();
    const r = await runTransferDebtPaymentRepair(client, { apply: false, now: NOW });
    check("the dry run proposes the eligible rows", r.totals.proposed === 3, JSON.stringify(r.rows.map((x) => x.idHash)));
    check("…and writes nothing", fake.callsTo("Transaction", "updateMany").length === 0 && flow(fake, "a_out") === "DEBT_PAYMENT");
    check("mode DRY_RUN", r.mode === "DRY_RUN" && r.totals.written === 0);
  }

  console.log("4. apply, idempotence, precedence");
  {
    const { fake, client } = world();
    const r = await runTransferDebtPaymentRepair(client, { apply: true, now: NOW });
    check("apply writes exactly the proposals", r.totals.written === 3 && r.totals.conflicts === 0, JSON.stringify(r.totals));
    check("the HYSA leg is TRANSFER/Transfer under TRANSFER_AUTHORITY",
      flow(fake, "a_out") === "TRANSFER" && (fake.one("Transaction", { id: "a_out" }) as Record<string, unknown>).flowAuthority === "TRANSFER_AUTHORITY");
    check("the posted twin is corrected", flow(fake, "p_post") === "TRANSFER");
    check("the pending twin is NOT rewritten (it retires)", flow(fake, "p_pend") === "DEBT_PAYMENT" && r.totals.retiringPending.count === 1);
    check("the USER_OVERRIDE row is untouched", flow(fake, "o_out") === "DEBT_PAYMENT" && (r.untouched.USER_CATEGORY ?? 0) === 1);
    check("the real card payment is kept", flow(fake, "c_out") === "DEBT_PAYMENT");
    check("the unrelated same-amount purchase is untouched", flow(fake, "a_buy") === "SPENDING");
    const again = await runTransferDebtPaymentRepair(client, { apply: true, now: NOW });
    check("a second run changes nothing (idempotent)", again.totals.proposed === 0 && again.totals.written === 0, JSON.stringify(again.totals));
  }

  console.log("5. --space scoping");
  {
    const { fake, client } = world();
    const r = await runTransferDebtPaymentRepair(client, { apply: true, spaceId: "space_b", now: NOW });
    check("only the scoped Space's leg is written", r.totals.written === 1 && flow(fake, "b_out") === "TRANSFER" && flow(fake, "a_out") === "DEBT_PAYMENT");
    check("the scope is reported as a hash, never the raw id", r.scope.spaceIdHash === hashId("space_b"));
  }

  console.log("6. the audit report");
  {
    const { client } = world();
    const r = await runTransferDebtPaymentRepair(client, { apply: false, now: NOW });
    const row = r.rows.find((x) => x.idHash === hashId("a_out"))!;
    check("top-level shape", ["rule", "generatedAt", "mode", "scope", "totals", "untouched", "rows", "retiringPending"].every((k) => k in r));
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

  console.log(`\nrepair-transfer-debt-payment: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
