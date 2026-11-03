/**
 * lib/plaid/balance-observed.test.ts
 *
 * FIN-A2 (FM-AUDIT-023, new-row half). A NEW account created at token exchange
 * with no observed provider balance is marked `balanceObserved: false`, is
 * EXCLUDED from every total ("Balance unavailable", never $0), and raises
 * BALANCE_UNOBSERVED through the one incident writer. The first observed balance
 * flips it back and resolves the condition. Existing rows are untouched.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/plaid/balance-observed.test.ts
 *
 * Synthetic fixtures only; no database (in-memory fakes through injection seams).
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { planBalanceWrite, planExchangeBalanceStamp, isObservedBalance } from "@/lib/plaid/refresh";
import { resolveWalletBalance } from "@/lib/crypto/wallet-current-value";
import { classifyAccounts, unvaluedBalanceLabel } from "@/lib/account-classifier";
import { classifySyncIssue, incidentLabel } from "@/lib/platform/sync-issue-semantics";
import { recordIncidentObservation, resolveByAutomaticRecovery, type IncidentClient } from "@/lib/platform/incidents/lifecycle";
import { isRegisteredOperation } from "@/lib/platform/incidents/operation-key";
import { readSpaceAccountsForSnapshot, type SnapshotAccountsClient } from "@/lib/snapshots/space-accounts";
import { auditMigrationNames } from "../../scripts/lib/migration-names";

let failures = 0;
let passes = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) { passes++; console.log(`  ✓ ${name}`); }
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── In-memory incident client (the lifecycle.test.ts fake, honouring the partial unique index) ──
type IssueRow = Record<string, unknown> & { id: string; incidentKey: string | null; resolved: boolean };
function makeIncidentClient() {
  const issues: IssueRow[] = [];
  let n = 0;
  const match = (row: IssueRow, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => {
      if (k === "id" && typeof v === "object" && v && "in" in (v as object)) return (v as { in: string[] }).in.includes(row.id);
      return row[k] === v;
    });
  const client = {
    syncIssue: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (data.incidentKey !== null && data.resolved === false &&
            issues.some((r) => r.incidentKey === data.incidentKey && r.resolved === false)) {
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        const row = { ...data, id: `i${++n}` } as IssueRow;
        issues.push(row);
        return row;
      },
      findFirst: async ({ where }: { where: Record<string, unknown> }) => issues.find((r) => match(r, where)) ?? null,
      findMany: async ({ where }: { where?: Record<string, unknown> } = {}) => issues.filter((r) => (where ? match(r, where) : true)),
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = issues.find((r) => r.id === where.id)!; Object.assign(row, data); return row;
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const hits = issues.filter((r) => match(r, where)); hits.forEach((r) => Object.assign(r, data)); return { count: hits.length };
      },
    },
    syncIssueOccurrence: { create: async ({ data }: { data: Record<string, unknown> }) => ({ ...data, id: `o${++n}` }) },
    $transaction: async () => { throw new Error("the incident lifecycle must not open transactions"); },
  };
  return { client: client as unknown as IncidentClient, issues };
}
const noExec = async () => null;

async function main(): Promise<void> {
  // ── 1. Writes ──────────────────────────────────────────────────────────────
  console.log("1. writes — the planners mark an observed balance observed, and only then");
  {
    const now = new Date("2026-03-01T00:00:00Z");
    check("exchange: observed ⇒ balance + lastUpdated + balanceObserved true",
      JSON.stringify(planExchangeBalanceStamp(120.5, now)) === JSON.stringify({ balance: 120.5, lastUpdated: now, balanceObserved: true }));
    check("exchange: null ⇒ writes nothing (an unobserved row stays unobserved)",
      JSON.stringify(planExchangeBalanceStamp(null, now)) === "{}" && JSON.stringify(planExchangeBalanceStamp(undefined, now)) === "{}");
    const obs = planBalanceWrite({ current: 50, available: 40 }, "checking");
    const un  = planBalanceWrite({ current: null, available: 40 }, "checking");
    check("refresh: observed ⇒ data.balanceObserved true", obs.observed && obs.data.balanceObserved === true && obs.data.balance === 50);
    check("refresh: null ⇒ no balance, no balanceObserved key", !un.observed && !("balance" in un.data) && !("balanceObserved" in un.data));
    check("one predicate decides 'observed'", isObservedBalance(0) && !isObservedBalance(NaN) && !isObservedBalance(null));

    const EX = code(read("lib", "plaid", "exchangeToken.ts"));
    check("create site: balanceObserved false ONLY when not observed (observed create unchanged)",
      /balance:\s*balanceStamp\.balance \?\? 0,\s*\.\.\.\(balanceStamp\.balanceObserved \? \{\} : \{ balanceObserved: false \}\),/.test(EX));
    check("create site: raises BALANCE_UNOBSERVED for that row via the dedicated recorder",
      /createdUnobserved = !balanceStamp\.balanceObserved;/.test(EX)
      && /if \(createdUnobserved\) \{\s*await recordExchangeBalanceUnobserved\(fa\.id, acct\.account_id, plaidItem\.id\);/.test(EX));
    check("existing-row writes: an observed balance resolves the condition",
      /else if \(wroteExistingRow && balanceStamp\.balanceObserved\) \{\s*await resolveExchangeBalanceObserved\(fa\.id\);/.test(EX)
      && (EX.match(/wroteExistingRow = true;/g) ?? []).length === 2);
    check("exchangeToken.ts itself still records no sync issue (admission pin intact)", !/recordSyncIssue\(|syncIssue\.create\(/.test(EX));
    const REC = code(read("lib", "plaid", "exchange-balance-observation.ts"));
    check("recorder: kind BALANCE_UNOBSERVED, account-scoped (no plaidItemId), registered stage",
      /kind: SyncIssueKind\.BALANCE_UNOBSERVED/.test(REC) && /financialAccountId,/.test(REC)
      && !/plaidItemId:/.test(REC) && /stage: "exchange-balance-unobserved"/.test(REC));
    check("recorder/resolver go through the one incident writer, never a direct row",
      /recordSyncIssue\(/.test(REC) && /resolveBalanceUnobservedIssue\(/.test(REC) && !/syncIssue\.(create|update)/.test(REC));
    const RF = code(read("lib", "plaid", "refresh.ts"));
    check("refresh: the first observed balance on an unobserved row resolves it (transition only)",
      /if \(plan\.observed && fa\.balanceObserved === false\) \{\s*await resolveBalanceUnobservedIssue\(fa\.id\);/.test(RF));
  }

  // ── 2. Classification — excluded from every total, never $0 ───────────────
  console.log("\n2. the ONE totals classification excludes an unobserved balance");
  {
    check("unobserved (any type) ⇒ structural 0 + valuationUnknown",
      JSON.stringify(resolveWalletBalance(0, undefined, false)) === JSON.stringify({ balance: 0, valuationUnknown: true })
      && JSON.stringify(resolveWalletBalance(999, undefined, false)) === JSON.stringify({ balance: 0, valuationUnknown: true }));
    check("observed / absent / null ⇒ byte-identical to the two-argument call",
      [true, undefined, null].every((o) => JSON.stringify(resolveWalletBalance(321.09, undefined, o)) === JSON.stringify(resolveWalletBalance(321.09, undefined))));
    const CASH = { type: "checking", balance: 1_000, currency: "USD" };
    const NEW  = { type: "savings", ...resolveWalletBalance(0, undefined, false), currency: "USD" };
    const c = classifyAccounts([CASH, NEW]);
    check("totals exclude it; unvaluedCount reports it", c.netWorth === 1_000 && c.totalAssets === 1_000 && c.unvaluedCount === 1);
    const legacy = classifyAccounts([CASH, { type: "savings", ...resolveWalletBalance(250, undefined, true), currency: "USD" }]);
    const before = classifyAccounts([CASH, { type: "savings", balance: 250, currency: "USD" }]);
    check("existing rows (balanceObserved true) ⇒ totals byte-identical", JSON.stringify(legacy) === JSON.stringify(before));
    check("label: 'Balance unavailable' for a bank/brokerage row, never $0",
      unvaluedBalanceLabel({ type: "checking" }) === "Balance unavailable" && unvaluedBalanceLabel({ type: "investment" }) === "Balance unavailable");
    check("label: a wallet keeps 'Not yet valued'", unvaluedBalanceLabel({ type: "crypto" }) === "Not yet valued");
  }

  // ── 3. Snapshot read — excluded the same way as an unvalued wallet ────────
  console.log("\n3. today's snapshot read excludes it exactly like an unvalued wallet");
  {
    const lu = new Date("2026-03-01T00:00:00Z");
    const client = {
      spaceAccountLink: {
        findMany: async (args: any) => {
          const sel = args.select.financialAccount.select;
          const rows = [
            { id: "fa-cash", type: "checking", balance: 500, currency: "USD", walletChain: null, lastUpdated: lu, availableBalance: null, balanceObserved: true },
            { id: "fa-new",  type: "checking", balance: 0,   currency: "USD", walletChain: null, lastUpdated: lu, availableBalance: null, balanceObserved: false },
          ];
          // The read must SELECT the column, or the classification cannot see it.
          return rows.map((r) => ({ visibilityLevel: "FULL", financialAccount: sel.balanceObserved ? r : { ...r, balanceObserved: undefined } }));
        },
      },
      positionObservation: { groupBy: async () => [] },
    } as unknown as SnapshotAccountsClient;
    const rows = await readSpaceAccountsForSnapshot("space-synthetic", client);
    const byId = new Map(rows.map((r) => [r.id, r]));
    check("the unobserved row is flagged valuationUnknown with a structural 0",
      byId.get("fa-new")?.valuationUnknown === true && byId.get("fa-new")?.balance === 0);
    check("the observed row carries no flag (byte-identical)", !("valuationUnknown" in (byId.get("fa-cash") ?? {})) && byId.get("fa-cash")?.balance === 500);
    const c = classifyAccounts(rows as any);
    check("snapshot classification excludes it and reports unvaluedCount (the incomplete-stamp input)",
      c.netWorth === 500 && c.unvaluedCount === 1);
  }

  // ── 4. The incident — raised, account-scoped, resolved by the first observation ──
  console.log("\n4. BALANCE_UNOBSERVED through the existing incident writer + evidence path");
  {
    const cls = classifySyncIssue({ kind: "BALANCE_UNOBSERVED", provider: "PLAID", detail: { stage: "exchange-balance-unobserved" }, plaidTransactionId: null });
    check("classified an open CONDITION in domain 'balances', not member-actionable",
      cls.nature === "condition" && cls.domain === "balances" && !cls.customerActionable && cls.severity === "warning");
    check("labelled honestly", incidentLabel("BALANCE_UNOBSERVED", "balances") === "Balance not yet observed");
    check("its stage is a registered operation key", isRegisteredOperation("exchange-balance-unobserved"));

    const { client, issues } = makeIncidentClient();
    const raise = (acc: string) => recordIncidentObservation(
      { kind: "BALANCE_UNOBSERVED", provider: "PLAID", financialAccountId: acc, plaidAccountId: `p-${acc}`, detail: { stage: "exchange-balance-unobserved" } } as any,
      client, noExec);
    await raise("fa-a"); await raise("fa-b"); await raise("fa-a");
    const open = issues.filter((r) => r.kind === "BALANCE_UNOBSERVED" && r.resolved === false);
    check("one open episode PER ACCOUNT (repeat observations converge)", open.length === 2, String(open.length));
    // A held transaction page on the same item must be untouched by a balance recovery.
    await recordIncidentObservation(
      { kind: "UPSERT_ERROR", provider: "PLAID", plaidItemId: "item-1", plaidTransactionId: "tx1", detail: { stage: "transaction-persist", cursorBlocking: true } } as any,
      client, noExec);

    const r = await resolveByAutomaticRecovery({ financialAccountId: "fa-a", domain: "balances" }, client, noExec);
    check("first observed balance on fa-a resolves exactly its condition", r.resolved === 1);
    check("…fa-b stays open (another account's balance proves nothing)",
      issues.some((x) => x.financialAccountId === "fa-b" && x.resolved === false));
    check("…the held transaction page stays open", issues.some((x) => x.kind === "UPSERT_ERROR" && x.resolved === false));
    check("…resolved AUTOMATICALLY (the evidence path), not by an operator",
      issues.some((x) => x.financialAccountId === "fa-a" && x.resolved === true && x.resolutionKind != null));
    const again = await resolveByAutomaticRecovery({ financialAccountId: "fa-a", domain: "balances" }, client, noExec);
    check("idempotent: a later observed balance resolves nothing more", again.resolved === 0);
    const tx = await resolveByAutomaticRecovery({ plaidItemId: "item-1", domain: "transactions" }, client, noExec);
    check("the transactions recovery is unchanged (still resolves only the held page)", tx.resolved === 1
      && issues.some((x) => x.financialAccountId === "fa-b" && x.resolved === false));
  }

  // ── 5. Pin — every totals path goes through the one classification ───────
  console.log("\n5. pin — every totals path passes balanceObserved to the one classification");
  {
    const roots = ["app", "lib", "components"];
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { if (name !== "node_modules") walk(p); continue; }
        if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(p);
      }
    };
    for (const r of roots) walk(join(process.cwd(), r));
    const AUTHORITY = join(process.cwd(), "lib", "crypto", "wallet-current-value.ts");
    const callers = files.filter((f) => f !== AUTHORITY && /resolveWalletBalance\(/.test(code(readFileSync(f, "utf8"))));
    check("the totals readers are found", callers.length >= 5, callers.map((f) => f.slice(process.cwd().length + 1)).join(", "));
    /** Every `resolveWalletBalance(...)` call, with balanced parentheses. */
    const callsIn = (src: string): string[] => {
      const out: string[] = [];
      let i = src.indexOf("resolveWalletBalance(");
      while (i >= 0) {
        let depth = 0, j = i + "resolveWalletBalance".length;
        for (; j < src.length; j++) {
          if (src[j] === "(") depth++;
          else if (src[j] === ")") { depth--; if (depth === 0) break; }
        }
        out.push(src.slice(i, j + 1));
        i = src.indexOf("resolveWalletBalance(", j);
      }
      return out;
    };
    for (const f of callers) {
      const src = code(readFileSync(f, "utf8"));
      const rel = f.slice(process.cwd().length + 1);
      const calls = callsIn(src);
      check(`${rel}: every resolveWalletBalance call passes balanceObserved (3rd argument)`,
        calls.length > 0 && calls.every((c) => /,[^,]*balanceObserved[^,]*\)$/.test(c.replace(/\s+/g, " "))), calls.join(" | "));
    }
    // The readers that SELECT columns explicitly must select the new one.
    for (const f of ["lib/snapshots/space-accounts.ts", "lib/space/mount-composition.ts", "app/api/spaces/[id]/accounts/detail/route.ts", "lib/snapshots/backfill.ts"]) {
      check(`${f}: selects balanceObserved for the classification`, /balanceObserved:\s*true/.test(code(read(f))));
    }
    const A = code(read("lib", "data", "accounts.ts"));
    check("lib/data/accounts.ts reads the full row (include), so balanceObserved is present", /financialAccount: \{\s*include: \{/.test(A));
    const W = code(read("lib", "crypto", "wallet-current-value.ts"));
    check("the classification checks balanceObserved FIRST", /if \(balanceObserved === false\) return \{ balance: 0, valuationUnknown: true \};\s*if \(v === undefined\)/.test(W));
    for (const f of ["components/space/widgets/accounts/AccountsLedger.tsx", "components/space/manage/FinancesPanel.tsx", "components/space/manage/ShareExistingAccountsPanel.tsx"]) {
      const s = code(read(f));
      check(`${f}: an excluded row prints unvaluedBalanceLabel, never a hard-coded label`,
        /unvaluedBalanceLabel\(/.test(s) && !/>Not yet valued</.test(s));
    }
  }

  // ── 6. Migration ──────────────────────────────────────────────────────────
  console.log("\n6. migration — named, additive, catalog-only");
  {
    const dirs = readdirSync(join(process.cwd(), "prisma", "migrations"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
    const NAME = "20261103150000_fin_a2_balance_observed";
    check("the migration exists under its timestamped name", dirs.includes(NAME));
    check("the migration-name audit passes over the whole tree", auditMigrationNames(dirs).errors.length === 0, auditMigrationNames(dirs).errors.join("; "));
    const sql = read("prisma", "migrations", NAME, "migration.sql").replace(/^--.*$/gm, "");
    check("adds balanceObserved BOOLEAN NOT NULL DEFAULT true (catalog-only, no backfill)",
      /ALTER TABLE "FinancialAccount" ADD COLUMN "balanceObserved" BOOLEAN NOT NULL DEFAULT true;/.test(sql) && !/UPDATE\s+"FinancialAccount"/i.test(sql));
    check("adds the SyncIssueKind value", /ALTER TYPE "SyncIssueKind" ADD VALUE IF NOT EXISTS 'BALANCE_UNOBSERVED';/.test(sql));
    check("drops, renames or retypes nothing; balance stays NOT NULL", !/DROP|RENAME|ALTER COLUMN|SET DATA TYPE/i.test(sql));
    const schema = read("prisma", "schema.prisma");
    check("schema declares the column with default true", /balanceObserved\s+Boolean\s+@default\(true\)/.test(schema));
    check("schema declares the enum value", /BALANCE_UNOBSERVED/.test(schema.slice(schema.indexOf("enum SyncIssueKind"))));
    const grants = readdirSync(join(process.cwd(), "prisma", "migrations"))
      .filter((d) => !d.endsWith(".toml"))
      .map((d) => { try { return read("prisma", "migrations", d, "migration.sql").replace(/^\s*--.*$/gm, ""); } catch { return ""; } })
      .join("\n");
    check("no column-level grant exists on FinancialAccount (table grants cover the column)",
      !/GRANT[^;]*\([^)]*\)[^;]*ON[^;]*"FinancialAccount"/i.test(grants) && /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\."FinancialAccount" TO fm_app;/.test(grants));
  }

  console.log(failures === 0 ? `\nbalance-observed (FIN-A2): ${passes} checks passed.` : `\n${failures} check(s) failed`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
