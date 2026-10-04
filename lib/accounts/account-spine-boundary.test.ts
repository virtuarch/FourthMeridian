/**
 * lib/accounts/account-spine-boundary.test.ts
 *
 * THE CANONICAL ACCOUNT-SPINE MUTATION IS ONE TRANSACTION, AND THE PROVIDER
 * CALL IS NOT IN IT.
 *
 *   npx tsx lib/accounts/account-spine-boundary.test.ts
 *
 * House pattern: standalone tsx, DB-free, no Plaid API. It drives the REAL
 * `resolveAccountByFingerprint` against a ROOT-SHAPED fake whose `$transaction`
 * has REAL ROLLBACK SEMANTICS — it snapshots the world on entry and restores it
 * on throw. That is what makes the partial-commit claim a measurement instead of
 * an assertion about code shape.
 *
 * ⚠️ WHY A SECOND FAKE RATHER THAN reconcile.test.ts's. That one is deliberately
 * WITHOUT `$transaction`, because `mergeArchivedDuplicateIntoCanonical`'s
 * capability test (`"$transaction" in client`) would otherwise take the other
 * branch and recurse. It therefore cannot see transaction BOUNDARIES at all,
 * which is the only thing this file is about. Both fakes are correct for their
 * own question.
 *
 * ══ WHAT WAS WRONG ═════════════════════════════════════════════════════════
 *
 * For a cohort of N matching accounts, `pickCanonicalAndMerge` ran:
 *
 *     candidate sweep                      (autocommit, ×2)
 *     transaction.count per candidate      (autocommit, ×N)
 *     ┌ $transaction ─ fold loser 1 ─┐ COMMIT
 *     closeOutAccountConnections(loser 1)  (autocommit + PROVIDER HTTP)
 *     ┌ $transaction ─ fold loser 2 ─┐ COMMIT
 *     closeOutAccountConnections(loser 2)  (autocommit + PROVIDER HTTP)
 *
 * so a failure on loser 2 left loser 1 FULLY FOLDED AND COMMITTED — its
 * transactions re-pointed, its DebtProfile moved, its links copied to the
 * winner, a DuplicateAccountCandidate written, the row archived — while loser 2
 * was untouched. One canonical account-graph mutation, committed in pieces.
 *
 * The interleaved provider call is why it was built that way and must stay
 * outside: `disconnectPlaidItemIfOrphaned` counts live connections on
 * `systemDb`, a DIFFERENT client with a different pool, and returns silently
 * unless the count is zero. An uncommitted soft-delete is invisible to it, so
 * the close-out must be committed before `itemRemove` is considered.
 *
 * ══ WHAT IT IS NOW ═════════════════════════════════════════════════════════
 *
 *     ┌ ONE $transaction ─ sweep, elect, fold EVERY loser, close out their
 *     │                    connections, capture the provider work ─┐ COMMIT
 *     then: the caller dispatches the captured provider revocations
 *
 * so the mutation is atomic and the provider call still happens after a commit
 * that the orphan gate's own connection can see.
 */

import { DuplicateDetectionSource } from "@prisma/client";
import { resolveAccountByFingerprint } from "./reconcile";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

type Acct = { id: string; ownerUserId: string | null; deletedAt: Date | null; createdAt: Date };
type World = {
  accounts: Acct[];
  transactions: { id: string; financialAccountId: string; deletedAt: Date | null }[];
  debtProfiles: { id: string; financialAccountId: string }[];
  links: { id: string; spaceId: string; financialAccountId: string; addedByUserId: string | null; visibilityLevel: string; status: string }[];
  candidates: { a: string; b: string }[];
  connections: { id: string; financialAccountId: string; plaidItemDbId: string | null; deletedAt: Date | null }[];
};

/** Statement log entry: which transaction it ran in, or the root (autocommit). */
type Stmt = { scope: string; stmt: string };

