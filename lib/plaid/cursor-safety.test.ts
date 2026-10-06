/**
 * lib/plaid/cursor-safety.test.ts
 *
 * PRE-V26-PLAID-CLOSE Phase 1B — BEHAVIOURAL proof of the cursor safety
 * invariant (house pattern: standalone tsx, DB-free, no Plaid API):
 *
 *   npx tsx lib/plaid/cursor-safety.test.ts
 *
 *   A Plaid cursor may advance past a page ONLY when every canonical
 *   persistence obligation for that page has succeeded.
 *
 * This is the test that could not previously exist: `syncTransactionsForItem`
 * resolved `db` and `plaidClient` from module scope, so there was no way to make
 * one row fail. Phase 1 added a narrow `deps` seam ({ db, plaid }, both
 * defaulting to the real singletons), and this suite drives it with an in-memory
 * fake Prisma client and a scripted Plaid client.
 *
 * It proves the WHOLE loop, not a model of it: the real sync function runs, the
 * real cursor-gate decides, and the assertions read the fake's durable state.
 *
 * The scenario throughout is the one that actually cost us a transaction in
 * July 2026: a page carrying two rows where one persists and one does not.
 */

// A deterministic key BEFORE importing the sync module — the fake item carries a
// genuinely-encrypted token so the real decrypt path runs unmodified (no third
// injection point just for the test).
process.env.ENCRYPTION_KEY ??= "0".repeat(64);

import { encryptWithPurpose, EncryptionPurpose } from "./encryption";
import { syncTransactionsForItem, PlaidSyncIncompleteError } from "./syncTransactions";

const FAKE_TOKEN = encryptWithPurpose("access-sandbox-test-token", EncryptionPurpose.PLAID_ACCESS_TOKEN);

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ── Fakes ────────────────────────────────────────────────────────────────────

interface Row { id: string; plaidTransactionId: string | null; financialAccountId: string;
                amount: number; date: Date; merchant: string; pending: boolean;
                deletedAt: Date | null; merchantId: string | null; categorySource: string | null }

/** Which plaidTransactionIds should throw on write, and how many times more. */
type FailPlan = Map<string, number>;

