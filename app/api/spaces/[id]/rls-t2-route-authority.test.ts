/**
 * app/api/spaces/[id]/rls-t2-route-authority.test.ts
 *
 * RLS-T2 — WHAT EACH REMAINING SPACE ROUTE READS AS, STATED AS AN ASSERTION.
 *
 * The slice converted eleven route files. Nine of them legitimately still hold
 * the deployment-wide client for a NAMED reason, so "no `db` in a route" is not
 * the property — and the file-level ratchet in scripts/audit-db-authority.ts
 * cannot tell a route that kept ONE named exception from one that quietly grew a
 * second. This gate does, at STATEMENT granularity.
 *
 * Two halves, the house pattern (standalone tsx, exit 0/1):
 *
 *   1. BEHAVIOURAL — the two things the conversion actually changed about
 *      behaviour rather than authority: the bulk-write shortfall guard, and the
 *      canonical-first PlaidItem preference that replaced a relation include.
 *   2. SOURCE SCAN — the per-file authority inventory, plus the ordering and
 *      count-reading invariants the conversion depends on.
 *
 * ⚠️ EVERY ABSENCE CLAIM HERE CARRIES A DENOMINATOR. A scan that matches nothing
 * reports clean over zero sites — the exact way a prior slice's `\b$transaction\(`
 * needle "passed" — so every expectation below is a multiset the scan must EQUAL,
 * and the totals are asserted non-zero.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  assertEveryObservedRowWasWritten,
  PartialBulkWriteError,
} from "@/lib/db/conditional-write";

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { passed++; return; }
  failures.push(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
}

const ROOT = process.cwd();
const src = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/**
 * Comments removed, so the inventory below is about CODE.
 *
 * Deliberately crude, and SAFE in the direction that matters: if this ever
 * strips too much, a real `db.` site disappears from the measured set and the
 * equality assertions FAIL. It cannot turn a missed site into a pass.
 */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

// ── 1. BEHAVIOURAL ───────────────────────────────────────────────────────────

// 1a. The bulk shortfall guard, over the shapes the two converted write sites
//     actually produce. Non-vacuous by construction: the "complete" cases carry
//     a POSITIVE observed count, so none of them passes because nothing was
//     eligible.
const site = { table: "SpaceAccountLink", operation: "update" as const, scope: "test scope" };
{
  let threw = false;
  try { assertEveryObservedRowWasWritten(site, 3, 3); } catch { threw = true; }
  check("3 eligible rows, 3 written → no shortfall (denominator 3, not 0)", !threw);
}
{
  let err: unknown = null;
  try { assertEveryObservedRowWasWritten(site, 2, 1); } catch (e) { err = e; }
  check("2 eligible, 1 written → PartialBulkWriteError (the half-landed revoke)",
    err instanceof PartialBulkWriteError,
    `got ${err === null ? "no error" : String((err as Error).name)}`);
  check("the error carries both numbers, so an operator sees the deficit",
    err instanceof PartialBulkWriteError && err.observed === 2 && err.written === 1);
}
{
  let err: unknown = null;
  try { assertEveryObservedRowWasWritten(site, 1, 0); } catch (e) { err = e; }
  check("1 eligible, 0 written → raises (a wholly refused revoke is not success)",
    err instanceof PartialBulkWriteError);
}
{
  // The idempotent cancel: nothing was eligible, so nothing is a shortfall. This
  // is the case `resolveConditionalWrite` would have thrown on, which is why the
  // invite cancel uses the bulk helper instead.
  let threw = false;
  try {
    assertEveryObservedRowWasWritten(
      { table: "SpaceInvite", operation: "delete", scope: "one invite id in this Space" }, 0, 0);
  } catch { threw = true; }
  check("0 eligible, 0 deleted → honestly idempotent, not an error", !threw);
}

