/**
 * lib/plaid/exchange-account-isolation.test.ts  (IDEMP-008, partial)
 *
 * performPlaidTokenExchange is end-to-end Plaid + DB, so the per-account
 * isolation is proven structurally (house pattern: purge-revocation-wiring).
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/plaid/exchange-account-isolation.test.ts
 */
import { readFileSync } from "node:fs";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const code = readFileSync("lib/plaid/exchangeToken.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const loopAt = code.indexOf("for (const acct of plaidAccounts) {");
const loop = code.slice(loopAt, code.indexOf("const investmentAccounts", loopAt));
check("the account loop is found", loopAt > 0 && loop.length > 500);
const iTry = loop.indexOf("try {"), iCatch = loop.indexOf("} catch (accountErr) {");
check("the WHOLE account body sits in one try (first statement after the loop header)", iTry > 0 && iTry < 80, `${iTry}`);
check("the per-account catch exists after the import bookkeeping", iCatch > loop.indexOf("importedIds.push(fa.id)"));
const handler = loop.slice(iCatch, iCatch + 900);
check("only P2002 is absorbed; everything else rethrows", /\.code !== "P2002"\) throw accountErr/.test(handler));
check("an absorbed collision records a SyncIssue naming the item and the provider account",
  /recordExchangeAccountCollision\(plaidItem\.id, acct\.account_id\)/.test(handler)
  && /kind: SyncIssueKind\.UPSERT_ERROR/.test(readFileSync("lib/plaid/exchange-collision.ts", "utf8")));
check("…and skips the account (never imported, never synced)", /continue;/.test(handler) && !/importedIds\.push/.test(handler));
check("the identity-conflict degradation is preserved", /ProviderIdentityConflictError/.test(loop));
if (failures > 0) { console.error(`\n❌ exchange isolation: ${failures} check(s) failed`); process.exit(1); }
console.log("\n✅ exchange isolation: all checks passed");