function makeRootClient(w: World, opts: { failFoldOf?: string } = {}) {
  const log: Stmt[] = [];
  /** Non-null while inside a simulated transaction. */
  let scope = "root";
  let txCount = 0;
  const say = (stmt: string) => log.push({ scope, stmt });

  const clone = (): World => ({
    accounts:     w.accounts.map((a) => ({ ...a })),
    transactions: w.transactions.map((t) => ({ ...t })),
    debtProfiles: w.debtProfiles.map((d) => ({ ...d })),
    links:        w.links.map((l) => ({ ...l })),
    candidates:   w.candidates.map((c) => ({ ...c })),
    connections:  w.connections.map((c) => ({ ...c })),
  });
  const restore = (snap: World) => {
    w.accounts = snap.accounts; w.transactions = snap.transactions; w.debtProfiles = snap.debtProfiles;
    w.links = snap.links; w.candidates = snap.candidates; w.connections = snap.connections;
  };

  const statements = {
    financialAccount: {
      // TWO DIFFERENT CALLERS SHARE THIS METHOD, and conflating them is how a
      // probe lies. `findCandidatesByFingerprint` filters on `deletedAt` and
      // returns the cohort; `assertAccountReparentingAuthorized` asks
      // `{ id: { in: [...] } }` for owners only. Measured: a first version
      // ignored `id.in`, so the guard resolved no owners and REFUSED the fold —
      // which the probe then reported as "atomic", for entirely the wrong reason.
      findMany: async (a: { where: { id?: { in: string[] }; deletedAt?: null | { not: null } } }) => {
        if (a.where.id?.in) {
          say("financialAccount.findMany(owners)");
          const wanted = new Set(a.where.id.in);
          return w.accounts.filter((x) => wanted.has(x.id)).map((x) => ({ id: x.id, ownerUserId: x.ownerUserId }));
        }
        say("financialAccount.findMany");
        const wantArchived = a.where.deletedAt !== null && a.where.deletedAt !== undefined;
        return w.accounts
          .filter((x) => (wantArchived ? x.deletedAt !== null : x.deletedAt === null))
          .sort((p, q) => p.createdAt.getTime() - q.createdAt.getTime())
          .map((x) => ({ ...x }));
      },
      findUnique: async (a: { where: { id: string } }) => {
        say("financialAccount.findUnique");
        const row = w.accounts.find((x) => x.id === a.where.id);
        return row ? { ...row, createdByUserId: row.ownerUserId } : null;
      },
      update: async (a: { where: { id: string }; data: { deletedAt?: Date } }) => {
        say("financialAccount.update");
        const row = w.accounts.find((x) => x.id === a.where.id);
        if (row && a.data.deletedAt !== undefined) row.deletedAt = a.data.deletedAt;
        return row;
      },
    },
    transaction: {
      count: async (a: { where: { financialAccountId: string } }) => {
        say("transaction.count");
        return w.transactions.filter((t) => t.financialAccountId === a.where.financialAccountId && t.deletedAt === null).length;
      },
      groupBy: async (a: { where: { financialAccountId: { in: string[] } } }) => {
        say("transaction.groupBy");
        const ids = a.where.financialAccountId.in;
        const out: { financialAccountId: string; _count: { _all: number } }[] = [];
        for (const id of ids) {
          const n = w.transactions.filter((t) => t.financialAccountId === id && t.deletedAt === null).length;
          // ⚠️ THE REAL groupBy OMITS ZERO-COUNT GROUPS — measured against the
          // migrated database (asked for 6 ids, got 5 rows back). The fake must
          // omit them too, or it would hide the back-fill bug it exists to catch.
          if (n > 0) out.push({ financialAccountId: id, _count: { _all: n } });
        }
        return out;
      },
      updateMany: async (a: { where: { financialAccountId: string }; data: { financialAccountId: string } }) => {
        say("transaction.updateMany");
        if (opts.failFoldOf && a.where.financialAccountId === opts.failFoldOf) {
          throw new Error(`simulated write failure folding ${opts.failFoldOf}`);
        }
        const hit = w.transactions.filter((t) => t.financialAccountId === a.where.financialAccountId);
        for (const t of hit) t.financialAccountId = a.data.financialAccountId;
        return { count: hit.length };
      },
    },
    debtProfile: {
      findUnique: async (a: { where: { financialAccountId: string } }) => {
        say("debtProfile.findUnique");
        return w.debtProfiles.find((d) => d.financialAccountId === a.where.financialAccountId) ?? null;
      },
      count: async (a: { where: { financialAccountId: string } }) => {
        say("debtProfile.count");
        return w.debtProfiles.filter((d) => d.financialAccountId === a.where.financialAccountId).length;
      },
      updateMany: async (a: { where: { financialAccountId: string }; data: { financialAccountId: string } }) => {
        say("debtProfile.updateMany");
        const hit = w.debtProfiles.filter((d) => d.financialAccountId === a.where.financialAccountId);
        for (const d of hit) d.financialAccountId = a.data.financialAccountId;
        return { count: hit.length };
      },
    },
    spaceAccountLink: {
      findMany: async (a: { where: { financialAccountId: string } }) => {
        say("spaceAccountLink.findMany");
        return w.links.filter((l) => l.financialAccountId === a.where.financialAccountId).map((l) => ({ ...l }));
      },
      // ⚠️ HONOURS `where.id.in`, WHICH THE FIRST VERSION DID NOT. It filtered
      // on `where.financialAccountId` — a key the real call does not even send —
      // so it revoked the right rows for the wrong reason and would have passed
      // even if the implementation had asked for the wrong ids. Measured: §5's
      // assertions were vacuous until this was fixed.
      count:     async () => { say("spaceAccountLink.count"); return w.links.length; },
      findFirst: async () => { say("spaceAccountLink.findFirst"); return null; },
      upsert:    async (a: { create: { spaceId: string; financialAccountId: string; addedByUserId: string | null; visibilityLevel: string; status: string } }) => {
        say("spaceAccountLink.upsert");
        const c = a.create;
        const existing = w.links.find((l) => l.spaceId === c.spaceId && l.financialAccountId === c.financialAccountId);
        if (existing) existing.status = "ACTIVE";
        else w.links.push({ id: `sal_${c.financialAccountId}_${c.spaceId}`, ...c });
        return {};
      },
      updateMany: async (a: { where: { id?: { in: string[] }; status?: string }; data: { status?: string; revokedAt?: Date; revokedByUserId?: string | null } }) => {
        say("spaceAccountLink.updateMany");
        const ids = new Set(a.where.id?.in ?? []);
        const hit = w.links.filter((l) => ids.has(l.id) && (a.where.status === undefined || l.status === a.where.status));
        for (const l of hit) {
          if (a.data.status) l.status = a.data.status;
          if (a.data.revokedAt !== undefined) (l as { revokedAt?: Date | null }).revokedAt = a.data.revokedAt;
        }
        return { count: hit.length };
      },
    },
    duplicateAccountCandidate: {
      upsert: async (a: { create: { accountAId: string; accountBId: string } }) => {
        say("duplicateAccountCandidate.upsert");
        w.candidates.push({ a: a.create.accountAId, b: a.create.accountBId });
        return {};
      },
    },
    accountConnection: {
      findMany: async (a: { where: { financialAccountId: string } }) => {
        say("accountConnection.findMany");
        return w.connections
          .filter((c) => c.financialAccountId === a.where.financialAccountId && c.deletedAt === null)
          .map((c) => ({ ...c }));
      },
      updateMany: async (a: { where: { financialAccountId: string }; data: { deletedAt: Date } }) => {
        say("accountConnection.updateMany");
        const hit = w.connections.filter((c) => c.financialAccountId === a.where.financialAccountId && c.deletedAt === null);
        for (const c of hit) c.deletedAt = a.data.deletedAt;
        return { count: hit.length };
      },
    },
  };

  const client = {
    ...statements,
    // REAL ROLLBACK: snapshot on entry, restore on throw. Without this the
    // "partial commit" claim would be a reading of the code rather than an
    // observation of its effect.
    $transaction: async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      const id = `tx${++txCount}`;
      const outer = scope;
      const snap = clone();
      scope = id;
      log.push({ scope: id, stmt: "BEGIN" });
      try {
        // The tx client is the same statements WITHOUT $transaction — exactly
        // what Prisma hands an interactive transaction callback.
        const out = await fn(statements);
        log.push({ scope: id, stmt: "COMMIT" });
        return out;
      } catch (e) {
        restore(snap);
        log.push({ scope: id, stmt: "ROLLBACK" });
        throw e;
      } finally {
        scope = outer;
      }
    },
  };

  return { client, log, txOpens: () => log.filter((l) => l.stmt === "BEGIN").length };
}

