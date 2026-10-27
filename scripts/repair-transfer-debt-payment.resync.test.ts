/**
 * scripts/repair-transfer-debt-payment.resync.test.ts
 *
 * v2.7-P1 repair readiness — a row the HISTORICAL REPAIR corrected cannot be
 * turned back into DEBT_PAYMENT by a later Plaid sync. Runs the repair core and
 * then the REAL `syncTransactionsForItem` against the schema-driven in-memory
 * Prisma and a fake Plaid client — no Postgres, no network, no Plaid:
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs scripts/repair-transfer-debt-payment.resync.test.ts
 *
 * Setup: a first sync persists the Amex-pull pair; the rows are then put back in
 * the PRE-v2.7 shape the Production rows carry (classifier DEBT_PAYMENT/Payment,
 * PLAID_PFC_PRIMARY 0.8, v5) — the state the repair exists to fix — and the
 * repair is applied. Every scenario then re-syncs and asserts the row is still
 * the transfer authority's.
 */

process.env.ENCRYPTION_KEY ??= "0".repeat(64);

import { FakePrisma, installFakePrisma } from "@/lib/test-support/fake-prisma";
import { encryptWithPurpose, EncryptionPurpose } from "@/lib/plaid/encryption";
import { syncTransactionsForItem } from "@/lib/plaid/syncTransactions";
import { FLOW_CLASSIFIER_VERSION } from "@/lib/transactions/flow-classifier";
import type { CorrectionClient } from "@/lib/transactions/transfer-debt-payment-correction-write";
import { runTransferDebtPaymentRepair } from "./lib/repair-transfer-debt-payment.core";

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`); return; }
  failures.push(name);
  console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
}

const ACCTS = [
  { id: "fa_chk",  plaid: "p_chk",  type: "checking" },
  { id: "fa_hysa", plaid: "p_hysa", type: "savings" },
];

type R = Record<string, unknown>;

async function world() {
  const fake = new FakePrisma();
  await installFakePrisma(fake);
  fake.seed("User", { id: "u1", email: "u1@example.test" });
  fake.seed("PlaidItem", {
    id: "item_1", userId: "u1", externalItemId: "ext_item_1", institutionId: "ins_1", institutionName: "Bank",
    encryptedToken: encryptWithPurpose("access-sandbox-test", EncryptionPurpose.PLAID_ACCESS_TOKEN),
    cursor: null, completedSyncCount: 1,
  });
  for (const a of ACCTS) {
    fake.seed("FinancialAccount", {
      id: a.id, ownerType: "USER", ownerUserId: "u1", createdByUserId: "u1", name: a.id, type: a.type,
      institution: "Bank", currency: "USD", plaidAccountId: a.plaid, mask: a.plaid === "p_chk" ? "1234" : "5678",
    });
    fake.seed("ProviderAccountIdentity", { financialAccountId: a.id, provider: "PLAID", externalAccountId: a.plaid });
  }
  const client = { ...fake.txClient(), $transaction: (x: unknown, o?: unknown) => fake.transaction(x) };
  return { fake, client };
}

const NAME = "ORIG CO NAME:AMERICANEXPRESS CO ENTRY DESCR:TRANSFER";
const LP: [string, string] = ["LOAN_PAYMENTS", "LOAN_PAYMENTS_OTHER_PAYMENT"];
const ptx = (id: string, acct: string, amount: number, pfc: [string, string], name: string, over: R = {}) => ({
  transaction_id: id, account_id: acct, amount, date: "2026-10-23", authorized_date: "2026-10-23",
  name, merchant_name: null, pending: false, pending_transaction_id: null,
  iso_currency_code: "USD", payment_channel: "other",
  personal_finance_category: { primary: pfc[0], detailed: pfc[1], confidence_level: "HIGH" },
  counterparties: [], ...over,
});
const OUT = ptx("t_out", "p_chk", 1500, LP, NAME);
const IN  = ptx("t_in", "p_hysa", -1500, ["TRANSFER_IN", "TRANSFER_IN_ACCOUNT_TRANSFER"], "TRANSFER FROM CHECKING");

function plaidPages(pages: { added?: unknown[]; modified?: unknown[]; removed?: unknown[] }[]) {
  let i = 0;
  return {
    transactionsSync: async () => {
      const p = pages[Math.min(i++, pages.length - 1)];
      return { data: { added: p.added ?? [], modified: p.modified ?? [], removed: p.removed ?? [], has_more: false, next_cursor: `c${i}` } };
    },
  };
}
const sync = (client: unknown, page: { added?: unknown[]; modified?: unknown[]; removed?: unknown[] }) =>
  syncTransactionsForItem("item_1", { db: client as never, plaid: plaidPages([page]) as never, restartDelayMs: 0 });
const byPlaid = (fake: FakePrisma, id: string) => fake.one("Transaction", { plaidTransactionId: id }) as R | undefined;

/** The pre-v2.7 shape every affected Production row carries. */
const PRE_V27 = {
  flowType: "DEBT_PAYMENT", category: "Payment", flowAuthority: "CLASSIFIER", classifierVersion: FLOW_CLASSIFIER_VERSION,
  classificationReason: "PLAID_PFC_PRIMARY", classificationConfidence: 0.8,
};
async function regress(client: { transaction: { update: (a: unknown) => Promise<unknown> } }, fake: FakePrisma, plaidIds: string[]) {
  for (const p of plaidIds) {
    const r = byPlaid(fake, p)!;
    await client.transaction.update({ where: { id: r.id }, data: PRE_V27 });
  }
}
async function repair(fake: FakePrisma, client: unknown): Promise<number> {
  const r = await runTransferDebtPaymentRepair(client as CorrectionClient, {
    apply: true, context: { env: "local", targetHash: "t".repeat(16), approvalTicket: null }, persistRestore: () => {},
  });
  return r.totals.written;
}
const isRepaired = (r: R | undefined) => r?.flowType === "TRANSFER" && r?.category === "Transfer" && r?.flowAuthority === "TRANSFER_AUTHORITY";
const desc = (r: R | undefined) => `${r?.flowType}/${r?.category}/${r?.flowAuthority}/${r?.classificationConfidence}`;

/** A world holding one REPAIRED posted pair. */
async function repairedPosted() {
  const w = await world();
  await sync(w.client, { added: [OUT, IN] });
  await regress(w.client as never, w.fake, ["t_out"]);
  check("(setup) the row is back in the pre-v2.7 DEBT_PAYMENT shape", byPlaid(w.fake, "t_out")?.flowType === "DEBT_PAYMENT");
  const n = await repair(w.fake, w.client);
  check("(setup) the repair corrected it", n === 1 && isRepaired(byPlaid(w.fake, "t_out")), desc(byPlaid(w.fake, "t_out")));
  return w;
}

async function main(): Promise<void> {
  console.log("1. provider re-sends the SAME transaction (modified[]) with PFC LOAN_PAYMENTS");
  {
    const w = await repairedPosted();
    await sync(w.client, { modified: [{ ...OUT, name: `${NAME} ` }] });
    check("still TRANSFER/Transfer under TRANSFER_AUTHORITY", isRepaired(byPlaid(w.fake, "t_out")), desc(byPlaid(w.fake, "t_out")));
    check("no duplicate", w.fake.rows("Transaction", { plaidTransactionId: "t_out" }).length === 1);
  }

  console.log("2. provider re-sends it in added[] (replay)");
  {
    const w = await repairedPosted();
    await sync(w.client, { added: [OUT] });
    check("still repaired", isRepaired(byPlaid(w.fake, "t_out")), desc(byPlaid(w.fake, "t_out")));
  }

  console.log("3. removed[] then re-sent (tombstone + resurrection)");
  {
    const w = await repairedPosted();
    await sync(w.client, { removed: [{ transaction_id: "t_out" }] });
    check("tombstoned", byPlaid(w.fake, "t_out")?.deletedAt != null);
    await sync(w.client, { added: [OUT] });
    const r = byPlaid(w.fake, "t_out");
    check("resurrected and still repaired", r?.deletedAt == null && isRepaired(r), desc(r));
  }

  console.log("4. provider id churn (new transaction_id, same fingerprint) adopts the repaired row");
  {
    const w = await repairedPosted();
    await sync(w.client, { added: [{ ...OUT, transaction_id: "t_out_v2" }] });
    const r = byPlaid(w.fake, "t_out_v2");
    check("the repaired row adopted the new id and is still repaired", r != null && isRepaired(r), desc(r));
    check("no duplicate -1500 checking row", (w.fake.rows("Transaction", { deletedAt: null }) as R[]).filter((x) => x.amount === -1500).length === 1);
  }

  console.log("5. a repaired PENDING row (no posted twin) → posted + removed[] in the same sync");
  {
    const w = await world();
    await sync(w.client, { added: [{ ...OUT, transaction_id: "t_pend", pending: true }, IN] });
    await regress(w.client as never, w.fake, ["t_pend"]);
    const n = await repair(w.fake, w.client);
    check("(setup) the pending row was repaired", n === 1 && isRepaired(byPlaid(w.fake, "t_pend")), desc(byPlaid(w.fake, "t_pend")));
    await sync(w.client, { added: [{ ...OUT, transaction_id: "t_post", pending_transaction_id: "t_pend" }], removed: [{ transaction_id: "t_pend" }] });
    const post = byPlaid(w.fake, "t_post");
    check("the posted row is NOT DEBT_PAYMENT — the sync-time pass corrected it", isRepaired(post), desc(post));
    check("the pending row retired, one live -1500 checking row", byPlaid(w.fake, "t_pend")?.deletedAt != null
      && (w.fake.rows("Transaction", { deletedAt: null }) as R[]).filter((x) => x.amount === -1500).length === 1);
  }

  console.log("6. pending → posted where removed[] for the pending arrives in a LATER sync");
  {
    const w = await world();
    await sync(w.client, { added: [{ ...OUT, transaction_id: "t_pend", pending: true }, IN] });
    await regress(w.client as never, w.fake, ["t_pend"]);
    await repair(w.fake, w.client);
    await sync(w.client, { added: [{ ...OUT, transaction_id: "t_post", pending_transaction_id: "t_pend" }] });
    const post1 = byPlaid(w.fake, "t_post");
    check("while both observations are live the posted row is corrected (not DEBT_PAYMENT)", isRepaired(post1), desc(post1));
    check("the repaired pending row is untouched by that sync", isRepaired(byPlaid(w.fake, "t_pend")), desc(byPlaid(w.fake, "t_pend")));
    await sync(w.client, { removed: [{ transaction_id: "t_pend" }] });
    const post2 = byPlaid(w.fake, "t_post");
    check("after the pending retires the posted row is not DEBT_PAYMENT", post2?.flowType !== "DEBT_PAYMENT" && post2?.category !== "Payment", desc(post2));
  }

  console.log("7. the provider flips the SAME transaction id from pending to posted");
  {
    const w = await world();
    await sync(w.client, { added: [{ ...OUT, transaction_id: "t_flip", pending: true }, IN] });
    await regress(w.client as never, w.fake, ["t_flip"]);
    await repair(w.fake, w.client);
    await sync(w.client, { modified: [{ ...OUT, transaction_id: "t_flip", pending: false }] });
    const r = byPlaid(w.fake, "t_flip");
    check("posted, still repaired (the ownership gate keeps the correction)", r?.pending === false && isRepaired(r), desc(r));
  }

  console.log("8. a later sync re-runs the repair's own rule: the repair is idempotent against it");
  {
    const w = await repairedPosted();
    await sync(w.client, { modified: [OUT] });
    const n = await repair(w.fake, w.client);
    check("a repair after a re-sync proposes nothing", n === 0);
  }

  console.log(`\nrepair-transfer-debt-payment.resync: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
