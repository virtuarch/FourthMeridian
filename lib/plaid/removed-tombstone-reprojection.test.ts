/**
 * lib/plaid/removed-tombstone-reprojection.test.ts
 *
 * v2.6-EVENT-1 — BEHAVIOURAL proof that Plaid's `removed[]` re-projects the
 * events whose rows it tombstones (house pattern: standalone tsx, DB-free, no
 * Plaid API):
 *
 *   npx tsx lib/plaid/removed-tombstone-reprojection.test.ts
 *
 *   Tombstoning the last LIVE row observed by an event makes that event
 *   WITHDRAWN. Its observations, its identity and its economic date do not move.
 *
 * ── Why a full-loop test and not a source scan ──────────────────────────────
 *
 * `audit-event-identity` already asserts that every stored projection equals its
 * derived projection — and it CAUGHT this defect on the dev corpus, where a real
 * sync had tombstoned two pending rows and left their events saying PENDING.
 *
 * But that audit is structurally unable to catch it in CI. CI seeds a fresh
 * database in which no tombstone has ever occurred, so stored and derived agree
 * vacuously and the gate is green on a corpus that cannot express the bug. The
 * invariant only fails where the state exists, and the state only exists in
 * production and on long-lived developer databases.
 *
 * So this test MANUFACTURES the state. It drives the real
 * `syncTransactionsForItem` through the real `recordTransactionObservation` and
 * the real `reprojectEvent`, over the in-memory fake from cursor-safety.test.ts
 * extended with the L8 tables. Nothing here models the sync — the sync runs.
 *
 * ⚠️ Test 3 is the one that must fail if the fix is reverted. Deleting the
 * `reprojectEvent` loop from the `removed[]` branch leaves the event PENDING with
 * a `currentTransactionId` pointing at a tombstoned row, which is exactly the
 * production state this slice repaired.
 */

// A deterministic key BEFORE importing the sync module — the fake item carries a
// genuinely-encrypted token so the real decrypt path runs unmodified.
process.env.ENCRYPTION_KEY ??= "0".repeat(64);

import { encryptWithPurpose, EncryptionPurpose } from "./encryption";
import { syncTransactionsForItem } from "./syncTransactions";

const FAKE_TOKEN = encryptWithPurpose("access-sandbox-test-token", EncryptionPurpose.PLAID_ACCESS_TOKEN);

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ── Fakes ────────────────────────────────────────────────────────────────────

interface Row {
  id: string; plaidTransactionId: string | null; financialAccountId: string;
  amount: number; date: Date; economicDate: Date | null; merchant: string; pending: boolean;
  deletedAt: Date | null; merchantId: string | null; categorySource: string | null;
  transactionEventId: string | null; flowAuthority: string | null;
}
interface Obs {
  id: string; eventId: string; transactionId: string | null; financialAccountId: string;
  provider: string; providerRowId: string | null; providerPendingRef: string | null;
  observedAt: Date; lifecycle: string; amount: number;
  postingDate: Date; economicDate: Date; authorizedAt: Date | null; observationKey: string;
}
interface Evt {
  id: string; financialAccountId: string; lifecycle: string; economicDate: Date;
  currentAmount: number; currentTransactionId: string | null;
  firstObservedAt: Date; lastObservedAt: Date;
  firstPendingObservedAt: Date | null; postedObservedAt: Date | null; observationCount: number;
}

