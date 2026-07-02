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

  // ── Auth ────────────────────────────────────────────────────────────────
  check("authenticates via requireUser()", /requireUser\(\)/.test(code));
  check("wrapped in withApiHandler (house error framing)", /withApiHandler\(/.test(code));

  // ── Membership guard, and its ordering vs. compute ─────────────────────
  const guardIdx   = code.indexOf("spaceId_userId");
  const activeIdx  = code.indexOf("SpaceMemberStatus.ACTIVE");
  const statusIdx  = code.indexOf("status: 403");
  const computeIdx = code.indexOf("computePerspectives(");
  check("membership looked up by [spaceId, userId] unique", guardIdx !== -1);
  check("requires ACTIVE membership", activeIdx !== -1);
  check("non-members get 403", statusIdx !== -1);
  check("guard runs BEFORE any perspective computation",
    computeIdx !== -1 && guardIdx < computeIdx && activeIdx < computeIdx && statusIdx < computeIdx);

  // ── Viewer identity (§5.9) ──────────────────────────────────────────────
  check("engine scope userId is the authenticated requester",
    /computePerspectives\(\{\s*spaceId,\s*userId\s*\}\)/.test(code) &&
    /const userId = user\.id/.test(code));
  check("no foreign/stored identity reaches the scope",
    !/userId:\s*(?!.*user\.id)[a-zA-Z]+\.(ownerUserId|createdByUserId|addedByUserId)/.test(code));

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
