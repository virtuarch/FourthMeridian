/**
 * lib/accounts/reconcile.test.ts  (RLS-ACC-FK)
 *
 * THE FIRST TESTS THIS MODULE HAS EVER HAD.
 *
 * `mergeArchivedDuplicateIntoCanonical` is the ONLY deliberate account-FK
 * re-parenting in the codebase — it moves every transaction a loser account
 * owns onto a winner — and ZERO tests referenced it. There was no test file for
 * the module at all. For a function that relocates a user's financial history
 * between accounts, that is not acceptable, and it is why this file exists
 * alongside the guard rather than after it.
 *
 * ⚠️ WHAT A FAKE CLIENT CANNOT PROVE, STATED BEFORE ANY ASSERTION. A fake
 * answers whatever it was written to answer, so it cannot say ANYTHING about a
 * policy, a role, or what `fm_app` is permitted to see. The real-role proofs —
 * the cross-owner fold refused on a live `fm_app` connection, BALANCE_ONLY and
 * FULL reaching the IDENTICAL verdict, and the legitimate same-owner fold still
 * succeeding so the refusals are not vacuous — are cases 73–80 of
 * scripts/rls-app-acceptance.ts, which build their own Postgres. RLS-ACC-S5
 * added 86–87 there: the same fold driven on a real `fm_app` PHASE, succeeding
 * end to end when the loser is still linked and refused at exactly one
 * statement when it is archived. Nothing in THIS file can say either thing.
 *
 * ⚠️ RUN IT THROUGH THE PRELOAD. reconcile.ts reaches lib/plaid/client.ts, which
 * is `server-only`; a bare `npx tsx` on this file dies on MODULE_NOT_FOUND
 * before a single check runs. scripts/run-tests.ts already does this.
 *
 * What THIS file proves is the module's own behaviour: which rows move, which
 * deliberately do not, that a partial write is LOUD, that a replay is
 * deterministic, and that the authority question is asked through the caller's
 * client before anything is written.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/accounts/reconcile.test.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { mergeArchivedDuplicateIntoCanonical } from "@/lib/accounts/reconcile";
import { ReparentingRefusedError } from "@/lib/accounts/account-reparenting";
import { PartialBulkWriteError } from "@/lib/db/conditional-write";
import { DuplicateDetectionSource } from "@prisma/client";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const ROOT = join(__dirname, "..", "..");
const stripComments = (s: string) => s
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");

/* ────────────────────────────────────────────────────────────────────────────
 * THE FAKE
 *
 * Deliberately WITHOUT `$transaction`, so `mergeArchivedDuplicateIntoCanonical`
 * takes its phase-client branch and runs its statements against this object
 * directly. (The `"$transaction" in client` capability test is itself an RLS-7
 * fix and must not regress to a `=== db` reference comparison; a fake that
 * carried `$transaction` would silently exercise the other branch and recurse.)
 * ──────────────────────────────────────────────────────────────────────────── */

interface Row { id: string; financialAccountId: string }
interface World {
  /** account id -> ownerUserId (null models a SPACE-owned / owner-orphaned row). */
  owners: Record<string, string | null>;
  transactions: Row[];
  debtProfiles: Row[];
  links: Array<{ spaceId: string; financialAccountId: string; addedByUserId: string | null; visibilityLevel: string }>;
  /** Force a shortfall: the updateMany reports this many fewer rows than it saw. */
  txShortfall?: number;
  /** Force a DebtProfile shortfall the same way. */
  debtShortfall?: number;
}