const FP = {
  ownerUserId: "alice", type: "checking", mask: "4321",
  institution: "Chase", institutionId: "ins_1", name: "Chase Checking",
  officialName: "Chase Total Checking", plaidName: "Chase Checking",
};

/** Three ACTIVE siblings, oldest first, with 5 / 3 / 1 live transactions. */
function cohortOfThree(): World {
  const d = (n: number) => new Date(2026, 0, n);
  return {
    accounts: [
      { id: "acct_a", ownerUserId: "alice", deletedAt: null, createdAt: d(1) },
      { id: "acct_b", ownerUserId: "alice", deletedAt: null, createdAt: d(2) },
      { id: "acct_c", ownerUserId: "alice", deletedAt: null, createdAt: d(3) },
    ],
    transactions: [
      ...[1, 2, 3, 4, 5].map((i) => ({ id: `ta${i}`, financialAccountId: "acct_a", deletedAt: null })),
      ...[1, 2, 3].map((i) => ({ id: `tb${i}`, financialAccountId: "acct_b", deletedAt: null })),
      ...[1].map((i) => ({ id: `tc${i}`, financialAccountId: "acct_c", deletedAt: null })),
    ],
    debtProfiles: [{ id: "dp_b", financialAccountId: "acct_b" }],
    links: [
      { id: "sal_a", spaceId: "space_a", financialAccountId: "acct_a", addedByUserId: "alice", visibilityLevel: "FULL", status: "ACTIVE" },
      { id: "sal_b", spaceId: "space_b", financialAccountId: "acct_b", addedByUserId: "alice", visibilityLevel: "FULL", status: "ACTIVE" },
      { id: "sal_c", spaceId: "space_c", financialAccountId: "acct_c", addedByUserId: "alice", visibilityLevel: "FULL", status: "ACTIVE" },
    ],
    candidates: [],
    // Empty on purpose: a live connection would send closeOutAccountConnections
    // into disconnectPlaidItemIfOrphaned, which holds its OWN systemDb and
    // plaidClient and would attempt a real provider call from a unit test.
    // §3 proves the provider boundary structurally instead.
    connections: [],
  };
}

