/**
 * app/api/spaces/[id]/goals/goals-visibility.test.ts  (P1-3)
 *
 * Regression for the Goals-route privacy seam. The route is Space-scoped — it
 * returns every goal in the Space to every member — and previously serialized
 * each contribution's real FinancialAccount name + balance ungated. A member
 * who can only see a linked account at BALANCE_ONLY / SUMMARY_ONLY (or through a
 * REVOKED / deleted link) could read that account's real name, balance, and id.
 *
 * The fix reuses the canonical goals-contribution doctrine (export decision D4):
 *   resolveFullVisibleAccountIds(spaceId) → the FULL-visible account-id set
 *   filterVisibleContributions(contribs, set) → drop the rest
 *
 * The FULL set IS the boundary — a contribution whose account is excluded from
 * it is dropped from the response, so it can expose NO name/balance/id. These
 * tests drive both real helpers with a faithful fake Prisma client, then a
 * source-scan guard proves the route is actually wired to them.
 *
 *     npx tsx app/api/spaces/[id]/goals/goals-visibility.test.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VisibilityLevel, ShareStatus } from "@prisma/client";
import { resolveFullVisibleAccountIds } from "@/lib/accounts/space-account-link";
import { filterVisibleContributions } from "@/lib/export/select";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const SPACE = "space-1";

interface FixtureLink {
  financialAccountId: string;
  spaceId: string;
  visibilityLevel: VisibilityLevel;
  status: ShareStatus;
  deleted: boolean; // financialAccount.deletedAt != null
}

/** A fake Prisma client that faithfully applies the helper's SAL where-clause. */
function fakeClient(links: FixtureLink[]) {
  const matches = (l: FixtureLink, where: Record<string, unknown>): boolean => {
    if (where.spaceId !== undefined && l.spaceId !== where.spaceId) return false;
    if (where.status !== undefined && l.status !== where.status) return false;
    const fa = where.financialAccount as { deletedAt?: null } | undefined;
    if (fa && fa.deletedAt === null && l.deleted) return false;
    const vis = where.visibilityLevel as { in?: VisibilityLevel[] } | undefined;
    if (vis?.in && !vis.in.includes(l.visibilityLevel)) return false;
    return true;
  };
  return {
    spaceAccountLink: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findMany: async ({ where }: any) =>
        links.filter((l) => matches(l, where)).map((l) => ({ financialAccountId: l.financialAccountId })),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function link(id: string, visibilityLevel: VisibilityLevel, opts: Partial<FixtureLink> = {}): FixtureLink {
  return {
    financialAccountId: id,
    spaceId: opts.spaceId ?? SPACE,
    visibilityLevel,
    status: opts.status ?? ShareStatus.ACTIVE,
    deleted: opts.deleted ?? false,
  };
}

async function main(): Promise<void> {
  // ── 1. Shared Space: one of every tier + a revoked + a deleted-account link ─
  console.log("1. FULL-visible account set fails closed for every non-FULL / revoked / deleted case");
  const links = [
    link("faFull", VisibilityLevel.FULL),
    link("faBalance", VisibilityLevel.BALANCE_ONLY),
    link("faSummary", VisibilityLevel.SUMMARY_ONLY),
    link("faRevoked", VisibilityLevel.FULL, { status: ShareStatus.REVOKED }),
    link("faDeleted", VisibilityLevel.FULL, { deleted: true }),
  ];
  const fullSet = await resolveFullVisibleAccountIds(SPACE, fakeClient(links));
  check("FULL account is in the visible set", fullSet.has("faFull"));
  check("BALANCE_ONLY excluded", !fullSet.has("faBalance"));
  check("SUMMARY_ONLY excluded (fails closed)", !fullSet.has("faSummary"));
  check("REVOKED link excluded", !fullSet.has("faRevoked"));
  check("deleted account excluded", !fullSet.has("faDeleted"));
  check("exactly the FULL account is visible", fullSet.size === 1 && fullSet.has("faFull"));

  // A link for a DIFFERENT space must never leak in.
  const otherSpace = await resolveFullVisibleAccountIds("space-2", fakeClient(links));
  check("no cross-space leakage (space-2 sees nothing)", otherSpace.size === 0);

  // ── 2. filterVisibleContributions drops everything outside the FULL set ─────
  console.log("2. Contributions serialize name/balance ONLY for FULL-visible accounts");
  const contributions = [
    { financialAccountId: "faFull",    financialAccount: { id: "faFull",    name: "Real Chase Checking", balance: 1234 } },
    { financialAccountId: "faBalance", financialAccount: { id: "faBalance", name: "Secret Savings",       balance: 99999 } },
    { financialAccountId: "faSummary", financialAccount: { id: "faSummary", name: "Hidden Brokerage",     balance: 50000 } },
    { financialAccountId: "faRevoked", financialAccount: { id: "faRevoked", name: "Ex-shared Account",    balance: 7 } },
  ];
  const kept = filterVisibleContributions(contributions, fullSet);
  check("only the FULL contribution survives", kept.length === 1 && kept[0].financialAccountId === "faFull");
  check("FULL contribution keeps its real name+balance", kept[0].financialAccount.name === "Real Chase Checking" && kept[0].financialAccount.balance === 1234);
  const serialized = JSON.stringify(kept);
  check("no BALANCE_ONLY name/balance in output", !serialized.includes("Secret Savings") && !serialized.includes("99999"));
  check("no SUMMARY_ONLY name in output", !serialized.includes("Hidden Brokerage"));
  check("no REVOKED-link account name in output", !serialized.includes("Ex-shared Account"));

  // ── 3. Owner / Personal: every link is FULL, so all contributions retained ──
  console.log("3. Personal Space (all links FULL) — owner keeps all contributions");
  const personal = [link("p1", VisibilityLevel.FULL), link("p2", VisibilityLevel.FULL)];
  const personalSet = await resolveFullVisibleAccountIds(SPACE, fakeClient(personal));
  const personalContribs = [
    { financialAccountId: "p1", financialAccount: { name: "My Checking", balance: 10 } },
    { financialAccountId: "p2", financialAccount: { name: "My Savings",  balance: 20 } },
  ];
  const personalKept = filterVisibleContributions(personalContribs, personalSet);
  check("owner sees both own contributions", personalKept.length === 2);

  // ── 4. Source-scan: the route is wired to the canonical seam ────────────────
  console.log("4. source-scan — goals route wired to the D4 seam");
  const routeSrc = readFileSync(
    join(process.cwd(), "app", "api", "spaces", "[id]", "goals", "route.ts"),
    "utf8",
  );
  check("route resolves the FULL-visible account set", routeSrc.includes("resolveFullVisibleAccountIds(spaceId)"));
  check("route filters contributions via D4 helper", routeSrc.includes("filterVisibleContributions(g.contributions"));
  check("route returns the sanitized goals (not the raw findMany result)", routeSrc.includes("NextResponse.json(safeGoals)"));
  check("route no longer returns the raw goals directly", !routeSrc.includes("return NextResponse.json(goals);"));

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll goals-route visibility checks passed.");
  process.exit(0);
}

void main();