// 1b. Mirror of the PlaidItem preference the relation include used to express:
//     `connections.find(c => c.isCanonical && c.plaidItem) ?? connections.find(c => c.plaidItem)`.
//     Half (2) asserts the real route still carries the same two-tier shape.
function pickPlaidItemMirror<I>(
  connections: readonly { isCanonical: boolean; plaidItemDbId: string | null }[],
  itemById:    ReadonlyMap<string, I>,
): I | null {
  const first = (cs: readonly { plaidItemDbId: string | null }[]): I | null => {
    for (const c of cs) {
      const item = c.plaidItemDbId === null ? undefined : itemById.get(c.plaidItemDbId);
      if (item !== undefined) return item;
    }
    return null;
  };
  return first(connections.filter((c) => c.isCanonical)) ?? first(connections);
}
{
  const items = new Map([["pi_a", "A"], ["pi_b", "B"]]);
  check("a canonical connection's item wins over a non-canonical one listed first",
    pickPlaidItemMirror(
      [{ isCanonical: false, plaidItemDbId: "pi_b" }, { isCanonical: true, plaidItemDbId: "pi_a" }],
      items) === "A");
  check("with no canonical item, a non-canonical one is the fallback",
    pickPlaidItemMirror([{ isCanonical: false, plaidItemDbId: "pi_b" }], items) === "B");
  check("a canonical connection whose item is UNREADABLE falls through, it does not end the search",
    pickPlaidItemMirror(
      [{ isCanonical: true, plaidItemDbId: "pi_missing" }, { isCanonical: false, plaidItemDbId: "pi_b" }],
      items) === "B",
    "an invisible co-member PlaidItem must not mask a readable one");
  check("a manual account (no plaidItemDbId anywhere) resolves to null, never a fabricated item",
    pickPlaidItemMirror([{ isCanonical: true, plaidItemDbId: null }], items) === null);
  check("no connections at all → null", pickPlaidItemMirror([], items) === null);
}

// ── 2. SOURCE SCAN ───────────────────────────────────────────────────────────

/**
 * The slice's eleven files, and the `db.<model>` sites each is ALLOWED to keep.
 *
 * Every entry is a named exception documented in that file's header. An empty
 * array means the file reaches the database only as the authenticated caller.
 * The assertion is EQUALITY, in both directions: a new unexplained `db.` site
 * fails, and so does a stale allowlist entry for a site that has since been
 * converted.
 */
const AUTHORITY_INVENTORY: ReadonlyArray<readonly [string, readonly string[]]> = [
  // The actor's display name — `User.fm_app_sel` is `id = current_fm_user_id()`.
  ["app/api/spaces/[id]/activity/route.ts", ["db.user"]],
  // The cross-Space orphan count, and the one real delete (no fm_app DELETE
  // policy on "Space").
  ["app/api/spaces/[id]/permanent/route.ts", ["db.financialAccount", "db.space"]],
  // The PERSONAL guard that would fail OPEN for a non-member invitee, and the
  // re-join arm `SpaceMember.fm_app_upd` lacks.
  ["app/api/spaces/[id]/invites/[inviteId]/route.ts",
    ["db.$transaction", "db.space", "db.spaceInvite", "db.spaceMember"]],
  // The adder's display name, and a co-member's PlaidItem state.
  ["app/api/spaces/[id]/accounts/detail/route.ts", ["db.plaidItem", "db.user"]],
  // The Space-level backfill probe over a USER-keyed table.
  ["app/api/spaces/[id]/snapshots/route.ts", ["db.plaidItem"]],
  // The documented PUBLIC-Space read, which fm_app's Space policy does not serve.
  ["app/api/spaces/[id]/route.ts", ["db.space"]],
  // The target member's display name for an audit payload.
  ["app/api/spaces/[id]/members/[userId]/route.ts", ["db.user"]],
  // Display identity for the invitee and the inviter.
  ["app/api/spaces/[id]/invites/route.ts", ["db.user"]],
  // Username → user: the route's whole purpose is a question about someone else.
  ["app/api/spaces/[id]/invite/route.ts", ["db.user"]],
  // Fully converted.
  ["app/api/spaces/[id]/expense-baseline/route.ts", []],
  ["app/api/connections/build-intelligence/route.ts", []],
];

let totalSites = 0;
let totalExpected = 0;
for (const [rel, allowed] of AUTHORITY_INVENTORY) {
  const code = stripComments(src(rel));
  const found = (code.match(/\bdb\.[A-Za-z$][A-Za-z0-9$]*/g) ?? []).sort();
  const want  = [...allowed].sort();
  totalSites += found.length;
  totalExpected += want.length;
  check(`${rel}: db sites are exactly the named exceptions`,
    found.join(",") === want.join(","),
    `found=[${found.join(",")}] allowed=[${want.join(",")}]`);

  // Every one of the eleven reaches the database as the caller for something.
  check(`${rel}: calls withTenantDb`, code.includes("withTenantDb("));

  // A file with no named exception must not import the migration principal at
  // all — that is what shrinks the file-level ratchet.
  const importsDb = code.includes('from "@/lib/db"');
  check(`${rel}: imports @/lib/db iff it has a named exception`,
    importsDb === (allowed.length > 0),
    `importsDb=${importsDb} exceptions=${allowed.length}`);
}
check("the inventory covers all eleven files of the slice", AUTHORITY_INVENTORY.length === 11,
  String(AUTHORITY_INVENTORY.length));
