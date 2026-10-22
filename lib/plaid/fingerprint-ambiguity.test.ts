/**
 * lib/plaid/fingerprint-ambiguity.test.ts   (FIN-009)
 *
 * BEHAVIOURAL proof that an AMBIGUOUS fingerprint is REFUSED, not coin-tossed
 * (house pattern: standalone tsx, DB-free, no Plaid API — the harness shape of
 * pending-ref-fingerprint-guard.test.ts, reduced to the `added` path).
 *
 *     npx tsx --require scripts/lib/server-only-preload.cjs lib/plaid/fingerprint-ambiguity.test.ts
 *
 * Before FIN-009 `findByFingerprint` returned `matches[0]` when two rows carried
 * the same account/date/amount/descriptor/pending fingerprint, and the sync wrote
 * the incoming provider id onto that first twin. Lost coin toss ⇒ the wrong row
 * carries the id, and the real twin re-arrives later as a duplicate. Now the sync
 * resolves the fingerprint honestly: AMBIGUOUS adopts nothing, records a
 * non-cursor-blocking SyncIssue naming the candidates, and persists the incoming
 * row as its own. A SINGLE match is still adopted (DF-4 preserved).
 */

process.env.ENCRYPTION_KEY ??= "0".repeat(64);
import { encryptWithPurpose, EncryptionPurpose } from "./encryption";
import { syncTransactionsForItem } from "./syncTransactions";

const FAKE_TOKEN = encryptWithPurpose("access-sandbox-test-token", EncryptionPurpose.PLAID_ACCESS_TOKEN);

let failures = 0, passed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) passed++;
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

interface Row {
  id: string; plaidTransactionId: string | null; financialAccountId: string;
  amount: number; date: Date; economicDate: Date | null; merchant: string; description: string | null;
  pending: boolean; deletedAt: Date | null; merchantId: string | null; categorySource: string | null;
  transactionEventId: string | null; flowAuthority: string | null; pendingTransactionRef?: string | null;
}

function makeDb(opts: { accounts: Record<string, string>; seed: Row[] }) {
  const txns: Row[] = [...opts.seed];
  const issues: Record<string, unknown>[] = [];
  const item: { id: string; cursor: string | null; encryptedToken: string; institutionName: string } = { id: "item_1", cursor: "C1", encryptedToken: FAKE_TOKEN, institutionName: "Chase" };
  let seq = 100, oseq = 0, eseq = 0;
  const obs: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
  const d = {
    _txns: txns, _issues: issues,
    syncIssue: {
      create: async ({ data }: { data: Record<string, unknown> }) => { issues.push(data); return { id: `si${issues.length}` }; },
      findFirst: async () => null, update: async () => ({ id: "si1" }), findMany: async () => [], updateMany: async () => ({ count: 0 }),
    },
    syncIssueOccurrence: { create: async () => ({ id: "so1" }) },
    $transaction: async (fn: unknown) => (typeof fn === "function" ? (fn as (c: unknown) => unknown)(d) : undefined),
    plaidItem: {
      findUnique: async () => ({ ...item }),
      update: async ({ data }: { data: { cursor?: string | null } }) => { if ("cursor" in data) item.cursor = data.cursor ?? null; return item; },
    },
    providerAccountIdentity: {
      findFirst: async ({ where }: { where: { externalAccountId: string } }) => {
        const faId = opts.accounts[where.externalAccountId];
        return faId ? { financialAccount: { id: faId } } : null;
      },
    },
    financialAccount: {
      findUnique: async ({ where }: { where: { id?: string; plaidAccountId?: string } }) => {
        if (where.plaidAccountId) { const faId = opts.accounts[where.plaidAccountId]; return faId ? { id: faId } : null; }
        return { id: where.id, type: "checking", debtSubtype: null, currency: "USD", createdByUserId: "u1" };
      },
    },
    transaction: {
      findUnique: async ({ where }: { where: { plaidTransactionId?: string; id?: string } }) => {
        const r = where.plaidTransactionId ? txns.find((t) => t.plaidTransactionId === where.plaidTransactionId) : txns.find((t) => t.id === where.id);
        return r ? { ...r } : null;
      },
      findMany: async ({ where }: { where?: Record<string, unknown> } = {}) => {
        const w = where ?? {};
        const idIn = (w.id as { in?: string[] } | undefined)?.in;
        const ptIn = (w.plaidTransactionId as { in?: string[] } | undefined)?.in;
        if (!idIn && !ptIn && w.financialAccountId !== undefined) {
          return txns.filter((t) => t.financialAccountId === w.financialAccountId && t.date.getTime() === (w.date as Date).getTime()
            && t.amount === w.amount && t.pending === w.pending && t.deletedAt === null)
            .map((t) => ({ id: t.id, merchant: t.merchant, description: t.description, plaidTransactionId: t.plaidTransactionId,
              transactionEventId: t.transactionEventId, pendingTransactionRef: t.pendingTransactionRef ?? null }));
        }
        if (!idIn && !ptIn) return [];
        return txns.filter((t) => (!idIn || idIn.includes(t.id)) && (!ptIn || ptIn.includes(t.plaidTransactionId ?? ""))).map((t) => ({ ...t }));
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `t${++seq}`, deletedAt: null, merchantId: null, categorySource: null, transactionEventId: null,
          flowAuthority: null, economicDate: null, description: null, ...data } as unknown as Row;
        txns.push(row); return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const r = txns.find((t) => t.id === where.id); if (r) Object.assign(r, data); return r;
      },
      updateMany: async () => ({ count: 0 }),
    },
    transactionObservation: {
      findUnique: async () => null,
      findMany: async () => [],
      count: async () => 0,
      create: async ({ data }: { data: Record<string, unknown> }) => { const o = { id: `o${++oseq}`, ...data }; obs.push(o); return { id: o.id as string }; },
    },
    transactionEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => { const e = { id: `e${++eseq}`, ...data }; events.push(e); return { id: e.id as string }; },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => { const e = events.find((x) => x.id === where.id); if (e) Object.assign(e, data); return e; },
    },
    auditLog: { create: async () => ({ id: "al1" }) },
    notification: { findFirst: async () => null, updateMany: async () => ({ count: 0 }) },
    merchant: { upsert: async () => ({ id: "m1" }) },
    merchantAlias: { upsert: async () => ({ id: "a1" }), findUnique: async () => null },
    merchantRule: { findMany: async () => [] },
  };
  return d;
}

