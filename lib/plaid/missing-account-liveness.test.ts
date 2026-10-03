/**
 * lib/plaid/missing-account-liveness.test.ts
 *
 * THE LIVENESS FAILURE, REPRODUCED — THEN THE CONVERGENCE, PROVED.
 *
 *   npx tsx lib/plaid/missing-account-liveness.test.ts
 *
 * House pattern: standalone tsx, DB-free, no Plaid API. It drives the REAL
 * `syncTransactionsForItem` through its `{ db, plaid }` seam and the REAL
 * `recoverMissingPlaidAccountsForItem` through its `{ runPhase, ... }` seam, so
 * both the failure and the repair are measured on shipped code rather than on a
 * model of it.
 *
 *   §1 THE FAILURE. A page carrying a transaction for an account that does not
 *      exist locally cannot persist, so the cursor-safety gate holds the cursor
 *      — correctly. Replaying it produces the IDENTICAL outcome. That is the
 *      defect: not a lost transaction, but an item that can never make forward
 *      progress, re-fetching and re-billing one Plaid page forever.
 *   §2 THE CONVERGENCE. Recovery creates the account from the provider's own
 *      list, and the same page then persists and the cursor advances.
 *   §3 THE REFUSALS, each one load-bearing, each proved to make NO provider
 *      call and NO write when it fires.
 *
 * ⚠️ §1 IS WHAT MAKES §2 MEAN ANYTHING. "The page persisted" is also what a
 * suite that never blocked the page would report, so the block is established
 * first, twice, over the same fixture the repair then fixes.
 */

process.env.ENCRYPTION_KEY ??= "0".repeat(64);

import { encryptWithPurpose, EncryptionPurpose } from "./encryption";
import { syncTransactionsForItem, PlaidSyncIncompleteError } from "./syncTransactions";
import { recoverMissingPlaidAccountsForItem } from "@/lib/accounts/recover-plaid-account";