// THE DENOMINATOR. If the scan regex ever stops matching, these go to 0 and the
// equality checks above all "pass" over an empty set. They must not be 0.
check("the db-site scan matched a non-zero number of sites", totalSites > 0, `totalSites=${totalSites}`);
check("expected and found site totals agree", totalSites === totalExpected,
  `found=${totalSites} expected=${totalExpected}`);
check("nine of the eleven files still hold a named exception",
  AUTHORITY_INVENTORY.filter(([, a]) => a.length > 0).length === 9);

// ── 2a. members/[userId] — the ordering AND the detector ──────────────────────
{
  // Scoped to the DELETE handler: PATCH has a `tx.spaceMember.update(` of its own
  // and comparing offsets across both handlers would compare the wrong pair.
  const whole = src("app/api/spaces/[id]/members/[userId]/route.ts");
  const iDeleteHandler = whole.indexOf("export const DELETE");
  check("the DELETE handler is locatable for the ordering scan", iDeleteHandler > -1);
  const code = whole.slice(iDeleteHandler);
  const iCount  = code.indexOf("tx.spaceAccountLink.count(");
  const iUpdate = code.indexOf("tx.spaceAccountLink.updateMany(");
  const iAssert = code.indexOf("assertEveryObservedRowWasWritten(");
  const iMember = code.indexOf("tx.spaceMember.update(");
  check("the link count, the link revoke, the assertion and the member flip all exist",
    iCount > -1 && iUpdate > -1 && iAssert > -1 && iMember > -1,
    `count=${iCount} update=${iUpdate} assert=${iAssert} member=${iMember}`);
  check("the eligible-row COUNT precedes the revoke (the observation IS the guard)",
    iCount > -1 && iUpdate > -1 && iCount < iUpdate);
  check("the shortfall assertion follows the revoke",
    iAssert > iUpdate);
  // The slice-B reorder this slice must not undo: the SAL revoke runs while the
  // acting user is still ACTIVE, before the membership flip makes the Space
  // invisible to the next statement.
  check("the link revoke still precedes the SpaceMember flip (the self-leave reorder)",
    iUpdate < iMember, `update=${iUpdate} member=${iMember}`);
  check("the count and the write go through the SAME tenant client",
    /tx\.spaceAccountLink\.count\(/.test(code) && /tx\.spaceAccountLink\.updateMany\(/.test(code));
}

// ── 2b. invites/[inviteId] — the cancel no longer reports success it did not earn
{
  const code = src("app/api/spaces/[id]/invites/[inviteId]/route.ts");
  const iCount  = code.indexOf("tx.spaceInvite.count(");
  const iDelete = code.indexOf("tx.spaceInvite.deleteMany(");
  const iAssert = code.indexOf("assertEveryObservedRowWasWritten(");
  check("the invite cancel counts, deletes and asserts",
    iCount > -1 && iDelete > -1 && iAssert > -1,
    `count=${iCount} delete=${iDelete} assert=${iAssert}`);
  check("the eligible count precedes the delete", iCount < iDelete);
  check("the assertion follows the delete", iAssert > iDelete);
  check("the cancel does NOT use resolveConditionalWrite (its probe would throw on an idempotent repeat)",
    !code.includes("resolveConditionalWrite("));
}

// ── 2c. activity — the AuditLog actor include is gone, the stitch is there ────
{
  const code = src("app/api/spaces/[id]/activity/route.ts");
  check("the AuditLog read selects the actor's ID, not the actor relation",
    /userId:\s*true/.test(code), "the tenant read must carry userId for the stitch");
  check("no relation include with a nested select survives in this route",
    !/\buser:\s*\{\s*\n\s*select:/.test(code),
    "an optional User include returns null under fm_app and unattributes the whole feed");
  check("the actor display read is a named db.user.findMany",
    /db\.user\.findMany\(/.test(code));
  check("all four source reads moved onto the tenant client",
    ["tx.auditLog.findMany(", "tx.spaceAccountLink.findMany(", "tx.importBatch.findMany(",
      "tx.syncIssue.findMany("].every((n) => code.includes(n)));
  // The SyncIssue column grant (migration 20261002000500) is exactly these six
  // columns. Anything outside it is refused by Postgres, not merely discouraged.
  const GRANTED = new Set(["id", "kind", "resolved", "createdAt", "financialAccountId", "plaidTransactionId"]);
  // ⚠️ Comments stripped FIRST. The prose beside this query contains the words
  // "Defence in depth", and `depth:` matched the column regex — a needle that
  // scanned prose rather than code, which is the family of error this file's
  // header is about.
  const codeOnly  = stripComments(code);
  const syncQuery = codeOnly.slice(codeOnly.indexOf("tx.syncIssue.findMany("));
  const syncBody  = syncQuery.slice(0, syncQuery.indexOf("}),"));
  const columns   = [...syncBody.matchAll(/([A-Za-z][A-Za-z0-9]*):/g)].map((m) => m[1])
    .filter((c) => !["where", "orderBy", "take", "select", "not", "in"].includes(c));
  check("the SyncIssue query reads only COLUMN-GRANTED fields",
    columns.length > 0 && columns.every((c) => GRANTED.has(c)),
    `columns=[${columns.join(",")}] ungranted=[${columns.filter((c) => !GRANTED.has(c)).join(",")}]`);
  check("the SyncIssue column scan found a real denominator", columns.length >= 5, `n=${columns.length}`);
}

// ── 2d. accounts/detail — both degrading includes are out, both reads are named
{
  const code = src("app/api/spaces/[id]/accounts/detail/route.ts");
  check("the addedByUser relation include is gone", !/addedByUser:\s*\{\s*\n\s*select:/.test(code));
  check("the plaidItem relation include is gone", !/plaidItem:\s*\{\s*select:/.test(code));
  check("the adder display identity is a named db.user.findMany", /db\.user\.findMany\(/.test(code));
  check("the PlaidItem state is a named db.plaidItem.findMany", /db\.plaidItem\.findMany\(/.test(code));
  check("the PlaidItem read is narrowed to the two columns deriveConnectionState consumes",
    code.includes("select: { id: true, status: true, syncIncompleteAt: true }"));
  check("isManual is still derived from the plaidItemDbId SCALAR",
    code.includes("a.connections.some((c) => c.plaidItemDbId !== null)"));
  check("the item preference is still canonical-first",
    /first\(connections\.filter\(\(c\) => c\.isCanonical\)\) \?\? first\(connections\)/.test(code));
  check("the heavy reads moved onto the tenant client",
    ["client.spaceAccountLink.findMany(", "client.importBatch.groupBy(",
      "client.transaction.groupBy("].every((n) => code.includes(n)));
  check("loadPendingEvidence and loadWalletCurrentValues are handed the caller's client",
    code.includes("loadPendingEvidence(client,") && /contextSpaceId: spaceId, client/.test(code),
    "loadWalletCurrentValues still defaults to `db`, so an omitted client is an ambient authority");
}

// ── 2e. snapshots / expense-baseline / build-intelligence ────────────────────
{
  const code = src("app/api/spaces/[id]/snapshots/route.ts");
  check("snapshots reads its link set on the tenant client",
    code.includes("tx.spaceAccountLink.findMany("));
  check("the snapshot series and the link set share ONE phase",
    (code.match(/withTenantDb\(/g) ?? []).length === 1,
    "two phases here would scope the probe by a link set from another snapshot");
}
{
  const code = src("app/api/spaces/[id]/expense-baseline/route.ts");
  check("the assembler is handed the caller's client, not the migration principal",
    /assemble\(tx, spaceCtx/.test(code));
  check("the assembler phase's budget is IMPORTED, not a hand-copied number",
    code.includes("PHASE_BUDGET_MS.PROLOGUE") && !/timeout:\s*\d/.test(code));
}
{
  const code = src("app/api/connections/build-intelligence/route.ts");
  check("the connection resolution and the audit write are SEPARATE phases",
    (code.match(/withTenantDb\(/g) ?? []).length === 2,
    "one phase held across regenerateWealthHistoryForAccounts would pin a pooled connection");
  const iRead    = code.indexOf("tx.accountConnection.findMany(");
  const iRebuild = code.indexOf("regenerateWealthHistoryForAccounts(");
  const iAudit   = code.indexOf("tx.auditLog.createMany(");
  check("the rebuild sits BETWEEN the two phases, not inside either",
    iRead > -1 && iRebuild > iRead && iAudit > iRebuild,
    `read=${iRead} rebuild=${iRebuild} audit=${iAudit}`);
}

// ── Report ───────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`\nRLS-T2 route authority: ${failures.length} FAILURE(S) (${passed} checks passed):`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
console.log(`RLS-T2 route authority: all ${passed} checks passed (${totalSites} db sites inventoried).`);
process.exit(0);
