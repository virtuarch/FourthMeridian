/**
 * lib/accounts/account-reparenting.test.ts  (RLS-ACC-FK)
 *
 * Pins the contract of the account-FK re-parenting guard, and — more
 * importantly — pins the SHAPE that makes three of the eight invariant clauses
 * structural rather than remembered.
 *
 * ⚠️ WHAT A FAKE CLIENT CAN AND CANNOT PROVE. The behavioural proof against a
 * REAL `fm_app` role — Bob re-pointing Alice's BALANCE_ONLY transactions onto
 * his own account, and the FULL link reaching the IDENTICAL answer — is cases
 * 73–79 of scripts/rls-app-acceptance.ts, which need a live Postgres and real
 * roles. A fake client answers whatever it was written to answer and therefore
 * cannot say anything about a policy; this file defends the things a future edit
 * could quietly revert while every real-role case stayed green:
 *
 *   · the module has NO owner/user/tier parameter at all (clauses 3, 4, 5)
 *   · the probe takes its client and never imports one (clauses 1, 2, 6)
 *   · the `select` is CLOSED to {id, ownerUserId}
 *   · a missing row, a null owner and a cross owner each REFUSE, separately
 *   · a forgotten `select` of the FK is a REFUSAL, not a lucky comparison
 *   · no row contents ride along in either error
 *
 *   npx tsx lib/accounts/account-reparenting.test.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ReparentingRefusedError,
  UnintendedReparentingError,
  assertAccountFkUnchanged,
  assertAccountReparentingAuthorized,
  type ReparentingSite,
} from "@/lib/accounts/account-reparenting";
import type { WriteClient } from "@/lib/db/write-phase";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const ROOT = join(__dirname, "..", "..");
const src = (p: string) => readFileSync(join(ROOT, p), "utf8");

/**
 * ⚠️ STRIP COMMENTS BEFORE SCANNING. This module's header EXPLAINS, at length,
 * the hazard of an `ownerUserId` argument and of reading `visibilityLevel` — so
 * a scan for those words over the raw file matches the WARNING and reports the
 * defect it was written to prevent. The same trap is recorded in
 * scripts/audit-db-authority.ts and it has been hit for real in this programme.
 */
function stripComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

const SITE: ReparentingSite = { table: "Transaction", fkField: "financialAccountId", operation: "updateMany" };

/** A client that records what it was asked, and answers from a fixed owner map. */
function fakeClient(owners: Record<string, string | null>) {
  const calls: Array<{ where: unknown; select: unknown }> = [];
  const client = {
    financialAccount: {
      findMany: async (args: { where: { id: { in: string[] } }; select: Record<string, boolean> }) => {
        calls.push({ where: args.where, select: args.select });
        return args.where.id.in
          .filter((id) => id in owners)
          .map((id) => ({ id, ownerUserId: owners[id] }));
      },
    },
  } as unknown as WriteClient;
  return { client, calls };
}

async function refusal(fn: () => Promise<unknown>): Promise<Error | null> {
  try { await fn(); return null; } catch (e) { return e instanceof Error ? e : new Error(String(e)); }
}

