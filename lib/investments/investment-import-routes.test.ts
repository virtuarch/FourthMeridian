/**
 * lib/investments/investment-import-routes.test.ts
 *
 * A7-6 — source-scan contract tests (repo style: no RTL) proving the import
 * routes' safety wiring: authz gates, stable-id resolution, defense-in-depth
 * re-validation on commit, masking, and flag gating. Asserts the wiring rather
 * than spinning a server.
 *
 *   npx tsx lib/investments/investment-import-routes.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");

function main(): void {
  const commit = read("app/api/accounts/[id]/import/investments/route.ts");
  const preview = read("app/api/accounts/[id]/import/investments/preview/route.ts");
  const acctsRoute = read("app/api/connections/[id]/import-accounts/route.ts");
  const histRoute = read("app/api/connections/[id]/import-history/route.ts");
  const resolver = read("lib/investments/connection-import-accounts.ts");
  const history = read("lib/investments/investment-import-history.ts");

  console.log("commit route re-runs the safety gate (defense-in-depth)");
  check("commit calls buildImportPreview before committing", /buildImportPreview\(/.test(commit));
  check("commit refuses when !canCommit (422)", /!preview\.canCommit/.test(commit) && /422/.test(commit));
  check("commit requires explicit acknowledgement for unproven files (409)", /requiresConfirmation && !acknowledged/.test(commit) && /409/.test(commit));
  check("commit + preview guard the upload (size/type) before parsing", /guardImportUpload\(/.test(commit) && /guardImportUpload\(/.test(preview));

  console.log("all import routes are auth-gated + flag-gated");
  for (const [name, src] of [["commit", commit], ["preview", preview], ["accounts", acctsRoute], ["history", histRoute]] as const) {
    check(`${name} route requires a fresh user`, /requireFreshUser\(\)/.test(src));
    check(`${name} route is behind INVESTMENT_IMPORTS_ENABLED`, /investmentImportsEnabled\(\)/.test(src));
  }

  console.log("connection→accounts uses STABLE ids, not institution display names");
  check("resolver joins via AccountConnection.plaidItemDbId (stable connection id)", /plaidItemDbId:\s*args\.connectionId/.test(resolver));
  check("resolver gates by userId (cross-user access returns nothing)", /plaidItem:\s*{\s*userId/.test(resolver));
  check("resolver never keys on institution name", !/institution:\s*args\./.test(resolver));

  console.log("account identifiers are masked in outputs");
  check("accounts route emits masked labels", /maskAccountLabel\(/.test(acctsRoute));
  check("history helper emits masked account labels", /maskAccountLabel\(/.test(history));
  check("history is scoped to the connection's accounts by id", /financialAccountId:\s*{\s*in:/.test(history) && /getImportableAccountsForConnection/.test(history));

  console.log("commit binds the target by stable account id (path param), never a display label");
  check("commit passes financialAccountId (the [id] path param) to the committer", /financialAccountId:\s*id/.test(commit));

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nAll investment-import-routes checks passed");
}

main();
