/**
 * lib/imports/authorize-visibility.test.ts  (P1-3)
 *
 * Regression for the banking-import authorization seam. Transaction import is a
 * detail-mutating / detail-probing write (it creates rows and fingerprint-
 * matches against existing ones). Previously resolveImportableFinancialAccount
 * authorized any ACTIVE link + write-capable role, so a Space OWNER/ADMIN who
 * could only see an account at BALANCE_ONLY / SUMMARY_ONLY could import into (and
 * probe, via preview) an account whose detail they could not inspect — while the
 * investment-import path (opening-position) already gated FULL.
 *
 * The fix requires FULL visibility on the active-Space link for the non-owner
 * write-authority path (reusing grantsTransactionDetail), and fails closed on
 * REVOKED links (status filter) and soft-deleted accounts (deletedAt filter).
 * The account owner/creator keeps inherent authority over their own account.
 *
 * These tests drive the real resolver with a faithful fake Prisma client, plus a
 * source-scan guard proving the gate is actually wired.
 *
 *     npx tsx lib/imports/authorize-visibility.test.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VisibilityLevel, ShareStatus, SpaceMemberRole, SpaceMemberStatus } from "@prisma/client";
import { resolveImportableFinancialAccount } from "./authorize";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const SPACE = "space-1";
const FA = "fa-1";

interface Fixture {
  link?: { visibilityLevel: VisibilityLevel; status: ShareStatus; deleted: boolean };
  fa?: { ownerUserId: string | null; createdByUserId: string | null };
  member?: { role: SpaceMemberRole; status: SpaceMemberStatus };
}

/** A fake Prisma client faithfully applying the resolver's four reads' where-clauses. */
function fakeClient(f: Fixture) {
  const linkMatches = (where: Record<string, unknown>): boolean => {
    if (!f.link) return false;
    if (where.spaceId !== SPACE) return false;
    if (where.financialAccountId !== FA) return false;
    if (where.status !== undefined && f.link.status !== where.status) return false;
    const fa = where.financialAccount as { deletedAt?: null } | undefined;
    if (fa && fa.deletedAt === null && f.link.deleted) return false;
    return true;
  };
  return {
    spaceAccountLink: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findFirst: async ({ where }: any) =>
        linkMatches(where) ? { id: "link-1", visibilityLevel: f.link!.visibilityLevel } : null,
    },
    financialAccount: {
      findUnique: async () => f.fa ?? null,
    },
    spaceMember: {
      findUnique: async () => f.member ?? null,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

async function access(userId: string, f: Fixture, spaceId: string = SPACE) {
  return resolveImportableFinancialAccount(userId, spaceId, FA, fakeClient(f));
}
function activeLink(visibilityLevel: VisibilityLevel, deleted = false) {
  return { visibilityLevel, status: ShareStatus.ACTIVE, deleted };
}
const admin  = { role: SpaceMemberRole.ADMIN,  status: SpaceMemberStatus.ACTIVE };
const member = { role: SpaceMemberRole.MEMBER, status: SpaceMemberStatus.ACTIVE };

async function main(): Promise<void> {
  // ── 1. FULL link ────────────────────────────────────────────────────────
  console.log("1. FULL link");
  {
    const owner = await access("owner", { link: activeLink(VisibilityLevel.FULL), fa: { ownerUserId: "owner", createdByUserId: null } });
    check("FULL + owner → ok", owner.ok);

    const adminOk = await access("adm", { link: activeLink(VisibilityLevel.FULL), fa: { ownerUserId: "someone-else", createdByUserId: null }, member: admin });
    check("FULL + non-owner ADMIN → ok", adminOk.ok);

    const mem = await access("mem", { link: activeLink(VisibilityLevel.FULL), fa: { ownerUserId: "someone-else", createdByUserId: null }, member });
    check("FULL + non-owner MEMBER → 403 (no write authority)", !mem.ok && (mem as { response: Response }).response.status === 403);
  }

  // ── 2. BALANCE_ONLY link → non-owner import blocked (the vulnerability) ────
  console.log("2. BALANCE_ONLY link");
  {
    const adminBlocked = await access("adm", { link: activeLink(VisibilityLevel.BALANCE_ONLY), fa: { ownerUserId: "someone-else", createdByUserId: null }, member: admin });
    check("BALANCE_ONLY + non-owner ADMIN → 403 (FULL required)", !adminBlocked.ok && (adminBlocked as { response: Response }).response.status === 403);

    // The account owner still imports into their OWN account (inherent authority).
    const ownerOk = await access("owner", { link: activeLink(VisibilityLevel.BALANCE_ONLY), fa: { ownerUserId: "owner", createdByUserId: null } });
    check("BALANCE_ONLY + owner → ok (owner has inherent authority over own account)", ownerOk.ok);
  }

  // ── 3. SUMMARY_ONLY link → non-owner import blocked (fails closed) ─────────
  console.log("3. SUMMARY_ONLY link");
  {
    const adminBlocked = await access("adm", { link: activeLink(VisibilityLevel.SUMMARY_ONLY), fa: { ownerUserId: "someone-else", createdByUserId: null }, member: admin });
    check("SUMMARY_ONLY + non-owner ADMIN → 403 (fails closed)", !adminBlocked.ok && (adminBlocked as { response: Response }).response.status === 403);
  }

  // ── 4. REVOKED / deleted → fail closed ────────────────────────────────────
  console.log("4. REVOKED link / deleted account fail closed");
  {
    const revoked = await access("owner", { link: { visibilityLevel: VisibilityLevel.FULL, status: ShareStatus.REVOKED, deleted: false }, fa: { ownerUserId: "owner", createdByUserId: null } });
    check("REVOKED link → 404 (no ACTIVE link, no legacy fallback)", !revoked.ok && (revoked as { response: Response }).response.status === 404);

    const deleted = await access("owner", { link: activeLink(VisibilityLevel.FULL, /* deleted */ true), fa: { ownerUserId: "owner", createdByUserId: null } });
    check("deleted account → 404 (deletedAt filter fails closed, even for owner)", !deleted.ok && (deleted as { response: Response }).response.status === 404);

    const noLink = await access("owner", { fa: { ownerUserId: "owner", createdByUserId: null } });
    check("no link at all → 404", !noLink.ok && (noLink as { response: Response }).response.status === 404);
  }

  // ── 5. Wrong Space → 404 (link is scoped to its own Space) ────────────────
  console.log("6. wrong Space → 404 (no link in the requested Space)");
  {
    // A FULL owner link exists in SPACE, but the caller asks against a different
    // Space id — the link query is Space-scoped, so no link matches → 404.
    const wrong = await access("owner", { link: activeLink(VisibilityLevel.FULL), fa: { ownerUserId: "owner", createdByUserId: null } }, "other-space");
    check("owner but wrong Space → 404 (no ACTIVE link in that Space)", !wrong.ok && (wrong as { response: Response }).response.status === 404);
  }

  // ── 7. Source-scan: the gate + fail-closed filters are wired ───────────────
  console.log("7. source-scan — FULL gate + deletedAt filter wired");
  {
    const src = readFileSync(join(process.cwd(), "lib", "imports", "authorize.ts"), "utf8");
    check("reuses canonical grantsTransactionDetail predicate", src.includes("grantsTransactionDetail(link.visibilityLevel)"));
    check("link query fails closed on deleted account", src.includes("financialAccount: { deletedAt: null }"));
    check("link query still requires an ACTIVE link", src.includes("status: ShareStatus.ACTIVE"));
    check("owner/creator retains inherent authority (early ok)", /ownerUserId === userId \|\| fa\?\.createdByUserId === userId/.test(src));
  }

  // ── 8. Source-scan: every import route routes through the ONE shared guard ──
  // P1 closeout convergence — banking import, investment import + preview, and
  // opening-position must all rely solely on resolveImportableFinancialAccount,
  // with NO route-local `visibilityLevel !== FULL` re-check that could disagree.
  console.log("8. source-scan — import routes converged on the shared guard");
  {
    const routes = [
      ["app", "api", "accounts", "[id]", "import", "route.ts"],
      ["app", "api", "accounts", "[id]", "import", "preview", "route.ts"],
      ["app", "api", "accounts", "[id]", "import", "investments", "route.ts"],
      ["app", "api", "accounts", "[id]", "import", "investments", "preview", "route.ts"],
      ["app", "api", "investments", "opening-position", "route.ts"],
      // RLS Slice 2 — the SIXTH import route. Rollback had its own inline
      // spaceAccountLink.findFirst that omitted the FULL tier, so it was the one
      // import route a BALANCE_ONLY / SUMMARY_ONLY OWNER/ADMIN could reach — and
      // the most destructive one (it soft-deletes every Transaction the batch
      // created, i.e. detail they could not read). It now shares the one guard.
      ["app", "api", "imports", "[id]", "rollback", "route.ts"],
    ];
    for (const rel of routes) {
      const src = readFileSync(join(process.cwd(), ...rel), "utf8");
      const label = rel.slice(2).join("/");
      check(`${label} calls the shared guard`, src.includes("resolveImportableFinancialAccount("));
      check(`${label} has no redundant local FULL re-check`, !/visibilityLevel\s*!==\s*VisibilityLevel\.FULL/.test(src));
    }
  }

  // ── 9. Rollback-specific pins (RLS Slice 2) ───────────────────────────────
  // The defect was a SECOND, weaker copy of the same authority rule. These pin
  // that the copy is gone, that the guard is driven off the BATCH's own account
  // (never a client-supplied id), and that the creator/canManage check survives
  // as an ADDITIONAL restriction rather than being replaced by the guard.
  console.log("9. source-scan — rollback uses the guard and keeps its own extra restriction");
  {
    const src = readFileSync(
      join(process.cwd(), "app", "api", "imports", "[id]", "rollback", "route.ts"), "utf8");
    // Comments legitimately describe the removed query, so scan real code only.
    const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");

    check("rollback dropped its inline spaceAccountLink lookup (no second copy of the rule)",
      !code.includes("spaceAccountLink."));
    check("rollback no longer imports ShareStatus (the inline query's only user)",
      !code.includes("ShareStatus"));
    check("guard is driven off the BATCH's own financialAccountId, not a path param",
      /resolveImportableFinancialAccount\(\s*\n?\s*user\.id,\s*spaceId,\s*batch\.financialAccountId\s*\)/.test(code));
    check("rollback returns the guard's own response (same 404/403 bodies as its siblings)",
      /if\s*\(\s*!access\.ok\s*\)\s*return\s+access\.response/.test(code));
    check("rollback KEEPS the creator-or-canManage restriction on top of the guard",
      /batch\.createdByUserId === user\.id/.test(code) &&
      /!isCreator\s*&&\s*!permissions\.canManage/.test(code));
    check("rollback still requires a FRESH session (destructive action)",
      /requireFreshUser\s*\(\s*\)/.test(code));

    // Order: authorize before any destructive work. The guard must precede the
    // $transaction that performs the soft-delete.
    const guardAt = code.indexOf("resolveImportableFinancialAccount(");
    const txAt    = code.indexOf("db.$transaction");
    check("guard precedes the soft-delete transaction",
      guardAt !== -1 && txAt !== -1 && guardAt < txAt, `guard@${guardAt} tx@${txAt}`);
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll import-authorization visibility checks passed.");
  process.exit(0);
}

void main();
