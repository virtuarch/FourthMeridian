/**
 * lib/perspective-engine/route.test.ts
 *
 * Membership-gating tripwires for GET /api/spaces/[id]/perspectives.
 *
 * A DB-backed end-to-end route test is not practical here (no test runner,
 * and requireUser needs a Next request scope) — so this mirrors the KD-15
 * approach in lib/data/transactions.privacy.test.ts: source-scan the route
 * and fail loudly if a future edit weakens the auth/membership/viewer
 * guarantees. DB-backed proof rides the existing two-user visibility
 * script (scripts/test-visibility-two-user-space.ts) once dashboards wire
 * in (commit 6+ targeted UI testing).
 *
 *     npx tsx lib/perspective-engine/route.test.ts
 *
 * Run from the repo root. Exits 0 on success, 1 on failure.
 *
 * NOTE (SP-2b Batch 2, commit 8ede987): route authorization was centralized.
 * The route no longer inlines `requireUser()`, the `spaceId_userId` lookup,
 * the `SpaceMemberStatus.ACTIVE` check, or the `403` framing — those now live
 * in `requireSpaceAction()` (lib/spaces/authorize.ts), which is unit-tested in
 * lib/spaces/authorize.test.ts + lib/spaces/policy.test.ts. This tripwire
 * therefore asserts the route-level *contract*: it must delegate to
 * `requireSpaceAction(spaceId, "perspective:read")`, bail out on the returned
 * error before doing any work, and compute strictly as the authenticated
 * viewer. The centralized enforcement itself is proven by those sibling suites.
 */

import { readFileSync } from "fs";
import { join } from "path";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function main(): void {
  const routePath = join(
    process.cwd(), "app", "api", "spaces", "[id]", "perspectives", "route.ts",
  );
  const src = readFileSync(routePath, "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, ""); // strip comments

  console.log("GET /api/spaces/[id]/perspectives — gating tripwires");

  // ── Auth + membership gating (centralized) ───────────────────────────────
  // requireSpaceAction() wraps requireUser() + the [spaceId, userId] lookup +
  // ACTIVE-status/role enforcement + 403 framing (lib/spaces/authorize.ts).
  check("gates via requireSpaceAction(spaceId, \"perspective:read\")",
    /requireSpaceAction\(\s*spaceId\s*,\s*["']perspective:read["']\s*\)/.test(code));
  check("wrapped in withApiHandler (house error framing)", /withApiHandler\(/.test(code));

  // ── Guard ordering: bail on the auth error BEFORE any computation ────────
  const guardIdx   = code.search(/requireSpaceAction\(/);
  const bailIdx    = code.search(/if\s*\(\s*err\s*\)\s*return\s+err/);
  const computeIdx = code.indexOf("computePerspectives(");
  check("bails out on the authorization error (non-members never compute)",
    bailIdx !== -1);
  check("guard runs BEFORE any perspective computation",
    computeIdx !== -1 && guardIdx !== -1 && bailIdx !== -1 &&
    guardIdx < computeIdx && bailIdx < computeIdx);

  // ── Viewer identity (§5.9) ──────────────────────────────────────────────
  // The SCOPE (first arg) must be exactly { spaceId, userId } — no foreign
  // identity. A trailing options arg (e.g. the MC1 view-as { targetCurrency })
  // is permitted after the scope object; the scope shape itself is what this
  // pins.
  check("engine scope userId is the authenticated requester",
    /computePerspectives\(\{\s*spaceId,\s*userId\s*\}\s*[,)]/.test(code) &&
    /const\s+userId\s*=\s*auth\.user\.id/.test(code));
  check("no foreign/stored identity reaches the scope",
    !/userId:\s*[a-zA-Z]+\.(ownerUserId|createdByUserId|addedByUserId)/.test(code));

  // ── Engine boundary ─────────────────────────────────────────────────────
  check("route registers lenses via side-effect imports",
    /import\s+["']@\/lib\/perspective-engine\/lenses\/liquidity["']/.test(code) &&
    /import\s+["']@\/lib\/perspective-engine\/lenses\/debt["']/.test(code));
  check("route does no lens math of its own (thin consumer)",
    !/getAccountsWithVisibility|classifyAccounts|estimateMinimumPayment/.test(code));
  check("no retired-model reads", !/WorkspaceAccountShare/i.test(code));
  check("no response caching that could cross viewers",
    !/export\s+const\s+revalidate|unstable_cache|force-cache/.test(code));

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll perspectives-route gating checks passed.");
  process.exit(0);
}

main();
