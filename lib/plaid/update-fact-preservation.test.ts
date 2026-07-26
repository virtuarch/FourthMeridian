/**
 * lib/plaid/update-fact-preservation.test.ts
 *
 * V26-PRE (B1) — BEHAVIOURAL proof of the update-path fact-preservation
 * contract (house pattern: standalone tsx, DB-free, no Plaid API — the same
 * injected-deps harness as cursor-safety.test.ts):
 *
 *   npx tsx lib/plaid/update-fact-preservation.test.ts
 *
 *   Once semantic truth has been persisted for a transaction row, a FAILED
 *   classification run must never destroy it. Degrade-to-null is a CREATE
 *   contract; on UPDATE, semantic columns are written only when this run
 *   actually computed them, and transfer evidence follows the reconcile
 *   planner's NO_WRITE rule (persist only when RECOGNIZED — an unrecognized
 *   or non-transfer run never overwrites stamped evidence with nulls).
 *
 * The scenario in §1 is the exact failure class the V26-PRE audit proved: a
 * classified payroll row re-delivered in modified[] (Plaid enrichment drift is
 * documented, incident-proven behavior) while resolveAccountMeta — the FIRST
 * statement inside the classification try, a DB read — hits one transient
 * error. Pre-fix, the subsequent update overwrote flowType / flowDirection /
 * classifierVersion / TI facts / transfer evidence with explicit nulls and
 * reverted the rescued category; the page still "persisted", the cursor
 * advanced, and no replay ever healed it (null-classifierVersion rows are
 * excluded from version-scoped backfills by doctrine).
 */

process.env.ENCRYPTION_KEY ??= "0".repeat(64);

import { encryptWithPurpose, EncryptionPurpose } from "./encryption";
import { syncTransactionsForItem } from "./syncTransactions";

const FAKE_TOKEN = encryptWithPurpose("access-sandbox-test-token", EncryptionPurpose.PLAID_ACCESS_TOKEN);

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ── Fakes (cursor-safety harness, extended with semantic columns) ────────────

type Row = Record<string, unknown> & { id: string; plaidTransactionId: string | null; deletedAt: Date | null };

function makeFakeDb(opts: {
  cursor: string | null;
  accounts: Record<string, string>;
  /** Existing rows already persisted before the run. */
  seed?: Row[];
  /** How many financialAccount.findUnique({ where: { id } }) meta reads throw. */
  metaFailures?: number;
}) {
  const txns: Row[] = [...(opts.seed ?? [])];
  const item = { id: "item_1", cursor: opts.cursor, encryptedToken: FAKE_TOKEN, institutionName: "Chase" };
  const cursorWrites: (string | null)[] = [];
  let metaFailuresLeft = opts.metaFailures ?? 0;
  let seq = 100;

  return {
    _txns: txns, _item: item, _cursorWrites: cursorWrites,
    syncIssue: {
      create: async () => ({ id: "si1" }),
      findFirst: async () => null,
      update: async () => ({ id: "si1" }),
      findMany: async () => [],
      updateMany: async () => ({ count: 0 }),
    },
    syncIssueOccurrence: { create: async () => ({ id: "so1" }) },
    $transaction: async () => { throw new Error("the incident lifecycle must not open transactions"); },
    plaidItem: {
      findUnique: async () => ({ ...item }),
      update: async ({ data }: { data: { cursor?: string | null } }) => {
        if ("cursor" in data) { item.cursor = data.cursor ?? null; cursorWrites.push(data.cursor ?? null); }
        return item;
      },
    },
    providerAccountIdentity: {
      findFirst: async ({ where }: { where: { externalAccountId: string } }) => {
        const faId = opts.accounts[where.externalAccountId];
        return faId ? { financialAccount: { id: faId } } : null;
      },
    },
    financialAccount: {
      findUnique: async ({ where }: { where: { id?: string; plaidAccountId?: string } }) => {
        if (where.plaidAccountId) {
          const faId = opts.accounts[where.plaidAccountId];
          return faId ? { id: faId } : null;
        }
        // The meta read inside the classification try / miData — the injectable
        // transient failure this suite exists to exercise.
        if (metaFailuresLeft > 0) { metaFailuresLeft--; throw new Error("simulated transient meta-read failure"); }
        return { id: where.id, type: "checking", debtSubtype: null, currency: "USD", createdByUserId: "u1" };
      },
    },
    transaction: {
      findUnique: async ({ where, select: _s }: { where: { plaidTransactionId?: string; id?: string }; select?: unknown }) => {
        const r = where.plaidTransactionId
          ? txns.find((t) => t.plaidTransactionId === where.plaidTransactionId)
          : txns.find((t) => t.id === where.id);
        return r ? { ...r } : null;
      },
      findMany: async () => [],
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `t${++seq}`, deletedAt: null, merchantId: null, categorySource: null, ...data } as unknown as Row;
        txns.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const r = txns.find((t) => t.id === where.id);
        if (r) Object.assign(r, data);
        return r;
      },
      updateMany: async () => ({ count: 0 }),
    },
    auditLog:      { create: async () => ({ id: "al1" }) },
    notification:  { findFirst: async () => null, updateMany: async () => ({ count: 0 }) },
    merchant:      { upsert: async () => ({ id: "m1" }) },
    merchantAlias: { upsert: async () => ({ id: "a1" }), findUnique: async () => null },
    merchantRule:  { findMany: async () => [] },
  };
}

