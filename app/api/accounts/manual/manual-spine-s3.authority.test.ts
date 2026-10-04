/**
 * app/api/accounts/manual/manual-spine-s3.authority.test.ts  (RLS-ACC-S3)
 *
 * THE MANUAL-ASSET LIFECYCLE RUNS AS THE CALLER, REVOKES EVERY LINK IN EVERY
 * SPACE, AND WRITES IN THE ONLY ORDER THE POLICIES PERMIT.
 *
 * Two defects are pinned here and they fail in OPPOSITE ways, which is the whole
 * reason the file is not just a scan:
 *
 *   DEFECT 1 (DELETE)  a bare `spaceAccountLink.updateMany` whose count was
 *                      discarded. Under `fm_app` it writes 1 OF 2 and raises
 *                      nothing. A zero at least looks like nothing happened;
 *                      one-of-two looks exactly like success.
 *   DEFECT 3 (POST and DELETE)  the write ORDER. `AccountConnection`'s policies
 *                      are `fm_account_visible("financialAccountId")`, which is
 *                      false until an ACTIVE link exists in a visible Space. So
 *                      an INSERT before the link RAISES, and an UPDATE after the
 *                      revoke returns 0 SILENTLY. Same cause, two symptoms, and
 *                      only one of them is audible.
 *
 * ── THE PART THAT IS PROVED BY RUNNING ───────────────────────────────────────
 * Local development has no role URLs, so a route left on the wrong authority
 * would not fail any assertion in this repository. That makes a pure scan weak
 * precisely where it matters most. So the POLICY ITSELF is modelled here — a
 * tiny in-memory `fm_account_visible` over a link table, with Postgres's actual
 * asymmetry wired in (INSERT refusal RAISES; UPDATE refusal returns a count) —
 * and BOTH orderings are executed against it. The old order is shown to fail,
 * the new order to succeed, and the failure of the old DELETE order is shown to
 * be SILENT rather than loud. That is a demonstration of the phenomenon, not an
 * assertion about it.
 *
 * It models the policy; it does not prove the deployment's policy says this. The
 * real-role proof belongs in scripts/rls-app-acceptance.ts, which already does
 * exactly this for disconnect/restore with raw SQL (cases around
 * `AccountConnection.fm_app_upd`). The cases wanted there are in the report.
 *
 * ⚠️ Every absence claim below has a denominator asserted first, and the
 * source-scan needles are proved to MATCH on controls before any zero is read.
 *
 *   npx tsx app/api/accounts/manual/manual-spine-s3.authority.test.ts
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { assertEveryObservedRowWasWritten, PartialBulkWriteError } from "@/lib/db/conditional-write";

const ROOT = process.cwd();

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const raw = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
/** Comments stripped, so a header EXPLAINING a hazard never satisfies a scan for it. */
const code = (rel: string) => raw(rel).replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");

const POST_ROUTE = "app/api/accounts/manual/route.ts";
const ID_ROUTE   = "app/api/accounts/manual/[id]/route.ts";

// ═════════════════════════════════════════════════════════════════════════════
// PART A — THE POLICIES, MODELLED, AND BOTH ORDERINGS RUN AGAINST THEM
// ═════════════════════════════════════════════════════════════════════════════

/** SQLSTATE 42501. Postgres raises this for a refused INSERT and never for a refused UPDATE. */
class Refused42501 extends Error {
  readonly sqlState = "42501";
  constructor(table: string) {
    super(`new row violates row-level security policy for table "${table}"`);
    this.name = "Refused42501";
  }
}

interface Link { id: string; spaceId: string; financialAccountId: string; status: "ACTIVE" | "REVOKED" }
interface Conn { id: string; financialAccountId: string; deletedAt: Date | null }

/**
 * An in-memory stand-in for the two policies that matter, and ONLY those two.
 *
 * `visibleSpaces` is this identity's `fm_visible_space_ids()`. Everything else
 * follows the migration verbatim:
 *   SpaceAccountLink  — selectable/updatable where spaceId is visible
 *   AccountConnection — selectable/updatable/insertable where fm_account_visible
 */
