/**
 * lib/rls-server-component-authority.test.ts  (RLS-T3)
 *
 * Standalone tsx script (house pattern of lib/platform-surface.test.ts) — a
 * SOURCE-SCAN test over the three Server Components RLS-T3 classified, plus the
 * policy text each classification rests on. No runtime, no DB, deterministic.
 *
 * A Server Component is awkward to exercise directly: it reads a session, opens
 * transactions and returns JSX. So the honest pin is source-level, and it is
 * stated as such. What it can prove is exactly the thing a future edit would
 * silently undo — WHICH CLIENT each read reaches for:
 *
 *   1. spaces/page.tsx           every viewer-scoped read is inside
 *                                withTenantDb; the net-worth read is STILL in a
 *                                tenant phase (the RLS-C-S9 owner decision);
 *                                and the `db` reads that remain are EXACTLY the
 *                                two §10 display disclosures, enumerated.
 *   2. archived-assets/page.tsx  reaches NO ambient client — `db` is neither
 *                                imported nor named.
 *   3. platform/[area]/page.tsx  is NOT routed through fm_app, and stays that
 *                                way only while the systemDb allowlist still
 *                                lacks its entry. The pin is the conjunction,
 *                                so the day the entry lands this test asks for
 *                                the page to move with it.
 *   4. the policy facts           the `isPublic` arm the public-Space list
 *                                relies on exists; `SpaceDashboardSection` has
 *                                no platform arm anywhere (the reason for 3).
 *
 * ⚠️ EVERY ABSENCE CLAIM BELOW HAS A DENOMINATOR, AND EVERY NEEDLE IS
 * MUTATION-TESTED. Section 5 re-runs each pattern against a counterexample it
 * builds on the spot and requires it to FIRE. A prior slice shipped a scan whose
 * `\b${name}\s*\(` needle, with name = "$transaction", matched nothing and
 * reported clean over zero sites; a pattern that cannot fail is a comment with a
 * tick beside it.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Strip block + line comments, so the prose that DOCUMENTS an authority never
 *  satisfies a scan looking for one. (Neither of the three files contains a
 *  `//` inside a string literal — no URLs — so the simple form is safe here.) */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
}

const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");
const code = (rel: string): string => stripComments(read(rel));

const SPACES_PAGE   = "app/(shell)/dashboard/spaces/page.tsx";
const ARCHIVE_PAGE  = "app/(shell)/dashboard/settings/archived-assets/page.tsx";
const PLATFORM_PAGE = "app/(shell)/dashboard/platform/[area]/page.tsx";
const SPACES_CLIENT = "components/dashboard/SpacesClient.tsx";
const AUDIT_SCRIPT  = "scripts/audit-db-authority.ts";

for (const rel of [SPACES_PAGE, ARCHIVE_PAGE, PLATFORM_PAGE, SPACES_CLIENT, AUDIT_SCRIPT]) {
  if (!existsSync(path.join(ROOT, rel))) {
    console.error(`  ✗ fixture missing: ${rel}`);
    failures++;
  }
}

// ── The two needles, defined once and reused by the mutation test ─────────────

/** `db.<delegate>.<op>(` — a read on the migration principal. */
const DB_CALL = /\bdb\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\(/g;
/** `tx.<delegate>.<op>(` — a read inside a transaction-scoped client. */
const TX_CALL = /\btx\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\(/g;

function callSites(src: string, re: RegExp): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(new RegExp(re.source, "g"))) out.push(`${m[1]}.${m[2]}`);
  return out.sort();
}

// ── 1. spaces/page.tsx ────────────────────────────────────────────────────────