const FAKE_TOKEN = encryptWithPurpose("access-sandbox-test-token", EncryptionPurpose.PLAID_ACCESS_TOKEN);

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ── Fakes ────────────────────────────────────────────────────────────────────
// `accounts` maps plaidAccountId -> financialAccountId. A MISSING KEY is what
// models the defect, and it is the same device lib/plaid/cursor-safety.test.ts
// uses. `softDeleted` marks a key as an account the owner REMOVED, which must
// never be recreated.
function makeFakeDb(opts: { accounts: Record<string, string>; softDeleted?: Set<string> }) {
  const txns: { id: string; plaidTransactionId: string | null; financialAccountId: string; deletedAt: Date | null }[] = [];
  const item = { id: "item_1", cursor: null as string | null, encryptedToken: FAKE_TOKEN, institutionName: "Chase" };
  const cursorWrites: (string | null)[] = [];
  const syncIssues: { kind: string; plaidTransactionId: string | null; detail?: Record<string, unknown>; resolved: boolean }[] = [];
  let seq = 0;

  return {
    _txns: txns, _item: item, _cursorWrites: cursorWrites, _syncIssues: syncIssues,
    _accounts: opts.accounts,
    syncIssue: {
      // ⚠️ `detail` IS CARRIED. The auto-resolution authority classifies an
      // episode from its detail (cursorBlocking), so a fake that drops it makes
      // recovery unreachable — measured: §2's resolution assertion failed until
      // this was threaded through.
      create: async ({ data }: { data: { kind: string; plaidTransactionId: string | null; detail?: Record<string, unknown>; resolved?: boolean } }) => (
        syncIssues.push({ kind: data.kind, plaidTransactionId: data.plaidTransactionId ?? null, detail: data.detail, resolved: data.resolved ?? false }),
        { id: `si${syncIssues.length}` }),
      findFirst: async () => null,
      update:    async () => ({ id: "si1" }),
      findMany:  async () => syncIssues.map((i, n) => ({
        id: `si${n + 1}`, kind: i.kind, provider: "PLAID", detail: i.detail,
        plaidTransactionId: i.plaidTransactionId, resolved: i.resolved,
      })),
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
        if (!faId) return null;
        return { financialAccount: { id: faId, deletedAt: opts.softDeleted?.has(where.externalAccountId) ? new Date() : null } };
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
      findMany: async () => [],
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `t${++seq}`, deletedAt: null, ...data } as unknown as (typeof txns)[number];
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

const txn = (id: string, acct: string) => ({
  transaction_id: id, account_id: acct, amount: 12.34, date: "2026-07-02",
  name: `NAME ${id}`, merchant_name: `MERCH ${id}`, pending: false, iso_currency_code: "USD",
});

/** Returns the SAME page every call — which is exactly what a held cursor does. */
function makeFakePlaid(added: unknown[]) {
  const cursorsSent: (string | undefined)[] = [];
  return {
    _cursorsSent: cursorsSent,
    transactionsSync: async ({ cursor }: { cursor?: string }) => (
      cursorsSent.push(cursor),
      { data: { added, modified: [], removed: [], has_more: false, next_cursor: "cursor_after_page_1" } }),
  };
}

const PRESENT = "plaid_acct_1";
const MISSING = "plaid_acct_2";
const PAGE = [txn("tx_present", PRESENT), txn("tx_orphan", MISSING)];

const runSync = (fdb: ReturnType<typeof makeFakeDb>, fplaid: ReturnType<typeof makeFakePlaid>) =>
  syncTransactionsForItem("item_1", { db: fdb as never, plaid: fplaid as never });

/** A provider account as `accountsGet` returns it. */
const providerAccount = (id: string) => ({
  account_id: id, name: "Recovered Checking", official_name: "Chase Total Checking",
  mask: "4321", type: "depository", subtype: "checking",
  balances: { current: 100, available: 90, limit: null, iso_currency_code: "USD" },
});

/**
 * Recovery deps whose phase writes into the SAME fake the sync reads, so a
 * created account genuinely becomes resolvable and §2's convergence is CAUSAL
 * rather than asserted.
 */
function recoveryDeps(fdb: ReturnType<typeof makeFakeDb>, over: {
  ownerDeactivated?: boolean;
  blocking?: number;
  providerAccounts?: ReturnType<typeof providerAccount>[];
  siblingLink?: { spaceId: string; addedByUserId: string | null } | null;
} = {}) {
  const calls = { fetchProviderAccounts: 0, created: [] as string[], linksWritten: 0, connectionsWritten: 0 };
  const deps = {
    loadItem: async () => ({
      userId: "u1", ownerDeactivated: over.ownerDeactivated ?? false,
      accessToken: "plaintext-token", institutionName: "Chase", institutionId: "ins_1",
    }),
    countBlockingIssues: async () => over.blocking ?? 1,
    fetchProviderAccounts: async () => {
      calls.fetchProviderAccounts++;
      return over.providerAccounts ?? [providerAccount(MISSING)];
    },
    runPhase: async <T,>(_userId: string, fn: (tx: never) => Promise<T>): Promise<T> => fn({
      spaceAccountLink: {
        // The Space-evidence read. `undefined` in `over` means "a sibling link
        // exists"; an explicit `null` is the no-evidence case.
        findFirst: async () => (over.siblingLink === undefined ? { spaceId: "space_1", addedByUserId: "u1" } : over.siblingLink),
        // persistAccountSpine → dualWriteSpaceAccountLink → computeLinkKind.
        // Zero existing links ⇒ this account's link is its HOME, which is what
        // a recovered account's first link should be.
        count:   async () => 0,
        upsert:  async () => { calls.linksWritten++; return { id: "sal_recovered" }; },
        findMany: async () => [],
      },
      accountConnection: {
        findFirst:  async () => null,
        upsert:     async () => { calls.connectionsWritten++; return { id: "conn_recovered" }; },
        create:     async () => { calls.connectionsWritten++; return { id: "conn_recovered" }; },
        updateMany: async () => ({ count: 0 }),
      },
      providerAccountIdentity: fdb.providerAccountIdentity,
      financialAccount: {
        ...fdb.financialAccount,
        create: async ({ data }: { data: { plaidAccountId: string } }) => {
          const id = `fa_recovered_${data.plaidAccountId}`;
          // The account becomes resolvable, which is the whole point.
          fdb._accounts[data.plaidAccountId] = id;
          calls.created.push(id);
          return { id };
        },
      },
    } as never),
    writeIdentity: async () => {},
  };
  return { deps, calls };
}

async function main(): Promise<void> {
  // ══ 1. THE FAILURE, AND THAT IT CANNOT MAKE PROGRESS ══════════════════════
  console.log("\n1. a transaction for an account that does not exist pins the cursor — forever");
  {
    const fdb = makeFakeDb({ accounts: { [PRESENT]: "fa_checking" } });
    const fplaid = makeFakePlaid(PAGE);

    // DENOMINATOR: the page really does carry a row for each account, and one of
    // them really is unresolvable. Without this, "it threw" proves nothing.
    check("DENOMINATOR: the page carries 2 rows, exactly 1 of which has no account",
      PAGE.length === 2 && fdb._accounts[PRESENT] !== undefined && fdb._accounts[MISSING] === undefined);

    let threw1 = "(none)";
    try { await runSync(fdb, fplaid); } catch (e) { threw1 = e instanceof Error ? e.name : String(e); }

    check("attempt 1 THROWS PlaidSyncIncompleteError", threw1 === PlaidSyncIncompleteError.name, `threw=${threw1}`);
    check("attempt 1 wrote a MISSING_ACCOUNT SyncIssue naming the orphan row",
      fdb._syncIssues.some((i) => i.kind === "MISSING_ACCOUNT" && i.plaidTransactionId === "tx_orphan"),
      JSON.stringify(fdb._syncIssues));
    check("attempt 1 did NOT advance the cursor", fdb._cursorWrites.length === 0 && fdb._item.cursor === null,
      `writes=${JSON.stringify(fdb._cursorWrites)} cursor=${fdb._item.cursor}`);

    // THE LIVENESS CLAIM. Replay the identical page and compare the WHOLE
    // outcome: same throw, same held cursor, and Plaid asked from the same
    // place. Nothing the system did changed anything the next attempt sees.
    const txnsAfter1 = fdb._txns.length;
    let threw2 = "(none)";
    try { await runSync(fdb, fplaid); } catch (e) { threw2 = e instanceof Error ? e.name : String(e); }

    check("attempt 2 THROWS IDENTICALLY — no forward progress", threw2 === threw1, `1=${threw1} 2=${threw2}`);
    check("attempt 2 still did not advance the cursor", fdb._cursorWrites.length === 0 && fdb._item.cursor === null);
    check("both attempts fetched from the SAME cursor position — the same Plaid page, re-fetched and re-billed",
      fplaid._cursorsSent.length === 2 && fplaid._cursorsSent[0] === fplaid._cursorsSent[1],
      JSON.stringify(fplaid._cursorsSent));
    check("the resolvable row persisted and the orphan did not, on both attempts",
      fdb._txns.length === txnsAfter1 && fdb._txns.every((t) => t.plaidTransactionId !== "tx_orphan")
        && fdb._txns.some((t) => t.plaidTransactionId === "tx_present"),
      `${fdb._txns.length} row(s): ${fdb._txns.map((t) => t.plaidTransactionId).join(",")}`);
  }

  // ══ 2. THE CONVERGENCE ════════════════════════════════════════════════════
  console.log("\n2. recovery creates the account from the provider's list, and the page then persists");
  {
    const fdb = makeFakeDb({ accounts: { [PRESENT]: "fa_checking" } });
    const fplaid = makeFakePlaid(PAGE);
    try { await runSync(fdb, fplaid); } catch { /* blocked, as proved in §1 */ }
    check("PRE-STATE: blocked, cursor held, orphan unpersisted",
      fdb._item.cursor === null && !fdb._txns.some((t) => t.plaidTransactionId === "tx_orphan"));

    const { deps, calls } = recoveryDeps(fdb);
    const outcome = await recoverMissingPlaidAccountsForItem("item_1", deps as never);

    check("recovery was ATTEMPTED (the blocking issue is the trigger)", outcome.attempted, JSON.stringify(outcome));
    check("it CREATED exactly the missing account, from accountsGet",
      outcome.results.length === 1 && outcome.results[0].status === "CREATED"
        && outcome.results[0].plaidAccountId === MISSING && calls.created.length === 1,
      JSON.stringify(outcome.results));

    // Now the identical page, a third time. This is the convergence.
    let threw3 = "(none)";
    try { await runSync(fdb, fplaid); } catch (e) { threw3 = e instanceof Error ? e.name : String(e); }

    check("the SAME page now persists — no throw", threw3 === "(none)", `threw=${threw3}`);
    // A completed sync writes the cursor per page AND once after the loop, so
    // the COUNT is not 1 — measured. What matters is that it moved off null,
    // which §1 proved it could not do.
    check("the cursor ADVANCED off the held position", fdb._cursorWrites.length >= 1 && fdb._item.cursor === "cursor_after_page_1",
      `writes=${JSON.stringify(fdb._cursorWrites)} cursor=${fdb._item.cursor}`);
    check("the previously-orphaned transaction is persisted — provider evidence was NOT dropped",
      fdb._txns.some((t) => t.plaidTransactionId === "tx_orphan"),
      fdb._txns.map((t) => t.plaidTransactionId).join(","));
    check("the MISSING_ACCOUNT issue was auto-resolved by the run that proved recovery",
      fdb._syncIssues.filter((i) => i.kind === "MISSING_ACCOUNT").every((i) => i.resolved),
      JSON.stringify(fdb._syncIssues));
  }

  // ══ 3. THE REFUSALS ═══════════════════════════════════════════════════════
  console.log("\n3. every refusal, and each one makes no provider call or no write");
  {
    // THE PURGE WINDOW. purge.ts hard-deletes a user's accounts at step 5 and
    // only cascades PlaidItem at step 8's user.delete, so an ACTIVE item can
    // briefly have no accounts. resume-stale-imports gates on deactivatedAt;
    // the WEBHOOK path does not — so the guard lives here, and it must fire
    // BEFORE the provider call so a deactivating user accrues no Plaid spend.
    const fdb1 = makeFakeDb({ accounts: {} });
    const { deps: d1, calls: c1 } = recoveryDeps(fdb1, { ownerDeactivated: true });
    const o1 = await recoverMissingPlaidAccountsForItem("item_1", d1 as never);
    check("a DEACTIVATED owner (incl. pending deletion) is refused before any provider call",
      !o1.attempted && o1.skipped === "OWNER_INACTIVE" && c1.fetchProviderAccounts === 0 && c1.created.length === 0,
      `${JSON.stringify(o1)} fetches=${c1.fetchProviderAccounts}`);

    // No blocking issue ⇒ nothing to repair ⇒ not one provider call. This is
    // what keeps the healthy path free.
    const fdb2 = makeFakeDb({ accounts: {} });
    const { deps: d2, calls: c2 } = recoveryDeps(fdb2, { blocking: 0 });
    const o2 = await recoverMissingPlaidAccountsForItem("item_1", d2 as never);
    check("NO blocking issue ⇒ not attempted, and ZERO provider calls on a healthy item",
      !o2.attempted && o2.skipped === "NO_BLOCKING_ISSUE" && c2.fetchProviderAccounts === 0,
      `${JSON.stringify(o2)} fetches=${c2.fetchProviderAccounts}`);

    // SOFT-DELETED: the owner removed it. Recreating it would be worse than the
    // defect, so it is refused even though the item is blocked.
    const fdb3 = makeFakeDb({ accounts: { [MISSING]: "fa_removed" }, softDeleted: new Set([MISSING]) });
    const { deps: d3, calls: c3 } = recoveryDeps(fdb3);
    const o3 = await recoverMissingPlaidAccountsForItem("item_1", d3 as never);
    check("a SOFT-DELETED account is never restored — REFUSED/PREVIOUSLY_REMOVED, nothing created",
      o3.attempted && o3.results[0]?.status === "REFUSED"
        && (o3.results[0] as { reason: string }).reason === "PREVIOUSLY_REMOVED" && c3.created.length === 0,
      JSON.stringify(o3.results));

    // Already present: nothing was missing.
    const fdb4 = makeFakeDb({ accounts: { [MISSING]: "fa_live" } });
    const { deps: d4, calls: c4 } = recoveryDeps(fdb4);
    const o4 = await recoverMissingPlaidAccountsForItem("item_1", d4 as never);
    check("an account that ALREADY resolves is REFUSED/ALREADY_PRESENT, nothing created",
      o4.attempted && (o4.results[0] as { reason?: string })?.reason === "ALREADY_PRESENT" && c4.created.length === 0,
      JSON.stringify(o4.results));

    // No sibling link ⇒ no evidence of which Space the owner chose ⇒ refuse,
    // rather than inventing a placement.
    const fdb5 = makeFakeDb({ accounts: {} });
    const { deps: d5, calls: c5 } = recoveryDeps(fdb5, { siblingLink: null });
    const o5 = await recoverMissingPlaidAccountsForItem("item_1", d5 as never);
    check("NO sibling link ⇒ REFUSED/NO_SPACE_EVIDENCE — a Space is never invented",
      o5.attempted && (o5.results[0] as { reason?: string })?.reason === "NO_SPACE_EVIDENCE" && c5.created.length === 0,
      JSON.stringify(o5.results));
  }

  console.log(
    failures === 0
      ? "\n✅ the missing-account block is reproduced, proved non-progressing, and converges — with every refusal intact.\n"
      : `\n❌ ${failures} failure(s)\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
