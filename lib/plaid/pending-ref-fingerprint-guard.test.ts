/**
 * lib/plaid/pending-ref-fingerprint-guard.test.ts
 *
 * v2.6-EVENT-2 — BEHAVIOURAL proof that FINGERPRINT ADOPTION NEVER OVERRIDES
 * STRONGER PROVIDER IDENTITY EVIDENCE (house pattern: standalone tsx, DB-free,
 * no Plaid API — the harness from removed-tombstone-reprojection.test.ts):
 *
 *   npx tsx lib/plaid/pending-ref-fingerprint-guard.test.ts
 *
 * ── The production shape this manufactures ──────────────────────────────────
 *
 * Measured on the dev corpus (Chase "TAP TALABAT food", −12.05):
 *
 *   two pending rows, one day apart, same amount   → two events, correctly
 *   two posted deliveries, same day/amount/descriptor,
 *     each carrying a DIFFERENT `pending_transaction_id`
 *
 * The first posted row was created and linked to pending A's event. The second
 * fingerprint-matched that row (account+date+amount+descriptor+pending all
 * equal), so the sync ADOPTED it: overwrote `plaidTransactionId`, wrote a second
 * observation, and re-pointed `transactionEventId` at pending B's event. The
 * result was one row observed on two events, an orphaned provider id belonging
 * to no row, and a stale stored projection on the event it left behind — the
 * exact four violations `audit-event-identity` and `audit-event-reader-cutover`
 * reported.
 *
 * ⚠️ THE DOCTRINE THIS DEFENDS. `lib/transactions/event-identity.ts` ranks
 * `pending_transaction_id` as rank-1 evidence and DELIBERATELY leaves the
 * fingerprint rung empty, because a fingerprint cannot establish identity. The
 * defect was that the sync performed fingerprint identity on the ROW, upstream
 * of the authority, so the observation layer inherited a decision the authority
 * refuses to make. The provider said "two events"; the fingerprint said "one
 * row"; the fingerprint won.
 *
 * ⚠️ DF-4 IS PRESERVED. Test 2 is the Uber/Amazon case — a fingerprint collision
 * where NO stronger evidence exists. Adoption must still happen there, or the
 * six-Amazon-rows duplication returns. The guard is narrow by design: it refuses
 * adoption ONLY when the incoming row's `pending_transaction_id` resolves to a
 * different event than the candidate row already belongs to.
 *
 * ⚠️ Test 1 is the one that must fail if the guard is reverted.
 */

process.env.ENCRYPTION_KEY ??= "0".repeat(64);

import { encryptWithPurpose, EncryptionPurpose } from "./encryption";
import { syncTransactionsForItem } from "./syncTransactions";
import { projectEvent, type ObservationFacts } from "@/lib/transactions/event-identity";

const FAKE_TOKEN = encryptWithPurpose("access-sandbox-test-token", EncryptionPurpose.PLAID_ACCESS_TOKEN);

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ── Fakes ────────────────────────────────────────────────────────────────────

interface Row {
  id: string; plaidTransactionId: string | null; financialAccountId: string;
  amount: number; date: Date; economicDate: Date | null; merchant: string; description: string | null;
  pending: boolean; deletedAt: Date | null; merchantId: string | null; categorySource: string | null;
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
  let seq = 0, oseq = 0, eseq = 0;

