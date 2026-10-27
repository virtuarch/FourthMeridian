/**
 * lib/plaid/transfer-authority-sync.test.ts
 *
 * v2.7-P1 — the transfer authority writes at SYNC time, and a re-sync cannot
 * revert it. Runs the real `syncTransactionsForItem` against the schema-driven
 * in-memory Prisma (lib/test-support/fake-prisma.ts) and a fake Plaid client —
 * no Postgres, no network, no Plaid:
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/plaid/transfer-authority-sync.test.ts
 *
 * Scenario: an Amex-initiated ACH pull. Plaid tags the CHECKING leg
 * LOAN_PAYMENTS_OTHER_PAYMENT ("ORIG CO NAME:AMERICANEXPRESS CO ENTRY
 * DESCR:TRANSFER"), so the context-free classifier writes DEBT_PAYMENT/Payment;
 * the matching SAVINGS leg arrives as TRANSFER_IN. A card payment rides along to
 * prove the rule keeps real debt payments.
 */

process.env.ENCRYPTION_KEY ??= "0".repeat(64);

import { FakePrisma, installFakePrisma } from "@/lib/test-support/fake-prisma";
import { encryptWithPurpose, EncryptionPurpose } from "./encryption";
import { syncTransactionsForItem } from "./syncTransactions";

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
  { id: "fa_card", plaid: "p_card", type: "debt" },
];

async function world() {
  const fake = new FakePrisma();
  // Every authority the sync reaches (db, systemDb, the incident and notification
  // helpers) lands on this fake — nothing can reach a real client.
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
      institution: "Bank", currency: "USD", plaidAccountId: a.plaid,
    });
    fake.seed("ProviderAccountIdentity", { financialAccountId: a.id, provider: "PLAID", externalAccountId: a.plaid });
  }
  const client = { ...fake.txClient(), $transaction: (x: unknown) => fake.transaction(x) };
  return { fake, client };
}

/** Plaid's sign convention: positive = money OUT of the account. */
const ptx = (id: string, acct: string, amount: number, pfc: [string, string], name: string, over: Record<string, unknown> = {}) => ({
  transaction_id: id, account_id: acct, amount, date: "2026-10-23", authorized_date: "2026-10-23",
  name, merchant_name: null, pending: false, pending_transaction_id: null,
  iso_currency_code: "USD", payment_channel: "other",
  personal_finance_category: { primary: pfc[0], detailed: pfc[1], confidence_level: "HIGH" },
  counterparties: [], ...over,
});

function plaidPages(pages: { added?: unknown[]; modified?: unknown[]; removed?: unknown[] }[]) {
  let i = 0;
  return {
    transactionsSync: async () => {
      const p = pages[Math.min(i++, pages.length - 1)];
      return { data: { added: p.added ?? [], modified: p.modified ?? [], removed: p.removed ?? [], has_more: false, next_cursor: `c${i}` } };
    },
  };
}

const HYSA_OUT = ptx("t_out", "p_chk", 1500, ["LOAN_PAYMENTS", "LOAN_PAYMENTS_OTHER_PAYMENT"], "ORIG CO NAME:AMERICANEXPRESS CO ENTRY DESCR:TRANSFER");
const HYSA_IN  = ptx("t_in", "p_hysa", -1500, ["TRANSFER_IN", "TRANSFER_IN_ACCOUNT_TRANSFER"], "TRANSFER FROM CHECKING");
const CARD_OUT = ptx("t_cc_out", "p_chk", 300, ["LOAN_PAYMENTS", "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT"], "PAYMENT TO CHASE CARD");
const CARD_IN  = ptx("t_cc_in", "p_card", -300, ["LOAN_PAYMENTS", "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT"], "Payment Thank You-Mobile");

const byPlaid = (fake: FakePrisma, id: string) => fake.one("Transaction", { plaidTransactionId: id }) as Record<string, unknown> | undefined;