const txn = (id: string, acct: string, amount: number, over: Record<string, unknown> = {}) => ({
  transaction_id: id, account_id: acct, amount, date: "2026-07-02",
  name: `NAME ${id}`, merchant_name: `MERCH ${id}`, pending: false,
  iso_currency_code: "USD", ...over,
});

function makeFakePlaid(pages: { added?: unknown[]; modified?: unknown[]; removed?: unknown[]; next_cursor: string; has_more?: boolean }[]) {
  let i = 0;
  return {
    transactionsSync: async () => {
      const p = pages[Math.min(i++, pages.length - 1)];
      return { data: { added: p.added ?? [], modified: p.modified ?? [], removed: p.removed ?? [],
                       has_more: p.has_more ?? false, next_cursor: p.next_cursor } };
    },
  };
}

const ACCOUNTS = { plaid_acct_1: "fa_checking" };
const run = (fdb: ReturnType<typeof makeFakeDb>, fplaid: ReturnType<typeof makeFakePlaid>) =>
  syncTransactionsForItem("item_1", { db: fdb as never, plaid: fplaid as never });

/** A fully-classified, evidence-stamped payroll row as it sits in the DB. */
function classifiedPayrollRow(): Row {
  return {
    id: "t1", plaidTransactionId: "txn_P", financialAccountId: "fa_checking",
    amount: 2500, date: new Date("2026-07-01"), merchant: "ACME PAYROLL",
    description: "ACME PAYROLL DIRECT DEP", pending: false, deletedAt: null,
    merchantId: null, categorySource: null,
    category: "Income", currency: "USD",
    flowType: "INCOME", flowDirection: "IN",
    classifierVersion: "v3", classificationReason: "CATEGORY",
    transferRail: "PAYMENT_APP", transferMovementForm: "P2P",
    transferEvidenceVersion: "te1",
    // TI facts (transaction-facts.ts write columns)
    paymentChannel: "online", settlementState: "SETTLED", tiFactsVersion: "ti2",
  };
}

