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

    // ── RLS-ACC-S6 — THE MERGE'S DEFAULT IS GONE ────────────────────────────
    // A defaulted client is an AMBIENT authority. This one was kept for one
    // measured reason: the fold's final statement, `DuplicateAccountCandidate`'s
    // INSERT, was refused by fm_app for an ARCHIVED loser — which is the shape
    // EVERY production fold has (acceptance case 87). 20261003000100 gives that
    // table's two FK columns RLS-D1's owner arm, so the refusal is gone and the
    // parameter is required. The COMPILER now enumerates the call sites; what is
    // asserted here is that the default cannot creep back.
    check("the merge's client is REQUIRED — no `= db` default, so every caller names its authority",
      /^\s*client: DbClient,\s*$/m.test(code) && !/client: DbClient = db/.test(code),
      "a trailing `= db` here is an ambient authority on the one deliberate account-FK re-parenting in the codebase");
    check("…and `spaceId` became required-in-arity to allow it (a required parameter cannot follow an optional one)",
      /spaceId: string \| null \| undefined,/.test(code) && !/spaceId\?: string \| null,\s*\n\s*(?:\/\/[^\n]*\n\s*)*client: DbClient/.test(code));

    // ── THE ONE DEFAULT THAT SURVIVES, AND THE EXACT COUNT OF WHO RELIES ON IT
    // ⚠️ THE NUMBER IS THE ASSERTION, and it may only go DOWN.
    // `resolveAccountByFingerprint` keeps its default for a reason that is NOT a
    // policy and cannot be widened away: its client is typed `PrismaClient`
    // because it calls Plaid's `itemRemove` BETWEEN its own transactions, and a
    // tenant authority is only ever a transaction client (lib/db/write-phase.ts
    // says so in terms). No tenant client of any shape can satisfy it, and
    // naming `db` at the one site that defaults would put a restore route back
    // on the migration principal. Closing it means lifting the provider round
    // trip out of the fold — a transaction-boundary change, not an authority one.
    const DEFAULT_RELIANT = ["app/api/accounts/[id]/restore/route.ts"];
    const RECONCILE_CALLERS = [
      ...DEFAULT_RELIANT,
      "app/api/accounts/manual/[id]/restore/route.ts",
      "app/api/accounts/wallet/route.ts",
      "lib/plaid/exchangeToken.ts",
    ];
    {
      /**
       * Every external invocation of either defaulted-capable entry point, with
       * its argument list flattened so the trailing authority is visible.
       * ⚠️ BALANCED-PAREN, NOT `[\s\S]*?\);`. The non-greedy form stopped at the
       * FIRST `);` in the file, which for `withTenantDb(uid, (tx) => merge(…))`
       * is the wrong one — and a call whose arguments were mis-sliced would read
       * as "no client named" and make this check cry wolf about the conversion
       * it exists to confirm.
       */
      const callArgs = (src: string, fn: string): string[] => {
        const out: string[] = [];
        const re = new RegExp(`\\b${fn}\\s*\\(`, "g");
        let m: RegExpExecArray | null;
        while ((m = re.exec(src)) !== null) {
          const open = m.index + m[0].length - 1;
          let d = 0, close = -1;
          for (let i = open; i < src.length; i++) {
            if (src[i] === "(") d++;
            else if (src[i] === ")") { d--; if (d === 0) { close = i; break; } }
          }
          if (close < 0) { out.push("(UNBALANCED)"); continue; }
          out.push(src.slice(open + 1, close).replace(/\s+/g, " ").trim());
        }
        return out;
      };
      /** An authority named at the call site: the principal, or a phase client. */
      const namesAuthority = (args: string) => /\b(?:db|tx|client)\s*,?\s*$/.test(args);

      const mergeDefaulting: string[] = [];
      const fingerprintDefaulting: string[] = [];
      for (const f of RECONCILE_CALLERS) {
        const src = stripComments(readFileSync(join(ROOT, f), "utf8"));
        if (callArgs(src, "mergeArchivedDuplicateIntoCanonical").some((a) => !namesAuthority(a))) mergeDefaulting.push(f);
        if (callArgs(src, "resolveAccountByFingerprint").some((a) => !namesAuthority(a))) fingerprintDefaulting.push(f);
      }
      check("NO call site relies on the merge's default any more — all four name an authority",
        mergeDefaulting.length === 0,
        `still defaulting: ${mergeDefaulting.join(", ")}`);
      check("EXACTLY ONE call site relies on a reconcile default, and it is the fingerprint fallback in the generic restore route",
        fingerprintDefaulting.length === 1 && fingerprintDefaulting[0] === DEFAULT_RELIANT[0],
        `relying on a default: ${fingerprintDefaulting.join(", ") || "(none)"}`);
    }

    // ── AND THE CONVERSION IS THE TENANT PHASE, NOT A NAMED DEFAULT ─────────
    // ⚠️ Naming `db` in either restore route would have been a REGRESSION, not
    // honesty: RLS-C-S7 took both off the migration principal and
    // lib/accounts/links-everywhere.test.ts pins them there. The authority they
    // supply is their own `withTenantDb` phase.
    for (const f of ["app/api/accounts/[id]/restore/route.ts", "app/api/accounts/manual/[id]/restore/route.ts"]) {
      const src = readFileSync(join(ROOT, f), "utf8");
      const code2 = stripComments(src);
      check(`${f}: still does NOT import the migration principal`,
        !/import\s*\{[^{}]*\bdb\b[^{}]*\}\s*from\s*["']@\/lib\/db["']/.test(src));
      check(`${f}: folds through a withTenantDb PHASE — the merge's authority is this route's tenant role`,
        // ⚠️ NO `/s` FLAG. tsconfig targets below es2018, so dotAll is a
        // COMPILE ERROR here — and the main checkout's tsc never reached this
        // line, because it aborted on a stale generated `.next/dev/types` file
        // first. A clean worktree is what found it. `[^;]` already spans
        // newlines, so the flag was redundant as well as illegal.
        /withTenantDb\([^;]*?mergeArchivedDuplicateIntoCanonical\(/.test(code2),
        "the merge must receive a phase client, so every statement in the fold is policy-subject and atomic with it");
      check(`${f}: names the migration that unblocked the fold, so nobody re-derives the refusal`,
        /DuplicateAccountCandidate/.test(src) && /20261003000100/.test(src));
    }
    check("the generic restore route still records WHY its fingerprint fallback cannot be converted",
      /resolveAccountByFingerprint/.test(readFileSync(join(ROOT, DEFAULT_RELIANT[0]), "utf8"))
        && /itemRemove/.test(readFileSync(join(ROOT, DEFAULT_RELIANT[0]), "utf8")),
      "the blocker is a transaction boundary (a provider call between transactions), and the route must say so");
  }

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) failed.\n`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
