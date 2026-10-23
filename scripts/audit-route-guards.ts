/**
 * scripts/audit-route-guards.ts — TEST-002, the route-guard census (REQUIRED,
 * source-only, no database).
 *
 * Fails the build when any exported HTTP handler under app/api/ reaches its
 * body with no recognised authorization guard and no explicit `// PUBLIC:
 * <reason>` annotation, or when the closed PUBLIC_ROUTES allowlist no longer
 * matches the tree. The recognisers and the rules live in
 * scripts/lib/route-guards.ts; scripts/audit-route-guards.test.ts proves the
 * census fails on an unguarded fixture route and passes on a guarded one.
 *
 *   npx tsx scripts/audit-route-guards.ts
 */
import { auditRouteGuards, PUBLIC_ROUTES } from "./lib/route-guards";

const report = auditRouteGuards(process.cwd());

console.log(`[route-guards] ${report.routes} route files, ${report.methods} exported methods`);
console.log(`[route-guards] guarded methods: ${report.guarded}`);
console.log(`[route-guards] public by in-file annotation: ${report.publicByAnnotation.length}`);
console.log(`[route-guards] public by closed allowlist:   ${report.publicByAllowlist.length} of ${Object.keys(PUBLIC_ROUTES).length}`);
for (const f of report.publicByAllowlist) console.log(`    PUBLIC (allowlist) ${f}`);
for (const f of report.publicByAnnotation) console.log(`    PUBLIC (annotated) ${f}`);

let failed = false;
if (report.allowlistErrors.length > 0) {
  failed = true;
  console.error("\n✗ PUBLIC_ROUTES allowlist is not exact:");
  for (const e of report.allowlistErrors) console.error(`    ${e}`);
}
if (report.findings.length > 0) {
  failed = true;
  console.error(`\n✗ ${report.findings.length} handler(s) without a recognised guard:`);
  for (const f of report.findings) console.error(`    ${f.file} ${f.method} — ${f.reason}`);
  console.error(
    "\n  Every exported HTTP method must call one of: requireUser, requireFreshUser, requireSystemAdmin,\n" +
    "  requireFreshSystemAdmin, requireSpaceRole, requireSpaceAction, requirePlatformAccess,\n" +
    "  requireFreshPlatformAccess, the CRON bearer check, the Plaid webhook verifier, or the NextAuth\n" +
    "  handler — or the file must carry `// PUBLIC: <reason>` (≥ 12 characters) stating why it is open.\n",
  );
}

if (failed) process.exit(1);
console.log("\n✓ route-guard census holds: every handler is guarded or explicitly public.\n");