function makeFakeDb(opts: { cursor: string | null; accounts: Record<string, string> }) {
  const txns: Row[] = [];
  const obs: Obs[] = [];
  const events: Evt[] = [];
  const item = { id: "item_1", cursor: opts.cursor, encryptedToken: FAKE_TOKEN, institutionName: "Chase" };
  const syncIssues: { kind: string; detail?: Record<string, unknown>; resolved: boolean }[] = [];
  let seq = 0, oseq = 0, eseq = 0;

  return {
    _txns: txns, _obs: obs, _events: events, _item: item, _syncIssues: syncIssues,

    syncIssue: {
      create: async ({ data }: { data: { kind: string; detail?: Record<string, unknown>; resolved?: boolean } }) => {
        syncIssues.push({ kind: data.kind, detail: data.detail, resolved: data.resolved ?? false });
        return { id: `si${syncIssues.length}` };
      },
      findFirst: async () => null,
      update:    async () => ({ id: "si1" }),
      findMany:  async () => [],
      updateMany: async () => ({ count: 0 }),
    },
    syncIssueOccurrence: { create: async () => ({ id: "so1" }) },
    $transaction: async () => { throw new Error("the incident lifecycle must not open transactions"); },

    plaidItem: {
      findUnique: async () => ({ ...item }),
      update: async ({ data }: { data: { cursor?: string | null } }) => {
        if ("cursor" in data) item.cursor = data.cursor ?? null;
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
        return { id: where.id, type: "checking", debtSubtype: null, currency: "USD", createdByUserId: "u1" };
      },
    },

    transaction: {
      findUnique: async ({ where }: { where: { plaidTransactionId?: string; id?: string } }) => {
        const r = where.plaidTransactionId
          ? txns.find((t) => t.plaidTransactionId === where.plaidTransactionId)
          : txns.find((t) => t.id === where.id);
        return r ? { ...r } : null;
      },
      // Serves BOTH real callers: reprojectEvent's liveness lookup
      // ({ id: { in }, deletedAt: null }) and the removed[] branch's
      // affected-event read ({ plaidTransactionId: { in }, transactionEventId }).
      // The fingerprint fallback passes neither and must still get no candidates.
      findMany: async ({ where }: { where?: Record<string, unknown> } = {}) => {
        const w = where ?? {};
        const idIn  = (w.id as { in?: string[] } | undefined)?.in;
        const ptIn  = (w.plaidTransactionId as { in?: string[] } | undefined)?.in;
        if (!idIn && !ptIn) return [];
        return txns.filter((t) => {
          if (idIn && !idIn.includes(t.id)) return false;
          if (ptIn && !ptIn.includes(t.plaidTransactionId ?? "")) return false;
          if ("deletedAt" in w && w.deletedAt === null && t.deletedAt !== null) return false;
          if (w.transactionEventId && t.transactionEventId === null) return false;
          return true;
        }).map((t) => ({ ...t }));
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: `t${++seq}`, deletedAt: null, merchantId: null, categorySource: null,
          transactionEventId: null, flowAuthority: null, economicDate: null, ...data,
        } as unknown as Row;
        txns.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const r = txns.find((t) => t.id === where.id);
        if (r) Object.assign(r, data);
        return r;
      },
      updateMany: async ({ where, data }: { where: { plaidTransactionId: { in: string[] } }; data: { deletedAt: Date } }) => {
        let count = 0;
        for (const t of txns) {
          if (where.plaidTransactionId.in.includes(t.plaidTransactionId ?? "") && t.deletedAt === null) {
            t.deletedAt = data.deletedAt; count++;
          }
        }
        return { count };
      },
    },

    // ── L8 tables ────────────────────────────────────────────────────────────
    transactionObservation: {
      findUnique: async ({ where }: { where: { observationKey: string } }) => {
        const o = obs.find((x) => x.observationKey === where.observationKey);
        return o ? { id: o.id, eventId: o.eventId } : null;
      },
      findMany: async ({ where }: { where?: Record<string, unknown> } = {}) => {
        const w = where ?? {};
        const rowIn = (w.providerRowId as { in?: string[] } | undefined)?.in;
        return obs.filter((o) => {
          if (w.eventId && o.eventId !== w.eventId) return false;
          if (rowIn && !rowIn.includes(o.providerRowId ?? "")) return false;
          return true;
        }).map((o) => ({ ...o }));
      },
      count: async ({ where }: { where: { providerPendingRef?: string; NOT?: { transactionId?: string } } }) =>
        obs.filter((o) =>
          o.providerPendingRef === where.providerPendingRef &&
          o.transactionId !== where.NOT?.transactionId).length,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const o = { id: `o${++oseq}`, ...data } as unknown as Obs;
        obs.push(o);
        return { id: o.id };
      },
    },
    transactionEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const e = {
          id: `e${++eseq}`, firstPendingObservedAt: null, postedObservedAt: null,
          observationCount: 0, ...data,
        } as unknown as Evt;
        events.push(e);
        return { id: e.id };
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const e = events.find((x) => x.id === where.id);
        if (e) Object.assign(e, data);
        return e;
      },
    },

    auditLog:      { create: async () => ({ id: "al1" }) },
    notification:  { findFirst: async () => null, updateMany: async () => ({ count: 0 }) },
    merchant:      { upsert: async () => ({ id: "m1" }) },
    merchantAlias: { upsert: async () => ({ id: "a1" }), findUnique: async () => null },
    merchantRule:  { findMany: async () => [] },
  };
}