function policyAwareDb(visibleSpaces: Set<string>, links: Link[], conns: Conn[]) {
  const accountVisible = (acct: string) =>
    links.some((l) => l.financialAccountId === acct && l.status === "ACTIVE" && visibleSpaces.has(l.spaceId));

  return {
    accountVisible,
    spaceAccountLink: {
      findMany: (acct: string, status: Link["status"]) =>
        links.filter((l) => l.financialAccountId === acct && l.status === status && visibleSpaces.has(l.spaceId)),
      /** A refused UPDATE is NOT an error. It is a smaller count. That is the hazard. */
      updateMany: (acct: string, status: Link["status"], next: Link["status"]) => {
        const hit = links.filter(
          (l) => l.financialAccountId === acct && l.status === status && visibleSpaces.has(l.spaceId));
        for (const l of hit) l.status = next;
        return { count: hit.length };
      },
    },
    /** fm_system: USING (true). No space filter at all. */
    deploymentWideLinks: {
      findMany: (acct: string, status: Link["status"]) =>
        links.filter((l) => l.financialAccountId === acct && l.status === status),
      updateMany: (acct: string, status: Link["status"], next: Link["status"]) => {
        const hit = links.filter((l) => l.financialAccountId === acct && l.status === status);
        for (const l of hit) l.status = next;
        return { count: hit.length };
      },
    },
    accountConnection: {
      findMany: (acct: string) =>
        accountVisible(acct) ? conns.filter((c) => c.financialAccountId === acct && c.deletedAt === null) : [],
      updateMany: (acct: string, at: Date) => {
        if (!accountVisible(acct)) return { count: 0 };   // SILENT
        const hit = conns.filter((c) => c.financialAccountId === acct && c.deletedAt === null);
        for (const c of hit) c.deletedAt = at;
        return { count: hit.length };
      },
      create: (acct: string) => {
        if (!accountVisible(acct)) throw new Refused42501("AccountConnection");  // LOUD
        const row: Conn = { id: `ac-${conns.length + 1}`, financialAccountId: acct, deletedAt: null };
        conns.push(row);
        return row;
      },
    },
  };
}

const ACCT = "acct-1";
const MINE = "space-mine";
const THEIRS = "space-coowner";

function sharedAssetFixture() {
  const links: Link[] = [
    { id: "l-mine",   spaceId: MINE,   financialAccountId: ACCT, status: "ACTIVE" },
    { id: "l-theirs", spaceId: THEIRS, financialAccountId: ACCT, status: "ACTIVE" },
    { id: "l-other",  spaceId: MINE,   financialAccountId: "acct-unrelated", status: "ACTIVE" },
  ];
  const conns: Conn[] = [{ id: "ac-1", financialAccountId: ACCT, deletedAt: null }];
  return { links, conns, db: policyAwareDb(new Set([MINE]), links, conns) };
}

console.log("A1. THE FIXTURE IS REAL — a shared manual asset, one Space invisible to the actor");
{
  const f = sharedAssetFixture();
  check("the asset has TWO ACTIVE links in TWO DISTINCT Spaces",
    f.links.filter((l) => l.financialAccountId === ACCT && l.status === "ACTIVE").length === 2 &&
    new Set(f.links.filter((l) => l.financialAccountId === ACCT).map((l) => l.spaceId)).size === 2);
  check("…and exactly ONE of them is in a Space the actor cannot see — otherwise every claim below is vacuous",
    f.db.spaceAccountLink.findMany(ACCT, "ACTIVE").length === 1 &&
    f.db.deploymentWideLinks.findMany(ACCT, "ACTIVE").length === 2);
  check("the asset has a live AccountConnection to close", f.conns.length === 1);
}

console.log("\nA2. DEFECT 1 — THE BARE updateMany WRITES 1 OF 2 AND SAYS NOTHING");
{
  const f = sharedAssetFixture();
  // The route's OLD statement, verbatim in shape: tenant client, no status
  // observation, count discarded.
  const { count } = f.db.spaceAccountLink.updateMany(ACCT, "ACTIVE", "REVOKED");
  check("the tenant revoke reports a PLAUSIBLE count, and it is wrong", count === 1, `count=${count}`);
  check("the CO-OWNER's link is still ACTIVE — their Space keeps narrating a deleted asset",
    f.links.find((l) => l.id === "l-theirs")!.status === "ACTIVE");
  check("nothing was raised: one-of-two is indistinguishable from success by its count alone", true);

  // The CAPABILITY, with the shortfall asserted — the shape the route now has.
  const g = sharedAssetFixture();
  const observed = g.db.deploymentWideLinks.findMany(ACCT, "ACTIVE").length;
  const written  = g.db.deploymentWideLinks.updateMany(ACCT, "ACTIVE", "REVOKED").count;
  check("the deployment-wide authority observes BOTH links", observed === 2, `${observed}`);
  check("…and writes both", written === 2, `${written}`);
  check("the co-owner's link IS revoked now", g.links.find((l) => l.id === "l-theirs")!.status === "REVOKED");
  check("the unrelated account's link is untouched",
    g.links.find((l) => l.id === "l-other")!.status === "ACTIVE");

  // And a shortfall is audible rather than reported as health.
  let raised: unknown = null;
  try {
    assertEveryObservedRowWasWritten(
      { table: "SpaceAccountLink", operation: "update", scope: "1 authorized account id" }, 2, 1);
  } catch (e) { raised = e; }
  check("a 1-of-2 shortfall RAISES at the call site's assertion",
    raised instanceof PartialBulkWriteError);
  check("…naming both numbers, so an operator can see it was a PARTIAL",
    raised instanceof PartialBulkWriteError && raised.observed === 2 && raised.written === 1);
  check("a count ABOVE the observation is a benign race and does NOT raise", (() => {
    try {
      assertEveryObservedRowWasWritten(
        { table: "SpaceAccountLink", operation: "update", scope: "1 authorized account id" }, 1, 2);
      return true;
    } catch { return false; }
  })());
}

