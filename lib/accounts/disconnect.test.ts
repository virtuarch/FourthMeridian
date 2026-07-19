/**
 * lib/accounts/disconnect.test.ts  (CONN-4A)
 *
 * Source-scan invariants for the connection disconnect lifecycle. Standalone `tsx`
 * (no DB). Proves Model A only:
 *   - ONE disconnect engine (both routes delegate to disconnectAccounts)
 *   - NON-DESTRUCTIVE: soft-delete + SAL revoke only; NO hard delete anywhere
 *   - historical snapshots untouched (today-row regen only, not regenerateWealthHistory)
 *   - connection route is owner-gated + audited (CONNECTION_DISCONNECTED)
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const src  = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const code = (rel: string) => src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); }
}

const prim  = code("lib/accounts/disconnect.ts");
const acct  = code("app/api/accounts/[id]/route.ts");
const conn  = code("app/api/connections/[id]/disconnect/route.ts");

console.log("ONE disconnect engine — both routes delegate to disconnectAccounts");
{
  check("primitive exports disconnectAccounts", /export async function disconnectAccounts/.test(prim));
  check("account DELETE route delegates to disconnectAccounts", acct.includes("disconnectAccounts("));
  check("connection route delegates to disconnectAccounts", conn.includes("disconnectAccounts("));
  check("account route no longer inlines its own soft-delete/revoke transaction",
    !/financialAccount\.update\(\s*\{[\s\S]*deletedAt/.test(acct) && !acct.includes("spaceAccountLink.updateMany"));
}

console.log("NON-DESTRUCTIVE — Model A only, never a hard delete");
{
  for (const [name, s] of [["primitive", prim], ["connection route", conn]] as const) {
    check(`${name}: no financialAccount hard delete`, !/financialAccount\.delete(Many)?\(/.test(s));
    check(`${name}: no accountConnection hard delete`, !/accountConnection\.delete(Many)?\(/.test(s));
    check(`${name}: no transaction/holding hard delete`, !/(transaction|holding)\.delete(Many)?\(/.test(s));
  }
  check("primitive soft-deletes via deletedAt", prim.includes("deletedAt: now"));
  check("primitive revokes SALs (revoke-don't-delete)", prim.includes("ShareStatus.REVOKED"));
  check("primitive revokes provider access only when orphaned", prim.includes("disconnectPlaidItemIfOrphaned("));
}

console.log("Historical snapshots untouched (deferred) — today-row regen only");
{
  check("primitive regenerates today's snapshot", prim.includes("regenerateSpaceSnapshot("));
  check("primitive does NOT run historical wealth regen", !prim.includes("regenerateWealthHistory"));
  check("primitive does NOT run a snapshot amendment", !prim.includes("applyAmendment"));
}

console.log("Connection route — owner-gated + audited, no permanent-delete");
{
  check("gated by requireUser", conn.includes("requireUser("));
  check("ownership via plaidItem.userId", /plaidItem:\s*\{\s*userId/.test(conn));
  check("ownership via connection.userId", /connection:\s*\{\s*userId/.test(conn));
  check("audited as CONNECTION_DISCONNECTED", conn.includes("CONNECTION_DISCONNECTED"));
  check("returns 404 when not owned / already disconnected", conn.includes("404"));
}

if (failures > 0) { console.error(`\ndisconnect: ${failures} failure(s).`); process.exit(1); }
console.log("\ndisconnect: all passed.");