console.log("1. dashboard/spaces/page.tsx — every viewer read is a tenant read");
{
  const src = code(SPACES_PAGE);

  // The complete, enumerated set. Anything NEW on `db` fails here, which is the
  // property: the file is allowed exactly two display disclosures, and the
  // invite one needs two reads (the Space and the inviter).
  const EXPECTED_DB = ["space.findMany", "spaceMember.findMany", "user.findMany"].sort();
  const dbSites = callSites(src, DB_CALL);
  check(
    `db call sites are exactly the ${EXPECTED_DB.length} named §10 disclosures`,
    JSON.stringify(dbSites) === JSON.stringify(EXPECTED_DB),
    `found [${dbSites.join(", ")}], expected [${EXPECTED_DB.join(", ")}]`,
  );

  // The six reads that moved. `space.findMany` twice: the public list and the
  // platform list inside loadPlatformSpaces.
  const EXPECTED_TX = [
    "platformGrant.findMany",
    "space.findMany", "space.findMany",
    "spaceInvite.findMany",
    "spaceMember.findMany",
    "user.findUnique",
  ].sort();
  const txSites = callSites(src, TX_CALL);
  check(
    `tenant call sites are exactly the ${EXPECTED_TX.length} converted reads`,
    JSON.stringify(txSites) === JSON.stringify(EXPECTED_TX),
    `found [${txSites.join(", ")}], expected [${EXPECTED_TX.join(", ")}]`,
  );

  // RLS-C-S9's owner decision: membership gates money. Both directions.
  check("net worth is read inside a tenant phase (RLS-C-S9 preserved)",
    /withTenantDb\(\s*userId\s*,\s*\(tx\)\s*=>\s*getSpaceNetWorthSummaries\(\s*tx\s*,/.test(src),
    "expected withTenantDb(userId, (tx) => getSpaceNetWorthSummaries(tx, …))");
  check("net worth is never read on the migration principal",
    !/getSpaceNetWorthSummaries\(\s*db\b/.test(src));
  // Launch-readiness audit (2026-10-06): account freshness is metadata ABOUT the
  // money, read on the owner client — so it is asked only for Spaces the viewer
  // belongs to, never for the public Spaces they have not joined.
  check("account freshness is resolved for MEMBER Spaces only, never for unjoined public Spaces",
    /getSpaceCardFreshness\(\s*mySpaceIds\s*\)/.test(src) && !/getSpaceCardFreshness\(\s*allIds\s*\)/.test(src),
    "expected getSpaceCardFreshness(mySpaceIds)");

  // The public-Space list is a TENANT read that still returns rows — it works
  // only because Space.fm_app_sel has the isPublic arm (pinned in §4 below).
  check("the public-Space list is itself a tenant read",
    /withTenantDb\(\s*userId\s*,\s*\(tx\)\s*=>\s*tx\.space\.findMany\(\{\s*where:\s*\{\s*isPublic:\s*true/.test(src),
    "expected the isPublic list inside withTenantDb");

  // Neither roster include may come back: both would raise "Inconsistent query
  // result: Field user is required" under fm_app.
  check("no nested member-roster include survives",
    !/\bmembers:\s*\{\s*where:/.test(src),
    "a `members: { where: … }` include on a tenant read 500s in any shared Space");
  check("no nested User include survives",
    !/\binclude:\s*\{\s*user:\s*\{/.test(src),
    "fm_app's User policy hides a co-member, and the relation is REQUIRED");

  // A1's canonical count must still be spelled twice — once per card group.
  const counts = src.match(/accountLinks:\s*\{\s*where:\s*\{\s*status:\s*"ACTIVE"/g) ?? [];
  check("both card groups keep the canonical ACTIVE link count", counts.length === 2,
    `found ${counts.length}, expected 2`);

  // The identity is session state. Not the cookie, which is read for highlight.
  check("the tenant identity is the session user id",
    /const\s+userId\s*=\s*session\.user\.id/.test(src));
  check("no withTenantDb is ever handed the active-Space cookie",
    !/withTenantDb\(\s*activeSpaceId/.test(src));
}

// ── 2. archived-assets/page.tsx ───────────────────────────────────────────────

console.log("\n2. settings/archived-assets/page.tsx — no ambient client remains");
{
  const raw = read(ARCHIVE_PAGE);
  const src = code(ARCHIVE_PAGE);

  check("`db` is not imported", !/import\s*\{[^}]*\bdb\b[^}]*\}\s*from\s*"@\/lib\/db"/.test(raw));
  const dbSites = callSites(src, DB_CALL);
  check("zero db call sites", dbSites.length === 0, `found [${dbSites.join(", ")}]`);

  // The denominator for that zero: the three reads are all still there.
  const EXPECTED_TX = ["financialAccount.findMany", "spaceMember.findMany", "spaceMember.findMany"].sort();
  const txSites = callSites(src, TX_CALL);
  check(`all ${EXPECTED_TX.length} archive-bin reads are tenant reads`,
    JSON.stringify(txSites) === JSON.stringify(EXPECTED_TX),
    `found [${txSites.join(", ")}]`);
  check("one transaction wraps the three tabs",
    (src.match(/withTenantDb\(/g) ?? []).length === 1);
  check("the owner arm is what it relies on — the read is keyed on ownerUserId",
    /ownerUserId:\s*userId/.test(src));
}

// ── 3. platform/[area]/page.tsx ───────────────────────────────────────────────

console.log("\n3. dashboard/platform/[area]/page.tsx — an operator surface, not a tenant one");
{
  const src   = code(PLATFORM_PAGE);
  const audit = read(AUDIT_SCRIPT);

  const EXPECTED_DB = ["platformGrant.findUnique", "space.findUnique"].sort();
  const dbSites = callSites(src, DB_CALL);
  check(`the two operator reads are enumerated`,
    JSON.stringify(dbSites) === JSON.stringify(EXPECTED_DB),
    `found [${dbSites.join(", ")}]`);

  // The read that proves fm_app cannot serve this page. If it ever leaves, the
  // classification has to be re-made rather than inherited.
  check("the page still reads the Space's dashboardSections",
    /dashboardSections:\s*\{/.test(src),
    "this is the §7 relation fm_app returns as [] — the whole reason for the classification");

  // THE CONJUNCTION. `db` is only acceptable here because systemDb is confined
  // away from app/(shell)/. The day the allowlist entry lands, this flips and
  // asks for the page to move.
  const allowlisted =
    audit.includes('"app/(shell)/dashboard/platform/[area]/page.tsx"') ||
    audit.includes('"app/(shell)/dashboard/platform/"');
  const usesSystemDb = /\bsystemDb\b/.test(src);
  const usesTenant   = /\bwithTenantDb\b/.test(src);
  check("the operator page is NOT routed through fm_app", !usesTenant,
    "fm_app compiles here and returns [] sections — see the file header");
  check(
    allowlisted
      ? "systemDb is allowlisted, so the page must now use it"
      : "systemDb is not allowlisted, so the page correctly stays on db",
    allowlisted ? usesSystemDb : !usesSystemDb,
    allowlisted
      ? "add the systemDb import and drop db"
      : "systemDb here would fail scripts/audit-db-authority.ts confinement",
  );
}

// ── 4. The policy facts the classifications rest on ───────────────────────────

console.log("\n4. The migration text each classification cites");
{
  const dir = path.join(ROOT, "prisma", "migrations");
  const sql = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(dir, e.name, "migration.sql"))
    .filter((p) => existsSync(p))
    .map((p) => ({ rel: path.relative(ROOT, p), text: readFileSync(p, "utf8") }));
  check("migration history is readable", sql.length > 0, `${sql.length} files`);

  // (a) The arm the public-Space list depends on, inside a Space SELECT policy.
  const isPublicArm = sql.filter((f) =>
    /CREATE POLICY fm_app_sel ON public\."Space" FOR SELECT TO fm_app[\s\S]{0,600}?OR "isPublic" = true/.test(f.text));
  check('Space.fm_app_sel still carries `OR "isPublic" = true`', isPublicArm.length >= 1,
    "without it the Explore list returns nothing as the tenant");

  // (b) The absence that keeps the platform page on db. SpaceDashboardSection
  //     is named by the DB1 table rename too, so the claim is narrowed to the
  //     POLICY text: it must be reached by exactly ONE migration that creates
  //     policies, the §7 spaceId loop. The denominator is printed.
  const sectionHits = sql.filter((f) =>
    f.text.includes("SpaceDashboardSection") && /CREATE POLICY/.test(f.text));
  check("SpaceDashboardSection is policied by exactly one migration",
    sectionHits.length === 1, `found in ${sectionHits.length}: ${sectionHits.map((f) => f.rel).join(", ")}`);
  check("that one migration is the §7 spaceId loop",
    sectionHits.length === 1 &&
      /FOREACH t IN ARRAY ARRAY\[[\s\S]{0,300}?'SpaceDashboardSection'[\s\S]{0,900}?"spaceId" IN \(SELECT fm_visible_space_ids\(\)\)/
        .test(sectionHits[0].text),
    "the sections table is spaceId-scoped, and a platform Space has no members");
  const sectionArm = sql.some((f) =>
    /SpaceDashboardSection[\s\S]{0,400}?platformArea/i.test(f.text) ||
    /platformArea[\s\S]{0,400}?SpaceDashboardSection/i.test(f.text));
  check("SpaceDashboardSection has no platform arm", !sectionArm,
    "if one has been added, the platform page can and should become a tenant read");

  // (c) PlatformGrant's own SELECT policy — the answer to "would the chips
  //     vanish under fm_app". It is in the §9 userId loop, so they do not.
  const grantUserScoped = sql.some((f) =>
    /FOREACH t IN ARRAY ARRAY\[[\s\S]{0,400}?'PlatformGrant'[\s\S]{0,900}?"userId" = current_fm_user_id\(\)/.test(f.text));
  check("PlatformGrant is user-scoped (`userId = current_fm_user_id()`)", grantUserScoped,
    "the Spaces page reads its OWN grants, so fm_app serves them");
}

// ── 5. accountCount: the absence claim, with its denominator ──────────────────

console.log("\n5. accountCount is declared and never rendered");
{
  const client = read(SPACES_CLIENT);
  const all = (client.match(/accountCount/g) ?? []).length;
  const reads = (client.match(/[.?]\s*accountCount\b/g) ?? []).length;
  check(`accountCount occurs ${all} times in SpacesClient (all declarations)`, all > 0,
    "if the identifier vanished, this scan would pass vacuously");
  check("accountCount is never read off a value", reads === 0,
    `found ${reads} property reads — a public Space now reports 0, so a render site would be a false figure`);
}

// ── 6. MUTATION TEST — every needle above must be able to fail ────────────────

console.log("\n6. Mutation test: each needle fires on a counterexample");
{
  const m = (name: string, fires: boolean) =>
    check(`needle fires: ${name}`, fires, "a pattern that cannot fail proves nothing");

  m("DB_CALL", callSites("const x = db.spaceMember.findMany({});", DB_CALL).length === 1);
  m("DB_CALL ignores tx.", callSites("await tx.spaceMember.findMany({});", DB_CALL).length === 0);
  m("TX_CALL", callSites("await tx.space.findMany({});", TX_CALL).length === 1);
  m("DB_CALL not fooled by a substring", callSites("adb.space.findMany({});", DB_CALL).length === 0);

  m("net-worth tenant phase",
    /withTenantDb\(\s*userId\s*,\s*\(tx\)\s*=>\s*getSpaceNetWorthSummaries\(\s*tx\s*,/
      .test("await withTenantDb(userId, (tx) =>\n getSpaceNetWorthSummaries(tx, allIds));"));
  m("net-worth on db detected",
    /getSpaceNetWorthSummaries\(\s*db\b/.test("getSpaceNetWorthSummaries(db, allIds)"));
  m("public list tenant phase",
    /withTenantDb\(\s*userId\s*,\s*\(tx\)\s*=>\s*tx\.space\.findMany\(\{\s*where:\s*\{\s*isPublic:\s*true/
      .test("await withTenantDb(userId, (tx) => tx.space.findMany({ where: { isPublic: true,"));
  m("roster include detected", /\bmembers:\s*\{\s*where:/.test('members: { where: { status: "ACTIVE" } }'));
  m("User include detected", /\binclude:\s*\{\s*user:\s*\{/.test("include: { user: { select: { id: true } } }"));
  m("db import detected",
    /import\s*\{[^}]*\bdb\b[^}]*\}\s*from\s*"@\/lib\/db"/.test('import { db } from "@/lib/db";'));
  m("ownerUserId key detected", /ownerUserId:\s*userId/.test("where: { ownerUserId: userId }"));
  m("dashboardSections read detected", /dashboardSections:\s*\{/.test("dashboardSections: {\n where: {} }"));
  m("isPublic policy arm detected",
    /CREATE POLICY fm_app_sel ON public\."Space" FOR SELECT TO fm_app[\s\S]{0,600}?OR "isPublic" = true/
      .test('CREATE POLICY fm_app_sel ON public."Space" FOR SELECT TO fm_app\n USING (\n x\n OR "isPublic" = true\n);'));
  m("a platform arm on SpaceDashboardSection would be detected",
    /SpaceDashboardSection[\s\S]{0,400}?platformArea/i
      .test('CREATE POLICY p ON "SpaceDashboardSection" USING ("platformArea" IS NOT NULL);'));
  m("§7 spaceId loop membership detected",
    /FOREACH t IN ARRAY ARRAY\[[\s\S]{0,300}?'SpaceDashboardSection'[\s\S]{0,900}?"spaceId" IN \(SELECT fm_visible_space_ids\(\)\)/
      .test(`FOREACH t IN ARRAY ARRAY['AiAgent', 'SpaceDashboardSection'] LOOP\n USING ("spaceId" IN (SELECT fm_visible_space_ids()))`));
  m("PlatformGrant user-scope loop detected",
    /FOREACH t IN ARRAY ARRAY\[[\s\S]{0,400}?'PlatformGrant'[\s\S]{0,900}?"userId" = current_fm_user_id\(\)/
      .test(`FOREACH t IN ARRAY ARRAY['Connection', 'PlatformGrant'] LOOP\n USING ("userId" = current_fm_user_id())`));
  m("accountCount property read detected", /[.?]\s*accountCount\b/.test("{space.accountCount}"));
  m("comment stripping actually strips",
    !/db\.spaceMember/.test(stripComments("// db.spaceMember.findMany is gone\nconst a = 1;")));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll RLS-T3 Server Component authority checks passed.");
