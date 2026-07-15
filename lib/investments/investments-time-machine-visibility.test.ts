/**
 * lib/investments/investments-time-machine-visibility.test.ts
 *
 * KD-21a regression — the A10 Investments Time Machine (positions) and its period
 * flows must only expose per-item detail for SpaceAccountLinks whose visibility
 * grants detail (FULL), reusing the canonical TRANSACTION_DETAIL_VISIBILITY
 * predicate — the same gate getHoldings uses, so the investment spine and the
 * data layer can never disagree about who sees positions.
 *
 * The account-scope helper IS the boundary: its returned account ids are exactly
 * the set fed to positionObservation.findMany / investmentEvent.findMany, so an
 * id excluded here can expose NO position or event. These tests drive it with a
 * fake Prisma client (the price archive touches the real DB and is deliberately
 * not exercised in unit tests — see lib/prices/archive.ts), and a source-scan
 * guard proves the two DB bindings are actually wired to the right scope.
 *
 *     npx tsx lib/investments/investments-time-machine-visibility.test.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VisibilityLevel, ShareStatus } from "@prisma/client";
import {
  resolveSpaceInvestmentAccountIds,
  resolveSingleAccountScope,
} from "./account-scope";

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

/** A fake Prisma client that faithfully applies the helper's SAL where-clauses. */
function fakeClient(links: FixtureLink[]) {
  const matches = (l: FixtureLink, where: Record<string, unknown>): boolean => {
    if (where.spaceId !== undefined && l.spaceId !== where.spaceId) return false;
    if (where.status !== undefined && l.status !== where.status) return false;
    if (where.financialAccountId !== undefined && l.financialAccountId !== where.financialAccountId) return false;
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findFirst: async ({ where }: any) => {
        const m = links.find((l) => matches(l, where));
        return m ? { spaceId: m.spaceId } : null;
      },
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
  // A shared shared-Space fixture: one FULL, one BALANCE_ONLY, one SUMMARY_ONLY.
  const shared = [
    link("faFull", VisibilityLevel.FULL),
    link("faBalance", VisibilityLevel.BALANCE_ONLY),
    link("faSummary", VisibilityLevel.SUMMARY_ONLY),
  ];

  // ── 1. Space scope, member-facing (detailEligible) ─────────────────────────
  console.log("1. Space scope — detailEligible (member-facing positions/flows)");
  {
    const ids = await resolveSpaceInvestmentAccountIds(fakeClient(shared), SPACE, "detailEligible");
    check("FULL account exposes positions (in scope)", ids.includes("faFull"));
    check("BALANCE_ONLY exposes NO position detail (excluded)", !ids.includes("faBalance"));
    check("SUMMARY_ONLY exposes NO position detail (excluded, fails closed)", !ids.includes("faSummary"));
    check("exactly the FULL account is in scope", ids.length === 1 && ids[0] === "faFull");
  }

  // ── 2. Space scope, wealth-total (all) — A9 regeneration must NOT be redacted ─
  console.log("2. Space scope — all (A9 wealth regeneration preserved)");
  {
    const ids = await resolveSpaceInvestmentAccountIds(fakeClient(shared), SPACE, "all");
    check("BALANCE_ONLY value still counts toward Space wealth (included)", ids.includes("faBalance"));
    check("all three ACTIVE accounts valued", ids.length === 3 &&
      ["faFull", "faBalance", "faSummary"].every((id) => ids.includes(id)));
  }

  // ── 3. Owner-scoped / current Personal: every link is FULL ─────────────────
  console.log("3. Personal Space (all links FULL) — owner sees all positions");
  {
    const personal = [link("p1", VisibilityLevel.FULL), link("p2", VisibilityLevel.FULL)];
    const ids = await resolveSpaceInvestmentAccountIds(fakeClient(personal), SPACE, "detailEligible");
    check("owner's own FULL accounts all in scope", ids.length === 2 && ids.includes("p1") && ids.includes("p2"));
  }

  // ── 4. Non-ACTIVE / deleted links are excluded in BOTH scopes ──────────────
  console.log("4. inactive / deleted links excluded");
  {
    const mixed = [
      link("live", VisibilityLevel.FULL),
      link("revoked", VisibilityLevel.FULL, { status: ShareStatus.REVOKED }),
      link("gone", VisibilityLevel.FULL, { deleted: true }),
    ];
    const idsDetail = await resolveSpaceInvestmentAccountIds(fakeClient(mixed), SPACE, "detailEligible");
    const idsAll = await resolveSpaceInvestmentAccountIds(fakeClient(mixed), SPACE, "all");
    check("REVOKED link excluded (detailEligible)", !idsDetail.includes("revoked"));
    check("deleted account excluded (detailEligible)", !idsDetail.includes("gone"));
    check("only the live FULL account remains (detailEligible)", idsDetail.length === 1 && idsDetail[0] === "live");
    check("REVOKED/deleted also excluded under all", idsAll.length === 1 && idsAll[0] === "live");
  }

  // ── 5. Single-account scope, member-facing (detailEligible) ────────────────
  console.log("5. single-account scope — detailEligible fails closed for non-FULL");
  {
    const fullOwn = await resolveSingleAccountScope(fakeClient([link("faFull", VisibilityLevel.FULL)]), "faFull", null, "detailEligible");
    check("FULL-linked account exposes positions (accountIds=[id])",
      fullOwn.accountIds.length === 1 && fullOwn.accountIds[0] === "faFull");
    check("FULL-linked account resolves its Space (FX context)", fullOwn.spaceId === SPACE);

    const balance = await resolveSingleAccountScope(fakeClient([link("faBalance", VisibilityLevel.BALANCE_ONLY)]), "faBalance", null, "detailEligible");
    check("BALANCE_ONLY single account exposes NO positions (accountIds=[])", balance.accountIds.length === 0);

    const summary = await resolveSingleAccountScope(fakeClient([link("faSummary", VisibilityLevel.SUMMARY_ONLY)]), "faSummary", null, "detailEligible");
    check("SUMMARY_ONLY single account exposes NO positions (accountIds=[])", summary.accountIds.length === 0);

    const orphan = await resolveSingleAccountScope(fakeClient([]), "faNoLink", null, "detailEligible");
    check("no ACTIVE detail-eligible link → fails closed (accountIds=[])", orphan.accountIds.length === 0);
  }

  // ── 6. Single-account scope, "all" — unchanged behavior (regen/other callers) ─
  console.log("6. single-account scope — all (unchanged)");
  {
    const withHint = await resolveSingleAccountScope(fakeClient([]), "faX", SPACE, "all");
    check("all + spaceId hint → account in scope, hint preserved, no lookup needed",
      withHint.accountIds.length === 1 && withHint.accountIds[0] === "faX" && withHint.spaceId === SPACE);

    const noHint = await resolveSingleAccountScope(fakeClient([link("faY", VisibilityLevel.BALANCE_ONLY)]), "faY", null, "all");
    check("all + no hint → account in scope regardless of visibility, Space resolved",
      noHint.accountIds.length === 1 && noHint.accountIds[0] === "faY" && noHint.spaceId === SPACE);
  }

  // ── 7. Source-scan: the DB bindings are wired to the right scope ────────────
  console.log("7. source-scan — bindings wired");
  {
    const root = process.cwd();
    const valuation = readFileSync(join(root, "lib/investments/valuation.ts"), "utf8");
    const timeMachine = readFileSync(join(root, "lib/investments/investments-time-machine.ts"), "utf8");
    check("valuation default scope is 'all' (A9 regeneration unaffected)",
      /args\.visibilityScope\s*\?\?\s*"all"/.test(valuation));
    check("time machine values positions with detailEligible",
      /getInvestmentValueAsOf\(\{[^}]*visibilityScope:\s*"detailEligible"/.test(timeMachine));
    check("time machine flows scope uses detailEligible",
      /resolveSpaceInvestmentAccountIds\(client,\s*args\.spaceId!,\s*"detailEligible"\)/.test(timeMachine) &&
      /resolveSingleAccountScope\(client,\s*args\.financialAccountId,\s*args\.spaceId\s*\?\?\s*null,\s*"detailEligible"\)/.test(timeMachine));
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll investments-time-machine visibility checks passed.");
  process.exit(0);
}

void main();
