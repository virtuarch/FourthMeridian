/**
 * lib/accounts/links-everywhere.test.ts  (RLS-C-S7)
 *
 * THE BEHAVIOUR-PRESERVATION PIN FOR THE SLICE: a joint account disconnected by
 * one owner revokes the CO-OWNER's link too, and the co-owner's Space comes back
 * in `affectedSpaceIds` so their snapshot is regenerated. That is what the
 * product has always done, and an authority migration is not allowed to change
 * it quietly. See docs/plans/RLS-DISCONNECT-BLAST-RADIUS.md.
 *
 * ⚠️ THE VACUOUS PASS IS THE REAL ADVERSARY HERE. A fixture that yields an empty
 * link set makes every assertion below pass for the wrong reason — an earlier
 * slice in this programme shipped exactly that bug. So the positive fixture is
 * asserted to have TWO links in TWO DISTINCT Spaces *before* anything is claimed
 * about the outcome, and the assertion on the result compares against those two
 * Space ids by name rather than against a count.
 *
 * What a unit test can and cannot prove, stated so nobody over-reads a green run:
 *   CAN — the capability's shape, its `where` clauses, which argument reaches
 *         which clause, that it revokes every observed link and reports both
 *         counts, that a shortfall raises, and (by source scan) that the ids it
 *         receives are computed inside a tenant phase and that the two
 *         policy-forced orderings are the ones in the source.
 *   CANNOT — that `fm_system` actually sees the co-owner's row. That needs a live
 *         Postgres with real roles, i.e. scripts/rls-app-acceptance.ts. Local
 *         development has NO role URLs, so every client falls back to one
 *         principal and a wrong authority would not fail a single test here.
 *         That asymmetry is why so much of this file is a source scan.
 *
 *   npx tsx lib/accounts/links-everywhere.test.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ShareStatus } from "@prisma/client";

import {
  revokeAccountLinksEverywhere,
  reactivateAccountLinksEverywhere,
  type AtomicLinkLifecycle,
  type SpaceAccountLinkLifecycleDelegate,
} from "@/lib/accounts/links-everywhere";
import { PartialBulkWriteError, assertEveryObservedRowWasWritten } from "@/lib/db/conditional-write";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const ROOT = join(__dirname, "..", "..");
const src = (p: string) => readFileSync(join(ROOT, p), "utf8");
/** Comments stripped: a header that EXPLAINS a hazard must never satisfy a scan for it. */
const code = (p: string) => src(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ── AN IN-MEMORY SpaceAccountLink TABLE ──────────────────────────────────────
// Deliberately NOT policy-aware: it stands in for the DEPLOYMENT-WIDE authority,
// which sees everything. The test's job is to prove the capability asks for every
// link; whether the role is allowed to have them is the acceptance suite's job.

interface Row {
  id: string;
  spaceId: string;
  financialAccountId: string;
  status: ShareStatus;
  revokedAt: Date | null;
  revokedByUserId: string | null;
}

interface Recorder {
  readonly rows: Row[];
  readonly whereClauses: unknown[];
  readonly dataClauses: unknown[];
  /** Forces a reported count LOWER than the rows actually written. */
  underReportBy: number;
  readonly atomically: AtomicLinkLifecycle;
  transactions: number;
}

function table(rows: Row[]): Recorder {
  const rec: Recorder = {
    rows,
    whereClauses: [],
    dataClauses: [],
    underReportBy: 0,
    transactions: 0,
    atomically: null as unknown as AtomicLinkLifecycle,
  };

  const matches = (r: Row, where: Record<string, unknown>): boolean => {
    const ids = (where.financialAccountId as { in?: string[] } | undefined)?.in;
    if (ids && !ids.includes(r.financialAccountId)) return false;
    if (where.status !== undefined && r.status !== where.status) return false;
    return true;
  };

  const links: SpaceAccountLinkLifecycleDelegate = {
    async findMany(args) {
      rec.whereClauses.push(args.where);
      return rec.rows
        .filter((r) => matches(r, args.where as Record<string, unknown>))
        .map((r) => ({ spaceId: r.spaceId }));
    },
    async updateMany(args) {
      rec.whereClauses.push(args.where);
      rec.dataClauses.push(args.data);
      const hit = rec.rows.filter((r) => matches(r, args.where as Record<string, unknown>));
      for (const r of hit) Object.assign(r, args.data);
      return { count: Math.max(0, hit.length - rec.underReportBy) };
    },
  };

  (rec as { atomically: AtomicLinkLifecycle }).atomically = async (run) => {
    rec.transactions++;
    return run(links);
  };
  return rec;
}

const ACTOR = "user_alice";
const JOINT = "acct_joint";
const ALICE_SPACE = "space_alice_personal";
const BOB_SPACE = "space_bob_personal";

function jointAccountInTwoSpaces(status: ShareStatus): Row[] {
  return [
    { id: "sal_1", spaceId: ALICE_SPACE, financialAccountId: JOINT, status, revokedAt: null, revokedByUserId: null },
    { id: "sal_2", spaceId: BOB_SPACE,   financialAccountId: JOINT, status, revokedAt: null, revokedByUserId: null },
    // A third link on a DIFFERENT account, so "revokes everything in the table"
    // cannot pass as "revokes everything for these ids".
    { id: "sal_3", spaceId: BOB_SPACE, financialAccountId: "acct_bob_only", status, revokedAt: null, revokedByUserId: null },
  ];
}

async function main(): Promise<void> {
  console.log("RLS-C-S7 — the deployment-wide SpaceAccountLink lifecycle");

  console.log("\n1. THE CO-OWNER'S LINK IS REVOKED, AND THEIR SPACE IS REPORTED");
  {
    const rows = jointAccountInTwoSpaces(ShareStatus.ACTIVE);
    const t = table(rows);

    // ── ANTI-VACUITY. Prove the fixture is the one the test claims to be about
    //    BEFORE asserting anything about the outcome.
    const jointActive = rows.filter((r) => r.financialAccountId === JOINT && r.status === ShareStatus.ACTIVE);
    check("FIXTURE: the joint account genuinely has TWO ACTIVE links",
      jointActive.length === 2, `${jointActive.length} link(s)`);
    check("FIXTURE: …in TWO DISTINCT Spaces, one of which is not the actor's",
      new Set(jointActive.map((r) => r.spaceId)).size === 2 && jointActive.some((r) => r.spaceId === BOB_SPACE));

    const revokedAt = new Date("2026-10-02T12:00:00.000Z");
    const result = await revokeAccountLinksEverywhere([JOINT], ACTOR, revokedAt, t.atomically);

    const alice = rows.find((r) => r.id === "sal_1")!;
    const bob   = rows.find((r) => r.id === "sal_2")!;
    const other = rows.find((r) => r.id === "sal_3")!;

    check("the actor's own link is REVOKED", alice.status === ShareStatus.REVOKED);
    check("THE CO-OWNER'S LINK IS REVOKED TOO — the shipped semantics, preserved",
      bob.status === ShareStatus.REVOKED, `status ${bob.status}`);
    check("a link on an UNRELATED account is untouched", other.status === ShareStatus.ACTIVE);
    check("both links carry revokedAt and revokedByUserId",
      alice.revokedAt === revokedAt && bob.revokedAt === revokedAt
      && alice.revokedByUserId === ACTOR && bob.revokedByUserId === ACTOR);

    check("BOTH Spaces appear in affectedSpaceIds, so BOTH snapshots regenerate",
      [...result.affectedSpaceIds].sort().join(",") === [ALICE_SPACE, BOB_SPACE].sort().join(","),
      result.affectedSpaceIds.join(","));
    check("…deduplicated, and never the unrelated account's extra Space entry",
      result.affectedSpaceIds.length === 2);
    check("observed and changed counts agree on the happy path",
      result.observedLinkCount === 2 && result.changedLinkCount === 2,
      `observed ${result.observedLinkCount}, changed ${result.changedLinkCount}`);
    check("the observation and the write share ONE transaction", t.transactions === 1);
  }

  console.log("\n2. A SHORTFALL DOES NOT PASS QUIETLY");
  {
    // The partial is the nasty form: 1-of-2 looks exactly like success.
    const rows = jointAccountInTwoSpaces(ShareStatus.ACTIVE);
    const t = table(rows);
    t.underReportBy = 1;

    const result = await revokeAccountLinksEverywhere([JOINT], ACTOR, new Date(), t.atomically);
    check("the capability REPORTS the shortfall rather than hiding it",
      result.observedLinkCount === 2 && result.changedLinkCount === 1,
      `observed ${result.observedLinkCount}, changed ${result.changedLinkCount}`);

    let err: unknown = null;
    try {
      assertEveryObservedRowWasWritten(
        { table: "SpaceAccountLink", operation: "update", scope: "1 authorized account id" },
        result.observedLinkCount, result.changedLinkCount,
      );
    } catch (e) { err = e; }
    check("…and the caller's assertion RAISES on it",
      err instanceof PartialBulkWriteError, err === null ? "no error" : String(err));
    check("the error names both numbers, so an operator can see it was a PARTIAL",
      err instanceof PartialBulkWriteError && err.observed === 2 && err.written === 1);
    check("…and refuses the two wrong conclusions by name",
      err instanceof Error && /partially applied/i.test(err.message));

    // The inverse must NOT raise: a link that became eligible between the two
    // statements is a link that also needed writing.
    let extra: unknown = null;
    try {
      assertEveryObservedRowWasWritten(
        { table: "SpaceAccountLink", operation: "update", scope: "x" }, 2, 3);
    } catch (e) { extra = e; }
    check("a count ABOVE the observation is a benign race, not a shortfall", extra === null);
  }

  console.log("\n3. THE CAPABILITY RETURNS COUNTS AND SPACE IDS — NEVER ROWS");
  {
    const t = table(jointAccountInTwoSpaces(ShareStatus.ACTIVE));
    const result = await revokeAccountLinksEverywhere([JOINT], ACTOR, new Date(), t.atomically);

    check("the result has EXACTLY three keys",
      Object.keys(result).sort().join(",") === "affectedSpaceIds,changedLinkCount,observedLinkCount",
      Object.keys(result).join(","));
    check("affectedSpaceIds is a list of plain strings — no row, no status, no userId",
      result.affectedSpaceIds.every((s) => typeof s === "string"));
    check("the two counts are numbers",
      typeof result.observedLinkCount === "number" && typeof result.changedLinkCount === "number");

    // ── NO SELECTOR THROUGH WHICH TO ASK ABOUT SOMEBODY ELSE ─────────────────
    const keys = t.whereClauses.flatMap((w) => Object.keys(w as object));
    check("every `where` mentions ONLY financialAccountId and status",
      keys.every((k) => k === "financialAccountId" || k === "status"), [...new Set(keys)].join(","));
    check("no `where` carries a spaceId", !keys.includes("spaceId"));
    check("no `where` carries a userId / addedByUserId / revokedByUserId",
      !keys.some((k) => /userId$/i.test(k)));
    check("actorUserId reaches the DATA as revokedByUserId and nothing else",
      t.dataClauses.every((d) => (d as Record<string, unknown>).revokedByUserId === ACTOR));

    const mod = code("lib/accounts/links-everywhere.ts");
    // The PARAMETER LISTS of the exported capabilities, not the file: `spaceId`
    // legitimately appears in the RETURN shape (that is the whole point of the
    // affected-Space capture). What must not exist is an argument.
    const signatures = [...mod.matchAll(/export async function \w+\(([\s\S]*?)\):/g)].map((m) => m[1]);
    check("there ARE exported capabilities to inspect", signatures.length === 2, `${signatures.length}`);
    check("no capability takes a spaceId argument",
      signatures.every((s) => !/\bspaceId\b/.test(s)), signatures.join(" | "));
    check("the only userId-shaped argument anywhere is actorUserId (written, never selected)",
      signatures.flatMap((s) => s.match(/\b\w*[Uu]serId\b/g) ?? []).every((p) => p === "actorUserId"));
    check("it never reads a Space, a SpaceMember or a User", !/\b(space|spaceMember|user)\./.test(mod));
    check("it touches ONLY the spaceAccountLink delegate",
      (mod.match(/\btx\.[a-zA-Z]+/g) ?? []).every((m) => m === "tx.spaceAccountLink"));
    check("systemDb is reached in exactly ONE place in the module",
      (mod.match(/systemDb\./g) ?? []).length === 1);
    check("an empty id list short-circuits before any authority is touched",
      (await revokeAccountLinksEverywhere([], ACTOR, new Date(), table([]).atomically)).observedLinkCount === 0);
  }

  console.log("\n4. THE INVERSE — reactivation is the same operation run backwards");
  {
    const rows = jointAccountInTwoSpaces(ShareStatus.REVOKED);
    const t = table(rows);
    const revoked = rows.filter((r) => r.financialAccountId === JOINT && r.status === ShareStatus.REVOKED);
    check("FIXTURE: two REVOKED links in two Spaces", revoked.length === 2
      && new Set(revoked.map((r) => r.spaceId)).size === 2);

    const result = await reactivateAccountLinksEverywhere([JOINT], t.atomically);
    check("THE CO-OWNER'S LINK IS REACTIVATED, so their net worth hears about it again",
      rows.find((r) => r.id === "sal_2")!.status === ShareStatus.ACTIVE);
    check("both Spaces are reported", result.affectedSpaceIds.length === 2);
    check("revokedAt and revokedByUserId are CLEARED",
      t.dataClauses.every((d) => (d as Record<string, unknown>).revokedAt === null
        && (d as Record<string, unknown>).revokedByUserId === null));
    check("it takes no actorUserId at all — narrower than the revoke",
      reactivateAccountLinksEverywhere.length <= 2, `arity ${reactivateAccountLinksEverywhere.length}`);
  }

  console.log("\n5. AUTHORIZATION PRECEDES THE CAPABILITY (source scan — see the header)");
  {
    const dis = code("lib/accounts/disconnect.ts");

    check("disconnect.ts opens a tenant phase",
      /withTenantDb\(\s*actorUserId/.test(dis));
    check("the capability is called with provenIds, NOT with the caller's parameter",
      /revokeAccountLinksEverywhere\(\s*provenIds/.test(dis)
      && !/revokeAccountLinksEverywhere\(\s*financialAccountIds/.test(dis));
    // provenIds must be DERIVED from a tenant read, not aliased to the input.
    const tenantBody = dis.slice(dis.indexOf("withTenantDb("), dis.indexOf("revokeAccountLinksEverywhere("));
    check("provenIds is DERIVED from a tenant-client FinancialAccount read, not aliased to the input",
      /tx\.financialAccount\.findMany/.test(tenantBody)
      && /ownedIds\s*=\s*new Set\(proven\.map/.test(tenantBody)
      && /provenIds\s*=\s*requested\.filter\(\(id\)\s*=>\s*ownedIds\.has\(id\)\)/.test(tenantBody));
    check("…and the read requires OWNERSHIP, not mere visibility",
      /ownerUserId:\s*actorUserId/.test(tenantBody));
    check("an unproved id RAISES rather than reaching the capability",
      /UnauthorizedDisconnectError/.test(tenantBody));
    check("the shortfall is asserted at the call site",
      /assertEveryObservedRowWasWritten\(/.test(dis)
      && /revocation\.observedLinkCount/.test(dis) && /revocation\.changedLinkCount/.test(dis));
    check("disconnect.ts no longer imports the migration principal",
      !/import\s*\{[^}]*\bdb\b[^}]*\}\s*from\s*["']@\/lib\/db["']/.test(dis));

    for (const route of [
      "app/api/accounts/[id]/restore/route.ts",
      "app/api/accounts/manual/[id]/restore/route.ts",
    ]) {
      const r = code(route);
      check(`${route}: proves ownership on the tenant client before reactivating`,
        /withTenantDb\([^)]*\(tx\)\s*=>\s*tx\.financialAccount\.findUnique/.test(r)
        && /ownerUserId !== (user\.id|userId)/.test(r)
        && r.indexOf("ownerUserId !==") < r.indexOf("reactivateAccountLinksEverywhere("));
      check(`${route}: asserts the reactivation shortfall`,
        /assertEveryObservedRowWasWritten\(/.test(r) && /reactivation\.changedLinkCount/.test(r));
      check(`${route}: no longer imports the migration principal`,
        !/import\s*\{[^}]*\bdb\b[^}]*\}\s*from\s*["']@\/lib\/db["']/.test(r));
    }
  }

  console.log("\n6. THE TWO POLICY-FORCED ORDERINGS, WHICH FAIL SILENTLY IF REVERSED");
  {
    // AccountConnection.fm_app_upd = fm_account_visible("financialAccountId"),
    // true only while an ACTIVE link exists in a visible Space.
    const dis = code("lib/accounts/disconnect.ts");
    check("DISCONNECT: the connection soft-delete comes BEFORE the link revoke",
      dis.indexOf("accountConnection.updateMany") < dis.indexOf("revokeAccountLinksEverywhere("),
      "revoking first makes the connections invisible and their write is refused silently");

    for (const route of [
      "app/api/accounts/[id]/restore/route.ts",
      "app/api/accounts/manual/[id]/restore/route.ts",
    ]) {
      const r = code(route);
      check(`RESTORE ${route}: the link reactivation comes BEFORE the connection un-delete`,
        r.indexOf("reactivateAccountLinksEverywhere(") < r.indexOf("accountConnection.updateMany"),
        "un-deleting first is refused silently — the links that confer visibility are still REVOKED");
    }

    const perm = code("app/api/accounts/manual/[id]/permanent/route.ts");
    check("PERMANENT DELETE: the connection delete comes BEFORE the link delete",
      perm.indexOf("accountConnection.deleteMany") < perm.indexOf("dualDeleteSpaceAccountLinks("));
  }

  console.log("\n7. fm_system IS NOT BECOMING A NEIGHBOURHOOD");
  {
    const audit = src("scripts/audit-db-authority.ts");
    check("the capability is allowlisted as a FILE, not as lib/accounts/",
      audit.includes('"lib/accounts/links-everywhere.ts"') && !audit.includes('"lib/accounts/"'));
    check("…with the reason stated in the allowlist, in the availability.ts voice",
      /RLS-C-S7[\s\S]{0,2200}"lib\/accounts\/links-everywhere\.ts"/.test(audit));

    // The ONE systemDb importer under lib/accounts/ must be this file. Comments
    // stripped: the modules that EXPLAIN why they no longer reach fm_system must
    // not read as reaching it.
    const importers = ["disconnect.ts", "reconcile.ts", "space-account-link.ts", "persist-account-spine.ts",
      "credit-utilization.ts", "display-identity.ts", "provider-identity.ts", "wallet-connection.ts",
      "wallet-connection-format.ts"]
      .filter((f) => /\bsystemDb\b/.test(code(`lib/accounts/${f}`)));
    check("no other module under lib/accounts/ imports systemDb",
      importers.length === 0, importers.join(","));
  }

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) failed.\n`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