  return {
    _txns: txns, _obs: obs, _events: events, _item: item,

    syncIssue: {
      create: async () => ({ id: "si1" }), findFirst: async () => null,
      update: async () => ({ id: "si1" }), findMany: async () => [], updateMany: async () => ({ count: 0 }),
    },
    syncIssueOccurrence: { create: async () => ({ id: "so1" }) },
    // Replaced by makeDb() below, which can close over the finished object.
    $transaction: async (): Promise<never> => { throw new Error("unbound $transaction"); },

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
      /**
       * Serves THREE real callers:
       *   · reprojectEvent liveness      { id: { in }, deletedAt: null }
       *   · removed[] affected events    { plaidTransactionId: { in }, transactionEventId }
       *   · findByFingerprint            { financialAccountId, date, amount, pending, deletedAt: null }
       * The third is what this file exists to exercise, so it is modelled fully.
       */
      findMany: async ({ where }: { where?: Record<string, unknown> } = {}) => {
        const w = where ?? {};
        const idIn = (w.id as { in?: string[] } | undefined)?.in;
        const ptIn = (w.plaidTransactionId as { in?: string[] } | undefined)?.in;

        if (!idIn && !ptIn && w.financialAccountId !== undefined) {
          // findByFingerprint
          return txns.filter((t) =>
            t.financialAccountId === w.financialAccountId &&
            t.date.getTime() === (w.date as Date).getTime() &&
            t.amount === w.amount &&
            t.pending === w.pending &&
            t.deletedAt === null,
          ).map((t) => ({
            id: t.id, merchant: t.merchant, description: t.description,
            plaidTransactionId: t.plaidTransactionId,
            // v2.6-EVENT-2 — the guard reads the candidate's event to compare it
            // against the incoming row's pending-ref evidence.
            transactionEventId: t.transactionEventId,
          }));
        }
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
          transactionEventId: null, flowAuthority: null, economicDate: null, description: null, ...data,
        } as unknown as Row;
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

/**
 * `$transaction` must hand the callback a client, and the only faithful client
 * here is the fake itself — so it is bound after construction. The observation
 * writer runs its three writes inside one interactive transaction (step 2 of
 * this slice); atomicity under FAILURE is proven in event-write-atomicity.test.ts.
 */
function makeDb(opts: { cursor: string | null; accounts: Record<string, string> }) {
  const d = makeFakeDb(opts);
  (d as unknown as { $transaction: (fn: unknown) => unknown }).$transaction = async (fn: unknown) => {
    if (typeof fn === "function") return (fn as (c: unknown) => unknown)(d);
    throw new Error("unexpected $transaction usage");
  };
  return d;
}

const ACCOUNTS = { plaid_acct_1: "fa_checking" };
const run = (fdb: ReturnType<typeof makeDb>, fplaid: { transactionsSync: () => Promise<unknown> }) =>
  syncTransactionsForItem("item_1", { db: fdb as never, plaid: fplaid as never });

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

/** A pending authorisation. Distinct dates keep the two from fingerprinting together. */
const pending = (id: string, date: string, amount: number) => ({
  transaction_id: id, account_id: "plaid_acct_1", amount, date,
  name: "TAP TALABAT food", merchant_name: "Talabat", pending: true, iso_currency_code: "USD",
});

/** A posted settlement carrying the provider's succession claim. */
const posted = (id: string, date: string, amount: number, ref: string | null) => ({
  transaction_id: id, account_id: "plaid_acct_1", amount, date,
  name: "TAP TALABAT food", merchant_name: "Talabat", pending: false,
  pending_transaction_id: ref, iso_currency_code: "USD",
});

/** Re-derive every event and report those whose stored projection has drifted. */
function staleEvents(fdb: ReturnType<typeof makeDb>): string[] {
  const live = new Set(fdb._txns.filter((t) => t.deletedAt === null).map((t) => t.id));
  const out: string[] = [];
  for (const ev of fdb._events) {
    const mine = fdb._obs.filter((o) => o.eventId === ev.id)
      .sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
    if (mine.length === 0) continue;
    const facts: ObservationFacts[] = mine.map((o) => ({
      observedAt: o.observedAt, lifecycle: o.lifecycle as "PENDING" | "POSTED", amount: o.amount,
      postingDate: o.postingDate, economicDate: o.economicDate,
      liveTransactionId: o.transactionId && live.has(o.transactionId) ? o.transactionId : null,
    }));
    const p = projectEvent(facts);
    if (p.lifecycle !== ev.lifecycle || p.observationCount !== ev.observationCount ||
        (p.currentTransactionId ?? null) !== (ev.currentTransactionId ?? null)) {
      out.push(`${ev.id}: stored ${ev.lifecycle}/${ev.observationCount}/${ev.currentTransactionId ?? "null"} vs derived ${p.lifecycle}/${p.observationCount}/${p.currentTransactionId ?? "null"}`);
    }
  }
  return out;
}

async function main(): Promise<void> {

// ── 1. THE DEFECT — a pending-ref must outrank a fingerprint ────────────────
console.log("1. Two posted rows with DIFFERENT pending refs must stay TWO rows (the guard)");
{
  const fdb = makeDb({ cursor: null, accounts: ACCOUNTS });
  await run(fdb, makeFakePlaid([
    // Two pending authorisations, one day apart, identical amount.
    { added: [pending("pend_A", "2026-08-05", -12.05), pending("pend_B", "2026-08-06", -12.05)],
      next_cursor: "C1", has_more: true },
    // Both settle on the same day for the same amount under the same descriptor.
    // Fingerprint-identical to each other; provider-distinct via pending ref.
    { added: [posted("post_A", "2026-08-09", -12.05, "pend_A"),
              posted("post_B", "2026-08-09", -12.05, "pend_B")], next_cursor: "C2" },
  ]));

  const live = fdb._txns.filter((t) => t.deletedAt === null);
  check("both pending rows persisted", fdb._txns.filter((t) => t.pending).length === 2,
    `${fdb._txns.filter((t) => t.pending).length}`);
  check("BOTH posted rows persisted as separate rows",
    live.filter((t) => !t.pending).length === 2,
    `${live.filter((t) => !t.pending).length} posted live row(s) — fingerprint adoption swallowed one`);
  check("no provider row id was overwritten",
    fdb._obs.every((o) => {
      const t = fdb._txns.find((x) => x.id === o.transactionId);
      return !t || !o.providerRowId || !t.plaidTransactionId || o.providerRowId === t.plaidTransactionId;
    }),
    "an observation carries a provider id its row no longer has");
  check("every observation sits on its row's event",
    fdb._obs.every((o) => {
      const t = fdb._txns.find((x) => x.id === o.transactionId);
      return !t || t.transactionEventId === null || t.transactionEventId === o.eventId;
    }),
    "observation.eventId ≠ transaction.transactionEventId");
  check("no event has a stale stored projection", staleEvents(fdb).length === 0,
    staleEvents(fdb).join(" | "));
  check("exactly two events, each with two observations",
    fdb._events.length === 2 && fdb._events.every((e) => e.observationCount === 2),
    `${fdb._events.length} event(s): ${fdb._events.map((e) => `${e.id}=${e.observationCount}`).join(",")}`);
}

// ── 2. DF-4 PRESERVED — no stronger evidence ⇒ adoption still happens ───────
console.log("\n2. DF-4 unchanged: a re-keyed row with NO pending ref is still adopted");
{
  const fdb = makeDb({ cursor: null, accounts: ACCOUNTS });
  await run(fdb, makeFakePlaid([
    { added: [{ transaction_id: "uber_1", account_id: "plaid_acct_1", amount: -7.12,
                date: "2026-08-16", name: "Uber", merchant_name: "Uber", pending: true,
                iso_currency_code: "USD" }], next_cursor: "C1", has_more: true },
    // Same account/date/amount/descriptor/pending, NEW provider id, no pending ref:
    // Plaid re-keyed the row. DF-4's whole purpose is to reuse it, not duplicate.
    { added: [{ transaction_id: "uber_2", account_id: "plaid_acct_1", amount: -7.12,
                date: "2026-08-16", name: "Uber", merchant_name: "Uber", pending: true,
                iso_currency_code: "USD" }], next_cursor: "C2" },
  ]));

  const live = fdb._txns.filter((t) => t.deletedAt === null);
  check("still ONE row — the duplicate was prevented", live.length === 1, `${live.length}`);
  check("the row carries the newest provider id",
    live[0]?.plaidTransactionId === "uber_2", `${live[0]?.plaidTransactionId}`);
  check("still ONE event", fdb._events.length === 1, `${fdb._events.length}`);
  check("no event has a stale stored projection", staleEvents(fdb).length === 0,
    staleEvents(fdb).join(" | "));
  // ⚠️ RECORDED, NOT ASSERTED AWAY. A legitimate DF-4 adoption produces TWO
  // observations of ONE live row — we genuinely observed the row twice, under
  // two provider ids. That is honest history and the projection is correct
  // (`observationCount` 2, one live row). But `audit-event-identity` INV-4 and
  // `audit-event-reader-cutover` count OBSERVATIONS-pointing-at-live-rows rather
  // than DISTINCT live rows, so they read this as "two live rows" and fail. The
  // data is right and the counter is wrong; resolving that is a decision about
  // the audits, not about this write path, and is left open deliberately.
  const liveObs = fdb._obs.filter((o) =>
    fdb._txns.some((t) => t.id === o.transactionId && t.deletedAt === null)).length;
  console.log(`     ℹ one live row observed ${liveObs}× under ${new Set(fdb._obs.map((o) => o.providerRowId)).size} provider ids` +
              ` — INV-4 as currently implemented would read this as ${liveObs} live rows`);
}

// ── 3. The ordinary succession still works ─────────────────────────────────
console.log("\n3. A single pending → posted succession is still ONE event");
{
  const fdb = makeDb({ cursor: null, accounts: ACCOUNTS });
  await run(fdb, makeFakePlaid([
    { added: [pending("pend_S", "2026-08-05", -20)], next_cursor: "C1", has_more: true },
    { added: [posted("post_S", "2026-08-09", -20, "pend_S")], next_cursor: "C2" },
  ]));

  check("one event", fdb._events.length === 1, `${fdb._events.length}`);
  check("two observations on it", fdb._obs.length === 2, `${fdb._obs.length}`);
  check("the event is POSTED", fdb._events[0]?.lifecycle === "POSTED", fdb._events[0]?.lifecycle);
  check("economic date pinned to the FIRST observation",
    fdb._events[0]?.economicDate.toISOString().slice(0, 10) === "2026-08-05",
    fdb._events[0]?.economicDate.toISOString().slice(0, 10));
  check("no event has a stale stored projection", staleEvents(fdb).length === 0,
    staleEvents(fdb).join(" | "));
}

console.log(failures === 0 ? "\nAll pending-ref guard checks passed.\n" : `\n${failures} check(s) failed\n`);
if (failures > 0) process.exit(1);
}

main();
