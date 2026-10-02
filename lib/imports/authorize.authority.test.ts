/**
 * lib/imports/authorize.authority.test.ts  (RLS-ACC-S2)
 *
 * THE ONE IMPORT AUTHORIZATION GATE EXECUTES ON THE AUTHORITY IT WAS HANDED, AND
 * ALL SIX OF ITS CALLERS HAND IT A TENANT ONE.
 *
 * ── WHY THIS FILE EXISTS AT ALL ──────────────────────────────────────────────
 * `resolveImportableFinancialAccount` had `client: DbClient = db`. Not one of the
 * six production call sites passed anything, so every import authorization in the
 * product ran as the migration principal while each route's own source scanned
 * clean — `app/api/imports/[id]/rollback/route.ts` most sharply, because
 * RLS-C-S8 converted all three of its phases and a test asserts `!/\bdb\s*\.\w/`
 * over its source. That test was right about the file and wrong about the
 * request. A DEFAULTED authority is an AMBIENT one that LOOKS converted.
 *
 * ── WHAT IS PROVED BY RUNNING, AND WHAT ONLY A SCAN CAN REACH ────────────────
 * The gate is pure of `db` now, so it CAN be driven: the cases below hand it a
 * RECORDING client and assert on the COUNT AND IDENTITY of the reads it performed.
 * A read that slipped back onto a module-level client would simply be MISSING
 * from the log — the count drops and the case fails. That is a denominator, not
 * an absence claim.
 *
 * Which SIDE of a `withTenantDb` boundary each of the six call sites is on cannot
 * be reached that way (a route handler needs a request store), so that half is a
 * scan — over a shape asserted to MATCH first.
 *
 * ── THE NEEDLE THIS REPO HAS ALREADY BROKEN ──────────────────────────────────
 * ⚠️ A prior slice scanned with `` `\b${name}\s*\(` `` where name = "$transaction".
 * The unescaped `$` matched nothing and the scan reported clean over ZERO sites.
 * This file asserts the ABSENCE of `$transaction` in the banking import route —
 * i.e. it depends on exactly that needle — so the needle is first required to
 * MATCH on a control that genuinely has one, and the regex escapes the `$`.
 * Verified by mutation: un-escaping it turns the control red.
 *
 *   npx tsx lib/imports/authorize.authority.test.ts
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { VisibilityLevel, ShareStatus, SpaceMemberRole, SpaceMemberStatus } from "@prisma/client";

import { resolveImportableFinancialAccount } from "./authorize";
import type { ReadClient } from "@/lib/db/tenant-context";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const ROOT = process.cwd();
const raw = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
/** Comments stripped, so a header EXPLAINING a hazard never satisfies a scan for it. */
const code = (rel: string) => raw(rel).replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");

const SPACE = "space-1";
const FA = "fa-1";

// ─────────────────────────────────────────────────────────────────────────────
// A RECORDING ReadClient — every read the gate performs lands in the log.
// ─────────────────────────────────────────────────────────────────────────────

interface Rows {
  link?: { visibilityLevel: VisibilityLevel } | null;
  fa?: { ownerUserId: string | null; createdByUserId: string | null } | null;
  member?: { role: SpaceMemberRole; status: SpaceMemberStatus } | null;
}

function recorder(rows: Rows) {
  const log: Array<{ op: string; where: unknown }> = [];
  const client = {
    spaceAccountLink: {
      findFirst: async ({ where }: { where: unknown }) => {
        log.push({ op: "spaceAccountLink.findFirst", where });
        return rows.link ?? null;
      },
    },
    financialAccount: {
      findUnique: async ({ where }: { where: unknown }) => {
        log.push({ op: "financialAccount.findUnique", where });
        return rows.fa ?? null;
      },
    },
    spaceMember: {
      findUnique: async ({ where }: { where: unknown }) => {
        log.push({ op: "spaceMember.findUnique", where });
        return rows.member ?? null;
      },
    },
  } as unknown as ReadClient;
  return { client, log };
}