const pendingTxn = (id: string, acct: string, amount: number) => ({
  transaction_id: id, account_id: acct, amount, date: "2026-07-02",
  name: `NAME ${id}`, merchant_name: `MERCH ${id}`, pending: true,
  iso_currency_code: "USD",
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

async function main(): Promise<void> {

// ── 1. A pending row arrives — the event exists and is PENDING ───────────────
console.log("1. A pending authorization creates a PENDING event");
{
  const fdb = makeFakeDb({ cursor: null, accounts: ACCOUNTS });
  await run(fdb, makeFakePlaid([{ added: [pendingTxn("txn_P", "plaid_acct_1", 42)], next_cursor: "C1" }]));

  check("one row persisted", fdb._txns.length === 1, `${fdb._txns.length}`);
  check("one observation recorded", fdb._obs.length === 1, `${fdb._obs.length}`);
  check("one event created", fdb._events.length === 1, `${fdb._events.length}`);
  check("the event is PENDING", fdb._events[0]?.lifecycle === "PENDING", fdb._events[0]?.lifecycle);
  check("the event points at the live row",
    fdb._events[0]?.currentTransactionId === fdb._txns[0]?.id,
    `${fdb._events[0]?.currentTransactionId} vs ${fdb._txns[0]?.id}`);
}

// ── 2. THE TRANSITION — removed[] tombstones it ⇒ the event is WITHDRAWN ─────
console.log("\n2. removed[] tombstones the row ⇒ the event becomes WITHDRAWN (the fix)");
{
  const fdb = makeFakeDb({ cursor: null, accounts: ACCOUNTS });
  const fplaid = makeFakePlaid([
    { added: [pendingTxn("txn_P", "plaid_acct_1", 42)], next_cursor: "C1", has_more: true },
    { removed: [{ transaction_id: "txn_P" }], next_cursor: "C2" },
  ]);
  await run(fdb, fplaid);

  const row = fdb._txns[0];
  const evt = fdb._events[0];

  check("the row is tombstoned", row?.deletedAt !== null);
  check("the event is WITHDRAWN", evt?.lifecycle === "WITHDRAWN", evt?.lifecycle);
  check("the event no longer points at the tombstoned row",
    evt?.currentTransactionId === null, String(evt?.currentTransactionId));

  // Identity, history and evidence are preserved — a projection repair must
  // never edit its own input.
  check("the observation is preserved", fdb._obs.length === 1, `${fdb._obs.length}`);
  check("no event was created or destroyed", fdb._events.length === 1, `${fdb._events.length}`);
  check("the transaction row still exists (soft delete, not physical)", fdb._txns.length === 1);
  check("observationCount is unchanged", evt?.observationCount === 1, String(evt?.observationCount));
  check("the economic date did not move",
    evt?.economicDate?.toISOString() === fdb._obs[0]?.economicDate?.toISOString(),
    `${evt?.economicDate?.toISOString()} vs ${fdb._obs[0]?.economicDate?.toISOString()}`);
  check("the tombstone batch is still recorded for forensics",
    fdb._syncIssues.some((i) => i.kind === "REMOVED_TOMBSTONE"));
  check("the forensic record names how many events were re-projected",
    fdb._syncIssues.find((i) => i.kind === "REMOVED_TOMBSTONE")?.detail?.reprojectedEvents === 1,
    String(fdb._syncIssues.find((i) => i.kind === "REMOVED_TOMBSTONE")?.detail?.reprojectedEvents));
}

// ── 3. IDEMPOTENCE — replaying the same removed[] changes nothing ────────────
console.log("\n3. Replaying the same removed[] is idempotent (and self-heals a half-done run)");
{
  const fdb = makeFakeDb({ cursor: null, accounts: ACCOUNTS });
  const fplaid = makeFakePlaid([
    { added: [pendingTxn("txn_P", "plaid_acct_1", 42)], next_cursor: "C1", has_more: true },
    { removed: [{ transaction_id: "txn_P" }], next_cursor: "C2", has_more: true },
    { removed: [{ transaction_id: "txn_P" }], next_cursor: "C3" },
  ]);
  await run(fdb, fplaid);

  const evt = fdb._events[0];
  check("still exactly one event", fdb._events.length === 1, `${fdb._events.length}`);
  check("still WITHDRAWN", evt?.lifecycle === "WITHDRAWN", evt?.lifecycle);
  check("still one observation", fdb._obs.length === 1, `${fdb._obs.length}`);
  check("observationCount still 1", evt?.observationCount === 1, String(evt?.observationCount));

  // The second pass tombstones nothing (deletedAt is already set) yet still
  // re-projects — which is what makes a run that died between the two steps
  // recoverable rather than permanently drifted.
  check("the replay re-projected even though it tombstoned nothing",
    fdb._syncIssues.filter((i) => i.kind === "REMOVED_TOMBSTONE").length === 1,
    "a guarded updateMany means only the FIRST pass records a tombstone batch");
}

// ── 4. A posted row is NOT withdrawn by an unrelated tombstone ───────────────
console.log("\n4. Tombstoning one row does not withdraw a different event");
{
  const fdb = makeFakeDb({ cursor: null, accounts: ACCOUNTS });
  const fplaid = makeFakePlaid([
    { added: [pendingTxn("txn_P", "plaid_acct_1", 42), pendingTxn("txn_Q", "plaid_acct_1", 99)], next_cursor: "C1", has_more: true },
    { removed: [{ transaction_id: "txn_P" }], next_cursor: "C2" },
  ]);
  await run(fdb, fplaid);

  const byRow = new Map(fdb._obs.map((o) => [o.providerRowId, o.eventId]));
  const evtP = fdb._events.find((e) => e.id === byRow.get("txn_P"));
  const evtQ = fdb._events.find((e) => e.id === byRow.get("txn_Q"));

  check("two events exist", fdb._events.length === 2, `${fdb._events.length}`);
  check("the tombstoned row's event is WITHDRAWN", evtP?.lifecycle === "WITHDRAWN", evtP?.lifecycle);
  check("the untouched row's event is still PENDING", evtQ?.lifecycle === "PENDING", evtQ?.lifecycle);
  check("the untouched event still points at its live row", evtQ?.currentTransactionId !== null);
}

console.log(failures === 0
  ? "\nremoved-tombstone-reprojection: all checks passed."
  : `\nremoved-tombstone-reprojection: ${failures} FAILED.`);
process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