function makeClient(w: World) {
  const calls: string[] = [];
  const upserts: Array<{ table: string; args: unknown }> = [];
  const client = {
    financialAccount: {
      findMany: async (a: { where: { id: { in: string[] } }; select: Record<string, boolean> }) => {
        calls.push(`financialAccount.findMany(${JSON.stringify(Object.keys(a.select).sort())})`);
        return a.where.id.in.filter((id) => id in w.owners).map((id) => ({ id, ownerUserId: w.owners[id] }));
      },
      findUnique: async () => ({ createdByUserId: null, ownerUserId: "alice" }),
    },
    transaction: {
      count: async (a: { where: { financialAccountId: string } }) => {
        calls.push("transaction.count");
        return w.transactions.filter((t) => t.financialAccountId === a.where.financialAccountId).length;
      },
      updateMany: async (a: { where: { financialAccountId: string }; data: { financialAccountId: string } }) => {
        calls.push("transaction.updateMany");
        const hit = w.transactions.filter((t) => t.financialAccountId === a.where.financialAccountId);
        const moved = hit.slice(0, Math.max(0, hit.length - (w.txShortfall ?? 0)));
        for (const t of moved) t.financialAccountId = a.data.financialAccountId;
        return { count: moved.length };
      },
    },
    debtProfile: {
      findUnique: async (a: { where: { financialAccountId: string } }) => {
        calls.push("debtProfile.findUnique");
        return w.debtProfiles.find((d) => d.financialAccountId === a.where.financialAccountId) ?? null;
      },
      count: async (a: { where: { financialAccountId: string } }) => {
        calls.push("debtProfile.count");
        return w.debtProfiles.filter((d) => d.financialAccountId === a.where.financialAccountId).length;
      },
      updateMany: async (a: { where: { financialAccountId: string }; data: { financialAccountId: string } }) => {
        calls.push("debtProfile.updateMany");
        const hit = w.debtProfiles.filter((d) => d.financialAccountId === a.where.financialAccountId);
        const moved = hit.slice(0, Math.max(0, hit.length - (w.debtShortfall ?? 0)));
        for (const d of moved) d.financialAccountId = a.data.financialAccountId;
        return { count: moved.length };
      },
    },
    spaceAccountLink: {
      findMany: async (a: { where: { financialAccountId: string } }) => {
        calls.push("spaceAccountLink.findMany");
        return w.links.filter((l) => l.financialAccountId === a.where.financialAccountId);
      },
      count: async () => w.links.length,
      findFirst: async () => null,
      upsert: async (a: unknown) => { calls.push("spaceAccountLink.upsert"); upserts.push({ table: "SpaceAccountLink", args: a }); },
    },
    duplicateAccountCandidate: {
      upsert: async (a: unknown) => { calls.push("duplicateAccountCandidate.upsert"); upserts.push({ table: "DuplicateAccountCandidate", args: a }); },
    },
  };
  return { client, calls, upserts };
}

const world = (over: Partial<World> = {}): World => ({
  owners: { acct_loser: "alice", acct_winner: "alice" },
  transactions: [
    { id: "t1", financialAccountId: "acct_loser" },
    { id: "t2", financialAccountId: "acct_loser" },
    { id: "t3", financialAccountId: "acct_winner" },
  ],
  debtProfiles: [{ id: "dp1", financialAccountId: "acct_loser" }],
  links: [{ spaceId: "space_a", financialAccountId: "acct_loser", addedByUserId: "alice", visibilityLevel: "FULL" }],
  ...over,
});

const merge = (w: World, loser = "acct_loser", winner = "acct_winner") =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mergeArchivedDuplicateIntoCanonical(loser, winner, DuplicateDetectionSource.FINGERPRINT_MATCH, null, makeClient(w).client as any);

async function thrown(fn: () => Promise<unknown>): Promise<Error | null> {
  try { await fn(); return null; } catch (e) { return e instanceof Error ? e : new Error(String(e)); }
}