async function main(): Promise<void> {
  // ───────────────────────────────────────────────────────────────────────────
  console.log("THE GATE READS THROUGH THE CLIENT IT WAS GIVEN — by execution");
  // ───────────────────────────────────────────────────────────────────────────
  {
    // Owner path: two reads, and it short-circuits before the membership read.
    const a = recorder({
      link: { visibilityLevel: VisibilityLevel.FULL },
      fa:   { ownerUserId: "owner", createdByUserId: null },
    });
    const owner = await resolveImportableFinancialAccount(a.client, "owner", SPACE, FA);
    check("FIXTURE is non-empty: the owner path returns ok", owner.ok,
      owner.ok ? "" : "the fixture yields nothing, so every absence below would be vacuous");
    check("the owner path performed EXACTLY the two reads it needs", a.log.length === 2,
      a.log.map((r) => r.op).join(" → "));
    check("…and both landed on the PASSED client, in order",
      a.log[0]?.op === "spaceAccountLink.findFirst" && a.log[1]?.op === "financialAccount.findUnique",
      a.log.map((r) => r.op).join(" → "));
    check("the link read is scoped to the SPACE and the ACCOUNT it was asked about",
      JSON.stringify(a.log[0]?.where).includes(SPACE) && JSON.stringify(a.log[0]?.where).includes(FA));
    check("the owner path never reads SpaceMember (it short-circuits)",
      !a.log.some((r) => r.op === "spaceMember.findUnique"));

    // Non-owner path: all three reads, same client.
    const b = recorder({
      link:   { visibilityLevel: VisibilityLevel.FULL },
      fa:     { ownerUserId: "someone-else", createdByUserId: null },
      member: { role: SpaceMemberRole.ADMIN, status: SpaceMemberStatus.ACTIVE },
    });
    const adminOk = await resolveImportableFinancialAccount(b.client, "adm", SPACE, FA);
    check("FIXTURE is non-empty: the non-owner ADMIN path returns ok", adminOk.ok);
    check("the non-owner path performed EXACTLY three reads, all on the passed client",
      b.log.length === 3, b.log.map((r) => r.op).join(" → "));
    check("the membership read asks about the CALLER and nothing else",
      JSON.stringify(b.log[2]?.where).includes("adm"));

    // The refusal path must not reach past the gate at all.
    const c = recorder({ link: null });
    const none = await resolveImportableFinancialAccount(c.client, "owner", SPACE, FA);
    check("no visible link → 404, from the FIRST read", !none.ok && c.log.length === 1,
      `${c.log.length} read(s)`);
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\nTHE GATE CANNOT CHOOSE ITS OWN AUTHORITY");
  // ───────────────────────────────────────────────────────────────────────────
  {
    const mod = code("lib/imports/authorize.ts");
    check("it no longer imports the migration principal at all",
      !/from\s+"@\/lib\/db"/.test(mod));
    check("…and holds no `db.<model>.` reach", (mod.match(/\bdb\.[a-zA-Z]+\./g) ?? []).length === 0);
    check("the client is the FIRST parameter, so the authority is read next to the name",
      /resolveImportableFinancialAccount\(\s*client:\s*ReadClient\s*,/.test(mod));
    check("it has NO default — an optional authority is an ambient one",
      !/client[^,)]*=\s*db/.test(mod));
    check("typed ReadClient, which strips `$transaction`: the gate cannot open a phase of its own",
      /import type \{ ReadClient \}/.test(mod) && /client:\s*ReadClient/.test(mod));
    check("there are still exactly three reads to account for",
      (mod.match(/client\.[a-zA-Z]+\.(?:findFirst|findUnique|findMany)/g) ?? []).length === 3,
      (mod.match(/client\.[a-zA-Z]+\.(?:findFirst|findUnique|findMany)/g) ?? []).join(", "));
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\nALL SIX CALLERS — the compiler enumerated them, so the test does too");
  // ───────────────────────────────────────────────────────────────────────────
  const CALLERS = [
    "app/api/accounts/[id]/import/route.ts",
    "app/api/accounts/[id]/import/preview/route.ts",
    "app/api/accounts/[id]/import/investments/route.ts",
    "app/api/accounts/[id]/import/investments/preview/route.ts",
    "app/api/investments/opening-position/route.ts",
    "app/api/imports/[id]/rollback/route.ts",
  ] as const;
  {
    check("the caller set is SIX — the two beyond this slice's own four are the ones the required parameter found",
      CALLERS.length === 6);
    for (const rel of CALLERS) {
      check(`${rel} exists`, existsSync(join(ROOT, rel)));
      const c = code(rel);
      check(`${rel}: the gate is called inside a tenant phase`,
        /withTenantDb\(\s*\n?\s*user\.id,\s*\(tx\)\s*=>\s*resolveImportableFinancialAccount\(\s*tx\s*,/.test(c));
      check(`${rel}: the tenant client is the FIRST argument — nothing wider precedes it`,
        /resolveImportableFinancialAccount\(\s*tx\s*,/.test(c) &&
        !/resolveImportableFinancialAccount\(\s*(?!tx\s*,)/.test(c));
      check(`${rel}: the identity bound is the SESSION's user, not a path or body value`,
        /withTenantDb\(\s*\n?\s*user\.id/.test(c));
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\nTHE EXPOSURE THIS SLICE DELIBERATELY DID NOT CLOSE, PINNED AS A FACT");
  // ───────────────────────────────────────────────────────────────────────────
  // The banking import writes one Transaction per file row with NO enclosing
  // transaction, so a refusal part-way through leaves the earlier rows committed.
  // That is its own decision (see the slice report); what must not happen is for
  // somebody to BELIEVE it was fixed here. If a `$transaction` ever appears in
  // this route, this case goes red and the next reader must come and look.
  {
    const IMPORT_ROUTE = "app/api/accounts/[id]/import/route.ts";
    const needle = /\$transaction/;            // the `$` IS escaped — see the header
    const CONTROL = "lib/transactions/event-write.ts";
    check("CONTROL: the needle MATCHES a module that genuinely opens a transaction",
      needle.test(code(CONTROL)),
      "if this fails the absence below means nothing — this is the repo's recorded needle bug");

    const imp = code(IMPORT_ROUTE);
    check("the banking import still has NO enclosing transaction (unchanged, and recorded)",
      !needle.test(imp));
    check("…and it still writes one Transaction per row (so the exposure is real, not hypothetical)",
      /db\.transaction\.create\(/.test(imp));
    check("…inside a per-row catch that CONTINUES, which is what makes a refusal look like a bad row",
      /catch\s*\(rowErr\)/.test(imp) && /failed\+\+/.test(imp));
    check("the gate itself is nonetheless a tenant phase, so authorization is not part of the exposure",
      /withTenantDb\(/.test(imp));
  }

  if (failures > 0) {
    console.error(`\nRLS-ACC-S2 import-gate authority: ${failures} failure(s).`);
    process.exit(1);
  }
  console.log("\nRLS-ACC-S2 import-gate authority: all passed.");
}

void main();