console.log("\nA3. DEFECT 3 (DELETE) — LINKS-FIRST SILENTLY SKIPS THE CONNECTION SOFT-DELETE");
{
  // THE OLD ORDER: revoke the links, then close the connections.
  const old = sharedAssetFixture();
  old.db.deploymentWideLinks.updateMany(ACCT, "ACTIVE", "REVOKED");
  const closedOld = old.db.accountConnection.updateMany(ACCT, new Date());
  check("after the revoke the account is no longer visible to the tenant role",
    old.db.accountVisible(ACCT) === false);
  check("THE CONNECTION SOFT-DELETE WRITES ZERO — and raises nothing", closedOld.count === 0);
  check("…so the connection is left OPEN on a soft-deleted asset",
    old.conns[0].deletedAt === null);

  // THE NEW ORDER: close the connections, then revoke the links.
  const now = sharedAssetFixture();
  const observed = now.db.accountConnection.findMany(ACCT).length;
  const closedNew = now.db.accountConnection.updateMany(ACCT, new Date());
  check("connections-first OBSERVES the live connection", observed === 1);
  check("…and closes it", closedNew.count === 1 && now.conns[0].deletedAt !== null);
  const rev = now.db.deploymentWideLinks.updateMany(ACCT, "ACTIVE", "REVOKED");
  check("…and the links still revoke afterwards, everywhere", rev.count === 2);
}

console.log("\nA4. DEFECT 3 (POST) — CONNECTION-BEFORE-LINK RAISES 42501, SO THE ASSET IS NEVER CREATED");
{
  // A brand-new account: no links yet. This is the state the POST route creates.
  const links: Link[] = [];
  const conns: Conn[] = [];
  const db = policyAwareDb(new Set([MINE]), links, conns);
  check("FIXTURE: a just-created account has NO links, so fm_account_visible is false",
    db.accountVisible(ACCT) === false);

  // THE OLD ORDER.
  let raised: unknown = null;
  try { db.accountConnection.create(ACCT); } catch (e) { raised = e; }
  check("AccountConnection.create BEFORE any link is REFUSED 42501",
    raised instanceof Refused42501 && (raised as Refused42501).sqlState === "42501");
  check("…and because an INSERT refusal RAISES, the enclosing transaction rolls back: no asset at all",
    conns.length === 0);

  // THE NEW ORDER.
  links.push({ id: "l-new", spaceId: MINE, financialAccountId: ACCT, status: "ACTIVE" });
  check("with the link written first, the account IS visible to its creator's identity",
    db.accountVisible(ACCT) === true);
  const created = db.accountConnection.create(ACCT);
  check("…and the connection insert succeeds", created.financialAccountId === ACCT && conns.length === 1);
}

// ═════════════════════════════════════════════════════════════════════════════
// PART B — THE ROUTES ACTUALLY HAVE THAT SHAPE
// ═════════════════════════════════════════════════════════════════════════════

console.log("\nB0. THE NEEDLES WORK, AND THE DENOMINATOR IS REAL");
{
  for (const rel of [POST_ROUTE, ID_ROUTE]) {
    check(`${rel} exists`, existsSync(path.join(ROOT, rel)));
    check(`${rel} is a real handler, not a stub`,
      code(rel).length > 400 && /export\s+const\s+(POST|PATCH|DELETE)\s*=/.test(code(rel)));
  }
  // The `db.<model>.` needle, proved against a control that legitimately holds one.
  // RLS-PREP-C — was the wallet route; it was converted and stopped holding one.
  // This route's owner reads are deliberate and documented in its header.
  const CONTROL = "app/api/spaces/[id]/permanent/route.ts";
  const needle = /\bdb\.[a-zA-Z][a-zA-Z0-9_]*\./g;
  check("CONTROL: the migration-principal needle MATCHES a file that still holds one",
    (code(CONTROL).match(needle) ?? []).length > 0,
    "if this fails, the zeroes below mean nothing");
}