async function main(): Promise<void> {
  console.log("1. a NEW sync is corrected by the transfer authority");
  const { fake, client } = await world();
  const res = await syncTransactionsForItem("item_1", { db: client as never, plaid: plaidPages([{ added: [HYSA_OUT, HYSA_IN, CARD_OUT, CARD_IN] }]) as never, restartDelayMs: 0 });
  const out = byPlaid(fake, "t_out");
  check("the sync completed", res.created === 4, JSON.stringify(res));
  check("the Amex-pull checking leg is TRANSFER", out?.flowType === "TRANSFER", String(out?.flowType));
  check("…category Transfer", out?.category === "Transfer", String(out?.category));
  check("…owned by TRANSFER_AUTHORITY, classifier version nulled", out?.flowAuthority === "TRANSFER_AUTHORITY" && out?.classifierVersion === null);
  check("…at the certain signature", out?.classificationReason === "ACCOUNT_TYPE_CONTEXT" && out?.classificationConfidence === 1);
  check("…amount and direction untouched", out?.amount === -1500 && out?.flowDirection === "INTERNAL");
  check("the savings leg is untouched (classifier TRANSFER)", byPlaid(fake, "t_in")?.flowAuthority === "CLASSIFIER");
  const ccOut = byPlaid(fake, "t_cc_out");
  check("the Chase card payment's cash leg stays DEBT_PAYMENT/Payment (classifier)",
    ccOut?.flowType === "DEBT_PAYMENT" && ccOut?.category === "Payment" && ccOut?.flowAuthority === "CLASSIFIER");
  check("the card leg stays DEBT_PAYMENT", byPlaid(fake, "t_cc_in")?.flowType === "DEBT_PAYMENT");

  console.log("2. a re-sync of the TRANSFER_AUTHORITY row does not revert it");
  const modified = { ...HYSA_OUT, name: "ORIG CO NAME:AMERICANEXPRESS CO ENTRY DESCR:TRANSFER v2" };
  await syncTransactionsForItem("item_1", { db: client as never, plaid: plaidPages([{ modified: [modified] }]) as never, restartDelayMs: 0 });
  const again = byPlaid(fake, "t_out");
  check("flowType still TRANSFER", again?.flowType === "TRANSFER", String(again?.flowType));
  check("category still Transfer (the provider's Payment is withheld on a foreign-owned row)", again?.category === "Transfer", String(again?.category));
  check("still owned by TRANSFER_AUTHORITY", again?.flowAuthority === "TRANSFER_AUTHORITY");
  check("base fields still refresh (description)", again?.description === modified.name, String(again?.description));
  check("no duplicate row", fake.rows("Transaction", { plaidTransactionId: "t_out" }).length === 1 && fake.rows("Transaction").length === 4);

  console.log("3. pending → posted: the posted row is corrected, the pending one retires");
  {
    const w = await world();
    const pend = { ...HYSA_OUT, transaction_id: "t_pend", pending: true };
    await syncTransactionsForItem("item_1", { db: w.client as never, plaid: plaidPages([{ added: [pend] }]) as never, restartDelayMs: 0 });
    const p0 = byPlaid(w.fake, "t_pend");
    check("an unpaired pending OTHER_PAYMENT leg is never silently asserted: TRANSFER @0.2",
      p0?.flowType === "TRANSFER" && p0?.classificationConfidence === 0.2, `${p0?.flowType}/${p0?.classificationConfidence}`);
    const posted = { ...HYSA_OUT, transaction_id: "t_post", pending_transaction_id: "t_pend" };
    await syncTransactionsForItem("item_1", { db: w.client as never, plaid: plaidPages([{ added: [posted, HYSA_IN], removed: [{ transaction_id: "t_pend" }] }]) as never, restartDelayMs: 0 });
    const post = byPlaid(w.fake, "t_post");
    const live = w.fake.rows("Transaction", { deletedAt: null }) as Record<string, unknown>[];
    check("the posted row is TRANSFER at the certain signature", post?.flowType === "TRANSFER" && post?.classificationConfidence === 1,
      `${post?.flowType}/${post?.classificationConfidence}`);
    check("the pending row retired (tombstoned by removed[]), not rewritten into a duplicate",
      byPlaid(w.fake, "t_pend")?.deletedAt != null && live.filter((r) => r.amount === -1500).length === 1,
      `live -1500 rows: ${live.filter((r) => r.amount === -1500).length}`);
  }

  console.log(`\ntransfer-authority-sync: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