async function main(): Promise<void> {

// ── 1. THE CONTRACT — meta-read failure on modified[] re-delivery ────────────
console.log("1. Transient meta failure on a modified[] re-delivery — persisted facts SURVIVE");
{
  const fdb = makeFakeDb({
    cursor: "C_old", accounts: ACCOUNTS, seed: [classifiedPayrollRow()],
    metaFailures: 2, // classification try + miData both hit the transient error
  });
  const fplaid = makeFakePlaid([{ modified: [txn("txn_P", "plaid_acct_1", -2500, { name: "ACME PAYROLL DIRECT DEP v2" })], next_cursor: "C_next" }]);
  const res = await run(fdb, fplaid);
  const row = fdb._txns.find((t) => t.plaidTransactionId === "txn_P")!;

  check("run completes (degradation must still never block the write)", res.modified === 1);
  check("cursor advanced (this is fact-fidelity, not a cursor-safety case)", fdb._item.cursor === "C_next");
  check("flowType PRESERVED (was: nulled → row left every economic total)", row.flowType === "INCOME", String(row.flowType));
  check("flowDirection preserved", row.flowDirection === "IN");
  check("classifierVersion preserved (null would exclude the row from version-scoped backfills — unrecoverable)", row.classifierVersion === "v3");
  check("classificationReason preserved", row.classificationReason === "CATEGORY");
  check("category preserved (was: reverted to the un-rescued mapPlaidCategory value)", row.category === "Income", String(row.category));
  check("transfer evidence preserved (rail)", row.transferRail === "PAYMENT_APP");
  check("transfer evidence preserved (form)", row.transferMovementForm === "P2P");
  check("TI facts preserved (paymentChannel)", row.paymentChannel === "online", String(row.paymentChannel));
  check("TI facts preserved (settlementState)", row.settlementState === "SETTLED");
  check("TI facts preserved (tiFactsVersion — null would mark facts never-derived)", row.tiFactsVersion === "ti2");
  check("base fields still refreshed (description)", row.description === "ACME PAYROLL DIRECT DEP v2", String(row.description));
  check("base fields still refreshed (amount sign-normalized)", row.amount === 2500);
  check("currency preserved/re-stamped (never nulled)", row.currency === "USD");
}

// ── 2. Evidence NO_WRITE — successful non-transfer classification ────────────
console.log("2. Successful re-classification with NO recognized evidence — stamped evidence survives (planner NO_WRITE)");
{
  const seed = classifiedPayrollRow();
  const fdb = makeFakeDb({ cursor: "C_old", accounts: ACCOUNTS, seed: [seed] });
  // Plain purchase shape: positive Plaid amount (money out), PFC present →
  // classification succeeds and is NOT a recognized transfer.
  const fplaid = makeFakePlaid([{ modified: [txn("txn_P", "plaid_acct_1", 42.5, {
    name: "STARBUCKS", merchant_name: "Starbucks",
    personal_finance_category: { primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_COFFEE", confidence_level: "HIGH" },
  })] , next_cursor: "C_next" }]);
  await run(fdb, fplaid);
  const row = fdb._txns.find((t) => t.plaidTransactionId === "txn_P")!;

  check("classification refreshed (provider re-sync recomputes provider-derived facts)",
    row.flowType !== "INCOME" && row.flowType != null, String(row.flowType));
  check("classifierVersion re-stamped by the successful run", row.classifierVersion !== "v3" && row.classifierVersion != null, String(row.classifierVersion));
  check("stamped evidence NOT overwritten with nulls (rail)", row.transferRail === "PAYMENT_APP", String(row.transferRail));
  check("stamped evidence NOT overwritten with nulls (form)", row.transferMovementForm === "P2P");
  check("evidence version untouched by the no-signal run", row.transferEvidenceVersion === "te1");
}

// ── 3. CREATE degradation unchanged — null semantics on a FRESH row only ─────
console.log("3. Meta failure on a genuinely new row — degrade-to-null CREATE contract unchanged");
{
  const fdb = makeFakeDb({ cursor: "C_old", accounts: ACCOUNTS, metaFailures: 2 });
  const fplaid = makeFakePlaid([{ added: [txn("txn_N", "plaid_acct_1", 12)], next_cursor: "C_next" }]);
  const res = await run(fdb, fplaid);
  const row = fdb._txns.find((t) => t.plaidTransactionId === "txn_N")!;

  check("row created (degradation never blocks the write)", res.created === 1);
  check("fresh row carries null flow columns (needs-classification backlog visibility)", row.flowType === null);
  check("fresh row carries null classifierVersion", row.classifierVersion === null);
  check("cursor advanced", fdb._item.cursor === "C_next");
}

if (failures > 0) {
  console.error(`\nupdate-fact-preservation: ${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\n✅ update-fact-preservation: all checks passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