async function main(): Promise<void> {
  console.log("\naccount-reparenting — tenancy visibility is not mutation authority\n");

  // ── THE SHAPE: clauses 3, 4 and 5 are structural ──────────────────────────
  {
    const raw = src("lib/accounts/account-reparenting.ts");
    const code = stripComments(raw);

    // Clause 5. A request-controlled owner value must have nowhere to enter.
    //
    // ⚠️ ASSERTED BY EXTRACTING THE PARAMETER LISTS AND NAMING THEM EXACTLY,
    // not by a regex over the file. Two scanner failures this programme has
    // already paid for apply here: a `.match()` that returns only the FIRST
    // match would check one of the two exported functions and ignore the other,
    // and a `[^)]*` parameter-list pattern stops at the first `)` inside a type
    // annotation. A closed list of expected names also fails LOUDLY on an
    // unrecognised one, instead of passing over a parameter it did not think to
    // look for.
    const paramsOf = (name: string): string[] => {
      const at = [`export function ${name}(`, `export async function ${name}(`]
        .map((f) => code.indexOf(f)).find((i) => i >= 0);
      if (at === undefined) return ["(NOT FOUND)"];
      const open = code.indexOf("(", at);
      let depth = 0, end = -1;
      for (let i = open; i < code.length; i++) {
        if ("([{<".includes(code[i])) depth++;
        else if (")]}>".includes(code[i]) && --depth === 0) { end = i; break; }
      }
      let d = 0;
      return code.slice(open + 1, end).split("").reduce<string[]>((acc, ch) => {
        if ("([{<".includes(ch)) d++;
        if (")]}>".includes(ch)) d--;
        if (ch === "," && d === 0) acc.push("");
        else acc[acc.length - 1] += ch;
        return acc;
      }, [""]).map((p) => p.trim().split(/[?:]/)[0].trim()).filter(Boolean);
    };
    for (const [name, expected] of [
      ["assertAccountFkUnchanged", "site,rowId,observedAccountId,intendedAccountId"],
      ["assertAccountReparentingAuthorized", "client,site,sourceAccountId,destinationAccountId"],
    ] as const) {
      const got = paramsOf(name).join(",");
      check(`${name} takes EXACTLY ${expected} — no owner, no user, no tier (clause 5 has no door)`,
        got === expected, `got ${got}`);
    }
    check("the tokens userId / actorUserId / ownerSpaceId appear NOWHERE in the code",
      !/\b(userId|actorUserId|ownerSpaceId)\b/.test(code),
      "a forbidden identity token reached the code");
    check("ownerUserId appears ONLY as a database column — selected, mapped, compared, returned",
      (code.match(/ownerUserId/g) ?? []).length > 0);

    // Clause 4. The tier must be unreachable, not merely unused.
    check("visibilityLevel / FULL / BALANCE_ONLY are absent from the code entirely (clause 4 cannot be learned)",
      !/visibilityLevel|BALANCE_ONLY/.test(code) && !/\bFULL\b/.test(code),
      "a tier token reached the code");
    check("SpaceAccountLink and fm_account_visible are never consulted (clause 3: visibility is not authority)",
      !/spaceAccountLink|fm_account_visible/i.test(code));

    // Clauses 1, 2, 6. The probe must issue through the WRITE's client.
    check("the module imports NO database client — authority arrives as a parameter",
      !/from\s+["']@\/lib\/db["']/.test(code) && !/\bsystemDb\b|\btenantDb\b/.test(code));
    check("the client parameter is REQUIRED and FIRST (no default, so no ambient authority)",
      /assertAccountReparentingAuthorized\(\s*\n?\s*client: WriteClient,/.test(code)
        && !/client:\s*WriteClient\s*=/.test(code));
    check("assertAccountReparentingAuthorized has arity 4 — client, site, source, destination; nothing else",
      assertAccountReparentingAuthorized.length === 4, `arity ${assertAccountReparentingAuthorized.length}`);
  }

  // ── CLAUSE 6 — the unscoped source, the cheap half ────────────────────────
  {
    check("a row already on the intended account passes",
      (() => { try { assertAccountFkUnchanged(SITE, "tx1", "acct_a", "acct_a"); return true; } catch { return false; } })());

    const moved = (() => {
      try { assertAccountFkUnchanged(SITE, "tx1", "acct_shared", "acct_bob"); return null; }
      catch (e) { return e as Error; }
    })();
    check("a row on a DIFFERENT account raises UnintendedReparentingError",
      moved instanceof UnintendedReparentingError, moved?.name);
    check("the refusal names both accounts and the row, and NOTHING about the row's contents",
      moved instanceof UnintendedReparentingError
        && moved.rowId === "tx1" && moved.observedAccountId === "acct_shared" && moved.intendedAccountId === "acct_bob"
        && Object.keys(moved).sort().join(",") === ["name", "table", "fkField", "rowId", "observedAccountId", "intendedAccountId"].sort().join(","),
      moved instanceof UnintendedReparentingError ? Object.keys(moved).sort().join(",") : "");

    // ⚠️ THE FORGOTTEN-SELECT CASE. A `select` that omits the FK yields
    // undefined/null, and `null === null` would have cleared the comparison for
    // every row in the corpus — a guard that passes hardest exactly where the
    // read is broken.
    const nullObserved = (() => {
      try { assertAccountFkUnchanged(SITE, "tx1", null, "acct_bob"); return null; }
      catch (e) { return e as Error; }
    })();
    check("a NULL observed account REFUSES — a forgotten select must not read as agreement",
      nullObserved instanceof UnintendedReparentingError);
    const nullBoth = (() => {
      try { assertAccountFkUnchanged(SITE, "tx1", null, "acct_bob"); return "no throw"; }
      catch { return "threw"; }
    })();
    check("...and it refuses even when the intended account is the only thing known",
      nullBoth === "threw");
  }

  // ── CLAUSES 1,2,3 — the authority half, through a client that records ─────
  {
    const same = fakeClient({ acct_loser: "alice", acct_winner: "alice" });
    const ok = await assertAccountReparentingAuthorized(same.client, SITE, "acct_loser", "acct_winner");
    check("a SAME-OWNER move is authorized and reports the owner it proved",
      ok.ownerUserId === "alice" && ok.sourceAccountId === "acct_loser" && ok.destinationAccountId === "acct_winner",
      JSON.stringify(ok));
    check("the probe asked THIS client, once, for exactly the two accounts",
      same.calls.length === 1
        && JSON.stringify((same.calls[0].where as { id: { in: string[] } }).id.in) === JSON.stringify(["acct_loser", "acct_winner"]),
      JSON.stringify(same.calls));
    check("the `select` is CLOSED to {id, ownerUserId} — no ownerSpaceId, no tier, no row detail",
      Object.keys(same.calls[0].select as object).sort().join(",") === "id,ownerUserId",
      Object.keys(same.calls[0].select as object).sort().join(","));

    // ── THE ATTACK. Bob's account as the destination for Alice's row. ────────
    const cross = fakeClient({ acct_shared: "alice", acct_bob: "bob" });
    const crossErr = await refusal(() =>
      assertAccountReparentingAuthorized(cross.client, SITE, "acct_shared", "acct_bob"));
    check("a CROSS-OWNER move is refused — ReparentingRefusedError / CROSS_OWNER",
      crossErr instanceof ReparentingRefusedError && crossErr.reason === "CROSS_OWNER",
      `${crossErr?.name}/${crossErr instanceof ReparentingRefusedError ? crossErr.reason : "?"}`);

    // The INVERSE direction is the same defect and must refuse identically.
    const inverseErr = await refusal(() =>
      assertAccountReparentingAuthorized(cross.client, SITE, "acct_bob", "acct_shared"));
    check("the INVERSE direction (pushing one's own rows ONTO another owner's account) refuses identically",
      inverseErr instanceof ReparentingRefusedError && inverseErr.reason === "CROSS_OWNER");

    check("the refusal carries table/field/accounts/reason and NO row contents",
      crossErr instanceof ReparentingRefusedError
        && Object.keys(crossErr).sort().join(",")
           === ["name", "table", "fkField", "sourceAccountId", "destinationAccountId", "reason"].sort().join(","),
      crossErr instanceof ReparentingRefusedError ? Object.keys(crossErr).sort().join(",") : "");

    // ── AN UNRESOLVABLE ACCOUNT IS A REFUSAL, NOT AN ABSENCE ────────────────
    const missingDest = fakeClient({ acct_loser: "alice" });
    const missErr = await refusal(() =>
      assertAccountReparentingAuthorized(missingDest.client, SITE, "acct_loser", "acct_gone"));
    check("a destination this client cannot resolve refuses (UNRESOLVED_ACCOUNT) — hidden is not distinguishable from absent",
      missErr instanceof ReparentingRefusedError && missErr.reason === "UNRESOLVED_ACCOUNT",
      `${missErr?.name}/${missErr instanceof ReparentingRefusedError ? missErr.reason : "?"}`);

    const missingSrc = fakeClient({ acct_winner: "alice" });
    const missSrcErr = await refusal(() =>
      assertAccountReparentingAuthorized(missingSrc.client, SITE, "acct_gone", "acct_winner"));
    check("an unresolvable SOURCE refuses too — a destination-only check would have passed this",
      missSrcErr instanceof ReparentingRefusedError && missSrcErr.reason === "UNRESOLVED_ACCOUNT");

    // ── THE NULL-OWNER HOLE, CLOSED IN ONE PLACE ───────────────────────────
    const nullOwner = fakeClient({ acct_space: null, acct_winner: "alice" });
    const nullErr = await refusal(() =>
      assertAccountReparentingAuthorized(nullOwner.client, SITE, "acct_space", "acct_winner"));
    check("a NULL ownerUserId refuses (NULL_OWNER) — the reconcile.ts global-sweep hole closes here",
      nullErr instanceof ReparentingRefusedError && nullErr.reason === "NULL_OWNER",
      `${nullErr?.name}/${nullErr instanceof ReparentingRefusedError ? nullErr.reason : "?"}`);
    const bothNull = fakeClient({ acct_s1: null, acct_s2: null });
    const bothNullErr = await refusal(() =>
      assertAccountReparentingAuthorized(bothNull.client, SITE, "acct_s1", "acct_s2"));
    check("TWO null owners do not satisfy equality — null === null must not read as co-ownership",
      bothNullErr instanceof ReparentingRefusedError && bothNullErr.reason === "NULL_OWNER");

    // ── A SAME-ACCOUNT MOVE STILL RESOLVES ─────────────────────────────────
    const noop = fakeClient({ acct_a: "alice" });
    const noopOk = await assertAccountReparentingAuthorized(noop.client, SITE, "acct_a", "acct_a");
    check("a same-account move still PROBES rather than short-circuiting an unvalidated pair",
      noopOk.ownerUserId === "alice" && noop.calls.length === 1
        && (noop.calls[0].where as { id: { in: string[] } }).id.in.length === 1);
    const noopGone = fakeClient({});
    check("...and a same-account move over an unresolvable account refuses",
      (await refusal(() => assertAccountReparentingAuthorized(noopGone.client, SITE, "acct_x", "acct_x")))
        instanceof ReparentingRefusedError);
  }

  // ── THE CALLERS: the two unscoped-source selects must READ the FK ─────────
  {
    for (const [name, path, needle] of [
      ["syncTransactions plaidTransactionId lookup", "lib/plaid/syncTransactions.ts", "assertAccountFkUnchanged"],
      ["investment-event persist [source, externalEventId] lookup", "lib/investments/investment-event-ingest.ts", "assertAccountFkUnchanged"],
    ] as const) {
      const code = stripComments(src(path));
      check(`${name}: selects financialAccountId AND compares it`,
        /financialAccountId:\s*true/.test(code) && code.includes(needle),
        `select=${/financialAccountId:\s*true/.test(code)} guard=${code.includes(needle)}`);
    }

    // reconcile.ts is the AUTHORITY half's only current caller, and the
    // observation must stay in front of every bulk re-point (clauses 7/8).
    const rec = stripComments(src("lib/accounts/reconcile.ts"));
    check("reconcile.ts asks the authority question before it folds an account",
      rec.includes("assertAccountReparentingAuthorized("));
    check("reconcile.ts observes its bulk re-points and compares the counts",
      rec.includes("assertEveryObservedRowWasWritten("));

    // sync-current-holdings' FK clause was a no-op that would have become a
    // silent relocation path the moment the merge was extended. It is gone.
    const holdings = stripComments(src("lib/investments/sync-current-holdings.ts"));
    check("sync-current-holdings' holding.update no longer re-states financialAccountId (the no-op relocation path is gone)",
      /holding\.update\(\s*\{\s*where:\s*\{\s*id:\s*u\.id\s*\},\s*data:\s*u\.row\s*\}\s*\)/.test(holdings)
        && !/holding\.update\([^)]*financialAccountId/.test(holdings));
  }

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) failed.\n`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