async function main(): Promise<void> {
  console.log("\nreconcile — the one deliberate account-FK re-parenting, and what it may and may not fold\n");

  // ── 1. THE LEGITIMATE FOLD. THE DENOMINATOR FOR EVERY REFUSAL BELOW. ──────
  // ⚠️ WITHOUT THIS, every assertion after it would pass over a function that
  // refuses everything — the vacuity trap this whole programme keeps hitting.
  {
    const w = world();
    const { client, calls, upserts } = makeClient(w);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await mergeArchivedDuplicateIntoCanonical("acct_loser", "acct_winner", DuplicateDetectionSource.FINGERPRINT_MATCH, null, client as any);

    check("a SAME-OWNER archived fold SUCCEEDS and moves every transaction to the winner",
      w.transactions.every((t) => t.financialAccountId === "acct_winner")
        && w.transactions.filter((t) => t.financialAccountId === "acct_winner").length === 3,
      JSON.stringify(w.transactions));
    check("the DebtProfile moves too, because the winner had none (strict 1:1)",
      w.debtProfiles[0].financialAccountId === "acct_winner");
    check("every one of the loser's SpaceAccountLinks is re-pointed at the winner",
      upserts.filter((u) => u.table === "SpaceAccountLink").length === w.links.length);
    check("a DuplicateAccountCandidate audit row is upserted on the (winner, loser) key",
      upserts.some((u) => u.table === "DuplicateAccountCandidate"
        && JSON.stringify(u.args).includes('"accountAId":"acct_winner"')
        && JSON.stringify(u.args).includes('"accountBId":"acct_loser"')),
      JSON.stringify(upserts.find((u) => u.table === "DuplicateAccountCandidate")?.args));

    // ── THE ORDER IS THE PROPERTY. The authority question must be asked
    // BEFORE anything is written, or a refused fold has already moved rows.
    const firstWrite = calls.findIndex((c) => /updateMany|upsert/.test(c));
    const authorityAsk = calls.findIndex((c) => c.startsWith("financialAccount.findMany"));
    check("the AUTHORITY question is asked before the FIRST write, not after it",
      authorityAsk >= 0 && authorityAsk < firstWrite, `ask@${authorityAsk} firstWrite@${firstWrite} — ${calls.join(" → ")}`);
    check("the authority probe issues through the CALLER'S client and selects only {id, ownerUserId}",
      calls.some((c) => c === 'financialAccount.findMany(["id","ownerUserId"])'), calls.join(" | "));
    check("each bulk re-point OBSERVES before it writes (count, then updateMany — the guard, not an optimisation)",
      calls.indexOf("transaction.count") < calls.indexOf("transaction.updateMany")
        && calls.indexOf("debtProfile.count") < calls.indexOf("debtProfile.updateMany"),
      calls.join(" → "));
  }

  // ── 2. DebtProfile: LEFT ON THE LOSER WHEN THE WINNER ALREADY HAS ONE ─────
  {
    const w = world({ debtProfiles: [
      { id: "dp_loser", financialAccountId: "acct_loser" },
      { id: "dp_winner", financialAccountId: "acct_winner" },
    ] });
    await merge(w);
    check("a DebtProfile is NOT moved when the winner already has one — it stays on the archived loser, inert",
      w.debtProfiles.find((d) => d.id === "dp_loser")!.financialAccountId === "acct_loser"
        && w.debtProfiles.find((d) => d.id === "dp_winner")!.financialAccountId === "acct_winner",
      JSON.stringify(w.debtProfiles));
  }
  {
    const w = world({ debtProfiles: [] });
    const { client, calls } = makeClient(w);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await mergeArchivedDuplicateIntoCanonical("acct_loser", "acct_winner", DuplicateDetectionSource.FINGERPRINT_MATCH, null, client as any);
    check("with NO DebtProfile anywhere the 1:1 move is a no-op and raises nothing (0 observed, 0 written)",
      calls.includes("debtProfile.count") && calls.includes("debtProfile.updateMany"));
  }

  // ── 3. THE ATTACK: A CROSS-OWNER FOLD, IN BOTH DIRECTIONS ─────────────────
  {
    const w = world({ owners: { acct_shared: "alice", acct_bob: "bob" },
      transactions: [
        { id: "s1", financialAccountId: "acct_shared" },
        { id: "s2", financialAccountId: "acct_shared" },
      ],
      debtProfiles: [], links: [] });
    const err = await thrown(() => merge(w, "acct_shared", "acct_bob"));
    check("a CROSS-OWNER source cannot be folded — ReparentingRefusedError / CROSS_OWNER",
      err instanceof ReparentingRefusedError && err.reason === "CROSS_OWNER",
      `${err?.name}/${err instanceof ReparentingRefusedError ? err.reason : "?"}`);
    check("...and it refuses BEFORE ANY MUTATION — the post-state is asserted, not just the throw",
      w.transactions.every((t) => t.financialAccountId === "acct_shared"), JSON.stringify(w.transactions));

    const inverse = await thrown(() => merge(w, "acct_bob", "acct_shared"));
    check("a CROSS-OWNER destination cannot be selected either — the inverse direction refuses identically",
      inverse instanceof ReparentingRefusedError && inverse.reason === "CROSS_OWNER");
  }

  // ── 4. AN UNRESOLVABLE ACCOUNT IS A REFUSAL, NOT AN ABSENCE ───────────────
  {
    const w = world({ owners: { acct_loser: "alice" } });
    const err = await thrown(() => merge(w));
    check("a winner this client cannot resolve refuses (UNRESOLVED_ACCOUNT) and moves nothing",
      err instanceof ReparentingRefusedError && err.reason === "UNRESOLVED_ACCOUNT"
        && w.transactions.filter((t) => t.financialAccountId === "acct_loser").length === 2,
      `${err?.name} / ${JSON.stringify(w.transactions)}`);
  }

  // ── 5. THE NULL-OWNER HOLE (reconcile.ts's own fingerprint sweep) ─────────
  // `findCandidatesByFingerprint` DROPS its `ownerUserId` predicate entirely
  // when the fingerprint's owner is null — a global, cross-owner candidate
  // sweep. Two null owners must not compare equal and read as co-ownership.
  {
    const w = world({ owners: { acct_loser: null, acct_winner: "alice" } });
    const err = await thrown(() => merge(w));
    check("a NULL ownerUserId on the loser refuses (NULL_OWNER) — no migration-principal fallback, no inferred owner",
      err instanceof ReparentingRefusedError && err.reason === "NULL_OWNER"
        && w.transactions.filter((t) => t.financialAccountId === "acct_loser").length === 2);
    const both = world({ owners: { acct_loser: null, acct_winner: null } });
    const bothErr = await thrown(() => merge(both));
    check("TWO null owners refuse as well — `null === null` must never authorize a fold",
      bothErr instanceof ReparentingRefusedError && bothErr.reason === "NULL_OWNER");
  }

  // ── 6. A PARTIAL WRITE IS LOUD ────────────────────────────────────────────
  // The hazard is not the zero. 1-of-2 looks exactly like success: the statement
  // returned, nothing raised, and the count is a plausible number nobody
  // compares to anything.
  {
    const w = world({ txShortfall: 1 });
    const err = await thrown(() => merge(w));
    check("a transaction re-point that writes FEWER rows than it observed raises PartialBulkWriteError",
      err instanceof PartialBulkWriteError, `${err?.name}: ${err?.message?.slice(0, 90)}`);
    check("...and the error reports the two numbers that disagreed, with no row contents",
      err instanceof PartialBulkWriteError && err.observed === 2 && err.written === 1
        && err.table === "Transaction" && !/\bt1\b|\bt2\b/.test(err.message),
      err instanceof PartialBulkWriteError ? `observed=${err.observed} written=${err.written}` : "");

    const d = world({ debtShortfall: 1 });
    const dErr = await thrown(() => merge(d));
    check("a DebtProfile re-point shortfall is equally loud — the APR/minimum are user-entered and exist nowhere else",
      dErr instanceof PartialBulkWriteError && dErr.table === "DebtProfile"
        && dErr.observed === 1 && dErr.written === 0,
      dErr instanceof PartialBulkWriteError ? `${dErr.table} ${dErr.observed}/${dErr.written}` : `${dErr?.name}`);
  }

  // ── 7. REPLAY / IDEMPOTENCE STAYS DETERMINISTIC ───────────────────────────
  {
    const w = world();
    await merge(w);
    const before = JSON.stringify(w.transactions);
    const second = await thrown(() => merge(w));
    check("a SECOND merge of the same already-folded pair raises nothing and changes nothing",
      second === null && JSON.stringify(w.transactions) === before,
      `${second?.name ?? "(no throw)"} / ${JSON.stringify(w.transactions)}`);

    const self = world();
    const selfBefore = JSON.stringify(self.transactions);
    const selfErr = await thrown(() => merge(self, "acct_loser", "acct_loser"));
    check("loser === winner returns immediately: nothing written, nothing asked, nothing raised",
      selfErr === null && JSON.stringify(self.transactions) === selfBefore);
  }

  // ── 8. THE SOURCE SCAN — WHAT A FAKE CANNOT DEFEND ───────────────────────
  {
    const code = stripComments(readFileSync(join(ROOT, "lib/accounts/reconcile.ts"), "utf8"));
    check("the authority probe is issued on `tx` — the phase client — and NOT on the module-global `db`",
      /assertAccountReparentingAuthorized\(\s*\n?\s*tx,/.test(code),
      "a probe on a wider authority than the write answers about rows the writer cannot see");
    check("the client-capability test is still `\"$transaction\" in client`, not a `=== db` reference compare",
      /"\$transaction" in client/.test(code) && !/client === db/.test(code));
    check("no migration-principal fallback inside the merge: every statement in it runs on `tx`",
      !/\bdb\.(transaction|debtProfile|spaceAccountLink|duplicateAccountCandidate)\./.test(
        code.slice(code.indexOf("const tx = client;"))));

    // ── RLS-ACC-S5 — THE READS NO LONGER CHOOSE THEIR OWN AUTHORITY ────────
    // Prisma's ITXClientDenyList strips $transaction from ReadClient, so a read
    // leaf is structurally incapable of opening a phase of its own; LEADING so
    // the authority is the first thing read at every call site.
    for (const fn of ["findActiveAccountByIdentity", "resolvePlaidAccountByExternalId", "findCandidatesByFingerprint"]) {
      check(`${fn} takes a REQUIRED, LEADING ReadClient — a read leaf cannot open its own phase`,
        new RegExp(`function ${fn}\\(\\s*client: ReadClient,`).test(code));
    }

    // ⚠️ THE PROVIDER-CALLING HELPERS DEMAND A ROOT CLIENT, BY TYPE. They reach
    // Plaid's itemRemove BETWEEN their transactions; handed a phase client they
    // would make that call inside somebody else's open transaction.
    // Prisma.TransactionClient has no $transaction, so it is not assignable to
    // PrismaClient and the mistake does not compile.
    check("closeOutAccountConnections demands a ROOT client — it reaches a provider call",
      /function closeOutAccountConnections\(\s*client: PrismaClient,/.test(code));
    check("pickCanonicalAndMerge demands a ROOT client — it opens transactions around a provider call",
      /function pickCanonicalAndMerge\(\s*client: PrismaClient,/.test(code));
    check("resolveAccountByFingerprint's client is typed PrismaClient, so a tenant PHASE cannot be threaded into a provider call",
      /client: PrismaClient = db,/.test(code));

    // ── THE DEFAULT THAT SURVIVES, AND THE EXACT COUNT OF WHO RELIES ON IT ──
    // ⚠️ THE NUMBER IS THE ASSERTION. A defaulted client is an ambient
    // authority; this one is kept because the fold's final statement —
    // `DuplicateAccountCandidate`'s INSERT — is refused by fm_app for an
    // ARCHIVED loser (acceptance case 87), and because requiring it would put
    // the two restore routes back on the migration principal and GROW the
    // ratchet. Both facts are measured. What must not happen is the set
    // quietly growing again, so it is counted, not described.
    const DEFAULT_RELIANT = [
      "app/api/accounts/[id]/restore/route.ts",
      "app/api/accounts/manual/[id]/restore/route.ts",
    ];
    const MERGE_CALLERS = [
      ...DEFAULT_RELIANT,
      "app/api/accounts/wallet/route.ts",
      "lib/plaid/exchangeToken.ts",
    ];
    {
      const callsWithoutClient: string[] = [];
      for (const f of MERGE_CALLERS) {
        const src = stripComments(readFileSync(join(ROOT, f), "utf8"));
        // Every external invocation of either defaulted entry point, with the
        // argument list flattened so the trailing client is visible.
        const calls = [...src.matchAll(/(?:mergeArchivedDuplicateIntoCanonical|resolveAccountByFingerprint)\(([\s\S]*?)\);/g)]
          .map((m) => m[1].replace(/\s+/g, " "));
        if (calls.some((c) => !/\bdb\s*,?\s*$/.test(c.trim()))) callsWithoutClient.push(f);
      }
      check("EXACTLY the two restore routes still rely on the module default — and they are the two that provably cannot supply a client",
        callsWithoutClient.length === DEFAULT_RELIANT.length
          && DEFAULT_RELIANT.every((f) => callsWithoutClient.includes(f)),
        `relying on the default: ${callsWithoutClient.join(", ") || "(none)"}`);
    }
    for (const f of DEFAULT_RELIANT) {
      const src = readFileSync(join(ROOT, f), "utf8");
      check(`${f}: still does NOT import the migration principal (requiring the client would have regressed it)`,
        !/import\s*\{[^{}]*\bdb\b[^{}]*\}\s*from\s*["']@\/lib\/db["']/.test(src));
      check(`${f}: names the policy that blocks the conversion, so nobody re-derives it`,
        /DuplicateAccountCandidate/.test(src) && /fm_account_visible/.test(src));
    }
  }

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) failed.\n`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