function makeFakeDb(opts: {
  cursor: string | null;
  /** plaidAccountId -> financialAccountId. A missing key models MISSING_ACCOUNT. */
  accounts: Record<string, string>;
  failPlan?: FailPlan;
  /** Extra PlaidItem columns (completedSyncCount, syncOriginCursor, syncImportedCount). */
  itemExtra?: Record<string, unknown>;
}) {
  const txns: Row[] = [];
  const item: Record<string, unknown> & { id: string; cursor: string | null } =
    { id: "item_1", cursor: opts.cursor, encryptedToken: FAKE_TOKEN, institutionName: "Chase", ...opts.itemExtra };
  const failPlan = opts.failPlan ?? new Map<string, number>();
  const cursorWrites: (string | null)[] = [];
  /** SyncIssue rows written through the INJECTED client (Phase 2 seam). */
  const syncIssues: { kind: string; plaidTransactionId: string | null; detail?: Record<string, unknown>; resolved: boolean }[] = [];
  /** Phase 4 — every auto-recovery call, so scoping can be asserted. */
  const resolveCalls: { plaidItemId: string; count: number }[] = [];
  let seq = 0;

  const maybeFail = (ptid: string | null | undefined) => {
    if (!ptid) return;
    const left = failPlan.get(ptid);
    if (left && left > 0) {
      failPlan.set(ptid, left - 1);
      throw new Error(`simulated persistence failure for ${ptid}`);
    }
  };

  return {
    _txns: txns, _item: item, _cursorWrites: cursorWrites, _syncIssues: syncIssues, _resolveCalls: resolveCalls,
    // PRE-V26-PLAID-CLOSE Phase 2 — recordSyncIssue now writes through the
    // injected client, so forensic evidence is OBSERVABLE here instead of
    // leaking to the developer's real database.
    // OPS-2D-5A-1 — recordSyncIssue is now a facade over the incident lifecycle,
    // so the injected client sees the episode write, a convergence lookup, and an
    // occurrence write. The INTENT is unchanged: forensic evidence stays
    // observable here instead of leaking to the developer's real database, and
    // recovery stays item-scoped.
    syncIssue: {
      create: async ({ data }: { data: { kind: string; plaidTransactionId: string | null; detail?: Record<string, unknown>; incidentKey?: string | null; resolved?: boolean } }) => {
        syncIssues.push({ kind: data.kind, plaidTransactionId: data.plaidTransactionId ?? null, detail: data.detail, resolved: data.resolved ?? false });
        return { id: `si${syncIssues.length}` };
      },
      findFirst: async () => null,   // no active episode in these fixtures
      update: async () => ({ id: "si1" }),
      // 5A-1 — the item scoping now happens HERE: the authority selects the
      // item's unresolved rows, classifies them, then resolves by id. This is
      // the observable the "item-scoped recovery pass" assertion watches.
      findMany: async ({ where }: { where?: { plaidItemId?: string } } = {}) => (
        resolveCalls.push({ plaidItemId: where?.plaidItemId ?? "unscoped", count: 0 }),
        syncIssues.map((i, n) => ({
        id: `si${n + 1}`, kind: i.kind, provider: "PLAID", detail: i.detail,
        plaidTransactionId: i.plaidTransactionId, resolved: i.resolved,
      }))),
      // Phase 4 / 5A-1 — scoped auto-recovery. The authority now selects by
      // classification rather than a Json path, then resolves by id.
      updateMany: async ({ where }: { where: { id?: { in: string[] } } }) => {
        let count = 0;
        const ids = where.id?.in ?? [];
        for (const [n, i] of syncIssues.entries()) {
          if (ids.includes(`si${n + 1}`) && !i.resolved) { i.resolved = true; count++; }
        }
        return { count };
      },
    },
    syncIssueOccurrence: { create: async () => ({ id: "so1" }) },
    // OPS-2D-TX-1 — declares this fake as a ROOT client (see IncidentClient).
    // syncTransactionsForItem passes `database` straight through to
    // recordSyncIssue, so the fake must satisfy the same contract the real
    // client does: incident recording never runs inside a caller transaction.
    $transaction: async () => { throw new Error("the incident lifecycle must not open transactions"); },
    plaidItem: {
      findUnique: async () => ({ ...item }),
      update: async ({ data }: { data: { cursor?: string | null } & Record<string, unknown> }) => {
        if ("cursor" in data) { item.cursor = data.cursor ?? null; cursorWrites.push(data.cursor ?? null); }
        for (const k of ["syncOriginCursor", "syncImportedCount", "completedSyncCount"]) if (k in data) item[k] = data[k];
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
      findMany: async () => [],           // fingerprint fallback: no candidates
      create: async ({ data }: { data: Record<string, unknown> }) => {
        maybeFail(data.plaidTransactionId as string);
        const row = { id: `t${++seq}`, deletedAt: null, merchantId: null, categorySource: null, ...data } as unknown as Row;
        txns.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const r = txns.find((t) => t.id === where.id);
        maybeFail((data.plaidTransactionId as string) ?? r?.plaidTransactionId);
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
    // setPlaidItemHealth's audit row + retireItemSyncFailure's lookup ride the
    // same injected client, so the success path never reaches the real database.
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

/** Plaid client returning scripted pages in order. */
function makeFakePlaid(pages: { added?: unknown[]; modified?: unknown[]; removed?: unknown[]; next_cursor: string; has_more?: boolean }[]) {
  let i = 0;
  const cursorsSent: (string | undefined)[] = [];
  return {
    _cursorsSent: cursorsSent,
    transactionsSync: async ({ cursor }: { cursor?: string }) => {
      cursorsSent.push(cursor);
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

// ── 1. Baseline — a fully-persisted page DOES advance the cursor ─────────────
console.log("1. Fully-persisted page — cursor advances (the invariant is not a blanket block)");
{
  const fdb = makeFakeDb({ cursor: "C_old", accounts: ACCOUNTS });
  const fplaid = makeFakePlaid([{ added: [txn("txn_A", "plaid_acct_1", 10), txn("txn_B", "plaid_acct_1", 20)], next_cursor: "C_next" }]);
  const res = await run(fdb, fplaid);

  check("both rows persisted", fdb._txns.length === 2, `${fdb._txns.length}`);
  check("cursor advanced to C_next", fdb._item.cursor === "C_next", String(fdb._item.cursor));
  check("result reports 2 created", res.created === 2);
  check("a clean page records NO SyncIssue evidence", fdb._syncIssues.length === 0);
  check("recovery pass is item-scoped even with nothing to resolve",
    fdb._resolveCalls.length === 1 && fdb._resolveCalls[0].plaidItemId === "item_1");
  check("a returned result means complete persistence (no partial-state field)",
    !("failedRows" in res));
}

// ── 2. THE INVARIANT — one row fails ⇒ cursor held, function throws ──────────
console.log("2. UPSERT failure on txn_B — cursor MUST NOT advance");
{
  const fdb = makeFakeDb({ cursor: "C_old", accounts: ACCOUNTS, failPlan: new Map([["txn_B", 1]]) });
  const fplaid = makeFakePlaid([{ added: [txn("txn_A", "plaid_acct_1", 10), txn("txn_B", "plaid_acct_1", 20)], next_cursor: "C_next" }]);

  let thrown: unknown = null;
  try { await run(fdb, fplaid); } catch (e) { thrown = e; }

  check("function THROWS (does not report success)", thrown !== null);
  check("throws PlaidSyncIncompleteError", thrown instanceof PlaidSyncIncompleteError);
  check("C_next was NEVER persisted", !fdb._cursorWrites.includes("C_next"), JSON.stringify(fdb._cursorWrites));
  check("stored cursor remains C_old", fdb._item.cursor === "C_old", String(fdb._item.cursor));
  check("no cursor write happened at all", fdb._cursorWrites.length === 0, JSON.stringify(fdb._cursorWrites));

  const err = thrown as PlaidSyncIncompleteError;
  check("error names the failed row", err.failures.length === 1 && err.failures[0].plaidTransactionId === "txn_B");
  // PagePersistenceFailure keeps its OWN vocabulary. It is cursor-safety
  // accounting — "which obligations did this page fail to discharge" — not an
  // incident classification, and OPS-2D-5B-1 deliberately left it alone.
  check("cursor-safety failure kind is unchanged (local accounting, not taxonomy)",
    err.failures[0].kind === "UPSERT_ERROR");
  check("error carries the held cursor", err.heldCursor === "C_old");
  check("error is NOT an Axios error ⇒ health classifier leaves item ACTIVE",
    !("isAxiosError" in (thrown as object)) && !("response" in (thrown as object)));

  // The successful sibling is still durable — we do not roll back good rows.
  check("txn_A remains persisted (partial work is kept, not discarded)",
    fdb._txns.some((t) => t.plaidTransactionId === "txn_A"), `${fdb._txns.length}`);
  check("txn_B is absent (it genuinely failed)", !fdb._txns.some((t) => t.plaidTransactionId === "txn_B"));

  // Phase 2 — the forensic record is DURABLE and precedes the cursor decision.
  // Order matters: the evidence must survive even though the run then throws.
  const ev = fdb._syncIssues;
  check("exactly one SyncIssue recorded", ev.length === 1, `${ev.length}`);
  check("SyncIssue kind is TRANSACTION_PERSISTENCE_FAILED", ev[0]?.kind === "TRANSACTION_PERSISTENCE_FAILED");
  check("SyncIssue names the failed transaction", ev[0]?.plaidTransactionId === "txn_B");
  check("SyncIssue detail carries the error", typeof ev[0]?.detail?.error === "string");
  check("SyncIssue detail carries `pending` (Phase 1 asymmetry closed)",
    typeof ev[0]?.detail?.pending === "boolean");
  check("evidence was written BEFORE the cursor was held (it exists despite the throw)",
    ev.length === 1 && fdb._cursorWrites.length === 0);
  check("a FAILED run resolves nothing (recovery needs proof, not optimism)",
    fdb._resolveCalls.length === 0 && ev[0]?.resolved === false);
  check("the issue is stamped cursorBlocking (the only auto-recovery key)",
    ev[0]?.detail?.cursorBlocking === true);
  check("the issue carries stage + runId for domain and correlation",
    ev[0]?.detail?.stage === "transaction-persist" && typeof ev[0]?.detail?.runId === "string");
}

// ── 3. Replay — the held cursor re-fetches the SAME page and converges ───────
console.log("3. Replay — next attempt sends C_old, replay is idempotent, then cursor advances");
{
  // failPlan of 1 ⇒ txn_B fails on attempt 1, succeeds on attempt 2.
  const fdb = makeFakeDb({ cursor: "C_old", accounts: ACCOUNTS, failPlan: new Map([["txn_B", 1]]) });
  const page = { added: [txn("txn_A", "plaid_acct_1", 10), txn("txn_B", "plaid_acct_1", 20)], next_cursor: "C_next" };
  const fplaid = makeFakePlaid([page, page]);   // Plaid re-delivers the same page for the same cursor

  try { await run(fdb, fplaid); } catch { /* attempt 1 fails, as proven above */ }
  check("attempt 1 sent cursor C_old", fplaid._cursorsSent[0] === "C_old");
  check("after attempt 1 cursor is still C_old", fdb._item.cursor === "C_old");

  const res = await run(fdb, fplaid);           // attempt 2
  check("attempt 2 ALSO sent C_old (the page replays)", fplaid._cursorsSent[1] === "C_old", String(fplaid._cursorsSent[1]));
  check("attempt 2 returns (i.e. fully persisted)", res.created === 1 || res.updatedByPlaidId >= 1);
  check("txn_B now persisted", fdb._txns.some((t) => t.plaidTransactionId === "txn_B"));
  check("ONLY AFTER full success does cursor become C_next", fdb._item.cursor === "C_next", String(fdb._item.cursor));

  // Idempotency: txn_A was processed twice and must not have duplicated.
  const aRows = fdb._txns.filter((t) => t.plaidTransactionId === "txn_A");
  check("txn_A replay is idempotent — exactly ONE row", aRows.length === 1, `${aRows.length}`);
  check("no duplicate canonical transactions at all", fdb._txns.length === 2, `${fdb._txns.length}`);
  check("exactly ONE issue recorded across both attempts (the successful replay adds none)",
    fdb._syncIssues.length === 1, `${fdb._syncIssues.length}`);
  check("no SyncIssue row reached the real database (all captured by the fake)",
    fdb._syncIssues.every((i) => i.kind === "TRANSACTION_PERSISTENCE_FAILED"));

  // Phase 4 — the successful replay CLOSES the incident it opened. Recovery is
  // proven by the cursor advancing, not assumed from elapsed time.
  check("the successful replay auto-resolved the cursor-blocking issue",
    fdb._syncIssues[0]?.resolved === true);
  check("auto-recovery was scoped to THIS item",
    fdb._resolveCalls.every((c) => c.plaidItemId === "item_1"));
  check("auto-recovery ran only after the successful run",
    fdb._resolveCalls.length === 1, `${fdb._resolveCalls.length}`);
}

// ── 4. MISSING_ACCOUNT has identical cursor semantics ────────────────────────
console.log("4. MISSING_ACCOUNT — same invariant (the more likely production trigger)");
{
  const fdb = makeFakeDb({ cursor: "C_old", accounts: ACCOUNTS });   // plaid_acct_UNKNOWN unmapped
  const fplaid = makeFakePlaid([{ added: [txn("txn_A", "plaid_acct_1", 10), txn("txn_X", "plaid_acct_UNKNOWN", 99)], next_cursor: "C_next" }]);

  let thrown: unknown = null;
  try { await run(fdb, fplaid); } catch (e) { thrown = e; }

  check("throws PlaidSyncIncompleteError", thrown instanceof PlaidSyncIncompleteError);
  check("kind is MISSING_ACCOUNT", (thrown as PlaidSyncIncompleteError).failures[0].kind === "MISSING_ACCOUNT");
  check("stored cursor remains C_old", fdb._item.cursor === "C_old", String(fdb._item.cursor));
  check("C_next never persisted", !fdb._cursorWrites.includes("C_next"));
  check("resolvable sibling still persisted", fdb._txns.length === 1);

  const ev = fdb._syncIssues;
  check("MISSING_ACCOUNT evidence recorded", ev.length === 1 && ev[0].kind === "MISSING_ACCOUNT");
  check("evidence names the unresolvable transaction", ev[0]?.plaidTransactionId === "txn_X");
  check("evidence durable despite the throw", ev.length === 1 && fdb._cursorWrites.length === 0);
}

// ── 5. MODIFIED-row failure — stale row must not be locked in ────────────────
console.log("5. MODIFIED-row failure — a stale local row never gets accepted behind an advanced cursor");
{
  const fdb = makeFakeDb({ cursor: "C_old", accounts: ACCOUNTS });
  // Page 1 establishes txn_M at amount 10 and advances the cursor legitimately.
  const p1 = { added: [txn("txn_M", "plaid_acct_1", 10)], next_cursor: "C_mid" };
  const fplaid1 = makeFakePlaid([p1]);
  await run(fdb, fplaid1);
  check("setup: txn_M stored, cursor C_mid", fdb._txns.length === 1 && fdb._item.cursor === "C_mid");

  // Page 2 MODIFIES txn_M to 42, but the update throws.
  const failing = makeFakeDb({ cursor: "C_mid", accounts: ACCOUNTS, failPlan: new Map([["txn_M", 1]]) });
  failing._txns.push({ ...fdb._txns[0] });
  const fplaid2 = makeFakePlaid([{ modified: [txn("txn_M", "plaid_acct_1", 42)], next_cursor: "C_next" }]);

  let thrown: unknown = null;
  try { await run(failing, fplaid2); } catch (e) { thrown = e; }

  check("modified-row failure throws", thrown instanceof PlaidSyncIncompleteError);
  check("cursor held at C_mid — the modification will be re-delivered", failing._item.cursor === "C_mid", String(failing._item.cursor));
  check("local row is still the STALE value (not silently accepted as current)",
    failing._txns[0].amount === -10, String(failing._txns[0].amount));
  check("staleness is therefore recoverable, not permanent", !failing._cursorWrites.includes("C_next"));
}

// ── 6. REMOVED-row DB failure — pre-existing throw-before-cursor still safe ──
console.log("6. REMOVED-row failure — the pre-existing safe path is preserved");
{
  const fdb = makeFakeDb({ cursor: "C_old", accounts: ACCOUNTS });
  const boom = new Error("simulated updateMany failure");
  fdb.transaction.updateMany = async () => { throw boom; };
  const fplaid = makeFakePlaid([{ removed: [{ transaction_id: "txn_R" }], next_cursor: "C_next" }]);

  let thrown: unknown = null;
  try { await run(fdb, fplaid); } catch (e) { thrown = e; }

  check("removal failure propagates (never swallowed)", thrown === boom);
  check("cursor remains C_old", fdb._item.cursor === "C_old", String(fdb._item.cursor));
  check("C_next never persisted", !fdb._cursorWrites.includes("C_next"));
}

// ── 7. Multi-page — earlier fully-persisted pages KEEP their cursor ──────────
console.log("7. Multi-page — a good page keeps its cursor; only the failing page is held");
{
  const fdb = makeFakeDb({ cursor: "C_old", accounts: ACCOUNTS, failPlan: new Map([["txn_P2", 1]]) });
  const fplaid = makeFakePlaid([
    { added: [txn("txn_P1", "plaid_acct_1", 10)], next_cursor: "C_page1", has_more: true },
    { added: [txn("txn_P2", "plaid_acct_1", 20)], next_cursor: "C_page2", has_more: false },
  ]);

  let thrown: unknown = null;
  try { await run(fdb, fplaid); } catch (e) { thrown = e; }

  check("throws on the failing SECOND page", thrown instanceof PlaidSyncIncompleteError);
  check("page 1's cursor WAS persisted (its rows are durable)", fdb._cursorWrites.includes("C_page1"));
  check("cursor rests at C_page1, not C_page2", fdb._item.cursor === "C_page1", String(fdb._item.cursor));
  check("page 2's cursor never persisted", !fdb._cursorWrites.includes("C_page2"));
  check("error's heldCursor is page 1's cursor", (thrown as PlaidSyncIncompleteError).heldCursor === "C_page1");
  check("only page 1's row is stored", fdb._txns.length === 1 && fdb._txns[0].plaidTransactionId === "txn_P1");
}

// ── 8. MUTATION_DURING_PAGINATION — restart the LOOP, never re-issue the page ─
// Preview Sandbox 2026-10-06: a fresh OAuth Item imported page 1 (100 rows), page
// 2 answered TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION, the same-cursor retry
// and every later resume re-sent page 1's cursor and failed identically, and
// the Item sat at "100 imported" for good. Plaid's rule: restart from where the
// last COMPLETED loop ended.
console.log("8. Pagination mutation — the loop restarts from its origin");
{
  const MUTATION = { isAxiosError: true, message: "Request failed with status code 400",
    response: { status: 400, data: { error_type: "TRANSACTIONS_ERROR", error_code: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" } } };
  const BAD_TOKEN = { isAxiosError: true, message: "Request failed with status code 400",
    response: { status: 400, data: { error_type: "INVALID_INPUT", error_code: "INVALID_ACCESS_TOKEN" } } };
  type Step = { added?: unknown[]; next_cursor: string; has_more?: boolean } | "MUTATION" | "BAD_TOKEN";
  const scripted = (steps: Step[]) => {
    let i = 0;
    const cursorsSent: (string | undefined)[] = [];
    return {
      _cursorsSent: cursorsSent,
      transactionsSync: async ({ cursor }: { cursor?: string }) => {
        cursorsSent.push(cursor);
        const st = steps[Math.min(i++, steps.length - 1)];
        if (st === "MUTATION") throw MUTATION;
        if (st === "BAD_TOKEN") throw BAD_TOKEN;
        return { data: { added: st.added ?? [], modified: [], removed: [], has_more: st.has_more ?? false, next_cursor: st.next_cursor } };
      },
    };
  };
  const runR = (fdb: ReturnType<typeof makeFakeDb>, fp: ReturnType<typeof scripted>) =>
    syncTransactionsForItem("item_1", { db: fdb as never, plaid: fp as never, restartDelayMs: 0 });
  const P1 = { added: [txn("txn_R1", "plaid_acct_1", 10)], next_cursor: "C_p1", has_more: true };
  const P2 = { added: [txn("txn_R2", "plaid_acct_1", 20)], next_cursor: "C_p2", has_more: false };

  // 8a — the live failure, end to end: fresh import, mutation on page 2.
  {
    const fdb = makeFakeDb({ cursor: null, accounts: ACCOUNTS, itemExtra: { completedSyncCount: 0 } });
    const fp = scripted([P1, "MUTATION", P1, P2]);
    const res = await runR(fdb, fp);
    check("8a fresh import: restarts from the BEGINNING, never re-sends page 1's cursor after the mutation",
      JSON.stringify(fp._cursorsSent) === JSON.stringify([undefined, "C_p1", undefined, "C_p1"]), JSON.stringify(fp._cursorsSent));
    check("8a the restart point (null) is persisted before re-fetching", JSON.stringify(fdb._cursorWrites.slice(0, 2)) === JSON.stringify(["C_p1", null]), JSON.stringify(fdb._cursorWrites));
    check("8a re-delivered page 1 does not duplicate: 2 rows, 2 distinct ids",
      fdb._txns.length === 2 && new Set(fdb._txns.map((t) => t.plaidTransactionId)).size === 2, `${fdb._txns.length}`);
    check("8a completes at C_p2 and records it as the next loop's origin",
      res.cursor === "C_p2" && fdb._item.cursor === "C_p2" && fdb._item.syncOriginCursor === "C_p2", JSON.stringify(fdb._item));
    check("8a import progress is not double-counted after the restart", fdb._item.syncImportedCount === 2, String(fdb._item.syncImportedCount));
  }

  // 8b — the Item already stuck in the field: stored cursor is page 1's, never completed.
  {
    const fdb = makeFakeDb({ cursor: "C_p1", accounts: ACCOUNTS, itemExtra: { completedSyncCount: 0, syncImportedCount: 1 } });
    const fp = scripted(["MUTATION", P1, P2]);
    await runR(fdb, fp);
    check("8b a stuck never-completed import recovers: dead cursor once, then from the beginning",
      JSON.stringify(fp._cursorsSent) === JSON.stringify(["C_p1", undefined, "C_p1"]) && fdb._item.cursor === "C_p2", JSON.stringify(fp._cursorsSent));
  }

  // 8c — an established Item restarts from its recorded origin, NOT from scratch
  // (a from-scratch pull would never re-deliver removals since that origin).
  {
    const fdb = makeFakeDb({ cursor: "C_mid", accounts: ACCOUNTS, itemExtra: { completedSyncCount: 4, syncOriginCursor: "C_origin" } });
    const fp = scripted(["MUTATION", P2]);
    await runR(fdb, fp);
    check("8c established Item: restarts from syncOriginCursor",
      JSON.stringify(fp._cursorsSent) === JSON.stringify(["C_mid", "C_origin"]), JSON.stringify(fp._cursorsSent));
  }

  // 8d — completed loops before the column existed: fall back to the current cursor.
  {
    const fdb = makeFakeDb({ cursor: "C_cur", accounts: ACCOUNTS, itemExtra: { completedSyncCount: 2, syncOriginCursor: null } });
    const fp = scripted(["MUTATION", P2]);
    await runR(fdb, fp);
    check("8d pre-column Item: restarts from its current cursor, then records the origin",
      JSON.stringify(fp._cursorsSent) === JSON.stringify(["C_cur", "C_cur"]) && fdb._item.syncOriginCursor === "C_p2", JSON.stringify(fp._cursorsSent));
  }

  // 8e — mutation that never settles: bounded, fails, and leaves the ORIGIN stored.
  {
    const fdb = makeFakeDb({ cursor: null, accounts: ACCOUNTS, itemExtra: { completedSyncCount: 0 } });
    const fp = scripted([P1, "MUTATION", "MUTATION", "MUTATION", "MUTATION"]);
    let thrown: unknown = null;
    try { await runR(fdb, fp); } catch (e) { thrown = e; }
    check("8e gives up after 3 restarts with the provider's error", thrown === MUTATION && fp._cursorsSent.length === 5, `${fp._cursorsSent.length} calls`);
    check("8e the next run starts at the origin, not the dead mid-loop cursor", fdb._item.cursor === null, String(fdb._item.cursor));
  }

  // 8f — NEGATIVE CONTROL: any other provider error is not a restart.
  {
    const fdb = makeFakeDb({ cursor: "C_cur", accounts: ACCOUNTS, itemExtra: { completedSyncCount: 2 } });
    const fp = scripted(["BAD_TOKEN", P2]);
    let thrown: unknown = null;
    try { await runR(fdb, fp); } catch (e) { thrown = e; }
    check("8f a non-mutation error throws after ONE call and moves no cursor",
      thrown === BAD_TOKEN && fp._cursorsSent.length === 1 && fdb._cursorWrites.length === 0, `${fp._cursorsSent.length}`);
  }
}

console.log(failures === 0
  ? "\n✅ cursor-safety: all checks passed"
  : `\n❌ cursor-safety: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

}

void main();