const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
/** A stored twin — the DB-side sign convention: Plaid −12.05 (money in) lands as +12.05. */
const twin = (id: string): Row => ({
  id, plaidTransactionId: null, financialAccountId: "fa_checking", amount: 12.05, date: day("2026-08-09"),
  economicDate: day("2026-08-09"), merchant: "Talabat", description: "TAP TALABAT food", pending: false,
  deletedAt: null, merchantId: null, categorySource: null, transactionEventId: null, flowAuthority: null, pendingTransactionRef: null,
});
const incoming = { transaction_id: "post_X", account_id: "plaid_acct_1", amount: -12.05, date: "2026-08-09",
  name: "TAP TALABAT food", merchant_name: "Talabat", pending: false, iso_currency_code: "USD" };
const fakePlaid = { transactionsSync: async () => ({ data: { added: [incoming], modified: [], removed: [], has_more: false, next_cursor: "C2" } }) };
const ACCOUNTS = { plaid_acct_1: "fa_checking" };

async function main(): Promise<void> {
  console.log("1. TWO twins carry the fingerprint ⇒ adoption refused, distinct row, SyncIssue recorded");
  {
    const fdb = makeDb({ accounts: ACCOUNTS, seed: [twin("twin-a"), twin("twin-b")] });
    const r = await syncTransactionsForItem("item_1", { db: fdb as never, plaid: fakePlaid as never });
    const live = fdb._txns.filter((t) => t.deletedAt === null);
    check("three live rows — the incoming row was persisted as its own, not fused onto a twin", live.length === 3, `${live.length}`);
    check("neither twin received the provider id", live.filter((t) => t.id.startsWith("twin")).every((t) => t.plaidTransactionId === null));
    check("the new row carries post_X", live.some((t) => t.plaidTransactionId === "post_X" && !t.id.startsWith("twin")));
    check("counted as created, not updatedByFingerprint", r.created === 1 && r.updatedByFingerprint === 0, JSON.stringify({ created: r.created, fp: r.updatedByFingerprint }));
    const issue = fdb._issues.find((i) => (i.detail as { stage?: string } | undefined)?.stage === "fingerprint-adoption-ambiguous");
    check("a SyncIssue was recorded with stage fingerprint-adoption-ambiguous", issue !== undefined, JSON.stringify(fdb._issues));
    const detail = (issue?.detail ?? {}) as Record<string, unknown>;
    check("…naming both candidates and the provider id, non-cursor-blocking, without a top-level plaidTransactionId (no member action)",
      Array.isArray(detail.candidateTransactionIds) && (detail.candidateTransactionIds as string[]).sort().join(",") === "twin-a,twin-b"
        && detail.providerTransactionId === "post_X" && detail.cursorBlocking === false && issue?.plaidTransactionId == null,
      JSON.stringify(issue));
    check("the cursor still advanced (the refusal is not a persistence failure)", r.cursor === "C2", String(r.cursor));
  }

  console.log("2. ONE twin ⇒ DF-4 adoption unchanged");
  {
    const fdb = makeDb({ accounts: ACCOUNTS, seed: [twin("twin-a")] });
    const r = await syncTransactionsForItem("item_1", { db: fdb as never, plaid: fakePlaid as never });
    const live = fdb._txns.filter((t) => t.deletedAt === null);
    check("still one row", live.length === 1, `${live.length}`);
    check("the twin was adopted and carries post_X", live[0]?.plaidTransactionId === "post_X");
    check("counted as updatedByFingerprint", r.updatedByFingerprint === 1 && r.created === 0);
    check("no ambiguity issue recorded", !fdb._issues.some((i) => (i.detail as { stage?: string } | undefined)?.stage === "fingerprint-adoption-ambiguous"));
  }

  console.log(failures === 0 ? `\nFIN-009 fingerprint ambiguity: ${passed} checks passed.` : `\n${failures} FAILED (${passed} passed)`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error("crashed:", e); process.exit(1); });