const resolve = (w: World, c: { client: unknown }) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resolveAccountByFingerprint(c.client as any, FP as any, undefined, "space_a");

async function main(): Promise<void> {
  // ══ 1. THE ELECTION IS UNCHANGED, INCLUDING ITS TIE-BREAK ═════════════════
  console.log("\n1. the canonical election still picks most-history, ties to oldest");
  {
    const w = cohortOfThree();
    const c = makeRootClient(w);
    const r = await resolve(w, c);
    check("acct_a wins on history (5 vs 3 vs 1)", r?.canonical.id === "acct_a", `canonical=${r?.canonical.id}`);
    check("it reports 3 active candidates", r?.activeCandidateCount === 3, `${r?.activeCandidateCount}`);

    // THE ZERO-COUNT TRAP, FORCED. All three have zero live transactions, so a
    // groupBy-based election sees NO rows at all and must still elect the
    // oldest — which is what the original `canonicalCount = -1` + strict `>`
    // over createdAt-asc candidates did.
    const z = cohortOfThree();
    z.transactions = [];
    const zc = makeRootClient(z);
    const zr = await resolve(z, zc);
    check("an ALL-ZERO cohort still elects the OLDEST (the -1/strict-> behaviour)",
      zr?.canonical.id === "acct_a", `canonical=${zr?.canonical.id}`);

    // And a mixed cohort where the winner has zero but an older sibling exists.
    const m = cohortOfThree();
    m.transactions = [{ id: "tc1", financialAccountId: "acct_c", deletedAt: null }];
    const mc = makeRootClient(m);
    const mr = await resolve(m, mc);
    check("a cohort where only the YOUNGEST has history elects the youngest",
      mr?.canonical.id === "acct_c", `canonical=${mr?.canonical.id}`);
  }

  // ══ 2. ATOMICITY — THE WHOLE POINT ════════════════════════════════════════
  // A cohort of 3 folds TWO losers. Fail the second one's write and ask what
  // survived. Before this slice: loser 1 was committed and loser 2 rolled back
  // — one canonical mutation, committed in pieces. Now: nothing survives.
  console.log("\n2. a failure anywhere in the fold rolls back the WHOLE mutation");
  {
    const w = cohortOfThree();
    const c = makeRootClient(w, { failFoldOf: "acct_c" });
    let threw = "(none)";
    try { await resolve(w, c); } catch (e) { threw = e instanceof Error ? e.message.slice(0, 60) : String(e); }

    check("the failure propagates — it is not swallowed", threw !== "(none)", threw);
    check("EXACTLY ONE transaction was opened for the whole fold",
      c.txOpens() === 1, `opened ${c.txOpens()}`);

    // The first loser is the one that proves atomicity: its fold ran to
    // completion before the second one failed.
    const bTxOnWinner = w.transactions.filter((t) => t.id.startsWith("tb") && t.financialAccountId === "acct_a").length;
    const bDebtMoved  = w.debtProfiles.some((d) => d.id === "dp_b" && d.financialAccountId === "acct_a");
    const bArchived   = w.accounts.find((a) => a.id === "acct_b")?.deletedAt !== null;
    check("loser 1's transactions did NOT move to the winner", bTxOnWinner === 0, `${bTxOnWinner} moved`);
    check("loser 1's DebtProfile did NOT move", !bDebtMoved);
    check("loser 1 was NOT archived", !bArchived);
    check("no DuplicateAccountCandidate row survives", w.candidates.length === 0, JSON.stringify(w.candidates));
    check("no winner-side link was created for either loser's Space",
      !w.links.some((l) => l.financialAccountId === "acct_a" && l.spaceId !== "space_a"),
      JSON.stringify(w.links));
  }

  // ══ 3. THE PROVIDER BOUNDARY ══════════════════════════════════════════════
  // The historical invariant: the AccountConnection soft-delete must be
  // COMMITTED and visible to the orphan gate's SEPARATE connection before
  // itemRemove is considered. So the DB half belongs inside the transaction and
  // the provider call strictly after it.
  console.log("\n3. the provider call is captured for after the commit, never made inside it");
  {
    const w = cohortOfThree();
    w.connections = [
      { id: "conn_b", financialAccountId: "acct_b", plaidItemDbId: "item_b", deletedAt: null },
      { id: "conn_c", financialAccountId: "acct_c", plaidItemDbId: "item_c", deletedAt: null },
    ];
    const c = makeRootClient(w);
    const r = await resolve(w, c);

    check("the resolution RETURNS the provider work instead of performing it",
      Array.isArray(r?.pendingProviderRevocations), JSON.stringify(r?.pendingProviderRevocations));
    check("it names both losers' Plaid items, de-duplicated",
      JSON.stringify([...(r?.pendingProviderRevocations ?? [])].sort()) === JSON.stringify(["item_b", "item_c"]),
      JSON.stringify(r?.pendingProviderRevocations));
    check("both losers' connections were soft-deleted",
      w.connections.every((x) => x.deletedAt !== null));

    // The close-out's DB half ran INSIDE the single transaction — which is what
    // makes it atomic with the fold — and nothing ran at root scope after BEGIN.
    const closeOut = c.log.filter((l) => l.stmt === "accountConnection.updateMany");
    check("the connection soft-delete ran inside the transaction",
      closeOut.length > 0 && closeOut.every((l) => l.scope !== "root"),
      JSON.stringify(closeOut));
    const afterBegin = c.log.slice(c.log.findIndex((l) => l.stmt === "BEGIN"));
    const rootAfterBegin = afterBegin.filter((l) => l.scope === "root" && l.stmt !== "COMMIT");
    check("no statement ran at root scope once the transaction was open",
      rootAfterBegin.length === 0, JSON.stringify(rootAfterBegin));
  }

  // ══ 4. [source] THE SHAPE, PINNED ═════════════════════════════════════════
  console.log("\n4. [source] the signature and the boundary are what they claim");
  {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("lib/accounts/reconcile.ts", "utf8");
    const stripped = src.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, "$1");

    check("resolveAccountByFingerprint takes a REQUIRED, LEADING WriteClient",
      /export async function resolveAccountByFingerprint\(\s*client: WriteClient,/.test(stripped));
    check("…and has NO `= db` default anywhere in the module",
      !/client: PrismaClient = db/.test(stripped) && !/=\s*db\b/.test(stripped));
    check("the module no longer imports `db`", !/import\s*\{[^}]*\bdb\b[^}]*\}\s*from\s*["']@\/lib\/db["']/.test(stripped));
    check("the fold runs through inOneTransaction", /inOneTransaction\s*\(/.test(stripped));
    check("pickCanonicalAndMerge no longer opens its own transaction",
      !/client\.\$transaction/.test(stripped));
    check("closeOutAccountConnections takes a transaction client, not a root one",
      /function closeOutAccountConnections\(\s*tx: Prisma\.TransactionClient/.test(stripped));
    check("disconnectPlaidItemIfOrphaned is NOT referenced in this module any more",
      !/disconnectPlaidItemIfOrphaned/.test(stripped));
    check("the connection close-out asserts its own shortfall",
      /assertEveryObservedRowWasWritten/.test(stripped) && /AccountConnection/.test(stripped));
  }

  // ══ 5. RLS-ACC-S8 — THE ARCHIVED LOSER KEEPS NO ACTIVE LINK ═══════════════
  // The fold COPIES each loser link onto the winner and, until this slice, left
  // the loser's own rows ACTIVE. `fm_account_visible(acct)` is
  // `EXISTS(SpaceAccountLink … status='ACTIVE' AND spaceId IN
  // fm_visible_space_ids())` and arm 1 of all thirteen subtree policies is that
  // predicate written out, so a lingering ACTIVE link kept the archived loser
  // AND ITS SUBTREE reachable by every member of that Space indefinitely.
  console.log("\n5. a folded loser keeps no ACTIVE link, and the winner's are correct");
  {
    // ── multi-Space loser: every link moves, every loser row is revoked ──────
    const w = cohortOfThree();
    w.links.push({ id: "sal_b2", spaceId: "space_x", financialAccountId: "acct_b", addedByUserId: "alice", visibilityLevel: "BALANCE_ONLY", status: "ACTIVE" });
    const c = makeRootClient(w);
    await resolve(w, c);

    const loserActive = w.links.filter((l) => (l.financialAccountId === "acct_b" || l.financialAccountId === "acct_c") && l.status === "ACTIVE");
    check("DENOMINATOR: the losers held 3 ACTIVE links across 3 Spaces before the fold",
      ["space_b", "space_c", "space_x"].length === 3);
    check("NO ACTIVE link remains on either folded loser",
      loserActive.length === 0, JSON.stringify(loserActive));
    check("…and they are REVOKED rather than deleted — the historical rows survive",
      w.links.filter((l) => l.financialAccountId === "acct_b" || l.financialAccountId === "acct_c").every((l) => l.status === "REVOKED"));
    check("the winner holds an ACTIVE link in EVERY Space a loser was in",
      ["space_b", "space_c", "space_x"].every((sp) =>
        w.links.some((l) => l.financialAccountId === "acct_a" && l.spaceId === sp && l.status === "ACTIVE")),
      JSON.stringify(w.links.filter((l) => l.financialAccountId === "acct_a")));
    check("the winner's OWN pre-existing link is untouched and still ACTIVE",
      w.links.find((l) => l.id === "sal_a")?.status === "ACTIVE");
    // BALANCE_ONLY is a PRODUCT visibility level, never a mutation authority —
    // it travels with the copied link and does not gate the revoke.
    check("a BALANCE_ONLY loser link is revoked exactly like a FULL one",
      w.links.find((l) => l.id === "sal_b2")?.status === "REVOKED");

    // ── the revoke is INSIDE the atomic boundary (#1's) ──────────────────────
    const revokes = c.log.filter((l) => l.stmt === "spaceAccountLink.updateMany");
    check("the loser-link revoke ran inside the ONE transaction, not after it",
      revokes.length > 0 && revokes.every((l) => l.scope !== "root"), JSON.stringify(revokes));
  }
  {
    // ── ROLLBACK: the revoke is atomic with the fold ─────────────────────────
    const w = cohortOfThree();
    const c = makeRootClient(w, { failFoldOf: "acct_c" });
    try { await resolve(w, c); } catch { /* expected */ }
    check("on failure the loser's link is STILL ACTIVE — the revoke rolled back with everything else",
      w.links.find((l) => l.id === "sal_b")?.status === "ACTIVE",
      JSON.stringify(w.links.map((l) => `${l.id}:${l.status}`)));
  }
  {
    // ── REPLAY: already-revoked loser links are idempotent, and the shortfall
    //    assertion must not fire on them (they are filtered out before the
    //    write, so observed === written === 0).
    const w = cohortOfThree();
    const c1 = makeRootClient(w);
    await resolve(w, c1);
    const afterFirst = w.links.map((l) => `${l.id}:${l.status}`).sort().join(",");
    // Re-point the losers active again? No — replay the fold as production
    // would: the losers are now archived, so they arrive as ARCHIVED candidates.
    const c2 = makeRootClient(w);
    let replayThrew = "(none)";
    try { await resolve(w, c2); } catch (e) { replayThrew = e instanceof Error ? e.message.slice(0, 70) : String(e); }
    check("a REPLAY of the fold does not throw — an already-revoked loser link is not a shortfall",
      replayThrew === "(none)", replayThrew);
    check("…and the link state is unchanged by the replay",
      w.links.map((l) => `${l.id}:${l.status}`).sort().join(",") === afterFirst,
      `before=[${afterFirst}] after=[${w.links.map((l) => `${l.id}:${l.status}`).sort().join(",")}]`);
  }
  {
    // ── CROSS-OWNER: the reparenting guard still refuses, and nothing is
    //    revoked on the way to that refusal.
    const w = cohortOfThree();
    w.accounts.find((a) => a.id === "acct_c")!.ownerUserId = "bob";
    const c = makeRootClient(w);
    let threw = "(none)";
    try { await resolve(w, c); } catch (e) { threw = e instanceof Error ? e.name : String(e); }
    check("a cross-owner candidate REFUSES the fold (the reparenting guard holds)",
      threw !== "(none)", threw);
    check("…and no link was revoked on the way to that refusal",
      w.links.every((l) => l.status === "ACTIVE"),
      JSON.stringify(w.links.map((l) => `${l.id}:${l.status}`)));
  }
  {
    // ── [source] the shape, pinned ───────────────────────────────────────────
    const { readFileSync } = await import("node:fs");
    const code = readFileSync("lib/accounts/reconcile.ts", "utf8").replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, "$1");
    check("the loser-link revoke acts on OBSERVED IDS, not on a broad predicate",
      /spaceAccountLink\.updateMany\(\{\s*where:\s*\{\s*id:\s*\{\s*in:\s*loserActiveLinkIds\s*\}/.test(code.replace(/\s+/g, " ").replace(/ /g, " ")) ||
      /id: \{ in: loserActiveLinkIds \}/.test(code),
      "a `{financialAccountId, status: ACTIVE}` predicate could touch a row that became ACTIVE concurrently, " +
      "and would make the shortfall assertion meaningless");
    check("…and its shortfall is asserted",
      /assertEveryObservedRowWasWritten\(\s*\{ table: "SpaceAccountLink"/.test(code));
    check("reconcile.ts still does NOT import systemDb — the revoke stayed tenant-scoped and atomic",
      !/systemDb/.test(code));
  }

  console.log(
    failures === 0
      ? "\n✅ one transaction for the whole canonical mutation, provider work captured for after the commit.\n"
      : `\n❌ ${failures} failure(s)\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