console.log("\nB1. NEITHER ROUTE REACHES THE MIGRATION PRINCIPAL");
for (const rel of [POST_ROUTE, ID_ROUTE]) {
  const c = code(rel);
  check(`${rel}: does not import the migration principal`, !/from\s+"@\/lib\/db"/.test(c));
  check(`${rel}: zero \`db.<model>.\` reaches`,
    (c.match(/\bdb\.[a-zA-Z][a-zA-Z0-9_]*\./g) ?? []).length === 0,
    (c.match(/\bdb\.[a-zA-Z][a-zA-Z0-9_]*\./g) ?? []).join(", "));
  check(`${rel}: no bare \`db.$transaction\` — the atomic unit is a tenant phase`,
    !/db\.\$transaction/.test(c));
  check(`${rel}: binds the SESSION's identity`, /withTenantDb\(\s*userId/.test(c));
}

console.log("\nB2. POST — THE LINKS ARE WRITTEN BEFORE THE CONNECTION");
{
  const c = code(POST_ROUTE);
  const fa   = c.indexOf("financialAccount.create");
  const link = c.indexOf("dualWriteSpaceAccountLink(");
  const conn = c.indexOf("accountConnection.create");
  check("all three writes are present (so the ordering claim is not vacuous)",
    fa !== -1 && link !== -1 && conn !== -1, `fa@${fa} link@${link} conn@${conn}`);
  check("FinancialAccount first — its WITH CHECK is the ownerUserId arm", fa < link);
  check("SpaceAccountLink SECOND — this is the inversion", link < conn);
  check("AccountConnection LAST", conn > link);
  check("the link loop is still SEQUENTIAL (KD-5: a concurrent loop assigns HOME twice)",
    /for \(const wsId of shareTargets\)/.test(c) && !/Promise\.all/.test(c));
  check("the first share target is still the personal Space, so it is still the HOME link",
    /shareTargets = \[personalSpaceId/.test(c));
  check("the membership reads are a tenant phase too",
    /tx\.spaceMember\.findFirst/.test(c) && /tx\.spaceMember\.findMany/.test(c));
}

console.log("\nB3. DELETE — THE CAPABILITY, THE ASSERTION, AND THE ORDER");
{
  const c = code(ID_ROUTE);
  check("the bare cross-Space updateMany is GONE", !/spaceAccountLink\.updateMany/.test(c));
  check("…replaced by the ONE deployment-wide capability",
    c.includes("revokeAccountLinksEverywhere("));
  check("the shortfall is asserted at the call site, not trusted",
    c.includes("assertEveryObservedRowWasWritten("));
  check("the capability is handed a PROVEN id, never the path parameter",
    /revokeAccountLinksEverywhere\(\[gated\.provenId\]/.test(c));
  check("…and provenId is DERIVED inside the tenant callback from an OWNERSHIP read",
    /const provenId = fa\.id/.test(c) &&
    /fa\.ownerUserId !== userId/.test(c) &&
    c.indexOf("fa.ownerUserId !== userId") < c.indexOf("const provenId = fa.id"));
  check("NOT resolveConditionalWrite — its probe cannot tell a hidden row from an absent one, " +
        "and for an idempotent revoke the second is expected",
    !c.includes("resolveConditionalWrite"));

  const conn = c.indexOf("accountConnection.updateMany");
  const rev  = c.indexOf("revokeAccountLinksEverywhere(");
  check("both statements are present", conn !== -1 && rev !== -1, `conn@${conn} rev@${rev}`);
  check("THE CONNECTION SOFT-DELETE COMES BEFORE THE LINK REVOKE (reversing it writes zero, silently)",
    conn < rev);
  check("the connection soft-delete observes its own rows first — the observation IS the guard",
    c.indexOf("accountConnection.findMany") !== -1 &&
    c.indexOf("accountConnection.findMany") < conn);
  check("…and asserts that count too, not only the link one",
    (c.match(/assertEveryObservedRowWasWritten\(/g) ?? []).length === 2,
    `${(c.match(/assertEveryObservedRowWasWritten\(/g) ?? []).length} assertion(s)`);
  check("systemDb is reached through a FUNCTION, never by importing the client here",
    !/systemDb/.test(c));

  // The header must keep saying what was NOT changed, so nobody re-derives it.
  const header = raw(ID_ROUTE);
  check("the header records the ACTIVE-only narrowing of the revoke", /status: ACTIVE/.test(header));
  check("the header records that snapshots are still not regenerated here",
    /affectedSpaceIds/.test(header) && /snapshot/i.test(header));
}

if (failures > 0) {
  console.error(`\nRLS-ACC-S3 manual-asset spine: ${failures} failure(s).`);
  process.exit(1);
}
console.log("\nRLS-ACC-S3 manual-asset spine: all passed.");
